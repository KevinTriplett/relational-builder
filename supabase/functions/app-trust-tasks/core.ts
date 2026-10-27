// app-trust-tasks/core.ts — SPIKE STUB (Phase 1, design agent). Signatures only; see
// docs/spikes/openvtc-signin/DESIGN.md §2. Deno-free: all I/O via injected deps.
// Parameter names carry a `_` prefix only so the stub satisfies noUnusedParameters;
// the implementation drops the prefix.

import type {
  ConsumeChecks,
  ErrorPayload,
  ErrorResponse,
  PayloadValidator,
  ProofVerifier,
  ReplayGuard,
  TrustTaskDocument,
} from "npm:@openvtc/trust-tasks@0.26.29";

/** `auth/challenge/0.1` request Type URI (exact match). */
export const CHALLENGE_TYPE = "https://trusttasks.org/spec/auth/challenge/0.1" as const;
/** `auth/authenticate/0.3` request Type URI (exact match). */
export const AUTHENTICATE_TYPE = "https://trusttasks.org/spec/auth/authenticate/0.3" as const;
/** The Type URIs this consumer dispatches (S-41). Increment 2 adds `…/auth/authenticate/0.2`. */
export const REGISTERED_TYPES: readonly string[] = [CHALLENGE_TYPE, AUTHENTICATE_TYPE];

/** Default challenge lifetime (S-43; spec window 30 s–5 min). */
export const DEFAULT_CHALLENGE_TTL_MS = 120_000;
/** Default member-session lifetime, equal to app-data's SESSION_TTL_MS (S-47). */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Default acceptance window over `issuedAt` for authenticate (S-42). */
export const DEFAULT_ACCEPTANCE_WINDOW_MS = 300_000;
/** Requests per app per minute before 429 (S-40; same as app-data). */
export const RATE_LIMIT_PER_MIN = 120;
/** Reverse-DNS `ext` namespace carrying the Community Cloud member object (S-47). */
export const EXT_NAMESPACE = "org.relationalbuilder.cloud" as const;
/** proofPurpose values accepted (SPEC §4.7.3 item 1: the four signing relationships) (S-42). */
export const SIGNING_PROOF_PURPOSES: readonly string[] = [
  "authentication",
  "assertionMethod",
  "capabilityInvocation",
  "capabilityDelegation",
];
/** Extended error codes this consumer emits (S-43…S-46). */
export const CODES = {
  subjectNotRecognized: "auth/challenge:subjectNotRecognized",
  challengeNotFound: "auth/authenticate:challengeNotFound",
  challengeExpired: "auth/authenticate:challengeExpired",
  challengeMismatch: "auth/authenticate:challengeMismatch",
  subjectMismatch: "auth/authenticate:subjectMismatch",
  sessionKeyUnsupported: "auth/authenticate:sessionKeyUnsupported",
  delegationEvidenceRequired: "auth/authenticate:delegationEvidenceRequired",
  delegationNotRecognized: "auth/authenticate:delegationNotRecognized",
} as const;

/** The PostgREST seam every store uses (service-role, injected; no Deno). */
export interface PostgrestDeps {
  fetch: typeof fetch;
  restUrl: (path: string) => string;
  svcHeaders: () => Record<string, string>;
}

/** Per-app request budget; `hit` records one request and returns true when over the limit. */
export interface RateLimiter {
  hit(appId: string, nowMs: number): boolean;
}

/** Fixed-window in-isolate limiter, same semantics as app-data's isRateLimited (S-40). */
export class InMemoryRateLimiter implements RateLimiter {
  /** @param limitPerMin defaults to RATE_LIMIT_PER_MIN. */
  constructor(_limitPerMin?: number) {
    throw new Error("not implemented");
  }
  /** Record one request for `appId` at `nowMs`; true when this request exceeds the limit. */
  hit(_appId: string, _nowMs: number): boolean {
    throw new Error("not implemented");
  }
}

/** Everything handleTrustTask needs; index.ts builds it once per isolate. */
export interface CoreDeps extends PostgrestDeps {
  /** The only clock: consumeInbound `now`/`clock`, proof `created` skew, TTLs, timestamps. */
  now: () => Date;
  /** S-30: configured label, used as `myVid` and as `issuer` of every emitted document. */
  localVid: string;
  rateLimiter: RateLimiter;
  challengeTtlMs?: number;
  sessionTtlMs?: number;
  acceptanceWindowMs?: number;
  /** Default: defaultMemberToken (two randomUUIDs, dashes stripped, 64 hex). */
  memberTokenFactory?: () => string;
  /** Default: crypto.randomUUID. Used for error ids, response ids, session ids, challenge session ids. */
  randomUUID?: () => string;
  /** Default: crypto.getRandomValues. Used for the 32-byte challenge. */
  randomBytes?: (n: number) => Uint8Array;
  /** Server-side log sink (suppressed outcomes, store failures). Default: no-op. */
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

/** One inbound HTTP request, already split: query-string credentials + parsed body (undefined if unparseable). */
export interface CoreRequest {
  appId: string;
  appKey: string;
  rawBody: unknown;
}

/** What index.ts turns into a Response (headers come from status.ts responseHeaders). */
export interface CoreResponse {
  status: number;
  body?: unknown;
}

/** Result of classifying a `type` member against REGISTERED_TYPES (S-41). */
export type TypeClass = "challenge" | "authenticate" | "unsupportedVersion" | "unsupportedType";

/** The whole consumer: S-40 app auth → S-41 parse/dispatch → S-42 consumeInbound → S-43/S-44 handlers → S-50 status. */
export async function handleTrustTask(_deps: CoreDeps, _req: CoreRequest): Promise<CoreResponse> {
  throw new Error("not implemented");
}

/** S-30 default: `did:web:<host of SUPABASE_URL>` (host only, no port/path). */
export function localVidFromSupabaseUrl(_supabaseUrl: string): string {
  throw new Error("not implemented");
}

/** S-41: exact registered URI → handler; same slug, other version → unsupportedVersion; else unsupportedType. */
export function classifyType(_type: string): TypeClass {
  throw new Error("not implemented");
}

/** S-41 framework-shape check (id/type/payload/party/timestamp/proof member types); null when acceptable, else a wire-safe message. */
export function checkFrameworkShape(_doc: Record<string, unknown>): string | null {
  throw new Error("not implemented");
}

/** Build a trust-task-error with issuer = localVid, for failures with or without a parsed request (S-30, S-41). */
export function errorDocument(
  _deps: Pick<CoreDeps, "localVid" | "now" | "randomUUID">,
  _request: { id?: unknown; type?: unknown; issuer?: unknown; threadId?: unknown } | undefined,
  _payload: ErrorPayload,
): ErrorResponse {
  throw new Error("not implemented");
}

/** Overwrite `issuer` with localVid on any emitted document (runtime copies request.recipient) (S-30). */
export function stampIssuer<D extends TrustTaskDocument<unknown>>(_doc: D, _localVid: string): D {
  throw new Error("not implemented");
}

/** S-42 authenticate posture: CONSEQUENTIAL_FRESHNESS with maxAgeMs = windowMs, replay guarded by `guard`. */
export function authenticateChecks(_guard: ReplayGuard, _windowMs: number): ConsumeChecks {
  throw new Error("not implemented");
}

/** Wraps a verifier: proofPurpose must be in SIGNING_PROOF_PURPOSES, then delegates (S-42). */
export class PurposeCheckingVerifier implements ProofVerifier {
  constructor(_inner: ProofVerifier, _purposes?: readonly string[]) {
    throw new Error("not implemented");
  }
  /** False when proof.proofPurpose is not allowed; else the inner verdict. */
  verify<P>(_doc: TrustTaskDocument<P>): Promise<boolean> {
    throw new Error("not implemented");
  }
}

/** S-25: the JSON Schema keywords subsetSchemaValidator implements; anything else throws. */
export const SUPPORTED_SCHEMA_KEYWORDS: readonly string[] = [
  "$schema", "$id", "$anchor", "$defs", "$ref", "title", "description",
  "type", "properties", "additionalProperties", "required", "items",
  "minLength", "maxLength", "pattern", "format", "minimum", "minItems",
  "minProperties", "propertyNames",
];

/** S-25: throw if `schema` uses a keyword outside SUPPORTED_SCHEMA_KEYWORDS or a non-local $ref. */
export function assertSchemaSupported(_schema: unknown): void {
  throw new Error("not implemented");
}

/** S-25: hand-written draft 2020-12 subset validator for the bundled SPEC.payloadSchema values. */
export const subsetSchemaValidator: PayloadValidator = {
  validate(_schema: unknown, _payload: unknown): { ok: boolean; errors?: readonly string[] } {
    throw new Error("not implemented");
  },
};

/** Length-independent-time string comparison for the challenge (S-44 step 2). */
export function constantTimeEqual(_a: string, _b: string): boolean {
  throw new Error("not implemented");
}
