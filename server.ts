import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type TagConfig,
  type RelayMessage,
  type TelegramIncomingUpdate,
  AUTHORIZED_OWNER_EMAIL,
  isContactWindowActive,
  toOwnerTagView,
  resolveUpdatedBotToken,
  toPublicTagView,
  sanitizeScannerSessionId,
  filterMessagesForPublicScanner,
  checkScannerRateLimit,
  pruneRateLimitMap,
  resolveTargetScannerSession,
  isAuthorizedOwnerEmail,
  validateOwnerPinFormat,
  evaluateOwnerSessionRequest,
  verifyOwnerAccess,
  verifySameOriginRequest,
  validateIncomingMessage,
  validateOwnerReply,
  validateTelegramCredentials,
  formatTelegramRelayPayload,
  parseTelegramUpdateForOwnerReply,
  isStaleTelegramBacklogUpdate,
  checkDndSpamShield,
  checkTagDndCeiling,
  checkLookupBudget,
  checkTagAlertCeiling,
  cleanupStoreState,
  createInitialTagConfig,
  hasTagSetupData,
  normalizePersistedTagFields,
  extractClientIp,
  assertVaultSecretConfigured,
  buildOwnerSessionCookie,
  computeHealthSummary,
  generateNewTagCode,
} from './src/utils/relayLogic.ts';

const SERVER_STARTED_AT = Date.now();
const OWNER_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12-hour bounded session lifetime
const API_REQUESTS_PER_MINUTE = 240; // scanner pages poll every few seconds, so this leaves ample headroom
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

assertVaultSecretConfigured(process.env.RELAYTAG_VAULT_SECRET, process.env.NODE_ENV);

// Server-only secret entropy (never exposed to browser bundle) combined with project identifiers
const SERVER_ONLY_ENTROPY =
  process.env.RELAYTAG_VAULT_SECRET || process.env.GEMINI_API_KEY || '';

const PRIMARY_VAULT_KEY = crypto.scryptSync(
  `relaytag-vault-v2:${SERVER_ONLY_ENTROPY}:${firebaseConfig.projectId || ''}:${firebaseConfig.firestoreDatabaseId || ''}:${firebaseConfig.appId || 'relaytag-v1'}`,
  'relaytag-aes-gcm-salt-v2',
  32
);

// Config-derived & legacy fallback keys for backwards-compatible decryption of previously stored vaults
const STABLE_VAULT_KEY = crypto.scryptSync(
  `relaytag-vault:${firebaseConfig.projectId || ''}:${firebaseConfig.firestoreDatabaseId || ''}:${firebaseConfig.appId || 'relaytag-v1'}`,
  'relaytag-aes-gcm-salt-v1',
  32
);

const LEGACY_VAULT_KEY = crypto.scryptSync(
  `${process.env.GEMINI_API_KEY || ''}:${process.env.GOOGLE_CLOUD_PROJECT || ''}:${firebaseConfig.appId || 'relaytag-v1'}`,
  'relaytag-aes-gcm-salt-v1',
  32
);

function hashOwnerPin(cleanPin: string): string {
  const derived = crypto.scryptSync(`owner-pin:${cleanPin}`, PRIMARY_VAULT_KEY, 32);
  return `pin_v1_${derived.toString('hex')}`;
}

function hashOwnerPinLegacy(cleanPin: string): string {
  const derived = crypto.scryptSync(`owner-pin:${cleanPin}`, STABLE_VAULT_KEY, 32);
  return `pin_v1_${derived.toString('hex')}`;
}

function verifyOwnerPinHash(candidatePin: unknown, storedHash?: string | null): boolean {
  if (!storedHash || typeof storedHash !== 'string' || !storedHash.startsWith('pin_v1_')) {
    return false;
  }
  const check = validateOwnerPinFormat(candidatePin);
  if (!check.valid) return false;
  const storedBuf = Buffer.from(storedHash, 'utf8');
  const primaryBuf = Buffer.from(hashOwnerPin(check.cleanPin), 'utf8');
  if (primaryBuf.length === storedBuf.length && crypto.timingSafeEqual(primaryBuf, storedBuf)) {
    return true;
  }
  const legacyBuf = Buffer.from(hashOwnerPinLegacy(check.cleanPin), 'utf8');
  if (legacyBuf.length === storedBuf.length && crypto.timingSafeEqual(legacyBuf, storedBuf)) {
    return true;
  }
  return false;
}

function mintSignedOwnerToken(nowMs: number, pinHash?: string | null): string {
  const issuedHex = nowMs.toString(16);
  const nonce = crypto.randomBytes(16).toString('hex');
  const pinFingerprint = (pinHash || 'no-pin').slice(-12);
  const sig = crypto
    .createHmac('sha256', PRIMARY_VAULT_KEY)
    .update(`sess:${issuedHex}:${nonce}:${pinFingerprint}`)
    .digest('hex')
    .slice(0, 32);
  return `rt_own_v2_${issuedHex}_${nonce}_${sig}`;
}

function isSignedOwnerTokenValidAndFresh(
  token: string | null | undefined,
  nowMs: number,
  pinHash?: string | null
): boolean {
  if (!token || typeof token !== 'string') return false;
  const trimmed = token.trim();
  if (!trimmed.startsWith('rt_own_v2_')) {
    return false;
  }
  const parts = trimmed.split('_');
  // ['rt', 'own', 'v2', issuedHex, nonce, sig]
  if (parts.length !== 6) return false;
  const [, , , issuedHex, nonce, sig] = parts;
  const issuedMs = Number.parseInt(issuedHex, 16);
  if (!Number.isFinite(issuedMs) || issuedMs <= 0) return false;
  if (nowMs - issuedMs > OWNER_SESSION_TTL_MS || issuedMs > nowMs + 60_000) {
    return false;
  }
  const pinFingerprint = (pinHash || 'no-pin').slice(-12);
  const expectedSig = crypto
    .createHmac('sha256', PRIMARY_VAULT_KEY)
    .update(`sess:${issuedHex}:${nonce}:${pinFingerprint}`)
    .digest('hex')
    .slice(0, 32);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getActiveValidOwnerTokens(
  store: StoreSchema,
  nowMs: number,
  pinHash?: string | null
): Set<string> {
  const rawList = Array.isArray(store.ownerTokens) ? store.ownerTokens : [];
  const valid = new Set<string>();
  for (const tok of rawList) {
    if (isSignedOwnerTokenValidAndFresh(tok, nowMs, pinHash)) {
      valid.add(tok);
    }
  }
  if (valid.size !== rawList.length) {
    store.ownerTokens = [...valid];
  }
  return valid;
}

function computeTelegramWebhookSecret(tagCode: string, botToken: string): string {
  return crypto
    .createHmac('sha256', PRIMARY_VAULT_KEY)
    .update(`tg-webhook:${tagCode.trim().toUpperCase()}:${botToken.trim()}`)
    .digest('hex')
    .slice(0, 48);
}

function computeVaultId(tagCode: string, key: Buffer = PRIMARY_VAULT_KEY): string {
  const hmac = crypto
    .createHmac('sha256', key)
    .update(`vault:${tagCode.trim().toUpperCase()}`)
    .digest('hex')
    .slice(0, 32);
  return `vlt_${hmac}`;
}

function encryptRelayVault(payload: {
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  ownerPinHash?: string | null;
  ownerEmail?: string | null;
}): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', PRIMARY_VAULT_KEY, iv);
  const plain = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function buildVaultForTag(tag: TagConfig): { vaultId: string; ciphertext: string } {
  return {
    vaultId: computeVaultId(tag.code),
    ciphertext: encryptRelayVault({
      telegramEnabled: tag.telegramEnabled,
      telegramBotToken: tag.telegramBotToken,
      telegramChatId: tag.telegramChatId,
      ownerPinHash: tag.ownerPinHash || null,
      ownerEmail: tag.ownerEmail || AUTHORIZED_OWNER_EMAIL,
    }),
  };
}

function decryptRelayVaultWithKey(
  ciphertext: string,
  key: Buffer
): {
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  ownerPinHash?: string | null;
  ownerEmail?: string | null;
} | null {
  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encrypted = Buffer.from(parts[3], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(decrypted);
    if (typeof parsed.telegramEnabled === 'boolean' && typeof parsed.telegramBotToken === 'string') {
      return {
        telegramEnabled: parsed.telegramEnabled,
        telegramBotToken: parsed.telegramBotToken,
        telegramChatId: typeof parsed.telegramChatId === 'string' ? parsed.telegramChatId : '',
        ownerPinHash: typeof parsed.ownerPinHash === 'string' ? parsed.ownerPinHash : null,
        ownerEmail: typeof parsed.ownerEmail === 'string' ? parsed.ownerEmail : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function decryptRelayVault(ciphertext: string): {
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  ownerPinHash?: string | null;
  ownerEmail?: string | null;
} | null {
  return (
    decryptRelayVaultWithKey(ciphertext, PRIMARY_VAULT_KEY) ||
    decryptRelayVaultWithKey(ciphertext, STABLE_VAULT_KEY) ||
    decryptRelayVaultWithKey(ciphertext, LEGACY_VAULT_KEY)
  );
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
const lastLocalMutationMap = new Map<string, number>();
const missingTagLookupCache = new Map<string, number>();

function pruneBoundedTimestampMap(map: Map<string, number>, now: number, ttlMs: number, maxEntries = 500): void {
  for (const [k, ts] of map.entries()) {
    if (now - ts > ttlMs) {
      map.delete(k);
    }
  }
  if (map.size > maxEntries) {
    const overflow = map.size - maxEntries;
    const iter = map.keys();
    for (let i = 0; i < overflow; i++) {
      const next = iter.next();
      if (next.done) break;
      map.delete(next.value);
    }
  }
}

// 'missing' means Firestore answered and has no such tag; 'unavailable' means we could not ask
// (timeout, network, 429/5xx). Callers must not report a real tag as nonexistent for the latter.
type HydrationOutcome = 'ok' | 'missing' | 'unavailable';

class TagLookupUnavailableError extends Error {}

const HYDRATE_REFRESH_MS = 30_000;
const HYDRATE_RETRY_AFTER_FAILURE_MS = 5_000;

async function hydrateTagFromFirestoreIfNeeded(
  store: StoreSchema,
  tag: TagConfig,
  forceLookup = false
): Promise<HydrationOutcome> {
  const code = tag.code.toUpperCase();
  const now = Date.now();
  const lastHydrated = hydratedTagTimestamps.get(code) || 0;
  // Re-verify from Firestore on cold start (lastHydrated === 0) or every 30s when public scanners poll
  if (!forceLookup && lastHydrated > 0 && now - lastHydrated < HYDRATE_REFRESH_MS) {
    return 'ok';
  }
  if (!firebaseConfig.projectId || !firebaseConfig.firestoreDatabaseId) {
    return 'missing';
  }

  hydratedTagTimestamps.set(code, now);
  // A failed lookup must not freeze a stale (default, Do Not Disturb) tag for a full refresh window.
  const retrySoon = () => {
    hydratedTagTimestamps.set(code, Date.now() - (HYDRATE_REFRESH_MS - HYDRATE_RETRY_AFTER_FAILURE_MS));
  };
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    firebaseConfig.projectId
  )}/databases/${encodeURIComponent(firebaseConfig.firestoreDatabaseId)}/documents`;
  const keyParam = firebaseConfig.apiKey ? `?key=${encodeURIComponent(firebaseConfig.apiKey)}` : '';

  try {
    const tagUrl = `${baseUrl}/tags/${encodeURIComponent(code)}${keyParam}`;
    const primaryVaultId = computeVaultId(code, PRIMARY_VAULT_KEY);
    const stableVaultId = computeVaultId(code, STABLE_VAULT_KEY);
    const legacyVaultId = computeVaultId(code, LEGACY_VAULT_KEY);
    const vaultUrl = `${baseUrl}/tags/${encodeURIComponent(code)}/vault/${encodeURIComponent(primaryVaultId)}${keyParam}`;

    const [tagRes, primaryVaultRes] = await Promise.all([
      fetch(tagUrl, { signal: AbortSignal.timeout(3500) }).catch(() => null),
      fetch(vaultUrl, { signal: AbortSignal.timeout(3500) }).catch(() => null),
    ]);

    if (!tagRes || tagRes.status === 429 || tagRes.status >= 500) {
      retrySoon();
      return 'unavailable';
    }
    if (!tagRes.ok) {
      return 'missing';
    }

    let vaultRes = primaryVaultRes;
    if ((!vaultRes || !vaultRes.ok) && stableVaultId !== primaryVaultId) {
      const stableUrl = `${baseUrl}/tags/${encodeURIComponent(code)}/vault/${encodeURIComponent(stableVaultId)}${keyParam}`;
      vaultRes = await fetch(stableUrl, { signal: AbortSignal.timeout(2500) }).catch(() => null);
    }
    if ((!vaultRes || !vaultRes.ok) && legacyVaultId !== primaryVaultId && legacyVaultId !== stableVaultId) {
      const legacyUrl = `${baseUrl}/tags/${encodeURIComponent(code)}/vault/${encodeURIComponent(legacyVaultId)}${keyParam}`;
      vaultRes = await fetch(legacyUrl, { signal: AbortSignal.timeout(2500) }).catch(() => null);
    }

    const docJson = (await tagRes.json()) as {
      updateTime?: string;
      fields?: Record<
        string,
        {
          stringValue?: string;
          booleanValue?: boolean;
          integerValue?: string;
          doubleValue?: number;
          timestampValue?: string;
        }
      >;
    };
    const f = docJson.fields;
    if (!f) {
      return 'missing';
    }

    const fsUpdatedIso = f.updatedAt?.timestampValue || docJson.updateTime || '';
    const fsUpdatedMs = fsUpdatedIso ? Date.parse(fsUpdatedIso) : 0;
    const lastLocalMutation = lastLocalMutationMap.get(code) || 0;
    // Apply Firestore tag fields if no local mutation has occurred in this server process yet, or if Firestore has a newer timestamp
    const shouldApplyTagDoc =
      forceLookup ||
      lastLocalMutation === 0 ||
      (Number.isFinite(fsUpdatedMs) && fsUpdatedMs > lastLocalMutation + 2000);

    let mutated = false;

    if (shouldApplyTagDoc) {
      if (f.ownerId?.stringValue) tag.ownerUid = f.ownerId.stringValue;
      const normalized = normalizePersistedTagFields({
        code,
        vehicleLabel: f.vehicleLabel?.stringValue,
        plateNumber: f.plateNumber?.stringValue,
        statusNote: f.statusNote?.stringValue,
      });
      tag.vehicleLabel = normalized.vehicleLabel;
      tag.plateHint = normalized.plateHint;
      tag.statusNote = normalized.statusNote;
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
      if (Number.isFinite(fsUpdatedMs) && fsUpdatedMs > 0) {
        tag.updatedAt = fsUpdatedMs;
      }
      mutated = true;
    }

    if (vaultRes && vaultRes.ok && (shouldApplyTagDoc || !tag.telegramBotToken || !tag.ownerPinHash)) {
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
          if (decrypted.ownerPinHash !== undefined) {
            tag.ownerPinHash = decrypted.ownerPinHash;
          }
          if (decrypted.ownerEmail) {
            tag.ownerEmail = decrypted.ownerEmail;
          }
          mutated = true;
        }
      }
    }

    if (mutated) {
      cleanupStoreState(store, Date.now());
      saveStore(store);
    }
    return 'ok';
  } catch {
    retrySoon();
    return 'unavailable';
  }
}

async function findOrHydrateTagByCode(
  store: StoreSchema,
  rawCode: string,
  now: number
): Promise<TagConfig | null> {
  const code = (rawCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,20}$/.test(code)) {
    return null;
  }

  const existing = store.tags.find((t) => t.code.toUpperCase() === code);
  if (existing) {
    await hydrateTagFromFirestoreIfNeeded(store, existing);
    return existing;
  }

  // Check negative lookup cache for unknown or rotated codes not yet in memory
  const lastMiss = missingTagLookupCache.get(code) || 0;
  if (lastMiss > 0 && now - lastMiss < 30_000) {
    return null;
  }

  const candidateTag: TagConfig = {
    ...createInitialTagConfig(now),
    id: store.tags[0]?.id || 'tag-default',
    code,
  };

  const outcome = await hydrateTagFromFirestoreIfNeeded(store, candidateTag, true);
  if (outcome === 'unavailable') {
    throw new TagLookupUnavailableError('Tag lookup temporarily unavailable.');
  }
  if (outcome === 'missing') {
    pruneBoundedTimestampMap(missingTagLookupCache, now, 30_000);
    missingTagLookupCache.set(code, now);
    return null;
  }

  missingTagLookupCache.delete(code);
  const primary = store.tags[0];
  if (
    primary &&
    ((!hasTagSetupData(primary) && !primary.ownerUid && !lastLocalMutationMap.has(primary.code.toUpperCase())) ||
      (primary.ownerUid && candidateTag.ownerUid && primary.ownerUid === candidateTag.ownerUid))
  ) {
    Object.assign(primary, candidateTag, { id: primary.id });
    saveStore(store);
    return primary;
  }

  candidateTag.id = `tag-${code.toLowerCase()}`;
  store.tags.push(candidateTag);
  saveStore(store);
  return candidateTag;
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

function extractFirebaseEmail(req: Request): string | null {
  const headerEmail = req.headers['x-firebase-email'];
  if (typeof headerEmail === 'string' && headerEmail.trim().length <= 120) {
    return headerEmail.trim().toLowerCase();
  }
  return null;
}

interface VerifiedFirebaseIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
  expiresAtMs: number;
}

const verifiedIdTokenCache = new Map<string, VerifiedFirebaseIdentity>();

async function verifyFirebaseBearerTokenIfPresent(
  req: Request,
  now: number
): Promise<VerifiedFirebaseIdentity | null> {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const idToken = authHeader.slice('Bearer '.length).trim();
  if (!idToken || idToken.length < 32) {
    return null;
  }

  const cached = verifiedIdTokenCache.get(idToken);
  if (cached && cached.expiresAtMs > now) {
    return cached;
  }

  if (!firebaseConfig.apiKey) {
    return null;
  }

  try {
    const lookupUrl = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(
      firebaseConfig.apiKey
    )}`;
    const res = await fetch(lookupUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
      signal: AbortSignal.timeout(3500),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      users?: Array<{
        localId?: string;
        email?: string;
        emailVerified?: boolean;
      }>;
    };
    const user = data.users?.[0];
    if (!user?.localId || !user?.email) return null;

    const identity: VerifiedFirebaseIdentity = {
      uid: user.localId.trim(),
      email: user.email.trim().toLowerCase(),
      emailVerified: Boolean(user.emailVerified),
      expiresAtMs: now + 5 * 60 * 1000,
    };

    if (verifiedIdTokenCache.size > 200) {
      verifiedIdTokenCache.clear();
    }
    verifiedIdTokenCache.set(idToken, identity);
    return identity;
  } catch {
    return null;
  }
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
  text: string
): Promise<{ forwarded: boolean; error?: string }> {
  if (!tag.telegramEnabled || !tag.telegramBotToken.trim() || !tag.telegramChatId.trim()) {
    return { forwarded: false };
  }
  return sendTelegramMessageWithRetry(
    tag.telegramBotToken,
    tag.telegramChatId,
    formatTelegramRelayPayload(tag, text)
  );
}

function applyParsedTelegramUpdate(
  store: StoreSchema,
  tag: TagConfig,
  update: TelegramIncomingUpdate,
  now: number,
  dropIfStale = false
): { applied: boolean; replyMessage?: RelayMessage; dndChanged?: boolean } {
  if (typeof update.update_id === 'number' && update.update_id > (tag.lastTelegramUpdateId || 0)) {
    tag.lastTelegramUpdateId = update.update_id;
  }
  // Acknowledged (the offset above moves past it) but never acted on.
  if (dropIfStale && isStaleTelegramBacklogUpdate(update, now)) {
    return { applied: false };
  }

  const parsed = parseTelegramUpdateForOwnerReply(
    update,
    tag.telegramChatId,
    store.messages,
    tag.id
  );

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
    lastLocalMutationMap.set(tag.code.toUpperCase(), now);
    hydratedTagTimestamps.set(tag.code.toUpperCase(), now);
    saveStore(store);
    return { applied: true, dndChanged: true };
  }

  if (parsed.action === 'command-on') {
    tag.contactEnabled = true;
    tag.autoExpireAt = null;
    tag.updatedAt = now;
    lastLocalMutationMap.set(tag.code.toUpperCase(), now);
    hydratedTagTimestamps.set(tag.code.toUpperCase(), now);
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
    const vehicleDisplay = tag.plateHint || tag.vehicleLabel || tag.code;
    // Nothing handled yet in this process: this batch may be a backlog from before a restart.
    const isFirstPollOfProcess = !tag.lastTelegramUpdateId;
    for (const upd of data.result) {
      const prevMax = tag.lastTelegramUpdateId || 0;
      const outcome = applyParsedTelegramUpdate(store, tag, upd, Date.now(), isFirstPollOfProcess);
      if ((tag.lastTelegramUpdateId || 0) > prevMax) {
        maxUpdateUpdated = true;
      }
      if (outcome.applied) {
        appliedCount++;
        if (outcome.replyMessage) {
          void sendTelegramMessageWithRetry(
            tag.telegramBotToken,
            tag.telegramChatId,
            `✓ Reply delivered to scanner on ${vehicleDisplay}: "${outcome.replyMessage.text}"`
          );
        } else if (outcome.dndChanged) {
          void sendTelegramMessageWithRetry(
            tag.telegramBotToken,
            tag.telegramChatId,
            tag.contactEnabled
              ? `🟢 ${vehicleDisplay} is now Reachable (ON).`
              : `🔒 ${vehicleDisplay} switched to Do Not Disturb (OFF). Incoming QR scans are now paused.`
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

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Production reverse-proxy & security hardening
  app.disable('x-powered-by');
  // Number of reverse-proxy hops that append to X-Forwarded-For. Must match the real topology:
  // too high lets clients spoof their rate-limit identity, 0 behind a proxy collapses all users to one IP.
  const trustProxyHops = Number.parseInt(
    process.env.TRUST_PROXY_HOPS ?? (process.env.NODE_ENV === 'production' ? '1' : '0'),
    10
  );
  app.set('trust proxy', Number.isInteger(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 0);

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

  // Blanket per-IP ceiling on every API call, ahead of body parsing and any Firestore/Telegram I/O.
  // Route-specific limiters (PIN, scanner messages, DND shield) stay stricter.
  app.use('/api', (req, res, next) => {
    const now = Date.now();
    const ip = extractClientIp(req.ip || req.socket.remoteAddress);
    const check = checkScannerRateLimit(scannerRateLimitMap, `api:${ip}`, now, API_REQUESTS_PER_MINUTE, 60_000);
    if (!check.allowed) {
      res.setHeader('Retry-After', String(check.retryAfterSeconds));
      res.status(429).json({
        error: 'Too many requests. Please slow down.',
        retryAfterSeconds: check.retryAfterSeconds,
      });
      return;
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

  // Check current owner session & security gate configuration (safe for unauthenticated gate display)
  app.get(
    '/api/owner/auth-status',
    asyncHandler(async (req, res) => {
      const now = Date.now();
      const store = getCleanedStore(now);
      const primaryTag = store.tags[0];
      if (primaryTag) {
        await hydrateTagFromFirestoreIfNeeded(store, primaryTag);
      }

      const validTokens = getActiveValidOwnerTokens(store, now, primaryTag?.ownerPinHash);
      const providedToken = extractOwnerToken(req);
      const providedFirebaseUid = extractFirebaseUid(req);
      const providedOwnerEmail = extractFirebaseEmail(req);

      const check = verifyOwnerAccess({
        providedToken,
        validTokens,
        tagOwnerUid: primaryTag?.ownerUid,
        providedFirebaseUid,
        providedOwnerEmail,
        allowedOwnerEmail: primaryTag?.ownerEmail || AUTHORIZED_OWNER_EMAIL,
      });

      res.json({
        authenticated: check.authorized,
        pinConfigured: Boolean(primaryTag?.ownerPinHash),
        authorizedEmail: primaryTag?.ownerEmail || AUTHORIZED_OWNER_EMAIL,
        serverTime: now,
      });
    })
  );

  // Bootstrap or verify an authenticated owner session (requires cryptographically verified Google owner token or Owner Security PIN)
  app.post(
    '/api/owner/session',
    asyncHandler(async (req, res) => {
      if (!verifySameOriginRequest(req.headers.origin, req.get('host'))) {
        res.status(403).json({ error: 'Forbidden: Cross-origin session request rejected.' });
        return;
      }

      const now = Date.now();
      const store = getCleanedStore(now);
      if (!Array.isArray(store.ownerTokens)) {
        store.ownerTokens = [];
      }

      const primaryTag = store.tags[0];
      if (primaryTag) {
        await hydrateTagFromFirestoreIfNeeded(store, primaryTag);
      }

      const clientIp = extractClientIp(req.ip || req.socket.remoteAddress);

      // Global per-IP rate limit on session creation attempts (prevents token/PIN brute-forcing)
      const sessionRateCheck = checkScannerRateLimit(
        scannerRateLimitMap,
        `owner-session:${clientIp}`,
        now,
        15,
        60_000
      );
      if (!sessionRateCheck.allowed) {
        res.status(429).json({
          error: `Too many authentication attempts. Please wait ${sessionRateCheck.retryAfterSeconds}s before trying again.`,
          retryAfterSeconds: sessionRateCheck.retryAfterSeconds,
        });
        return;
      }

      const verifiedBearer = await verifyFirebaseBearerTokenIfPresent(req, now);
      const existingToken = extractOwnerToken(req);
      const rawHeaderUid = extractFirebaseUid(req);
      const rawHeaderEmail = extractFirebaseEmail(req);

      // CRITICAL ZERO-TRUST INVARIANT: Never fall back to unverified X-Firebase-Uid / X-Firebase-Email headers
      const firebaseUid = verifiedBearer ? verifiedBearer.uid : null;
      const firebaseEmail = verifiedBearer ? verifiedBearer.email : null;
      const unverifiedHeaderPresent = Boolean(!verifiedBearer && (rawHeaderUid || rawHeaderEmail));

      const rawPin = (req.body as { pin?: unknown } | undefined)?.pin;
      const pinAttemptProvided = typeof rawPin === 'string' && rawPin.trim().length > 0;

      // Strict rate-limit on PIN attempts per IP (5 attempts per 60s)
      if (pinAttemptProvided) {
        const pinRateCheck = checkScannerRateLimit(
          scannerRateLimitMap,
          `owner-pin:${clientIp}`,
          now,
          5,
          60_000
        );
        if (!pinRateCheck.allowed) {
          res.status(429).json({
            error: `Too many PIN attempts. Please wait ${pinRateCheck.retryAfterSeconds}s before trying again.`,
            retryAfterSeconds: pinRateCheck.retryAfterSeconds,
          });
          return;
        }
      }

      const pinVerified = pinAttemptProvided
        ? verifyOwnerPinHash(rawPin, primaryTag?.ownerPinHash)
        : false;

      const validTokens = getActiveValidOwnerTokens(store, now, primaryTag?.ownerPinHash);

      const evalResult = evaluateOwnerSessionRequest({
        existingToken,
        validTokens,
        firebaseUid,
        firebaseEmail,
        firebaseTokenVerified: Boolean(verifiedBearer),
        firebaseEmailVerified: verifiedBearer?.emailVerified ?? false,
        unverifiedHeaderPresent,
        tagOwnerUid: primaryTag?.ownerUid,
        allowedOwnerEmail: primaryTag?.ownerEmail || AUTHORIZED_OWNER_EMAIL,
        pinVerified,
        pinAttemptProvided,
      });

      if (!evalResult.allowed) {
        res.status(evalResult.status).json({
          error: evalResult.error,
          pinConfigured: Boolean(primaryTag?.ownerPinHash),
        });
        return;
      }

      const token =
        existingToken && validTokens.has(existingToken)
          ? existingToken
          : mintSignedOwnerToken(now, primaryTag?.ownerPinHash);

      if (!store.ownerTokens.includes(token)) {
        store.ownerTokens.push(token);
        if (store.ownerTokens.length > 25) {
          store.ownerTokens = store.ownerTokens.slice(-25);
        }
      }

      // Bind tag ownerUid & ownerEmail ONLY when cryptographically verified Google owner signs in
      if (
        primaryTag &&
        verifiedBearer &&
        verifiedBearer.emailVerified &&
        isAuthorizedOwnerEmail(verifiedBearer.email, primaryTag.ownerEmail || AUTHORIZED_OWNER_EMAIL)
      ) {
        if (!primaryTag.ownerUid) {
          primaryTag.ownerUid = verifiedBearer.uid;
        }
        primaryTag.ownerEmail = verifiedBearer.email || AUTHORIZED_OWNER_EMAIL;
      }

      saveStore(store);

      const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      const isSecureReq = Boolean(req.secure || forwardedProto === 'https');
      res.setHeader('Set-Cookie', buildOwnerSessionCookie(token, isSecureReq));
      res.json({
        token,
        authMethod: evalResult.authMethod,
        pinConfigured: Boolean(primaryTag?.ownerPinHash),
        serverTime: now,
      });
    })
  );

  // Revoke active owner session token & lock console immediately
  app.post('/api/owner/logout', (req, res) => {
    const now = Date.now();
    const store = getCleanedStore(now);
    const existingToken = extractOwnerToken(req);
    if (existingToken && Array.isArray(store.ownerTokens)) {
      store.ownerTokens = store.ownerTokens.filter((t) => t !== existingToken);
      saveStore(store);
    }
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const isSecureReq = Boolean(req.secure || forwardedProto === 'https');
    const sameSitePart = isSecureReq ? 'SameSite=None; Secure' : 'SameSite=Lax';
    res.setHeader(
      'Set-Cookie',
      `relaytag_owner_token=; Path=/; HttpOnly; ${sameSitePart}; Max-Age=0`
    );
    res.json({ ok: true, serverTime: now });
  });

  // Guard middleware for all /api/owner/* endpoints
  const requireOwnerAuth = (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!verifySameOriginRequest(req.headers.origin, req.get('host'))) {
        res.status(403).json({ error: 'Forbidden: Cross-origin mutation rejected.' });
        return;
      }
    }

    const now = Date.now();
    const store = getCleanedStore(now);
    const primaryTag = store.tags[0];
    const validTokens = getActiveValidOwnerTokens(store, now, primaryTag?.ownerPinHash);
    const providedToken = extractOwnerToken(req);
    const providedFirebaseUid = extractFirebaseUid(req);
    const providedOwnerEmail = extractFirebaseEmail(req);

    const check = verifyOwnerAccess({
      providedToken,
      validTokens,
      tagOwnerUid: primaryTag?.ownerUid,
      providedFirebaseUid,
      providedOwnerEmail,
      allowedOwnerEmail: primaryTag?.ownerEmail || AUTHORIZED_OWNER_EMAIL,
    });

    if (!check.authorized) {
      res.status(check.status).json({ error: check.error });
      return;
    }

    next();
  };

  // Set, update, or remove the 4-8 digit Owner Security PIN (rotates session tokens to revoke prior PIN sessions)
  app.post('/api/owner/tags/:id/security-pin', requireOwnerAuth, (req, res) => {
    const now = Date.now();
    const store = getCleanedStore(now);
    const tag = store.tags.find((t) => t.id === req.params.id);
    if (!tag) {
      res.status(404).json({ error: 'Tag not found' });
      return;
    }

    const { pin, remove } = (req.body || {}) as { pin?: unknown; remove?: unknown };

    // Allow clearing PIN if remove === true, null, or empty string is passed
    if (remove === true || pin === null || (typeof pin === 'string' && pin.trim() === '')) {
      tag.ownerPinHash = null;
      tag.updatedAt = now;
      // Revoke all old session tokens and issue a fresh token bound to the updated PIN state
      const rotatedToken = mintSignedOwnerToken(now, null);
      store.ownerTokens = [rotatedToken];
      lastLocalMutationMap.set(tag.code.toUpperCase(), now);
      hydratedTagTimestamps.set(tag.code.toUpperCase(), now);
      saveStore(store);
      const vault = buildVaultForTag(tag);
      const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      const isSecureReq = Boolean(req.secure || forwardedProto === 'https');
      res.setHeader('Set-Cookie', buildOwnerSessionCookie(rotatedToken, isSecureReq));
      res.json({
        ok: true,
        pinConfigured: false,
        token: rotatedToken,
        tag: toOwnerTagView(tag),
        vault,
        serverTime: now,
      });
      return;
    }

    const pinCheck = validateOwnerPinFormat(pin);
    if (!pinCheck.valid) {
      res.status(400).json({ error: pinCheck.error });
      return;
    }

    tag.ownerPinHash = hashOwnerPin(pinCheck.cleanPin);
    tag.updatedAt = now;
    // Rotate session tokens so any previous sessions unlocked with an older PIN are revoked immediately
    const rotatedToken = mintSignedOwnerToken(now, tag.ownerPinHash);
    store.ownerTokens = [rotatedToken];
    lastLocalMutationMap.set(tag.code.toUpperCase(), now);
    hydratedTagTimestamps.set(tag.code.toUpperCase(), now);
    saveStore(store);

    const vault = buildVaultForTag(tag);
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const isSecureReq = Boolean(req.secure || forwardedProto === 'https');
    res.setHeader('Set-Cookie', buildOwnerSessionCookie(rotatedToken, isSecureReq));
    res.json({
      ok: true,
      pinConfigured: true,
      token: rotatedToken,
      tag: toOwnerTagView(tag),
      vault,
      serverTime: now,
    });
  });

  app.get(
    '/api/owner/state',
    requireOwnerAuth,
    asyncHandler(async (_req, res) => {
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
    })
  );

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
    lastLocalMutationMap.set(tag.code.toUpperCase(), now);
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
      code,
      vehicleLabel,
      plateHint,
      statusNote,
      contactEnabled,
      autoExpireAt,
      telegramEnabled,
      telegramBotToken,
      telegramChatId,
    } = req.body as Partial<TagConfig>;

    if (typeof code === 'string' && /^[A-Z0-9-]{4,20}$/.test(code.trim().toUpperCase())) {
      tag.code = code.trim().toUpperCase();
    }
    if (typeof vehicleLabel === 'string') {
      const normalized = normalizePersistedTagFields({ code: tag.code, vehicleLabel });
      tag.vehicleLabel = normalized.vehicleLabel;
    }
    if (typeof plateHint === 'string') {
      const normalized = normalizePersistedTagFields({ code: tag.code, plateHint });
      tag.plateHint = normalized.plateHint;
    }
    if (typeof statusNote === 'string') {
      const normalized = normalizePersistedTagFields({ code: tag.code, statusNote });
      tag.statusNote = normalized.statusNote;
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
    lastLocalMutationMap.set(tag.code.toUpperCase(), now);
    hydratedTagTimestamps.set(tag.code.toUpperCase(), now);
    missingTagLookupCache.delete(tag.code.toUpperCase());

    saveStore(store);
    const vault = buildVaultForTag(tag);
    res.json({ tag: toOwnerTagView(tag), vault, serverTime: now });
  });

  app.post('/api/owner/tags/:id/regenerate-code', requireOwnerAuth, (req, res) => {
    const now = Date.now();
    const store = getCleanedStore(now);
    const tag = store.tags.find((t) => t.id === req.params.id);
    if (!tag) {
      res.status(404).json({ error: 'Tag not found' });
      return;
    }

    const previousCode = tag.code;
    const previousVaultId = computeVaultId(previousCode);
    const existingCodes = new Set(store.tags.map((t) => t.code.toUpperCase()));
    let nextCode = generateNewTagCode(previousCode);
    for (let i = 0; i < 10 && existingCodes.has(nextCode); i++) {
      nextCode = generateNewTagCode(previousCode);
    }

    hydratedTagTimestamps.delete(previousCode.toUpperCase());
    lastLocalMutationMap.delete(previousCode.toUpperCase());
    lastTelegramPollMap.delete(previousCode.toUpperCase());
    missingTagLookupCache.set(previousCode.toUpperCase(), now);
    missingTagLookupCache.delete(nextCode.toUpperCase());

    tag.code = nextCode;
    tag.updatedAt = now;
    lastLocalMutationMap.set(nextCode.toUpperCase(), now);
    hydratedTagTimestamps.set(nextCode.toUpperCase(), now);

    // Clear messages from the revoked QR code so the rotated tag starts clean
    store.messages = store.messages.filter((m) => m.tagId !== tag.id);
    saveStore(store);

    const vault = buildVaultForTag(tag);

    res.json({
      ok: true,
      previousCode,
      previousVaultId,
      tag: toOwnerTagView(tag),
      vault,
      serverTime: now,
    });
  });

  app.post(
    '/api/owner/tags/:id/test-telegram',
    requireOwnerAuth,
    asyncHandler(async (req, res) => {
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

      const cleanLabel = (tag.vehicleLabel || '').trim();
      const cleanPlate = (tag.plateHint || '').trim();
      const vehicleHeader =
        cleanLabel && cleanPlate
          ? `${cleanLabel} (${cleanPlate})`
          : cleanLabel || cleanPlate || tag.code;

      const testPayload = [
        `✅ RelayTag 2-Way Connected — ${vehicleHeader}`,
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
      lastLocalMutationMap.set(tag.code.toUpperCase(), now);
      hydratedTagTimestamps.set(tag.code.toUpperCase(), now);
      saveStore(store);

      const vault = buildVaultForTag(tag);

      res.json({
        ok: true,
        tag: toOwnerTagView(tag),
        vault,
        serverTime: now,
      });
    })
  );

  app.post(
    '/api/owner/tags/:id/simulate-telegram-reply',
    requireOwnerAuth,
    asyncHandler(async (req, res) => {
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
    })
  );

  app.post(
    '/api/telegram/webhook/:code',
    asyncHandler(async (req, res) => {
      const now = Date.now();
      const store = getCleanedStore(now);
      const code = (req.params.code || '').trim().toUpperCase();
      const tag = await findOrHydrateTagByCode(store, code, now);
      if (!tag || !tag.telegramEnabled || !tag.telegramBotToken.trim()) {
        res.status(200).json({ ok: true });
        return;
      }

      // Verify cryptographic Telegram webhook secret token to block unauthorized webhook spoofing
      const providedSecret = String(
        req.headers['x-telegram-bot-api-secret-token'] || req.query.secret || ''
      ).trim();
      const expectedSecret = computeTelegramWebhookSecret(tag.code, tag.telegramBotToken);
      const a = Buffer.from(providedSecret, 'utf8');
      const b = Buffer.from(expectedSecret, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.status(401).json({ error: 'Unauthorized webhook secret token.' });
        return;
      }

      const update = req.body as TelegramIncomingUpdate;
      if (update && typeof update.update_id === 'number') {
        const outcome = applyParsedTelegramUpdate(store, tag, update, now);
        const vehicleDisplay = tag.plateHint || tag.vehicleLabel || tag.code;
        if (outcome.applied && tag.telegramBotToken && tag.telegramChatId) {
          if (outcome.replyMessage) {
            void sendTelegramMessageWithRetry(
              tag.telegramBotToken,
              tag.telegramChatId,
              `✓ Reply delivered to scanner on ${vehicleDisplay}: "${outcome.replyMessage.text}"`
            );
          } else if (outcome.dndChanged) {
            void sendTelegramMessageWithRetry(
              tag.telegramBotToken,
              tag.telegramChatId,
              tag.contactEnabled
                ? `🟢 ${vehicleDisplay} is now Reachable (ON).`
                : `🔒 ${vehicleDisplay} switched to Do Not Disturb (OFF). Incoming QR scans are now paused.`
            );
          }
        }
      }
      res.status(200).json({ ok: true });
    })
  );

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
              telegramForwarded: Boolean(item.telegramForwarded),
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

  app.get(
    '/api/public/tags/:code',
    asyncHandler(async (req, res) => {
      const now = Date.now();
      const store = getCleanedStore(now);
      const code = (req.params.code || '').trim().toUpperCase();
      const clientIp = extractClientIp(req.ip || req.socket.remoteAddress);

      let tag = store.tags.find((t) => t.code.toUpperCase() === code) || null;
      if (tag) {
        const initiallyActive = isContactWindowActive(tag.contactEnabled, tag.autoExpireAt, now);
        // Zero-Disruption DND Shield: When Reachable is OFF, block repeated QR spam in-memory before any I/O
        if (!initiallyActive) {
          const ipCheck = checkDndSpamShield(scannerRateLimitMap, `${code}:${clientIp}`, now);
          const dndCheck = ipCheck.allowed ? checkTagDndCeiling(scannerRateLimitMap, code, now) : ipCheck;
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
      } else {
        const codeCheck = checkDndSpamShield(scannerRateLimitMap, `lookup:${code}:${clientIp}`, now);
        const lookupCheck = codeCheck.allowed ? checkLookupBudget(scannerRateLimitMap, clientIp, now) : codeCheck;
        if (!lookupCheck.allowed) {
          res.setHeader('Retry-After', String(lookupCheck.retryAfterSeconds));
          res.status(429).json({
            error: 'Too many tag lookup requests. Please wait before retrying.',
            retryAfterSeconds: lookupCheck.retryAfterSeconds,
          });
          return;
        }
        tag = await findOrHydrateTagByCode(store, code, now);
        if (!tag) {
          res.setHeader('Cache-Control', 'no-store');
          res.status(404).json({ error: 'Windshield tag code not found.' });
          return;
        }
      }

      const publicView = toPublicTagView(tag, now);

      // If tag is in Do Not Disturb (Reachable OFF), return minimal response without polling Telegram
      if (!publicView.contactEnabled) {
        res.setHeader('Cache-Control', 'no-store');
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

      res.setHeader('Cache-Control', 'no-store');
      res.json({
        tag: refreshedPublicView,
        messages: thread,
        serverTime: now,
      });
    })
  );

  app.post(
    '/api/public/tags/:code/messages',
    asyncHandler(async (req, res) => {
      const now = Date.now();
      const store = getCleanedStore(now);
      const code = (req.params.code || '').trim().toUpperCase();
      const clientIp = extractClientIp(req.ip || req.socket.remoteAddress);

      let tag = store.tags.find((t) => t.code.toUpperCase() === code) || null;
      if (tag) {
        // Fast in-memory DND spam guard before any external Firestore/Telegram calls
        if (!isContactWindowActive(tag.contactEnabled, tag.autoExpireAt, now)) {
          const ipCheck = checkDndSpamShield(scannerRateLimitMap, `post:${code}:${clientIp}`, now);
          const dndCheck = ipCheck.allowed ? checkTagDndCeiling(scannerRateLimitMap, code, now) : ipCheck;
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
      } else {
        const codeCheck = checkDndSpamShield(scannerRateLimitMap, `post-lookup:${code}:${clientIp}`, now);
        const lookupCheck = codeCheck.allowed ? checkLookupBudget(scannerRateLimitMap, clientIp, now) : codeCheck;
        if (!lookupCheck.allowed) {
          res.setHeader('Retry-After', String(lookupCheck.retryAfterSeconds));
          res.status(429).json({
            error: 'Too many requests. Please wait before retrying.',
            retryAfterSeconds: lookupCheck.retryAfterSeconds,
          });
          return;
        }
        tag = await findOrHydrateTagByCode(store, code, now);
        if (!tag) {
          res.status(404).json({ error: 'Windshield tag code not found.' });
          return;
        }
      }

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

      // Prevent accidental double-tap duplicate message bursts within 2 seconds for the same scanner session
      const recentDuplicate = store.messages.find(
        (m) =>
          m.tagId === tag.id &&
          m.sender === 'scanner' &&
          m.sessionId === scannerSessionId &&
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

      // Per-IP limit (max 5 alerts per 60s) keyed on nothing the client chooses: a rotating session
      // ID or alias must not mint a fresh allowance. The per-tag ceiling covers many IPs together.
      const rateCheck = checkScannerRateLimit(scannerRateLimitMap, `${tag.code}:${clientIp}`, now);
      const tagCheck = rateCheck.allowed
        ? checkTagAlertCeiling(scannerRateLimitMap, tag.code.toUpperCase(), now)
        : rateCheck;
      if (!tagCheck.allowed) {
        res.setHeader('Retry-After', String(tagCheck.retryAfterSeconds));
        res.status(429).json({
          error: `Rate limit reached. Please wait ${tagCheck.retryAfterSeconds}s before sending another alert.`,
          retryAfterSeconds: tagCheck.retryAfterSeconds,
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

      const telegramResult = await forwardToTelegramIfConfigured(tag, validation.sanitizedText);

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
    })
  );

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
    app.get('*', (req, res) => {
      // A missing hashed bundle must fail loudly, not come back as HTML that the browser then
      // tries to run as JavaScript.
      if (req.path.startsWith('/assets/')) {
        res.status(404).type('text/plain').send('Not found');
        return;
      }
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
    if (err instanceof TagLookupUnavailableError) {
      res.setHeader('Retry-After', String(HYDRATE_RETRY_AFTER_FAILURE_MS / 1000));
      res.status(503).json({ error: 'Tag lookup is temporarily unavailable. Please try again.' });
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



