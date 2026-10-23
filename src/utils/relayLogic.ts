export type SenderRole = 'scanner' | 'owner';

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

export interface OwnerTagView extends TagConfig {
  telegramBotTokenConfigured: boolean;
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

export function hasTagSetupData(tag: {
  vehicleLabel?: string | null;
  plateHint?: string | null;
  plateNumber?: string | null;
  statusNote?: string | null;
  telegramEnabled?: boolean | null;
  telegramBotToken?: string | null;
  telegramChatId?: string | null;
}): boolean {
  return Boolean(
    (tag.vehicleLabel && tag.vehicleLabel.trim()) ||
      (tag.plateHint && tag.plateHint.trim()) ||
      (tag.plateNumber && tag.plateNumber.trim()) ||
      (tag.statusNote && tag.statusNote.trim()) ||
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
  return {
    ...tag,
    telegramBotToken: configured ? MASKED_BOT_TOKEN : '',
    telegramBotTokenConfigured: configured,
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


export function verifyOwnerAccess(params: {
  providedToken?: string | null;
  validTokens: Set<string>;
  tagOwnerUid?: string | null;
  providedFirebaseUid?: string | null;
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

export function formatTelegramRelayPayload(
  tag: Pick<TagConfig, 'code' | 'vehicleLabel' | 'plateHint'>,
  senderAlias: string,
  messageText: string,
  category?: string,
  consoleUrl?: string,
  sessionId?: string
): string {
  const categoryBadge = category ? `[${category.toUpperCase()}] ` : '';
  const cleanSession = sanitizeScannerSessionId(sessionId);
  const lines = [
    `🚗 RelayTag Alert — ${tag.vehicleLabel} (${tag.plateHint})`,
    `Tag ID: ${tag.code}`,
    `From: ${senderAlias}`,
    ...(cleanSession ? [`Session: #${cleanSession}`] : []),
    `Message: ${categoryBadge}${messageText}`,
    `\n↩️ Reply directly to this message in Telegram to answer the scanner (or send /dnd to turn off alerts).`,
  ];
  if (consoleUrl) {
    lines.push(`🌐 Web Console: ${consoleUrl}`);
  }
  return lines.join('\n');
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

export function extractClientIp(
  forwardedForHeader: unknown,
  remoteAddress?: string | null
): string {
  if (typeof forwardedForHeader === 'string' && forwardedForHeader.trim()) {
    const firstHop = forwardedForHeader.split(',')[0].trim();
    if (firstHop && /^[a-fA-F0-9:.,\s]{3,64}$/.test(firstHop)) {
      return firstHop.slice(0, 64);
    }
  } else if (Array.isArray(forwardedForHeader) && typeof forwardedForHeader[0] === 'string') {
    const firstHop = forwardedForHeader[0].split(',')[0].trim();
    if (firstHop && /^[a-fA-F0-9:.,\s]{3,64}$/.test(firstHop)) {
      return firstHop.slice(0, 64);
    }
  }

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


