import React, { useState } from 'react';
import {
  CheckCircle2,
  Circle,
  Bell,
  Copy,
  Check,
  Send,
  Eye,
  EyeOff,
  X,
  LogIn,
  Printer,
  MessageSquare,
  ChevronRight,
} from 'lucide-react';
import {
  SetupReadinessSummary,
  MASKED_BOT_TOKEN,
} from '../utils/relayLogic';

interface GuidedSetupPanelProps {
  isOpen: boolean;
  onClose: () => void;
  readiness: SetupReadinessSummary;
  isSignedIn: boolean;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  telegramBotTokenConfigured: boolean;
  settingsSaved: boolean;
  telegramTesting: boolean;
  simulatingScan: boolean;
  simulatingTelegramReply: boolean;
  telegramFeedback: { type: 'success' | 'error'; text: string } | null;
  onChangeBotToken: (val: string) => void;
  onChangeChatId: (val: string) => void;
  onToggleTelegramSwitch: () => void;
  onSaveTelegram: (e: React.FormEvent) => void;
  onTestTelegram: () => void;
  onGoogleSignIn: () => void;
  onOpenQrModal: () => void;
  onFocusPlateInput: () => void;
  onSimulateScanAlert: () => void;
  onSimulateTelegramReply: () => void;
}

export const GuidedSetupPanel: React.FC<GuidedSetupPanelProps> = ({
  isOpen,
  onClose,
  readiness,
  isSignedIn,
  telegramEnabled,
  telegramBotToken,
  telegramChatId,
  telegramBotTokenConfigured,
  settingsSaved,
  telegramTesting,
  simulatingScan,
  simulatingTelegramReply,
  telegramFeedback,
  onChangeBotToken,
  onChangeChatId,
  onToggleTelegramSwitch,
  onSaveTelegram,
  onTestTelegram,
  onGoogleSignIn,
  onOpenQrModal,
  onFocusPlateInput,
  onSimulateScanAlert,
  onSimulateTelegramReply,
}) => {
  const [activeTab, setActiveTab] = useState<'telegram' | 'checklist'>('telegram');
  const [revealToken, setRevealToken] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleCopySnippet = (text: string, label: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedSnippet(label);
    setTimeout(() => setCopiedSnippet(null), 1800);
  };

  const isTelegramFullyReady =
    telegramEnabled &&
    (telegramBotTokenConfigured || Boolean(telegramBotToken.trim())) &&
    Boolean(telegramChatId.trim());

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup-sheet-title"
      className="animate-backdrop-enter fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="animate-modal-enter bg-white dark:bg-[#11141B] rounded-t-3xl sm:rounded-3xl border-t sm:border border-zinc-200 dark:border-white/[0.09] max-w-md w-full max-h-[90dvh] overflow-y-auto custom-scrollbar p-5 sm:p-6 pb-7 sm:pb-6 shadow-2xl space-y-4 relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mobile Bottom Sheet Grab Handle */}
        <div
          aria-hidden="true"
          className="w-10 h-1.5 rounded-full bg-zinc-300 dark:bg-zinc-700 mx-auto -mt-1 mb-2 sm:hidden"
        />

        {/* Modal Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-10 h-10 sm:w-9 sm:h-9 rounded-xl bg-zinc-100 dark:bg-[#191E29] border border-zinc-200/70 dark:border-white/[0.07] text-zinc-700 dark:text-zinc-200 flex items-center justify-center shrink-0">
              <Bell className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2
                id="setup-sheet-title"
                className="font-display text-base font-bold text-zinc-900 dark:text-zinc-100 truncate"
              >
                Phone Alerts & Setup
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                <span className="font-mono tabular-nums">
                  {readiness.completedCount}/{readiness.totalCount}
                </span>{' '}
                steps ready ·{' '}
                <span
                  className={
                    isTelegramFullyReady
                      ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                      : 'text-amber-600 dark:text-amber-400 font-medium'
                  }
                >
                  {isTelegramFullyReady ? '2-Way Telegram Active' : 'Telegram Unlinked'}
                </span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close Setup Modal"
            className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 sm:w-8 sm:h-8 rounded-xl bg-zinc-100 dark:bg-[#191E29] hover:bg-zinc-200 dark:hover:bg-[#222836] border border-zinc-200/60 dark:border-white/[0.07] text-zinc-600 dark:text-zinc-300 flex items-center justify-center cursor-pointer spring-transition shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Segmented Switcher */}
        <div className="grid grid-cols-2 rounded-xl bg-zinc-100 dark:bg-[#0B0E14] p-1 border border-zinc-200/70 dark:border-white/[0.07]">
          <button
            type="button"
            onClick={() => setActiveTab('telegram')}
            className={`spring-transition min-h-[40px] sm:min-h-0 py-2 sm:py-1.5 rounded-lg text-xs font-semibold cursor-pointer whitespace-nowrap ${
              activeTab === 'telegram'
                ? 'bg-white dark:bg-[#1B202C] text-zinc-900 dark:text-white shadow-2xs'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            Telegram Bot
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('checklist')}
            className={`spring-transition min-h-[40px] sm:min-h-0 py-2 sm:py-1.5 rounded-lg text-xs font-semibold cursor-pointer whitespace-nowrap ${
              activeTab === 'checklist'
                ? 'bg-white dark:bg-[#1B202C] text-zinc-900 dark:text-white shadow-2xs'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            System Check ({readiness.completedCount}/{readiness.totalCount})
          </button>
        </div>

        {activeTab === 'telegram' ? (
          <div className="space-y-3.5">
            {/* Enable Switch */}
            <div className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-2xl bg-zinc-50 dark:bg-[#161A23] border border-zinc-200/70 dark:border-white/[0.07]">
              <div className="min-w-0">
                <span className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                  2-Way Telegram Alert & Reply Bridge
                </span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                  Reply directly in Telegram to message the scanner back
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={telegramEnabled}
                aria-label="Enable Telegram Bot forwarding"
                onClick={onToggleTelegramSwitch}
                className={`spring-transition relative inline-flex h-7 w-12 sm:h-6 sm:w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent items-center focus:outline-none ${
                  telegramEnabled
                    ? 'bg-emerald-600 dark:bg-emerald-500'
                    : 'bg-zinc-300 dark:bg-[#252B39]'
                }`}
              >
                <span
                  className={`spring-transition pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-xs ring-0 ${
                    telegramEnabled ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>

            {/* Concise 2-step helper */}
            <div className="rounded-2xl border border-zinc-200/80 dark:border-white/[0.07] bg-zinc-50/50 dark:bg-[#141821] p-3.5 space-y-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-zinc-600 dark:text-zinc-300 leading-snug">
                  <strong className="font-mono text-zinc-900 dark:text-zinc-100">01.</strong>{' '}
                  Message{' '}
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-emerald-700 dark:text-emerald-400 underline"
                  >
                    @BotFather
                  </a>{' '}
                  to create a bot & tap <strong>Start</strong>
                </span>
                <button
                  type="button"
                  onClick={() => handleCopySnippet('/newbot', 'newbot')}
                  className="shrink-0 min-h-[36px] sm:min-h-0 inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-white/[0.09] bg-white dark:bg-[#1D222E] px-2.5 py-1 text-[11px] font-mono font-semibold text-zinc-700 dark:text-zinc-200 cursor-pointer whitespace-nowrap"
                >
                  {copiedSnippet === 'newbot' ? (
                    <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>/newbot</span>
                </button>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-zinc-600 dark:text-zinc-300 leading-snug">
                  <strong className="font-mono text-zinc-900 dark:text-zinc-100">02.</strong>{' '}
                  Message{' '}
                  <a
                    href="https://t.me/userinfobot"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-emerald-700 dark:text-emerald-400 underline"
                  >
                    @userinfobot
                  </a>{' '}
                  to get your numeric Chat ID
                </span>
                <button
                  type="button"
                  onClick={() => handleCopySnippet('@userinfobot', 'userinfobot')}
                  className="shrink-0 min-h-[36px] sm:min-h-0 inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-white/[0.09] bg-white dark:bg-[#1D222E] px-2.5 py-1 text-[11px] font-mono font-semibold text-zinc-700 dark:text-zinc-200 cursor-pointer whitespace-nowrap"
                >
                  {copiedSnippet === 'userinfobot' ? (
                    <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>@userinfobot</span>
                </button>
              </div>
            </div>

            {/* Credentials Form */}
            <form onSubmit={onSaveTelegram} className="space-y-3">
              <div>
                <label
                  htmlFor="telegram-bot-token-input"
                  className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-400 mb-1"
                >
                  Telegram Bot Token
                </label>
                <div className="relative">
                  <input
                    id="telegram-bot-token-input"
                    type={revealToken ? 'text' : 'password'}
                    maxLength={120}
                    value={telegramBotToken}
                    onChange={(e) => onChangeBotToken(e.target.value)}
                    placeholder="123456789:AAHdqTcvCH1v..."
                    className="w-full rounded-xl border border-zinc-200 dark:border-white/[0.09] bg-zinc-50 dark:bg-[#0B0E14] pl-3.5 pr-10 py-2.5 text-base sm:text-xs font-mono text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-[#121620] focus:border-zinc-900 dark:focus:border-emerald-500/60 focus:outline-none"
                  />
                  {telegramBotToken && telegramBotToken !== MASKED_BOT_TOKEN && (
                    <button
                      type="button"
                      onClick={() => setRevealToken(!revealToken)}
                      aria-label={revealToken ? 'Hide Bot Token' : 'Show Bot Token'}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 min-w-[36px] min-h-[36px] flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer"
                    >
                      {revealToken ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  )}
                </div>
              </div>

              <div>
                <label
                  htmlFor="telegram-chat-id-input"
                  className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-400 mb-1"
                >
                  Telegram Chat ID
                </label>
                <input
                  id="telegram-chat-id-input"
                  type="text"
                  inputMode="numeric"
                  maxLength={60}
                  value={telegramChatId}
                  onChange={(e) => onChangeChatId(e.target.value)}
                  placeholder="e.g. 987654321"
                  className="w-full rounded-xl border border-zinc-200 dark:border-white/[0.09] bg-zinc-50 dark:bg-[#0B0E14] px-3.5 py-2.5 text-base sm:text-xs font-mono text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-[#121620] focus:border-zinc-900 dark:focus:border-emerald-500/60 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-0.5">
                <button
                  type="button"
                  disabled={telegramTesting}
                  onClick={onTestTelegram}
                  className="spring-transition w-full min-h-[44px] sm:min-h-0 inline-flex items-center justify-center gap-1.5 rounded-xl bg-zinc-900 dark:bg-emerald-500 hover:bg-zinc-800 dark:hover:bg-emerald-400 text-white dark:text-emerald-950 font-semibold text-xs py-2.5 px-3 cursor-pointer active:scale-[0.99] disabled:opacity-50 whitespace-nowrap"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{telegramTesting ? 'Testing...' : 'Verify & Test Ping'}</span>
                </button>

                <button
                  type="submit"
                  className="spring-transition w-full min-h-[44px] sm:min-h-0 rounded-xl border border-zinc-200 dark:border-white/[0.09] bg-zinc-50 dark:bg-[#181C26] hover:bg-zinc-100 dark:hover:bg-[#202634] text-zinc-800 dark:text-zinc-100 font-semibold text-xs py-2.5 px-3 cursor-pointer active:scale-[0.99] whitespace-nowrap"
                >
                  {settingsSaved ? 'Saved ✓' : 'Save Settings'}
                </button>
              </div>

              {telegramFeedback && (
                <div
                  role="status"
                  className={`text-xs font-medium rounded-xl px-3 py-2.5 border leading-snug ${
                    telegramFeedback.type === 'success'
                      ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-900 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/30'
                      : 'bg-red-50 dark:bg-red-950/60 text-red-800 dark:text-red-200 border-red-200 dark:border-red-500/30'
                  }`}
                >
                  {telegramFeedback.text}
                </div>
              )}
            </form>
          </div>
        ) : (
          /* Tab 2: System Readiness & Simulate Scan / Reply */
          <div className="space-y-3">
            <div className="divide-y divide-zinc-100 dark:divide-white/[0.06] rounded-2xl border border-zinc-200/80 dark:border-white/[0.07] bg-zinc-50/50 dark:bg-[#141821] px-3.5">
              {readiness.steps.map((step) => (
                <div
                  key={step.id}
                  className="py-3 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    {step.done ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    ) : (
                      <Circle className="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                        {step.title}
                      </p>
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                        {step.statusText}
                      </p>
                    </div>
                  </div>

                  {step.id === 'cloud-sync' && !isSignedIn && (
                    <button
                      type="button"
                      onClick={onGoogleSignIn}
                      className="shrink-0 min-h-[36px] sm:min-h-0 inline-flex items-center gap-1 rounded-lg bg-zinc-900 dark:bg-emerald-500 text-white dark:text-emerald-950 px-3 py-1.5 text-[11px] font-semibold cursor-pointer whitespace-nowrap"
                    >
                      <LogIn className="w-3 h-3" />
                      <span>Sign In</span>
                    </button>
                  )}
                  {step.id === 'vehicle-plate' && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onFocusPlateInput();
                      }}
                      className="shrink-0 min-h-[36px] sm:min-h-0 rounded-lg border border-zinc-200 dark:border-white/[0.09] bg-white dark:bg-[#1C212D] px-3 py-1.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 cursor-pointer whitespace-nowrap"
                    >
                      Edit
                    </button>
                  )}
                  {step.id === 'telegram-alert' && !step.done && (
                    <button
                      type="button"
                      onClick={() => setActiveTab('telegram')}
                      className="shrink-0 min-h-[36px] sm:min-h-0 inline-flex items-center gap-0.5 rounded-lg border border-zinc-200 dark:border-white/[0.09] bg-white dark:bg-[#1C212D] px-3 py-1.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 cursor-pointer whitespace-nowrap"
                    >
                      <span>Link</span>
                      <ChevronRight className="w-3 h-3" />
                    </button>
                  )}
                  {step.id === 'windshield-qr' && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenQrModal();
                      }}
                      className="shrink-0 min-h-[36px] sm:min-h-0 inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-white/[0.09] bg-white dark:bg-[#1C212D] px-3 py-1.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 cursor-pointer whitespace-nowrap"
                    >
                      <Printer className="w-3 h-3" />
                      <span>QR</span>
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                disabled={simulatingScan}
                onClick={onSimulateScanAlert}
                className="spring-transition w-full min-h-[44px] sm:min-h-0 inline-flex items-center justify-center gap-1.5 rounded-xl bg-zinc-900 dark:bg-emerald-500 hover:bg-zinc-800 dark:hover:bg-emerald-400 text-white dark:text-emerald-950 text-xs font-semibold py-2.5 px-3 cursor-pointer active:scale-95 disabled:opacity-50 whitespace-nowrap"
              >
                <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {simulatingScan ? 'Sending Scan...' : 'Simulate Scan Alert'}
                </span>
              </button>

              <button
                type="button"
                disabled={simulatingTelegramReply}
                onClick={onSimulateTelegramReply}
                className="spring-transition w-full min-h-[44px] sm:min-h-0 inline-flex items-center justify-center gap-1.5 rounded-xl border border-zinc-200 dark:border-white/[0.09] bg-zinc-50 dark:bg-[#181C26] hover:bg-zinc-100 dark:hover:bg-[#202634] text-zinc-800 dark:text-zinc-100 text-xs font-semibold py-2.5 px-3 cursor-pointer active:scale-95 disabled:opacity-50 whitespace-nowrap"
              >
                <Send className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span>
                  {simulatingTelegramReply
                    ? 'Routing Reply...'
                    : 'Simulate Telegram Reply'}
                </span>
              </button>
            </div>

            {telegramFeedback && (
              <div
                role="status"
                className={`text-xs font-medium rounded-xl px-3 py-2.5 border leading-snug ${
                  telegramFeedback.type === 'success'
                    ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-900 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/30'
                    : 'bg-red-50 dark:bg-red-950/60 text-red-800 dark:text-red-200 border-red-200 dark:border-red-500/30'
                }`}
              >
                {telegramFeedback.text}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
