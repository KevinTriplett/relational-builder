# DESIGN — Trust Tasks sign-in spike, Increment 1

Phase 1 output of the design agent, 2026-10-26. Pins come from `BASE_SHA`: `@openvtc/trust-tasks@0.26.29`, `@openvtc/trust-tasks-proof@0.1.3`, `@noble/curves@2.4.0`. Runtime paths are under `node_modules/@openvtc/trust-tasks/src/_runtime/` (written `rt/` below). Generated task modules are under `node_modules/@openvtc/trust-tasks/src/auth/` (written `gen/`). Proof package paths are under `node_modules/@openvtc/trust-tasks-proof/dist/` (written `proof/`). Upstream docs are under `.spike-deps/dtgwg-trust-tasks-tf/` (written `up/`). Claims marked **(probed)** were also run against the installed package. The probe script is at `/private/tmp/claude-501/-Users-kevintriplett-Documents-Documents---Kevin-s-MacBook-Pro-BACKUP-PROJECTS-SOFTWARE-relational-builder/3e2df449-6548-43d7-a037-2cf61828649b/scratchpad/design/probe.mjs`.

## 1. Resolved questions

**Q1 (S-42). Does `UnauthenticatedTransport` make the in-band `issuer` authoritative?** Yes. `deriveParties()` returns `{}` (`rt/transport.ts:143-151`). `resolveParties` only reports a conflict when *both* the in-band and the transport value are present (`rt/transport.ts:77-83`), so it can never yield `identityMismatch`. The resolved `issuer` is `doc.issuer` (`:86`). As a result, the `suppressed` outcome cannot happen with this transport. Proof binding to `issuer` is the verifier's job (`proof/verifier.js:75-82`).

**Q2 (S-42). How does the runtime express "proof optional, verify if present"?** No separate policy kind exists or is needed. `{kind:"verify"}` verifies only `if (doc.proof !== undefined)` (`rt/consume.ts:425-458`). Absence is judged separately by `enforceSpecPolicy` against `spec.isProofRequired` (`rt/document.ts:317-323`). That flag is `false` for `AuthChallenge_v0_1.SPEC` (`gen/challenge/0.1/payload.ts:203`) and `true` for `AuthAuthenticate_v0_3.SPEC` (`gen/authenticate/0.3/payload.ts:509`). So the same `{kind:"verify", verify}` policy is correct for both tasks: optional for challenge, hard-required for authenticate. `verifyDetailed` is not needed. Two notes:
- The verifier does **not** check `proofPurpose` against SPEC §4.7.3 item 1. It only requires the field to be a non-empty string (`proof/verifier.js:50-54`). The consumer therefore wraps it in `PurposeCheckingVerifier` (amendment to S-42).
- The verifier's clock defaults to `Date.now` (`proof/verifier.d.ts` `VerifierOptions.now`). The implementation must pass `now: () => deps.now().getTime()`.

**Q3 (S-22). What is the exact `ReplayGuard` interface?** From `rt/replay.ts:86-132`, with `ReplayVerdict` from `:58-76`:
```ts
export type ReplayVerdict =
  | { kind: "fresh" }
  | { kind: "duplicate"; priorResponse?: unknown; inFlight: boolean }
  | { kind: "conflict" };
export interface ReplayGuard {
  claim(id: string, digest: string, retainUntil: number | undefined, now: number): Promise<ReplayVerdict> | ReplayVerdict;
  recordResponse?(id: string, response: unknown): Promise<void> | void;
  release?(id: string, digest: string): Promise<void> | void;
}
```
How `consumeInbound` uses the guard:
- **Digest.** The runtime computes it with `documentDigest(doc)` (sha256 hex of `canonicalJson`, `proof` included; `rt/replay.ts:53-55`).
- **Retention.** `retainUntil` is `recordExpiry(...)` (`rt/freshness.ts:168-183`). That is `expiresAt` when present, otherwise `issuedAt + maxAgeMs`. It is *not* `now + window`.
- **When `claim` runs.** It is called last, after every other check (`rt/consume.ts:471-518`).
- **Store failure.** If `claim` throws, the result is `unavailable` with `retryable:true` (`:489-501`).
- **Response recording.** `recordResponse` is best-effort, and its errors are swallowed (`:553-564`).
- **Release.** `release` runs only after a handler refusal whose `retryable === true` (`:533-535`). A non-retryable refusal is retained as the prior response (`:536`).
- **Handler throws.** A thrown handler error propagates out of `consumeInbound` and leaves the claim in flight (`:520`). **(probed)** An identical retry then gets `duplicate`, `inFlight:true`.

**Upstream defect, worked around in S-22.** The record can expire before the acceptance window closes:
- Freshness accepts a document while `issuedAt + maxAgeMs + skewMs ≥ now` (`rt/freshness.ts:143`).
- But `recordExpiry` returns `issuedAt + maxAgeMs` (`:182`), which is `skewMs` (60 s) earlier.
- A document accepted in that last minute is stored with a `retainUntil` already in the past. `InMemoryReplayGuard` then treats it as absent (`rt/replay.ts:209`), so a replay executes again. **(probed: 2 executions for one id.)**

`PostgresReplayGuard` pads `until_at` by `DEFAULT_SKEW_MS`.

**Q4 (§1.2). Does `auth/authenticate/0.3` or the HTTPS binding require a signed `#response`?** The binding does not require it, but the task spec does.
- **Binding.** HTTPS 0.2 imposes nothing on responses beyond `Content-Type` (`up/bindings/https/0.2/spec.md:44-50`, `:95`). Its §5 rule is about requests (`:129`, `:148`).
- **Task spec.** `auth/authenticate/0.3` declares a *single* `proofRequirement: REQUIRED` (`up/specs/auth/authenticate/0.3/spec.md:31-33`). SPEC §7.3 item 8 says a single requirement applies "to every document variant" (`up/SPEC.md`, §7.3 item 8, "The statement takes one of two forms"). The generated `RESPONSE_SPEC.isProofRequired` is `true` (`gen/authenticate/0.3/payload.ts:523`).
- **Conclusion.** The spec's §1.2 claim is **false**. Unsigned `#response` documents are a deviation. A client that runs `consumeInbound(RESPONSE_SPEC)` would reject them with `proofRequired`. Our helper does not run the pipeline on responses. Amended in §1.2.
- **Contradiction upstream.** The task spec's own response examples are unsigned (`spec.md:282-341`).
- **Challenge.** `auth/challenge/0.1` responses need no proof (`gen/challenge/0.1/payload.ts:217`).

**Q5 (S-42). Does the npm package export payload JSON schemas usable at runtime?** Yes, as values: `PAYLOAD_SCHEMA` and `RESPONSE_PAYLOAD_SCHEMA`, also carried on `SPEC.payloadSchema` (`gen/challenge/0.1/payload.ts:72,144,200-207`; `gen/authenticate/0.3/payload.ts:101,338,506-513`). Cross-file `$ref`s are already inlined. They are reachable as `AuthChallenge_v0_1` and `AuthAuthenticate_v0_3` from the package root (`src/index.ts:44-45`), or through the subpath `npm:@openvtc/trust-tasks@0.26.29/auth/authenticate/0.3/payload` (deno-checked). No JSON Schema *engine* ships with the package (`rt/consume.ts:197-205`, "bundles no JSON Schema implementation"). NF-3 forbids adding one, so S-25 introduces a hand-written subset validator. The keyword set used by all four schemas is: `$anchor $defs $id $ref $schema additionalProperties description format items maxLength minItems minLength minProperties minimum pattern properties propertyNames required title type`. Schemas are not vendored.

**Q6 (S-30). What does the runtime do when `recipient` is absent, and when it is present but mismatched?**
- **Present but mismatched.** `wrongRecipient` from `validateBasic` (`rt/document.ts:264-270`), which maps to 422. It is not `identityMismatch`, even though binding 0.2 §3 says it should be (`up/bindings/https/0.2/spec.md:63`). **(probed.)**
- **Absent.** `malformedRequest` (400), because **both tasks declare `recipient` REQUIRED**: `isRecipientRequired: true` (`gen/challenge/0.1/payload.ts:204`, `gen/authenticate/0.3/payload.ts:510`), enforced on the *in-band* member in `rt/document.ts:309-316`. **(probed.)** This holds even for the unsigned challenge. For a signed document, audience binding requires `recipient` anyway (`rt/document.ts:284`). A transport-derived recipient cannot fill the gap, because `enforceSpecPolicy` reads `doc.recipient` and not the resolved parties.
- **Consequence.** S-61 "recipient omitted" would fail every request. The browser must send `recipient = <service VID>` (new env key `TRUST_TASKS_VID`, S-71).
- **Error issuer.** The runtime's error documents set `issuer: request.recipient` (`rt/document.ts:369`). Under `wrongRecipient` that is the *other* VID (**probed**: `err issuer: did:web:other`). The consumer therefore re-stamps `issuer = localVid` on every emitted document (S-30).

**Q7 (S-50). Does the runtime provide an outcome→HTTP helper, and is S-50's mapping correct?**
- **Helper.** The TypeScript runtime has none (`rt/index.ts:13-93` exports nothing HTTP-related). The Rust `trust-tasks-https` crate has `status_for_code` (`up/trust-tasks-https/src/status.rs:54-86`). `status.ts` is hand-written.
- **Mapping.** S-50 is **resolved with corrections**, against binding 0.2 §4 (`up/bindings/https/0.2/spec.md:73-95`):
  1. A duplicate whose first execution is still in progress is **202** with an empty body. S-50 said 204. That is the binding row at `:77`.
  2. A duplicate whose execution completed without a retained response is 204 (`:78`).
  3. A duplicate *with* a retained response is answered with that document (`:93`). S-50 said 200. When the retained document is a `trust-task-error`, the amendment uses the status for its code instead. The binding is silent on this case, and the Rust server sends 200 (`server.rs:857-862`). See Risk R6.
  4. **suppressed:** S-50 said "no body, 204". The reference server instead answers with a generic `malformedRequest` and 400, so there is no 204-vs-400 oracle (`up/trust-tasks-https/src/server.rs:1076-1103`). The amendment follows that. The case is unreachable here (Q1).
  5. `cancelled` → 422, a row S-50 omitted (`:86`).
  6. An unknown standard code maps to 500, as the Rust server does (`status.rs:85`). Extended `slug:local` codes map to 422 (`status.rs:57`).
  7. 202 and 204 carry no `Content-Type` (`:95`).
  8. `OPTIONS` must answer 204 with CORS headers for browsers. That contradicts binding §2 item 1, "every other method → 405" (`:46`), and is recorded as a deviation. Other paths → 404, other methods → 405 (S-51).
  9. Rows S-50 got right: `malformedRequest` 400, `permissionDenied` 403, `idConflict` 409, `unavailable` 503, `internalError` 500. `unsupportedType`, `unsupportedVersion`, `expired`, `proofRequired`, `proofInvalid`, `identityMismatch`, `wrongRecipient` and `taskFailed` → 422, and `handled` → 200.

**Q8 (Phase 0a). Is the 0.19 `DataIntegrityProofVerifier` assignable to 0.26.29's `ProofVerifier`?** **Yes.**
- **Check file.** `/private/tmp/claude-501/-Users-kevintriplett-Documents-Documents---Kevin-s-MacBook-Pro-BACKUP-PROJECTS-SOFTWARE-relational-builder/3e2df449-6548-43d7-a037-2cf61828649b/scratchpad/design/check.ts`. It covers four cases: plain assignment to `ProofVerifier`, use inside `ProofPolicy`, the 0.19-typed `signTrustTask` result passed as `doc` to 0.26 `consumeInbound`, and the full call shape.
- **tsc.** `tsc 6.0.2` with `skipLibCheck: false` exits 0. Trace resolution shows the proof package's `@openvtc/trust-tasks` resolving to the nested `trust-tasks-proof/node_modules/@openvtc/trust-tasks@0.19.22/dist/index.d.ts`, so the 0.19-vs-0.26 comparison really happened.
- **Deno.** `deno check --no-config` on the same file (real `npm:` resolution) also exits 0.
- **Why it works.** The `ProofVerifier` and `TrustTaskDocument` declarations are textually identical in 0.19.22 and 0.26.29.
- **Workaround.** None needed.
- **Side finding.** Appendix A's `paths` entry `"npm:@openvtc/trust-tasks-proof@<PIN>": ["./node_modules/@openvtc/trust-tasks-proof"]` fails with `TS2307`. The proof package has no top-level `"types"` field, only `exports` (`node_modules/@openvtc/trust-tasks-proof/package.json:13-18`), and `paths`-to-directory resolution ignores `exports`. The mapping must target `dist/index.d.ts`. Amended.

**Q9 (Phase 0b). What does HTTPS binding 0.3 change?** It differs from 0.2 only by adding streamed responses: §2.1 SSE, opened by `Accept: text/event-stream`, with a new 200 `text/event-stream` row, and it is declared a MINOR (`up/bindings/https/0.3/spec.md:23-28, 60-117, 288`). Status mapping, identity mapping, §5.1 replay rules and §6 discovery are unchanged. Neither of our tasks is streamed, so 0.3 behaviour is identical to 0.2 for us. The spec stays on 0.2.

**Other false or incomplete spec statements, each fixed in §4.**
- (a) **S-61 signing.** S-61 says to sign with `signTrustTask` and S-60 wants a non-extractable WebCrypto key. `Signer.sign(hashData): Uint8Array` is **synchronous** (`proof/sign.d.ts:10`), and WebCrypto signing is async, so the two cannot be combined. The helper re-implements eddsa-jcs-2022 using the package's exported `canonicalBytes` and `toMultibase`. A fixture test asserts byte equality with `signTrustTask`.
- (b) **`signTrustTask` default purpose.** It defaults to `proofPurpose: "assertionMethod"` (`proof/sign.js:49`). It must be passed `"authentication"` explicitly.
- (c) **S-42 "the runtime's `ISSUED_AT_REQUIRED` rejection".** The code is `malformedRequest` (400), with that constant as its message (`rt/freshness.ts:149`).
- (d) **S-42 window.** `consequentialChecks(guard)` hard-codes `CONSEQUENTIAL_FRESHNESS` (`rt/consume.ts:124-126`). A configurable window needs a `ConsumeChecks` literal.
- (e) **S-43 `threadId`.** `respondWith` sets `threadId = request.threadId ?? request.id` (`rt/document.ts:426`).
- (f) **S-41 versions.** Another version of a registered slug is `unsupportedVersion`, not `unsupportedType`, per SPEC §8.3.
- (g) **S-41 envelope.** The runtime checks no framework envelope shape (no `id`, `payload` or member types; `rt/consume.ts:48-49`), so `core.ts` must.
- (h) **S-40 order.** `app-data` rate-limits *before* the app lookup (`supabase/functions/app-data/index.ts:135` vs `:139`).
- (i) **Kit wiring.** `KIT_FILES` is merged only on the framework-preview and publish paths (`src/components/preview/FrameworkPreview.tsx:78`, `src/project/build-for-publish.ts:76`). The helper must be registered in `src/kit/index.ts`, and it is unavailable to Sandpack-routed "simple tools".
- (j) **S-60 `isEd25519Available()`.** It is necessarily async.
- (k) **Order of checks.** The runtime validates the payload schema *before* expiry, recipient or proof (`rt/consume.ts:383` vs `:408`).

## 2. Public interfaces

Stubs exist at these paths, and their bodies throw `not implemented`. Stub parameter names carry a `_` prefix only to satisfy `noUnusedParameters`; the implementation drops the prefix. All npm imports use the exact pins.

### `supabase/functions/app-trust-tasks/core.ts` (Deno-free)
```ts
export const CHALLENGE_TYPE = "https://trusttasks.org/spec/auth/challenge/0.1";        // as const
export const AUTHENTICATE_TYPE = "https://trusttasks.org/spec/auth/authenticate/0.3";  // as const
export const REGISTERED_TYPES: readonly string[] = [CHALLENGE_TYPE, AUTHENTICATE_TYPE];
export const DEFAULT_CHALLENGE_TTL_MS = 120_000;
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_ACCEPTANCE_WINDOW_MS = 300_000;
export const RATE_LIMIT_PER_MIN = 120;
export const EXT_NAMESPACE = "org.relationalbuilder.cloud";                            // as const
/** SPEC §4.7.3 item 1 signing relationships. */
export const SIGNING_PROOF_PURPOSES: readonly string[];  // authentication, assertionMethod, capabilityInvocation, capabilityDelegation
/** Extended codes emitted (S-43…S-46). */
export const CODES: { readonly subjectNotRecognized: "auth/challenge:subjectNotRecognized"; readonly challengeNotFound: "auth/authenticate:challengeNotFound";
  readonly challengeExpired: "auth/authenticate:challengeExpired"; readonly challengeMismatch: "auth/authenticate:challengeMismatch";
  readonly subjectMismatch: "auth/authenticate:subjectMismatch"; readonly sessionKeyUnsupported: "auth/authenticate:sessionKeyUnsupported";
  readonly delegationEvidenceRequired: "auth/authenticate:delegationEvidenceRequired"; readonly delegationNotRecognized: "auth/authenticate:delegationNotRecognized" };
/** PostgREST seam used by every store. */
export interface PostgrestDeps { fetch: typeof fetch; restUrl: (path: string) => string; svcHeaders: () => Record<string, string>; }
/** `hit` records one request; true when over the limit. */
export interface RateLimiter { hit(appId: string, nowMs: number): boolean; }
/** Fixed 60 s window per appId, app-data semantics (S-40). */
export class InMemoryRateLimiter implements RateLimiter { constructor(limitPerMin?: number); hit(appId: string, nowMs: number): boolean; }
export interface CoreDeps extends PostgrestDeps {
  now: () => Date;                 // the only clock (S-42 clock seam)
  localVid: string;                // S-30
  rateLimiter: RateLimiter;        // S-40
  challengeTtlMs?: number; sessionTtlMs?: number; acceptanceWindowMs?: number;
  memberTokenFactory?: () => string;           // default defaultMemberToken
  randomUUID?: () => string;                   // default crypto.randomUUID
  randomBytes?: (n: number) => Uint8Array;     // default crypto.getRandomValues
  log?: (event: string, detail?: Record<string, unknown>) => void;
}
export interface CoreRequest { appId: string; appKey: string; rawBody: unknown; }   // rawBody undefined = unparseable JSON
export interface CoreResponse { status: number; body?: unknown; }
export type TypeClass = "challenge" | "authenticate" | "unsupportedVersion" | "unsupportedType";
/** S-40 → S-41 → S-42 → S-43/S-44 → S-50. Never throws. */
export async function handleTrustTask(deps: CoreDeps, req: CoreRequest): Promise<CoreResponse>;
/** `did:web:<hostname>` (+ `%3A<port>` if an explicit non-default port) of SUPABASE_URL (S-30, C-25). */
export function localVidFromSupabaseUrl(supabaseUrl: string): string;
/** S-41 dispatch class. */
export function classifyType(type: string): TypeClass;
/** S-41 envelope check; null or a wire-safe message. */
export function checkFrameworkShape(doc: Record<string, unknown>): string | null;
/** trust-task-error with issuer = localVid; works without a parsed request (S-30, S-41). */
export function errorDocument(deps: Pick<CoreDeps, "localVid" | "now" | "randomUUID">,
  request: { id?: unknown; type?: unknown; issuer?: unknown; threadId?: unknown } | undefined, payload: ErrorPayload): ErrorResponse;
/** Returns doc with issuer = localVid (S-30). */
export function stampIssuer<D extends TrustTaskDocument<unknown>>(doc: D, localVid: string): D;
/** {freshness: {...CONSEQUENTIAL_FRESHNESS, maxAgeMs: windowMs}, replay: {kind:"guard", guard}} (S-42). */
export function authenticateChecks(guard: ReplayGuard, windowMs: number): ConsumeChecks;
/** Rejects proofPurpose ∉ purposes (default SIGNING_PROOF_PURPOSES), else delegates (S-42). */
export class PurposeCheckingVerifier implements ProofVerifier { constructor(inner: ProofVerifier, purposes?: readonly string[]); verify<P>(doc: TrustTaskDocument<P>): Promise<boolean>; }
export const SUPPORTED_SCHEMA_KEYWORDS: readonly string[];   // the 20 keywords listed in Q5
/** Throws on any other keyword or a non-`#/$defs/…` $ref (S-25). */
export function assertSchemaSupported(schema: unknown): void;
/** Draft 2020-12 subset validator; unknown keyword → throws (S-25). */
export const subsetSchemaValidator: PayloadValidator;
/** Constant-time over max(len) (S-44 step 2). */
export function constantTimeEqual(a: string, b: string): boolean;
```
Types are imported from `npm:@openvtc/trust-tasks@0.26.29`: `ConsumeChecks, ErrorPayload, ErrorResponse, PayloadValidator, ProofVerifier, ReplayGuard, TrustTaskDocument`. The implementation also imports `consumeInbound, UnauthenticatedTransport, notConsequentialChecks, CONSEQUENTIAL_FRESHNESS, TRUST_TASK_ERROR_TYPE_URI, rejectWith, respondWith, normalizeCode, slugFromTypeUri, AuthChallenge_v0_1, AuthAuthenticate_v0_3` from the same specifier, and `DataIntegrityProofVerifier` from `npm:@openvtc/trust-tasks-proof@0.1.3`.

### `challenges.ts`
```ts
export interface IssueInput { appId: string; subject?: string; ttlMs: number; }
export interface IssuedChallenge { sessionId: string; challenge: string; expiresAt: Date; }
export type LookupResult = { kind: "notFound" } | { kind: "expired" } | { kind: "ok"; challenge: string; subject: string | null };
export interface ChallengeStoreDeps extends PostgrestDeps { now: () => Date; randomUUID?: () => string; randomBytes?: (n: number) => Uint8Array; }
export class PostgresChallengeStore {
  constructor(deps: ChallengeStoreDeps);
  /** S-20; 409 → one retry with a new uuid, then throw. */
  issue(input: IssueInput): Promise<IssuedChallenge>;
  /** S-21 single PATCH. */
  lookupAndConsume(input: { appId: string; sessionId: string; now: Date }): Promise<LookupResult>;
  /** S-23; never throws. */
  sweep(): Promise<void>;
}
/** 32 bytes → base64url, no padding (43 chars). */
export function generateChallenge(randomBytes?: (n: number) => Uint8Array): string;
```

### `replay.ts`
```ts
export const DEFAULT_RETENTION_PAD_MS: number;   // = DEFAULT_SKEW_MS (60_000) from the runtime
export interface ReplayGuardDeps extends PostgrestDeps {
  appId: string; retentionPadMs?: number;
  acceptanceWindowMs?: number;   // C-39: until_at cap = now + window + 2·DEFAULT_SKEW_MS; default DEFAULT_ACCEPTANCE_WINDOW_MS
  log?: (event: string, detail?: Record<string, unknown>) => void;   // C-40: release failures
}
/** S-22/S-24 */
export class PostgresReplayGuard implements ReplayGuard {
  constructor(deps: ReplayGuardDeps);
  claim(id: string, digest: string, retainUntil: number | undefined, now: number): Promise<ReplayVerdict>;
  recordResponse(id: string, response: unknown): Promise<void>;   // C-40: P9, one retry, then throw
  release(id: string, digest: string): Promise<void>;              // C-40: never throws
}
```

### `members.ts`
```ts
export interface MemberRow { id: string; email: string | null; name: string | null; did: string | null; }
/** GET → else POST → 409 → GET (S-47). */
export async function upsertMemberByDid(deps: PostgrestDeps, appId: string, did: string): Promise<MemberRow>;
/** Inserts app_sessions; returns token (S-47). */
export async function mintMemberToken(deps: PostgrestDeps & { memberTokenFactory: () => string },
  input: { appId: string; memberId: string; expiresAt: Date }): Promise<string>;
/** 64 lowercase hex, authVerify scheme (app-data/index.ts:615). */
export function defaultMemberToken(randomUUID?: () => string): string;
```

### `status.ts`
```ts
export const CORS_HEADERS: Readonly<Record<string, string>>;  // == app-data CORS (index.ts:67-71)
export interface HttpResult { status: number; body?: unknown; log?: string; }
/** Binding 0.2 §4 table, as amended in S-50. */
export function statusForCode(code: string): number;
/** S-50 outcome mapping; genericMalformed builds the suppressed body. */
export function mapOutcomeToHttp(outcome: ConsumeOutcome<unknown>, genericMalformed: () => ErrorResponse): HttpResult;
/** CORS + Cache-Control: no-store (+ Content-Type: application/json iff body). */
export function responseHeaders(hasBody: boolean): Record<string, string>;
/** {status, body:{error}} (S-40). */
export function plainError(status: number, error: string): HttpResult;
```

### `src/integrations/catalog.ts` (additions, C-26)
```ts
export const TRUST_SIGNIN_KEYS = ['TRUST_TASKS_URL', 'TRUST_TASKS_VID'];
/** communityCloudConnected(vars) && every TRUST_SIGNIN_KEYS value non-blank (S-70). */
export function trustSigninConnected(vars: EnvVar[]): boolean;
/** Guidance text (S-70); stub is ''. */
export const TRUST_SIGNIN_GUIDANCE: string;
```

### `index.ts`
`Deno.serve` glue only (S-51). It exports nothing, and it is the only file that may touch `Deno.*`.

### `src/kit/files/lib/trust-signin.ts` (bare imports: `@openvtc/trust-tasks-proof`, `@noble/curves/ed25519.js` only — C-51 drops the type-only `@openvtc/trust-tasks` import; `TrustTaskDocument<P>` is declared locally)
```ts
export const MEMBER_TOKEN_KEY = 'member_token';
// C-37: IDENTITY_KEY ('rb.trust-signin.identity.v1') is REMOVED — no shared identity.
export const IDENTITY_KEY_PREFIX = 'rb.trust-signin.identity.v2:';
/** C-37: IDENTITY_KEY_PREFIX + appId.trim().toLowerCase(); blank/non-string → TrustSignInError('invalidAppId', false, 0). SPIKE marker 'shared origin' (C-38). */
export function identityKeyForApp(appId: string): string;
export type Custody = 'webcrypto' | 'software';
export interface DeviceIdentity { did: string; verificationMethod: string; custody: Custody; kind: 'bootstrap'; sign(bytes: Uint8Array): Promise<Uint8Array>; }
export interface IdentityStore { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void>; }
export interface GetIdentityOptions { appId: string; store?: IdentityStore; allowInMemoryFallback?: boolean; }   // C-37: appId required
export interface SignInOptions { recipient: string; identity?: DeviceIdentity; identityStore?: IdentityStore;   // C-37: identityStore added
  fetch?: typeof fetch; now?: () => Date; randomUUID?: () => string; storage?: Pick<Storage, 'setItem'>; }
export interface TrustMember { id: string; did: string; name: string | null; email: null; }
export interface SignInResult { member_token: string; member: TrustMember | null; did: string; }
/** code 'transport' for non-JSON failures (S-61 step 4). */
export class TrustSignInError extends Error { readonly code: string; readonly retryable: boolean; readonly status: number; constructor(code: string, retryable: boolean, status: number, message?: string); }
export async function isEd25519Available(): Promise<boolean>;
export function indexedDbIdentityStore(dbName?: string): IdentityStore;
/** S-60; no network. C-37: one identity per app, stored under identityKeyForApp(options.appId) only; options now required. */
export async function getOrCreateIdentity(options: GetIdentityOptions): Promise<DeviceIdentity>;
export function buildChallengeDocument(did: string, recipient: string, now: Date, id: string): TrustTaskDocument<{ subject: string; purpose: string }>;
export function buildAuthenticateDocument(did: string, recipient: string, now: Date, id: string,
  challenge: { challenge: string; sessionId: string }): TrustTaskDocument<{ challenge: string; sessionId: string }>;
/** eddsa-jcs-2022, proofPurpose 'authentication', bytes ≡ signTrustTask. */
export async function signDocument<P>(doc: TrustTaskDocument<P>, identity: DeviceIdentity, created: Date): Promise<TrustTaskDocument<P>>;
/** S-61. */
export async function signIn(endpointBase: string, appId: string, appKey: string, options: SignInOptions): Promise<SignInResult>;
/** S-62. */
export function shortDid(did: string): string;
```

## 3. Fake PostgREST contract

`restUrl(p) = ${SUPABASE_URL}/rest/v1${p}`. Every request carries `svcHeaders()` = `{apikey, Authorization: "Bearer <svc>", "Content-Type": "application/json"}`, plus `Prefer` where listed. Filter values are `encodeURIComponent`-encoded and timestamps are `Date#toISOString()`. The fake must parse the query string (parameter order is not significant), compare timestamps as instants, and throw on any path, method, operator or `Prefer` value not listed. The `select=` column set must **equal** the listed set, order-insensitive (C-35). Every filter value except `select` is `encodeURIComponent`-encoded exactly once. The fake decodes as PostgREST does: `+` → space, then percent-decoding (C-36). Unique violations return `409 {"code":"23505","message":…}`. The fake must also support fault injection: `fetch` rejects, or answers 503.

| # | Method + path ? query | Prefer | Body | Success response | Other modelled responses |
|---|---|---|---|---|---|
| P1 | `GET /cloud_apps?id=eq.{appId}&select=id,app_key,trust_signin_enabled` | — | — | 200 `[{id,app_key,trust_signin_enabled}]` or `[]` | 400 if `appId` is not a uuid (PostgREST behaviour) |
| P2 | `POST /app_tt_challenges` | `return=minimal` | `{session_id,app_id,subject:string\|null,challenge,expires_at}` | 201, empty body | 409 duplicate `session_id` |
| P3 | `PATCH /app_tt_challenges?session_id=eq.{sid}&app_id=eq.{appId}&consumed_at=is.null` | `return=representation` | `{consumed_at}` | 200, array of updated full rows (`session_id,app_id,subject,challenge,expires_at,consumed_at,created_at`), `[]` when none | — |
| P4 | `DELETE /app_tt_challenges?expires_at=lt.{iso}` | — | — | 204 | — |
| P5 | `POST /app_tt_replay` | `return=minimal` | `{doc_id,app_id,digest,response:null,until_at}` | 201, empty | 409 duplicate `doc_id` |
| P6 | `GET /app_tt_replay?doc_id=eq.{id}&select=app_id,digest,response,until_at` | — | — | 200 `[row]` or `[]` | — |
| P7 | `DELETE /app_tt_replay?doc_id=eq.{id}&until_at=lte.{iso}` | — | — | 204 | — |
| P8 | `DELETE /app_tt_replay?until_at=lt.{iso}` | — | — | 204 | — |
| P9 | `PATCH /app_tt_replay?doc_id=eq.{id}&app_id=eq.{appId}` | `return=minimal` | `{response:<document>}` | 204 | — |
| P10 | `DELETE /app_tt_replay?doc_id=eq.{id}&app_id=eq.{appId}&digest=eq.{digest}&response=is.null` | — | — | 204 | — |
| P11 | `GET /app_members?app_id=eq.{appId}&did=eq.{did}&select=id,email,name,did` | — | — | 200 `[row]` or `[]` | — |
| P12 | `POST /app_members` | `return=representation` | `{app_id,did,email:null,name:null}` | 201 `[{id,app_id,email,name,did,created_at}]`, `id` a fresh uuid | 409 duplicate `(app_id,did)` where `did` is not null |
| P13 | `POST /app_sessions` | `return=minimal` | `{token,app_id,member_id,expires_at}` | 201, empty | 409 duplicate `token` |

When each call is issued:
- **P1:** once per request, after the 401 and 429 checks.
- **P2:** on challenge success.
- **P3:** once per authenticate that reaches the handler.
- **P4:** fire-and-forget after P2.
- **P5:** at claim. P8 is fire-and-forget after a 201 on P5. P6 runs after a 409 on P5. P7 runs when the P6 row has expired, and is followed by a single retry of P5.
- **P9:** after the handler returns a document, or a non-retryable refusal. *(C-40)* Issued a second time only if the first rejects or answers non-2xx.
- **P10:** after a retryable refusal, at most once. *(C-40)* Its failure is logged and swallowed.
- **P11–P13:** on authenticate success.

Operators used: `eq.`, `lt.`, `lte.`, `is.null`, plus `select=` and the two `Prefer` values. Not used: `order=`, `limit=` (S-12 changelog).

## 4. Spec amendments (applied to SPIKE-SPEC.md, mirrored in its Changelog)

```diff
 §1.2  - "auth/authenticate 0.3 does not declare the #response proof REQUIRED. Verify…"
       + False (Q4): single proofRequirement REQUIRED covers #response (SPEC §7.3 i8; RESPONSE_SPEC.isProofRequired=true).
       +   Unsigned responses are a recorded deviation; the binding itself requires none.
 §2    ~ diagram: challenge/authenticate carry recipient = TRUST_TASKS_VID; payloadPolicy uses SPEC.payloadSchema + subset validator
 S-12  + (new) fake-postgrest operator list = DESIGN §3 (adds lte., POST/DELETE, Prefer: return=minimal; drops order=/limit=)
 S-21  ~ invalid sessionId still a single PATCH; store failure → handler answers `unavailable`
 S-22  ~ retainUntil comes from the runtime (recordExpiry), padded by DEFAULT_SKEW_MS (Q3 defect); exact claim algorithm
 S-24  + (new) guard is app-scoped: another app's row ⇒ conflict, never its retained response
 S-25  + (new) subsetSchemaValidator + assertSchemaSupported over the bundled schemas
 S-30  ~ default localVid = did:web:<host of SUPABASE_URL>; EVERY emitted document's issuer = localVid
 S-40  ~ order: 401 → 429 → app lookup (403/503) → disabled 403 (rate limit before lookup, as app-data)
 S-41  ~ unparseable JSON → 400; same-slug other version → unsupportedVersion; envelope shape check → 400
 S-42  ~ ConsumeChecks literal for the window; issuedAt-missing = malformedRequest; PurposeCheckingVerifier; clock seam
 S-43  ~ respondWith (threadId = threadId ?? id); store failure → unavailable
 S-44  ~ explicit order incl. acting party = principal ?? issuer before S-46/S-45; retryable refusal releases the claim
 S-50  ~ corrected per Q7 (202 in-flight, suppressed→400 generic, retained error→its code, cancelled, unknown→500)
 S-51  + (new) index.ts routing: POST …/trust-tasks; OPTIONS 204; other path 404; other method 405
 S-60  ~ isEd25519Available async; DeviceIdentity.sign async
 S-61  ~ recipient = options.recipient on both docs; signDocument (WebCrypto) ≡ signTrustTask bytes; purpose authentication
 S-63  + (new) kit wiring: KIT_FILES entry + PINNED_VERSIONS; framework-shaped projects only
 S-70  ~ TRUST_SIGNIN_KEYS = ['TRUST_TASKS_URL','TRUST_TASKS_VID']
 S-71  + (new) Builder sets TRUST_TASKS_URL (Trust-Task base) and TRUST_TASKS_VID
 §12   ~ table adds S-12, S-24, S-25, S-51, S-63, S-71
 App.A ~ proof path → dist/index.d.ts (Q8); pins filled
```
These are applied in place and recorded as Changelog entries C-1 through C-24. `S-31`/`S-32` are v1 references only (C-24). No requirement was weakened. No id was removed or reused.

## 5. Risks not resolvable by reading

- **R1 Cold start.** Importing the package root loads about 285 generated modules. The Phase 0 cold `deno eval` took about 4.5 s. The real cold start on Supabase and the benefit of subpath imports are unmeasured until Phase 5.
- **R2 Plugin compatibility.** The OpenVTC browser plugin sends `auth/authenticate/0.2`, which gets `unsupportedVersion`. It is unknown whether it sends `recipient`, which VID it would use, or whether it verifies responses and rejects our unsigned ones.
- **R3 `localVid` agreement.** The Builder's `TRUST_TASKS_VID` must equal the server's `localVid`. An operator who sets `TRUST_TASKS_LOCAL_VID` without updating the Builder breaks every sign-in with `wrongRecipient`. Only a deployed trial shows how fragile this is.
- **R4 WebCrypto Ed25519 coverage.** Coverage in target browsers, and IndexedDB structured-clone of non-extractable `CryptoKey`s (Safari private mode, Firefox), is unknown. The software fallback is gated off by default.
- **R5 Bundled schema subset.** The hand-rolled validator covers only the 20 keywords present. A future pin bump that adds a keyword is caught by S-25's test, not at runtime.
- **R6 Replay of a retained error.** It is answered with the code's status, not the 200 the reference Rust server uses. A strict 0.2 client may expect 200. This interpretation needs upstream confirmation.
- **R7 Fake PostgREST vs real.** Partial unique index 409 bodies, `Prefer: return=minimal` status codes (201 vs 204), and PATCH-returns-array behaviour must be confirmed against real Supabase in Phase 5.
- **R8 Bearer material retained.** `app_tt_replay.response` holds the access token for about 6 minutes, and an identical resend of a captured signed document returns it. This is the binding's own §5.1 behaviour, and it is acceptable only over TLS.
- **R9 Builder UI with `email = null` members.** The Cloud tab renders `m.name || m.email` (`src/components/CloudPanel.tsx:554`), which produces blank rows. `CloudMember.email: string` (`src/cloud/community-cloud.ts:46`) becomes a lie. `admin_restore_backup`'s member upsert has not been checked with null emails. All of this is outside S-52's allowed diff.
- **R10 esm.sh delivery of the proof package.** `@openvtc/trust-tasks-proof@0.1.3` as delivered by esm.sh in generated apps is untested, including its nested `^0.19` core range and `@noble/*` v2 subpath exports.
- **R11 Handler throw leaves the claim in flight.** If a handler throws (for example, a DB outage after the challenge was consumed), retries get 202 until the record expires (Q3). The core must catch store errors inside handlers and return `unavailable`. Whether every path does is a review item.
- **R12 Shared hosting origin (C-38).** Every hosted app and every Builder framework preview shares one origin, so any of them can *use* any app's non-extractable device key. Per-app keys (C-37) stop correlation, not impersonation. Trial-only enablement; per-app origins are a production prerequisite.

## 6. REVIEW-1 amendments (2026-10-28)

Changelog C-37 to C-52 in `SPIKE-SPEC.md` answer `REVIEW-1.md`. Design elements that change:

**§2 signature changes (explicit).** Only the helper's and `replay.ts`'s surfaces change. `core.ts`, `challenges.ts`, `members.ts`, `status.ts` and `catalog.ts` signatures are unchanged.
- `trust-signin.ts` (C-37): `IDENTITY_KEY` is **removed**. Added: `IDENTITY_KEY_PREFIX = 'rb.trust-signin.identity.v2:'` and `identityKeyForApp(appId)`. `GetIdentityOptions.appId` is **required**, and `getOrCreateIdentity(options)` no longer takes an optional argument. `SignInOptions.identityStore?` is added. `signIn` passes its own `appId` through. This is a breaking change to the helper's surface. Nothing is deployed, so nothing migrates.
- `trust-signin.ts` (C-51): no import from `@openvtc/trust-tasks`. `TrustTaskDocument<P>` is a local type with the same structural shape, so exported signatures read the same.
- `replay.ts` (C-39, C-40): `ReplayGuardDeps` gains optional `acceptanceWindowMs` and `log`. This is additive: existing constructions still compile.

**Behaviour changes without a signature change.**
- *Replay retention cap (C-39).* `until_at = min(retainUntil + pad, now + acceptanceWindowMs + 2·DEFAULT_SKEW_MS)`. Q3's pad still covers the runtime's `recordExpiry` gap, and the cap stops a producer's `expiresAt` from choosing retention. `core.ts` passes the same window to the guard and to `authenticateChecks`.
- *Total release (C-40).* `release` catches and logs, so a store outage during a retryable refusal stays 503 `unavailable`. `recordResponse` retries P9 once.
- *Schema walk (C-41).* `items`, `propertyNames` and a schema-valued `additionalProperties` are single sub-schemas, and `properties`/`$defs` are maps. The validator asserts the whole schema before validating, so R5's guard works at any depth. `required` uses own properties.
- *Verifier (C-42).* `DataIntegrityProofVerifier({now, cryptosuites: ["eddsa-jcs-2022"]})`, plus a `verificationMethod === issuer + "#" + multibase` check composed in `core.ts`, outside `PurposeCheckingVerifier`.
- *Envelope (C-43).* `checkFrameworkShape` applies the `date-time` rule to `issuedAt`/`expiresAt` and requires a string `parentThreadId`.
- *Status (C-45).* `unsupportedExtension` → 422.
- *Helper (C-52).* Each 200 must be `<request type>#response` with `threadId === request id`.

**Recorded deviations added (each with a `// SPIKE:` phrase, C-49).** These are: shared-origin key use (C-38), expiry before mismatch (C-44), retained-error status (C-45), the rate-limit axis and no `rateLimited` (C-46), self-enrolment (C-47), and per-service audience binding (C-48). The envelope checks not done are C-43.
