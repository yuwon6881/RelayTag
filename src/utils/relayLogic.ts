export type SenderRole = 'scanner' | 'owner';

export const AUTHORIZED_OWNER_EMAIL = 'yuwon6881@gmail.com';
export const MASKED_BOT_TOKEN = '••••••••••••';
export const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute sliding window
export const RATE_LIMIT_MAX_MESSAGES = 5; // max 5 messages per minute per scanner key

export interface RelayMessage {
  id: string;
  tagId: string;
  sessionId?: string;
  sender: SenderRole;
  senderAlias: string;
  text: string;
  category?: string;
  createdAt: number;
  telegramForwarded?: boolean;
  viaTelegram?: boolean;
}

export interface TagConfig {
  id: string;
  code: string;
  ownerUid?: string | null;
  ownerEmail?: string | null;
  ownerPinHash?: string | null;
  vehicleLabel: string;
  plateHint: string;
  contactEnabled: boolean;
  autoExpireAt: number | null;
  statusNote: string;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  lastTelegramUpdateId?: number;
  quickPresets: string[];
  updatedAt: number;
}

export interface OwnerTagView extends Omit<TagConfig, 'ownerPinHash'> {
  telegramBotTokenConfigured: boolean;
  ownerPinConfigured: boolean;
}

export interface PublicTagView {
  code: string;
  vehicleLabel: string;
  plateHint: string;
  contactEnabled: boolean;
  statusNote: string;
  quickPresets: string[];
  updatedAt: number;
}

export interface ValidationResult {
  valid: boolean;
  sanitizedText: string;
  error?: string;
}

export const QUICK_TIMER_PRESETS = [
  { label: 'Off', mins: 0, enable: false },
  { label: '30m', mins: 30, enable: true },
  { label: '1h', mins: 60, enable: true },
  { label: '3h', mins: 180, enable: true },
  { label: 'Always', mins: null, enable: true },
] as const;

export const DEFAULT_QUICK_PRESETS = [
  'Blocking driveway / lane — please move car',
  'Headlights or interior lights left on',
  'Parking enforcement / tow truck nearby',
  'Window or trunk appears slightly open',
];

export function normalizePersistedTagFields(raw: {
  code?: string | null;
  vehicleLabel?: string | null;
  plateNumber?: string | null;
  plateHint?: string | null;
  statusNote?: string | null;
}): {
  vehicleLabel: string;
  plateHint: string;
  statusNote: string;
} {
  const cleanCode = (raw.code || '').trim().toUpperCase();
  const rawVehicle = (raw.vehicleLabel || '').trim();
  const rawPlate = (raw.plateNumber ?? raw.plateHint ?? '').trim().toUpperCase();
  const rawNote = (raw.statusNote || '').trim();

  const vehicleLabel =
    rawVehicle === 'Registered Vehicle' ? '' : rawVehicle.slice(0, 60);
  const plateHint =
    cleanCode && rawPlate === cleanCode ? '' : rawPlate.slice(0, 20);
  const statusNote =
    rawNote === 'Contact via RelayTag' ? '' : rawNote.slice(0, 160);

  return { vehicleLabel, plateHint, statusNote };
}

export function hasTagSetupData(tag: {
  code?: string | null;
  vehicleLabel?: string | null;
  plateHint?: string | null;
  plateNumber?: string | null;
  statusNote?: string | null;
  telegramEnabled?: boolean | null;
  telegramBotToken?: string | null;
  telegramChatId?: string | null;
}): boolean {
  const normalized = normalizePersistedTagFields(tag);
  return Boolean(
    normalized.vehicleLabel ||
      normalized.plateHint ||
      normalized.statusNote ||
      tag.telegramEnabled ||
      (tag.telegramBotToken && tag.telegramBotToken.trim()) ||
      (tag.telegramChatId && tag.telegramChatId.trim())
  );
}

export function createInitialTagConfig(nowMs: number = Date.now()): TagConfig {
  return {
    id: 'tag-default',
    code: 'RT-482-9XK',
    ownerUid: null,
    ownerEmail: AUTHORIZED_OWNER_EMAIL,
    ownerPinHash: null,
    vehicleLabel: '',
    plateHint: '',
    contactEnabled: false,
    autoExpireAt: null,
    statusNote: '',
    telegramEnabled: false,
    telegramBotToken: '',
    telegramChatId: '',
    quickPresets: [...DEFAULT_QUICK_PRESETS],
    updatedAt: nowMs,
  };
}

export function isContactWindowActive(
  contactEnabled: boolean,
  autoExpireAt: number | null | undefined,
  nowMs: number
): boolean {
  if (!contactEnabled) return false;
  if (typeof autoExpireAt === 'number' && autoExpireAt > 0 && nowMs >= autoExpireAt) {
    return false;
  }
  return true;
}

export function toOwnerTagView(tag: TagConfig): OwnerTagView {
  const configured = Boolean(tag.telegramBotToken && tag.telegramBotToken.trim());
  const pinConfigured = Boolean(tag.ownerPinHash && tag.ownerPinHash.trim());
  const { ownerPinHash: _omittedPinHash, ...safeTag } = tag;
  return {
    ...safeTag,
    telegramBotToken: configured ? MASKED_BOT_TOKEN : '',
    telegramBotTokenConfigured: configured,
    ownerPinConfigured: pinConfigured,
  };
}

export function resolveUpdatedBotToken(
  incomingToken: unknown,
  existingSecretToken: string
): string {
  if (typeof incomingToken !== 'string') {
    return existingSecretToken;
  }
  const trimmed = incomingToken.trim();
  if (trimmed === MASKED_BOT_TOKEN) {
    return existingSecretToken;
  }
  return trimmed.slice(0, 120);
}

export function toPublicTagView(tag: TagConfig, nowMs: number): PublicTagView {
  const active = isContactWindowActive(tag.contactEnabled, tag.autoExpireAt, nowMs);
  return {
    code: tag.code,
    vehicleLabel: tag.vehicleLabel,
    plateHint: tag.plateHint,
    contactEnabled: active,
    statusNote: active ? tag.statusNote : '',
    quickPresets: active ? tag.quickPresets : [],
    updatedAt: tag.updatedAt,
  };
}

export function sanitizeScannerSessionId(rawSessionId: unknown): string | null {
  if (typeof rawSessionId !== 'string') return null;
  const trimmed = rawSessionId.trim();
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

// The session ID is the only thing that scopes a scanner to its own thread, so it must be
// unguessable, never shared between visitors, and never outlive the scan that created it.
export const SCANNER_SESSION_KEY = 'relaytag-scanner-session-v2';
export const SCANNER_SESSION_IDLE_MS = 30 * 60 * 1000;

export interface ScannerSessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createScannerSessionId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `scan-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// Pass a per-tab store (sessionStorage): a new tab from a new scan starts clean, a refresh
// continues. An idle session also expires, so a tab left open does not resurrect an old chat.
// With no usable store the ID is still unique to this page load, never a shared constant.
export function resolveScannerSession(
  store: ScannerSessionStore | null,
  nowMs: number,
  newId: () => string
): string {
  try {
    const raw = store?.getItem(SCANNER_SESSION_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as { id?: unknown; at?: unknown };
      const id = sanitizeScannerSessionId(saved.id);
      if (id && typeof saved.at === 'number' && saved.at <= nowMs + 60_000 && nowMs - saved.at < SCANNER_SESSION_IDLE_MS) {
        touchScannerSession(store ?? null, id, nowMs);
        return id;
      }
    }
  } catch {
    // unreadable storage or a corrupt entry: fall through to a fresh session
  }
  const id = newId();
  touchScannerSession(store, id, nowMs);
  return id;
}

export function touchScannerSession(
  store: ScannerSessionStore | null,
  id: string,
  nowMs: number
): void {
  try {
    store?.setItem(SCANNER_SESSION_KEY, JSON.stringify({ id, at: nowMs }));
  } catch {
    // storage blocked: the session simply lives for this page load
  }
}

export function filterMessagesForPublicScanner(
  messages: RelayMessage[],
  tagId: string,
  contactActive: boolean,
  scannerSessionId: string | null
): RelayMessage[] {
  if (!contactActive || !scannerSessionId) {
    return [];
  }
  return messages
    .filter((m) => m.tagId === tagId && m.sessionId === scannerSessionId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((m) => ({
      id: m.id,
      tagId: m.tagId,
      sessionId: m.sessionId,
      sender: m.sender,
      senderAlias: m.senderAlias,
      text: m.text,
      category: m.category,
      createdAt: m.createdAt,
      telegramForwarded: m.telegramForwarded,
      viaTelegram: m.viaTelegram,
    }));
}

export function checkScannerRateLimit(
  rateMap: Map<string, number[]>,
  key: string,
  nowMs: number,
  maxMessages: number = RATE_LIMIT_MAX_MESSAGES,
  windowMs: number = RATE_LIMIT_WINDOW_MS
): { allowed: boolean; retryAfterSeconds: number } {
  const cutoff = nowMs - windowMs;
  const existing = (rateMap.get(key) || []).filter((ts) => ts > cutoff);

  if (existing.length >= maxMessages) {
    const oldestInWindow = existing[0];
    const retryAfterMs = Math.max(1000, oldestInWindow + windowMs - nowMs);
    rateMap.set(key, existing);
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    };
  }

  existing.push(nowMs);
  rateMap.set(key, existing);
  return {
    allowed: true,
    retryAfterSeconds: 0,
  };
}

export const MAX_RATE_LIMIT_KEYS = 5000;

export function pruneRateLimitMap(
  rateMap: Map<string, number[]>,
  nowMs: number,
  windowMs: number = RATE_LIMIT_WINDOW_MS
): number {
  const cutoff = nowMs - windowMs;
  let removed = 0;

  for (const [key, timestamps] of rateMap.entries()) {
    const active = timestamps.filter((ts) => ts > cutoff);
    if (active.length === 0) {
      rateMap.delete(key);
      removed++;
    } else if (active.length !== timestamps.length) {
      rateMap.set(key, active);
    }
  }

  // Cap total tracked keys to prevent memory exhaustion under distributed flood
  if (rateMap.size > MAX_RATE_LIMIT_KEYS) {
    const overflow = rateMap.size - MAX_RATE_LIMIT_KEYS;
    const keys = rateMap.keys();
    for (let i = 0; i < overflow; i++) {
      const next = keys.next();
      if (next.done) break;
      rateMap.delete(next.value);
      removed++;
    }
  }

  return removed;
}

export function resolveTargetScannerSession(
  messages: RelayMessage[],
  tagId: string,
  explicitSessionId?: unknown
): string | undefined {
  const sanitizedExplicit = sanitizeScannerSessionId(explicitSessionId);
  if (sanitizedExplicit) {
    return sanitizedExplicit;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.tagId === tagId && m.sender === 'scanner' && m.sessionId) {
      return m.sessionId;
    }
  }
  return undefined;
}

export function isAuthorizedOwnerEmail(
  email: unknown,
  allowedOwnerEmail: string = AUTHORIZED_OWNER_EMAIL
): boolean {
  if (typeof email !== 'string') return false;
  const cleanEmail = email.trim().toLowerCase();
  const cleanAllowed = (allowedOwnerEmail || AUTHORIZED_OWNER_EMAIL).trim().toLowerCase();
  if (!cleanEmail || !cleanAllowed) return false;
  return cleanEmail === cleanAllowed;
}

export function validateOwnerPinFormat(rawPin: unknown): {
  valid: boolean;
  cleanPin: string;
  error?: string;
} {
  if (typeof rawPin !== 'string') {
    return {
      valid: false,
      cleanPin: '',
      error: 'Security PIN must be a 4 to 8 digit number.',
    };
  }
  const cleanPin = rawPin.trim();
  if (!/^\d{4,8}$/.test(cleanPin)) {
    return {
      valid: false,
      cleanPin: '',
      error: 'Security PIN must be 4 to 8 digits (numbers 0–9 only).',
    };
  }
  return { valid: true, cleanPin };
}

export interface OwnerSessionEvalInput {
  existingToken?: string | null;
  validTokens: Set<string>;
  firebaseUid?: string | null;
  firebaseEmail?: string | null;
  firebaseTokenVerified?: boolean;
  firebaseEmailVerified?: boolean;
  unverifiedHeaderPresent?: boolean;
  tagOwnerUid?: string | null;
  allowedOwnerEmail?: string | null;
  pinVerified?: boolean;
  pinAttemptProvided?: boolean;
}

export interface OwnerSessionEvalResult {
  allowed: boolean;
  status: 200 | 401 | 403;
  error?: string;
  authMethod?: 'google' | 'pin' | 'existing-token';
}

export function evaluateOwnerSessionRequest(
  input: OwnerSessionEvalInput
): OwnerSessionEvalResult {
  const allowedEmail = (input.allowedOwnerEmail || AUTHORIZED_OWNER_EMAIL).trim().toLowerCase();
  const cleanUid = typeof input.firebaseUid === 'string' ? input.firebaseUid.trim() : '';
  const cleanEmail =
    typeof input.firebaseEmail === 'string' ? input.firebaseEmail.trim().toLowerCase() : '';
  const cleanTagOwnerUid =
    typeof input.tagOwnerUid === 'string' ? input.tagOwnerUid.trim() : '';

  // 1. If a PIN unlock attempt was explicitly submitted, verify it strictly
  if (input.pinAttemptProvided) {
    if (!input.pinVerified) {
      return {
        allowed: false,
        status: 403,
        error: 'Invalid Owner Security PIN. Please check your passcode and try again.',
      };
    }
    return { allowed: true, status: 200, authMethod: 'pin' };
  }

  // 2. If a Google/Firebase email is provided, it MUST match the authorized owner email
  if (cleanEmail && !isAuthorizedOwnerEmail(cleanEmail, allowedEmail)) {
    return {
      allowed: false,
      status: 403,
      error: `Forbidden: Account (${cleanEmail}) is not authorized to access this RelayTag console.`,
    };
  }

  // 3. If tag is already claimed by a specific Firebase UID and caller provides a different UID, deny
  if (cleanTagOwnerUid && cleanUid && cleanTagOwnerUid !== cleanUid) {
    return {
      allowed: false,
      status: 403,
      error: 'Forbidden: This vehicle tag is registered to a different owner account.',
    };
  }

  // 4. Authorized Google sign-in: MUST come from a cryptographically verified Firebase ID token with email_verified == true
  if (cleanUid) {
    if (input.firebaseTokenVerified === false) {
      return {
        allowed: false,
        status: 401,
        error:
          'Unauthorized: Cryptographically verified Firebase Bearer ID token is required for Google sign-in.',
      };
    }
    if (input.firebaseEmailVerified === false) {
      return {
        allowed: false,
        status: 403,
        error: 'Forbidden: Google account email address must be verified.',
      };
    }
    if (isAuthorizedOwnerEmail(cleanEmail, allowedEmail)) {
      return { allowed: true, status: 200, authMethod: 'google' };
    }
    return {
      allowed: false,
      status: 403,
      error: 'Forbidden: Verified owner email is required to unlock this console.',
    };
  }

  // 5. Existing valid owner token from an already-authenticated session
  const existingTok = typeof input.existingToken === 'string' ? input.existingToken.trim() : '';
  if (existingTok && input.validTokens.has(existingTok)) {
    return { allowed: true, status: 200, authMethod: 'existing-token' };
  }

  // 6. Block raw X-Firebase-Uid / X-Firebase-Email header spoofing attempts when no verified Bearer token is present
  if (input.unverifiedHeaderPresent) {
    return {
      allowed: false,
      status: 401,
      error:
        'Unauthorized: Unverified identity headers rejected. Provide a valid Authorization Bearer ID token or Owner Security PIN.',
    };
  }

  // 7. Default Deny: Unauthenticated visitor cannot establish an owner session
  return {
    allowed: false,
    status: 401,
    error:
      'Unauthorized: Owner authentication required. Sign in with the authorized Google account or enter your Owner Security PIN.',
  };
}

export function verifyOwnerAccess(params: {
  providedToken?: string | null;
  validTokens: Set<string>;
  tagOwnerUid?: string | null;
  providedFirebaseUid?: string | null;
  providedOwnerEmail?: string | null;
  allowedOwnerEmail?: string | null;
}): { authorized: boolean; status: 200 | 401 | 403; error?: string } {
  const token = (params.providedToken || '').trim();
  if (!token || !params.validTokens.has(token)) {
    return {
      authorized: false,
      status: 401,
      error: 'Unauthorized: Valid owner session token required.',
    };
  }

  if (
    typeof params.providedOwnerEmail === 'string' &&
    params.providedOwnerEmail.trim() &&
    !isAuthorizedOwnerEmail(
      params.providedOwnerEmail,
      params.allowedOwnerEmail || AUTHORIZED_OWNER_EMAIL
    )
  ) {
    return {
      authorized: false,
      status: 403,
      error:
        'Forbidden: This Google account is not authorized to access the RelayTag owner console.',
    };
  }

  if (
    params.tagOwnerUid &&
    params.providedFirebaseUid &&
    params.tagOwnerUid !== params.providedFirebaseUid
  ) {
    return {
      authorized: false,
      status: 403,
      error: 'Forbidden: This vehicle tag belongs to a different authenticated owner.',
    };
  }

  return { authorized: true, status: 200 };
}

export function verifySameOriginRequest(
  originHeader: unknown,
  hostHeader: unknown
): boolean {
  if (typeof originHeader !== 'string' || !originHeader.trim()) {
    return true; // Non-CORS same-origin requests without Origin header are guarded by custom header requirement
  }
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) {
    return false;
  }
  try {
    const parsedOrigin = new URL(originHeader.trim());
    return parsedOrigin.host.toLowerCase() === hostHeader.trim().toLowerCase();
  } catch {
    return false;
  }
}

function sanitizeMessageText(rawText: unknown): string {
  if (typeof rawText !== 'string') return '';
  return rawText
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function validateIncomingMessage(
  rawText: unknown,
  contactActive: boolean
): ValidationResult {
  if (!contactActive) {
    return {
      valid: false,
      sanitizedText: '',
      error: 'The vehicle owner has currently turned off incoming messages.',
    };
  }

  const trimmed = sanitizeMessageText(rawText);
  if (!trimmed) {
    return {
      valid: false,
      sanitizedText: '',
      error: 'Please enter a short message or select a quick alert.',
    };
  }

  if (trimmed.length > 280) {
    return {
      valid: false,
      sanitizedText: trimmed.slice(0, 280),
      error: 'Message must be 280 characters or fewer.',
    };
  }

  return {
    valid: true,
    sanitizedText: trimmed,
  };
}

export function validateOwnerReply(rawText: unknown): ValidationResult {
  const trimmed = sanitizeMessageText(rawText);
  if (!trimmed) {
    return {
      valid: false,
      sanitizedText: '',
      error: 'Reply cannot be empty.',
    };
  }

  if (trimmed.length > 280) {
    return {
      valid: false,
      sanitizedText: trimmed.slice(0, 280),
      error: 'Reply must be 280 characters or fewer.',
    };
  }

  return {
    valid: true,
    sanitizedText: trimmed,
  };
}

export interface TelegramValidationResult {
  valid: boolean;
  cleanBotToken: string;
  cleanChatId: string;
  error?: string;
}

export function validateTelegramCredentials(
  botToken: string,
  chatId: string
): TelegramValidationResult {
  const cleanToken = (botToken || '').trim();
  const cleanChat = (chatId || '').trim();

  if (!cleanToken) {
    return {
      valid: false,
      cleanBotToken: '',
      cleanChatId: cleanChat,
      error: 'Telegram Bot Token is required (e.g. 123456789:AAH...). Create one via @BotFather.',
    };
  }

  if (cleanToken !== MASKED_BOT_TOKEN && !/^\d{5,16}:[A-Za-z0-9_-]{20,100}$/.test(cleanToken)) {
    return {
      valid: false,
      cleanBotToken: cleanToken,
      cleanChatId: cleanChat,
      error: 'Invalid Bot Token format. Expected format: 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
    };
  }

  if (!cleanChat) {
    return {
      valid: false,
      cleanBotToken: cleanToken,
      cleanChatId: '',
      error: 'Telegram Chat ID is required (e.g. 987654321). Message @userinfobot on Telegram to get yours.',
    };
  }

  if (!/^(-?\d{4,20}|@[A-Za-z0-9_]{4,60})$/.test(cleanChat)) {
    return {
      valid: false,
      cleanBotToken: cleanToken,
      cleanChatId: cleanChat,
      error: 'Invalid Chat ID format. Use your numeric Telegram ID (e.g. 987654321) or @channel_name.',
    };
  }

  return {
    valid: true,
    cleanBotToken: cleanToken,
    cleanChatId: cleanChat,
  };
}

export function isTelegramReady(tag: Pick<TagConfig, 'telegramEnabled' | 'telegramBotToken' | 'telegramChatId'>): boolean {
  if (!tag.telegramEnabled) return false;
  const token = (tag.telegramBotToken || '').trim();
  const chat = (tag.telegramChatId || '').trim();
  return Boolean(token && chat);
}

// The alert is the message itself, led by the plate when one is on file. Replies in Telegram
// route to the most recent scanner session, so no session marker is embedded.
export function formatTelegramRelayPayload(
  tag: Pick<TagConfig, 'plateHint'>,
  messageText: string
): string {
  const plate = (tag.plateHint || '').trim();
  return plate ? `${plate}\n${messageText}` : messageText;
}

export function extractSessionIdFromTelegramText(text: unknown): string | undefined {
  if (typeof text !== 'string' || !text) return undefined;
  const match = text.match(/Session:\s*#?([a-zA-Z0-9_-]{8,64})/i);
  if (match && match[1]) {
    return sanitizeScannerSessionId(match[1]) || undefined;
  }
  return undefined;
}

export interface TelegramIncomingUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    date?: number;
    text?: string;
    chat?: {
      id?: number | string;
      username?: string;
    };
    from?: {
      is_bot?: boolean;
    };
    reply_to_message?: {
      text?: string;
    };
  };
}

export type ParsedTelegramAction =
  | {
      action: 'reply';
      updateId: number;
      sanitizedText: string;
      sessionId?: string;
    }
  | {
      action: 'command-dnd';
      updateId: number;
    }
  | {
      action: 'command-on';
      updateId: number;
    }
  | {
      action: 'ignore';
      updateId: number;
      reason: string;
    };

export function parseTelegramUpdateForOwnerReply(
  update: TelegramIncomingUpdate,
  expectedChatId: string,
  existingMessages: RelayMessage[],
  tagId: string
): ParsedTelegramAction {
  const updateId = typeof update?.update_id === 'number' ? update.update_id : 0;
  const msg = update?.message;
  if (!msg) {
    return { action: 'ignore', updateId, reason: 'no-message' };
  }
  if (msg.from?.is_bot) {
    return { action: 'ignore', updateId, reason: 'from-bot' };
  }

  const cleanExpected = (expectedChatId || '').trim();
  if (!cleanExpected) {
    return { action: 'ignore', updateId, reason: 'unconfigured-chat' };
  }

  const incomingChatId = msg.chat?.id !== undefined ? String(msg.chat.id).trim() : '';
  const incomingUsername = msg.chat?.username ? `@${String(msg.chat.username).trim()}` : '';

  const chatMatches = cleanExpected.startsWith('@')
    ? incomingUsername.toLowerCase() === cleanExpected.toLowerCase()
    : incomingChatId === cleanExpected;

  if (!chatMatches) {
    return { action: 'ignore', updateId, reason: 'unauthorized-chat' };
  }

  const rawText = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!rawText) {
    return { action: 'ignore', updateId, reason: 'empty-text' };
  }

  // Handle slash commands from owner in Telegram
  if (rawText.startsWith('/')) {
    const cmd = rawText.split(/\s+/)[0].toLowerCase().split('@')[0];
    if (cmd === '/dnd' || cmd === '/off' || cmd === '/mute') {
      return { action: 'command-dnd', updateId };
    }
    if (cmd === '/on' || cmd === '/reachable') {
      return { action: 'command-on', updateId };
    }
    if (cmd === '/reply') {
      const rest = rawText.replace(/^\/reply(@[a-zA-Z0-9_]+)?\s*/i, '');
      const check = validateOwnerReply(rest);
      if (!check.valid) {
        return { action: 'ignore', updateId, reason: 'invalid-reply' };
      }
      const replyTarget =
        extractSessionIdFromTelegramText(msg.reply_to_message?.text) ||
        resolveTargetScannerSession(existingMessages, tagId);
      return {
        action: 'reply',
        updateId,
        sanitizedText: check.sanitizedText,
        sessionId: replyTarget,
      };
    }
    return { action: 'ignore', updateId, reason: 'bot-command' };
  }

  const check = validateOwnerReply(rawText);
  if (!check.valid) {
    return { action: 'ignore', updateId, reason: 'invalid-reply' };
  }

  const replyTarget =
    extractSessionIdFromTelegramText(msg.reply_to_message?.text) ||
    resolveTargetScannerSession(existingMessages, tagId);

  return {
    action: 'reply',
    updateId,
    sanitizedText: check.sanitizedText,
    sessionId: replyTarget,
  };
}

export const DND_SHIELD_WINDOW_MS = 60 * 1000;
export const DND_SHIELD_MAX_REQUESTS = 4;

export function checkDndSpamShield(
  rateMap: Map<string, number[]>,
  key: string,
  nowMs: number
): { allowed: boolean; retryAfterSeconds: number } {
  return checkScannerRateLimit(
    rateMap,
    `dnd:${key}`,
    nowMs,
    DND_SHIELD_MAX_REQUESTS,
    DND_SHIELD_WINDOW_MS
  );
}

// With the owner in Do Not Disturb, every caller together is capped per tag, so a spread of
// IPs still cannot keep the backend busy. Answered from memory, before any I/O.
export const DND_TAG_MAX_REQUESTS = 30;

export function checkTagDndCeiling(
  rateMap: Map<string, number[]>,
  tagCode: string,
  nowMs: number
): { allowed: boolean; retryAfterSeconds: number } {
  return checkScannerRateLimit(rateMap, `dnd-tag:${tagCode}`, nowMs, DND_TAG_MAX_REQUESTS, 60_000);
}

// Unknown tag codes each cost a Firestore lookup. Budgeted per IP across all codes, so trying a
// new code every time does not mint a fresh allowance.
export const LOOKUP_MAX_PER_IP = 10;

export function checkLookupBudget(
  rateMap: Map<string, number[]>,
  ip: string,
  nowMs: number
): { allowed: boolean; retryAfterSeconds: number } {
  return checkScannerRateLimit(rateMap, `lookup-ip:${ip}`, nowMs, LOOKUP_MAX_PER_IP, 60_000);
}

// Each accepted alert pings the owner's Telegram. This ceiling is per tag and keyed on nothing
// the client supplies (session ID, alias), so it cannot be reset by rotating them.
export const TAG_ALERTS_MAX_PER_MINUTE = 20;

export function checkTagAlertCeiling(
  rateMap: Map<string, number[]>,
  tagCode: string,
  nowMs: number
): { allowed: boolean; retryAfterSeconds: number } {
  return checkScannerRateLimit(rateMap, `alerts-tag:${tagCode}`, nowMs, TAG_ALERTS_MAX_PER_MINUTE, 60_000);
}

export function shouldPollScannerBackend(params: {
  isPublicScanRoute: boolean;
  contactEnabled: boolean | null | undefined;
  hasNotFoundError: boolean;
}): boolean {
  if (params.hasNotFoundError) return false;
  if (params.isPublicScanRoute) {
    // When Reachable is OFF (false), never poll the backend from a QR scan page
    return params.contactEnabled === true;
  }
  return true;
}

export function computeRemainingMinutes(
  autoExpireAt: number | null | undefined,
  nowMs: number
): number | null {
  if (typeof autoExpireAt !== 'number' || autoExpireAt <= 0) return null;
  const diffMs = autoExpireAt - nowMs;
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / 60000);
}

export const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MAX_MESSAGES_PER_TAG = 100;

export function cleanupStoreState(
  store: { tags: TagConfig[]; messages: RelayMessage[] },
  nowMs: number
): boolean {
  let mutated = false;
  const validTagIds = new Set<string>();

  for (const tag of store.tags) {
    validTagIds.add(tag.id);
    if (
      tag.contactEnabled &&
      typeof tag.autoExpireAt === 'number' &&
      tag.autoExpireAt > 0 &&
      nowMs >= tag.autoExpireAt
    ) {
      tag.contactEnabled = false;
      tag.autoExpireAt = null;
      tag.updatedAt = nowMs;
      mutated = true;
    }
  }

  const cutoffMs = nowMs - MESSAGE_TTL_MS;
  const filteredMessages = store.messages.filter(
    (m) => validTagIds.has(m.tagId) && m.createdAt >= cutoffMs
  );

  if (filteredMessages.length !== store.messages.length) {
    store.messages = filteredMessages;
    mutated = true;
  }

  // Enforce per-tag maximum message count (keep newest MAX_MESSAGES_PER_TAG)
  for (const tagId of validTagIds) {
    const tagMsgs = store.messages.filter((m) => m.tagId === tagId);
    if (tagMsgs.length > MAX_MESSAGES_PER_TAG) {
      tagMsgs.sort((a, b) => a.createdAt - b.createdAt);
      const idsToDrop = new Set(
        tagMsgs.slice(0, tagMsgs.length - MAX_MESSAGES_PER_TAG).map((m) => m.id)
      );
      store.messages = store.messages.filter((m) => !idsToDrop.has(m.id));
      mutated = true;
    }
  }

  return mutated;
}

export interface SetupReadinessStep {
  id: 'cloud-sync' | 'vehicle-plate' | 'telegram-alert' | 'windshield-qr';
  indexLabel: string;
  title: string;
  description: string;
  done: boolean;
  statusText: string;
}

export interface SetupReadinessSummary {
  completedCount: number;
  totalCount: number;
  allReady: boolean;
  steps: SetupReadinessStep[];
}

export function computeSetupReadiness(params: {
  isSignedIn: boolean;
  userEmail?: string | null;
  tag: Pick<
    TagConfig,
    'plateHint' | 'vehicleLabel' | 'telegramEnabled' | 'telegramBotToken' | 'telegramChatId' | 'contactEnabled'
  >;
  nowMs?: number;
  autoExpireAt?: number | null;
}): SetupReadinessSummary {
  const cloudDone = Boolean(params.isSignedIn);
  const plateClean = (params.tag.plateHint || '').trim();
  const labelClean = (params.tag.vehicleLabel || '').trim();
  const vehicleDone = Boolean(plateClean && labelClean);
  const telegramDone = isTelegramReady(params.tag);
  const contactDone = isContactWindowActive(
    params.tag.contactEnabled,
    params.autoExpireAt ?? null,
    params.nowMs ?? Date.now()
  );

  const steps: SetupReadinessStep[] = [
    {
      id: 'cloud-sync',
      indexLabel: '01',
      title: 'Cloud Account Sync',
      description: 'Persists your tag & encrypted vault in Firestore across restarts.',
      done: cloudDone,
      statusText: cloudDone
        ? `Synced (${params.userEmail || 'Google Account'})`
        : 'Sign in with Google recommended',
    },
    {
      id: 'vehicle-plate',
      indexLabel: '02',
      title: 'Vehicle & License Plate',
      description: 'Shown on your public scan card so callers confirm the right car.',
      done: vehicleDone,
      statusText: vehicleDone ? `${plateClean} · ${labelClean}` : 'Enter plate number',
    },
    {
      id: 'telegram-alert',
      indexLabel: '03',
      title: 'Telegram Phone Alerts',
      description: 'Pushes instant alerts to your phone whenever your QR is scanned.',
      done: telegramDone,
      statusText: telegramDone ? 'Verified & forwarding active' : 'Connect @BotFather token & Chat ID',
    },
    {
      id: 'windshield-qr',
      indexLabel: '04',
      title: 'Contact Switch & QR Card',
      description: 'Print your windshield QR card and keep Contact ON when parked.',
      done: contactDone,
      statusText: contactDone ? 'Driver Reachable (ON)' : 'Currently in Do Not Disturb (OFF)',
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;
  return {
    completedCount,
    totalCount: steps.length,
    allReady: completedCount === steps.length,
    steps,
  };
}

export function formatAuthErrorForUi(err: unknown): string | null {
  if (!err) return null;
  const code =
    typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code || '')
      : '';
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
      ? err
      : '';

  if (
    code === 'auth/popup-closed-by-user' ||
    code === 'auth/cancelled-popup-request' ||
    code === 'auth/user-cancelled' ||
    message.includes('auth/popup-closed-by-user') ||
    message.includes('auth/cancelled-popup-request') ||
    message.includes('auth/user-cancelled')
  ) {
    return null;
  }

  return 'Could not complete Google sign-in. Please try again.';
}

export const RELATIVE_TIMESTAMP_REFRESH_MS = 10 * 1000; // 10s interval tick for live relative timestamps

export function formatRelativeTimestamp(
  createdAtMs: number,
  nowMs: number = Date.now()
): string {
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)) {
    return 'Just now';
  }

  const diffMs = Math.max(0, nowMs - createdAtMs);
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 10) {
    return 'Just now';
  }
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  return new Date(createdAtMs).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });
}

export const MIN_VAULT_SECRET_LENGTH = 32;

export function assertVaultSecretConfigured(secret: string | undefined, nodeEnv: string | undefined): void {
  if (nodeEnv !== 'production') return;
  if (!secret || secret.trim().length < MIN_VAULT_SECRET_LENGTH) {
    throw new Error(
      `RELAYTAG_VAULT_SECRET must be set to at least ${MIN_VAULT_SECRET_LENGTH} random characters in production.`
    );
  }
}

// Takes Express's proxy-resolved `req.ip` (with `trust proxy` set to the real hop count).
// X-Forwarded-For is deliberately not read here: its leading entries are client-controlled,
// so keying rate limits on them lets an attacker mint a fresh bucket per request.
export function extractClientIp(remoteAddress?: string | null): string {
  if (typeof remoteAddress === 'string' && remoteAddress.trim()) {
    return remoteAddress.trim().slice(0, 64);
  }

  return 'unknown';
}

export function buildOwnerSessionCookie(
  token: string,
  isSecureRequest: boolean
): string {
  const encoded = encodeURIComponent(token);
  const sameSitePart = isSecureRequest
    ? 'SameSite=None; Secure'
    : 'SameSite=Lax';
  return `relaytag_owner_token=${encoded}; Path=/; HttpOnly; ${sameSitePart}; Max-Age=2592000`;
}

export interface BackendHealthSummary {
  status: 'ok';
  ready: true;
  uptimeSeconds: number;
  serverTime: number;
  tagCount: number;
  activeMessageCount: number;
  reachableTagCount: number;
}

export function computeHealthSummary(
  store: { tags: TagConfig[]; messages: RelayMessage[] },
  nowMs: number,
  startedAtMs: number
): BackendHealthSummary {
  const tags = Array.isArray(store.tags) ? store.tags : [];
  const messages = Array.isArray(store.messages) ? store.messages : [];
  const reachableTagCount = tags.filter((t) =>
    isContactWindowActive(t.contactEnabled, t.autoExpireAt, nowMs)
  ).length;

  return {
    status: 'ok',
    ready: true,
    uptimeSeconds: Math.max(0, Math.floor((nowMs - startedAtMs) / 1000)),
    serverTime: nowMs,
    tagCount: tags.length,
    activeMessageCount: messages.length,
    reachableTagCount,
  };
}

const TAG_DIGITS = '23456789';
const TAG_ALPHANUM = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateNewTagCode(existingCode?: string): string {
  const cleanExisting = (existingCode || '').trim().toUpperCase();
  for (let attempt = 0; attempt < 25; attempt++) {
    let digits = '';
    for (let i = 0; i < 3; i++) {
      digits += TAG_DIGITS[Math.floor(Math.random() * TAG_DIGITS.length)];
    }
    let suffix = '';
    for (let i = 0; i < 3; i++) {
      suffix += TAG_ALPHANUM[Math.floor(Math.random() * TAG_ALPHANUM.length)];
    }
    const candidate = `RT-${digits}-${suffix}`;
    if (candidate !== cleanExisting) {
      return candidate;
    }
  }
  return `RT-984-7XK`;
}

export type ScannerDeliveryStage =
  | 'driver-replied'
  | 'delivered-telegram'
  | 'delivered-relay';

export interface ScannerDeliveryStatusInfo {
  stage: ScannerDeliveryStage;
  label: string;
}

export function computeScannerMessageDeliveryStatus(
  msg: RelayMessage,
  threadMessages: RelayMessage[]
): ScannerDeliveryStatusInfo {
  const hasDriverReply = threadMessages.some(
    (other) => other.sender === 'owner' && other.createdAt >= msg.createdAt
  );

  if (hasDriverReply) {
    return {
      stage: 'driver-replied',
      label: 'Driver Replied',
    };
  }

  if (msg.telegramForwarded) {
    return {
      stage: 'delivered-telegram',
      label: 'Delivered to Telegram',
    };
  }

  return {
    stage: 'delivered-relay',
    label: 'Delivered to Console',
  };
}

export function extractRetryAfterSeconds(
  payload: { retryAfterSeconds?: unknown; error?: unknown } | null | undefined
): number {
  if (!payload) return 0;
  if (
    typeof payload.retryAfterSeconds === 'number' &&
    Number.isFinite(payload.retryAfterSeconds) &&
    payload.retryAfterSeconds > 0
  ) {
    return Math.ceil(payload.retryAfterSeconds);
  }
  if (typeof payload.error === 'string') {
    const match = payload.error.match(/(?:wait|in)\s+(\d+)\s*s/i);
    if (match && match[1]) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return 0;
}

export function formatCooldownButtonLabel(
  cooldownSeconds: number,
  defaultLabel = 'Send Anonymous Message'
): string {
  if (Number.isFinite(cooldownSeconds) && cooldownSeconds > 0) {
    return `Retry in ${Math.ceil(cooldownSeconds)}s`;
  }
  return defaultLabel;
}

export function sanitizeBadgeFilename(
  code: string,
  format: 'png' | 'svg'
): string {
  const cleanCode = (code || 'TAG')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 20) || 'TAG';
  return `relaytag-${cleanCode}.${format}`;
}

function escapeXmlText(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildDownloadableTagSvgBadge(params: {
  code: string;
  plateHint?: string;
  vehicleLabel?: string;
  qrSvgMarkup: string;
}): string {
  const cleanCode = escapeXmlText((params.code || 'RT-482-9XK').trim().toUpperCase());
  const cleanPlate = escapeXmlText((params.plateHint || '').trim().toUpperCase());
  const cleanVehicle = escapeXmlText((params.vehicleLabel || '').trim());
  const vehicleSubtitle =
    cleanPlate && cleanVehicle
      ? `${cleanPlate} · ${cleanVehicle}`
      : cleanPlate || cleanVehicle || 'Registered Vehicle';

  // Extract inner elements and viewBox from generated QR SVG so it nests cleanly at (140, 230) 360x360
  const rawQr = params.qrSvgMarkup || '';
  const viewBoxMatch = rawQr.match(/viewBox="([^"]+)"/i);
  const qrViewBox = viewBoxMatch ? viewBoxMatch[1] : '0 0 33 33';
  const innerQr = rawQr
    .replace(/^[\s\S]*?<svg[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="780" viewBox="0 0 640 780" fill="none">`,
    `  <rect width="640" height="780" rx="44" fill="#F4F5F7"/>`,
    `  <rect x="24" y="24" width="592" height="732" rx="32" fill="#FFFFFF" stroke="#E4E4E7" stroke-width="2"/>`,
    `  <text x="320" y="88" text-anchor="middle" fill="#047857" font-family="'JetBrains Mono', monospace" font-size="16" font-weight="700" letter-spacing="0.06em">WINDSHIELD TAG · ${cleanCode}</text>`,
    `  <text x="320" y="132" text-anchor="middle" fill="#111318" font-family="'Plus Jakarta Sans', -apple-system, sans-serif" font-size="32" font-weight="800">Scan to Contact Driver</text>`,
    `  <text x="320" y="168" text-anchor="middle" fill="#52525B" font-family="'JetBrains Mono', monospace" font-size="18" font-weight="600">${vehicleSubtitle}</text>`,
    `  <rect x="120" y="200" width="400" height="400" rx="28" fill="#FFFFFF" stroke="#E4E4E7" stroke-width="2"/>`,
    `  <svg x="144" y="224" width="352" height="352" viewBox="${qrViewBox}" shape-rendering="crispEdges">`,
    `    ${innerQr}`,
    `  </svg>`,
    `  <text x="320" y="654" text-anchor="middle" fill="#3F3F46" font-family="'Plus Jakarta Sans', -apple-system, sans-serif" font-size="17" font-weight="600">Anonymous 2-Way Windshield Relay</text>`,
    `  <text x="320" y="684" text-anchor="middle" fill="#71717A" font-family="'Plus Jakarta Sans', -apple-system, sans-serif" font-size="14" font-weight="500">Phone numbers stay hidden · Driver reachable when Contact is ON</text>`,
    `</svg>`,
  ].join('\n');
}



