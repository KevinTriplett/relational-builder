// lib/trust-signin.ts — "Sign in with this device" for Community Cloud apps (Trust Tasks
// auth/challenge 0.1 + auth/authenticate 0.3). See docs/spikes/openvtc-signin/DESIGN.md §2.
// Ships into generated apps via the kit, so it uses bare imports only (pinned to esm.sh by
// the preview bundler's import map).
//
// The browser mints its own Ed25519 did:key (a VTI "bootstrap" client identity). The private
// key never leaves this device: it is a non-extractable WebCrypto key in IndexedDB, and only
// signatures go over the network.

import type { TrustTaskDocument } from '@openvtc/trust-tasks';
import { canonicalBytes, didKeyFromPublicKey, toMultibase } from '@openvtc/trust-tasks-proof';
import { ed25519 } from '@noble/curves/ed25519.js';

/** localStorage key the email path already uses for the member session (S-61). */
export const MEMBER_TOKEN_KEY = 'member_token';
/** IndexedDB key under which the bootstrap identity is persisted (S-60). */
export const IDENTITY_KEY = 'rb.trust-signin.identity.v1';

const CHALLENGE_TYPE = 'https://trusttasks.org/spec/auth/challenge/0.1';
const AUTHENTICATE_TYPE = 'https://trusttasks.org/spec/auth/authenticate/0.3';
const MEMBER_EXT = 'org.relationalbuilder.cloud';

/** Where the private key lives: non-extractable WebCrypto, or raw bytes (software fallback). */
export type Custody = 'webcrypto' | 'software';

/** The browser's bootstrap identity (VTI-CLT-001…006); never leaves the device (S-60). */
export interface DeviceIdentity {
  /** `did:key:z6Mk…` (Ed25519). */
  did: string;
  /** `did + '#' + <multikey>` — the proof's verificationMethod. */
  verificationMethod: string;
  custody: Custody;
  /** VTI-CLT-004: distinguishes this from a later wallet identity. */
  kind: 'bootstrap';
  /** Ed25519 signature over `bytes` (async so a non-extractable WebCrypto key can be used). */
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

/** Minimal async key/value store; default is IndexedDB (S-60). */
export interface IdentityStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

/** Options for getOrCreateIdentity (S-60). */
export interface GetIdentityOptions {
  store?: IdentityStore;
  /** Permit @noble software keys when WebCrypto Ed25519 is unavailable. Default false. */
  allowInMemoryFallback?: boolean;
}

/** Options for signIn (S-61). */
export interface SignInOptions {
  /** The auth service VID (env TRUST_TASKS_VID); both documents carry it as `recipient`. */
  recipient: string;
  identity?: DeviceIdentity;
  fetch?: typeof fetch;
  now?: () => Date;
  randomUUID?: () => string;
  /** Where member_token is written. Default window.localStorage. */
  storage?: Pick<Storage, 'setItem'>;
}

/** Member object as the email path returns it, plus did (S-47 ext). */
export interface TrustMember {
  id: string;
  did: string;
  name: string | null;
  email: null;
}

/** Result of a successful sign-in (S-61). */
export interface SignInResult {
  member_token: string;
  member: TrustMember | null;
  did: string;
}

/** A trust-task-error (or transport failure, code 'transport') surfaced to the app (S-61 step 4). */
export class TrustSignInError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  constructor(code: string, retryable: boolean, status: number, message?: string) {
    super(message ?? code);
    this.name = 'TrustSignInError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

/** Persisted forms of the identity. CryptoKeys survive IndexedDB's structured clone. */
type IdentityRecord =
  | { kind: 'bootstrap'; custody: 'webcrypto'; did: string; verificationMethod: string; privateKey: CryptoKey; publicKey: CryptoKey }
  | { kind: 'bootstrap'; custody: 'software'; did: string; verificationMethod: string; seed: Uint8Array };

const ED25519 = { name: 'Ed25519' } as const;

/** True when this browser can generate and use a non-extractable Ed25519 WebCrypto key (S-60). */
export async function isEd25519Available(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey(ED25519, false, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

/** IndexedDB-backed IdentityStore (structured-clones CryptoKey objects) (S-60). */
export function indexedDbIdentityStore(dbName = 'rb-trust-signin'): IdentityStore {
  const STORE = 'kv';
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const run = async <T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const req = op(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    put: async (key, value) => {
      await run('readwrite', (s) => s.put(value, key));
    },
  };
}

function didFromPublicKey(bytes: Uint8Array): { did: string; verificationMethod: string } {
  const verificationMethod = didKeyFromPublicKey({ curve: 'ed25519', bytes });
  return { did: verificationMethod.split('#', 1)[0], verificationMethod };
}

function fromRecord(r: IdentityRecord): DeviceIdentity {
  const base = { did: r.did, verificationMethod: r.verificationMethod, kind: 'bootstrap' as const };
  if (r.custody === 'webcrypto') {
    const key = r.privateKey;
    return {
      ...base,
      custody: 'webcrypto',
      sign: async (bytes) => new Uint8Array(await crypto.subtle.sign(ED25519, key, new Uint8Array(bytes))),
    };
  }
  const seed = r.seed;
  return { ...base, custody: 'software', sign: async (bytes) => ed25519.sign(bytes, seed) };
}

function isRecord(v: unknown): v is IdentityRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.kind !== 'bootstrap' || typeof r.did !== 'string' || typeof r.verificationMethod !== 'string') return false;
  if (r.custody === 'webcrypto') return typeof r.privateKey === 'object' && r.privateKey !== null;
  return r.custody === 'software' && r.seed instanceof Uint8Array && r.seed.length === 32;
}

/** Load the persisted bootstrap identity or mint one; no network I/O (S-60, VTI-CLT-005). */
export async function getOrCreateIdentity(options: GetIdentityOptions = {}): Promise<DeviceIdentity> {
  const store = options.store ?? indexedDbIdentityStore();
  const existing = await store.get(IDENTITY_KEY);
  if (isRecord(existing)) return fromRecord(existing);

  let pair: CryptoKeyPair | undefined;
  try {
    pair = (await crypto.subtle.generateKey(ED25519, false, ['sign', 'verify'])) as CryptoKeyPair;
  } catch {
    pair = undefined;
  }
  let record: IdentityRecord;
  if (pair) {
    // The public half is always exportable; the private half stays non-extractable.
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    record = { kind: 'bootstrap', custody: 'webcrypto', ...didFromPublicKey(pub), privateKey: pair.privateKey, publicKey: pair.publicKey };
  } else {
    if (!options.allowInMemoryFallback) {
      throw new TrustSignInError('unsupported', false, 0, 'this browser cannot create a device key (WebCrypto Ed25519 unavailable)');
    }
    // SPIKE: software custody — the 32-byte seed is stored as plain bytes in IndexedDB, readable
    // by any script on this origin. Only used when the app opts in with allowInMemoryFallback.
    const seed = crypto.getRandomValues(new Uint8Array(32));
    record = { kind: 'bootstrap', custody: 'software', ...didFromPublicKey(ed25519.getPublicKey(seed)), seed };
  }
  await store.put(IDENTITY_KEY, record);
  return fromRecord(record);
}

/** Unsigned auth/challenge/0.1 request: issuer = did, recipient, issuedAt, payload {subject: did, purpose: 'login'} (S-61 step 1). */
export function buildChallengeDocument(
  did: string,
  recipient: string,
  now: Date,
  id: string,
): TrustTaskDocument<{ subject: string; purpose: string }> {
  return { id, type: CHALLENGE_TYPE, issuer: did, recipient, issuedAt: now.toISOString(), payload: { subject: did, purpose: 'login' } };
}

/** Unsigned auth/authenticate/0.3 request: issuer = did, recipient, issuedAt, payload {challenge, sessionId} (S-61 step 2). */
export function buildAuthenticateDocument(
  did: string,
  recipient: string,
  now: Date,
  id: string,
  challenge: { challenge: string; sessionId: string },
): TrustTaskDocument<{ challenge: string; sessionId: string }> {
  return {
    id,
    type: AUTHENTICATE_TYPE,
    issuer: did,
    recipient,
    issuedAt: now.toISOString(),
    payload: { challenge: challenge.challenge, sessionId: challenge.sessionId },
  };
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}

/** eddsa-jcs-2022 proof, proofPurpose 'authentication', byte-identical to signTrustTask for the same key/doc/created (S-61). */
export async function signDocument<P>(
  doc: TrustTaskDocument<P>,
  identity: DeviceIdentity,
  created: Date,
): Promise<TrustTaskDocument<P>> {
  if (doc.issuer !== identity.did) {
    throw new TrustSignInError('issuerMismatch', false, 0, 'document issuer is not this device identity');
  }
  const body: TrustTaskDocument<P> = { ...doc };
  delete body.proof;
  const config = {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: created.toISOString().replace(/\.000Z$/, 'Z'),
    verificationMethod: identity.verificationMethod,
    proofPurpose: 'authentication',
  };
  const [configHash, bodyHash] = await Promise.all([sha256(canonicalBytes(config)), sha256(canonicalBytes(body))]);
  const hashData = new Uint8Array([...configHash, ...bodyHash]);
  const proofValue = toMultibase(await identity.sign(hashData));
  return { ...body, proof: { ...config, proofValue } };
}

interface ErrorBody {
  type: string;
  payload: { code: string; retryable?: boolean; message?: string };
}

function isTrustTaskError(v: unknown): v is ErrorBody {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as { type?: unknown; payload?: { code?: unknown } };
  return typeof d.type === 'string' && d.type.split('#')[0].includes('/trust-task-error/') && typeof d.payload?.code === 'string';
}

async function postDocument(fetchFn: typeof fetch, url: string, doc: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) });
  } catch {
    throw new TrustSignInError('transport', true, 0, 'could not reach the sign-in service');
  }
  if (res.status === 202 || res.status === 204) {
    throw new TrustSignInError('noResponse', true, res.status, 'the sign-in service did not answer; try again');
  }
  const isJson = (res.headers.get('Content-Type') ?? '').includes('application/json');
  let body: unknown;
  if (isJson) {
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
  }
  if (isTrustTaskError(body)) {
    throw new TrustSignInError(body.payload.code, body.payload.retryable === true, res.status, body.payload.message);
  }
  if (!res.ok || typeof body !== 'object' || body === null) {
    throw new TrustSignInError('transport', res.status >= 500, res.status, `sign-in service answered HTTP ${res.status}`);
  }
  return body as Record<string, unknown>;
}

function payloadOf(doc: Record<string, unknown>): Record<string, unknown> {
  const p = doc.payload;
  return typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : {};
}

/** Run challenge → authenticate against `<endpointBase>/trust-tasks?app_id&app_key`; stores and returns member_token (S-61). */
export async function signIn(
  endpointBase: string,
  appId: string,
  appKey: string,
  options: SignInOptions,
): Promise<SignInResult> {
  const identity = options.identity ?? (await getOrCreateIdentity());
  const fetchFn: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const uuid = options.randomUUID ?? (() => crypto.randomUUID());
  const url =
    `${endpointBase.replace(/\/$/, '')}/trust-tasks` +
    `?app_id=${encodeURIComponent(appId)}&app_key=${encodeURIComponent(appKey)}`;

  // 1. Unsigned challenge request.
  const challengeRes = payloadOf(await postDocument(fetchFn, url, buildChallengeDocument(identity.did, options.recipient, now(), uuid())));
  const { challenge, sessionId } = challengeRes;
  if (typeof challenge !== 'string' || typeof sessionId !== 'string') {
    throw new TrustSignInError('transport', false, 200, 'unexpected challenge response');
  }

  // 2. Signed authenticate request: one clock reading for issuedAt and proof.created.
  const t = now();
  const doc = buildAuthenticateDocument(identity.did, options.recipient, t, uuid(), { challenge, sessionId });
  const signed = await signDocument(doc, identity, t);

  // 3. Read the TokenBundle.
  const authRes = payloadOf(await postDocument(fetchFn, url, signed));
  const tokens = authRes.tokens as { accessToken?: unknown } | undefined;
  const token = tokens?.accessToken;
  if (typeof token !== 'string' || token === '') {
    throw new TrustSignInError('transport', false, 200, 'unexpected authenticate response');
  }
  const ext = authRes.ext as Record<string, { member?: TrustMember }> | undefined;
  const member = ext?.[MEMBER_EXT]?.member ?? null;
  (options.storage ?? localStorage).setItem(MEMBER_TOKEN_KEY, token);
  return { member_token: token, member, did: identity.did };
}

/** Short display form: `did:key:z6Mk…` + last 6 chars (S-62). */
export function shortDid(did: string): string {
  const prefix = did.startsWith('did:key:z6Mk') ? 'did:key:z6Mk' : did.slice(0, 12);
  return `${prefix}…${did.slice(-6)}`;
}
