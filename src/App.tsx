import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Power,
  Send,
  Printer,
  Trash2,
  Clock,
  Bell,
  ChevronRight,
  MessageSquare,
  Sliders,
  X,
  Copy,
  Check,
  ShieldCheck,
  Lock,
  Sun,
  Moon,
  Car,
  UserCheck,
  LogIn,
  LogOut,
} from 'lucide-react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import {
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
} from './firebase';
import {
  TagConfig,
  OwnerTagView,
  RelayMessage,
  PublicTagView,
  QUICK_TIMER_PRESETS,
  MASKED_BOT_TOKEN,
  computeRemainingMinutes,
  isContactWindowActive,
  toPublicTagView,
  computeSetupReadiness,
  formatAuthErrorForUi,
  shouldPollScannerBackend,
  hasTagSetupData,
  RELATIVE_TIMESTAMP_REFRESH_MS,
} from './utils/relayLogic';
import { QrCodeVector } from './components/QrCodeVector';
import { PublicScannerPanel } from './components/PublicScannerPanel';
import { GuidedSetupPanel } from './components/GuidedSetupPanel';
import { MessageList } from './components/MessageList';

type OwnerPage = 'control' | 'messages';
type ThemePreference = 'system' | 'light' | 'dark';

function getOrCreateScannerSessionId(): string {
  if (typeof window === 'undefined') return 'scan-ssr-fallback';
  try {
    const existing = window.localStorage.getItem('relaytag-scanner-session');
    if (existing && /^[a-zA-Z0-9_-]{8,64}$/.test(existing)) {
      return existing;
    }
    const randomPart =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        : Math.random().toString(36).slice(2, 10) +
          Math.random().toString(36).slice(2, 6);
    const created = `scan-${randomPart}`;
    window.localStorage.setItem('relaytag-scanner-session', created);
    return created;
  } catch {
    return 'scan-ephemeral-session';
  }
}

export default function App() {
  const isPublicScanRoute =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('scan');

  const scannedCodeParam =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('scan')
      : null;

  // Theme state: defaults to 'system' (browser prefers-color-scheme)
  const [themePref, setThemePref] = useState<ThemePreference>(() => {
    if (typeof window === 'undefined') return 'system';
    const saved = window.localStorage.getItem('relaytag-theme') as ThemePreference | null;
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    return 'system';
  });
  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const saved = window.localStorage.getItem('relaytag-theme') as ThemePreference | null;
    if (saved === 'dark') return true;
    if (saved === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const applyTheme = () => {
      const effectiveDark =
        themePref === 'dark'
          ? true
          : themePref === 'light'
          ? false
          : mediaQuery.matches;
      setIsDark(effectiveDark);
      document.documentElement.classList.toggle('dark', effectiveDark);
    };

    applyTheme();
    window.localStorage.setItem('relaytag-theme', themePref);

    const listener = () => {
      if (themePref === 'system') {
        applyTheme();
      }
    };
    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }, [themePref]);

  const toggleTheme = () => {
    setThemePref((prev) => {
      const currentEffectiveDark =
        prev === 'dark'
          ? true
          : prev === 'light'
          ? false
          : window.matchMedia('(prefers-color-scheme: dark)').matches;
      return currentEffectiveDark ? 'light' : 'dark';
    });
  };

  // Firebase Auth state
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const [ownerPage, setOwnerPage] = useState<OwnerPage>('control');
  const [showQrModal, setShowQrModal] = useState(false);
  const [showSetupModal, setShowSetupModal] = useState(false);

  const [tag, setTag] = useState<OwnerTagView | null>(null);
  const [publicScanTag, setPublicScanTag] = useState<PublicTagView | null>(null);
  const [publicNotFoundError, setPublicNotFoundError] = useState<string | null>(null);
  const [messages, setMessages] = useState<RelayMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState<number>(Date.now());

  // Owner reply state
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);

  // Vehicle & License Plate setup state
  const [vehicleLabelInput, setVehicleLabelInput] = useState('');
  const [plateNumberInput, setPlateNumberInput] = useState('');
  const [statusNoteInput, setStatusNoteInput] = useState('');
  const [vehicleSaving, setVehicleSaving] = useState(false);
  const [vehicleSavedToast, setVehicleSavedToast] = useState(false);

  // Guided Telegram & Test Scan setup state
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramBotToken, setTelegramBotToken] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [simulatingScan, setSimulatingScan] = useState(false);
  const [simulatingTelegramReply, setSimulatingTelegramReply] = useState(false);
  const [telegramFeedback, setTelegramFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  const initializedRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const ownerTokenRef = useRef<string | null>(
    typeof window !== 'undefined'
      ? window.sessionStorage.getItem('relaytag-owner-token')
      : null
  );
  const scannerSessionIdRef = useRef<string>(getOrCreateScannerSessionId());
  // Cached Firestore createdAt timestamps to eliminate redundant getDoc reads on updates
  const tagCreatedAtCacheRef = useRef<Record<string, Timestamp | null>>({});
  const privateConfigCreatedAtRef = useRef<Timestamp | null>(null);
  const privateBotTokenCacheRef = useRef<string>('');

  const ensureOwnerSession = useCallback(async (forceRefresh = false): Promise<string | null> => {
    if (!forceRefresh && ownerTokenRef.current) {
      return ownerTokenRef.current;
    }
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (ownerTokenRef.current) {
        headers['X-Owner-Token'] = ownerTokenRef.current;
      }
      if (auth.currentUser?.uid) {
        headers['X-Firebase-Uid'] = auth.currentUser.uid;
      }
      const res = await fetch('/api/owner/session', {
        method: 'POST',
        headers,
        credentials: 'same-origin',
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (typeof data.token === 'string' && data.token) {
        ownerTokenRef.current = data.token;
        try {
          window.sessionStorage.setItem('relaytag-owner-token', data.token);
        } catch {
          // ignore storage quota errors
        }
        return data.token;
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  const ownerFetch = useCallback(
    async (input: string, init: RequestInit = {}): Promise<Response> => {
      let token = await ensureOwnerSession(false);
      const buildHeaders = (tok: string | null) => {
        const h = new Headers(init.headers || {});
        if (tok) h.set('X-Owner-Token', tok);
        if (auth.currentUser?.uid) h.set('X-Firebase-Uid', auth.currentUser.uid);
        return h;
      };

      let res = await fetch(input, {
        ...init,
        headers: buildHeaders(token),
        credentials: 'same-origin',
      });

      if (res.status === 401) {
        token = await ensureOwnerSession(true);
        res = await fetch(input, {
          ...init,
          headers: buildHeaders(token),
          credentials: 'same-origin',
        });
      }
      return res;
    },
    [ensureOwnerSession]
  );

  const fetchState = useCallback(async () => {
    try {
      if (isPublicScanRoute) {
        const cleanCode = (scannedCodeParam || '').trim().toUpperCase();
        if (!cleanCode) {
          setPublicNotFoundError('Invalid or missing QR tag code.');
          setPublicScanTag(null);
          return;
        }

        // Zero-Backend-Wake DND Check: Race Firestore edge read (250ms budget) before hitting backend
        const fsPromise = /^[A-Z0-9-]+$/.test(cleanCode)
          ? getDoc(doc(db, 'tags', cleanCode)).catch(() => null)
          : Promise.resolve(null);

        const quickFsSnap = await Promise.race([
          fsPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
        ]);

        if (quickFsSnap && quickFsSnap.exists()) {
          const fd = quickFsSnap.data();
          const nowClient = Date.now();
          const fsActive = isContactWindowActive(
            Boolean(fd.contactEnabled),
            typeof fd.autoExpireAt === 'number' ? fd.autoExpireAt : null,
            nowClient
          );
          // If Reachable is OFF in Firestore, resolve immediately without hitting the backend
          if (!fsActive) {
            setPublicNotFoundError(null);
            setPublicScanTag({
              code: cleanCode,
              vehicleLabel: String(fd.vehicleLabel || 'Registered Vehicle'),
              plateHint: String(fd.plateNumber || ''),
              contactEnabled: false,
              statusNote: '',
              quickPresets: [],
              updatedAt: nowClient,
            });
            setMessages([]);
            setNowMs(nowClient);
            setLoading(false);
            return;
          }
        }

        const sessionParam = encodeURIComponent(scannerSessionIdRef.current);
        const res = await fetch(
          `/api/public/tags/${encodeURIComponent(cleanCode)}?sessionId=${sessionParam}`,
          {
            headers: {
              'X-Scanner-Session': scannerSessionIdRef.current,
            },
          }
        );
        const data = await res.json();
        if (!res.ok && res.status !== 429) {
          setPublicNotFoundError(data.error || 'Windshield tag code not found.');
          setPublicScanTag(null);
          setMessages([]);
          setLoading(false);
          return;
        }

        const serverTime = data.serverTime || Date.now();
        const resolvedPublicTag: PublicTagView = data.tag;

        // Render immediately from fast server / HTTP cache response
        setPublicNotFoundError(null);
        setPublicScanTag(resolvedPublicTag);
        setMessages(resolvedPublicTag.contactEnabled ? data.messages || [] : []);
        setNowMs(serverTime);
        setLoading(false);

        // Apply Firestore overlay asynchronously if available
        void fsPromise.then((fsSnap) => {
          if (!fsSnap || !fsSnap.exists()) return;
          const fd = fsSnap.data();
          const fsActive = isContactWindowActive(
            Boolean(fd.contactEnabled),
            typeof fd.autoExpireAt === 'number' ? fd.autoExpireAt : null,
            serverTime
          );
          const effectiveActive = fsActive && resolvedPublicTag.contactEnabled;
          setPublicScanTag((prev) =>
            prev
              ? {
                  ...prev,
                  vehicleLabel: String(fd.vehicleLabel || '') || prev.vehicleLabel,
                  plateHint: String(fd.plateNumber || '') || prev.plateHint,
                  contactEnabled: effectiveActive,
                  statusNote: effectiveActive
                    ? String(fd.statusNote || '') || prev.statusNote
                    : '',
                  quickPresets: effectiveActive ? prev.quickPresets : [],
                }
              : prev
          );
          if (!effectiveActive) {
            setMessages([]);
          }
        });
        return;
      }

      const res = await ownerFetch('/api/owner/state');
      if (!res.ok) return;
      const data = await res.json();
      const firstTag: OwnerTagView | undefined = data.tags?.[0];
      if (firstTag) {
        setTag(firstTag);
        if (!initializedRef.current) {
          setVehicleLabelInput(firstTag.vehicleLabel);
          setPlateNumberInput(firstTag.plateHint);
          setStatusNoteInput(firstTag.statusNote);
          setTelegramEnabled(firstTag.telegramEnabled);
          setTelegramBotToken(firstTag.telegramBotToken);
          setTelegramChatId(firstTag.telegramChatId);
          initializedRef.current = true;
        }
      }
      setMessages(data.messages || []);
      setNowMs(data.serverTime || Date.now());
    } catch (err) {
      console.error('Failed to load state:', err);
    } finally {
      setLoading(false);
    }
  }, [isPublicScanRoute, scannedCodeParam, ownerFetch]);

  // Initial fetch on mount or route change
  useEffect(() => {
    fetchState();
  }, [fetchState]);

  // Visibility-aware & DND-aware polling: completely halts backend polling when Reachable is OFF
  const shouldPoll = shouldPollScannerBackend({
    isPublicScanRoute,
    contactEnabled: publicScanTag?.contactEnabled,
    hasNotFoundError: Boolean(publicNotFoundError),
  });

  useEffect(() => {
    if (!shouldPoll) {
      return;
    }
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      fetchState();
    }, 4000);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchState();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchState, shouldPoll]);

  // Listen to Firebase Auth state and sync user's vehicle profile, DND state, private config & messages from Firestore
  useEffect(() => {
    if (isPublicScanRoute) {
      setAuthLoading(false);
      return;
    }
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      setAuthLoading(false);
      if (user) {
        try {
          await ensureOwnerSession(true);
          const tagDocRef = doc(db, 'tags', 'RT-482-9XK');
          const privRef = doc(db, 'users', user.uid, 'private', 'config');
          const [snap, privSnap] = await Promise.all([
            getDoc(tagDocRef),
            getDoc(privRef),
          ]);

          const d = snap.exists() && snap.data().ownerId === user.uid ? snap.data() : null;
          const pd = privSnap.exists() && privSnap.data().ownerId === user.uid ? privSnap.data() : null;
          const isConfigured = hasTagSetupData({
            vehicleLabel: d?.vehicleLabel,
            plateNumber: d?.plateNumber,
            statusNote: d?.statusNote,
            telegramEnabled: pd?.telegramEnabled,
            telegramBotToken: pd?.telegramBotToken,
            telegramChatId: pd?.telegramChatId,
          });

          if (d) {
            if (d.createdAt) {
              tagCreatedAtCacheRef.current['RT-482-9XK'] = d.createdAt;
            }
            setVehicleLabelInput(d.vehicleLabel || '');
            setPlateNumberInput(d.plateNumber || '');
            setStatusNoteInput(d.statusNote || '');
            await ownerFetch('/api/owner/tags/tag-default', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                vehicleLabel: d.vehicleLabel,
                plateHint: d.plateNumber,
                statusNote: d.statusNote,
                contactEnabled:
                  isConfigured && typeof d.contactEnabled === 'boolean'
                    ? d.contactEnabled
                    : false,
                autoExpireAt:
                  isConfigured && typeof d.autoExpireAt === 'number' && d.autoExpireAt > 0
                    ? d.autoExpireAt
                    : null,
              }),
            });
          }

          // Restore owner's private Telegram configuration from Firestore if present
          if (pd) {
            if (pd.createdAt) {
              privateConfigCreatedAtRef.current = pd.createdAt;
            }
            if (typeof pd.telegramBotToken === 'string') {
              privateBotTokenCacheRef.current = pd.telegramBotToken;
            }
            setTelegramEnabled(Boolean(pd.telegramEnabled));
            setTelegramBotToken(pd.telegramBotToken ? MASKED_BOT_TOKEN : '');
            setTelegramChatId(pd.telegramChatId || '');
            const patchRes = await ownerFetch('/api/owner/tags/tag-default', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                telegramEnabled: Boolean(pd.telegramEnabled),
                telegramBotToken: pd.telegramBotToken || '',
                telegramChatId: pd.telegramChatId || '',
              }),
            });
            if (patchRes.ok) {
              const patchData = await patchRes.json();
              if (patchData.vault?.vaultId && patchData.vault?.ciphertext) {
                const vaultRef = doc(db, 'tags', 'RT-482-9XK', 'vault', patchData.vault.vaultId);
                const vaultSnap = await getDoc(vaultRef);
                const existingVaultCreatedAt = vaultSnap.exists() ? vaultSnap.data().createdAt : null;
                await setDoc(vaultRef, {
                  tagCode: 'RT-482-9XK',
                  ownerId: user.uid,
                  ciphertext: String(patchData.vault.ciphertext).slice(0, 1024),
                  createdAt: existingVaultCreatedAt || serverTimestamp(),
                  updatedAt: serverTimestamp(),
                });
              }
            }
          }

          // Hydrate persisted Firestore messages into server state so message history survives cold starts
          const msgQuery = query(
            collection(db, 'tags', 'RT-482-9XK', 'messages'),
            where('ownerId', '==', user.uid)
          );
          const msgSnap = await getDocs(msgQuery);
          if (!msgSnap.empty) {
            const restoredMessages = msgSnap.docs.map((docSnap) => {
              const md = docSnap.data();
              const tsMillis =
                md.createdAt && typeof md.createdAt.toMillis === 'function'
                  ? md.createdAt.toMillis()
                  : Date.now();
              return {
                id: docSnap.id,
                tagId: 'tag-default',
                sessionId: typeof md.sessionId === 'string' ? md.sessionId : undefined,
                sender: md.sender === 'owner' ? 'owner' : 'scanner',
                senderAlias: md.senderAlias || 'Passerby',
                text: md.text || '',
                createdAt: tsMillis,
              };
            });
            await ownerFetch('/api/owner/tags/tag-default/hydrate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ messages: restoredMessages }),
            });
          }

          fetchState();
        } catch (err) {
          console.warn('Firestore tag lookup skipped:', err);
        }
      }
    });
    return () => unsubscribe();
  }, [fetchState, isPublicScanRoute, ensureOwnerSession, ownerFetch]);

  useEffect(() => {
    if (ownerPage === 'messages' && messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [ownerPage, messages.length]);

  // Recurring interval effect to keep relative timestamps and timer countdowns fresh without reloading history
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      setNowMs(Date.now());
    }, RELATIVE_TIMESTAMP_REFRESH_MS);

    return () => window.clearInterval(intervalId);
  }, []);

  const syncTagToFirestore = async (updatedTag: TagConfig) => {
    if (!currentUser) return;
    const tagPath = `tags/${updatedTag.code}`;
    try {
      const ref = doc(db, 'tags', updatedTag.code);
      let cachedCreatedAt = tagCreatedAtCacheRef.current[updatedTag.code];

      if (!cachedCreatedAt) {
        const snap = await getDoc(ref);
        if (snap.exists()) {
          if (snap.data().ownerId !== currentUser.uid) return;
          cachedCreatedAt = snap.data().createdAt;
          tagCreatedAtCacheRef.current[updatedTag.code] = cachedCreatedAt || null;
        }
      }

      await setDoc(
        ref,
        {
          code: updatedTag.code,
          ownerId: currentUser.uid,
          vehicleLabel: updatedTag.vehicleLabel || '',
          plateNumber: updatedTag.plateHint || '',
          contactEnabled: updatedTag.contactEnabled,
          autoExpireAt: updatedTag.autoExpireAt ?? 0,
          statusNote: updatedTag.statusNote || '',
          createdAt: cachedCreatedAt || serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: false }
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, tagPath);
    }
  };

  const syncMessageToFirestore = async (
    tagCode: string,
    msg: RelayMessage,
    ownerUid?: string | null
  ) => {
    const cleanMsgId = msg.id.replace(/[^a-zA-Z0-9_-]/g, '');
    const msgPath = `tags/${tagCode}/messages/${cleanMsgId}`;
    try {
      let resolvedOwnerId = ownerUid || currentUser?.uid || null;
      if (!resolvedOwnerId) {
        const tagSnap = await getDoc(doc(db, 'tags', tagCode));
        if (!tagSnap.exists()) return;
        resolvedOwnerId = tagSnap.data().ownerId;
      }
      if (!resolvedOwnerId) return;

      const payloadDoc: Record<string, unknown> = {
        tagCode,
        ownerId: resolvedOwnerId,
        sender: msg.sender,
        senderAlias: msg.senderAlias.slice(0, 40),
        text: msg.text.slice(0, 500),
        createdAt: serverTimestamp(),
      };
      if (msg.sessionId && /^[a-zA-Z0-9_-]{8,64}$/.test(msg.sessionId)) {
        payloadDoc.sessionId = msg.sessionId;
      }

      await setDoc(doc(db, 'tags', tagCode, 'messages', cleanMsgId), payloadDoc);
    } catch (err) {
      if (currentUser) {
        handleFirestoreError(err, OperationType.CREATE, msgPath);
      }
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      if (cred.user && tag) {
        await syncTagToFirestore(tag);
      }
    } catch (err) {
      const formatted = formatAuthErrorForUi(err);
      if (formatted) {
        setAuthError(formatted);
      }
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
  };

  const handleToggle = async (
    nextState: boolean,
    durationMinutes?: number | null
  ) => {
    if (!tag) return;
    const res = await ownerFetch(`/api/owner/tags/${tag.id}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactEnabled: nextState, durationMinutes }),
    });
    if (res.ok) {
      const data = await res.json();
      setTag(data.tag);
      setNowMs(data.serverTime || Date.now());
      if (currentUser) {
        await syncTagToFirestore(data.tag);
      }
    }
  };

  const handleSaveVehicleRegistration = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tag) return;
    setVehicleSaving(true);
    try {
      const cleanVehicle = vehicleLabelInput.trim();
      const cleanPlate = plateNumberInput.trim().toUpperCase();
      const cleanNote = statusNoteInput.trim();

      const res = await ownerFetch(`/api/owner/tags/${tag.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleLabel: cleanVehicle,
          plateHint: cleanPlate,
          statusNote: cleanNote,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setTag(data.tag);
        setNowMs(data.serverTime || Date.now());
        setVehicleLabelInput(data.tag.vehicleLabel);
        setPlateNumberInput(data.tag.plateHint);
        setStatusNoteInput(data.tag.statusNote);
        if (currentUser) {
          await syncTagToFirestore(data.tag);
        }
        setVehicleSavedToast(true);
        setTimeout(() => setVehicleSavedToast(false), 2500);
      }
    } finally {
      setVehicleSaving(false);
    }
  };

  const persistTelegramSettings = async (
    nextEnabled: boolean,
    nextBotToken: string,
    nextChatId: string,
    showSavedFeedback: boolean
  ) => {
    if (!tag) return;
    setTelegramFeedback(null);
    const res = await ownerFetch(`/api/owner/tags/${tag.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegramEnabled: nextEnabled,
        telegramBotToken: nextBotToken,
        telegramChatId: nextChatId,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setTelegramFeedback({
        type: 'error',
        text: data.error || 'Could not save Telegram settings.',
      });
      return;
    }
    setTag(data.tag);
    setTelegramEnabled(Boolean(data.tag.telegramEnabled));
    setTelegramBotToken(data.tag.telegramBotToken);
    setNowMs(data.serverTime || Date.now());
    if (nextBotToken && nextBotToken !== MASKED_BOT_TOKEN) {
      privateBotTokenCacheRef.current = nextBotToken.trim();
    } else if (!nextBotToken) {
      privateBotTokenCacheRef.current = '';
    }
    if (currentUser) {
      const privatePath = `users/${currentUser.uid}/private/config`;
      try {
        const ref = doc(db, 'users', currentUser.uid, 'private', 'config');
        if (!privateConfigCreatedAtRef.current) {
          const snap = await getDoc(ref);
          if (snap.exists() && snap.data().createdAt) {
            privateConfigCreatedAtRef.current = snap.data().createdAt;
            if (!privateBotTokenCacheRef.current && snap.data().telegramBotToken) {
              privateBotTokenCacheRef.current = snap.data().telegramBotToken;
            }
          }
        }
        await setDoc(ref, {
          ownerId: currentUser.uid,
          email: currentUser.email || '',
          telegramEnabled: nextEnabled,
          telegramBotToken: privateBotTokenCacheRef.current.slice(0, 120),
          telegramChatId: nextChatId.trim().slice(0, 60),
          createdAt: privateConfigCreatedAtRef.current || serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        // Ensure parent tag exists in Firestore and persist AES-256-GCM encrypted server vault for cold-start recovery
        if (data.vault?.vaultId && data.vault?.ciphertext) {
          await syncTagToFirestore(data.tag);
          const vaultRef = doc(db, 'tags', data.tag.code, 'vault', data.vault.vaultId);
          const vaultSnap = await getDoc(vaultRef);
          const existingVaultCreatedAt = vaultSnap.exists() ? vaultSnap.data().createdAt : null;
          await setDoc(vaultRef, {
            tagCode: data.tag.code,
            ownerId: currentUser.uid,
            ciphertext: String(data.vault.ciphertext).slice(0, 1024),
            createdAt: existingVaultCreatedAt || serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, privatePath);
      }
    }
    if (showSavedFeedback) {
      setSettingsSaved(true);
      setTelegramFeedback({
        type: 'success',
        text: nextEnabled
          ? 'Telegram forwarding saved. Tap "Send Test Ping" below to confirm alerts arrive on your phone.'
          : 'Telegram settings saved.',
      });
      setTimeout(() => setSettingsSaved(false), 2500);
    }
  };

  const handleTelegramToggleSwitch = async () => {
    const nextEnabled = !telegramEnabled;
    setTelegramEnabled(nextEnabled);
    await persistTelegramSettings(
      nextEnabled,
      telegramBotToken,
      telegramChatId,
      false
    );
  };

  const handleSaveTelegramSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    await persistTelegramSettings(
      telegramEnabled,
      telegramBotToken,
      telegramChatId,
      true
    );
  };

  const handleTestTelegram = async () => {
    if (!tag || telegramTesting) return;
    setTelegramTesting(true);
    setTelegramFeedback(null);
    try {
      const res = await ownerFetch(`/api/owner/tags/${tag.id}/test-telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramBotToken,
          telegramChatId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTelegramFeedback({
          type: 'error',
          text: data.error || 'Telegram verification failed.',
        });
        return;
      }

      setTag(data.tag);
      setTelegramEnabled(true);
      setTelegramBotToken(data.tag.telegramBotToken);
      setNowMs(data.serverTime || Date.now());
      if (telegramBotToken && telegramBotToken !== MASKED_BOT_TOKEN) {
        privateBotTokenCacheRef.current = telegramBotToken.trim();
      }

      if (currentUser) {
        const privatePath = `users/${currentUser.uid}/private/config`;
        try {
          const ref = doc(db, 'users', currentUser.uid, 'private', 'config');
          if (!privateConfigCreatedAtRef.current) {
            const snap = await getDoc(ref);
            if (snap.exists() && snap.data().createdAt) {
              privateConfigCreatedAtRef.current = snap.data().createdAt;
            }
          }
          await setDoc(ref, {
            ownerId: currentUser.uid,
            email: currentUser.email || '',
            telegramEnabled: true,
            telegramBotToken: privateBotTokenCacheRef.current.slice(0, 120),
            telegramChatId: telegramChatId.trim().slice(0, 60),
            createdAt: privateConfigCreatedAtRef.current || serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          if (data.vault?.vaultId && data.vault?.ciphertext) {
            await syncTagToFirestore(data.tag);
            const vaultRef = doc(db, 'tags', data.tag.code, 'vault', data.vault.vaultId);
            const vaultSnap = await getDoc(vaultRef);
            const existingVaultCreatedAt = vaultSnap.exists() ? vaultSnap.data().createdAt : null;
            await setDoc(vaultRef, {
              tagCode: data.tag.code,
              ownerId: currentUser.uid,
              ciphertext: String(data.vault.ciphertext).slice(0, 1024),
              createdAt: existingVaultCreatedAt || serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, privatePath);
        }
      }

      setTelegramFeedback({
        type: 'success',
        text: 'Verified! A test alert was delivered to your Telegram phone app.',
      });
    } finally {
      setTelegramTesting(false);
    }
  };

  const handleOwnerReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tag || !replyText.trim()) return;
    setReplySending(true);
    const res = await ownerFetch(`/api/owner/tags/${tag.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: replyText }),
    });
    setReplySending(false);
    if (res.ok) {
      const data = await res.json();
      setReplyText('');
      if (currentUser && data.message) {
        await syncMessageToFirestore(tag.code, data.message, currentUser.uid);
      }
      fetchState();
    }
  };

  const handleClearMessages = async () => {
    if (!tag) return;
    await ownerFetch(`/api/owner/tags/${tag.id}/messages`, { method: 'DELETE' });
    if (currentUser) {
      const msgColPath = `tags/${tag.code}/messages`;
      try {
        const msgQuery = query(
          collection(db, 'tags', tag.code, 'messages'),
          where('ownerId', '==', currentUser.uid)
        );
        const snap = await getDocs(msgQuery);
        await Promise.all(snap.docs.map((docSnap) => deleteDoc(docSnap.ref)));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, msgColPath);
      }
    }
    fetchState();
  };

  const handlePublicSendMessage = async (payload: {
    text: string;
    category?: string;
    senderAlias?: string;
  }) => {
    const targetCode = (scannedCodeParam || publicScanTag?.code || tag?.code || '').trim();
    if (!targetCode) return { ok: false, error: 'Tag not loaded' };
    try {
      const res = await fetch(
        `/api/public/tags/${encodeURIComponent(targetCode)}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Scanner-Session': scannerSessionIdRef.current,
          },
          body: JSON.stringify({
            ...payload,
            sessionId: scannerSessionIdRef.current,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        await fetchState();
        return { ok: false, error: data.error || 'Message rejected' };
      }
      if (data.message) {
        await syncMessageToFirestore(targetCode.toUpperCase(), data.message);
      }
      await fetchState();
      return { ok: true, telegramForwarded: data.telegramForwarded };
    } catch {
      return { ok: false, error: 'Network error' };
    }
  };

  // ============================================================================
  // PUBLIC SCANNER VIEW ONLY (Triggered strictly when scanning QR: /?scan=...)
  // ============================================================================
  if (isPublicScanRoute) {
    if (loading) {
      return (
        <div className="h-dvh flex items-center justify-center bg-[#F4F5F7] dark:bg-[#090B0E] text-zinc-500 dark:text-zinc-400 text-sm font-medium">
          Loading RelayTag...
        </div>
      );
    }

    const displayCode = publicScanTag?.code || scannedCodeParam || '';

    return (
      <div className="min-h-dvh bg-[#F4F5F7] dark:bg-[#090B0E] text-zinc-900 dark:text-zinc-100 flex flex-col justify-between sm:justify-center py-4 sm:py-8 px-3.5 sm:px-4">
        <div className="max-w-md w-full mx-auto my-auto space-y-3.5 sm:space-y-4">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-zinc-900 dark:bg-emerald-500 text-white dark:text-emerald-950 flex items-center justify-center font-display font-bold text-xs shrink-0">
                RT
              </div>
              <span className="font-display font-bold text-sm tracking-tight truncate">
                RelayTag Windshield Relay
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {displayCode && (
                <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                  {displayCode}
                </span>
              )}
              <button
                type="button"
                onClick={toggleTheme}
                aria-label="Toggle dark or light theme"
                className="spring-transition min-w-[40px] min-h-[40px] flex items-center justify-center rounded-xl border border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-[#11141B] text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
              >
                {isDark ? (
                  <Sun className="w-4 h-4 text-amber-400" />
                ) : (
                  <Moon className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          <PublicScannerPanel
            publicTag={publicScanTag}
            messages={messages}
            notFoundError={publicNotFoundError}
            onSendMessage={handlePublicSendMessage}
          />

          <div className="flex items-center justify-center pt-1">
            <a
              href="/"
              className="text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white underline underline-offset-4 py-2 px-3"
            >
              Vehicle Owner? Open RelayTag Console
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (loading || !tag) {
    return (
      <div className="h-dvh flex items-center justify-center bg-[#F4F5F7] dark:bg-[#090B0E] text-zinc-500 dark:text-zinc-400 text-sm font-medium">
        Loading RelayTag...
      </div>
    );
  }

  const publicTagView: PublicTagView = toPublicTagView(tag, nowMs);
  const isContactActive = publicTagView.contactEnabled;
  const remainingMinutes = computeRemainingMinutes(tag.autoExpireAt, nowMs);
  const scanUrl = `${window.location.origin}/?scan=${encodeURIComponent(tag.code)}`;
  const isTagSetup = hasTagSetupData(tag);

  const readiness = computeSetupReadiness({
    isSignedIn: Boolean(currentUser),
    userEmail: currentUser?.email,
    tag,
    nowMs,
    autoExpireAt: tag.autoExpireAt,
  });

  const handleFocusPlateInput = () => {
    setOwnerPage('control');
    setTimeout(() => {
      const el = document.getElementById('plate-number-input');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
      }
    }, 60);
  };

  const handleSimulateScanAlert = async () => {
    if (!tag || simulatingScan) return;
    setSimulatingScan(true);
    setTelegramFeedback(null);
    try {
      if (!isContactActive) {
        await handleToggle(true, null);
      }
      const res = await handlePublicSendMessage({
        text: 'Simulated test scan: Checking in-app relay & Telegram phone alert.',
        category: 'test',
        senderAlias: 'Test Scanner',
      });
      if (!res.ok) {
        setTelegramFeedback({
          type: 'error',
          text: res.error || 'Simulated scan could not be delivered.',
        });
        return;
      }
      setTelegramFeedback({
        type: 'success',
        text: res.telegramForwarded
          ? 'Test scan delivered! Reply directly in Telegram or tap "Simulate Telegram Reply" below.'
          : 'Test scan delivered to your in-app Messages tab! Configure Telegram to also receive phone alerts.',
      });
    } finally {
      setSimulatingScan(false);
    }
  };

  const handleSimulateTelegramReply = async () => {
    if (!tag || simulatingTelegramReply) return;
    setSimulatingTelegramReply(true);
    setTelegramFeedback(null);
    try {
      const res = await ownerFetch(`/api/owner/tags/${tag.id}/simulate-telegram-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Heading down in 2 minutes to move the car! (Replied directly from Telegram)',
          sessionId: scannerSessionIdRef.current,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTelegramFeedback({
          type: 'error',
          text: data.error || 'Could not simulate Telegram reply.',
        });
        return;
      }
      if (currentUser && data.message) {
        await syncMessageToFirestore(tag.code, data.message, currentUser.uid);
      }
      await fetchState();
      setTelegramFeedback({
        type: 'success',
        text: 'Direct Telegram reply routed! It is now visible in your Messages tab and on the scanner chatbox.',
      });
    } finally {
      setSimulatingTelegramReply(false);
    }
  };

  const handleCopyScanUrl = async () => {
    try {
      if (
        typeof navigator !== 'undefined' &&
        typeof navigator.share === 'function' &&
        window.matchMedia('(max-width: 640px)').matches
      ) {
        await navigator.share({
          title: `RelayTag — ${tag.plateHint || tag.code}`,
          text: 'Scan or open this link to contact the vehicle driver anonymously:',
          url: scanUrl,
        });
        return;
      }
    } catch {
      // Fallback to clipboard copy if share sheet dismissed
    }
    navigator.clipboard?.writeText(scanUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const isTelegramActive =
    tag.telegramEnabled &&
    (tag.telegramBotTokenConfigured || Boolean(tag.telegramBotToken.trim())) &&
    Boolean(tag.telegramChatId.trim());

  // ============================================================================
  // OWNER CONSOLE SHELL — Compact Top Header + Responsive Viewport + Mobile Thumb Bar
  // ============================================================================
  return (
    <div className="h-dvh overflow-hidden bg-[#F4F5F7] dark:bg-[#090B0E] text-zinc-900 dark:text-zinc-100 flex flex-col">
      {/* Pinned Top Bar — 48px on mobile (combined with 56px bottom nav = 104px <= 12.3% of 844px mobile height) */}
      <header className="no-print shrink-0 z-20 border-b border-zinc-200/80 dark:border-white/[0.07] bg-white/90 dark:bg-[#0D1016]/90 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-12 sm:h-16 flex items-center justify-between gap-4">
          {/* Zone 1: Brand wordmark */}
          <a
            href="/"
            className="font-display font-bold text-base sm:text-lg tracking-tight text-zinc-900 dark:text-zinc-100 whitespace-nowrap shrink-0"
          >
            RelayTag
          </a>

          {/* Zone 2: Desktop View Switcher (On mobile, moved to ergonomic bottom thumb bar) */}
          <div className="hidden sm:inline-flex rounded-xl bg-zinc-100 dark:bg-[#131720] p-1 border border-zinc-200/70 dark:border-white/[0.08]">
            <button
              type="button"
              onClick={() => setOwnerPage('control')}
              className={`spring-transition inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0 ${
                ownerPage === 'control'
                  ? 'bg-white dark:bg-[#1F2533] text-zinc-900 dark:text-white shadow-xs'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>Toggle</span>
            </button>
            <button
              type="button"
              onClick={() => setOwnerPage('messages')}
              className={`spring-transition inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0 ${
                ownerPage === 'messages'
                  ? 'bg-white dark:bg-[#1F2533] text-zinc-900 dark:text-white shadow-xs'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              <span>Messages</span>
              {messages.length > 0 && (
                <span
                  className={`font-mono tabular-nums px-1.5 py-0.2 rounded-md text-[11px] ${
                    ownerPage === 'messages'
                      ? 'bg-emerald-600 dark:bg-emerald-500 text-white dark:text-emerald-950'
                      : 'bg-zinc-200/80 dark:bg-[#232938] text-zinc-700 dark:text-zinc-300'
                  }`}
                >
                  {messages.length}
                </span>
              )}
            </button>
          </div>

          {/* Zone 3: Actions */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowQrModal(true)}
              className="hidden sm:inline-flex spring-transition items-center gap-1.5 px-3.5 py-2 rounded-xl border border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-[#131720] hover:bg-zinc-50 dark:hover:bg-[#1B202C] text-xs font-semibold text-zinc-800 dark:text-zinc-200 cursor-pointer shadow-2xs active:scale-95 whitespace-nowrap shrink-0"
              title="View and print windshield QR card"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print QR</span>
            </button>

            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle dark or light theme"
              title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              className="spring-transition min-w-[38px] min-h-[38px] sm:min-w-[40px] sm:min-h-[40px] flex items-center justify-center rounded-xl border border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-[#131720] hover:bg-zinc-50 dark:hover:bg-[#1B202C] text-zinc-700 dark:text-zinc-200 cursor-pointer shadow-2xs active:scale-95 shrink-0"
            >
              {isDark ? (
                <Sun className="w-4 h-4 text-amber-400" />
              ) : (
                <Moon className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      {ownerPage === 'control' ? (
        <main className="no-print flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3.5 sm:px-6 py-3 sm:py-6 flex flex-col">
          <div
            key="control-view"
            className="animate-view-enter max-w-5xl w-full mx-auto my-auto grid grid-cols-1 lg:grid-cols-12 gap-3 sm:gap-5 items-stretch"
          >
            {/* Left Column (7 cols on desktop): Master Switch Card + Telegram Forwarding Row */}
            <div className="lg:col-span-7 flex flex-col justify-between gap-3 sm:gap-4">
              {/* Primary Master Switch Card */}
              <section
                className={`spring-transition rounded-3xl p-4 sm:p-6 border shadow-sm flex-1 flex flex-col justify-between ${
                  isContactActive
                    ? 'bg-emerald-50/90 dark:bg-[#0B211A] border-emerald-300/90 dark:border-emerald-500/35 text-emerald-950 dark:text-white shadow-emerald-900/5 dark:shadow-black/25'
                    : 'bg-white dark:bg-[#11141B] border-zinc-200/90 dark:border-white/[0.08] text-zinc-900 dark:text-zinc-100 shadow-black/5 dark:shadow-black/30'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1 min-w-0">
                      <div
                        className={`flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap ${
                          isContactActive
                            ? 'text-emerald-800 dark:text-emerald-300'
                            : 'text-zinc-500 dark:text-zinc-400'
                        }`}
                      >
                        <span className="font-mono">
                          {isContactActive
                            ? 'Contact ON · Live Relay'
                            : !isTagSetup
                            ? 'Contact OFF · Setup Pending'
                            : 'Contact OFF · Standby'}
                        </span>
                      </div>

                      <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight">
                        {isContactActive ? 'Driver Reachable' : 'Do Not Disturb'}
                      </h1>

                      <div className="flex flex-wrap items-center gap-2 pt-0.5 text-xs">
                        <span
                          className={`inline-flex items-center gap-1.5 font-mono font-bold tracking-wider ${
                            isContactActive
                              ? 'text-emerald-900 dark:text-emerald-200'
                              : 'text-zinc-800 dark:text-zinc-200'
                          }`}
                        >
                          <Car className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                          <span>{tag.plateHint || tag.code}</span>
                        </span>
                        <span aria-hidden="true" className="opacity-40">
                          ·
                        </span>
                        {tag.vehicleLabel ? (
                          <span
                            className={`font-medium truncate ${
                              isContactActive
                                ? 'text-emerald-800/85 dark:text-emerald-200/85'
                                : 'text-zinc-500 dark:text-zinc-400'
                            }`}
                          >
                            {tag.vehicleLabel}
                          </span>
                        ) : (
                          <span className="text-zinc-400 dark:text-zinc-500">
                            Unregistered vehicle
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Tactile Master Toggle Button (>= 64x64px touch target) */}
                    <button
                      type="button"
                      onClick={() => handleToggle(!isContactActive, null)}
                      aria-label={
                        isContactActive ? 'Turn Contact Off' : 'Turn Contact On'
                      }
                      className={`spring-transition shrink-0 w-16 h-16 sm:w-18 sm:h-18 rounded-2xl flex flex-col items-center justify-center gap-1 font-display font-bold text-xs cursor-pointer active:scale-95 ${
                        isContactActive
                          ? 'bg-emerald-600 dark:bg-emerald-400 text-white dark:text-emerald-950 hover:bg-emerald-700 dark:hover:bg-emerald-300 shadow-md shadow-emerald-600/20 dark:shadow-none'
                          : 'bg-zinc-100 dark:bg-[#1A202C] text-zinc-700 dark:text-zinc-200 border border-zinc-300/80 dark:border-white/[0.12] hover:bg-emerald-600 dark:hover:bg-emerald-500 hover:text-white dark:hover:text-emerald-950 hover:border-transparent shadow-xs'
                      }`}
                    >
                      <Power className="w-5 h-5 stroke-[2.4]" />
                      <span>{isContactActive ? 'ON' : 'OFF'}</span>
                    </button>
                  </div>

                  <p
                    className={`text-xs sm:text-sm mt-2 leading-relaxed ${
                      isContactActive
                        ? 'text-emerald-900/80 dark:text-emerald-100/90'
                        : 'text-zinc-500 dark:text-zinc-400'
                    }`}
                  >
                    {isContactActive
                      ? 'Anyone scanning your windshield QR can send you an anonymous alert.'
                      : !isTagSetup
                      ? 'Relay is off by default until your vehicle is set up. Save your plate or tap the power switch when parked.'
                      : 'Incoming scans are blocked. Nobody can message you right now.'}
                  </p>
                </div>

                {/* Quick Auto-Off Duration Bar — Mobile ergonomic 5-column segmented row */}
                <div
                  className={`mt-3.5 pt-3 border-t flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
                    isContactActive
                      ? 'border-emerald-200/90 dark:border-emerald-500/25'
                      : 'border-zinc-100 dark:border-white/[0.07]'
                  }`}
                >
                  <div
                    className={`flex items-center gap-1.5 text-xs font-medium ${
                      isContactActive
                        ? 'text-emerald-800 dark:text-emerald-200'
                        : 'text-zinc-500 dark:text-zinc-400'
                    }`}
                  >
                    <Clock className="w-3.5 h-3.5 shrink-0" />
                    <span className="font-mono tabular-nums">
                      {remainingMinutes !== null && isContactActive
                        ? `Auto-off in ${remainingMinutes}m`
                        : 'Quick timer:'}
                    </span>
                  </div>
                  <div
                    className={`grid grid-cols-5 sm:inline-flex items-center gap-1 p-1 rounded-xl border ${
                      isContactActive
                        ? 'bg-emerald-100/70 dark:bg-[#071611] border-emerald-200/80 dark:border-emerald-500/25'
                        : 'bg-zinc-100 dark:bg-[#0B0E14] border-zinc-200/70 dark:border-white/[0.07]'
                    }`}
                  >
                    {QUICK_TIMER_PRESETS.map((preset) => {
                      const activePreset =
                        preset.enable === false
                          ? !isContactActive
                          : isContactActive &&
                            (preset.mins === null
                              ? tag.autoExpireAt === null || tag.autoExpireAt === 0
                              : remainingMinutes !== null &&
                                (preset.mins === 30
                                  ? remainingMinutes > 0 && remainingMinutes <= 30
                                  : preset.mins === 60
                                  ? remainingMinutes > 30 && remainingMinutes <= 60
                                  : remainingMinutes > 60 && remainingMinutes <= 180));
                      return (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => handleToggle(preset.enable, preset.mins)}
                          className={`spring-transition min-h-[38px] sm:min-h-[32px] px-2.5 sm:px-3 py-1.5 sm:py-1 rounded-lg text-xs font-semibold cursor-pointer active:scale-95 whitespace-nowrap shrink-0 text-center ${
                            activePreset
                              ? isContactActive
                                ? 'bg-emerald-700 dark:bg-emerald-400 text-white dark:text-emerald-950 shadow-2xs'
                                : 'bg-white dark:bg-[#1E2433] text-zinc-900 dark:text-white shadow-2xs'
                              : isContactActive
                              ? 'text-emerald-900/80 dark:text-emerald-200/80 hover:text-emerald-950 dark:hover:text-white hover:bg-white/50 dark:hover:bg-emerald-900/50'
                              : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                          }`}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section>

              {/* Telegram & Setup Layer Trigger Row */}
              <section className="rounded-3xl border border-zinc-200/90 dark:border-white/[0.08] bg-white dark:bg-[#11141B] shadow-xs overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowSetupModal(true)}
                  className="w-full min-h-[56px] px-4 sm:px-6 py-3.5 flex items-center justify-between text-left hover:bg-zinc-50/80 dark:hover:bg-[#161B24] cursor-pointer spring-transition"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-zinc-100 dark:bg-[#191E2A] border border-zinc-200/70 dark:border-white/[0.07] flex items-center justify-center shrink-0">
                      <Bell className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-display text-sm font-bold text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
                          Telegram Alerts
                        </span>
                        <span aria-hidden="true" className="text-zinc-300 dark:text-zinc-600">
                          ·
                        </span>
                        <span
                          className={`text-xs font-semibold whitespace-nowrap ${
                            isTelegramActive
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          {isTelegramActive ? 'Active' : 'Setup Required'}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                        2-way phone notifications & simulated scan check
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 shrink-0 pl-2">
                    <span className="font-mono tabular-nums">
                      {readiness.completedCount}/{readiness.totalCount}
                    </span>
                    <ChevronRight className="w-4 h-4 text-zinc-400" />
                  </div>
                </button>
              </section>
            </div>

            {/* Right Column (5 cols on desktop): Vehicle Plate & Account Registration Card */}
            <div className="lg:col-span-5 flex flex-col">
              <section className="rounded-3xl border border-zinc-200/90 dark:border-white/[0.08] bg-white dark:bg-[#11141B] shadow-xs overflow-hidden p-4 sm:p-6 space-y-3 flex-1 flex flex-col justify-between">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-zinc-100 dark:bg-[#191E2A] border border-zinc-200/70 dark:border-white/[0.07] text-zinc-700 dark:text-zinc-200 flex items-center justify-center shrink-0">
                      <Car className="w-4 h-4" />
                    </div>
                    <div>
                      <h2 className="font-display text-sm font-bold text-zinc-900 dark:text-zinc-100">
                        Vehicle & License Plate
                      </h2>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        Shown on your windshield QR tag so callers confirm the right car
                      </p>
                    </div>
                  </div>
                </div>

                <form onSubmit={handleSaveVehicleRegistration} className="space-y-2.5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-2.5">
                    <div>
                      <label
                        htmlFor="plate-number-input"
                        className="block text-xs font-semibold text-zinc-600 dark:text-zinc-400 mb-1"
                      >
                        License Plate Number
                      </label>
                      <input
                        id="plate-number-input"
                        type="text"
                        maxLength={20}
                        value={plateNumberInput}
                        onChange={(e) => setPlateNumberInput(e.target.value.toUpperCase())}
                        placeholder="e.g. SBA 8492M"
                        className="w-full rounded-xl border border-zinc-200 dark:border-white/[0.09] bg-zinc-50 dark:bg-[#0B0E14] px-3.5 py-2 sm:py-2.5 text-base sm:text-xs font-mono font-semibold uppercase tracking-wider text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-[#121620] focus:border-zinc-900 dark:focus:border-emerald-500/60 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="vehicle-label-input"
                        className="block text-xs font-semibold text-zinc-600 dark:text-zinc-400 mb-1"
                      >
                        Vehicle Description
                      </label>
                      <input
                        id="vehicle-label-input"
                        type="text"
                        maxLength={60}
                        value={vehicleLabelInput}
                        onChange={(e) => setVehicleLabelInput(e.target.value)}
                        placeholder="e.g. Slate Civic Hatchback"
                        className="w-full rounded-xl border border-zinc-200 dark:border-white/[0.09] bg-zinc-50 dark:bg-[#0B0E14] px-3.5 py-2 sm:py-2.5 text-base sm:text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-[#121620] focus:border-zinc-900 dark:focus:border-emerald-500/60 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="status-note-input"
                      className="block text-xs font-semibold text-zinc-600 dark:text-zinc-400 mb-1"
                    >
                      Windshield Note (Optional)
                    </label>
                    <input
                      id="status-note-input"
                      type="text"
                      maxLength={140}
                      value={statusNoteInput}
                      onChange={(e) => setStatusNoteInput(e.target.value)}
                      placeholder="Parked briefly near loading bay. Ping me if I need to move!"
                      className="w-full rounded-xl border border-zinc-200 dark:border-white/[0.09] bg-zinc-50 dark:bg-[#0B0E14] px-3.5 py-2 sm:py-2.5 text-base sm:text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-[#121620] focus:border-zinc-900 dark:focus:border-emerald-500/60 focus:outline-none"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
                    <button
                      type="submit"
                      disabled={vehicleSaving}
                      className="spring-transition min-h-[42px] sm:min-h-[38px] rounded-xl bg-zinc-900 dark:bg-emerald-500 hover:bg-zinc-800 dark:hover:bg-emerald-400 text-white dark:text-emerald-950 font-semibold text-xs px-4 py-2 cursor-pointer active:scale-95 disabled:opacity-50 whitespace-nowrap"
                    >
                      {vehicleSaving
                        ? 'Saving...'
                        : vehicleSavedToast
                        ? 'Vehicle Plate Saved ✓'
                        : 'Save Vehicle Details'}
                    </button>

                    {/* Account Sync Status / Sign-In */}
                    {!authLoading && (
                      <div className="flex items-center gap-2">
                        {currentUser ? (
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                              <UserCheck className="w-3.5 h-3.5 shrink-0" />
                              <span className="truncate max-w-[130px]">
                                {currentUser.email || 'Cloud Synced'}
                              </span>
                            </span>
                            <button
                              type="button"
                              onClick={handleSignOut}
                              aria-label="Sign out"
                              title="Sign out"
                              className="min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 sm:p-2 flex items-center justify-center rounded-xl border border-zinc-200 dark:border-white/[0.09] bg-zinc-50 dark:bg-[#181C26] text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
                            >
                              <LogOut className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={handleGoogleSignIn}
                            className="spring-transition min-h-[44px] sm:min-h-[38px] inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 dark:border-white/[0.1] bg-zinc-50 dark:bg-[#181C26] hover:bg-zinc-100 dark:hover:bg-[#222836] px-3.5 py-2.5 text-xs font-semibold text-zinc-700 dark:text-zinc-200 cursor-pointer whitespace-nowrap"
                          >
                            <LogIn className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                            <span>Sync Account</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {authError && (
                    <p className="text-[11px] text-red-600 dark:text-red-400 pt-1">
                      {authError}
                    </p>
                  )}
                </form>
              </section>
            </div>
          </div>
        </main>
      ) : (
        /* ============================================================================
         * ANONYMOUS MESSAGES PAGE — Locked Shell; Non-Scrollable When Empty
         * ============================================================================ */
        <main className="no-print flex-1 min-h-0 max-w-4xl w-full mx-auto px-3.5 sm:px-6 py-3 sm:py-5 flex flex-col">
          <section
            key="messages-view"
            className="animate-view-enter flex-1 min-h-0 rounded-3xl border border-zinc-200/90 dark:border-white/[0.08] bg-white dark:bg-[#11141B] shadow-xs flex flex-col overflow-hidden"
          >
            {/* Pinned Thread Subheader inside Card */}
            <div className="shrink-0 px-4 sm:px-6 py-3.5 sm:py-4 border-b border-zinc-100 dark:border-white/[0.07] flex items-center justify-between gap-3 bg-white dark:bg-[#11141B]">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="font-display text-base sm:text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
                    Anonymous Messages
                  </h1>
                  {tag.plateHint && (
                    <span className="font-mono text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                      · {tag.plateHint}
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">
                  Two-way relay for {tag.vehicleLabel || 'your vehicle'} · Phone numbers stay hidden
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <span
                  className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold whitespace-nowrap ${
                    isContactActive
                      ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/30'
                      : 'bg-zinc-100 dark:bg-[#191E2A] text-zinc-600 dark:text-zinc-300 border border-zinc-200/80 dark:border-white/[0.08]'
                  }`}
                >
                  {isContactActive ? 'Reachable' : 'Do Not Disturb'}
                </span>

                {messages.length > 0 && (
                  <button
                    type="button"
                    onClick={handleClearMessages}
                    className="spring-transition min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer whitespace-nowrap"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Clear</span>
                  </button>
                )}
              </div>
            </div>

            {!isContactActive && (
              <div className="shrink-0 px-4 sm:px-6 py-2.5 bg-zinc-50 dark:bg-[#161B25] border-b border-zinc-200/80 dark:border-white/[0.07] flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Lock className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400 shrink-0" />
                  <p className="text-xs text-zinc-600 dark:text-zinc-300 truncate">
                    <span className="font-semibold text-zinc-900 dark:text-zinc-100">Do Not Disturb is active:</span>{' '}
                    Incoming scans paused.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggle(true, null)}
                  className="spring-transition shrink-0 min-h-[36px] px-3 py-1.5 rounded-lg bg-zinc-900 dark:bg-emerald-500 hover:bg-zinc-800 dark:hover:bg-emerald-400 text-white dark:text-emerald-950 text-xs font-semibold cursor-pointer whitespace-nowrap"
                >
                  Turn Contact ON
                </button>
              </div>
            )}

            {/* Inner Message Section — Strictly non-scrollable when empty; scrollable with live relative timestamps when messages exist */}
            <MessageList
              messages={messages}
              isContactActive={isContactActive}
              simulatingScan={simulatingScan}
              onSimulateScanAlert={handleSimulateScanAlert}
              onOpenQrModal={() => setShowQrModal(true)}
              messagesEndRef={messagesEndRef}
            />

            {/* Pinned Bottom Composer Bar */}
            <form
              onSubmit={handleOwnerReply}
              className="shrink-0 p-3 sm:px-6 sm:py-4 border-t border-zinc-100 dark:border-white/[0.07] bg-white dark:bg-[#11141B] flex gap-2"
            >
              <input
                type="text"
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                aria-label="Reply to scanner"
                placeholder="Reply here or inside Telegram..."
                className="flex-1 min-w-0 rounded-2xl border border-zinc-200 dark:border-white/[0.09] bg-zinc-50 dark:bg-[#0B0E14] px-3.5 sm:px-4 py-2.5 sm:py-3 text-base sm:text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-[#121620] focus:border-zinc-900 dark:focus:border-emerald-500/60 focus:outline-none"
              />
              <button
                type="submit"
                disabled={replySending || !replyText.trim()}
                className="spring-transition min-h-[44px] rounded-2xl bg-zinc-900 dark:bg-emerald-500 hover:bg-zinc-800 dark:hover:bg-emerald-400 disabled:bg-zinc-100 dark:disabled:bg-[#191E2A] disabled:text-zinc-400 dark:disabled:text-zinc-500 disabled:border disabled:border-zinc-200/70 dark:disabled:border-white/[0.06] text-white dark:text-emerald-950 px-4 sm:px-5 py-2.5 sm:py-3 text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 cursor-pointer shrink-0 active:scale-95 whitespace-nowrap"
              >
                <Send className="w-4 h-4" />
                <span>Reply</span>
              </button>
            </form>
          </section>
        </main>
      )}

      {/* ============================================================================
       * MOBILE THUMB-ZONE BOTTOM NAVIGATION BAR (sm:hidden, 56px height)
       * ============================================================================ */}
      <nav
        aria-label="Mobile primary navigation"
        className="no-print sm:hidden shrink-0 h-14 border-t border-zinc-200/80 dark:border-white/[0.08] bg-white/95 dark:bg-[#0D1016]/95 backdrop-blur-md grid grid-cols-4 items-center px-1.5 z-20"
      >
        <button
          type="button"
          onClick={() => {
            setShowSetupModal(false);
            setShowQrModal(false);
            setOwnerPage('control');
          }}
          className={`spring-transition min-h-[48px] flex flex-col items-center justify-center gap-0.5 rounded-xl cursor-pointer ${
            ownerPage === 'control' && !showSetupModal && !showQrModal
              ? 'text-zinc-900 dark:text-emerald-400 font-bold'
              : 'text-zinc-500 dark:text-zinc-400 font-medium'
          }`}
        >
          <Sliders className="w-4 h-4" />
          <span className="text-[11px] tracking-tight whitespace-nowrap">Toggle</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setShowSetupModal(false);
            setShowQrModal(false);
            setOwnerPage('messages');
          }}
          className={`spring-transition relative min-h-[48px] flex flex-col items-center justify-center gap-0.5 rounded-xl cursor-pointer ${
            ownerPage === 'messages' && !showSetupModal && !showQrModal
              ? 'text-zinc-900 dark:text-emerald-400 font-bold'
              : 'text-zinc-500 dark:text-zinc-400 font-medium'
          }`}
        >
          <div className="relative flex items-center justify-center">
            <MessageSquare className="w-4 h-4" />
            {messages.length > 0 && (
              <span className="ml-1 font-mono tabular-nums text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                ({messages.length})
              </span>
            )}
          </div>
          <span className="text-[11px] tracking-tight whitespace-nowrap">Messages</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setShowQrModal(false);
            setShowSetupModal(true);
          }}
          className={`spring-transition min-h-[48px] flex flex-col items-center justify-center gap-0.5 rounded-xl cursor-pointer ${
            showSetupModal
              ? 'text-zinc-900 dark:text-emerald-400 font-bold'
              : 'text-zinc-500 dark:text-zinc-400 font-medium'
          }`}
        >
          <div className="flex items-center gap-1">
            <Bell className="w-4 h-4" />
            <span className="font-mono tabular-nums text-[10px]">
              {readiness.completedCount}/{readiness.totalCount}
            </span>
          </div>
          <span className="text-[11px] tracking-tight whitespace-nowrap">Alerts</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setShowSetupModal(false);
            setShowQrModal(true);
          }}
          className={`spring-transition min-h-[48px] flex flex-col items-center justify-center gap-0.5 rounded-xl cursor-pointer ${
            showQrModal
              ? 'text-zinc-900 dark:text-emerald-400 font-bold'
              : 'text-zinc-500 dark:text-zinc-400 font-medium'
          }`}
        >
          <Printer className="w-4 h-4" />
          <span className="text-[11px] tracking-tight whitespace-nowrap">Print QR</span>
        </button>
      </nav>

      {/* ============================================================================
       * GUIDED TELEGRAM & SETUP MODAL LAYER (Mobile Bottom Sheet + Desktop Modal)
       * ============================================================================ */}
      <GuidedSetupPanel
        isOpen={showSetupModal}
        onClose={() => {
          setShowSetupModal(false);
          setTelegramFeedback(null);
          setAuthError(null);
        }}
        readiness={readiness}
        isSignedIn={Boolean(currentUser)}
        telegramEnabled={telegramEnabled}
        telegramBotToken={telegramBotToken}
        telegramChatId={telegramChatId}
        telegramBotTokenConfigured={Boolean(
          tag.telegramBotTokenConfigured || tag.telegramBotToken.trim()
        )}
        settingsSaved={settingsSaved}
        telegramTesting={telegramTesting}
        simulatingScan={simulatingScan}
        simulatingTelegramReply={simulatingTelegramReply}
        telegramFeedback={telegramFeedback}
        onChangeBotToken={setTelegramBotToken}
        onChangeChatId={setTelegramChatId}
        onToggleTelegramSwitch={handleTelegramToggleSwitch}
        onSaveTelegram={handleSaveTelegramSettings}
        onTestTelegram={handleTestTelegram}
        onGoogleSignIn={handleGoogleSignIn}
        onOpenQrModal={() => setShowQrModal(true)}
        onFocusPlateInput={handleFocusPlateInput}
        onSimulateScanAlert={handleSimulateScanAlert}
        onSimulateTelegramReply={handleSimulateTelegramReply}
      />

      {/* ============================================================================
       * PRINT QR MODAL — Mobile Bottom Sheet + Desktop Centered Modal
       * ============================================================================ */}
      {showQrModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="qr-modal-title"
          className="animate-backdrop-enter fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShowQrModal(false)}
        >
          <div
            className="animate-modal-enter bg-white dark:bg-[#11141B] rounded-t-3xl sm:rounded-3xl border-t sm:border border-zinc-200 dark:border-white/[0.09] max-w-sm w-full max-h-[90dvh] overflow-y-auto p-6 pb-7 sm:pb-6 shadow-2xl space-y-4 text-center relative"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Mobile Bottom Sheet Grab Handle */}
            <div
              aria-hidden="true"
              className="no-print w-10 h-1.5 rounded-full bg-zinc-300 dark:bg-zinc-700 mx-auto -mt-1 mb-2 sm:hidden"
            />

            <button
              type="button"
              onClick={() => setShowQrModal(false)}
              aria-label="Close QR Modal"
              className="no-print absolute top-4 right-4 min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 sm:w-8 sm:h-8 rounded-xl bg-zinc-100 dark:bg-[#191E29] hover:bg-zinc-200 dark:hover:bg-[#222836] border border-zinc-200/60 dark:border-white/[0.07] text-zinc-600 dark:text-zinc-300 flex items-center justify-center cursor-pointer spring-transition"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="space-y-1 pt-1 sm:pt-0">
              <p className="font-mono text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                Windshield Tag · {tag.code}
              </p>
              <h2
                id="qr-modal-title"
                className="font-display text-xl font-bold text-zinc-900 dark:text-zinc-100"
              >
                Scan to Contact Driver
              </h2>
              {(tag.plateHint || tag.vehicleLabel) && (
                <div className="flex items-center justify-center gap-1.5 pt-0.5 text-xs">
                  {tag.plateHint && (
                    <span className="font-mono font-bold text-zinc-800 dark:text-zinc-200">
                      {tag.plateHint}
                    </span>
                  )}
                  {tag.plateHint && tag.vehicleLabel && (
                    <span aria-hidden="true" className="text-zinc-400">
                      ·
                    </span>
                  )}
                  {tag.vehicleLabel && (
                    <span className="text-zinc-500 dark:text-zinc-400">
                      {tag.vehicleLabel}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-center py-1">
              <QrCodeVector url={scanUrl} size={184} />
            </div>

            <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs mx-auto leading-relaxed">
              Place this card inside your windshield. Scanners can only message you when your toggle is ON.
            </p>

            <div className="no-print flex flex-col gap-2 pt-1">
              <button
                type="button"
                onClick={() => window.print()}
                className="spring-transition w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-2xl bg-zinc-900 dark:bg-emerald-500 hover:bg-zinc-800 dark:hover:bg-emerald-400 text-white dark:text-emerald-950 text-xs font-semibold py-3 px-4 cursor-pointer active:scale-95 whitespace-nowrap"
              >
                <Printer className="w-4 h-4" />
                <span>Print Windshield Card</span>
              </button>

              <button
                type="button"
                onClick={handleCopyScanUrl}
                className="spring-transition w-full min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-2xl border border-zinc-200 dark:border-white/[0.09] bg-zinc-50 dark:bg-[#181C26] hover:bg-zinc-100 dark:hover:bg-[#202634] text-zinc-700 dark:text-zinc-200 text-xs font-semibold py-2.5 px-4 cursor-pointer whitespace-nowrap"
              >
                {copiedLink ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span>Scanner Link Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy Scanner Link</span>
                  </>
                )}
              </button>

              <a
                href={scanUrl}
                className="spring-transition w-full min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-2xl text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline py-2 px-4 whitespace-nowrap"
              >
                <span>Preview Public Scanner Page</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

