// Preloaded into the server under test (node --import). Replaces the two Google endpoints the
// server calls, so the suite is deterministic and never touches a real project:
//  - Firestore REST: behaviour is read from the file named by STUB_FIRESTORE_MODE_FILE on every
//    call ('down' = unreachable, 'missing' = every document is 404).
//  - Identity Toolkit accounts:lookup: any token resolves to the authorized owner.
import fs from 'node:fs';

const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  if (url.startsWith('https://firestore.googleapis.com/')) {
    const mode = fs.readFileSync(process.env.STUB_FIRESTORE_MODE_FILE, 'utf8').trim();
    if (mode === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (url.startsWith('https://identitytoolkit.googleapis.com/')) {
    return new Response(
      JSON.stringify({
        users: [{ localId: 'uid-owner', email: process.env.STUB_OWNER_EMAIL, emailVerified: true }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  // Telegram: getUpdates serves the JSON array in STUB_TELEGRAM_UPDATES_FILE; every other call
  // (sendMessage, deleteWebhook) is appended to STUB_TELEGRAM_SENT_FILE so tests can see what was sent.
  if (url.startsWith('https://api.telegram.org/')) {
    const json = (body) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/getUpdates')) {
      const updates = JSON.parse(fs.readFileSync(process.env.STUB_TELEGRAM_UPDATES_FILE, 'utf8'));
      return json({ ok: true, result: updates });
    }
    fs.appendFileSync(process.env.STUB_TELEGRAM_SENT_FILE, `${init?.body ?? url}\n`);
    return json({ ok: true, result: {} });
  }

  return realFetch(input, init);
};
