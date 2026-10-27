// lib/trust-signin.ts — "Sign in with this device" for Community Cloud apps (Trust Tasks
// auth/challenge 0.1 + auth/authenticate 0.3). SPIKE STUB (Phase 1): signatures only; see
// docs/spikes/openvtc-signin/DESIGN.md §2. Ships into generated apps via the kit, so it uses
// bare imports only (pinned to esm.sh by the preview bundler's import map).

import type { TrustTaskDocument } from '@openvtc/trust-tasks';

/** localStorage key the email path already uses for the member session (S-61). */
export const MEMBER_TOKEN_KEY = 'member_token';
/** IndexedDB key under which the bootstrap identity is persisted (S-60). */
export const IDENTITY_KEY = 'rb.trust-signin.identity.v1';

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
    super(message);
    void [code, retryable, status];
    throw new Error('not implemented');
  }
}

/** True when this browser can generate and use a non-extractable Ed25519 WebCrypto key (S-60). */
export async function isEd25519Available(): Promise<boolean> {
  throw new Error('not implemented');
}

/** IndexedDB-backed IdentityStore (structured-clones CryptoKey objects) (S-60). */
export function indexedDbIdentityStore(_dbName?: string): IdentityStore {
  throw new Error('not implemented');
}

/** Load the persisted bootstrap identity or mint one; no network I/O (S-60, VTI-CLT-005). */
export async function getOrCreateIdentity(_options?: GetIdentityOptions): Promise<DeviceIdentity> {
  throw new Error('not implemented');
}

/** Unsigned auth/challenge/0.1 request: issuer = did, recipient, issuedAt, payload {subject: did, purpose: 'login'} (S-61 step 1). */
export function buildChallengeDocument(
  _did: string,
  _recipient: string,
  _now: Date,
  _id: string,
): TrustTaskDocument<{ subject: string; purpose: string }> {
  throw new Error('not implemented');
}

/** Unsigned auth/authenticate/0.3 request: issuer = did, recipient, issuedAt, payload {challenge, sessionId} (S-61 step 2). */
export function buildAuthenticateDocument(
  _did: string,
  _recipient: string,
  _now: Date,
  _id: string,
  _challenge: { challenge: string; sessionId: string },
): TrustTaskDocument<{ challenge: string; sessionId: string }> {
  throw new Error('not implemented');
}

/** eddsa-jcs-2022 proof, proofPurpose 'authentication', byte-identical to signTrustTask for the same key/doc/created (S-61). */
export async function signDocument<P>(
  _doc: TrustTaskDocument<P>,
  _identity: DeviceIdentity,
  _created: Date,
): Promise<TrustTaskDocument<P>> {
  throw new Error('not implemented');
}

/** Run challenge → authenticate against `<endpointBase>/trust-tasks?app_id&app_key`; stores and returns member_token (S-61). */
export async function signIn(
  _endpointBase: string,
  _appId: string,
  _appKey: string,
  _options: SignInOptions,
): Promise<SignInResult> {
  throw new Error('not implemented');
}

/** Short display form: `did:key:z6Mk…` + last 6 chars (S-62). */
export function shortDid(_did: string): string {
  throw new Error('not implemented');
}
