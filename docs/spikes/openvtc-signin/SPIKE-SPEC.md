# Spike v2: one Trust Task at a time — `auth/challenge` + `auth/authenticate` for Community Cloud

**Status:** spike / experiment on Kevin's fork. Not for upstream without a separate proposal.
**Supersedes:** `SPIKE-SPEC-v1-oob-deferred.md` (2026-10-17), now Increment 3.
**Author:** Kevin Triplett, 2026-10-18. Sources: `app-data/index.ts` (fork @ 2026-10-14); `dtgwg-trust-tasks-tf` @ main 2026-10-18 (`GETTING-STARTED.md`, `SPEC.md`, `bindings/https/0.2/spec.md`, `specs/auth/challenge/0.1`, `specs/auth/authenticate/0.3`, `specs/auth/_shared/0.3`, `trust-tasks-ts` 0.26.18, `trust-tasks-ts-proof`); `dtgwg-vti-spec/spec/07-clients.md` (Client Onboarding and Lifecycle).

Written for an LLM coding assistant. Every `S-nn` is phrased so a second LLM can turn it into a test without reading the codebase. Names of files, tables, functions, constants and type URIs are binding.

---

## 0. Why v2 replaces v1

The OpenVTC lead's guidance, paraphrased: the architecture is radically different from web2, but you do not have to swallow it whole. Think of VTI services as *sidecars* to an existing system. **Trust Tasks is the integration library**; an existing app can adopt *one* task and grow. Demanding DIDs-only, credentials-only, privacy-by-design on day one is "open heart surgery while the patient runs a marathon."

v1 started at the wrong end. The rp-sdk `auth/oob/*` QR flow requires every *end user* to have a wallet and a VTA before anything works, and requires a `did:web`/`did:webvh` service identity, a resolver, and a Postgres-backed state machine — a large first bite whose payoff is gated on wallet adoption we cannot control.

v2 starts where Trust Tasks were designed to start: Community Cloud already *has* a challenge→prove→token sign-in (email code → `member_token`). The Trust Tasks registry has that exact shape as two published tasks, `auth/challenge/0.1` and `auth/authenticate/0.3`, with a TokenBundle in the response. The OpenVTC browser plugin already speaks them (`auth/challenge` → `auth/authenticate/0.2` posted to the relying party's `/trust-tasks`). And with `did:key` subjects, the proof verifies **offline** with `@openvtc/trust-tasks-proof` — no resolver, no VTA, no wallet, no DID hosting.

So the first increment is: **a `POST /trust-tasks` endpoint on Community Cloud that consumes exactly two task types and hands back the same `member_token` the email path mints.** The generated app is the *client* in the VTI sense (Client Onboarding chapter): it mints its own `did:key` bootstrap identity in the browser (VTI-CLT-001…006), and that identity becomes the member. Everything a wallet later adds (a `did:webvh` persona, proxied login via a VTA, QR hand-off) plugs into the same endpoint as later increments.

### Increments

| # | Scope | Subject identity | New external dependency | This spec |
|---|---|---|---|---|
| **1** | `/trust-tasks` consumer for `auth/challenge/0.1` + `auth/authenticate/0.3` (ordinary form only); browser mints `did:key`; `member_token` in TokenBundle | `did:key` held by the browser | `@openvtc/trust-tasks`, `@openvtc/trust-tasks-proof` | **§3–§9 (build this)** |
| 2 | Accept `did:webvh` / `did:web` issuers (wallet personas) and `sessionKey` binding; add `auth/whoami`, `auth/revoke-session` | wallet persona DID | a DID resolver with net-guard | §10 (sketch only) |
| 3 | `auth/oob/*` QR/trigger-link flow via rp-sdk; service `did:web` identity | wallet via VTA | rp-sdk, service key, resolver | `SPIKE-SPEC-v1-oob-deferred.md` |
| 4 | Proxied authenticate (`payload.principal` + `delegationEvidence` from a VTA context) | VTA on behalf of holder | VTA, credential verification | not written |

Increment 1 is the spike. Increments 2–4 exist so that every design choice in Increment 1 is checked against "does this close a door we will need open."

## 1. Scope of Increment 1

### 1.1 In scope

1. New Supabase edge function `supabase/functions/app-trust-tasks/index.ts` exposing `POST /trust-tasks` per the HTTPS binding 0.2, for Community Cloud apps.
2. Consumption of exactly two type URIs: `https://trusttasks.org/spec/auth/challenge/0.1` and `https://trusttasks.org/spec/auth/authenticate/0.3` (ordinary form: `payload.principal` absent or equal to `issuer`). Everything else → `unsupportedType`.
3. Proof verification for `did:key` issuers only, via `@openvtc/trust-tasks-proof` `DataIntegrityProofVerifier` (`eddsa-jcs-2022`).
4. A Postgres-backed challenge store and a Postgres-backed `ReplayGuard` (the TS package ships only in-memory ones; Supabase isolates do not share memory).
5. Minting of a Community Cloud `member_token` (same shape as `authVerify` produces) as the `TokenBundle.accessToken`; `app_members` row keyed by `did`.
6. Migration: `app_members.email` nullable, `app_members.did` added, new tables `app_tt_challenges`, `app_tt_replay`.
7. `app-data` changes limited to `resolveMember` returning `did` and tolerating `email = null`.
8. A browser-side helper module **shipped as a project file into generated apps** (`src/kit/files/lib/trust-signin.ts`, materialized by `withKitFiles()`): mint/persist a `did:key`, sign a document, run challenge→authenticate, return `member_token`.
9. Prompt guidance `TRUST_SIGNIN_GUIDANCE` in `src/integrations/catalog.ts`.
10. A vitest harness (repo has none).

### 1.2 Out of scope (Increment 1)

- Any DID method other than `did:key` for the issuer (→ Increment 2).
- `payload.sessionKey` binding (the browser key *is* the subject key in Increment 1, so a separate session key adds nothing yet) → Increment 2. Consumer refuses it with `auth/authenticate:sessionKeyUnsupported` (S-45).
- `payload.principal ≠ issuer` (proxied login) → Increment 4. Refused with `auth/authenticate:delegationNotRecognized` (S-46).
- `auth/refresh`, `auth/whoami`, `auth/revoke-session`, `trust-task-discovery`. Not registered → `unsupportedType`.
- A service DID for Community Cloud. The consumer's `local_vid` is a `did:web` *string* configured by env (S-30) but **nothing resolves it and nothing signs responses** in Increment 1. The HTTPS binding does not require signed responses; `auth/authenticate` 0.3 does not declare the `#response` proof REQUIRED. Verify this claim in Phase 1 (design) and record it.
- Email path changes. Byte-identical except `select` lists (S-52).
- The VTI client *rotation* (Step 3 of the Client Onboarding chapter, `acl/swap-key`). Community Cloud has no ACL entries per member in the VTI sense; the member row *is* the standing. Record in FINDINGS what rotation would mean here.

## 2. Architecture

```
Generated app (any origin)
  trust-signin.ts
    1. mint or load did:key (WebCrypto Ed25519 non-extractable, else @noble fallback)   [VTI-CLT-001..006]
    2. POST /trust-tasks  auth/challenge/0.1  {payload:{subject: did, purpose:"login"}}  (unsigned OK)
    3. POST /trust-tasks  auth/authenticate/0.3 {payload:{challenge, sessionId}} + proof (eddsa-jcs-2022, did:key)
    4. read #response payload.tokens.accessToken  →  member_token  (identical to email path)
  ▼
app-trust-tasks edge function (Deno)              ← Trust-Task base = <fn url>; path = /trust-tasks
  ├─ app_id/app_key from query string (?app_id=&app_key=)     [S-40]   (body is the bare document per binding §2)
  ├─ parse → dispatch on `type`                                [S-41]
  ├─ consumeInbound (@openvtc/trust-tasks)                     [S-42]
  │     transport    = UnauthenticatedTransport (no bearer in Increment 1; in-band issuer is authoritative)
  │     proofPolicy  = verify via DataIntegrityProofVerifier (did:key only)
  │     payloadPolicy= validate against bundled payload.schema.json
  │     checks       = consequentialChecks(PostgresReplayGuard)   for authenticate
  │                    notConsequentialChecks()                   for challenge
  ├─ challenge handler → app_tt_challenges insert               [S-43]
  └─ authenticate handler → bind check, consume, member upsert by did, app_sessions insert → TokenBundle [S-44..S-48]
```

### 2.1 File layout (binding)

```
supabase/functions/app-trust-tasks/
  index.ts        Deno.serve glue only (≤ 60 lines): read env, build deps, call core, map status.
  core.ts         handleTrustTask(deps, req): pure, injected fetch/now. The §7.2 pipeline + two handlers.
  challenges.ts   PostgresChallengeStore (issue, lookupAndConsume).
  replay.ts       PostgresReplayGuard implements ReplayGuard from @openvtc/trust-tasks.
  members.ts      upsertMemberByDid, mintMemberToken (PostgREST).
  status.ts       mapOutcomeToHttp(outcome) per HTTPS binding §4.
supabase/migrations/2026MMDD000000_trust_tasks_signin.sql
src/kit/files/lib/trust-signin.ts         browser helper shipped into generated apps
src/integrations/catalog.ts               (+ TRUST_SIGNIN_GUIDANCE, TRUST_SIGNIN_KEYS)
src/cloud/community-cloud.ts              (+ setVar('TRUST_TASKS_URL', …))
tests/app-trust-tasks/*.test.ts           vitest
tests/app-trust-tasks/fake-postgrest.ts   in-memory PostgREST subset
tests/app-trust-tasks/producer.ts         test-side producer: mint did:key, build + sign documents (mirrors trust-signin.ts)
tsconfig.functions.json, vitest.config.ts
docs/spikes/openvtc-signin/FINDINGS.md    written last (§9)
```

`core.ts`, `challenges.ts`, `replay.ts`, `members.ts`, `status.ts` import nothing Deno-specific; all I/O via injected `fetch` and `now`. Only `index.ts` touches `Deno.*`.

## 3. Data model

### S-10 Migration is additive and idempotent

Re-runnable (`if not exists` guards; constraint add wrapped in `do $$ … $$`). Must:

- `alter table public.app_members alter column email drop not null;`
- `alter table public.app_members add column if not exists did text;`
- `create unique index if not exists app_members_app_did_idx on public.app_members (app_id, did) where did is not null;`
- add check `app_members_identity_chk check (email is not null or did is not null)`.
- `alter table public.cloud_apps add column if not exists trust_signin_enabled boolean not null default false;`
- create `public.app_tt_challenges (session_id text primary key, app_id uuid not null references public.cloud_apps(id) on delete cascade, subject text, challenge text not null, expires_at timestamptz not null, consumed_at timestamptz, created_at timestamptz not null default now())` with index `(app_id, expires_at)`.
- create `public.app_tt_replay (doc_id text primary key, app_id uuid not null references public.cloud_apps(id) on delete cascade, digest text not null, response jsonb, until_at timestamptz not null)` with index `(until_at)`.
- RLS enabled on both new tables, **no** policies (service-role only, like `app_sessions`).

**Oracle:** apply twice → second run no-op. Existing `app_members` rows valid. `(did null, email null)` insert fails. Duplicate `(app_id, did)` fails; two rows with `did null` succeed.

### S-11 Replay record keyed on document `id` alone

`app_tt_replay.doc_id` is the Trust Task `id`. `digest` is `sha256Hex(canonicalJson(document))` **including `proof`** (binding §5.1 item 1). `response` is the retained `#response` document for a completed execution, or `null` while in progress / when none.

## 4. Stores

### S-20 `PostgresChallengeStore.issue`

`issue({appId, subject?, ttlMs}) → {sessionId, challenge, expiresAt}`. `sessionId` = `crypto.randomUUID()`. `challenge` = 32 random bytes, base64url, no padding (≥ 128 bits: spec item 2). Inserts one row. A duplicate `session_id` (astronomically unlikely) → retry once, then throw.

### S-21 `PostgresChallengeStore.lookupAndConsume`

`lookupAndConsume({appId, sessionId, now}) → {kind:"notFound"} | {kind:"expired"} | {kind:"ok", challenge, subject}`. Implemented as **one** `PATCH /app_tt_challenges?session_id=eq.<id>&app_id=eq.<appId>&consumed_at=is.null` with body `{consumed_at: now}` and `Prefer: return=representation`. Zero rows → `notFound` (covers both never-issued and already-consumed — the spec's single `challengeNotFound` code). One row with `expires_at < now` → `expired` (row stays consumed; a second attempt is `notFound`). Else `ok`. Rows for another `app_id` are invisible.

**Oracle:** two concurrent `lookupAndConsume` for the same id — exactly one `ok`, the other `notFound`.

### S-22 `PostgresReplayGuard` implements `ReplayGuard`

Implements the `ReplayGuard` interface exported by `@openvtc/trust-tasks` (read its exact shape from `trust-tasks-ts/src/_runtime/replay.ts` — the design agent copies the signature into DESIGN.md). Semantics per binding §5.1: keyed on `id`; same `id` + same digest → duplicate (return retained response when present); same `id` + different digest → `idConflict`; record is written at the commit point (after all checks, before the handler runs); store unreachable → the guard reports unavailable and the consumer answers `unavailable`/503 and does **not** execute (fail closed, §5.1 item 5). Retention `until_at` = `now + acceptance window` (S-42). Opportunistic `DELETE … until_at=lt.now` on each write; its failure is ignored.

### S-23 Sweep

`PostgresChallengeStore.sweep()` deletes `app_tt_challenges` where `expires_at < now - 1h`. Called fire-and-forget from the challenge handler.

## 5. Consumer core (`core.ts`)

```ts
export interface CoreDeps {
  fetch: typeof fetch; now: () => Date;
  restUrl: (p: string) => string; svcHeaders: () => Record<string,string>;
  localVid: string;                     // S-30
  challengeTtlMs?: number;              // default 120_000 (spec: 30 s–5 min)
  sessionTtlMs?: number;                // default 30 days (match authVerify)
  acceptanceWindowMs?: number;          // default 300_000 (S-42)
  memberTokenFactory?: () => string;    // default: authVerify's 64-hex scheme
}
export interface CoreRequest { appId: string; appKey: string; rawBody: unknown; }
export async function handleTrustTask(deps: CoreDeps, req: CoreRequest): Promise<{ status: number; body?: unknown }>;
```

### S-30 `localVid` is configuration, not identity

`localVid` comes from env `TRUST_TASKS_LOCAL_VID` and defaults to `did:web:<SUPABASE project host>` when unset. It is used only as the transport-authenticated *recipient* for the §4.8.1 cross-check (`wrongRecipient` when the document's `recipient` is present and differs) and as `issuer` of response documents. **Nothing resolves it and nothing signs with it in Increment 1**; code comment `// SPIKE: unsigned responses; local_vid is a label` is mandatory.

### S-40 App authentication precedes parsing

`appId`/`appKey` come from the function URL query string (`?app_id=&app_key=`) because the HTTPS binding (§2) requires the body to be the bare document. Missing → `401 {error:"app_id and app_key required"}` (plain JSON, **not** a trust-task-error: binding §4 says missing auth is transport-level). Unknown app or wrong key → `403 {error:"Unknown app or wrong key"}`. `trust_signin_enabled = false` → `403 {error:"Trust Task sign-in is not enabled for this app"}`. Rate limit 120/min per app → `429` plain JSON. Only then is `rawBody` examined.

### S-41 Parse and dispatch

`rawBody` must be a JSON object with string `type`; otherwise `400` with a `trust-task-error` whose code is `malformedRequest` (use `rejectWith` from the runtime). `type` not in the registered set → `422` with `unsupportedType`. The two registered URIs are exact-match strings; `…/auth/authenticate/0.2` is **not** registered in Increment 1 (the plugin's current version) — record this in FINDINGS as the compatibility question it is, and make the registered set a single constant `REGISTERED_TYPES` so Increment 2 can add 0.2.

### S-42 `consumeInbound` is the pipeline

Both handlers run through `consumeInbound` from `@openvtc/trust-tasks` with: `transport = new UnauthenticatedTransport()` (no bearer in Increment 1; the in-band `issuer` is then authoritative per §4.8.1 — confirm in design phase that `UnauthenticatedTransport` yields that behaviour and does not reject every document as `identityMismatch`); `myVid = deps.localVid`; `now`; `newErrorId = crypto.randomUUID`; `payloadPolicy = {kind:"validate", validate}` where `validate` checks against the task's `payload.schema.json` bundled from the npm package (use the `PayloadSchemaJSON`/equivalent export if present; else vendor the two schema files under `supabase/functions/app-trust-tasks/schemas/` with provenance comment).

For **challenge**: `proofPolicy = {kind:"verify", verify}` **but** absence of proof is not an error (spec: proof OPTIONAL). Confirm the runtime expresses "optional, verify if present" — if it needs a distinct policy kind, use it; if it cannot, run `verifyDetailed` manually and document. `checks = notConsequentialChecks()`. Freshness: `DEFAULT_FRESHNESS`.

For **authenticate**: `proofPolicy = {kind:"verify", verify: new DataIntegrityProofVerifier()}` (hard-required). `checks = consequentialChecks(new PostgresReplayGuard(...))`. Freshness: `CONSEQUENTIAL_FRESHNESS` with the acceptance window = `deps.acceptanceWindowMs`; `issuedAt` REQUIRED (spec `issuedAtRequirement`), missing → the runtime's `ISSUED_AT_REQUIRED` rejection.

The five outcomes map to HTTP per binding §4 via `status.ts` (S-50).

### S-43 Challenge handler

Given an accepted `auth/challenge/0.1` document: if `payload.subject` is present and is not an Ed25519 `did:key` (`^did:key:z6Mk`) → `trust-task-error` code `auth/challenge:subjectNotRecognized`, `retryable:false`. Else `issue({appId, subject, ttlMs: challengeTtlMs})` and respond with a `…/auth/challenge/0.1#response` document whose payload is `{challenge, sessionId, expiresAt}` (ISO-8601), `issuer = localVid`, `recipient = document.issuer` when present, `threadId = document.id`. Fire-and-forget `sweep()`.

**Oracle:** challenge is ≥ 43 base64url chars; `expiresAt - now` within [30 s, 5 min]; a second call yields different `sessionId` and `challenge`.

### S-44 Authenticate handler — binding checks in spec order

Given an accepted `auth/authenticate/0.3` document (proof already verified by the pipeline, so `issuer` is proven):

1. `lookupAndConsume(sessionId)`: `notFound` → `auth/authenticate:challengeNotFound` (retryable false); `expired` → `auth/authenticate:challengeExpired` (retryable true).
2. Constant-time compare `payload.challenge` to stored → mismatch → `auth/authenticate:challengeMismatch`. (Note order: the spec consumes at item 6 after comparing at item 3; Increment 1 consumes *first* via the single atomic PATCH and accepts that a mismatched guess also burns the challenge. Record this as a deliberate deviation: it is strictly safer and simpler than a two-step read-then-consume on PostgREST.)
3. Acting party = `issuer` (ordinary form). If the stored `subject` is non-null and ≠ issuer → `auth/authenticate:subjectMismatch`.
4. `payload.scope` present → ignore contents; response `tokens.scope` is omitted (no scope vocabulary yet).

### S-45 `sessionKey` refused in Increment 1

`payload.sessionKey` present → `auth/authenticate:sessionKeyUnsupported` (spec item 11 permits refusal). Challenge is already consumed at this point; that is acceptable and documented.

### S-46 Proxied form refused in Increment 1

`payload.principal` present and ≠ `issuer` → if `delegationEvidence` absent → `auth/authenticate:delegationEvidenceRequired`; else → `auth/authenticate:delegationNotRecognized`. Never create a session for a principal.

### S-47 Session minting

On success: upsert `app_members` by `(app_id, did = issuer)`; insert `app_sessions {token, app_id, member_id, expires_at = now + sessionTtlMs}` where `token = deps.memberTokenFactory()` (default = `authVerify`'s scheme: two `randomUUID()` with dashes stripped, 64 hex chars). Response is `…/auth/authenticate/0.3#response` with payload:

```json
{ "session": { "id": "<app_sessions.token truncated? NO — use a separate uuid>", "subject": "<issuer did>", "issuedAt": "<now>", "expiresAt": "<expires_at>", "amr": ["did"], "acr": "aal1" },
  "tokens":  { "accessToken": "<member_token>", "tokenType": "Bearer", "expiresIn": <seconds> } }
```

`session.id` is a fresh `randomUUID()` stored nowhere in Increment 1 (no introspection yet); it must **not** equal or reveal the token. `ext["org.relationalbuilder.cloud"] = { member: { id, did, name, email: null } }` is added to the response payload so generated apps get the same `member` object the email path returns.

**Oracle:** full producer flow with a fresh `did:key` → one `app_members` row (did set, email null), one `app_sessions` row whose token equals `tokens.accessToken`; `expiresIn == 30*24*3600` within ±2 s; a second sign-in by the same `did:key` → second session row, no second member row; `member_name` on documents the member then creates via `app-data` equals `app_members.name` (null → the existing `app-data` behaviour for null names).

### S-48 Replay semantics end-to-end

Re-sending the **identical** signed authenticate document (same `id`, same bytes) within the acceptance window → `200` with the **retained** `#response` (same `accessToken`), **no** new `app_sessions` row. Same `id` with a different body → `409` `idConflict`. A document whose `issuedAt` is older than the window → `422` `expired`, and it is **not** recorded in `app_tt_replay` (binding §5.1 item 3).

### S-49 Nothing touches email

`core.ts` and siblings contain no reference to `RESEND_API_KEY`, `app_login_codes`, or any email-sending call. (Grep-testable.)

### S-50 HTTP status mapping

`status.ts` maps exactly per binding §4: handled → 200; rejected → by code (`malformedRequest` 400, `permissionDenied` 403, `unsupportedType`/`unsupportedVersion`/`expired`/`proofRequired`/`proofInvalid`/`identityMismatch`/`wrongRecipient`/`taskFailed` 422, `idConflict` 409, `unavailable` 503, `internalError` 500, any `auth/…:` family code 422 unless the code's spec says otherwise); suppressed → **no body**, status 204, and a server-side log line; duplicate with prior response → 200 + that response; duplicate without → 204; accepted (fire-and-forget) → 204. Every body is `Content-Type: application/json`; every response `Cache-Control: no-store`; CORS as `app-data`.

## 6. Browser helper (`src/kit/files/lib/trust-signin.ts`)

### S-60 Key custody (VTI-CLT-001, -002, -004, -005, -006)

`getOrCreateIdentity(store = indexedDB)`: generates Ed25519 via WebCrypto with `extractable: false` when `isEd25519Available()`; otherwise, only if the caller passed `{allowInMemoryFallback: true}`, generates with `@noble/curves` and keeps it in IndexedDB as raw bytes (labelled `custody: "software"`). Returns `{ did, custody, sign(bytes) }`. The private key is never sent anywhere (grep-testable: no network call carries key material). The identity is recorded with `kind: "bootstrap"` in storage (VTI-CLT-004) so Increment 2 can distinguish it from a wallet identity. Generation performs no network I/O (VTI-CLT-005).

### S-61 `signIn(endpointBase, appId, appKey)`

1. `POST <base>/trust-tasks?app_id&app_key` with an **unsigned** `auth/challenge/0.1` document: `id = randomUUID()`, `issuer = did`, `recipient` omitted, `issuedAt = now`, `payload = {subject: did, purpose:"login"}`.
2. Build `auth/authenticate/0.3` with `id`, `issuer = did`, `recipient` omitted, `issuedAt = now`, `payload = {challenge, sessionId}`; sign with `signTrustTask` from `@openvtc/trust-tasks-proof` (`proofPurpose: "authentication"`, `verificationMethod = did + "#" + <multikey>`) **after** all members are set (GETTING-STARTED trap 4.1).
3. POST it; on 200 read `payload.tokens.accessToken` → `localStorage.member_token` (same key the email path uses) and return `{ member_token, member }`.
4. Any non-2xx with `application/json` is parsed as `trust-task-error` and thrown as `TrustSignInError{code, retryable}`; other failures are transport errors.

### S-62 Non-goal: the helper never asks for email

No input field, no `auth_request`. "Sign in with this device" is the UX phrase; the helper exposes `did` so the app can show a short form (`did:key:z6Mk…` last 6 chars).

## 7. Prompt guidance (`catalog.ts`)

### S-70 `TRUST_SIGNIN_GUIDANCE`

Appended only when env has `TRUST_TASKS_URL` (new key; `TRUST_SIGNIN_KEYS = ['TRUST_TASKS_URL']`). Tells the model: import `signIn` from `./lib/trust-signin`; offer "Sign in with this device" **alongside** email-code sign-in, never instead; treat the returned `member_token` exactly as `auth_verify`'s; the identity lives in this browser only — losing it means a new member row (say so in the UI with the email path as the recovery route); do not explain DIDs to end users. **Oracle:** guidance included iff key set; `COMMUNITY_CLOUD_GUIDANCE` byte-identical before/after.

## 8. `app-data` changes

### S-52 Byte-identical except `select` lists

`git diff <BASE_SHA> -- supabase/functions/app-data/index.ts` touches only: `select=id,email,name` → `select=id,email,name,did` in `resolveMember` and `authVerify`; returned `member` objects gain `did` (null for email members). No other hunk.

## 9. FINDINGS.md (the deliverable)

Must answer, with evidence:

1. LOC added by file; LOC changed in `app-data`.
2. Did `@openvtc/trust-tasks` and `@openvtc/trust-tasks-proof` load under Deno `npm:` specifiers? Cold-start time with and without them.
3. Which runtime behaviours matched `GETTING-STARTED.md` and which needed source reading: `UnauthenticatedTransport` + in-band issuer; optional-proof policy for challenge; `ReplayGuard` signature; status mapping helpers (did the runtime provide one?).
4. Every deviation from the two task specs and the binding, each with "what closing it requires": unsigned responses / label `local_vid`; consume-before-compare; 0.2 not registered; no `sessionKey`; no bearer identity mapping; no discovery task.
5. What the OpenVTC browser plugin did when pointed at the endpoint (it sends 0.2 — expect `unsupportedType`; record the exact error document it displayed). If it was not tried, say so.
6. The VTI Client Onboarding mapping: which of VTI-CLT-001…006, 013, 016, 040…045 the browser helper satisfies, and what "rotation" (Step 3) would mean for Community Cloud where the member row is the standing.
7. Revised effort estimates for Increments 2, 3, 4, each with the one fact from this increment that most changed it.

## 10. Increment 2 sketch (not for implementation now)

Accept `did:webvh`/`did:web` issuers: swap `DataIntegrityProofVerifier` (did:key-only) for a verifier that takes a resolver; reuse v1's `resolver.ts` with net-guard (v1 S-31/S-32). Register `auth/authenticate/0.2` for the current browser plugin. Honour `sessionKey`: store on `app_sessions`, and let `app-data` accept a Data Integrity proof by that key on write actions in place of `member_token` — this is the point where Community Cloud's bearer model and the VTI's signed-document model actually meet, and the first increment that forces a change inside `app-data` proper. Add `auth/whoami` (replaces `auth_me`) and `auth/revoke-session` (replaces `auth_signout`).

## 11. Non-functional

- **NF-1** `tsc --noEmit -p tsconfig.functions.json` passes for the function sources (ES2022 + DOM libs; `npm:` specifiers mapped via `paths`).
- **NF-2** `npx vitest run` < 60 s, no network.
- **NF-3** Dev deps only: `vitest`, `@openvtc/trust-tasks@0.26.x`, `@openvtc/trust-tasks-proof@latest-compatible`, `@noble/curves`. Edge function imports `npm:@openvtc/trust-tasks@<pinned>` and `npm:@openvtc/trust-tasks-proof@<pinned>` — pins recorded in `BASE_SHA`.
- **NF-4** No secrets in committed files. `.env.example` gains `TRUST_TASKS_LOCAL_VID=` with a comment.
- **NF-5** Every spike-grade shortcut carries `// SPIKE:`.

## 12. Test strategy (for the test agent)

Tests in `tests/app-trust-tasks/`. Import the Deno-free modules directly. Build `producer.ts` (the test-side client: `mintDidKey()`, `challengeDoc()`, `authenticateDoc()` signed with `signTrustTask`) — it must mirror `trust-signin.ts`'s wire output so the two are cross-checked by a fixture test. Build `fake-postgrest.ts` modelling only: `select=`, `eq.`, `lt.`, `is.null`, `order=`, `limit=`, `Prefer: return=representation`, 409 on unique violations (`app_tt_challenges.session_id`, `app_tt_replay.doc_id`, `(app_id, did)`), and PATCH-with-filter returning affected rows; throw on anything unmodeled.

| File | Requirements |
|---|---|
| `migration.test.ts` | S-10, S-11 (real Postgres if `pg-mem`/embedded available; else statement-level parse + `todo`) |
| `challenges.test.ts` | S-20, S-21 (incl. concurrency), S-23 |
| `replay.test.ts` | S-22 (duplicate, conflict, fail-closed when fetch throws) |
| `core.auth.test.ts` | S-40, S-41, S-49, S-50 |
| `core.challenge.test.ts` | S-43 incl. non-did:key subject refusal |
| `core.authenticate.test.ts` | S-42, S-44 (each error code), S-45, S-46, S-47, S-48 |
| `producer-helper.fixture.test.ts` | S-60, S-61 wire shape equals `producer.ts` output for a fixed seed and fixed `now` |
| `catalog.test.ts` | S-70 |
| `app-data.snapshot.test.ts` | S-52 against `git show <BASE_SHA>:supabase/functions/app-data/index.ts` |

Each `it()` title begins with its requirement id.

## Appendix A — `tsconfig.functions.json` (create it; the project has none)

The existing edge functions have no imports and are not type-checked by anything (`tsconfig.app.json` includes only `src/`). `app-trust-tasks` is the first function with npm dependencies, so this file is new. **Do not add it to `tsconfig.json`'s `references`**: `tsc -b` runs in `npm run build` and the Vercel deploy must not depend on edge-function type errors. Run it as its own script: `"typecheck:functions": "tsc --noEmit -p tsconfig.functions.json"`.

Two problems it solves: (1) `Deno.*` globals — only `index.ts` uses them, so `index.ts` is excluded here and checked with `deno check` instead; this keeps the gate-G3 grep ("no `Deno.` in core modules") meaningful. (2) `npm:` specifiers — `tsc` does not understand them; `paths` maps each pinned specifier to the locally installed devDependency **for types only**. A green `tsc` does not prove Deno can load the package; that is what the Phase 0 `deno eval` smoke test is for.

```jsonc
{
  "compilerOptions": {
    "ignoreDeprecations": "6.0",
    "target": "es2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "types": [],
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
    "baseUrl": ".",
    "paths": {
      "npm:@openvtc/trust-tasks@<PIN>":       ["./node_modules/@openvtc/trust-tasks"],
      "npm:@openvtc/trust-tasks@<PIN>/*":     ["./node_modules/@openvtc/trust-tasks/dist/*"],
      "npm:@openvtc/trust-tasks-proof@<PIN>": ["./node_modules/@openvtc/trust-tasks-proof"],
      "npm:@noble/curves@<PIN>/*":            ["./node_modules/@noble/curves/*"]
    }
  },
  "include": [
    "supabase/functions/app-trust-tasks/**/*.ts",
    "src/kit/files/lib/trust-signin.ts"
  ],
  "exclude": ["supabase/functions/app-trust-tasks/index.ts"]
}
```

`<PIN>` values are filled by the design agent from what Phase 0 installed and must equal the specifiers used in `index.ts` and recorded in `BASE_SHA`; a mismatch fails as "cannot find module", which is the desired behaviour. Relative imports inside the function use explicit `.ts` extensions (Deno requires them; `allowImportingTsExtensions` lets `tsc` accept them). Where Deno is available, the implementer also runs `deno check supabase/functions/app-trust-tasks/index.ts`; where it is not, `tsc` plus the Phase 0 smoke test is the gate. NF-1 is amended accordingly.
