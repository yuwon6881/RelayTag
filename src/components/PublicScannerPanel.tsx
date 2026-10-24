import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  Lock,
  Send,
  CheckCircle2,
  CheckCheck,
  AlertCircle,
  Car,
  Clock,
} from 'lucide-react';
import {
  PublicTagView,
  RelayMessage,
  formatRelativeTimestamp,
  RELATIVE_TIMESTAMP_REFRESH_MS,
  computeScannerMessageDeliveryStatus,
  extractRetryAfterSeconds,
  formatCooldownButtonLabel,
} from '../utils/relayLogic';

interface PublicScannerPanelProps {
  publicTag: PublicTagView | null;
  messages: RelayMessage[];
  notFoundError?: string | null;
  onSendMessage: (payload: {
    text: string;
    category?: string;
    senderAlias?: string;
  }) => Promise<{
    ok: boolean;
    error?: string;
    telegramForwarded?: boolean;
    retryAfterSeconds?: number;
  }>;
}

export const PublicScannerPanel: React.FC<PublicScannerPanelProps> = ({
  publicTag,
  messages,
  notFoundError,
  onSendMessage,
}) => {
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
    isRateLimit?: boolean;
  } | null>(null);

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const isReachable = Boolean(publicTag?.contactEnabled);

  // Sync clock immediately when new messages arrive
  useEffect(() => {
    if (messages.length > 0) {
      setNowMs(Date.now());
    }
  }, [messages]);

  // Live 1-second countdown timer when rate-limit cooldown is active
  useEffect(() => {
    if (cooldownSeconds <= 0) {
      return;
    }
    const timerId = window.setInterval(() => {
      setCooldownSeconds((prev) => {
        if (prev <= 1) {
          setFeedback((curr) => (curr?.isRateLimit ? null : curr));
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(timerId);
  }, [cooldownSeconds]);

  // Recurring interval effect to keep relative message timestamps updated without reloading history
  useEffect(() => {
    if (!isReachable || messages.length === 0) {
      return;
    }
    const intervalId = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      setNowMs(Date.now());
    }, RELATIVE_TIMESTAMP_REFRESH_MS);

    return () => window.clearInterval(intervalId);
  }, [isReachable, messages.length]);

  // Clear stale success feedback if owner switches to Do Not Disturb
  useEffect(() => {
    if (!isReachable && feedback?.type === 'success') {
      setFeedback(null);
    }
  }, [isReachable, feedback]);

  if (notFoundError) {
    return (
      <div className="animate-view-enter rounded-3xl border border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-[#11141B] p-6 sm:p-7 text-center space-y-2.5 shadow-sm">
        <div className="w-12 h-12 rounded-2xl bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 flex items-center justify-center mx-auto">
          <AlertCircle className="w-5 h-5" />
        </div>
        <h2 className="font-display text-lg font-bold text-zinc-900 dark:text-zinc-100">
          Windshield Tag Not Found
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-xs mx-auto leading-relaxed">
          {notFoundError}
        </p>
      </div>
    );
  }

  if (!publicTag) {
    return (
      <div className="rounded-3xl border border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-[#11141B] p-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
        Loading vehicle tag status...
      </div>
    );
  }

  const handleSend = async (textToUse: string) => {
    if (sending || cooldownSeconds > 0) return;
    setSending(true);
    setFeedback(null);
    const result = await onSendMessage({ text: textToUse });
    setSending(false);

    if (result.ok) {
      setMessageText('');
      setFeedback({
        type: 'success',
        text: result.telegramForwarded
          ? 'Sent to owner via private relay & Telegram.'
          : 'Message delivered to vehicle owner.',
      });
    } else {
      const retrySecs = extractRetryAfterSeconds(result);
      if (retrySecs > 0) {
        setCooldownSeconds(retrySecs);
        setFeedback({
          type: 'error',
          text: `Rate limit active — you can send another alert in ${retrySecs}s.`,
          isRateLimit: true,
        });
      } else {
        setFeedback({
          type: 'error',
          text: result.error || 'Could not send message.',
        });
      }
    }
  };

  const isCoolingDown = cooldownSeconds > 0;
  const submitButtonLabel = formatCooldownButtonLabel(
    cooldownSeconds,
    sending ? 'Sending...' : 'Send Anonymous Message'
  );

  return (
    <div className="animate-view-enter rounded-3xl border border-zinc-200/90 dark:border-white/[0.08] bg-white dark:bg-[#11141B] shadow-sm overflow-hidden">
      {/* Vehicle Status Header */}
      <div
        className={`px-5 sm:px-6 py-4 sm:py-5 border-b spring-transition flex items-center justify-between gap-3 ${
          isReachable
            ? 'bg-emerald-50/90 dark:bg-[#0D221B] border-emerald-200/90 dark:border-emerald-500/25 text-emerald-950 dark:text-white'
            : 'bg-zinc-50 dark:bg-[#161A23] border-zinc-200/80 dark:border-white/[0.07] text-zinc-900 dark:text-zinc-100'
        }`}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-mono opacity-80">{publicTag.code}</span>
            {publicTag.plateHint && (
              <>
                <span aria-hidden="true" className="opacity-40">
                  ·
                </span>
                <span className="inline-flex items-center gap-1 font-mono font-bold tracking-wider">
                  <Car className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>{publicTag.plateHint}</span>
                </span>
              </>
            )}
          </div>
          <h1 className="font-display text-lg sm:text-xl font-bold tracking-tight mt-1 truncate">
            {publicTag.vehicleLabel || 'Registered Vehicle'}
          </h1>
        </div>

        <span
          className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap ${
            isReachable
              ? 'bg-emerald-600/15 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-200 border border-emerald-500/30 dark:border-emerald-400/30'
              : 'bg-zinc-200/80 dark:bg-[#222836] text-zinc-700 dark:text-zinc-300 border border-zinc-300/60 dark:border-white/[0.08]'
          }`}
        >
          {isReachable ? 'Owner Reachable' : 'Do Not Disturb'}
        </span>
      </div>

      <div className="p-5 sm:p-6 space-y-4 sm:space-y-5">
        {isReachable ? (
          <>
            {publicTag.statusNote && (
              <div className="rounded-2xl bg-zinc-50 dark:bg-[#161B24] border border-zinc-200/80 dark:border-white/[0.07] px-4 py-3 text-sm text-zinc-700 dark:text-zinc-300">
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">Owner note: </span>
                “{publicTag.statusNote}”
              </div>
            )}

            {/* Conversation thread: absent until there is something in it */}
            {messages.length > 0 && (
              <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar pr-1">
                {messages.slice(-5).map((m) => {
                  const deliveryStatus =
                    m.sender === 'scanner'
                      ? computeScannerMessageDeliveryStatus(m, messages)
                      : null;

                  return (
                    <div
                      key={m.id}
                      className={`animate-msg-enter rounded-2xl px-4 py-3 text-xs ${
                        m.sender === 'owner'
                          ? 'bg-emerald-50/90 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-500/30 text-emerald-950 dark:text-emerald-100 ml-3 sm:ml-4'
                          : 'bg-zinc-50 dark:bg-[#171B24] border border-zinc-200/80 dark:border-white/[0.07] text-zinc-800 dark:text-zinc-200 mr-3 sm:mr-4'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px] opacity-75 mb-1">
                        <span className="font-semibold truncate">
                          {m.sender === 'owner' ? 'Driver' : 'You'}
                        </span>
                        <time
                          data-testid="scanner-message-relative-time"
                          dateTime={new Date(m.createdAt).toISOString()}
                          title={new Date(m.createdAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                          className="font-mono tabular-nums shrink-0"
                        >
                          {formatRelativeTimestamp(m.createdAt, nowMs)}
                        </time>
                      </div>
                      <p className="text-sm leading-snug break-words">{m.text}</p>

                      {deliveryStatus && (
                        <div
                          data-testid="scanner-delivery-status"
                          data-delivery-stage={deliveryStatus.stage}
                          className={`mt-2 pt-1.5 border-t border-zinc-200/60 dark:border-white/[0.06] flex items-center gap-1.5 text-[11px] font-medium ${
                            deliveryStatus.stage === 'driver-replied'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : deliveryStatus.stage === 'delivered-telegram'
                              ? 'text-emerald-700/90 dark:text-emerald-400/90'
                              : 'text-zinc-500 dark:text-zinc-400'
                          }`}
                        >
                          {deliveryStatus.stage === 'driver-replied' ? (
                            <CheckCheck className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                          )}
                          <span>{deliveryStatus.label}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSend(messageText);
              }}
              className="space-y-2.5"
            >
              <textarea
                id="scanner-custom-note"
                rows={2}
                maxLength={280}
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                aria-label="Message to the driver"
                placeholder="Write a message to the driver..."
                className="w-full rounded-2xl border border-zinc-200 dark:border-white/[0.09] bg-zinc-50 dark:bg-[#0D1016] px-4 py-3 text-base sm:text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-[#131822] focus:border-zinc-900 dark:focus:border-emerald-500/60 focus:outline-none"
              />
              <button
                type="submit"
                data-testid="scanner-send-button"
                disabled={sending || isCoolingDown || !messageText.trim()}
                className="spring-transition w-full min-h-[48px] inline-flex items-center justify-center gap-2 rounded-2xl bg-zinc-900 dark:bg-emerald-500 hover:bg-zinc-800 dark:hover:bg-emerald-400 disabled:bg-zinc-200 dark:disabled:bg-[#1B202C] disabled:text-zinc-500 dark:disabled:text-zinc-400 text-white dark:text-emerald-950 font-semibold text-sm px-5 py-3.5 cursor-pointer active:scale-[0.99] whitespace-nowrap"
              >
                {isCoolingDown ? (
                  <Clock className="w-4 h-4 shrink-0" />
                ) : (
                  <Send className="w-4 h-4 shrink-0" />
                )}
                <span className="font-mono sm:font-sans tabular-nums">
                  {submitButtonLabel}
                </span>
              </button>
            </form>
          </>
        ) : (
          <div className="py-7 sm:py-8 text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-zinc-100 dark:bg-[#191E29] border border-zinc-200/70 dark:border-white/[0.07] text-zinc-600 dark:text-zinc-300 flex items-center justify-center mx-auto">
              <Lock className="w-5 h-5" />
            </div>
            <h2 className="font-display text-lg font-bold text-zinc-900 dark:text-zinc-100">
              Owner Has Turned Off Messages
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-xs mx-auto leading-relaxed">
              This vehicle’s contact switch is currently off (Do Not Disturb). No messages or notifications can be sent right now.
            </p>
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 pt-1">
              <ShieldCheck className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
              <span>Standby Shield Active · Server polling paused</span>
            </div>
          </div>
        )}

        {feedback && (
          <div
            role="status"
            className={`animate-msg-enter rounded-2xl px-4 py-3 text-xs font-medium flex items-center gap-2 ${
              feedback.type === 'success'
                ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-900 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-500/30'
                : 'bg-red-50 dark:bg-red-950/50 text-red-900 dark:text-red-200 border border-red-200 dark:border-red-500/30'
            }`}
          >
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span>
              {feedback.isRateLimit && isCoolingDown
                ? `Rate limit reached — retry available in ${cooldownSeconds}s.`
                : feedback.text}
            </span>
          </div>
        )}

      </div>
    </div>
  );
};

