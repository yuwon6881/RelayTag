import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type TagConfig,
  type RelayMessage,
  type TelegramIncomingUpdate,
  isContactWindowActive,
  toOwnerTagView,
  resolveUpdatedBotToken,
  toPublicTagView,
  sanitizeScannerSessionId,
  filterMessagesForPublicScanner,
  checkScannerRateLimit,
  pruneRateLimitMap,
  resolveTargetScannerSession,
  verifyOwnerAccess,
  validateIncomingMessage,
  validateOwnerReply,
  validateTelegramCredentials,
  formatTelegramRelayPayload,
  parseTelegramUpdateForOwnerReply,
  checkDndSpamShield,
  cleanupStoreState,
  createInitialTagConfig,
  hasTagSetupData,
  extractClientIp,
  buildOwnerSessionCookie,
  computeHealthSummary,
} from './src/utils/relayLogic.ts';

const SERVER_STARTED_AT = Date.now();
const DATA_FILE = path.join(os.tmpdir(), 'relaytag-store-v5.json');

interface FirebaseAppletConfig {
  projectId?: string;
  firestoreDatabaseId?: string;
  apiKey?: string;
  appId?: string;
}

const firebaseConfig: FirebaseAppletConfig = (() => {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf-8');
    return JSON.parse(raw) as FirebaseAppletConfig;
  } catch {
    return {};
  }
})();

const SERVER_VAULT_KEY = crypto.scryptSync(
  `${process.env.GEMINI_API_KEY || ''}:${process.env.GOOGLE_CLOUD_PROJECT || ''}:${firebaseConfig.appId || 'relaytag-v1'}`,
  'relaytag-aes-gcm-salt-v1',
  32
);

function computeVaultId(tagCode: string): string {
  const hmac = crypto
    .createHmac('sha256', SERVER_VAULT_KEY)
    .update(`vault:${tagCode.trim().toUpperCase()}`)
    .digest('hex')
    .slice(0, 32);
  return `vlt_${hmac}`;
}

function encryptRelayVault(payload: {
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
}): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SERVER_VAULT_KEY, iv);
  const plain = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptRelayVault(ciphertext: string): {
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
} | null {
  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encrypted = Buffer.from(parts[3], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', SERVER_VAULT_KEY, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(decrypted);
    if (typeof parsed.telegramEnabled === 'boolean' && typeof parsed.telegramBotToken === 'string') {
      return {
        telegramEnabled: parsed.telegramEnabled,
        telegramBotToken: parsed.telegramBotToken,
        telegramChatId: typeof parsed.telegramChatId === 'string' ? parsed.telegramChatId : '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

interface StoreSchema {
  tags: TagConfig[];
  messages: RelayMessage[];
  ownerTokens?: string[];
}

// In-memory store cache to eliminate synchronous disk reads on high-frequency polling
let memoryStore: StoreSchema | null = null;
const scannerRateLimitMap = new Map<string, number[]>();
const hydratedTagTimestamps = new Map<string, number>();

async function hydrateTagFromFirestoreIfNeeded(store: StoreSchema, tag: TagConfig): Promise<void> {
  const code = tag.code.toUpperCase();
  const now = Date.now();
  const lastHydrated = hydratedTagTimestamps.get(code) || 0;
  // Re-verify from Firestore on cold start (lastHydrated === 0) or every 30s when public scanners poll
  if (lastHydrated > 0 && now - lastHydrated < 30_000) {
    return;
  }
  if (!firebaseConfig.projectId || !firebaseConfig.firestoreDatabaseId) {
    return;
  }

  hydratedTagTimestamps.set(code, now);
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    firebaseConfig.projectId
  )}/databases/${encodeURIComponent(firebaseConfig.firestoreDatabaseId)}/documents`;
  const keyParam = firebaseConfig.apiKey ? `?key=${encodeURIComponent(firebaseConfig.apiKey)}` : '';

  try {
    const tagUrl = `${baseUrl}/tags/${encodeURIComponent(code)}${keyParam}`;
    const vaultId = computeVaultId(code);
    const vaultUrl = `${baseUrl}/tags/${encodeURIComponent(code)}/vault/${encodeURIComponent(vaultId)}${keyParam}`;

    const [tagRes, vaultRes] = await Promise.all([
      fetch(tagUrl, { signal: AbortSignal.timeout(3500) }).catch(() => null),
      fetch(vaultUrl, { signal: AbortSignal.timeout(3500) }).catch(() => null),
    ]);

    let mutated = false;

    if (tagRes && tagRes.ok) {
      const docJson = (await tagRes.json()) as {
        fields?: Record<string, { stringValue?: string; booleanValue?: boolean; integerValue?: string; doubleValue?: number }>;
      };
      const f = docJson.fields;
      if (f) {
        if (f.ownerId?.stringValue) tag.ownerUid = f.ownerId.stringValue;
        if (typeof f.vehicleLabel?.stringValue === 'string') tag.vehicleLabel = f.vehicleLabel.stringValue;
        if (typeof f.plateNumber?.stringValue === 'string') tag.plateHint = f.plateNumber.stringValue;
        if (typeof f.contactEnabled?.booleanValue === 'boolean') {
          tag.contactEnabled = f.contactEnabled.booleanValue;
        }
        const rawExpire =
          typeof f.autoExpireAt?.integerValue === 'string'
            ? Number(f.autoExpireAt.integerValue)
            : typeof f.autoExpireAt?.doubleValue === 'number'
            ? f.autoExpireAt.doubleValue
            : 0;
        tag.autoExpireAt = rawExpire > 0 ? rawExpire : null;
        if (typeof f.statusNote?.stringValue === 'string') {
          tag.statusNote = f.statusNote.stringValue;
        }
        mutated = true;
      }
    }

    if (vaultRes && vaultRes.ok) {
      const vaultJson = (await vaultRes.json()) as {
        fields?: Record<string, { stringValue?: string }>;
      };
      const ciphertext = vaultJson.fields?.ciphertext?.stringValue;
      if (ciphertext) {
        const decrypted = decryptRelayVault(ciphertext);
        if (decrypted) {
          tag.telegramEnabled = decrypted.telegramEnabled;
          tag.telegramBotToken = decrypted.telegramBotToken;
          tag.telegramChatId = decrypted.telegramChatId;
          mutated = true;
        }
      }
    }

    if (mutated) {
      if (!hasTagSetupData(tag)) {
        tag.contactEnabled = false;
        tag.autoExpireAt = null;
      }
      cleanupStoreState(store, Date.now());
      saveStore(store);
    }
  } catch {
    // Non-fatal: continue with local store state
  }
}

function getInitialStore(): StoreSchema {
  const now = Date.now();
  return {
    tags: [createInitialTagConfig(now)],
    messages: [],
    ownerTokens: [],
  };
}

function loadStore(): StoreSchema {
  if (memoryStore) {
    return memoryStore;
  }
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) as StoreSchema;
      if (Array.isArray(parsed.tags) && parsed.tags.length > 0 && Array.isArray(parsed.messages)) {
        if (!Array.isArray(parsed.ownerTokens)) {
          parsed.ownerTokens = [];
        }
        memoryStore = parsed;
        return memoryStore;
      }
    }
  } catch (err) {
    console.error(`Failed to read store file (${DATA_FILE}), resetting:`, err);
  }
  const initial = getInitialStore();
  saveStore(initial);
  return initial;
}

function saveStore(store: StoreSchema): void {
  memoryStore = store;
  const serialized = JSON.stringify(store, null, 2);
  try {
    const tmpFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmpFile, serialized, 'utf-8');
    fs.renameSync(tmpFile, DATA_FILE);
  } catch {
    // ignore read-only or ephemeral FS errors
  }
}

function getCleanedStore(now: number): StoreSchema {
  const store = loadStore();
  pruneRateLimitMap(scannerRateLimitMap, now);
  if (cleanupStoreState(store, now)) {
    saveStore(store);
  }
  return store;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

function extractOwnerToken(req: Request): string | null {
  const headerToken = req.headers['x-owner-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.relaytag_owner_token) {
    return cookies.relaytag_owner_token.trim();
  }
  return null;
}

function extractFirebaseUid(req: Request): string | null {
  const headerUid = req.headers['x-firebase-uid'];
  if (typeof headerUid === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(headerUid.trim())) {
    return headerUid.trim();
  }
  return null;
}

async function sendTelegramMessageWithRetry(
  botToken: string,
  chatId: string,
  payloadText: string
): Promise<{ forwarded: boolean; error?: string }> {
  const url = `https://api.telegram.org/bot${botToken.trim()}/sendMessage`;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId.trim(),
          text: payloadText,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        return { forwarded: true };
      }

      const rawBody = await response.text();
      if (response.status === 401 || response.status === 404) {
        return {
          forwarded: false,
          error:
            'Telegram rejected the Bot Token (401/404). Please verify the token from @BotFather.',
        };
      }
      if (response.status === 400 || response.status === 403) {
        return {
          forwarded: false,
          error:
            'Telegram could not reach this Chat ID. Make sure you opened your bot in Telegram, pressed Start (/start), and entered your numeric Chat ID.',
        };
      }

      // Retry on 429 or 5xx server errors
      if (attempt < maxAttempts && (response.status === 429 || response.status >= 500)) {
        await new Promise((r) => setTimeout(r, attempt * 400));
        continue;
      }

      return {
        forwarded: false,
        error: `Telegram API returned ${response.status}: ${rawBody.slice(0, 140)}`,
      };
    } catch (err) {
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 400));
        continue;
      }
      return {
        forwarded: false,
        error: err instanceof Error ? err.message : 'Unknown Telegram webhook error',
      };
    }
  }

  return { forwarded: false, error: 'Telegram delivery failed after retries.' };
}

const lastTelegramPollMap = new Map<string, number>();

async function forwardToTelegramIfConfigured(
  tag: TagConfig,
  senderAlias: string,
  text: string,
  category?: string,
  sessionId?: string,
  fallbackOrigin?: string
): Promise<{ forwarded: boolean; error?: string }> {
  if (!tag.telegramEnabled || !tag.telegramBotToken.trim() || !tag.telegramChatId.trim()) {
    return { forwarded: false };
  }

  const consoleUrl =
    (process.env.APP_URL ? process.env.APP_URL.trim() : '') ||
    (fallbackOrigin ? fallbackOrigin.trim() : '') ||
    undefined;
  const payloadText = formatTelegramRelayPayload(
    tag,
    senderAlias,
    text,
    category,
    consoleUrl,
    sessionId
  );
  return sendTelegramMessageWithRetry(tag.telegramBotToken, tag.telegramChatId, payloadText);
}

function applyParsedTelegramUpdate(
  store: StoreSchema,
  tag: TagConfig,
  update: TelegramIncomingUpdate,
  now: number
): { applied: boolean; replyMessage?: RelayMessage; dndChanged?: boolean } {
  const parsed = parseTelegramUpdateForOwnerReply(
    update,
    tag.telegramChatId,
    store.messages,
    tag.id
  );

  if (typeof update.update_id === 'number' && update.update_id > (tag.lastTelegramUpdateId || 0)) {
    tag.lastTelegramUpdateId = update.update_id;
  }

  if (parsed.action === 'reply') {
    const msgId = `tg-reply-${parsed.updateId || now}`;
    if (store.messages.some((m) => m.id === msgId)) {
      return { applied: false };
    }
    const replyMsg: RelayMessage = {
      id: msgId,
      tagId: tag.id,
      sessionId: parsed.sessionId,
      sender: 'owner',
      senderAlias: 'Vehicle Owner (via Telegram)',
      text: parsed.sanitizedText,
      createdAt: now,
      viaTelegram: true,
    };
    store.messages.push(replyMsg);
    cleanupStoreState(store, now);
    saveStore(store);
    return { applied: true, replyMessage: replyMsg };
  }

  if (parsed.action === 'command-dnd') {
    tag.contactEnabled = false;
    tag.autoExpireAt = null;
    tag.updatedAt = now;
    hydratedTagTimestamps.set(tag.code.toUpperCase(), now + 3600_000);
    saveStore(store);
    return { applied: true, dndChanged: true };
  }

  if (parsed.action === 'command-on') {
    tag.contactEnabled = true;
    tag.autoExpireAt = null;
    tag.updatedAt = now;
    hydratedTagTimestamps.set(tag.code.toUpperCase(), now + 3600_000);
    saveStore(store);
    return { applied: true, dndChanged: true };
  }

  return { applied: false };
}

async function syncTelegramBotRepliesIfNeeded(
  store: StoreSchema,
  tag: TagConfig,
  now: number,
  force = false
): Promise<number> {
  if (!tag.telegramEnabled || !tag.telegramBotToken.trim() || !tag.telegramChatId.trim()) {
    return 0;
  }
  const code = tag.code.toUpperCase();
  const lastPoll = lastTelegramPollMap.get(code) || 0;
  if (!force && now - lastPoll < 3500) {
    return 0;
  }
  lastTelegramPollMap.set(code, now);

  const offset = (tag.lastTelegramUpdateId || 0) + 1;
  const url = `https://api.telegram.org/bot${tag.telegramBotToken.trim()}/getUpdates?offset=${offset}&limit=20&timeout=0`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return 0;
    const data = (await res.json()) as {
      ok?: boolean;
      result?: TelegramIncomingUpdate[];
    };
    if (!data.ok || !Array.isArray(data.result) || data.result.length === 0) {
      return 0;
    }

    let appliedCount = 0;
    let maxUpdateUpdated = false;
    for (const upd of data.result) {
      const prevMax = tag.lastTelegramUpdateId || 0;
      const outcome = applyParsedTelegramUpdate(store, tag, upd, Date.now());
      if ((tag.lastTelegramUpdateId || 0) > prevMax) {
        maxUpdateUpdated = true;
      }
      if (outcome.applied) {
        appliedCount++;
        if (outcome.replyMessage) {
          void sendTelegramMessageWithRetry(
            tag.telegramBotToken,
            tag.telegramChatId,
            `✓ Reply delivered to scanner on ${tag.plateHint}: "${outcome.replyMessage.text}"`
          );
        } else if (outcome.dndChanged) {
          void sendTelegramMessageWithRetry(
            tag.telegramBotToken,
            tag.telegramChatId,
            tag.contactEnabled
              ? `🟢 ${tag.plateHint} is now Reachable (ON).`
              : `🔒 ${tag.plateHint} switched to Do Not Disturb (OFF). Incoming QR scans are now paused.`
          );
        }
      }
    }
    if (maxUpdateUpdated && appliedCount === 0) {
      saveStore(store);
    }
    return appliedCount;
  } catch {
    return 0;
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Production reverse-proxy & security hardening
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.path.startsWith('/api/owner/')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

  app.use(express.json({ limit: '16kb' }));

  // Production Health & Readiness Endpoint
  app.get('/api/health', (_req, res) => {
    const now = Date.now();
    const store = getCleanedStore(now);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(computeHealthSummary(store, now, SERVER_STARTED_AT));
  });

  // Bootstrap or verify an authenticated owner session (HttpOnly cookie + token header)
  app.post('/api/owner/session', (req, res) => {
    const store = getCleanedStore(Date.now());
    if (!Array.isArray(store.ownerTokens)) {
      store.ownerTokens = [];
    }

    const existingToken = extractOwnerToken(req);
    const firebaseUid = extractFirebaseUid(req);
    const primaryTag = store.tags[0];

    // If tag is already claimed by a specific Firebase UID and caller provides a different UID, deny
    if (primaryTag?.ownerUid && firebaseUid && primaryTag.ownerUid !== firebaseUid) {
      res.status(403).json({
        error: 'Forbidden: This vehicle tag is registered to a different account.',
      });
      return;
    }

    let token =
      existingToken && store.ownerTokens.includes(existingToken)
        ? existingToken
        : `rt_own_${crypto.randomBytes(24).toString('hex')}`;

    if (!store.ownerTokens.includes(token)) {
      store.ownerTokens.push(token);
      if (store.ownerTokens.length > 25) {
        store.ownerTokens = store.ownerTokens.slice(-25);
      }
    }

    // Bind tag ownerUid when owner signs in with Firebase
    if (primaryTag && firebaseUid && !primaryTag.ownerUid) {
      primaryTag.ownerUid = firebaseUid;
    }

    saveStore(store);

    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const isSecureReq = Boolean(req.secure || forwardedProto === 'https');
    res.setHeader('Set-Cookie', buildOwnerSessionCookie(token, isSecureReq));
    res.json({ token, serverTime: Date.now() });
  });

  // Guard middleware for all /api/owner/* endpoints
  const requireOwnerAuth = (req: Request, res: Response, next: NextFunction) => {
    const store = getCleanedStore(Date.now());
    const validTokens = new Set(store.ownerTokens || []);
    const providedToken = extractOwnerToken(req);
    const providedFirebaseUid = extractFirebaseUid(req);
    const primaryTag = store.tags[0];

    const check = verifyOwnerAccess({
      providedToken,
      validTokens,
      tagOwnerUid: primaryTag?.ownerUid,
      providedFirebaseUid,
    });

    if (!check.authorized) {
      res.status(check.status).json({ error: check.error });
      return;
    }

    if (primaryTag && providedFirebaseUid && !primaryTag.ownerUid) {
      primaryTag.ownerUid = providedFirebaseUid;
      saveStore(store);
    }

    next();
  };

  app.get('/api/owner/state', requireOwnerAuth, async (_req, res) => {
    const now = Date.now();
    const store = getCleanedStore(now);
    const primaryTag = store.tags[0];
    if (primaryTag && primaryTag.telegramEnabled) {
      await syncTelegramBotRepliesIfNeeded(store, primaryTag, now);
    }

    res.json({
      tags: store.tags.map((t) => toOwnerTagView(t)),
      messages: [...store.messages].sort((a, b) => a.createdAt - b.createdAt),
      serverTime: now,
    });
  });

  app.patch('/api/owner/tags/:id/toggle', requireOwnerAuth, (req, res) => {
    const now = Date.now();
    const store = getCleanedStore(now);
    const tag = store.tags.find((t) => t.id === req.params.id);
    if (!tag) {
      res.status(404).json({ error: 'Tag not found' });
      return;
    }

    const { contactEnabled, durationMinutes } = req.body as {
      contactEnabled: boolean;
      durationMinutes?: number | null;
    };

    tag.contactEnabled = Boolean(contactEnabled);
    if (tag.contactEnabled && typeof durationMinutes === 'number' && durationMinutes > 0) {
      // Max allowed duration cap: 24 hours (1440m)
      const clampedMins = Math.min(Math.max(1, Math.round(durationMinutes)), 1440);
      tag.autoExpireAt = now + clampedMins * 60 * 1000;
    } else {
      tag.autoExpireAt = null;
    }
    tag.updatedAt = now;
    hydratedTagTimestamps.set(tag.code.toUpperCase(), now);

    saveStore(store);
    res.json({ tag: toOwnerTagView(tag), serverTime: now });
  });

  app.patch('/api/owner/tags/:id', requireOwnerAuth, (req, res) => {
    const now = Date.now();
    const store = getCleanedStore(now);
    const tag = store.tags.find((t) => t.id === req.params.id);
    if (!tag) {
      res.status(404).json({ error: 'Tag not found' });
      return;
    }

    const {
      vehicleLabel,
      plateHint,
      statusNote,
      contactEnabled,
      autoExpireAt,
      telegramEnabled,
      telegramBotToken,
      telegramChatId,
    } = req.body as Partial<TagConfig>;

    if (typeof vehicleLabel === 'string') {
      tag.vehicleLabel = vehicleLabel.trim().slice(0, 60);
    }
    if (typeof plateHint === 'string') {
      tag.plateHint = plateHint.trim().toUpperCase().slice(0, 20);
    }
    if (typeof statusNote === 'string') {
      tag.statusNote = statusNote.trim().slice(0, 160);
    }
    if (typeof contactEnabled === 'boolean') {
      tag.contactEnabled = contactEnabled;
    }
    if (autoExpireAt === null || (typeof autoExpireAt === 'number' && autoExpireAt >= 0)) {
      tag.autoExpireAt = autoExpireAt && autoExpireAt > now ? autoExpireAt : null;
      if (typeof autoExpireAt === 'number' && autoExpireAt > 0 && autoExpireAt <= now) {
        tag.contactEnabled = false;
      }
    }
    const nextBotToken =
      typeof telegramBotToken === 'string'
        ? resolveUpdatedBotToken(telegramBotToken, tag.telegramBotToken)
        : tag.telegramBotToken;
    const nextChatId =
      typeof telegramChatId === 'string'
        ? telegramChatId.trim().slice(0, 60)
        : tag.telegramChatId;
    const nextTelegramEnabled =
      typeof telegramEnabled === 'boolean' ? telegramEnabled : tag.telegramEnabled;

    // Enforce valid Bot Token & Chat ID whenever Telegram forwarding is enabled via explicit save
    if (
      typeof telegramEnabled === 'boolean' &&
      telegramEnabled &&
      (typeof telegramBotToken === 'string' || typeof telegramChatId === 'string')
    ) {
      const check = validateTelegramCredentials(nextBotToken, nextChatId);
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }
    }

    tag.telegramEnabled = nextTelegramEnabled;
    tag.telegramBotToken = nextBotToken;
    tag.telegramChatId = nextChatId;
    tag.updatedAt = now;
    hydratedTagTimestamps.set(tag.code.toUpperCase(), now);

    saveStore(store);
    const vault = {
      vaultId: computeVaultId(tag.code),
      ciphertext: encryptRelayVault({
        telegramEnabled: tag.telegramEnabled,
        telegramBotToken: tag.telegramBotToken,
        telegramChatId: tag.telegramChatId,
      }),
    };
    res.json({ tag: toOwnerTagView(tag), vault, serverTime: now });
  });

  app.post('/api/owner/tags/:id/test-telegram', requireOwnerAuth, async (req, res) => {
    const now = Date.now();
    const store = getCleanedStore(now);
    const tag = store.tags.find((t) => t.id === req.params.id);
    if (!tag) {
      res.status(404).json({ error: 'Tag not found' });
      return;
    }

    const { telegramBotToken, telegramChatId } = (req.body || {}) as {
      telegramBotToken?: unknown;
      telegramChatId?: unknown;
    };

    const candidateToken =
      typeof telegramBotToken === 'string'
        ? resolveUpdatedBotToken(telegramBotToken, tag.telegramBotToken)
        : tag.telegramBotToken;
    const candidateChatId =
      typeof telegramChatId === 'string'
        ? telegramChatId.trim().slice(0, 60)
        : tag.telegramChatId;

    const validation = validateTelegramCredentials(candidateToken, candidateChatId);
    if (!validation.valid) {
      res.status(400).json({ ok: false, error: validation.error });
      return;
    }

    // Clear any stale webhook so 2-way getUpdates polling works reliably
    try {
      await fetch(
        `https://api.telegram.org/bot${validation.cleanBotToken}/deleteWebhook`,
        { method: 'POST', signal: AbortSignal.timeout(3000) }
      );
    } catch {
      // non-fatal
    }

    const testPayload = [
      `✅ RelayTag 2-Way Connected — ${tag.vehicleLabel} (${tag.plateHint})`,
      `Tag ID: ${tag.code}`,
      `Status: Instant Telegram alerts & direct 2-way replies are active!`,
      `↩️ Reply directly to any scan alert in Telegram to message the scanner back, or send /dnd here anytime to turn off alerts.`,
    ].join('\n');

    const result = await sendTelegramMessageWithRetry(
      validation.cleanBotToken,
      validation.cleanChatId,
      testPayload
    );

    if (!result.forwarded) {
      res.status(400).json({
        ok: false,
        error: result.error || 'Could not deliver test message to Telegram.',
      });
      return;
    }

    // Automatically save and enable the verified credentials
    tag.telegramEnabled = true;
    tag.telegramBotToken = validation.cleanBotToken;
    tag.telegramChatId = validation.cleanChatId;
    tag.updatedAt = now;
    hydratedTagTimestamps.set(tag.code.toUpperCase(), now);
    saveStore(store);

    const vault = {
      vaultId: computeVaultId(tag.code),
      ciphertext: encryptRelayVault({
        telegramEnabled: tag.telegramEnabled,
        telegramBotToken: tag.telegramBotToken,
        telegramChatId: tag.telegramChatId,
      }),
    };

    res.json({
      ok: true,
      tag: toOwnerTagView(tag),
      vault,
      serverTime: now,
    });
  });

  app.post('/api/owner/tags/:id/simulate-telegram-reply', requireOwnerAuth, async (req, res) => {
    const now = Date.now();
    const store = getCleanedStore(now);
    const tag = store.tags.find((t) => t.id === req.params.id);
    if (!tag) {
      res.status(404).json({ error: 'Tag not found' });
      return;
    }

    // First pull any real pending replies from Telegram if configured
    await syncTelegramBotRepliesIfNeeded(store, tag, now, true);

    const { text, sessionId } = (req.body || {}) as {
      text?: unknown;
      sessionId?: unknown;
    };
    const replyText =
      typeof text === 'string' && text.trim()
        ? text.trim()
        : 'On my way down right now — thanks for scanning! (Sent directly from Telegram)';

    const simulatedUpdateId = Math.max((tag.lastTelegramUpdateId || 1000) + 1, now);
    const simulatedChatId = tag.telegramChatId.trim() || '999999999';
    const targetSession = resolveTargetScannerSession(store.messages, tag.id, sessionId);

    const fakeUpdate: TelegramIncomingUpdate = {
      update_id: simulatedUpdateId,
      message: {
        text: replyText,
        chat: { id: simulatedChatId },
        from: { is_bot: false },
        reply_to_message: targetSession
          ? { text: `Session: #${targetSession}` }
          : undefined,
      },
    };

    const prevChatId = tag.telegramChatId;
    tag.telegramChatId = simulatedChatId;
    const outcome = applyParsedTelegramUpdate(store, tag, fakeUpdate, now);
    tag.telegramChatId = prevChatId;
    saveStore(store);

    res.status(201).json({
      ok: outcome.applied,
      message: outcome.replyMessage,
      serverTime: now,
    });
  });

  app.post('/api/telegram/webhook/:code', (req, res) => {
    const now = Date.now();
    const store = getCleanedStore(now);
    const code = (req.params.code || '').trim().toUpperCase();
    const tag = store.tags.find((t) => t.code.toUpperCase() === code);
    if (!tag || !tag.telegramEnabled) {
      res.status(200).json({ ok: true });
      return;
    }

    const update = req.body as TelegramIncomingUpdate;
    if (update && typeof update.update_id === 'number') {
      const outcome = applyParsedTelegramUpdate(store, tag, update, now);
      if (outcome.applied && outcome.replyMessage && tag.telegramBotToken && tag.telegramChatId) {
        void sendTelegramMessageWithRetry(
          tag.telegramBotToken,
          tag.telegramChatId,
          `✓ Reply delivered to scanner on ${tag.plateHint}: "${outcome.replyMessage.text}"`
        );
      }
    }
    res.status(200).json({ ok: true });
  });

  app.post('/api/owner/tags/:id/reply', requireOwnerAuth, (req, res) => {
    const now = Date.now();
    const store = getCleanedStore(now);
    const tag = store.tags.find((t) => t.id === req.params.id);
    if (!tag) {
      res.status(404).json({ error: 'Tag not found' });
      return;
    }

    const { text, sessionId } = req.body as { text?: unknown; sessionId?: unknown };
    const validation = validateOwnerReply(text);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    // Route reply to explicit scanner sessionId or the most recent scanner session on this tag
    const targetSessionId = resolveTargetScannerSession(store.messages, tag.id, sessionId);

    const msg: RelayMessage = {
      id: `msg-${now}-${Math.random().toString(36).slice(2, 6)}`,
      tagId: tag.id,
      sessionId: targetSessionId,
      sender: 'owner',
      senderAlias: 'Vehicle Owner (Anonymous)',
      text: validation.sanitizedText,
      createdAt: now,
    };

    store.messages.push(msg);
    cleanupStoreState(store, now);
    saveStore(store);
    res.status(201).json({ message: msg, serverTime: now });
  });

  app.post('/api/owner/tags/:id/hydrate', requireOwnerAuth, (req, res) => {
    const now = Date.now();
    const store = getCleanedStore(now);
    const tag = store.tags.find((t) => t.id === req.params.id);
    if (!tag) {
      res.status(404).json({ error: 'Tag not found' });
      return;
    }

    const { messages } = (req.body || {}) as { messages?: unknown };
    if (Array.isArray(messages)) {
      const existingIds = new Set(store.messages.map((m) => m.id));
      let added = false;
      for (const raw of messages) {
        if (
          raw &&
          typeof raw === 'object' &&
          typeof (raw as RelayMessage).id === 'string' &&
          typeof (raw as RelayMessage).text === 'string' &&
          ((raw as RelayMessage).sender === 'scanner' || (raw as RelayMessage).sender === 'owner')
        ) {
          const item = raw as RelayMessage;
          if (!existingIds.has(item.id)) {
            existingIds.add(item.id);
            store.messages.push({
              id: item.id.slice(0, 128),
              tagId: tag.id,
              sessionId: sanitizeScannerSessionId(item.sessionId) || undefined,
              sender: item.sender,
              senderAlias: (item.senderAlias || 'Passerby').slice(0, 40),
              text: item.text.slice(0, 500),
              createdAt: typeof item.createdAt === 'number' ? item.createdAt : now,
              viaTelegram: Boolean(item.viaTelegram),
            });
            added = true;
          }
        }
      }
      if (added) {
        cleanupStoreState(store, now);
        saveStore(store);
      }
    }

    res.json({ ok: true, count: store.messages.length, serverTime: now });
  });

  app.delete('/api/owner/tags/:id/messages', requireOwnerAuth, (req, res) => {
    const now = Date.now();
    const store = getCleanedStore(now);
    store.messages = store.messages.filter((m) => m.tagId !== req.params.id);
    saveStore(store);
    res.json({ ok: true, serverTime: now });
  });

  app.get('/api/public/tags/:code', async (req, res) => {
    const now = Date.now();
    const store = getCleanedStore(now);
    const code = (req.params.code || '').trim().toUpperCase();
    const tag = store.tags.find((t) => t.code.toUpperCase() === code);
    if (!tag) {
      res.setHeader('Cache-Control', 'public, max-age=30');
      res.status(404).json({ error: 'Windshield tag code not found.' });
      return;
    }

    const clientIp = extractClientIp(
      req.headers['x-forwarded-for'],
      req.ip || req.socket.remoteAddress
    );
    const initiallyActive = isContactWindowActive(tag.contactEnabled, tag.autoExpireAt, now);

    // Zero-Disruption DND Shield: When Reachable is OFF, block repeated QR spam in-memory before any I/O
    if (!initiallyActive) {
      const dndCheck = checkDndSpamShield(scannerRateLimitMap, `${code}:${clientIp}`, now);
      if (!dndCheck.allowed) {
        res.setHeader('Cache-Control', 'public, max-age=30');
        res.setHeader('Retry-After', String(dndCheck.retryAfterSeconds));
        res.status(429).json({
          tag: toPublicTagView(tag, now),
          messages: [],
          dndStandbyShield: true,
          retryAfterSeconds: dndCheck.retryAfterSeconds,
          serverTime: now,
        });
        return;
      }
    }

    await hydrateTagFromFirestoreIfNeeded(store, tag);

    const publicView = toPublicTagView(tag, now);

    // If tag is in Do Not Disturb (Reachable OFF), return cacheable minimal response without polling Telegram
    if (!publicView.contactEnabled) {
      res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
      res.json({
        tag: publicView,
        messages: [],
        dndStandbyShield: true,
        serverTime: now,
      });
      return;
    }

    // Tag is Reachable (ON): check for any direct Telegram replies from the owner
    await syncTelegramBotRepliesIfNeeded(store, tag, now);

    // Re-evaluate publicView in case the owner sent /dnd via Telegram just now
    const refreshedPublicView = toPublicTagView(tag, now);
    const rawSession = req.query.sessionId || req.headers['x-scanner-session'];
    const scannerSessionId = sanitizeScannerSessionId(rawSession);

    // Isolate conversation thread to the active scanner session only
    const thread = filterMessagesForPublicScanner(
      store.messages,
      tag.id,
      refreshedPublicView.contactEnabled,
      scannerSessionId
    );

    res.json({
      tag: refreshedPublicView,
      messages: thread,
      serverTime: now,
    });
  });

  app.post('/api/public/tags/:code/messages', async (req, res) => {
    const now = Date.now();
    const store = getCleanedStore(now);
    const code = (req.params.code || '').trim().toUpperCase();
    const tag = store.tags.find((t) => t.code.toUpperCase() === code);
    if (!tag) {
      res.status(404).json({ error: 'Windshield tag code not found.' });
      return;
    }

    const clientIp = extractClientIp(
      req.headers['x-forwarded-for'],
      req.ip || req.socket.remoteAddress
    );

    // Fast in-memory DND spam guard before any external Firestore/Telegram calls
    if (!isContactWindowActive(tag.contactEnabled, tag.autoExpireAt, now)) {
      const dndCheck = checkDndSpamShield(scannerRateLimitMap, `post:${code}:${clientIp}`, now);
      if (!dndCheck.allowed) {
        res.setHeader('Retry-After', String(dndCheck.retryAfterSeconds));
        res.status(429).json({
          error: 'Vehicle is in Do Not Disturb mode. Requests are paused.',
          retryAfterSeconds: dndCheck.retryAfterSeconds,
        });
        return;
      }
    }

    await hydrateTagFromFirestoreIfNeeded(store, tag);

    const contactActive = isContactWindowActive(tag.contactEnabled, tag.autoExpireAt, now);
    const { text, category, senderAlias, sessionId } = (req.body || {}) as {
      text?: unknown;
      category?: unknown;
      senderAlias?: unknown;
      sessionId?: unknown;
    };

    const validation = validateIncomingMessage(text, contactActive);
    if (!validation.valid) {
      res.status(403).json({ error: validation.error });
      return;
    }

    const scannerSessionId =
      sanitizeScannerSessionId(sessionId || req.headers['x-scanner-session']) ||
      `scan-${crypto.randomBytes(6).toString('hex')}`;

    // Prevent accidental double-tap duplicate message bursts within 2 seconds
    const recentDuplicate = store.messages.find(
      (m) =>
        m.tagId === tag.id &&
        m.sender === 'scanner' &&
        m.text === validation.sanitizedText &&
        now - m.createdAt < 2000
    );
    if (recentDuplicate) {
      res.status(200).json({
        message: recentDuplicate,
        sessionId: recentDuplicate.sessionId || scannerSessionId,
        telegramForwarded: Boolean(recentDuplicate.telegramForwarded),
        deduplicated: true,
      });
      return;
    }

    // Per-scanner/IP sliding-window rate limit (max 5 alerts per 60s)
    const rateKey = `${tag.code}:${scannerSessionId}:${clientIp}`;
    const rateCheck = checkScannerRateLimit(scannerRateLimitMap, rateKey, now);
    if (!rateCheck.allowed) {
      res.status(429).json({
        error: `Rate limit reached. Please wait ${rateCheck.retryAfterSeconds}s before sending another alert.`,
        retryAfterSeconds: rateCheck.retryAfterSeconds,
      });
      return;
    }

    const rawAlias = typeof senderAlias === 'string' ? senderAlias.trim().slice(0, 32) : '';
    const cleanAlias =
      rawAlias || `Passerby #${Math.floor(100 + Math.random() * 900)}`;

    const cleanCategory =
      typeof category === 'string' && category.trim()
        ? category.trim().slice(0, 24)
        : undefined;

    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = req.get('host');
    const fallbackOrigin = host ? `${proto}://${host}` : undefined;

    const telegramResult = await forwardToTelegramIfConfigured(
      tag,
      cleanAlias,
      validation.sanitizedText,
      cleanCategory,
      scannerSessionId,
      fallbackOrigin
    );

    const newMsg: RelayMessage = {
      id: `msg-${now}-${Math.random().toString(36).slice(2, 6)}`,
      tagId: tag.id,
      sessionId: scannerSessionId,
      sender: 'scanner',
      senderAlias: cleanAlias,
      text: validation.sanitizedText,
      category: cleanCategory,
      createdAt: now,
      telegramForwarded: telegramResult.forwarded,
    };

    store.messages.push(newMsg);
    cleanupStoreState(store, now);
    saveStore(store);

    res.status(201).json({
      message: newMsg,
      sessionId: scannerSessionId,
      telegramForwarded: telegramResult.forwarded,
      serverTime: now,
    });
  });

  // Catch unmatched /api/* routes before SPA fallback
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  const distPath = path.join(process.cwd(), 'dist');
  const distIndexHtml = path.join(distPath, 'index.html');
  const isProduction =
    process.env.NODE_ENV === 'production' && fs.existsSync(distIndexHtml);

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(
      express.static(distPath, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=3600');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      if (fs.existsSync(distIndexHtml)) {
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(distIndexHtml);
      } else {
        res.status(503).send('Application build is initializing. Please refresh.');
      }
    });
  }

  // Global JSON & unexpected error handler
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError || err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON payload.' });
      return;
    }
    if (err.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request payload too large (max 16KB).' });
      return;
    }
    console.error('Unhandled server error:', err);
    res.status(err.status || 500).json({ error: 'Internal server error.' });
  });

  // Periodic background housekeeping for expired timers & rate-limit windows
  const maintenanceTimer = setInterval(() => {
    getCleanedStore(Date.now());
  }, 60_000);
  maintenanceTimer.unref();

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`RelayTag server running on http://localhost:${PORT}`);
  });

  const handleShutdown = () => {
    if (memoryStore) {
      saveStore(memoryStore);
    }
    server.close(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
}

startServer();



