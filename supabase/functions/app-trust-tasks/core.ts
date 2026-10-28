// app-trust-tasks/core.ts — the consumer core (S-25, S-30, S-40…S-50).
// See docs/spikes/openvtc-signin/DESIGN.md §2. Deno-free: all I/O via injected deps
// (PostgREST `fetch`, the `now` clock, `randomUUID`/`randomBytes`).
//
// SPIKE: unsigned responses; local_vid is a label

import {
  AuthAuthenticate_v0_3,
  AuthChallenge_v0_1,
  CONSEQUENTIAL_FRESHNESS,
  TRUST_TASK_ERROR_TYPE_URI,
  UnauthenticatedTransport,
  consumeInbound,
  notConsequentialChecks,
  rejectWith,
  respondWith,
  slugFromTypeUri,
  type ConsumeChecks,
  type ErrorPayload,
  type ErrorResponse,
  type PayloadValidator,
  type ProofVerifier,
  type ReplayGuard,
  type TrustTaskDocument,
} from "npm:@openvtc/trust-tasks@0.26.29";
import { DataIntegrityProofVerifier, publicKeyFromDidKey } from "npm:@openvtc/trust-tasks-proof@0.1.3";
import { PostgresChallengeStore } from "./challenges.ts";
import { PostgresReplayGuard } from "./replay.ts";
import { defaultMemberToken, mintMemberToken, upsertMemberByDid } from "./members.ts";
import { mapOutcomeToHttp, plainError } from "./status.ts";

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

// SPIKE: in-isolate rate limiter — per Supabase isolate, not global (same as app-data).
/** Fixed-window in-isolate limiter, same semantics as app-data's isRateLimited (S-40). */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly limit: number;
  private readonly buckets = new Map<string, { count: number; windowStart: number }>();
  /** @param limitPerMin defaults to RATE_LIMIT_PER_MIN. */
  constructor(limitPerMin: number = RATE_LIMIT_PER_MIN) {
    this.limit = limitPerMin;
  }
  /** Record one request for `appId` at `nowMs`; true when this request exceeds the limit. */
  hit(appId: string, nowMs: number): boolean {
    const bucket = this.buckets.get(appId);
    if (!bucket || nowMs - bucket.windowStart > 60_000) {
      this.buckets.set(appId, { count: 1, windowStart: nowMs });
      return 1 > this.limit;
    }
    bucket.count += 1;
    return bucket.count > this.limit;
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

type Doc = TrustTaskDocument<Record<string, unknown>>;

// Wire-safe constant messages: they name no DID, challenge, session id or token (S-44).
const MSG = {
  malformedBody: "request body must be a JSON object with a string type (SPEC §7.2 item 1)",
  unsupportedType: "this consumer does not accept that Trust Task type",
  unsupportedVersion: "this consumer does not accept that version of the Trust Task",
  unavailable: "temporarily unavailable",
  subjectNotRecognized: "subject must be an Ed25519 did:key",
  challengeNotFound: "no outstanding challenge for this session",
  challengeExpired: "the challenge has expired; request a new one",
  challengeMismatch: "the challenge does not match",
  subjectMismatch: "the challenge was issued to a different subject",
  sessionKeyUnsupported: "sessionKey binding is not supported by this consumer",
  delegationEvidenceRequired: "a principal other than the issuer requires delegationEvidence",
  delegationNotRecognized: "delegated authentication is not supported by this consumer",
  suppressed: "malformed request",
} as const;

const ED25519_DID_KEY = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/;

function nowIso(deps: Pick<CoreDeps, "now">): () => string {
  return () => deps.now().toISOString();
}

function uuidOf(deps: Pick<CoreDeps, "randomUUID">): () => string {
  return deps.randomUUID ?? (() => crypto.randomUUID());
}

/** The whole consumer: S-40 app auth → S-41 parse/dispatch → S-42 consumeInbound → S-43/S-44 handlers → S-50 status. */
export async function handleTrustTask(deps: CoreDeps, req: CoreRequest): Promise<CoreResponse> {
  try {
    return await handleInner(deps, req);
  } catch (e) {
    // Never throws (DESIGN §2): anything unforeseen becomes a 500 internalError.
    deps.log?.("app-trust-tasks.internalError", { error: e instanceof Error ? e.message : String(e) });
    const body = isPlainObject(req.rawBody) ? req.rawBody : undefined;
    return { status: 500, body: errorDocument(deps, body, { code: "internalError", message: "internal error", retryable: false }) };
  }
}

async function handleInner(deps: CoreDeps, req: CoreRequest): Promise<CoreResponse> {
  // S-40 (C-6): 401 → 429 → lookup (403/503) → disabled 403. All plain JSON.
  const { appId, appKey } = req;
  if (!appId || !appKey) return plainError(401, "app_id and app_key required");
  if (deps.rateLimiter.hit(appId, deps.now().getTime())) {
    return plainError(429, "Rate limit exceeded — try again in a minute");
  }
  const app = await lookupApp(deps, appId);
  if (app === "unavailable") return plainError(503, "Service unavailable");
  if (app === null || app.app_key !== appKey) return plainError(403, "Unknown app or wrong key");
  if (app.trust_signin_enabled !== true) return plainError(403, "Trust Task sign-in is not enabled for this app");

  // S-41: parse and dispatch.
  const raw = req.rawBody;
  const malformed = (message: string, request?: Record<string, unknown>): CoreResponse => ({
    status: 400,
    body: errorDocument(deps, request, { code: "malformedRequest", message, retryable: false }),
  });
  if (!isPlainObject(raw) || typeof raw.type !== "string") {
    return malformed(MSG.malformedBody, isPlainObject(raw) ? raw : undefined);
  }
  const cls = classifyType(raw.type);
  if (cls === "unsupportedType" || cls === "unsupportedVersion") {
    return {
      status: 422,
      body: errorDocument(deps, raw, { code: cls, message: MSG[cls], retryable: false }),
    };
  }
  const shape = checkFrameworkShape(raw);
  if (shape !== null) return malformed(shape, raw);

  const doc = raw as unknown as Doc;
  return cls === "challenge" ? runChallenge(deps, appId, doc) : runAuthenticate(deps, appId, doc);
}

interface AppRow {
  id: string;
  app_key: string;
  trust_signin_enabled: boolean;
}

// P1. A rejected fetch or a 5xx → unavailable; any other non-2xx or no row → null (403).
async function lookupApp(deps: CoreDeps, appId: string): Promise<AppRow | null | "unavailable"> {
  let res: Response;
  try {
    res = await deps.fetch(
      deps.restUrl(`/cloud_apps?id=eq.${encodeURIComponent(appId)}&select=id,app_key,trust_signin_enabled`),
      { headers: deps.svcHeaders() },
    );
  } catch {
    return "unavailable";
  }
  if (res.status >= 500) return "unavailable";
  if (!res.ok) return null;
  let rows: unknown;
  try {
    rows = await res.json();
  } catch {
    return "unavailable";
  }
  if (!Array.isArray(rows) || rows.length === 0 || !isPlainObject(rows[0])) return null;
  return rows[0] as unknown as AppRow;
}

function proofPolicy(deps: CoreDeps) {
  return {
    kind: "verify" as const,
    verify: new PurposeCheckingVerifier(new DataIntegrityProofVerifier({ now: () => deps.now().getTime() })),
  };
}

function toHttp(deps: CoreDeps, outcome: Parameters<typeof mapOutcomeToHttp>[0]): CoreResponse {
  const http = mapOutcomeToHttp(outcome, () =>
    errorDocument(deps, undefined, { code: "malformedRequest", message: MSG.suppressed, retryable: false }),
  );
  if (http.log !== undefined) deps.log?.("app-trust-tasks.suppressed", { detail: http.log });
  // Runtime rejections copy request.recipient into issuer (rt/document.ts:369): re-stamp (S-30).
  let body = http.body;
  if (outcome.kind === "rejected" && isPlainObject(body)) body = stampIssuer(body as unknown as Doc, deps.localVid);
  return body === undefined ? { status: http.status } : { status: http.status, body };
}

function refusal(deps: CoreDeps, doc: Doc, code: string, message: string, retryable: boolean): ErrorResponse {
  return stampIssuer(rejectWith(doc, uuidOf(deps)(), { code, message, retryable }, nowIso(deps)), deps.localVid);
}

function isEd25519DidKey(subject: string): boolean {
  if (!ED25519_DID_KEY.test(subject)) return false;
  try {
    return publicKeyFromDidKey(subject)?.curve === "ed25519";
  } catch {
    return false;
  }
}

// S-43: auth/challenge/0.1. Proof optional (verified if present); no replay record.
async function runChallenge(deps: CoreDeps, appId: string, doc: Doc): Promise<CoreResponse> {
  const store = new PostgresChallengeStore({ ...postgrest(deps), now: deps.now, randomUUID: deps.randomUUID, randomBytes: deps.randomBytes });
  const outcome = await consumeInbound<Record<string, unknown>, unknown>({
    transport: new UnauthenticatedTransport(),
    spec: AuthChallenge_v0_1.SPEC,
    proofPolicy: proofPolicy(deps),
    payloadPolicy: { kind: "validate", validate: subsetSchemaValidator },
    checks: notConsequentialChecks(),
    doc,
    myVid: deps.localVid,
    now: deps.now().getTime(),
    newErrorId: uuidOf(deps),
    clock: nowIso(deps),
    handler: async (accepted) => {
      const subject = accepted.payload.subject;
      if (subject !== undefined && (typeof subject !== "string" || !isEd25519DidKey(subject))) {
        return refusal(deps, accepted, CODES.subjectNotRecognized, MSG.subjectNotRecognized, false);
      }
      let issued;
      try {
        issued = await store.issue({ appId, subject: subject as string | undefined, ttlMs: deps.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS });
      } catch (e) {
        deps.log?.("app-trust-tasks.storeUnavailable", { op: "issue", error: e instanceof Error ? e.message : String(e) });
        return refusal(deps, accepted, "unavailable", MSG.unavailable, true);
      }
      void store.sweep(); // S-23, fire-and-forget; sweep never throws
      const payload = { challenge: issued.challenge, sessionId: issued.sessionId, expiresAt: issued.expiresAt.toISOString() };
      return stampIssuer(respondWith(accepted, uuidOf(deps)(), payload, nowIso(deps)), deps.localVid);
    },
  });
  return toHttp(deps, outcome);
}

function postgrest(deps: CoreDeps): PostgrestDeps {
  return { fetch: deps.fetch, restUrl: deps.restUrl, svcHeaders: deps.svcHeaders };
}

// S-44…S-48: auth/authenticate/0.3. Proof required (spec), replay-guarded, window-bounded.
async function runAuthenticate(deps: CoreDeps, appId: string, doc: Doc): Promise<CoreResponse> {
  const guard = new PostgresReplayGuard({ ...postgrest(deps), appId });
  const store = new PostgresChallengeStore({ ...postgrest(deps), now: deps.now, randomUUID: deps.randomUUID, randomBytes: deps.randomBytes });
  const outcome = await consumeInbound<Record<string, unknown>, unknown>({
    transport: new UnauthenticatedTransport(),
    spec: AuthAuthenticate_v0_3.SPEC,
    proofPolicy: proofPolicy(deps),
    payloadPolicy: { kind: "validate", validate: subsetSchemaValidator },
    checks: authenticateChecks(guard, deps.acceptanceWindowMs ?? DEFAULT_ACCEPTANCE_WINDOW_MS),
    doc,
    myVid: deps.localVid,
    now: deps.now().getTime(),
    newErrorId: uuidOf(deps),
    clock: nowIso(deps),
    // Never throws: a thrown handler would leave the replay claim in flight (C-9, R11).
    handler: async (accepted) => {
      try {
        return await authenticateHandler(deps, appId, store, accepted);
      } catch (e) {
        deps.log?.("app-trust-tasks.storeUnavailable", { op: "authenticate", error: e instanceof Error ? e.message : String(e) });
        return refusal(deps, accepted, "unavailable", MSG.unavailable, true);
      }
    },
  });
  return toHttp(deps, outcome);
}

async function authenticateHandler(
  deps: CoreDeps,
  appId: string,
  store: PostgresChallengeStore,
  doc: Doc,
): Promise<TrustTaskDocument<unknown>> {
  const p = doc.payload;
  const issuer = doc.issuer as string; // proven by the verifier (proof required)
  const refuse = (code: string, message: string, retryable = false) => refusal(deps, doc, code, message, retryable);

  // SPIKE: consume-before-compare — the single atomic PATCH burns the challenge even on a
  // mismatched guess (spec consumes at item 6, after comparing). Strictly safer on PostgREST.
  const found = await store.lookupAndConsume({ appId, sessionId: String(p.sessionId), now: deps.now() });
  if (found.kind === "notFound") return refuse(CODES.challengeNotFound, MSG.challengeNotFound);
  if (found.kind === "expired") return refuse(CODES.challengeExpired, MSG.challengeExpired, true);
  if (!constantTimeEqual(String(p.challenge), found.challenge)) return refuse(CODES.challengeMismatch, MSG.challengeMismatch);

  const principal = typeof p.principal === "string" ? p.principal : undefined;
  const actingParty = principal ?? issuer;
  if (found.subject !== null && found.subject !== actingParty) return refuse(CODES.subjectMismatch, MSG.subjectMismatch);
  if (principal !== undefined && principal !== issuer) {
    return p.delegationEvidence === undefined
      ? refuse(CODES.delegationEvidenceRequired, MSG.delegationEvidenceRequired)
      : refuse(CODES.delegationNotRecognized, MSG.delegationNotRecognized);
  }
  if (p.sessionKey !== undefined) return refuse(CODES.sessionKeyUnsupported, MSG.sessionKeyUnsupported);

  // S-47: member by did, then a session row whose token is the access token.
  const now = deps.now();
  const ttl = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttl);
  const member = await upsertMemberByDid(postgrest(deps), appId, issuer);
  const token = await mintMemberToken(
    { ...postgrest(deps), memberTokenFactory: deps.memberTokenFactory ?? (() => defaultMemberToken(deps.randomUUID)) },
    { appId, memberId: member.id, expiresAt },
  );
  const payload = {
    session: {
      id: uuidOf(deps)(), // stored nowhere in Increment 1; never derived from the token
      subject: issuer,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      amr: ["did"],
      acr: "aal1",
    },
    tokens: { accessToken: token, tokenType: "Bearer", expiresIn: Math.round(ttl / 1000) },
    ext: { [EXT_NAMESPACE]: { member: { id: member.id, did: issuer, name: member.name, email: null } } },
  };
  // SPIKE: the auth/authenticate/0.3 #response is unsigned (spec requires a proof; recorded deviation, §1.2 / C-1).
  return stampIssuer(respondWith(doc, uuidOf(deps)(), payload, nowIso(deps)), deps.localVid);
}

/** S-30 default: `did:web:<hostname>` plus `%3A<port>` for an explicit non-default port (C-25). */
export function localVidFromSupabaseUrl(supabaseUrl: string): string {
  const u = new URL(supabaseUrl);
  // URL.port is "" for the scheme's default port, so only a non-default port survives.
  return `did:web:${u.hostname}${u.port ? `%3A${u.port}` : ""}`;
}

const TYPE_PREFIX = "https://trusttasks.org/spec/";

function slugOrNull(type: string): string | null {
  try {
    return slugFromTypeUri(type);
  } catch {
    return null;
  }
}

/** S-41: exact registered URI → handler; same slug, other version → unsupportedVersion; else unsupportedType. */
export function classifyType(type: string): TypeClass {
  if (type === CHALLENGE_TYPE) return "challenge";
  if (type === AUTHENTICATE_TYPE) return "authenticate";
  if (!type.startsWith(TYPE_PREFIX) || type.includes("#")) return "unsupportedType";
  const slug = slugOrNull(type);
  const version = type.slice(TYPE_PREFIX.length).split("/").pop() ?? "";
  if (slug === null || !/^\d+\.\d+$/.test(version)) return "unsupportedType";
  return REGISTERED_TYPES.some((t) => slugOrNull(t) === slug) ? "unsupportedVersion" : "unsupportedType";
}

/** S-41 framework-shape check (id/type/payload/party/timestamp/proof member types); null when acceptable, else a wire-safe message. */
export function checkFrameworkShape(doc: Record<string, unknown>): string | null {
  if (typeof doc.id !== "string" || doc.id.length === 0) return "id must be a non-empty string (SPEC §4)";
  if (typeof doc.type !== "string") return "type must be a string (SPEC §4)";
  if (!isPlainObject(doc.payload)) return "payload must be a JSON object (SPEC §4)";
  for (const m of ["issuer", "recipient", "issuedAt", "expiresAt", "threadId"] as const) {
    if (doc[m] !== undefined && typeof doc[m] !== "string") return `${m} must be a string when present (SPEC §4)`;
  }
  if (doc.proof !== undefined && !isPlainObject(doc.proof)) return "proof must be a JSON object when present (SPEC §4.7)";
  return null;
}

/** Build a trust-task-error with issuer = localVid, for failures with or without a parsed request (S-30, S-41). */
export function errorDocument(
  deps: Pick<CoreDeps, "localVid" | "now" | "randomUUID">,
  request: { id?: unknown; type?: unknown; issuer?: unknown; threadId?: unknown } | undefined,
  payload: ErrorPayload,
): ErrorResponse {
  const id = uuidOf(deps)();
  const r = request ?? {};
  const out: ErrorPayload = { ...payload };
  if (out.inResponseTo === undefined && typeof r.type === "string" && typeof r.id === "string") {
    out.inResponseTo = { typeUri: r.type, id: r.id };
  }
  const threadId = typeof r.threadId === "string" ? r.threadId : typeof r.id === "string" ? r.id : id;
  const doc: ErrorResponse = { id, threadId, type: TRUST_TASK_ERROR_TYPE_URI, issuer: deps.localVid, issuedAt: deps.now().toISOString(), payload: out };
  if (typeof r.issuer === "string") doc.recipient = r.issuer;
  return doc;
}

/** Overwrite `issuer` with localVid on any emitted document (runtime copies request.recipient) (S-30). */
export function stampIssuer<D extends TrustTaskDocument<unknown>>(doc: D, localVid: string): D {
  return { ...doc, issuer: localVid };
}

/** S-42 authenticate posture: CONSEQUENTIAL_FRESHNESS with maxAgeMs = windowMs, replay guarded by `guard`. */
export function authenticateChecks(guard: ReplayGuard, windowMs: number): ConsumeChecks {
  return { freshness: { ...CONSEQUENTIAL_FRESHNESS, maxAgeMs: windowMs }, replay: { kind: "guard", guard } };
}

/** Wraps a verifier: proofPurpose must be in SIGNING_PROOF_PURPOSES, then delegates (S-42). */
export class PurposeCheckingVerifier implements ProofVerifier {
  private readonly inner: ProofVerifier;
  private readonly purposes: readonly string[];
  constructor(inner: ProofVerifier, purposes: readonly string[] = SIGNING_PROOF_PURPOSES) {
    this.inner = inner;
    this.purposes = purposes;
  }
  /** False when proof.proofPurpose is not allowed; else the inner verdict. */
  async verify<P>(doc: TrustTaskDocument<P>): Promise<boolean> {
    const purpose = doc.proof?.proofPurpose;
    if (typeof purpose !== "string" || !this.purposes.includes(purpose)) return false;
    return (await this.inner.verify(doc)) === true;
  }
}

/** S-25: the JSON Schema keywords subsetSchemaValidator implements; anything else throws. */
export const SUPPORTED_SCHEMA_KEYWORDS: readonly string[] = [
  "$schema", "$id", "$anchor", "$defs", "$ref", "title", "description",
  "type", "properties", "additionalProperties", "required", "items",
  "minLength", "maxLength", "pattern", "format", "minimum", "minItems",
  "minProperties", "propertyNames",
];

// A local `#/$defs/<name>` reference and nothing else — S-25 forbids remote/anchor/property refs.
// The capture group is the def name: checkSchema resolves `#/$defs/X` via `m[1]`, so a bare
// (groupless) regex would leave `m[1]` undefined and make every $ref resolution fail.
const LOCAL_REF = /^#\/\$defs\/([^/]+)$/;
// JSON-Schema `date-time` / RFC 3339: an offset (or Z) is required, `T`/`Z` are
// case-insensitive, and the month must be 01–12 (range is checked after the match).
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/i;
const SUPPORTED = new Set(SUPPORTED_SCHEMA_KEYWORDS);

// The keywords the subset understands, with the value types they take in the bundled schemas.
// `additionalProperties`/`items`/`propertyNames` are sub-schemas (or a boolean).
interface Schema {
  $ref?: string;
  type?: string;
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  required?: string[];
  items?: unknown;
  minItems?: number;
  minLength?: number;
  maxLength?: number;
  minProperties?: number;
  minimum?: number;
  pattern?: string;
  format?: string;
  propertyNames?: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "object": return isPlainObject(value);
    case "array": return Array.isArray(value);
  }
  return false;
}

function isDateTime(value: string): boolean {
  const m = DATE_TIME.exec(value);
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** S-25: throw if `schema` uses a keyword outside SUPPORTED_SCHEMA_KEYWORDS or a non-local $ref. */
export function assertSchemaSupported(schema: unknown): void {
  checkSchemaNode(schema);
}

// Recurse into every sub-schema slot so a nested keyword or a nested $ref is caught too
// (the test feeds a bad keyword buried in $defs). A boolean additionalProperties is not a slot.
function checkSchemaNode(node: unknown): void {
  if (!isPlainObject(node)) return; // annotation primitives / arrays carry no keywords
  const n = node as Record<string, unknown>;
  for (const key of Object.keys(n)) {
    if (!SUPPORTED.has(key)) throw new Error(`S-25: unsupported schema keyword "${key}"`);
    if (key === "$ref" && (typeof n.$ref !== "string" || !LOCAL_REF.test(n.$ref))) {
      throw new Error(`S-25: non-local $ref "${String(n.$ref)}"`);
    }
  }
  for (const slot of ["properties", "items", "propertyNames", "$defs"] as const) {
    const v = n[slot];
    if (isPlainObject(v)) for (const sub of Object.values(v)) checkSchemaNode(sub);
  }
  if (isPlainObject(n.additionalProperties)) checkSchemaNode(n.additionalProperties);
}

// SPIKE: a hand-written draft-2020-12 subset validator (the 20 keywords above, no json-schema
// library) so the function stays dependency-free and Deno-free. It asserts support first, so an
// unknown keyword throws rather than being silently ignored, then validates the 20-keyword subset.
/** S-25: hand-written draft 2020-12 subset validator for the bundled SPEC.payloadSchema values. */
export const subsetSchemaValidator: PayloadValidator = {
  validate(schema, payload) {
    assertSchemaSupported(schema); // throws on an unsupported keyword or non-local $ref
    const defs =
      isPlainObject(schema) && isPlainObject(schema.$defs)
        ? (schema.$defs as Record<string, unknown>)
        : {};
    return checkSchema(schema, payload, defs);
  },
};

// Recursively test `value` against the subset `schema`, resolving local $refs against the root
// `defs` (every $ref the bundled schemas emit is a root-local `#/$defs/<name>`).
function checkSchema(schema: unknown, value: unknown, defs: Record<string, unknown>): boolean {
  if (isPlainObject(schema) && typeof schema.$ref === "string") {
    const m = LOCAL_REF.exec(schema.$ref);
    const target = m ? defs[m[1]] : undefined;
    return target === undefined ? false : checkSchema(target, value, defs);
  }
  if (schema === true) return true;
  if (schema === false || !isPlainObject(schema)) return false;
  const s = schema as Schema;

  if (s.type !== undefined && !typeMatches(s.type, value)) return false;

  if (typeof value === "string") {
    if (s.minLength !== undefined && [...value].length < s.minLength) return false;
    if (s.maxLength !== undefined && [...value].length > s.maxLength) return false;
    if (s.pattern !== undefined && !new RegExp(s.pattern).test(value)) return false;
    if (s.format === "date-time" && !isDateTime(value)) return false;
  } else if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) return false;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (s.required !== undefined && s.required.some((r) => !(r in value))) return false;
    if (s.minProperties !== undefined && keys.length < s.minProperties) return false;
    if (s.propertyNames !== undefined) {
      for (const k of keys) if (!checkSchema(s.propertyNames, k, defs)) return false;
    }
    const props = s.properties;
    for (const k of keys) {
      if (props && k in props) {
        if (!checkSchema(props[k], value[k], defs)) return false;
      } else if (s.additionalProperties === false) {
        return false;
      } else if (s.additionalProperties === true || isPlainObject(s.additionalProperties)) {
        if (!checkSchema(s.additionalProperties, value[k], defs)) return false;
      }
    }
    return true;
  }

  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) return false;
    if (s.items !== undefined) {
      for (const item of value) if (!checkSchema(s.items, item, defs)) return false;
    }
    return true;
  }

  // A primitive (boolean/null) with no applicable assertion above matches.
  return true;
}

/** Length-independent-time string comparison for the challenge (S-44 step 2). */
export function constantTimeEqual(a: string, b: string): boolean {
  // Walk max(len) code units so timing does not depend on where the first difference is.
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}
