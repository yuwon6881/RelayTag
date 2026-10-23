import React, { useState, useEffect } from 'react';
import { MessageSquare, Send, Printer } from 'lucide-react';
import {
  RelayMessage,
  formatRelativeTimestamp,
  RELATIVE_TIMESTAMP_REFRESH_MS,
} from '../utils/relayLogic';

interface MessageListProps {
  messages: RelayMessage[];
  isContactActive: boolean;
  simulatingScan: boolean;
  onSimulateScanAlert: () => void;
  onOpenQrModal: () => void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  isContactActive,
  simulatingScan,
  onSimulateScanAlert,
  onOpenQrModal,
  messagesEndRef,
}) => {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Sync clock immediately when new messages arrive so relative labels start at "Just now"
  useEffect(() => {
    if (messages.length > 0) {
      setNowMs(Date.now());
    }
  }, [messages]);

  // Recurring interval effect to keep relative timestamps (e.g., "2m ago") updated in-place without reloading history
  useEffect(() => {
    if (messages.length === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      setNowMs(Date.now());
    }, RELATIVE_TIMESTAMP_REFRESH_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setNowMs(Date.now());
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div
        data-testid="messages-empty-container"
        className="flex-1 min-h-0 overflow-hidden px-5 sm:px-7 flex flex-col items-center justify-center text-center bg-zinc-50/40 dark:bg-[#0C0E14]"
      >
        <div className="w-12 h-12 rounded-2xl bg-white dark:bg-[#161B24] border border-zinc-200/80 dark:border-white/[0.08] text-zinc-500 dark:text-emerald-400 flex items-center justify-center mb-3.5 shadow-2xs">
          <MessageSquare className="w-5 h-5" />
        </div>
        <p className="font-display text-base font-bold text-zinc-900 dark:text-zinc-100">
          No messages right now
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 max-w-xs leading-relaxed">
          {isContactActive
            ? 'When someone scans your windshield QR code, their anonymous alert will appear here.'
            : 'Your tag is currently in Do Not Disturb mode. Turn Contact ON when parked to receive windshield alerts.'}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2.5 mt-4">
          <button
            type="button"
            disabled={simulatingScan}
            onClick={onSimulateScanAlert}
            className="spring-transition min-h-[44px] sm:min-h-0 inline-flex items-center gap-1.5 rounded-xl bg-white dark:bg-[#171C26] hover:bg-zinc-100 dark:hover:bg-[#1F2533] border border-zinc-200/90 dark:border-white/[0.09] px-4 py-2.5 sm:py-2 text-xs font-semibold text-zinc-800 dark:text-zinc-200 cursor-pointer active:scale-95 disabled:opacity-50 whitespace-nowrap"
          >
            <Send className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>{simulatingScan ? 'Sending Test...' : 'Send Test Scan'}</span>
          </button>
          <button
            type="button"
            onClick={onOpenQrModal}
            className="spring-transition min-h-[44px] sm:min-h-0 inline-flex items-center gap-1.5 rounded-xl bg-white dark:bg-[#171C26] hover:bg-zinc-100 dark:hover:bg-[#1F2533] border border-zinc-200/90 dark:border-white/[0.09] px-4 py-2.5 sm:py-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300 cursor-pointer active:scale-95 whitespace-nowrap"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Windshield QR</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="messages-scroll-container"
      className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3.5 sm:px-6 py-4 sm:py-5 space-y-3 bg-zinc-50/40 dark:bg-[#0C0E14]"
    >
      {messages.map((msg) => {
        const relativeTime = formatRelativeTimestamp(msg.createdAt, nowMs);
        const exactTime = new Date(msg.createdAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });

        return (
          <div
            key={msg.id}
            className={`animate-msg-enter flex flex-col ${
              msg.sender === 'owner' ? 'items-end' : 'items-start'
            }`}
          >
            <div
              className={`max-w-[88%] sm:max-w-[74%] rounded-2xl px-4 py-3 text-sm ${
                msg.sender === 'owner'
                  ? 'bg-zinc-900 dark:bg-emerald-600 text-white'
                  : 'bg-white dark:bg-[#171C26] border border-zinc-200/90 dark:border-white/[0.08] text-zinc-900 dark:text-zinc-100 shadow-2xs'
              }`}
            >
              <div className="flex items-center justify-between gap-4 text-[11px] opacity-75 mb-1">
                <span className="font-semibold">
                  {msg.sender === 'owner'
                    ? msg.viaTelegram || msg.senderAlias.includes('Telegram')
                      ? 'You · via Telegram'
                      : 'You · Owner'
                    : msg.senderAlias}
                </span>
                <time
                  data-testid="message-relative-time"
                  dateTime={new Date(msg.createdAt).toISOString()}
                  title={exactTime}
                  className="font-mono tabular-nums shrink-0"
                >
                  {relativeTime}
                </time>
              </div>
              <p className="leading-relaxed break-words">{msg.text}</p>
            </div>
          </div>
        );
      })}
      <div ref={messagesEndRef} />
    </div>
  );
};
