/**
 * Test-side producer — built from the task specs (auth/challenge/0.1,
 * auth/authenticate/0.3) and the amended SPIKE-SPEC (S-61, C-17), *not* from
 * the helper's code. It mirrors trust-signin.ts's wire output so the two are
 * cross-checked by producer-helper.fixture.test.ts:
 *
 *  - challenge: `{id, type, issuer: did, recipient, issuedAt: now, payload: {subject: did, purpose: "login"}}`, unsigned.
 *  - authenticate: `{id, type, issuer: did, recipient, issuedAt: now, payload: {challenge, sessionId}}`,
 *    signed with `signTrustTask` (eddsa-jcs-2022, did:key, `proofPurpose: "authentication"`) after
 *    every member is set.
 */
import { AuthAuthenticate_v0_3, AuthChallenge_v0_1, type TrustTaskDocument } from '@openvtc/trust-tasks';
import { signerFromPrivateKey, signTrustTask, type Signer } from '@openvtc/trust-tasks-proof';

export const CHALLENGE_TYPE_URI = AuthChallenge_v0_1.TYPE_URI;
export const AUTHENTICATE_TYPE_URI = AuthAuthenticate_v0_3.TYPE_URI;

export interface TestIdentity {
  did: string;
  verificationMethod: string;
  seed: Uint8Array;
  signer: Signer;
}

/** Mint an Ed25519 `did:key` (random seed unless one is given). No network. */
export function mintDidKey(seed?: Uint8Array): TestIdentity {
  const s = seed ?? crypto.getRandomValues(new Uint8Array(32));
  const signer = signerFromPrivateKey('ed25519', s);
  return { did: signer.did, verificationMethod: signer.verificationMethod, seed: s, signer };
}

/** A fixed seed: bytes 1..32. */
export function fixedSeed(offset = 0): Uint8Array {
  return new Uint8Array(32).map((_, i) => (i + 1 + offset) & 0xff);
}

export interface ChallengeDocOptions {
  id: string;
  now: Date;
  /** `null` omits the member (the helper never omits it; tests do). */
  recipient: string | null;
  /** Defaults to the issuer DID; `null` omits it. */
  subject?: string | null;
  /** Defaults to "login"; `null` omits it. */
  purpose?: string | null;
  /** Omit `issuedAt`. */
  omitIssuedAt?: boolean;
  threadId?: string;
}

export function challengeDoc(did: string, o: ChallengeDocOptions): TrustTaskDocument<Record<string, unknown>> {
  const payload: Record<string, unknown> = {};
  const subject = o.subject === undefined ? did : o.subject;
  if (subject !== null) payload.subject = subject;
  const purpose = o.purpose === undefined ? 'login' : o.purpose;
  if (purpose !== null) payload.purpose = purpose;
  const doc: TrustTaskDocument<Record<string, unknown>> = { id: o.id, type: CHALLENGE_TYPE_URI, issuer: did, payload };
  if (o.recipient !== null) doc.recipient = o.recipient;
  if (!o.omitIssuedAt) doc.issuedAt = o.now.toISOString();
  if (o.threadId !== undefined) doc.threadId = o.threadId;
  return doc;
}

export interface AuthenticateDocOptions {
  id: string;
  now: Date;
  recipient: string | null;
  challenge: string;
  sessionId: string;
  /** Extra payload members (scope, principal, delegationEvidence, sessionKey, …). */
  extraPayload?: Record<string, unknown>;
  omitIssuedAt?: boolean;
  /** Override `issuedAt` (ISO) — for window-edge tests. */
  issuedAt?: string;
  expiresAt?: string;
  /** Default "authentication" (S-61). */
  proofPurpose?: string;
  /** Default `now`. */
  created?: Date;
  /** Sign with a different identity (proof/issuer mismatch tests). */
  signWith?: TestIdentity;
  /** Leave the document unsigned. */
  unsigned?: boolean;
}

export function unsignedAuthenticateDoc(did: string, o: AuthenticateDocOptions): TrustTaskDocument<Record<string, unknown>> {
  const doc: TrustTaskDocument<Record<string, unknown>> = {
    id: o.id,
    type: AUTHENTICATE_TYPE_URI,
    issuer: did,
    payload: { challenge: o.challenge, sessionId: o.sessionId, ...(o.extraPayload ?? {}) },
  };
  if (o.recipient !== null) doc.recipient = o.recipient;
  if (!o.omitIssuedAt) doc.issuedAt = o.issuedAt ?? o.now.toISOString();
  if (o.expiresAt !== undefined) doc.expiresAt = o.expiresAt;
  return doc;
}

/** Build and (unless `unsigned`) sign an auth/authenticate/0.3 document. */
export function authenticateDoc(identity: TestIdentity, o: AuthenticateDocOptions): TrustTaskDocument<Record<string, unknown>> {
  const doc = unsignedAuthenticateDoc(identity.did, o);
  if (o.unsigned) return doc;
  return signAs(doc, o.signWith ?? identity, { proofPurpose: o.proofPurpose ?? 'authentication', created: o.created ?? o.now });
}

/**
 * Sign any document with `signTrustTask`. When the signer's DID differs from
 * the document's issuer (`signTrustTask` refuses that), the proof is made over
 * a copy with the signer as issuer and then grafted back — an
 * issuer-mismatched proof the verifier must refuse.
 */
export function signAs<P>(doc: TrustTaskDocument<P>, identity: TestIdentity, opts: { proofPurpose: string; created: Date }): TrustTaskDocument<P> {
  if (doc.issuer === identity.did) return signTrustTask(doc, identity.signer, opts);
  const signed = signTrustTask({ ...doc, issuer: identity.did }, identity.signer, opts);
  return { ...doc, proof: signed.proof };
}
