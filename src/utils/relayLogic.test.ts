import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUICK_TIMER_PRESETS,
  MESSAGE_TTL_MS,
  MAX_MESSAGES_PER_TAG,
  MASKED_BOT_TOKEN,
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
  isTelegramReady,
  computeSetupReadiness,
  formatAuthErrorForUi,
  formatTelegramRelayPayload,
  extractSessionIdFromTelegramText,
  parseTelegramUpdateForOwnerReply,
  checkDndSpamShield,
  shouldPollScannerBackend,
  computeRemainingMinutes,
  cleanupStoreState,
  createInitialTagConfig,
  hasTagSetupData,
  normalizePersistedTagFields,
  formatRelativeTimestamp,
  RELATIVE_TIMESTAMP_REFRESH_MS,
  extractClientIp,
  buildOwnerSessionCookie,
  computeHealthSummary,
  generateNewTagCode,
  computeScannerMessageDeliveryStatus,
  extractRetryAfterSeconds,
  formatCooldownButtonLabel,
  sanitizeBadgeFilename,
  buildDownloadableTagSvgBadge,
  TagConfig,
  RelayMessage,
} from './relayLogic.ts';

const sampleTag: TagConfig = {
  id: 'tag-1',
  code: 'RT-482-9XK',
  ownerUid: 'uid-owner-1',
  vehicleLabel: 'Slate Civic Hatchback',
  plateHint: 'SBA 8492M',
  contactEnabled: true,
  autoExpireAt: null,
  statusNote: 'Parked briefly near loading bay. Ping me if I need to move!',
  telegramEnabled: true,
  telegramBotToken: '123456:SECRET_BOT_TOKEN',
  telegramChatId: '987654321',
  quickPresets: [
    'Blocking driveway / lane — please move car',
    'Headlights or interior lights left on',
  ],
  updatedAt: 1710000000000,
};

describe('relayLogic — privacy, DND, 3h timer, rate limiting & store cleanup rules', () => {
  it('includes 3h (180m) quick timer preset alongside Off, 30m, 1h, and Always', () => {
    const labels = QUICK_TIMER_PRESETS.map((p) => p.label);
    assert.deepEqual(labels, ['Off', '30m', '1h', '3h', 'Always']);
    const threeHour = QUICK_TIMER_PRESETS.find((p) => p.label === '3h');
    assert.ok(threeHour);
    assert.equal(threeHour.mins, 180);
    assert.equal(threeHour.enable, true);
  });

  it('returns false when contactEnabled is false regardless of expiration', () => {
    assert.equal(isContactWindowActive(false, null, 1000), false);
    assert.equal(isContactWindowActive(false, 0, 1000), false);
    assert.equal(isContactWindowActive(false, 999999, 1000), false);
  });

  it('treats null or 0 autoExpireAt as Always On when contactEnabled is true', () => {
    assert.equal(isContactWindowActive(true, null, 500000), true);
    assert.equal(isContactWindowActive(true, 0, 500000), true);
  });

  it('returns false when autoExpireAt is in the past', () => {
    assert.equal(isContactWindowActive(true, 5000, 5000), false);
    assert.equal(isContactWindowActive(true, 5000, 6000), false);
    assert.equal(isContactWindowActive(true, 5000, 4999), true);
  });

  it('masks raw telegramBotToken in toOwnerTagView and preserves secret when sentinel is submitted', () => {
    const ownerView = toOwnerTagView(sampleTag);
    assert.equal(ownerView.telegramBotToken, MASKED_BOT_TOKEN);
    assert.equal(ownerView.telegramBotTokenConfigured, true);

    const emptyOwnerView = toOwnerTagView({ ...sampleTag, telegramBotToken: '   ' });
    assert.equal(emptyOwnerView.telegramBotToken, '');
    assert.equal(emptyOwnerView.telegramBotTokenConfigured, false);

    // Submitting MASKED_BOT_TOKEN preserves existing secret
    assert.equal(
      resolveUpdatedBotToken(MASKED_BOT_TOKEN, '123456:SECRET_BOT_TOKEN'),
      '123456:SECRET_BOT_TOKEN'
    );
    // Submitting a new token replaces it
    assert.equal(
      resolveUpdatedBotToken('999999:NEW_TOKEN', '123456:SECRET_BOT_TOKEN'),
      '999999:NEW_TOKEN'
    );
    // Submitting empty string clears it
    assert.equal(resolveUpdatedBotToken('', '123456:SECRET_BOT_TOKEN'), '');
  });

  it('strips private credentials and hides note/presets in Do Not Disturb mode', () => {
    const activeView = toPublicTagView(sampleTag, 1710000005000);
    assert.equal(activeView.code, 'RT-482-9XK');
    assert.equal(activeView.contactEnabled, true);
    assert.equal(activeView.quickPresets.length, 2);
    assert.equal('telegramBotToken' in activeView, false);
    assert.equal('telegramChatId' in activeView, false);

    const dndView = toPublicTagView(
      { ...sampleTag, contactEnabled: false },
      1710000005000
    );
    assert.equal(dndView.contactEnabled, false);
    assert.equal(dndView.statusNote, '');
    assert.equal(dndView.quickPresets.length, 0);
  });

  it('isolates public scanner conversation threads by sessionId so scanners never see other scanners messages', () => {
    assert.equal(sanitizeScannerSessionId('scan-abc12345'), 'scan-abc12345');
    assert.equal(sanitizeScannerSessionId('short'), null);
    assert.equal(sanitizeScannerSessionId('bad<script>id'), null);

    const messages: RelayMessage[] = [
      {
        id: 'm1',
        tagId: 'tag-1',
        sessionId: 'scan-passerby-A',
        sender: 'scanner',
        senderAlias: 'Passerby #111',
        text: 'Blocking my driveway',
        createdAt: 1000,
      },
      {
        id: 'm2',
        tagId: 'tag-1',
        sessionId: 'scan-passerby-A',
        sender: 'owner',
        senderAlias: 'Vehicle Owner (Anonymous)',
        text: 'Coming right out!',
        createdAt: 2000,
      },
      {
        id: 'm3',
        tagId: 'tag-1',
        sessionId: 'scan-passerby-B',
        sender: 'scanner',
        senderAlias: 'Passerby #222',
        text: 'Headlights left on',
        createdAt: 3000,
      },
    ];

    const threadA = filterMessagesForPublicScanner(messages, 'tag-1', true, 'scan-passerby-A');
    assert.equal(threadA.length, 2);
    assert.deepEqual(threadA.map((m) => m.id), ['m1', 'm2']);

    const threadB = filterMessagesForPublicScanner(messages, 'tag-1', true, 'scan-passerby-B');
    assert.equal(threadB.length, 1);
    assert.equal(threadB[0].id, 'm3');

    // Scanner C with a fresh session sees 0 messages from A or B
    const threadC = filterMessagesForPublicScanner(messages, 'tag-1', true, 'scan-passerby-C');
    assert.equal(threadC.length, 0);

    // When DND is active, even Scanner A sees 0 messages
    const threadDnd = filterMessagesForPublicScanner(messages, 'tag-1', false, 'scan-passerby-A');
    assert.equal(threadDnd.length, 0);
  });

  it('enforces sliding-window rate limiting per scanner key', () => {
    const rateMap = new Map<string, number[]>();
    const key = 'ip-127.0.0.1:RT-482-9XK';
    const baseTime = 1_000_000;

    for (let i = 0; i < 5; i++) {
      const check = checkScannerRateLimit(rateMap, key, baseTime + i * 1000, 5, 60_000);
      assert.equal(check.allowed, true);
    }

    // 6th message within 60s window is blocked
    const blocked = checkScannerRateLimit(rateMap, key, baseTime + 6000, 5, 60_000);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds > 0);

    // After window elapses, messages are allowed again
    const allowedAfterWindow = checkScannerRateLimit(
      rateMap,
      key,
      baseTime + 61_000,
      5,
      60_000
    );
    assert.equal(allowedAfterWindow.allowed, true);
  });

  it('verifies owner session tokens and blocks unauthorized or mismatched UID access', () => {
    const validTokens = new Set(['tok-valid-123']);

    // Missing token -> 401
    assert.equal(
      verifyOwnerAccess({ providedToken: null, validTokens }).status,
      401
    );
    // Invalid token -> 401
    assert.equal(
      verifyOwnerAccess({ providedToken: 'tok-wrong', validTokens }).status,
      401
    );
    // Valid token -> 200
    assert.equal(
      verifyOwnerAccess({ providedToken: 'tok-valid-123', validTokens }).authorized,
      true
    );
    // Valid token + mismatched Firebase UID on claimed tag -> 403
    const mismatch = verifyOwnerAccess({
      providedToken: 'tok-valid-123',
      validTokens,
      tagOwnerUid: 'uid-owner-1',
      providedFirebaseUid: 'uid-attacker-2',
    });
    assert.equal(mismatch.authorized, false);
    assert.equal(mismatch.status, 403);
  });

  it('blocks incoming messages when contact toggle is off (Do Not Disturb)', () => {
    const res = validateIncomingMessage('Hey please move your car', false);
    assert.equal(res.valid, false);
    assert.match(res.error || '', /turned off incoming messages/i);
  });

  it('rejects empty, whitespace, or non-string messages and sanitizes control chars', () => {
    assert.equal(validateIncomingMessage('   \n  ', true).valid, false);
    assert.equal(validateIncomingMessage(null, true).valid, false);
    assert.equal(validateIncomingMessage(12345, true).valid, false);

    const validRes = validateIncomingMessage(
      '  Your \x00  lights\tare on! ',
      true
    );
    assert.equal(validRes.valid, true);
    assert.equal(validRes.sanitizedText, 'Your lights are on!');
  });

  it('rejects messages and owner replies exceeding 280 characters', () => {
    const longMsg = 'a'.repeat(285);
    const res = validateIncomingMessage(longMsg, true);
    assert.equal(res.valid, false);
    assert.equal(res.sanitizedText.length, 280);

    const replyRes = validateOwnerReply(longMsg);
    assert.equal(replyRes.valid, false);
    assert.equal(replyRes.sanitizedText.length, 280);

    const validReply = validateOwnerReply('  Heading down in 2 mins! ');
    assert.equal(validReply.valid, true);
    assert.equal(validReply.sanitizedText, 'Heading down in 2 mins!');
  });

  it('formats Telegram relay payload without leaking owner personal phone number', () => {
    const text = formatTelegramRelayPayload(
      sampleTag,
      'Passerby #402',
      'Blocking the exit lane',
      'urgent'
    );
    assert.match(text, /RT-482-9XK/);
    assert.match(text, /SBA 8492M/);
    assert.match(text, /\[URGENT\] Blocking the exit lane/);
  });

  it('calculates remaining minutes accurately including 3h (180m) timer', () => {
    assert.equal(computeRemainingMinutes(null, 1000), null);
    assert.equal(computeRemainingMinutes(0, 1000), null);
    assert.equal(computeRemainingMinutes(1000, 2000), 0);
    assert.equal(computeRemainingMinutes(1000 + 90_000, 1000), 2);
    assert.equal(computeRemainingMinutes(1000 + 180 * 60_000, 1000), 180);
  });

  it('cleanupStoreState auto-expires elapsed timers, prunes stale/orphaned messages, and caps message history', () => {
    const now = 2_000_000_000_000;
    const tag: TagConfig = {
      ...sampleTag,
      id: 'tag-default',
      contactEnabled: true,
      autoExpireAt: now - 1000, // expired 1s ago
    };
    const expiredMessage: RelayMessage = {
      id: 'old-msg',
      tagId: 'tag-default',
      sender: 'scanner',
      senderAlias: 'Passerby #100',
      text: 'Stale message > 24h old',
      createdAt: now - MESSAGE_TTL_MS - 5000,
    };
    const orphanMessage: RelayMessage = {
      id: 'orphan-msg',
      tagId: 'deleted-tag',
      sender: 'scanner',
      senderAlias: 'Passerby #101',
      text: 'Orphaned tag message',
      createdAt: now - 1000,
    };
    const recentMessages: RelayMessage[] = Array.from(
      { length: MAX_MESSAGES_PER_TAG + 5 },
      (_, idx) => ({
        id: `msg-${idx}`,
        tagId: 'tag-default',
        sender: 'scanner' as const,
        senderAlias: 'Passerby',
        text: `Message #${idx}`,
        createdAt: now - (MAX_MESSAGES_PER_TAG + 10 - idx) * 1000,
      })
    );

    const store = {
      tags: [tag],
      messages: [expiredMessage, orphanMessage, ...recentMessages],
    };

    const mutated = cleanupStoreState(store, now);
    assert.equal(mutated, true);
    assert.equal(store.tags[0].contactEnabled, false);
    assert.equal(store.tags[0].autoExpireAt, null);
    assert.equal(store.messages.length, MAX_MESSAGES_PER_TAG);
    assert.equal(store.messages[0].id, 'msg-5');
    assert.equal(store.messages[store.messages.length - 1].id, `msg-${MAX_MESSAGES_PER_TAG + 4}`);
  });

  it('prunes expired rate-limit keys and resolves target scanner session accurately', () => {
    const rateMap = new Map<string, number[]>([
      ['expired-key', [1000, 2000]],
      ['active-key', [1000, 95_000]],
    ]);
    const removed = pruneRateLimitMap(rateMap, 100_000, 60_000);
    assert.equal(removed, 1);
    assert.equal(rateMap.has('expired-key'), false);
    assert.deepEqual(rateMap.get('active-key'), [95_000]);

    const msgs: RelayMessage[] = [
      {
        id: 'm1',
        tagId: 'tag-default',
        sessionId: 'scan-older1234',
        sender: 'scanner',
        senderAlias: 'Passerby #1',
        text: 'Hello 1',
        createdAt: 1000,
      },
      {
        id: 'm2',
        tagId: 'tag-default',
        sessionId: 'scan-newer5678',
        sender: 'scanner',
        senderAlias: 'Passerby #2',
        text: 'Hello 2',
        createdAt: 2000,
      },
    ];
    assert.equal(
      resolveTargetScannerSession(msgs, 'tag-default', undefined),
      'scan-newer5678'
    );
    assert.equal(
      resolveTargetScannerSession(msgs, 'tag-default', 'scan-older1234'),
      'scan-older1234'
    );
  });

  it('validates Telegram Bot Token and Chat ID format strictly', () => {
    assert.equal(validateTelegramCredentials('', '987654321').valid, false);
    assert.equal(validateTelegramCredentials('bad-token', '987654321').valid, false);
    assert.equal(
      validateTelegramCredentials('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '').valid,
      false
    );
    assert.equal(
      validateTelegramCredentials('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', 'invalid chat').valid,
      false
    );
    const valid = validateTelegramCredentials(
      '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
      '987654321'
    );
    assert.equal(valid.valid, true);
    assert.equal(isTelegramReady(sampleTag), true);
    assert.equal(isTelegramReady({ ...sampleTag, telegramEnabled: false }), false);
  });

  it('computes 4-step setup readiness accurately for guided onboarding and starts at 0/4 when not set up yet', () => {
    const initialUnconfigured = createInitialTagConfig(1710000000000);
    assert.equal(initialUnconfigured.contactEnabled, false);
    assert.equal(hasTagSetupData(initialUnconfigured), false);

    const zeroReadiness = computeSetupReadiness({
      isSignedIn: false,
      tag: initialUnconfigured,
    });
    assert.equal(zeroReadiness.completedCount, 0);
    assert.equal(zeroReadiness.totalCount, 4);
    assert.equal(zeroReadiness.allReady, false);

    assert.equal(
      hasTagSetupData({ ...initialUnconfigured, plateHint: 'SBA 8492M' }),
      true
    );

    const partial = computeSetupReadiness({
      isSignedIn: false,
      tag: { ...sampleTag, telegramEnabled: false },
    });
    assert.equal(partial.completedCount, 2);
    assert.equal(partial.totalCount, 4);
    assert.equal(partial.allReady, false);

    const complete = computeSetupReadiness({
      isSignedIn: true,
      userEmail: 'driver@example.com',
      tag: sampleTag,
    });
    assert.equal(complete.completedCount, 4);
    assert.equal(complete.allReady, true);
  });

  it('suppresses auth/popup-closed-by-user and cancelled popup errors in formatAuthErrorForUi', () => {
    assert.equal(
      formatAuthErrorForUi(new Error('Firebase: Error (auth/popup-closed-by-user).')),
      null
    );
    assert.equal(
      formatAuthErrorForUi({ code: 'auth/popup-closed-by-user', message: 'Popup closed' }),
      null
    );
    assert.equal(
      formatAuthErrorForUi({ code: 'auth/cancelled-popup-request' }),
      null
    );
    assert.equal(
      formatAuthErrorForUi(new Error('Firebase: Error (auth/network-request-failed).')),
      'Could not complete Google sign-in. Please try again.'
    );
  });

  it('embeds scanner sessionId in Telegram payload and extracts it on swipe-to-reply', () => {
    const payload = formatTelegramRelayPayload(
      sampleTag,
      'Passerby #512',
      'Headlights left on',
      'lights',
      'https://relaytag.example.com',
      'scan-sessionA99'
    );
    assert.match(payload, /Session: #scan-sessionA99/);
    assert.match(payload, /Reply directly to this message in Telegram/i);

    const extracted = extractSessionIdFromTelegramText(payload);
    assert.equal(extracted, 'scan-sessionA99');
    assert.equal(extractSessionIdFromTelegramText('No session token here'), undefined);
  });

  it('parses incoming Telegram updates for direct owner replies, session routing, and /dnd commands', () => {
    const existingMessages: RelayMessage[] = [
      {
        id: 'm1',
        tagId: 'tag-1',
        sessionId: 'scan-passerby11',
        sender: 'scanner',
        senderAlias: 'Passerby #111',
        text: 'Blocking driveway',
        createdAt: 1000,
      },
      {
        id: 'm2',
        tagId: 'tag-1',
        sessionId: 'scan-passerby22',
        sender: 'scanner',
        senderAlias: 'Passerby #222',
        text: 'Lights on',
        createdAt: 2000,
      },
    ];

    // 1. Plain reply in Telegram routes to latest active scanner session (scan-passerby22)
    const plainReply = parseTelegramUpdateForOwnerReply(
      {
        update_id: 501,
        message: {
          text: 'Be right there in 3 minutes!',
          chat: { id: 987654321 },
          from: { is_bot: false },
        },
      },
      '987654321',
      existingMessages,
      'tag-1'
    );
    assert.equal(plainReply.action, 'reply');
    if (plainReply.action === 'reply') {
      assert.equal(plainReply.sanitizedText, 'Be right there in 3 minutes!');
      assert.equal(plainReply.sessionId, 'scan-passerby22');
      assert.equal(plainReply.updateId, 501);
    }

    // 2. Swipe-reply to Passerby #111's specific Telegram message routes to scan-passerby11
    const quotedAlert = formatTelegramRelayPayload(
      sampleTag,
      'Passerby #111',
      'Blocking driveway',
      undefined,
      undefined,
      'scan-passerby11'
    );
    const targetedReply = parseTelegramUpdateForOwnerReply(
      {
        update_id: 502,
        message: {
          text: 'Moving out of your driveway now!',
          chat: { id: 987654321 },
          from: { is_bot: false },
          reply_to_message: { text: quotedAlert },
        },
      },
      '987654321',
      existingMessages,
      'tag-1'
    );
    assert.equal(targetedReply.action, 'reply');
    if (targetedReply.action === 'reply') {
      assert.equal(targetedReply.sessionId, 'scan-passerby11');
      assert.equal(targetedReply.sanitizedText, 'Moving out of your driveway now!');
    }

    // 3. Rejects unauthorized chat IDs (prevents strangers from spoofing owner replies)
    const unauthorized = parseTelegramUpdateForOwnerReply(
      {
        update_id: 503,
        message: {
          text: 'Spoofed reply',
          chat: { id: 111111111 },
          from: { is_bot: false },
        },
      },
      '987654321',
      existingMessages,
      'tag-1'
    );
    assert.equal(unauthorized.action, 'ignore');

    // 4. Supports /dnd and /on commands directly from Telegram
    const dndCmd = parseTelegramUpdateForOwnerReply(
      {
        update_id: 504,
        message: {
          text: '/dnd',
          chat: { id: 987654321 },
          from: { is_bot: false },
        },
      },
      '987654321',
      existingMessages,
      'tag-1'
    );
    assert.equal(dndCmd.action, 'command-dnd');

    const onCmd = parseTelegramUpdateForOwnerReply(
      {
        update_id: 505,
        message: {
          text: '/on',
          chat: { id: 987654321 },
          from: { is_bot: false },
        },
      },
      '987654321',
      existingMessages,
      'tag-1'
    );
    assert.equal(onCmd.action, 'command-on');
  });

  it('halts scanner backend polling when Reachable is OFF and enforces DND spam shield', () => {
    // Public scanner must NOT poll backend when contactEnabled is false or null
    assert.equal(
      shouldPollScannerBackend({
        isPublicScanRoute: true,
        contactEnabled: false,
        hasNotFoundError: false,
      }),
      false
    );
    assert.equal(
      shouldPollScannerBackend({
        isPublicScanRoute: true,
        contactEnabled: null,
        hasNotFoundError: false,
      }),
      false
    );
    assert.equal(
      shouldPollScannerBackend({
        isPublicScanRoute: true,
        contactEnabled: true,
        hasNotFoundError: false,
      }),
      true
    );

    const dndMap = new Map<string, number[]>();
    const now = 5_000_000;
    for (let i = 0; i < 4; i++) {
      assert.equal(checkDndSpamShield(dndMap, '10.0.0.1', now + i * 100).allowed, true);
    }
    const blocked = checkDndSpamShield(dndMap, '10.0.0.1', now + 500);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds > 0);
  });

  it('formats relative message timestamps accurately across recurring intervals without reloading history', () => {
    const baseTime = 1_760_000_000_000;
    assert.equal(RELATIVE_TIMESTAMP_REFRESH_MS, 10_000);

    // Just created (< 10s) or slight future clock skew
    assert.equal(formatRelativeTimestamp(baseTime, baseTime), 'Just now');
    assert.equal(formatRelativeTimestamp(baseTime, baseTime + 5_000), 'Just now');
    assert.equal(formatRelativeTimestamp(baseTime + 3_000, baseTime), 'Just now');

    // Seconds (10s - 59s)
    assert.equal(formatRelativeTimestamp(baseTime, baseTime + 15_000), '15s ago');
    assert.equal(formatRelativeTimestamp(baseTime, baseTime + 45_000), '45s ago');

    // Minutes (1m - 59m, including '2m ago')
    assert.equal(formatRelativeTimestamp(baseTime, baseTime + 60_000), '1m ago');
    assert.equal(formatRelativeTimestamp(baseTime, baseTime + 2 * 60_000), '2m ago');
    assert.equal(formatRelativeTimestamp(baseTime, baseTime + 59 * 60_000), '59m ago');

    // Hours (1h - 23h)
    assert.equal(formatRelativeTimestamp(baseTime, baseTime + 60 * 60_000), '1h ago');
    assert.equal(formatRelativeTimestamp(baseTime, baseTime + 5 * 60 * 60_000), '5h ago');

    // Days (1d - 6d)
    assert.equal(formatRelativeTimestamp(baseTime, baseTime + 24 * 60 * 60_000), '1d ago');
    assert.equal(formatRelativeTimestamp(baseTime, baseTime + 3 * 24 * 60 * 60_000), '3d ago');

    // Non-finite fallback
    assert.equal(formatRelativeTimestamp(Number.NaN, baseTime), 'Just now');
  });

  it('extracts client IP safely behind reverse proxies and constructs secure cookies & health summaries', () => {
    assert.equal(
      extractClientIp('203.0.113.42, 10.0.0.1', '127.0.0.1'),
      '203.0.113.42'
    );
    assert.equal(
      extractClientIp(['198.51.100.7, 10.0.0.2'], '127.0.0.1'),
      '198.51.100.7'
    );
    assert.equal(
      extractClientIp('<script>malicious</script>', '127.0.0.1'),
      '127.0.0.1'
    );
    assert.equal(extractClientIp(undefined, undefined), 'unknown');

    const secureCookie = buildOwnerSessionCookie('rt_own_abc', true);
    assert.match(secureCookie, /SameSite=None; Secure/);
    assert.match(secureCookie, /HttpOnly/);

    const localCookie = buildOwnerSessionCookie('rt_own_abc', false);
    assert.match(localCookie, /SameSite=Lax/);
    assert.doesNotMatch(localCookie, /Secure/);

    const health = computeHealthSummary(
      {
        tags: [sampleTag],
        messages: [
          {
            id: 'm1',
            tagId: 'tag-1',
            sender: 'scanner',
            senderAlias: 'Passerby',
            text: 'Hi',
            createdAt: 1000,
          },
        ],
      },
      15_000,
      5_000
    );
    assert.equal(health.status, 'ok');
    assert.equal(health.ready, true);
    assert.equal(health.uptimeSeconds, 10);
    assert.equal(health.tagCount, 1);
    assert.equal(health.activeMessageCount, 1);
    assert.equal(health.reachableTagCount, 1);
  });

  it('generates distinct, schema-compliant tag codes on regeneration', () => {
    const prev = 'RT-482-9XK';
    for (let i = 0; i < 20; i++) {
      const next = generateNewTagCode(prev);
      assert.notEqual(next, prev);
      assert.match(next, /^RT-[2-9]{3}-[A-Z2-9]{3}$/);
      assert.match(next, /^[A-Z0-9-]+$/);
    }
  });

  it('computes live scanner delivery status progression (Delivered to Console/Telegram -> Driver Replied)', () => {
    const scanMsgConsole: RelayMessage = {
      id: 'm-scan-1',
      tagId: 'tag-1',
      sessionId: 'scan-session-1',
      sender: 'scanner',
      senderAlias: 'Passerby #101',
      text: 'Lights left on',
      createdAt: 1000,
      telegramForwarded: false,
    };
    const scanMsgTelegram: RelayMessage = {
      ...scanMsgConsole,
      id: 'm-scan-2',
      createdAt: 2000,
      telegramForwarded: true,
    };

    // Before driver replies
    const threadBeforeReply = filterMessagesForPublicScanner(
      [scanMsgConsole, scanMsgTelegram],
      'tag-1',
      true,
      'scan-session-1'
    );
    assert.equal(threadBeforeReply[1].telegramForwarded, true);

    assert.deepEqual(
      computeScannerMessageDeliveryStatus(threadBeforeReply[0], threadBeforeReply),
      { stage: 'delivered-relay', label: 'Delivered to Console' }
    );
    assert.deepEqual(
      computeScannerMessageDeliveryStatus(threadBeforeReply[1], threadBeforeReply),
      { stage: 'delivered-telegram', label: 'Delivered to Telegram' }
    );

    // After driver replies
    const ownerReply: RelayMessage = {
      id: 'm-owner-1',
      tagId: 'tag-1',
      sessionId: 'scan-session-1',
      sender: 'owner',
      senderAlias: 'Vehicle Owner',
      text: 'Coming down in 2 mins!',
      createdAt: 3000,
    };
    const threadAfterReply = [...threadBeforeReply, ownerReply];
    assert.deepEqual(
      computeScannerMessageDeliveryStatus(threadBeforeReply[1], threadAfterReply),
      { stage: 'driver-replied', label: 'Driver Replied' }
    );
  });

  it('extracts rate-limit retryAfterSeconds and formats live cooldown button labels', () => {
    assert.equal(extractRetryAfterSeconds({ retryAfterSeconds: 14 }), 14);
    assert.equal(extractRetryAfterSeconds({ retryAfterSeconds: 11.2 }), 12);
    assert.equal(
      extractRetryAfterSeconds({
        error: 'Rate limit reached. Please wait 19s before sending another alert.',
      }),
      19
    );
    assert.equal(extractRetryAfterSeconds({ error: 'Network error' }), 0);
    assert.equal(extractRetryAfterSeconds(null), 0);

    assert.equal(formatCooldownButtonLabel(14), 'Retry in 14s');
    assert.equal(formatCooldownButtonLabel(0, 'Send Anonymous Message'), 'Send Anonymous Message');
  });

  it('builds downloadable SVG badges and sanitized PNG/SVG filenames', () => {
    assert.equal(sanitizeBadgeFilename('RT-482-9XK', 'png'), 'relaytag-RT-482-9XK.png');
    assert.equal(sanitizeBadgeFilename('rt-999-abc', 'svg'), 'relaytag-RT-999-ABC.svg');

    const svgBadge = buildDownloadableTagSvgBadge({
      code: 'RT-482-9XK',
      plateHint: 'SBA 8492M',
      vehicleLabel: 'Slate Civic & Co',
      qrSvgMarkup: '<svg viewBox="0 0 33 33"><path d="M0 0h10v10H0z" fill="#141413"/></svg>',
    });
    assert.match(svgBadge, /WINDSHIELD TAG · RT-482-9XK/);
    assert.match(svgBadge, /SBA 8492M · Slate Civic &amp; Co/);
    assert.match(
      svgBadge,
      /<svg x="144" y="224" width="352" height="352" viewBox="0 0 33 33" shape-rendering="crispEdges">/
    );
  });

  it('normalizes legacy placeholder strings from persisted Firestore records and formats empty-field Telegram headers cleanly', () => {
    const legacyNormalized = normalizePersistedTagFields({
      code: 'RT-482-9XK',
      vehicleLabel: 'Registered Vehicle',
      plateNumber: 'RT-482-9XK',
      statusNote: 'Contact via RelayTag',
    });
    assert.deepEqual(legacyNormalized, {
      vehicleLabel: '',
      plateHint: '',
      statusNote: '',
    });

    assert.equal(
      hasTagSetupData({
        code: 'RT-482-9XK',
        vehicleLabel: 'Registered Vehicle',
        plateNumber: 'RT-482-9XK',
        statusNote: 'Contact via RelayTag',
      }),
      false
    );

    const realNormalized = normalizePersistedTagFields({
      code: 'RT-482-9XK',
      vehicleLabel: 'Slate Civic Hatchback',
      plateNumber: 'sba 8492m',
      statusNote: '',
    });
    assert.deepEqual(realNormalized, {
      vehicleLabel: 'Slate Civic Hatchback',
      plateHint: 'SBA 8492M',
      statusNote: '',
    });

    const unconfiguredAlert = formatTelegramRelayPayload(
      { code: 'RT-482-9XK', vehicleLabel: '', plateHint: '' },
      'Passerby #101',
      'Headlights on'
    );
    assert.match(unconfiguredAlert, /🚗 RelayTag Alert — RT-482-9XK/);
    assert.doesNotMatch(unconfiguredAlert, /\(\)/);
  });

  it('enforces authorized owner email, PIN format validation, blocks header spoofing, and validates CSRF origin', async () => {
    const {
      AUTHORIZED_OWNER_EMAIL,
      isAuthorizedOwnerEmail,
      validateOwnerPinFormat,
      evaluateOwnerSessionRequest,
      verifySameOriginRequest,
    } = await import('./relayLogic.ts');

    // Authorized owner email check
    assert.equal(isAuthorizedOwnerEmail(AUTHORIZED_OWNER_EMAIL), true);
    assert.equal(isAuthorizedOwnerEmail('YUWON6881@GMAIL.COM '), true);
    assert.equal(isAuthorizedOwnerEmail('stranger@example.com'), false);
    assert.equal(isAuthorizedOwnerEmail(null), false);

    // Owner PIN format validation (4-8 digits)
    assert.equal(validateOwnerPinFormat('4829').valid, true);
    assert.equal(validateOwnerPinFormat(' 12345678 ').cleanPin, '12345678');
    assert.equal(validateOwnerPinFormat('123').valid, false);
    assert.equal(validateOwnerPinFormat('123456789').valid, false);
    assert.equal(validateOwnerPinFormat('12a4').valid, false);

    const validTokens = new Set(['tok-existing-1']);

    // Unauthenticated visitor without token, Google auth, or PIN is rejected with 401
    const unauthEval = evaluateOwnerSessionRequest({
      existingToken: null,
      validTokens,
      firebaseUid: null,
      firebaseEmail: null,
      tagOwnerUid: 'owner-uid-1',
      allowedOwnerEmail: AUTHORIZED_OWNER_EMAIL,
      pinVerified: false,
      pinAttemptProvided: false,
    });
    assert.equal(unauthEval.allowed, false);
    assert.equal(unauthEval.status, 401);

    // Header spoofing attempt (raw X-Firebase-Uid / X-Firebase-Email without verified Bearer token) is rejected with 401
    const spoofedHeaderEval = evaluateOwnerSessionRequest({
      existingToken: null,
      validTokens,
      firebaseUid: null,
      firebaseEmail: null,
      firebaseTokenVerified: false,
      firebaseEmailVerified: false,
      unverifiedHeaderPresent: true,
      tagOwnerUid: 'owner-uid-1',
      allowedOwnerEmail: AUTHORIZED_OWNER_EMAIL,
      pinVerified: false,
      pinAttemptProvided: false,
    });
    assert.equal(spoofedHeaderEval.allowed, false);
    assert.equal(spoofedHeaderEval.status, 401);

    // Unverified Bearer token (firebaseTokenVerified: false) is rejected with 401 even if UID & email match
    const unverifiedTokenEval = evaluateOwnerSessionRequest({
      existingToken: null,
      validTokens,
      firebaseUid: 'owner-uid-1',
      firebaseEmail: AUTHORIZED_OWNER_EMAIL,
      firebaseTokenVerified: false,
      firebaseEmailVerified: true,
      tagOwnerUid: 'owner-uid-1',
      allowedOwnerEmail: AUTHORIZED_OWNER_EMAIL,
      pinVerified: false,
      pinAttemptProvided: false,
    });
    assert.equal(unverifiedTokenEval.allowed, false);
    assert.equal(unverifiedTokenEval.status, 401);

    // Unverified Google email (firebaseEmailVerified: false) is rejected with 403
    const unverifiedEmailEval = evaluateOwnerSessionRequest({
      existingToken: null,
      validTokens,
      firebaseUid: 'owner-uid-1',
      firebaseEmail: AUTHORIZED_OWNER_EMAIL,
      firebaseTokenVerified: true,
      firebaseEmailVerified: false,
      tagOwnerUid: 'owner-uid-1',
      allowedOwnerEmail: AUTHORIZED_OWNER_EMAIL,
      pinVerified: false,
      pinAttemptProvided: false,
    });
    assert.equal(unverifiedEmailEval.allowed, false);
    assert.equal(unverifiedEmailEval.status, 403);

    // Unauthorized Google account is rejected with 403
    const wrongAccountEval = evaluateOwnerSessionRequest({
      existingToken: null,
      validTokens,
      firebaseUid: 'intruder-uid',
      firebaseEmail: 'intruder@gmail.com',
      firebaseTokenVerified: true,
      firebaseEmailVerified: true,
      tagOwnerUid: 'owner-uid-1',
      allowedOwnerEmail: AUTHORIZED_OWNER_EMAIL,
      pinVerified: false,
      pinAttemptProvided: false,
    });
    assert.equal(wrongAccountEval.allowed, false);
    assert.equal(wrongAccountEval.status, 403);

    // Cryptographically verified authorized owner Google account is granted session
    const validGoogleEval = evaluateOwnerSessionRequest({
      existingToken: null,
      validTokens,
      firebaseUid: 'owner-uid-1',
      firebaseEmail: AUTHORIZED_OWNER_EMAIL,
      firebaseTokenVerified: true,
      firebaseEmailVerified: true,
      tagOwnerUid: 'owner-uid-1',
      allowedOwnerEmail: AUTHORIZED_OWNER_EMAIL,
      pinVerified: false,
      pinAttemptProvided: false,
    });
    assert.equal(validGoogleEval.allowed, true);
    assert.equal(validGoogleEval.authMethod, 'google');

    // Valid PIN unlock is granted session
    const validPinEval = evaluateOwnerSessionRequest({
      existingToken: null,
      validTokens,
      firebaseUid: null,
      firebaseEmail: null,
      tagOwnerUid: 'owner-uid-1',
      allowedOwnerEmail: AUTHORIZED_OWNER_EMAIL,
      pinVerified: true,
      pinAttemptProvided: true,
    });
    assert.equal(validPinEval.allowed, true);
    assert.equal(validPinEval.authMethod, 'pin');

    // CSRF Same-Origin check
    assert.equal(verifySameOriginRequest('https://relaytag.app', 'relaytag.app'), true);
    assert.equal(verifySameOriginRequest('https://evil.example.com', 'relaytag.app'), false);
    assert.equal(verifySameOriginRequest(undefined, 'relaytag.app'), true);

    // Strip ownerPinHash in toOwnerTagView while exposing ownerPinConfigured boolean
    const viewWithPin = toOwnerTagView({
      ...sampleTag,
      ownerPinHash: 'salt:deadbeef',
    });
    assert.equal(viewWithPin.ownerPinConfigured, true);
    assert.equal('ownerPinHash' in viewWithPin, false);
  });
});





