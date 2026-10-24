import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTHORIZED_OWNER_EMAIL } from '../src/utils/relayLogic.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER_BEARER = 'x'.repeat(40); // the stub accepts any 32+ char token as the owner's

let server: ChildProcess;
let baseUrl = '';
let workDir = '';
let modeFile = '';
let output = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not start:\n${output}`);
}

function api(pathname: string, init: RequestInit & { token?: string } = {}) {
  const { token, headers, ...rest } = init;
  return fetch(`${baseUrl}${pathname}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Owner-Token': token } : {}),
      ...(headers as Record<string, string> | undefined),
    },
  });
}

async function openOwnerSession(): Promise<string> {
  const res = await api('/api/owner/session', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OWNER_BEARER}`,
      'X-Firebase-Uid': 'uid-owner',
      'X-Firebase-Email': AUTHORIZED_OWNER_EMAIL,
    },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { token: string };
  assert.ok(body.token);
  return body.token;
}

before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaytag-it-'));
  fs.mkdirSync(path.join(workDir, 'dist'));
  fs.writeFileSync(path.join(workDir, 'dist', 'index.html'), '<!doctype html><div id="root"></div>');
  fs.writeFileSync(
    path.join(workDir, 'firebase-applet-config.json'),
    JSON.stringify({ projectId: 'ci-project', firestoreDatabaseId: 'ci-db', apiKey: 'ci-key', appId: 'ci-app' })
  );
  modeFile = path.join(workDir, 'firestore-mode');
  fs.writeFileSync(modeFile, 'missing');

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--import',
      new URL('./fixtures/stub-network.mjs', import.meta.url).href,
      path.join(repoRoot, 'server.ts'),
    ],
    {
      cwd: workDir,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        TRUST_PROXY_HOPS: '0',
        RELAYTAG_VAULT_SECRET: 'integration-test-secret-integration-test',
        TEMP: workDir,
        TMP: workDir,
        TMPDIR: workDir,
        STUB_FIRESTORE_MODE_FILE: modeFile,
        STUB_OWNER_EMAIL: AUTHORIZED_OWNER_EMAIL,
      },
    }
  );
  server.stdout?.on('data', (d) => (output += d));
  server.stderr?.on('data', (d) => (output += d));
  await waitUntilReady();
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited; // Windows will not delete a directory that is still some process's cwd
  }
  if (workDir) {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // temp dir cleanup is best-effort
    }
  }
});

describe('RelayTag server over HTTP', () => {
  it('serves the app shell but never HTML in place of a missing hashed asset', async () => {
    const shell = await fetch(`${baseUrl}/?scan=RT-482-9XK`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /id="root"/);

    const missing = await fetch(`${baseUrl}/assets/index-gone.js`);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(missing.headers.get('content-type') || '', /html/);
  });

  it('answers 404 for a tag Firestore does not have, but 503 (not 404) when it cannot be asked', async () => {
    fs.writeFileSync(modeFile, 'down');
    const outage = await api('/api/public/tags/RT-777-ABC');
    assert.equal(outage.status, 503);
    assert.ok(Number(outage.headers.get('retry-after')) > 0);

    // The outage must not have been remembered as "no such tag".
    fs.writeFileSync(modeFile, 'missing');
    const missing = await api('/api/public/tags/RT-777-ABC');
    assert.equal(missing.status, 404);
  });

  it('runs the owner-to-scanner conversation end to end and keeps scanners apart', async () => {
    const token = await openOwnerSession();

    const locked = await api('/api/owner/state');
    assert.equal(locked.status, 401);

    // Do Not Disturb by default: nothing gets through.
    const refused = await api('/api/public/tags/RT-482-9XK/messages', {
      method: 'POST',
      body: JSON.stringify({ text: 'hello?', sessionId: 'scan-aaaaaaaaaaaaaaaa' }),
    });
    assert.equal(refused.status, 403);

    const toggled = await api('/api/owner/tags/tag-default/toggle', {
      method: 'PATCH',
      token,
      body: JSON.stringify({ contactEnabled: true, durationMinutes: null }),
    });
    assert.equal(toggled.status, 200);

    const sessionA = 'scan-aaaaaaaaaaaaaaaa';
    const sessionB = 'scan-bbbbbbbbbbbbbbbb';
    const sent = await api('/api/public/tags/RT-482-9XK/messages', {
      method: 'POST',
      body: JSON.stringify({ text: 'Your lights are on', sessionId: sessionA }),
    });
    assert.equal(sent.status, 201);

    const reply = await api('/api/owner/tags/tag-default/reply', {
      method: 'POST',
      token,
      body: JSON.stringify({ text: 'Thanks, coming down', sessionId: sessionA }),
    });
    assert.equal(reply.status, 201);

    const threadA = (await (await api(`/api/public/tags/RT-482-9XK?sessionId=${sessionA}`)).json()) as {
      messages: { sender: string; text: string }[];
    };
    assert.deepEqual(
      threadA.messages.map((m) => [m.sender, m.text]),
      [
        ['scanner', 'Your lights are on'],
        ['owner', 'Thanks, coming down'],
      ]
    );

    const threadB = (await (await api(`/api/public/tags/RT-482-9XK?sessionId=${sessionB}`)).json()) as {
      messages: unknown[];
    };
    assert.deepEqual(threadB.messages, []);

    const state = (await (await api('/api/owner/state', { token })).json()) as { messages: unknown[] };
    assert.equal(state.messages.length, 2);

    const off = await api('/api/owner/tags/tag-default/toggle', {
      method: 'PATCH',
      token,
      body: JSON.stringify({ contactEnabled: false }),
    });
    assert.equal(off.status, 200);
    const blocked = await api('/api/public/tags/RT-482-9XK/messages', {
      method: 'POST',
      body: JSON.stringify({ text: 'still there?', sessionId: sessionA }),
    });
    assert.equal(blocked.status, 403);
  });
});
