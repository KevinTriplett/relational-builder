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
2. Consumption of exactly two type URIs: `https://trusttasks.org/spec/auth/challenge/0.1` and `https://trusttasks.org/spec/auth/authenticate/0.3` (ordinary form: `payload.principal` absent or equal to `issuer`). Everything else → `unsupportedType` (another version of either slug → `unsupportedVersion`, S-41).
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
- A service DID for Community Cloud. The consumer's `local_vid` is a `did:web` *string* configured by env (S-30) but **nothing resolves it and nothing signs responses** in Increment 1. The HTTPS binding does not require signed responses. *(Amended, Changelog C-1.)* `auth/authenticate/0.3` **does** require a proof on its `#response`. Its single `proofRequirement: REQUIRED` applies to every variant (SPEC §7.3 item 8), and the generated `AuthAuthenticate_v0_3.RESPONSE_SPEC.isProofRequired` is `true`. Unsigned `#response` documents are therefore a **recorded deviation**, not a conformant choice. A client that validates responses with `consumeInbound(RESPONSE_SPEC)` would reject them with `proofRequired`. `trust-signin.ts` does not run the pipeline on responses. Closing the deviation requires a service signing key and a resolvable `did:web` (Increment 3 territory). `auth/challenge/0.1` responses require no proof.
- Email path changes. Byte-identical except `select` lists (S-52).
- The VTI client *rotation* (Step 3 of the Client Onboarding chapter, `acl/swap-key`). Community Cloud has no ACL entries per member in the VTI sense; the member row *is* the standing. Record in FINDINGS what rotation would mean here.

## 2. Architecture

```
Generated app (any origin)
  trust-signin.ts
    1. mint or load did:key (WebCrypto Ed25519 non-extractable, else @noble fallback)   [VTI-CLT-001..006]
    2. POST /trust-tasks  auth/challenge/0.1  {recipient: TRUST_TASKS_VID, payload:{subject: did, purpose:"login"}}  (unsigned OK)
    3. POST /trust-tasks  auth/authenticate/0.3 {recipient: TRUST_TASKS_VID, payload:{challenge, sessionId}} + proof (eddsa-jcs-2022, did:key, proofPurpose authentication)
    4. read #response payload.tokens.accessToken  →  member_token  (identical to email path)
  ▼
app-trust-tasks edge function (Deno)              ← Trust-Task base = <fn url>; path = /trust-tasks
  ├─ app_id/app_key from query string (?app_id=&app_key=)     [S-40]   (body is the bare document per binding §2)
  ├─ parse → dispatch on `type`                                [S-41]
  ├─ consumeInbound (@openvtc/trust-tasks)                     [S-42]
  │     transport    = UnauthenticatedTransport (no bearer in Increment 1; in-band issuer is authoritative)
  │     proofPolicy  = verify via DataIntegrityProofVerifier (did:key only)
  │     payloadPolicy= validate SPEC.payloadSchema (shipped as a value) with subsetSchemaValidator [S-25]
  │     checks       = authenticateChecks(PostgresReplayGuard, window) for authenticate
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
src/cloud/community-cloud.ts              (+ setVar('TRUST_TASKS_URL', …), setVar('TRUST_TASKS_VID', …))  [S-71]
src/kit/index.ts                          (+ KIT_FILES['/src/lib/trust-signin.ts'])  [S-63]
src/preview/bundler/versions.ts           (+ PINNED_VERSIONS for the proof package and @noble/curves)  [S-63]
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

### S-12 PostgREST surface is closed *(new, C-2)*

The function issues **only** the PostgREST calls listed in `DESIGN.md` §3 (P1–P13): methods `GET`/`POST`/`PATCH`/`DELETE`; operators `eq.`, `lt.`, `lte.`, `is.null`; `select=`; `Prefer: return=minimal` or `return=representation`. The test fake models exactly that list and throws on anything else.

## 4. Stores

### S-20 `PostgresChallengeStore.issue`

`issue({appId, subject?, ttlMs}) → {sessionId, challenge, expiresAt}`. `sessionId` = `crypto.randomUUID()`. `challenge` = 32 random bytes, base64url, no padding (≥ 128 bits: spec item 2). Inserts one row. A duplicate `session_id` (astronomically unlikely) → retry once, then throw.

### S-21 `PostgresChallengeStore.lookupAndConsume`

`lookupAndConsume({appId, sessionId, now}) → {kind:"notFound"} | {kind:"expired"} | {kind:"ok", challenge, subject}`. Implemented as **one** `PATCH /app_tt_challenges?session_id=eq.<id>&app_id=eq.<appId>&consumed_at=is.null` with body `{consumed_at: now}` and `Prefer: return=representation`. Zero rows → `notFound` (covers both never-issued and already-consumed — the spec's single `challengeNotFound` code). One row with `expires_at < now` → `expired` (row stays consumed; a second attempt is `notFound`). Else `ok`. Rows for another `app_id` are invisible. A non-2xx answer or a rejected `fetch` makes `lookupAndConsume` (and `issue`) **throw**. The authenticate and challenge handlers catch that and refuse with `unavailable` (`retryable: true`, 503), and they never let it propagate out of `consumeInbound` (C-9). The `sessionId` is URL-encoded, and any string is a valid lookup key: an unknown one is `notFound`.

**Oracle:** two concurrent `lookupAndConsume` for the same id — exactly one `ok`, the other `notFound`.

### S-22 `PostgresReplayGuard` implements `ReplayGuard`

Implements the `ReplayGuard` interface exported by `@openvtc/trust-tasks` (read its exact shape from `trust-tasks-ts/src/_runtime/replay.ts` — the design agent copies the signature into DESIGN.md). Semantics per binding §5.1: keyed on `id`; same `id` + same digest → duplicate (return retained response when present); same `id` + different digest → `idConflict`; record is written at the commit point (after all checks, before the handler runs); store unreachable → the guard reports unavailable and the consumer answers `unavailable`/503 and does **not** execute (fail closed, §5.1 item 5). *(Amended, C-3.)* "Reports unavailable" means `claim` **throws**; `consumeInbound` maps the throw to `unavailable`, `retryable: true`. Retention is `until_at = retainUntil + retentionPadMs`. `retainUntil` is the value the runtime passes (`recordExpiry`: `expiresAt` if present, else `issuedAt + maxAgeMs`), and `retentionPadMs` defaults to `DEFAULT_SKEW_MS` (60 000). The pad closes a runtime gap: freshness accepts documents up to `issuedAt + maxAgeMs + skewMs`, but `recordExpiry` stops at `issuedAt + maxAgeMs`. A `retainUntil` of `undefined` makes `claim` throw.

Exact `claim(id, digest, retainUntil, now)` algorithm (DESIGN §3 numbering):
1. P5 insert `{doc_id:id, app_id, digest, response:null, until_at}`. On 201 → `fresh`, then fire-and-forget P8 (`until_at=lt.<now>`; its failure is ignored).
2. On 409 → P6 read. If `[]` (raced delete), retry step 1 once.
3. If the row's `until_at ≤ now` → P7 delete (`until_at=lte.<now>`), then retry step 1 once.
4. If the row's `app_id ≠` this guard's app, or its `digest ≠ digest` → `conflict` (S-24).
5. Otherwise → `duplicate`. When `response` is null, `inFlight: true` with no `priorResponse`. Otherwise `priorResponse: response, inFlight: false`.
6. Any other status, a second failed retry, or a rejected `fetch` → throw.

`recordResponse` = P9 and throws on non-2xx. `release` = P10.

### S-23 Sweep

`PostgresChallengeStore.sweep()` deletes `app_tt_challenges` where `expires_at < now - 1h`. Called fire-and-forget from the challenge handler.

### S-24 The replay record is app-scoped *(new, C-3)*

`app_tt_replay.doc_id` is globally unique, but a `PostgresReplayGuard` is constructed per request with the authenticated `appId`. A row written by app A, offered under app B with the same `id`, is `conflict` (409 `idConflict`) whatever its digest. App B's caller **never** receives app A's retained response, which contains an access token. `recordResponse` and `release` filter on `app_id` as well.

**Oracle:** app A completes a sign-in. The identical document is sent with app B's credentials (with `trust_signin_enabled` true for both) → 409, and the body contains no `accessToken`.

### S-25 Payload validation without a schema engine *(new, C-4)*

The npm package ships each task's payload schema as a value (`AuthChallenge_v0_1.SPEC.payloadSchema`, `AuthAuthenticate_v0_3.SPEC.payloadSchema`, refs inlined) but no validator, and NF-3 forbids adding one. `core.ts` exports `subsetSchemaValidator: PayloadValidator`, which implements exactly `SUPPORTED_SCHEMA_KEYWORDS`:
- Annotations, ignored: `$schema`, `$id`, `$anchor`, `title`, `description`.
- `$defs`, and `$ref` restricted to the form `#/$defs/<name>`.
- `type`, `properties`, `additionalProperties` (boolean, or a schema), `required`, `items`, `minLength`, `maxLength`, `pattern`, `format` (`date-time` only, RFC 3339), `minimum`, `minItems`, `minProperties`, `propertyNames`.

String length counts Unicode code points. Any other keyword, or another `$ref` form, **throws**; `consumeInbound` turns the throw into `malformedRequest`. `assertSchemaSupported(schema)` throws on the same conditions without a payload.

**Oracle:** `assertSchemaSupported` passes for the request and response schemas of both pinned tasks. The validator accepts each spec's valid examples and rejects every entry of each task's `payload.invalid-examples.json` under `.spike-deps/dtgwg-trust-tasks-tf/specs/auth/{challenge/0.1,authenticate/0.3}/`. A schema containing `oneOf` makes it throw.

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

*(Amended, C-22.)* The binding signatures are in `DESIGN.md` §2. `CoreDeps` now extends `PostgrestDeps` and adds a required `rateLimiter: RateLimiter`, plus optional `randomUUID`, `randomBytes` and `log`. `handleTrustTask` returns `CoreResponse` (same shape as above). It never throws.

### S-30 `localVid` is configuration, not identity

`localVid` comes from env `TRUST_TASKS_LOCAL_VID` and defaults to `did:web:<SUPABASE project host>` when unset. It is used only as the transport-authenticated *recipient* for the §4.8.1 cross-check (`wrongRecipient` when the document's `recipient` is present and differs) and as `issuer` of response documents. **Nothing resolves it and nothing signs with it in Increment 1**; code comment `// SPIKE: unsigned responses; local_vid is a label` is mandatory.

*(Amended, C-5.)* The default is computed by `localVidFromSupabaseUrl(SUPABASE_URL)` = `did:web:` + the URL's `hostname`, followed by `%3A<port>` only when the URL carries an explicit non-default port (did:web method rule: a port is percent-encoded); no scheme, no path (C-25). Examples: `https://abcd.supabase.co/functions/v1` → `did:web:abcd.supabase.co`; `http://localhost:54321` → `did:web:localhost%3A54321`. **Every document the function emits** has `issuer === localVid`: success responses, handler refusals, runtime rejections, and errors built without a parsed request. The runtime builds error documents with `issuer: request.recipient`, which under `wrongRecipient` is the VID the consumer has just said it is not, so `core.ts` re-stamps `issuer` (`stampIssuer`).

What the runtime does with `recipient`:
- Present and different from `localVid` → `wrongRecipient` (422). The runtime does not return `identityMismatch` here, although HTTPS binding 0.2 §3 says it should. Record this in FINDINGS.
- **Absent** → `malformedRequest` (400), because both tasks declare `recipient` REQUIRED (`isRecipientRequired: true`).

**Oracle:** a document whose `recipient` is `did:web:other.example` → 422 `wrongRecipient` with error `issuer === localVid`. A document with no `recipient` → 400 `malformedRequest`.

### S-40 App authentication precedes parsing

`appId`/`appKey` come from the function URL query string (`?app_id=&app_key=`) because the HTTPS binding (§2) requires the body to be the bare document. Missing → `401 {error:"app_id and app_key required"}` (plain JSON, **not** a trust-task-error: binding §4 says missing auth is transport-level). Unknown app or wrong key → `403 {error:"Unknown app or wrong key"}`. `trust_signin_enabled = false` → `403 {error:"Trust Task sign-in is not enabled for this app"}`. Rate limit 120/min per app → `429` plain JSON. Only then is `rawBody` examined.

*(Amended, C-6.)* The order matches `app-data`, which rate-limits *before* the database lookup:
1. Missing credentials → 401.
2. `deps.rateLimiter.hit(appId, now)` → 429 `{error:"Rate limit exceeded — try again in a minute"}`.
3. App lookup (P1, `select=id,app_key,trust_signin_enabled`): a rejected `fetch` or a 5xx → `503 {error:"Service unavailable"}`; any other non-2xx, an empty result or a key mismatch → 403.
4. Not enabled → 403.

Every one of these bodies is plain JSON, never a trust-task-error. Where `trust_signin_enabled` is false, the 403 precedes any challenge or replay store access (zero P2–P13 calls).

### S-41 Parse and dispatch

`rawBody` must be a JSON object with string `type`; otherwise `400` with a `trust-task-error` whose code is `malformedRequest` (*C-32: every `malformedRequest` this consumer emits has `retryable: false`, SPEC §8.3 default*) (use `rejectWith` from the runtime). `type` not in the registered set → `422` with `unsupportedType`. The two registered URIs are exact-match strings; `…/auth/authenticate/0.2` is **not** registered in Increment 1 (the plugin's current version) — record this in FINDINGS as the compatibility question it is, and make the registered set a single constant `REGISTERED_TYPES` so Increment 2 can add 0.2.

*(Amended, C-7.)*
- **Unparseable body.** `index.ts` passes `rawBody: undefined` for a body that is not valid JSON. That gives 400 `malformedRequest`, the same as a non-object.
- **Unsupported version.** A `type` with the slug of a registered task but a different version (for example `…/auth/authenticate/0.2`, or `…/auth/challenge/0.2`) → 422 **`unsupportedVersion`** (SPEC §8.3: "recognized but its MAJOR.MINOR version is not supported"). Any other `type` → 422 `unsupportedType`. Fragments (`#response`) are not registered: a `#response` posted here → `unsupportedType`.
- **Envelope shape.** For a registered type, `checkFrameworkShape` must pass before `consumeInbound`, else 400 `malformedRequest`. It requires `id` to be a non-empty string and `payload` a JSON object. `issuer`, `recipient`, `issuedAt`, `expiresAt` and `threadId` must be strings when present, and `proof` an object when present. The runtime performs none of these checks (it states that §7.2 item 1 belongs to the caller).
- **Error documents without a parsed request** (`errorDocument`): `type = TRUST_TASK_ERROR_TYPE_URI`, `issuer = localVid`, `recipient` = the body's `issuer` when it is a string, `threadId` = the body's `threadId ?? id` when a string, else the error's own `id`. `inResponseTo` is set only when the body's `type` and `id` are strings.

**Oracle:** `…/auth/authenticate/0.2` → 422 `unsupportedVersion`; `…/acl/grant/0.1` → 422 `unsupportedType`; `{type: CHALLENGE_TYPE, payload: {}}` without `id` → 400 `malformedRequest`; body `"not json"` → 400.

### S-42 `consumeInbound` is the pipeline

Both handlers run through `consumeInbound` from `@openvtc/trust-tasks` with: `transport = new UnauthenticatedTransport()` (no bearer in Increment 1; the in-band `issuer` is then authoritative per §4.8.1 — confirm in design phase that `UnauthenticatedTransport` yields that behaviour and does not reject every document as `identityMismatch`); `myVid = deps.localVid`; `now`; `newErrorId = crypto.randomUUID`; `payloadPolicy = {kind:"validate", validate}` where `validate` checks against the task's `payload.schema.json` bundled from the npm package (use the `PayloadSchemaJSON`/equivalent export if present; else vendor the two schema files under `supabase/functions/app-trust-tasks/schemas/` with provenance comment).

For **challenge**: `proofPolicy = {kind:"verify", verify}` **but** absence of proof is not an error (spec: proof OPTIONAL). Confirm the runtime expresses "optional, verify if present" — if it needs a distinct policy kind, use it; if it cannot, run `verifyDetailed` manually and document. `checks = notConsequentialChecks()`. Freshness: `DEFAULT_FRESHNESS`.

For **authenticate**: `proofPolicy = {kind:"verify", verify: new DataIntegrityProofVerifier()}` (hard-required). `checks = consequentialChecks(new PostgresReplayGuard(...))`. Freshness: `CONSEQUENTIAL_FRESHNESS` with the acceptance window = `deps.acceptanceWindowMs`; `issuedAt` REQUIRED (spec `issuedAtRequirement`), missing → the runtime's `ISSUED_AT_REQUIRED` rejection.

The five outcomes map to HTTP per binding §4 via `status.ts` (S-50).

*(Amended, C-8; design phase resolved the open questions.)*
- **(a) Issuer authority.** `UnauthenticatedTransport` derives no parties, so the in-band `issuer` is authoritative and `identityMismatch` / `suppressed` cannot occur.
- **(b) Optional proof.** "Optional, verify if present" is `{kind:"verify"}` plus the spec's `isProofRequired: false`. Both tasks use the same policy, `proofPolicy = {kind:"verify", verify: new PurposeCheckingVerifier(new DataIntegrityProofVerifier({now: () => deps.now().getTime()}))}`. `PurposeCheckingVerifier` returns false (→ `proofInvalid`, 422) unless `proof.proofPurpose` is one of `SIGNING_PROOF_PURPOSES` (SPEC §4.7.3 item 1), because the upstream verifier does not check it.
- **(c) Schemas.** The schemas are `SPEC.payloadSchema` from `AuthChallenge_v0_1` and `AuthAuthenticate_v0_3`, validated by `subsetSchemaValidator` (S-25). Nothing is vendored.
- **(d) Acceptance window.** `consequentialChecks()` cannot take a window, so authenticate uses `checks = authenticateChecks(guard, acceptanceWindowMs)`, which is `{freshness: {...CONSEQUENTIAL_FRESHNESS, maxAgeMs: acceptanceWindowMs}, replay: {kind:"guard", guard}}`.
- **(e) Missing `issuedAt`.** On authenticate this is **400 `malformedRequest`** with message `ISSUED_AT_REQUIRED`. The challenge accepts a missing `issuedAt`.
- **(f) Clock seam.** `consumeInbound` gets `now: deps.now().getTime()` and `clock: () => deps.now().toISOString()`. `respondWith` gets the same clock. No module calls `Date.now()` or `new Date()` without an argument.
- **(g) Check order.** The runtime validates the payload schema *first*, then expiry/recipient, freshness, identity, proof, spec policy (recipient required → proof required → `issuedAt` required → audience binding), then the replay claim, then the handler. A document that fails several checks is refused with the first.

### S-43 Challenge handler

Given an accepted `auth/challenge/0.1` document: if `payload.subject` is present and is not an Ed25519 `did:key` (`^did:key:z6Mk`; *C-31: precisely — matches `^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$` with no fragment, **and** `publicKeyFromDidKey(subject)` returns `{curve:"ed25519"}`*) → `trust-task-error` code `auth/challenge:subjectNotRecognized`, `retryable:false`. Else `issue({appId, subject, ttlMs: challengeTtlMs})` and respond with a `…/auth/challenge/0.1#response` document whose payload is `{challenge, sessionId, expiresAt}` (ISO-8601), `issuer = localVid`, `recipient = document.issuer` when present, `threadId = document.id`. Fire-and-forget `sweep()`.

*(Amended, C-10.)* Build the response with the runtime's `respondWith(document, randomUUID(), payload, clock)`. That gives `threadId = document.threadId ?? document.id` and `recipient = document.issuer`. Then `stampIssuer(…, localVid)`. If `issue` throws, the handler refuses with `unavailable` (`retryable: true`, 503). `subjectNotRecognized` is built with `rejectWith` and the `CODES` constant, and the handler checks `subject` only when it is present.

**Oracle:** challenge is ≥ 43 base64url chars; `expiresAt - now` within [30 s, 5 min]; a second call yields different `sessionId` and `challenge`.

### S-44 Authenticate handler — binding checks in spec order

Given an accepted `auth/authenticate/0.3` document (proof already verified by the pipeline, so `issuer` is proven):

1. `lookupAndConsume(sessionId)`: `notFound` → `auth/authenticate:challengeNotFound` (retryable false); `expired` → `auth/authenticate:challengeExpired` (retryable true).
2. Constant-time compare `payload.challenge` to stored → mismatch → `auth/authenticate:challengeMismatch`. (Note order: the spec consumes at item 6 after comparing at item 3; Increment 1 consumes *first* via the single atomic PATCH and accepts that a mismatched guess also burns the challenge. Record this as a deliberate deviation: it is strictly safer and simpler than a two-step read-then-consume on PostgREST.)
3. Acting party = `issuer` (ordinary form). If the stored `subject` is non-null and ≠ issuer → `auth/authenticate:subjectMismatch`.
4. `payload.scope` present → ignore contents; response `tokens.scope` is omitted (no scope vocabulary yet).

*(Amended, C-11.)* The handler runs only after the runtime has claimed the replay record. It applies these checks in this order, first failure wins:
1. `lookupAndConsume` → `challengeNotFound` (retryable false) / `challengeExpired` (retryable **true**) / a thrown store error → `unavailable` (retryable true).
2. `constantTimeEqual(payload.challenge, stored)` false → `challengeMismatch`.
3. **Acting party** = `payload.principal ?? issuer` (the task spec's item 5). Stored `subject` non-null and ≠ acting party → `subjectMismatch`.
4. `payload.principal` present and ≠ `issuer` → S-46.
5. `payload.sessionKey` present → S-45.
6. S-47 minting. A thrown store error here → `unavailable`.

Refusals are built with `rejectWith(document, randomUUID(), {code, message, retryable}, clock)` and then `stampIssuer`. Messages are constants that name no DID, challenge or token. Because a handler refusal with `retryable: true` makes the runtime `release` the claim, an identical resend after `challengeExpired` or `unavailable` is re-executed and then gets `challengeNotFound`, since the challenge is already consumed. Non-retryable refusals are retained, and an identical resend gets the same error document back (S-48, S-50). The handler **never throws**: a thrown handler would leave the claim in flight, and every retry would get 202 until the record expired.

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

*(Amended, C-15.)*
- **Document construction.** The response is `stampIssuer(respondWith(document, randomUUID(), payload, clock), localVid)`, with type `…/auth/authenticate/0.3#response`.
- **Calls.** Members use P11/P12 (409 race → P11 again) and sessions use P13.
- **Schema.** The payload must validate against `AuthAuthenticate_v0_3.RESPONSE_SPEC.payloadSchema` with `subsetSchemaValidator`. The `ext` key `org.relationalbuilder.cloud` satisfies the schema's reverse-DNS `propertyNames` pattern.
- **Times.** `expiresIn` is `Math.round(sessionTtlMs / 1000)`, and `session.issuedAt` / `session.expiresAt` come from `deps.now()`.
- **Mark.** This response is **unsigned**; `// SPIKE:` (see §1.2).

**Oracle:** full producer flow with a fresh `did:key` → one `app_members` row (did set, email null), one `app_sessions` row whose token equals `tokens.accessToken`; `expiresIn == 30*24*3600` within ±2 s; a second sign-in by the same `did:key` → second session row, no second member row; `member_name` on documents the member then creates via `app-data` equals `app_members.name` (null → the existing `app-data` behaviour for null names).

### S-48 Replay semantics end-to-end

Re-sending the **identical** signed authenticate document (same `id`, same bytes) within the acceptance window → `200` with the **retained** `#response` (same `accessToken`), **no** new `app_sessions` row. Same `id` with a different body → `409` `idConflict`. A document whose `issuedAt` is older than the window → `422` `expired`, and it is **not** recorded in `app_tt_replay` (binding §5.1 item 3).

*(Amended, C-14.)*
- **The window's edge.** "Older than the window" means `issuedAt + acceptanceWindowMs + 60 000 (skew) < now` (runtime freshness rule). A document `acceptanceWindowMs + 30 s` old is still accepted, and its replay record must still be live (S-22 pad).
- **Retained errors.** A non-retryable refusal is retained too. Re-sending the identical document returns the *same* error document under its code's status, and makes no new store calls beyond P5/P6.

**Additional oracle:** a document `acceptanceWindowMs + 30 s` old completes once. Its identical resend → the retained response, and the session count is unchanged.

### S-49 Nothing touches email

`core.ts` and siblings contain no reference to `RESEND_API_KEY`, `app_login_codes`, or any email-sending call. (Grep-testable.)

### S-50 HTTP status mapping

`status.ts` maps exactly per binding §4: handled → 200; rejected → by code (`malformedRequest` 400, `permissionDenied` 403, `unsupportedType`/`unsupportedVersion`/`expired`/`proofRequired`/`proofInvalid`/`identityMismatch`/`wrongRecipient`/`taskFailed` 422, `idConflict` 409, `unavailable` 503, `internalError` 500, any `auth/…:` family code 422 unless the code's spec says otherwise — *C-33: no task spec maps a code to an HTTP status, so every extended code is 422, including `auth/challenge:rateLimited` (which this consumer never emits; S-40's 429 is transport-level plain JSON)*); suppressed → **no body**, status 204, and a server-side log line; duplicate with prior response → 200 + that response; duplicate without → 204; accepted (fire-and-forget) → 204. Every body is `Content-Type: application/json`; every response `Cache-Control: no-store`; CORS as `app-data`.

*(Amended, C-12: resolved against binding 0.2 §4. The runtime ships no status helper.)* `statusForCode(code)` first applies `normalizeCode` (0.1 snake_case → camelCase). Then:
- `malformedRequest` → 400
- `permissionDenied` → 403
- `idConflict` → 409
- `unavailable` → 503
- `internalError` → 500
- `unsupportedType`, `unsupportedVersion`, `expired`, `proofRequired`, `proofInvalid`, `identityMismatch`, `wrongRecipient`, `cancelled`, `taskFailed` → 422
- any extended `slug:local` code → 422
- any other standard-looking code → 500 (as `trust-tasks-https` `status_for_code`)

`mapOutcomeToHttp`:

| Outcome | Status | Body |
|---|---|---|
| `handled` | 200 | the response |
| `rejected` | `statusForCode(error.payload.code)` | the error |
| `suppressed` | 400 | a **generic `malformedRequest`** document from `genericMalformed()`, plus a `log`. The reference server does this so there is no oracle. Unreachable with `UnauthenticatedTransport`; this replaces the original 204. |
| `accepted` | 204 | no body |
| `duplicate` with `priorResponse` | 200, or `statusForCode` of its code when the prior is a `trust-task-error` | that document. Binding §4 says 200 for a retained result; using the error's status for a retained error is our interpretation, recorded in FINDINGS. |
| `duplicate`, no `priorResponse`, `inFlight: true` | **202** | empty (binding row; replaces 204) |
| `duplicate`, no `priorResponse`, `inFlight: false` | 204 | empty |

202 and 204 carry **no `Content-Type`**. `index.ts` also turns any exception that escapes `handleTrustTask` into a 500 `internalError` trust-task-error with message `"internal error"` and no stack.

### S-51 `index.ts` routing *(new, C-13)*

- `OPTIONS` (any path) → 204 with `CORS_HEADERS` and no body. This deviates from binding 0.2 §2 item 1 ("every other method → 405"), because browsers need the preflight. Mark it `// SPIKE:`.
- `POST` to a path ending in `/trust-tasks` → `handleTrustTask`.
- Any other path → 404. Any other method on `/trust-tasks` → 405.

404/405 bodies are plain JSON. `app_id`/`app_key` come from `new URL(req.url).searchParams`. `CoreDeps` is built once per isolate:
- `fetch`
- `restUrl` / `svcHeaders` as in `app-data`
- `now: () => new Date()`
- `localVid: Deno.env.get("TRUST_TASKS_LOCAL_VID") || localVidFromSupabaseUrl(SUPABASE_URL)`
- `rateLimiter: new InMemoryRateLimiter()`
- `log: console.log`

`index.ts` is ≤ 60 lines.

## 6. Browser helper (`src/kit/files/lib/trust-signin.ts`)

### S-60 Key custody (VTI-CLT-001, -002, -004, -005, -006)

`getOrCreateIdentity(store = indexedDB)`: generates Ed25519 via WebCrypto with `extractable: false` when `isEd25519Available()`; otherwise, only if the caller passed `{allowInMemoryFallback: true}`, generates with `@noble/curves` and keeps it in IndexedDB as raw bytes (labelled `custody: "software"`). Returns `{ did, custody, sign(bytes) }`. The private key is never sent anywhere (grep-testable: no network call carries key material). The identity is recorded with `kind: "bootstrap"` in storage (VTI-CLT-004) so Increment 2 can distinguish it from a wallet identity. Generation performs no network I/O (VTI-CLT-005).

*(Amended, C-16.)*
- **Async detection.** `isEd25519Available()` is **async** (`Promise<boolean>`): the only reliable probe is a `crypto.subtle.generateKey({name:"Ed25519"}, false, ["sign","verify"])` attempt.
- **Async signing.** `DeviceIdentity.sign(bytes)` returns `Promise<Uint8Array>`, because WebCrypto signing is async. For the same reason `signTrustTask` cannot sign with a non-extractable key: its `Signer.sign` is synchronous.
- **Public key.** For the WebCrypto path, the public key is exported raw (always allowed for the public half) to build the `did:key`.
- **Software path.** It stores the 32-byte seed under `custody: "software"`, and only when `allowInMemoryFallback` is true. Otherwise it throws `TrustSignInError('unsupported', false, 0)`.
- **Signature.** `getOrCreateIdentity(options?: {store?, allowInMemoryFallback?})`; the default store is `indexedDbIdentityStore()`, persisting under `IDENTITY_KEY`.

### S-61 `signIn(endpointBase, appId, appKey)`

1. `POST <base>/trust-tasks?app_id&app_key` with an **unsigned** `auth/challenge/0.1` document: `id = randomUUID()`, `issuer = did`, `recipient` omitted, `issuedAt = now` (*C-27: `now.toISOString()`, milliseconds kept; one `options.now()` reading per document*), `payload = {subject: did, purpose:"login"}`.
2. Build `auth/authenticate/0.3` with `id`, `issuer = did`, `recipient` omitted, `issuedAt = now`, `payload = {challenge, sessionId}`; sign with `signTrustTask` from `@openvtc/trust-tasks-proof` (`proofPurpose: "authentication"`, `verificationMethod = did + "#" + <multikey>`) **after** all members are set (GETTING-STARTED trap 4.1).
3. POST it; on 200 read `payload.tokens.accessToken` → `localStorage.member_token` (same key the email path uses) and return `{ member_token, member }`.
4. Any non-2xx with `application/json` is parsed as `trust-task-error` and thrown as `TrustSignInError{code, retryable}`; other failures are transport errors.

*(Amended, C-17. Steps 1–2 above said "`recipient` omitted"; that is unachievable.)* Both task specs declare `recipient` REQUIRED (`isRecipientRequired: true`), and the runtime rejects a document without one as `malformedRequest`. Signed documents also need it for audience binding (SPEC §4.8.2). The signature is therefore `signIn(endpointBase, appId, appKey, options: SignInOptions)` with **required** `options.recipient` (the app passes `env.TRUST_TASKS_VID`, S-71). Both documents carry `recipient = options.recipient`.

Signing:
- **Function.** Signing uses `signDocument(doc, identity, created)`, which implements eddsa-jcs-2022 exactly as `signTrustTask` does:
  - `proof` config = `{type:"DataIntegrityProof", cryptosuite:"eddsa-jcs-2022", created, verificationMethod, proofPurpose:"authentication"}`.
  - `created` is ISO-8601 UTC with a `.000Z` suffix shortened to `Z`.
  - `hashData` = SHA-256(JCS(config)) ‖ SHA-256(JCS(doc ∖ proof)), using the package's exported `canonicalBytes`.
  - `proofValue` = `toMultibase(await identity.sign(hashData))`.
- **Purpose.** `proofPurpose` is `"authentication"` explicitly, because `signTrustTask` defaults to `"assertionMethod"`.
- **Issuer check.** `signDocument` throws if `doc.issuer !== identity.did`.
- **Bare signature.** `endpointBase` is the Trust-Task base (`env.TRUST_TASKS_URL`). The request URL is `endpointBase` with one trailing `/` stripped, then `"/trust-tasks?app_id=…&app_key=…"` (binding §6.1).
- **Statuses.** A 202 or 204 on authenticate is a `TrustSignInError('noResponse', true, status)`, so the app retries with new documents. A 200 whose body is a `trust-task-error` is thrown like a non-2xx.
- **Clock.** All time comes from `options.now`. *(C-28)* `buildAuthenticateDocument` and `signDocument` inside `signIn` use the **same single** `options.now()` reading: `issuedAt = t.toISOString()`, `created = t` (formatted per the `created` rule). **Transport failures** *(C-29)*: a rejected `fetch` (no response) → `TrustSignInError('transport', true, 0)`; a non-2xx without `application/json`, or a JSON body that is not a trust-task-error → `TrustSignInError('transport', status >= 500, status)`.

**Oracle (fixture test):** for a fixed seed, a fixed `now` and fixed ids, `signDocument` with a software identity produces byte-identical JSON to `signTrustTask(doc, signerFromPrivateKey("ed25519", seed), {proofPurpose:"authentication", created})`. `producer.ts` output for the same inputs equals `buildAuthenticateDocument` + `signDocument`.

### S-62 Non-goal: the helper never asks for email

No input field, no `auth_request`. "Sign in with this device" is the UX phrase; the helper exposes `did` so the app can show a short form (`did:key:z6Mk…` last 6 chars).

### S-63 Kit wiring *(new, C-18)*

The helper reaches generated apps only through the kit:
- **Registration.** `src/kit/index.ts` imports `./files/lib/trust-signin.ts?raw` and adds `'/src/lib/trust-signin.ts'` to `KIT_FILES`. `withKitFiles()` then materializes it when a project imports `./lib/trust-signin` or `@/lib/trust-signin`.
- **Imports.** The file uses **bare** specifiers only: `@openvtc/trust-tasks` (type-only), `@openvtc/trust-tasks-proof`, `@noble/curves/ed25519.js`. No `npm:` or `@/` aliases are allowed.
- **Version pins.** `src/preview/bundler/versions.ts` `PINNED_VERSIONS` gains `'@openvtc/trust-tasks-proof': '0.1.3'` and `'@noble/curves': '2.4.0'`.
- **Type-checking.** The file is also type-checked by `tsc -b` (`tsconfig.app.json` includes `src/`).
- **Limitation.** `KIT_FILES` is merged only for framework-shaped projects (FrameworkPreview and publish builds). Sandpack-routed "simple tools" cannot import the helper in Increment 1. S-70 guidance says so. Record this in FINDINGS.

**Oracle:** `kitFilesUsed({'/src/App.tsx': "import { signIn } from './lib/trust-signin'"})` contains `/src/lib/trust-signin.ts`. `cdnUrl('@openvtc/trust-tasks-proof')` contains `@0.1.3`.

## 7. Prompt guidance (`catalog.ts`)

### S-70 `TRUST_SIGNIN_GUIDANCE`

Appended only when env has `TRUST_TASKS_URL` (new key; `TRUST_SIGNIN_KEYS = ['TRUST_TASKS_URL']`). Tells the model: import `signIn` from `./lib/trust-signin`; offer "Sign in with this device" **alongside** email-code sign-in, never instead; treat the returned `member_token` exactly as `auth_verify`'s; the identity lives in this browser only — losing it means a new member row (say so in the UI with the email path as the recovery route); do not explain DIDs to end users. **Oracle:** guidance included iff key set; `COMMUNITY_CLOUD_GUIDANCE` byte-identical before/after.

*(Amended, C-19.)* `TRUST_SIGNIN_KEYS = ['TRUST_TASKS_URL', 'TRUST_TASKS_VID']`. The guidance is appended iff **both** are set (non-blank) and Community Cloud is connected. *(C-26)* Binding names in `src/integrations/catalog.ts`: `export const TRUST_SIGNIN_KEYS`, `export const TRUST_SIGNIN_GUIDANCE: string`, and `export function trustSigninConnected(vars: EnvVar[]): boolean` = `communityCloudConnected(vars) && TRUST_SIGNIN_KEYS.every(k => vars.some(v => v.key === k && v.value.trim()))`. `ChatPanel.tsx` pushes `TRUST_SIGNIN_GUIDANCE` into `serviceGuidance` immediately after `COMMUNITY_CLOUD_GUIDANCE` iff `trustSigninConnected(envVars)`; the predicate is the test target, the one-line ChatPanel use is checked by grep. The guidance shows the call `signIn(env.TRUST_TASKS_URL, env.APP_ID, env.APP_KEY, { recipient: env.TRUST_TASKS_VID })` and says the helper is available in React/Vite (framework) projects only (S-63).

### S-71 Builder wiring *(new, C-20)*

Next to the existing `setVar` calls in `src/cloud/community-cloud.ts` (connect path, near `setVar('APP_KEY', …)`), the Builder sets two public variables:
- `TRUST_TASKS_URL` = `${VITE_BUILDER_SUPABASE_URL}/functions/v1/app-trust-tasks`, the Trust-Task base. The helper appends `/trust-tasks`.
- `TRUST_TASKS_VID` = the **same rule as S-30's default** applied to `VITE_BUILDER_SUPABASE_URL`: `did:web:` + `hostname`, plus `%3A<port>` when a non-default port is present (C-25). (`URL.host` with a raw `:` is wrong.)

Both are set with the same third argument (`false`) as the neighbouring `setVar` calls. If the server overrides `TRUST_TASKS_LOCAL_VID`, the two disagree and every sign-in fails with `wrongRecipient`; record that operational coupling in FINDINGS.

## 8. `app-data` changes

### S-52 Byte-identical except `select` lists

`git diff <BASE_SHA> -- supabase/functions/app-data/index.ts` touches only: `select=id,email,name` → `select=id,email,name,did` in `resolveMember` and `authVerify`; returned `member` objects gain `did` (null for email members). No other hunk. *(C-30)* Also permitted: inside `interface Member`, `email: string;` → `email: string | null;` and one added line `did: string | null;` — required by §1.1 item 7 (tolerate `email = null`) under TS strictness. Nothing else.

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
- **NF-5** Every spike-grade shortcut carries `// SPIKE:`. *(C-34)* The mandatory minimum, grep-testable per file: `core.ts` — the exact S-30 line `// SPIKE: unsigned responses; local_vid is a label`, plus one each at the S-44 consume-before-compare, the S-47 unsigned `#response`, the S-25 subset validator, and the in-isolate rate limiter (≥ 5 total); `replay.ts` — the S-22 retention pad (≥ 1); `index.ts` — the S-51 `OPTIONS` deviation (≥ 1); `src/kit/files/lib/trust-signin.ts` — the software-custody fallback (≥ 1). More are allowed.

## 12. Test strategy (for the test agent)

Tests in `tests/app-trust-tasks/`. Import the Deno-free modules directly. Build `producer.ts` (the test-side client: `mintDidKey()`, `challengeDoc()`, `authenticateDoc()` signed with `signTrustTask`) — it must mirror `trust-signin.ts`'s wire output so the two are cross-checked by a fixture test. Build `fake-postgrest.ts` modelling only: `select=`, `eq.`, `lt.`, `is.null`, `order=`, `limit=`, `Prefer: return=representation`, 409 on unique violations (`app_tt_challenges.session_id`, `app_tt_replay.doc_id`, `(app_id, did)`), and PATCH-with-filter returning affected rows; throw on anything unmodeled. *(Amended, C-2: the authoritative list is `DESIGN.md` §3 / S-12 — it adds `lte.`, `POST`/`DELETE`, `Prefer: return=minimal`, the `cloud_apps` and `app_sessions` calls and 409 on `app_sessions.token`, and drops `order=`/`limit=`, which nothing issues. The fake also offers fault injection: a rejecting `fetch` and a 503 answer.)*

| File | Requirements |
|---|---|
| `migration.test.ts` | S-10, S-11 (real Postgres if `pg-mem`/embedded available; else statement-level parse + `todo`) |
| `challenges.test.ts` | S-20, S-21 (incl. concurrency, store failure → throws), S-23 |
| `replay.test.ts` | S-22 (duplicate, conflict, fail-closed when fetch throws, retention pad), S-24 |
| `core.auth.test.ts` | S-40, S-41, S-49, S-50, S-30, S-51 (routing via a thin wrapper or `deno test`; else `not testable here`) |
| `core.challenge.test.ts` | S-43 incl. non-did:key subject refusal |
| `core.authenticate.test.ts` | S-42, S-44 (each error code), S-45, S-46, S-47, S-48 |
| `producer-helper.fixture.test.ts` | S-60, S-61 wire shape equals `producer.ts` output for a fixed seed and fixed `now` |
| `catalog.test.ts` | S-70, S-71 |
| `schema.test.ts` | S-25 |
| `kit.test.ts` | S-63 |
| `fake-postgrest` contract | S-12 (the fake throws on any unmodeled call; every suite runs through it) |
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
      "npm:@openvtc/trust-tasks-proof@<PIN>": ["./node_modules/@openvtc/trust-tasks-proof/dist/index.d.ts"],
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

*(Amended, C-21.)* The proof mapping targets `dist/index.d.ts`. The package declares its types only under `exports`, with no top-level `"types"`, and a `paths` entry that points at a directory ignores `exports`, so the original mapping failed with `TS2307`. The pins are 0.26.29, 0.1.3 and 2.4.0, and the committed `tsconfig.functions.json` is the source of truth. `<PIN>` values are filled by the design agent from what Phase 0 installed and must equal the specifiers used in `index.ts` and recorded in `BASE_SHA`; a mismatch fails as "cannot find module", which is the desired behaviour. Relative imports inside the function use explicit `.ts` extensions (Deno requires them; `allowImportingTsExtensions` lets `tsc` accept them). Where Deno is available, the implementer also runs `deno check supabase/functions/app-trust-tasks/index.ts`; where it is not, `tsc` plus the Phase 0 smoke test is the gate. NF-1 is amended accordingly.

## Changelog

Amendments made by the design agent in Phase 1 (2026-10-26), against the pins in `BASE_SHA`. The evidence for each is in `DESIGN.md` §1, by question number. No requirement id was removed, renumbered or reused. New ids: S-12, S-24, S-25, S-51, S-63, S-71. No requirement was weakened; the "unachievable" notes say which fact forced a change of mechanism.

- **C-1 · §1.2.** The claim that `auth/authenticate/0.3` does not require a proof on its `#response` was **false**. A single `proofRequirement: REQUIRED` covers every variant (SPEC §7.3 item 8), and `RESPONSE_SPEC.isProofRequired === true` (`gen/authenticate/0.3/payload.ts:523`). Unsigned responses stay, re-labelled as a recorded deviation. *(DESIGN Q4)*
- **C-2 · S-12 (new), §12.** The fake-PostgREST operator list is replaced by the closed list in `DESIGN.md` §3. `lte.`, `POST`/`DELETE`, `Prefer: return=minimal`, and the `cloud_apps` and `app_sessions` calls are added. `order=`/`limit=` are dropped because nothing issues them.
- **C-3 · S-22, S-24 (new).**
  - Retention comes from the runtime's `retainUntil` (`recordExpiry`), not `now + window`, and is padded by `DEFAULT_SKEW_MS`. The runtime's record expires `skewMs` before its acceptance window closes (`rt/freshness.ts:143` vs `:182`); probed, one id executed twice.
  - The exact claim algorithm is specified.
  - The guard is app-scoped, so it never returns another app's retained token. *(Q3)*
- **C-4 · S-25 (new), S-42.** "Vendor the schema files" is unnecessary, because the schemas ship as values on `SPEC.payloadSchema`. Validation still needs an engine, which the package deliberately omits (`rt/consume.ts:197-205`) and NF-3 forbids adding. Hence a tested subset validator. *(Q5)*
- **C-5 · S-30.** The default `localVid` rule is made precise. Every emitted document's `issuer` is re-stamped to `localVid`, because runtime errors copy `request.recipient` (`rt/document.ts:369`), which is the wrong VID under `wrongRecipient` (probed). The recipient-absent case is documented. *(Q6)*
- **C-6 · S-40.** Order is 401 → 429 → lookup → 403, matching `app-data` (`index.ts:135` before `:139`). A store failure on the app lookup → 503 plain JSON.
- **C-7 · S-41.**
  - An unparseable body → 400.
  - Another version of a registered slug → `unsupportedVersion` (SPEC §8.3), stricter than `unsupportedType`.
  - An envelope-shape check is added, because the runtime does none.
  - `errorDocument` covers error documents built without a parsed request.
- **C-8 · S-42.** Resolved:
  - `UnauthenticatedTransport` keeps the in-band issuer authoritative.
  - "Optional proof" is `{kind:"verify"}` plus `isProofRequired: false`.
  - The window is set through a `ConsumeChecks` literal, because `consequentialChecks` cannot take one (`rt/consume.ts:124-126`).
  - A missing `issuedAt` is `malformedRequest`/400.
  - The clock seam is spelled out.
  - `PurposeCheckingVerifier` is added, because `DataIntegrityProofVerifier` does not check `proofPurpose` (`proof/verifier.js:50-54`; SPEC §4.7.3 item 1). *(Q1, Q2)*
- **C-9 · S-21.** A store failure makes the store throw, and the handler answers `unavailable` instead of throwing. A handler that throws leaves the replay claim in flight (`rt/consume.ts:520`; probed).
- **C-10 · S-43.** Responses are built with `respondWith`, so `threadId = threadId ?? id`. A store failure → `unavailable`.
- **C-11 · S-44.** The check order is explicit. The acting party is `principal ?? issuer`, checked before S-46/S-45, as in the task spec's items 5–7 and 11. The release-on-retryable consequence (`rt/consume.ts:533`) is documented.
- **C-12 · S-50.** Resolved against binding 0.2 §4:
  - An in-flight duplicate → **202**, not 204.
  - `suppressed` → 400 generic `malformedRequest`, as `trust-tasks-https` does (`server.rs:1076-1103`); it was 204.
  - `cancelled` → 422.
  - Unknown standard codes → 500.
  - A retained error is answered with its code's status.
  - 202/204 carry no `Content-Type`.
  - No runtime helper exists. *(Q7)*
- **C-13 · S-51 (new).** `index.ts` routing. The `OPTIONS` preflight is a deliberate deviation from binding 0.2 §2 item 1.
- **C-14 · S-48.** "Older than the window" includes the 60 s skew. Retained errors are replayed too. A window-edge oracle is added.
- **C-15 · S-47.** The response is built with `respondWith` + `stampIssuer` and must validate against `RESPONSE_SPEC.payloadSchema`. It is unsigned.
- **C-16 · S-60.** `isEd25519Available()` and `DeviceIdentity.sign` are async. WebCrypto Ed25519 detection and signing are inherently async.
- **C-17 · S-61.**
  - **Unachievable as written:** "`recipient` omitted". Both task specs declare `recipient` REQUIRED (`gen/challenge/0.1/payload.ts:204`, `gen/authenticate/0.3/payload.ts:510`), and the runtime rejects the absence (`rt/document.ts:309-316`, probed). It is replaced by a required `options.recipient`.
  - **Unachievable as written:** "sign with `signTrustTask`" under S-60's non-extractable key. `Signer.sign` is synchronous (`proof/sign.d.ts:10`). It is replaced by `signDocument`, which is byte-equivalent and checked by a fixture against `signTrustTask`.
  - `proofPurpose: "authentication"` is explicit, because the default is `assertionMethod` (`proof/sign.js:49`).
  - 202/204 handling is added.
- **C-18 · S-63 (new).** Kit registration and esm.sh version pins. The helper is not available to Sandpack-routed projects (`KIT_FILES` is merged only at `FrameworkPreview.tsx:78` and `build-for-publish.ts:76`).
- **C-19 · S-70.** `TRUST_SIGNIN_KEYS` gains `TRUST_TASKS_VID`. The guidance names the framework-only limitation.
- **C-20 · S-71 (new).** The Builder sets `TRUST_TASKS_URL` (the Trust-Task base) and `TRUST_TASKS_VID`.
- **C-21 · Appendix A, NF-1.** The proof package `paths` entry → `dist/index.d.ts` (`TS2307` otherwise; *Q8*). Pins are filled. `tsc` and `deno check` pass on the stubs. The 0.19-typed `DataIntegrityProofVerifier` is assignable to the 0.26.29 `ProofVerifier` (compiled check with `skipLibCheck: false`), so no workaround is needed.
- **C-22 · §5.** The `CoreDeps`/`CoreRequest` sketch is superseded by `DESIGN.md` §2: required `rateLimiter`, optional `randomUUID`/`randomBytes`/`log`, `PostgrestDeps` base.
- **C-23 · §2 diagram, §1.1 item 2, §2.1 layout.** These are updated to match C-4, C-7, C-17, S-63 and S-71. HTTPS binding 0.3 (draft) adds only SSE streaming; the spec stays on 0.2. *(Q9)*
- **C-24 · Note, no change.** `S-31`/`S-32` appear only in §10 as references to *v1's* resolver requirements (`SPIKE-SPEC-v1-oob-deferred.md`). They are not requirements of this spec. A coverage matrix lists them as `not testable here (v1 reference, Increment 2)`.
- **C-25 · G2 item 1 (port in the default VID), S-30, S-71.** Decided: `did:web:<hostname>` plus `%3A<port>` when an explicit non-default port is present. The did:web method encodes a port as `%3A`, and S-30 and S-71 must compute the same value or every local sign-in fails with `wrongRecipient` (S-71's `URL.host` would insert a raw `:`). **Tests must change:** `localVidFromSupabaseUrl('http://localhost:54321')` is `'did:web:localhost%3A54321'`. The production examples are unchanged.
- **C-26 · G2 item 2 (where guidance is appended), S-70.** Decided: the binding names are `trustSigninConnected(vars)`, `TRUST_SIGNIN_GUIDANCE` and `TRUST_SIGNIN_KEYS` in `catalog.ts`, and ChatPanel uses the predicate right after `COMMUNITY_CLOUD_GUIDANCE` (`ChatPanel.tsx:709-710` is where that guidance is assembled today, inline, untestable). Stubs added to `catalog.ts`. The tests should test `trustSigninConnected` directly, including the "cloud not connected → false" case.
- **C-27 · G2 item 3 (`issuedAt` format), S-61.** Confirmed as tested: `issuedAt = now.toISOString()` with milliseconds kept. Only `created` drops `.000`, to match `signTrustTask`. **Tests OK as-is.**
- **C-28 · G2 item 4 (`created` in `signIn`), S-61.** Confirmed as tested: `created = options.now()`, the same reading as that document's `issuedAt`. **Tests OK as-is.**
- **C-29 · G2 item 5 (rejected `fetch`), S-61.** Decided: a rejected `fetch` → `TrustSignInError('transport', true, 0)`. A non-JSON non-2xx → `code: 'transport'`, `retryable: status >= 500`, `status`. **Tests OK; they should add** the rejected-`fetch` case.
- **C-30 · G2 item 6 (`Member` type in app-data), S-52.** Confirmed as tested: §1.1 item 7 (tolerate `email = null`) cannot type-check without `email: string | null` and `did: string | null` in `interface Member` (`app-data/index.ts:336-340`). Those two type lines are permitted hunks. **Tests OK as-is.**
- **C-31 · G2 item 7 (`subject` check), S-43.** Decided, stricter than the prefix: full multibase pattern, no fragment, and `publicKeyFromDidKey` must decode it as Ed25519. A prefix-only check would bind a challenge to an undecodable subject, which can never authenticate and which the task spec's `subjectNotRecognized` exists to refuse up front. **Tests OK; they should add** `did:key:z6Mk0OIl` (non-base58) and `did:key:z6Mk…#frag` → `subjectNotRecognized`.
- **C-32 · G2 item 8 (`malformedRequest` retryability), S-41.** Confirmed as tested: `retryable: false` (SPEC §8.3 default; the runtime uses the same, `rt/document.ts`, `rt/freshness.ts`). **Tests OK as-is.**
- **C-33 · G2 item 9 (extended code status), S-50.** Confirmed as tested: every extended code → 422. Binding 0.2 §4 has no 429 row, and no task spec assigns HTTP statuses. Rate limiting is S-40's transport-level 429. **Tests OK as-is.**
- **C-34 · G2 item 10 (`// SPIKE:` count), NF-5.** Decided: the per-file minimum list in NF-5 is core.ts ≥ 5 (including the exact S-30 line), replay.ts ≥ 1, index.ts ≥ 1, trust-signin.ts ≥ 1. **Tests must change:** the core.ts minimum rises to 5, and assertions are added for replay.ts and trust-signin.ts.
- **C-35 · G2 item 11 (`select=` columns), S-12 / DESIGN §3.** Confirmed as tested: the `select=` set must **equal** the listed set (order-insensitive). Subsets and supersets are contract violations. DESIGN §3 is reworded. **Tests OK as-is.**
- **C-36 · G2 item 12 (filter-value encoding), S-12 / DESIGN §3.** Confirmed: every filter value, `select` excepted, is passed through `encodeURIComponent` exactly once, and the fake decodes as PostgREST does (`+` → space, then percent-decoding). A raw `+ & # =` in a value is therefore an implementation bug the fake rightly exposes. **Tests OK; they should add** a `sessionId` containing `+&=#` that round-trips to `notFound` (not a contract violation).
