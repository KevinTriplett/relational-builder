// Trust Tasks sign-in smoke client (spike Phase 5, step 0a). Runs a real
// auth/challenge → auth/authenticate against a deployed or locally served
// app-trust-tasks function, proves the member_token works on app-data's
// email-path auth_me, and checks the C-60 replay rule (identical resend → 204,
// no token). Built on the test producer so it signs exactly as the tests do.
//
//   deno run -A scripts/trust-signin-smoke.ts <function-url> <app_id> <app_key> <service-vid>
//       [--key <file>] [--app-data <url>]
//
// <function-url> is the function root, e.g. http://localhost:54321/functions/v1/app-trust-tasks
// --key <file>  reuse a device key across runs (created on first use). The file also
//               remembers the member id, so a second run asserts no new member (S-47).
// --app-data    app-data URL; defaults to <function-url> with app-trust-tasks → app-data.
// Exits non-zero on the first mismatch.

import { authenticateDoc, challengeDoc, mintDidKey, type TestIdentity } from '../tests/app-trust-tasks/producer.ts';

declare const Deno: {
  args: string[];
  exit(code: number): never;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string): Promise<void>;
};

interface KeyFile {
  seedHex: string;
  memberId?: string;
}

const positional: string[] = [];
let keyPath: string | undefined;
let appDataUrl: string | undefined;
for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  if (arg === '--key') keyPath = Deno.args[++i];
  else if (arg === '--app-data') appDataUrl = Deno.args[++i];
  else positional.push(arg);
}
if (positional.length !== 4) {
  console.error('usage: deno run -A scripts/trust-signin-smoke.ts <function-url> <app_id> <app_key> <service-vid> [--key <file>] [--app-data <url>]');
  Deno.exit(2);
}
const [functionUrl, appId, appKey, serviceVid] = positional;
const root = functionUrl.replace(/\/+$/, '');
const endpoint = `${root}/trust-tasks?app_id=${encodeURIComponent(appId)}&app_key=${encodeURIComponent(appKey)}`;
const appData = appDataUrl ?? root.replace(/app-trust-tasks$/, 'app-data');

function fail(step: string, detail: unknown): never {
  console.error(`FAIL ${step}:`, typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
  Deno.exit(1);
}

function pass(step: string, detail = ''): void {
  console.log(`ok   ${step}${detail ? ` — ${detail}` : ''}`);
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);

async function loadKey(): Promise<{ identity: TestIdentity; saved?: KeyFile }> {
  if (!keyPath) return { identity: mintDidKey() };
  try {
    const saved = JSON.parse(await Deno.readTextFile(keyPath)) as KeyFile;
    return { identity: mintDidKey(fromHex(saved.seedHex)), saved };
  } catch {
    const identity = mintDidKey();
    await Deno.writeTextFile(keyPath, JSON.stringify({ seedHex: toHex(identity.seed) }));
    return { identity };
  }
}

async function post(url: string, body: unknown): Promise<{ status: number; ms: number; body: unknown }> {
  const started = performance.now();
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  const ms = Math.round(performance.now() - started);
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, ms, body: parsed };
}

type Doc = { type?: string; threadId?: string; payload?: Record<string, unknown> };

const { identity, saved } = await loadKey();
console.log(`did  ${identity.did}${saved ? ' (reused key)' : ''}`);

// 1. auth/challenge
const challengeRequest = challengeDoc(identity.did, { id: crypto.randomUUID(), now: new Date(), recipient: serviceVid });
const challenge = await post(endpoint, challengeRequest);
if (challenge.status !== 200) fail('challenge', challenge);
const challengeBody = challenge.body as Doc;
if (challengeBody.type !== `${challengeRequest.type}#response` || challengeBody.threadId !== challengeRequest.id) {
  fail('challenge response matches its request', challengeBody);
}
const { challenge: nonce, sessionId } = (challengeBody.payload ?? {}) as { challenge?: string; sessionId?: string };
if (typeof nonce !== 'string' || typeof sessionId !== 'string') fail('challenge payload', challengeBody);
pass('challenge', `${challenge.ms} ms`);

// 2. auth/authenticate
const authRequest = authenticateDoc(identity, {
  id: crypto.randomUUID(),
  now: new Date(),
  recipient: serviceVid,
  challenge: nonce,
  sessionId,
});
const auth = await post(endpoint, authRequest);
if (auth.status !== 200) fail('authenticate', auth);
const authBody = auth.body as Doc;
if (authBody.type !== `${authRequest.type}#response` || authBody.threadId !== authRequest.id) {
  fail('authenticate response matches its request', authBody);
}
const token = (authBody.payload?.tokens as { accessToken?: string } | undefined)?.accessToken;
if (typeof token !== 'string' || !token) fail('authenticate token', authBody);
pass('authenticate', `${auth.ms} ms`);

// 3. The token works on the email path's auth_me.
const me = await post(appData, { action: 'auth_me', app_id: appId, app_key: appKey, member_token: token });
const member = (me.body as { member?: { id?: string; did?: string } } | undefined)?.member;
if (me.status !== 200 || !member?.id) fail('app-data auth_me with the member_token', me);
if (member.did !== identity.did) fail('auth_me member.did equals the signer', member);
pass('app-data auth_me', `member ${member.id}`);

// 4. S-47: a reused key maps to the same member.
if (keyPath) {
  if (saved?.memberId && saved.memberId !== member.id) fail('reused key → same member (S-47)', { before: saved.memberId, now: member.id });
  if (saved?.memberId) pass('reused key → same member (S-47)');
  await Deno.writeTextFile(keyPath, JSON.stringify({ seedHex: toHex(identity.seed), memberId: member.id }));
}

// 5. S-48 / C-60: the identical signed document again → 204, no body, no token.
const replay = await post(endpoint, authRequest);
if (replay.status !== 204 || replay.body !== undefined) fail('identical resend → 204 with no body (C-60)', replay);
pass('identical resend → 204, no token (C-60)');

console.log('\nAll checks passed. Confirm in the database that this run added exactly one app_sessions row.');
