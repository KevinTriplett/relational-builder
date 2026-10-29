/**
 * S-60 / S-61 / S-62: the browser helper shipped into generated apps,
 * cross-checked against producer.ts (built from the task specs) and against
 * signTrustTask for byte-identical proofs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { AuthAuthenticate_v0_3, AuthChallenge_v0_1, TRUST_TASK_ERROR_TYPE_URI, canonicalJson, type TrustTaskDocument } from '@openvtc/trust-tasks';
import { DataIntegrityProofVerifier, publicKeyFromDidKey, signTrustTask, signerFromPrivateKey } from '@openvtc/trust-tasks-proof';
import * as helperModule from '../../src/kit/files/lib/trust-signin.ts';
import {
  MEMBER_TOKEN_KEY,
  TrustSignInError,
  buildAuthenticateDocument,
  buildChallengeDocument,
  getOrCreateIdentity,
  isEd25519Available,
  shortDid,
  signDocument,
  signIn,
  type DeviceIdentity,
  type GetIdentityOptions,
  type IdentityStore,
  type SignInOptions,
} from '../../src/kit/files/lib/trust-signin.ts';
import { handleTrustTask } from '../../supabase/functions/app-trust-tasks/core.ts';
import { responseHeaders } from '../../supabase/functions/app-trust-tasks/status.ts';
import { APP_A, APP_B, KEY_A, LOCAL_VID, T0, makeEnv, rejectionOf } from './helpers.ts';
import { authenticateDoc, challengeDoc, fixedSeed, mintDidKey } from './producer.ts';

const HELPER_SRC = readFileSync(fileURLToPath(new URL('../../src/kit/files/lib/trust-signin.ts', import.meta.url)), 'utf8');
const NOW = new Date(T0);
const RECIPIENT = LOCAL_VID;
const BASE = 'https://fakeproject.supabase.co/functions/v1/app-trust-tasks';

function softwareIdentity(seed = fixedSeed()): DeviceIdentity & { seed: Uint8Array } {
  const s = mintDidKey(seed);
  return { did: s.did, verificationMethod: s.verificationMethod, custody: 'software', kind: 'bootstrap', sign: async (b: Uint8Array) => s.signer.sign(b), seed };
}

/** In-memory IdentityStore that records every key it is asked for (C-37 oracles 1, 4, 5). */
function memoryStore(): IdentityStore & { data: Map<string, unknown>; calls: Array<{ op: 'get' | 'put'; key: string }> } {
  const data = new Map<string, unknown>();
  const calls: Array<{ op: 'get' | 'put'; key: string }> = [];
  return {
    data,
    calls,
    get: async (k) => (calls.push({ op: 'get', key: k }), data.get(k)),
    put: async (k, v) => void (calls.push({ op: 'put', key: k }), data.set(k, v)),
  };
}

// C-37 changes the helper's §2 surface (IDENTITY_KEY removed; IDENTITY_KEY_PREFIX,
// identityKeyForApp and GetIdentityOptions.appId added). Reached through the module
// namespace so a missing export fails the test that needs it, not the whole file.
const helperExports = helperModule as unknown as Record<string, unknown>;
const V1_KEY = 'rb.trust-signin.identity.v1';
function identityKeyForApp(appId: unknown): string {
  const f = helperExports.identityKeyForApp;
  if (typeof f !== 'function') throw new Error('identityKeyForApp is not exported by trust-signin.ts (C-37)');
  return (f as (a: unknown) => string)(appId);
}
/** getOrCreateIdentity with the C-37 required appId (typed loosely so invalid ids can be passed). */
function identityFor(appId: unknown, o: Omit<GetIdentityOptions, 'appId'> = {}): Promise<DeviceIdentity> {
  return getOrCreateIdentity({ ...o, appId } as GetIdentityOptions);
}

function* walk(v: unknown, seen = new Set<unknown>()): Generator<unknown> {
  if (v === null || typeof v !== 'object' || seen.has(v)) return;
  seen.add(v);
  yield v;
  if (v instanceof Uint8Array || (typeof CryptoKey !== 'undefined' && v instanceof CryptoKey)) return;
  for (const x of Object.values(v as Record<string, unknown>)) yield* walk(x, seen);
}

describe('signing fixture (S-61 oracle)', () => {
  it('S-61 signDocument with a software identity is byte-identical to signTrustTask(doc, signerFromPrivateKey("ed25519", seed), {proofPurpose:"authentication", created})', async () => {
    const id = softwareIdentity();
    const doc = buildAuthenticateDocument(id.did, RECIPIENT, NOW, 'doc-fixed-1', { challenge: 'C'.repeat(43), sessionId: 'sess-fixed-1' });
    for (const created of [new Date('2031-03-04T05:06:07.000Z'), new Date('2031-03-04T05:06:07.250Z')]) {
      const mine = await signDocument(doc, id, created);
      // C-51: the helper's TrustTaskDocument is a local structural type; view it as the upstream one.
      const ref = signTrustTask(doc as unknown as TrustTaskDocument<typeof doc.payload>, signerFromPrivateKey('ed25519', id.seed), { proofPurpose: 'authentication', created });
      expect(JSON.stringify(mine)).toBe(JSON.stringify(ref));
    }
    const signed = await signDocument(doc, id, new Date('2031-03-04T05:06:07.000Z'));
    expect(signed.proof).toMatchObject({
      type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: '2031-03-04T05:06:07Z', verificationMethod: id.verificationMethod, proofPurpose: 'authentication',
    });
    expect(await new DataIntegrityProofVerifier({ now: () => T0 }).verify(signed as unknown as TrustTaskDocument<typeof signed.payload>)).toBe(true);
  });

  it('S-61 signDocument refuses a document whose issuer is not the identity\'s did, without signing', async () => {
    const id = softwareIdentity();
    let signed = 0;
    const counting: DeviceIdentity = { ...id, sign: async (b) => { signed += 1; return id.sign(b); } };
    const doc = buildAuthenticateDocument(mintDidKey().did, RECIPIENT, NOW, 'x', { challenge: 'C'.repeat(43), sessionId: 's' });
    await rejectionOf(Promise.resolve().then(() => signDocument(doc, counting, NOW)));
    expect(signed).toBe(0);
  });

  it('S-61 buildChallengeDocument equals producer.challengeDoc for the same inputs (recipient = options.recipient, payload {subject: did, purpose:"login"}, unsigned)', () => {
    const id = softwareIdentity();
    const h = buildChallengeDocument(id.did, RECIPIENT, NOW, 'ch-1');
    const p = challengeDoc(id.did, { id: 'ch-1', now: NOW, recipient: RECIPIENT });
    expect(canonicalJson(h)).toBe(canonicalJson(p));
    expect(h).toEqual({ id: 'ch-1', type: AuthChallenge_v0_1.TYPE_URI, issuer: id.did, recipient: RECIPIENT, issuedAt: NOW.toISOString(), payload: { subject: id.did, purpose: 'login' } });
  });

  it('S-61 buildAuthenticateDocument + signDocument equals producer.authenticateDoc for a fixed seed, now and ids', async () => {
    const id = softwareIdentity();
    const ch = { challenge: 'Z'.repeat(43), sessionId: 'sess-9' };
    const h = await signDocument(buildAuthenticateDocument(id.did, RECIPIENT, NOW, 'au-1', ch), id, NOW);
    const p = authenticateDoc(mintDidKey(fixedSeed()), { id: 'au-1', now: NOW, recipient: RECIPIENT, ...ch });
    expect(canonicalJson(h)).toBe(canonicalJson(p));
    expect(h.type).toBe(AuthAuthenticate_v0_3.TYPE_URI);
  });
});

describe('key custody (S-60)', () => {
  it('S-60 isEd25519Available() is async and true where WebCrypto Ed25519 works (Node 24)', async () => {
    const r = isEd25519Available();
    expect(r).toBeInstanceOf(Promise);
    expect(await r).toBe(true);
  });

  it('S-60 / C-37 getOrCreateIdentity mints a non-extractable WebCrypto did:key (kind bootstrap), persists it under identityKeyForApp(appId), reloads the same identity, and does no network I/O', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('network'); });
    vi.stubGlobal('fetch', fetchSpy);
    const store = memoryStore();
    const KEY = identityKeyForApp(APP_A);
    const a = await identityFor(APP_A, { store });
    expect(a.custody).toBe('webcrypto');
    expect(a.kind).toBe('bootstrap');
    expect(a.did).toMatch(/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/);
    expect(a.verificationMethod).toBe(`${a.did}#${a.did.slice('did:key:'.length)}`);
    expect([...store.data.keys()]).toEqual([KEY]);
    const record = store.data.get(KEY);
    expect(JSON.stringify(record)).toMatch(/bootstrap/);
    const keys = [...walk(record)].filter((v): v is CryptoKey => typeof CryptoKey !== 'undefined' && v instanceof CryptoKey);
    const priv = keys.filter((k) => k.type === 'private');
    expect(priv.length).toBeGreaterThan(0);
    for (const k of priv) expect(k.extractable).toBe(false);
    const b = await identityFor(APP_A, { store });
    expect(b.did).toBe(a.did);
    const msg = new TextEncoder().encode('hello');
    const sig = await b.sign(msg);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
    expect(ed25519.verify(sig, msg, publicKeyFromDidKey(a.did)!.bytes)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('S-60 without WebCrypto Ed25519 and without allowInMemoryFallback → TrustSignInError("unsupported", false, 0)', async () => {
    vi.spyOn(crypto.subtle, 'generateKey').mockRejectedValue(new DOMException('Unrecognized name', 'NotSupportedError'));
    const store = memoryStore();
    const e = await rejectionOf(identityFor(APP_A, { store }));
    expect(e).toBeInstanceOf(TrustSignInError);
    expect(e).toMatchObject({ code: 'unsupported', retryable: false, status: 0 });
    expect(store.data.size).toBe(0);
  });

  it('S-60 / C-37 with allowInMemoryFallback the identity is a software did:key (custody "software") stored as a 32-byte seed under identityKeyForApp(appId), and signs verifiably', async () => {
    vi.spyOn(crypto.subtle, 'generateKey').mockRejectedValue(new DOMException('Unrecognized name', 'NotSupportedError'));
    const store = memoryStore();
    const KEY = identityKeyForApp(APP_A);
    const id = await identityFor(APP_A, { store, allowInMemoryFallback: true });
    expect(id.custody).toBe('software');
    expect(id.kind).toBe('bootstrap');
    expect(id.did).toMatch(/^did:key:z6Mk/);
    expect([...store.data.keys()]).toEqual([KEY]);
    const record = store.data.get(KEY);
    expect(JSON.stringify(record)).toContain('software');
    const seeds = [...walk(record)].filter((v): v is Uint8Array => v instanceof Uint8Array && v.length === 32);
    expect(seeds.length).toBeGreaterThan(0);
    const again = await identityFor(APP_A, { store, allowInMemoryFallback: true });
    expect(again.did).toBe(id.did);
    const msg = new Uint8Array([1, 2, 3]);
    expect(ed25519.verify(await id.sign(msg), msg, publicKeyFromDidKey(id.did)!.bytes)).toBe(true);
  });
});

interface Recorded { url: string; method: string; headers: Headers; body: unknown }

function scriptedFetch(responses: Array<(req: Recorded) => Response>) {
  const requests: Recorded[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Recorded = { url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(req);
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra request');
    return r(req);
  });
  return { fetch: fn as unknown as typeof fetch, requests };
}
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function challengeResponseFor(req: Recorded): Response {
  const d = req.body as TrustTaskDocument<unknown>;
  return jsonRes(200, {
    id: 'resp-ch', type: AuthChallenge_v0_1.RESPONSE_TYPE_URI, issuer: LOCAL_VID, recipient: d.issuer, threadId: d.id, issuedAt: NOW.toISOString(),
    payload: { challenge: 'K'.repeat(43), sessionId: 'sess-scripted', expiresAt: new Date(T0 + 120_000).toISOString() },
  });
}
function authResponseFor(req: Recorded, token = 'a'.repeat(64)): Response {
  const d = req.body as TrustTaskDocument<unknown>;
  return jsonRes(200, {
    id: 'resp-au', type: AuthAuthenticate_v0_3.RESPONSE_TYPE_URI, issuer: LOCAL_VID, recipient: d.issuer, threadId: d.id, issuedAt: NOW.toISOString(),
    payload: {
      session: { id: 'sid', subject: d.issuer, issuedAt: NOW.toISOString(), expiresAt: new Date(T0 + 1000).toISOString(), amr: ['did'], acr: 'aal1' },
      tokens: { accessToken: token, tokenType: 'Bearer', expiresIn: 2592000 },
      ext: { 'org.relationalbuilder.cloud': { member: { id: 'm-1', did: d.issuer, name: null, email: null } } },
    },
  });
}

describe('signIn wire shape (S-61)', () => {
  it('S-61 posts the challenge then the signed authenticate to <base>/trust-tasks?app_id&app_key (one trailing slash stripped); bodies equal producer.ts output; stores member_token', async () => {
    const id = softwareIdentity();
    const { fetch: f, requests } = scriptedFetch([challengeResponseFor, (r) => authResponseFor(r)]);
    const uuids = ['uuid-ch-1', 'uuid-au-2'];
    const stored: Array<[string, string]> = [];
    const result = await signIn(`${BASE}/`, APP_A, KEY_A, {
      recipient: RECIPIENT, identity: id, fetch: f, now: () => NOW, randomUUID: () => uuids.shift()!, storage: { setItem: (k, v) => void stored.push([k, v]) },
    });
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      const u = new URL(r.url);
      expect(`${u.origin}${u.pathname}`).toBe(`${BASE}/trust-tasks`);
      expect(Object.fromEntries(u.searchParams)).toEqual({ app_id: APP_A, app_key: KEY_A });
      expect(r.method).toBe('POST');
      expect(r.headers.get('Content-Type')).toContain('application/json');
    }
    expect(canonicalJson(requests[0].body)).toBe(canonicalJson(challengeDoc(id.did, { id: 'uuid-ch-1', now: NOW, recipient: RECIPIENT })));
    const expected = authenticateDoc(mintDidKey(fixedSeed()), { id: 'uuid-au-2', now: NOW, recipient: RECIPIENT, challenge: 'K'.repeat(43), sessionId: 'sess-scripted' });
    expect(canonicalJson(requests[1].body)).toBe(canonicalJson(expected));
    expect(result).toEqual({ member_token: 'a'.repeat(64), member: { id: 'm-1', did: id.did, name: null, email: null }, did: id.did });
    expect(stored).toEqual([[MEMBER_TOKEN_KEY, 'a'.repeat(64)]]);
    expect(MEMBER_TOKEN_KEY).toBe('member_token');
  });

  it('S-60 / S-61 no request carries private key material', async () => {
    const id = softwareIdentity(fixedSeed(100));
    const { fetch: f, requests } = scriptedFetch([challengeResponseFor, (r) => authResponseFor(r)]);
    await signIn(BASE, APP_A, KEY_A, { recipient: RECIPIENT, identity: id, fetch: f, now: () => NOW, storage: { setItem: () => {} } });
    const wire = requests.map((r) => r.url + JSON.stringify(r.body)).join('\n');
    const seed = Buffer.from(id.seed);
    for (const enc of [seed.toString('hex'), seed.toString('base64'), seed.toString('base64url')]) expect(wire).not.toContain(enc);
    expect(requests).toHaveLength(2);
  });

  it('S-61 a non-2xx trust-task-error is thrown as TrustSignInError{code, retryable, status}; a 200 trust-task-error too', async () => {
    const errBody = (code: string, retryable: boolean) => ({ id: 'e', type: TRUST_TASK_ERROR_TYPE_URI, issuer: LOCAL_VID, payload: { code, retryable } });
    const id = softwareIdentity();
    const a = scriptedFetch([challengeResponseFor, () => jsonRes(422, errBody('auth/authenticate:challengeExpired', true))]);
    const e1 = await rejectionOf(signIn(BASE, APP_A, KEY_A, { recipient: RECIPIENT, identity: id, fetch: a.fetch, now: () => NOW, storage: { setItem: () => {} } }));
    expect(e1).toBeInstanceOf(TrustSignInError);
    expect(e1).toMatchObject({ code: 'auth/authenticate:challengeExpired', retryable: true, status: 422 });
    const b = scriptedFetch([() => jsonRes(200, errBody('auth/challenge:subjectNotRecognized', false))]);
    const e2 = await rejectionOf(signIn(BASE, APP_A, KEY_A, { recipient: RECIPIENT, identity: id, fetch: b.fetch, now: () => NOW, storage: { setItem: () => {} } }));
    expect(e2).toMatchObject({ code: 'auth/challenge:subjectNotRecognized', retryable: false, status: 200 });
  });

  it('S-61 / C-62 202 or 204 (no body, no Content-Type) on authenticate → TrustSignInError("noResponse", true, status); storage.setItem is never called; exactly two fetches', async () => {
    for (const status of [202, 204]) {
      const f = scriptedFetch([challengeResponseFor, () => new Response(null, { status })]);
      const setItem = vi.fn();
      const e = await rejectionOf(signIn(BASE, APP_A, KEY_A, { recipient: RECIPIENT, identity: softwareIdentity(), fetch: f.fetch, now: () => NOW, storage: { setItem } }));
      expect(e).toBeInstanceOf(TrustSignInError);
      expect(e).toMatchObject({ code: 'noResponse', retryable: true, status });
      expect(setItem, String(status)).not.toHaveBeenCalled();
      expect(f.fetch, String(status)).toHaveBeenCalledTimes(2);
      expect(f.requests, String(status)).toHaveLength(2);
    }
  });

  it('S-61 non-JSON (or non-error JSON) non-2xx → TrustSignInError("transport", status >= 500, status) (C-29)', async () => {
    const cases: Array<[Response, boolean, number]> = [
      [new Response('Bad gateway', { status: 502, headers: { 'Content-Type': 'text/plain' } }), true, 502],
      [new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/html' } }), false, 404],
      [jsonRes(500, { error: 'boom' }), true, 500],
      [jsonRes(403, { error: 'Unknown app or wrong key' }), false, 403],
    ];
    for (const [res, retryable, status] of cases) {
      const f = scriptedFetch([() => res]);
      const e = await rejectionOf(signIn(BASE, APP_A, KEY_A, { recipient: RECIPIENT, identity: softwareIdentity(), fetch: f.fetch, now: () => NOW, storage: { setItem: () => {} } }));
      expect(e).toBeInstanceOf(TrustSignInError);
      expect(e).toMatchObject({ code: 'transport', retryable, status });
    }
  });

  it('S-61 a rejected fetch (no response) → TrustSignInError("transport", true, 0) (C-29), on either request', async () => {
    const reject = () => { throw new TypeError('Failed to fetch'); };
    for (const script of [[reject], [challengeResponseFor, reject]]) {
      const f = scriptedFetch(script as Array<(req: Recorded) => Response>);
      const e = await rejectionOf(signIn(BASE, APP_A, KEY_A, { recipient: RECIPIENT, identity: softwareIdentity(), fetch: f.fetch, now: () => NOW, storage: { setItem: () => {} } }));
      expect(e).toBeInstanceOf(TrustSignInError);
      expect(e).toMatchObject({ code: 'transport', retryable: true, status: 0 });
    }
  });

  it('S-61 end-to-end against handleTrustTask (fake PostgREST): signIn returns the member_token the server minted', async () => {
    const env = makeEnv();
    const serverFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      expect(u.pathname.endsWith('/trust-tasks')).toBe(true);
      const res = await handleTrustTask(env.deps, { appId: u.searchParams.get('app_id') ?? '', appKey: u.searchParams.get('app_key') ?? '', rawBody: JSON.parse(String(init?.body)) });
      return new Response(res.body === undefined ? null : JSON.stringify(res.body), { status: res.status, headers: responseHeaders(res.body !== undefined) });
    }) as typeof fetch;
    const id = softwareIdentity(fixedSeed(7));
    const out = await signIn(BASE, APP_A, KEY_A, { recipient: LOCAL_VID, identity: id, fetch: serverFetch, now: env.clock.now, storage: { setItem: () => {} } });
    expect(out.member_token).toBe(env.fake.tables.app_sessions[0].token);
    expect(out.did).toBe(id.did);
    expect(out.member).toMatchObject({ did: id.did, email: null, name: null, id: env.fake.tables.app_members[0].id });
  });
});

describe('per-app device identity (C-37)', () => {
  const PREFIX = 'rb.trust-signin.identity.v2:';
  const noV1 = (store: ReturnType<typeof memoryStore>) => {
    for (const c of store.calls) expect(c.key, `${c.op} used the retired shared key`).not.toBe(V1_KEY);
  };

  it('C-37 IDENTITY_KEY_PREFIX is rb.trust-signin.identity.v2: and identityKeyForApp(appId) = prefix + appId.trim().toLowerCase()', () => {
    expect(helperExports.IDENTITY_KEY_PREFIX).toBe(PREFIX);
    expect(identityKeyForApp(APP_A)).toBe(`${PREFIX}${APP_A}`);
    expect(identityKeyForApp(APP_B)).toBe(`${PREFIX}${APP_B}`);
    expect(identityKeyForApp(APP_A)).not.toBe(identityKeyForApp(APP_B));
  });

  it('C-37 oracle 3: upper- and lower-case (and padded) spellings of one uuid give the same key and the same identity', async () => {
    const lower = 'abcdef01-2345-4678-9abc-def012345678';
    const upper = lower.toUpperCase();
    expect(upper).not.toBe(lower);
    expect(identityKeyForApp(upper)).toBe(identityKeyForApp(lower));
    expect(identityKeyForApp(upper)).toBe(`${PREFIX}${lower}`);
    expect(identityKeyForApp(`  ${upper}  `)).toBe(identityKeyForApp(lower));
    const store = memoryStore();
    const a = await identityFor(lower, { store });
    const b = await identityFor(upper, { store });
    expect(b.did).toBe(a.did);
    expect([...store.data.keys()]).toEqual([identityKeyForApp(lower)]);
  });

  it('C-37 oracles 1, 2, 5: apps A and B on one store get different DIDs, stored under exactly identityKeyForApp(A) and identityKeyForApp(B); a repeat for A returns A\'s DID; no store call uses the v1 key', async () => {
    const store = memoryStore();
    const a = await identityFor(APP_A, { store });
    const b = await identityFor(APP_B, { store });
    expect(b.did).not.toBe(a.did);
    expect([...store.data.keys()].sort()).toEqual([identityKeyForApp(APP_A), identityKeyForApp(APP_B)].sort());
    expect((store.data.get(identityKeyForApp(APP_A)) as { did?: unknown }).did).toBe(a.did);
    expect((store.data.get(identityKeyForApp(APP_B)) as { did?: unknown }).did).toBe(b.did);
    const again = await identityFor(APP_A, { store });
    expect(again.did).toBe(a.did);
    expect(store.data.size).toBe(2);
    const allowed = new Set([identityKeyForApp(APP_A), identityKeyForApp(APP_B)]);
    for (const c of store.calls) expect(allowed.has(c.key), `${c.op} ${c.key}`).toBe(true);
    noV1(store);
  });

  it('C-37 oracle 4: appId "", blank, or a non-string → TrustSignInError("invalidAppId", false, 0) with zero store calls; identityKeyForApp throws the same', async () => {
    for (const bad of ['', '   ', '\t\n', 42, undefined, null, { id: APP_A }]) {
      const store = memoryStore();
      const e = await rejectionOf(identityFor(bad, { store, allowInMemoryFallback: true }));
      expect(e, JSON.stringify(bad)).toBeInstanceOf(TrustSignInError);
      expect(e, JSON.stringify(bad)).toMatchObject({ code: 'invalidAppId', retryable: false, status: 0 });
      expect(store.calls, JSON.stringify(bad)).toEqual([]);
      let thrown: unknown;
      try {
        identityKeyForApp(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, JSON.stringify(bad)).toBeInstanceOf(TrustSignInError);
      expect(thrown, JSON.stringify(bad)).toMatchObject({ code: 'invalidAppId', retryable: false, status: 0 });
    }
  });

  it('C-37 oracle 5: IDENTITY_KEY is no longer exported, and the helper source never names the v1 key', () => {
    expect('IDENTITY_KEY' in helperExports).toBe(false);
    expect(HELPER_SRC).not.toContain(V1_KEY);
  });

  it('C-37 oracle 6: signIn with identityStore and no identity signs with the app\'s own identity; a second signIn for app B on the same store uses a different issuer', async () => {
    const store = memoryStore();
    const run = async (appId: string) => {
      const { fetch: f, requests } = scriptedFetch([challengeResponseFor, (r) => authResponseFor(r)]);
      const options = { recipient: RECIPIENT, identityStore: store, fetch: f, now: () => NOW, storage: { setItem: () => {} } } as SignInOptions;
      const out = await signIn(BASE, appId, appId === APP_A ? KEY_A : 'key-b', options);
      expect(requests).toHaveLength(2);
      expect(new URL(requests[0].url).searchParams.get('app_id')).toBe(appId);
      return { out, issuers: requests.map((r) => (r.body as { issuer: string }).issuer) };
    };
    const a = await run(APP_A);
    const didA = (store.data.get(identityKeyForApp(APP_A)) as { did?: string } | undefined)?.did;
    expect(didA).toMatch(/^did:key:z6Mk/);
    expect(a.issuers).toEqual([didA, didA]);
    expect(a.out.did).toBe(didA);
    const b = await run(APP_B);
    const didB = (store.data.get(identityKeyForApp(APP_B)) as { did?: string } | undefined)?.did;
    expect(b.issuers).toEqual([didB, didB]);
    expect(didB).not.toBe(didA);
    noV1(store);
  });
});

describe('signIn checks that a response answers its request (C-52)', () => {
  const withBody = (base: (req: Recorded) => Response, patch: Record<string, unknown>) => async (req: Recorded) => {
    const body = (await base(req).json()) as Record<string, unknown>;
    return jsonRes(200, { ...body, ...patch });
  };
  const run = (script: Array<(req: Recorded) => Response | Promise<Response>>, stored: string[] = []) => {
    const f = scriptedFetch(script as Array<(req: Recorded) => Response>);
    const p = signIn(BASE, APP_A, KEY_A, { recipient: RECIPIENT, identity: softwareIdentity(), fetch: f.fetch, now: () => NOW, storage: { setItem: (k) => void stored.push(k) } });
    return { p, requests: f.requests };
  };

  it('C-52 a 200 challenge response with threadId ≠ the request id → TrustSignInError("transport", false, 200), and no second POST', async () => {
    const { p, requests } = run([withBody(challengeResponseFor, { threadId: 'not-the-request-id' })]);
    const e = await rejectionOf(p);
    expect(e).toBeInstanceOf(TrustSignInError);
    expect(e).toMatchObject({ code: 'transport', retryable: false, status: 200 });
    expect(requests).toHaveLength(1);
  });

  it('C-52 a 200 challenge response typed as the authenticate #response → TrustSignInError("transport", false, 200), and no second POST', async () => {
    const { p, requests } = run([withBody(challengeResponseFor, { type: AuthAuthenticate_v0_3.RESPONSE_TYPE_URI })]);
    const e = await rejectionOf(p);
    expect(e).toBeInstanceOf(TrustSignInError);
    expect(e).toMatchObject({ code: 'transport', retryable: false, status: 200 });
    expect(requests).toHaveLength(1);
  });

  it('C-52 an authenticate 200 typed as the challenge #response → TrustSignInError("transport", false, 200), and member_token is not written', async () => {
    const stored: string[] = [];
    const { p, requests } = run([challengeResponseFor, withBody((r) => authResponseFor(r), { type: AuthChallenge_v0_1.RESPONSE_TYPE_URI })], stored);
    const e = await rejectionOf(p);
    expect(e).toBeInstanceOf(TrustSignInError);
    expect(e).toMatchObject({ code: 'transport', retryable: false, status: 200 });
    expect(requests).toHaveLength(2);
    expect(stored).toEqual([]);
  });

  it('C-52 an authenticate 200 whose threadId ≠ the authenticate request id → TrustSignInError("transport", false, 200), and member_token is not written', async () => {
    const stored: string[] = [];
    const { p } = run([challengeResponseFor, withBody((r) => authResponseFor(r), { threadId: 'not-the-request-id' })], stored);
    const e = await rejectionOf(p);
    expect(e).toMatchObject({ code: 'transport', retryable: false, status: 200 });
    expect(stored).toEqual([]);
  });
});

describe('no email in the helper (S-62)', () => {
  it('S-62 shortDid gives did:key:z6Mk…<last 6>; the helper has no email input and no auth_request', () => {
    const did = mintDidKey().did;
    const s = shortDid(did);
    expect(s.startsWith('did:key:z6Mk')).toBe(true);
    expect(s.endsWith(did.slice(-6))).toBe(true);
    expect(s.length).toBeLessThan(did.length);
    expect(HELPER_SRC).not.toMatch(/auth_request|type=["']email["']|\bemail\s*:\s*string\b/);
  });
});
