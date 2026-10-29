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

So the first increment is: **a `POST /trust-tasks` endpoint on Community Cloud that consumes exactly two task types and hands back the same `member_token` the email path mints.** The generated app is the *client* in the VTI sense (Client Onboarding chapter): it mints its own `did:key` bootstrap identity in the browser, one per app (VTI-CLT-001…005; VTI-CLT-006 only against other origins, S-60), and that identity becomes the member. *(Amended, C-37, C-38.)* Everything a wallet later adds (a `did:webvh` persona, proxied login via a VTA, QR hand-off) plugs into the same endpoint as later increments.

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
3. Proof verification for Ed25519 `did:key` issuers only, via `@openvtc/trust-tasks-proof` `DataIntegrityProofVerifier` restricted to `eddsa-jcs-2022`, with `verificationMethod` required to be the `did:key`'s own key (S-42). *(Amended, C-42.)*
4. A Postgres-backed challenge store and a Postgres-backed `ReplayGuard` (the TS package ships only in-memory ones; Supabase isolates do not share memory).
5. Minting of a Community Cloud `member_token` (same shape as `authVerify` produces) as the `TokenBundle.accessToken`; `app_members` row keyed by `did`.
6. Migration: `app_members.email` nullable, `app_members.did` added, new tables `app_tt_challenges`, `app_tt_replay`.
7. `app-data` changes limited to `resolveMember` returning `did` and tolerating `email = null`.
8. A browser-side helper module **shipped as a project file into generated apps** (`src/kit/files/lib/trust-signin.ts`, materialized by `withKitFiles()`): mint/persist a `did:key` per app (C-37), sign a document, run challenge→authenticate, return `member_token`.
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

**Recorded deviations (accepted for Increment 1).** *(Amended, C-38, C-44, C-46, C-47, C-48; corrected by C-53, C-54.)* Each carries a `// SPIKE:` marker (NF-5) and a FINDINGS §9 item 4 entry. The unsigned `#response` is the first bullet above. The others are:
- **Shared hosting origin (C-38).** Every Community-Hosted app is served from one origin (`relationalbuilder.org/s/<slug>/`), and Builder framework previews run same-origin. Any script there can open the `rb-trust-signin` database and *use* any app's non-extractable device key to sign in as that person, for every app the device has joined. With `custody: 'software'` the seed itself is readable. VTI-CLT-006 is therefore **not met** on the shared origin (S-60). Per-app keys (C-37) stop cross-app correlation, not this impersonation. **Trial-only rule:** `trust_signin_enabled` stays default `false` and may be turned on for a shared-origin app only for the spike trial (owner-controlled test apps, test identities, never an app with real community members). **Production prerequisite:** per-app origins (for example `<slug>.relationalbuilder.org`) and previews isolated from the Builder and from each other.
- **Consume-before-compare (S-44).** The single atomic PATCH burns the challenge even on a mismatched guess.
- **Expiry before mismatch (C-44, C-53).** The atomic PATCH reports `expired` without returning the stored challenge, so `challengeExpired` wins over `challengeMismatch`, where the task spec compares first. The code differs, and so do retryability and the replay record's fate: `challengeExpired` is `retryable: true`, so the runtime **releases** the record (an identical resend re-executes and gets `challengeNotFound`), while a plain `challengeMismatch` is `retryable: false` and its refusal is **retained**. Harmless: the challenge is burned either way, and any retry needs a new challenge.
- **Rate limiting (C-46, C-54).** 120/min per app and per isolate, not per source IP or DID as challenge 0.1 consumer item 6 asks. A transport-level 429 plain JSON, never `auth/challenge:rateLimited` (a MUST in item 6). **Per-app budget DoS:** the limiter runs before the key check (S-40), so anyone who knows an app's `app_id` (public in every generated app's `env.js`) can use up that app's budget, even with a wrong `app_key`, denying sign-in by either path to every user of that app in that isolate. The email path shares this.
- **Self-enrolment (C-47).** Any freshly minted `did:key` becomes a full member of an app with `trust_signin_enabled`, with no administrator, invitation or ACL step (VTI-CLT-010/012/013). The bootstrap DID is not treated as low-trust, and the member row never expires (VTI-CLT-014). This is a Sybil and storage-growth surface, gated only by the per-isolate rate limit. The email path is gated by inbox possession; this path is not.
- **Audience per service, not per app (C-48).** Every Community Cloud app shares `recipient = localVid`, so SPEC §4.8.2 audience binding ties a signed document to Community Cloud, not to the app. App binding in Increment 1 rests entirely on `app_tt_challenges.app_id` (S-21) and the app-scoped replay record (S-24). The runtime answers `wrongRecipient` where binding 0.2 §3 says `identityMismatch` (S-30).
- **Also recorded elsewhere in this spec:** envelope checks not done (S-41, C-43); a refused leap second (S-25, C-55); the retained-error status and `suppressed` → 400 (S-50, C-45); the `OPTIONS` preflight (S-51); a failed release or double-failed record leaving a record in flight (S-22, C-40, C-59); the replay-record boundary millisecond (S-22, C-56).

## 2. Architecture

```
Generated app (any origin)
  trust-signin.ts
    1. mint or load this app's did:key (WebCrypto Ed25519 non-extractable, else @noble fallback)   [VTI-CLT-001..005; -006 only cross-origin, C-38]
    2. POST /trust-tasks  auth/challenge/0.1  {recipient: TRUST_TASKS_VID, payload:{subject: did, purpose:"login"}}  (unsigned OK)
    3. POST /trust-tasks  auth/authenticate/0.3 {recipient: TRUST_TASKS_VID, payload:{challenge, sessionId}} + proof (eddsa-jcs-2022, did:key, proofPurpose authentication)
    4. read #response payload.tokens.accessToken  →  member_token  (identical to email path)
  ▼
app-trust-tasks edge function (Deno)              ← Trust-Task base = <fn url>; path = /trust-tasks
  ├─ app_id/app_key from query string (?app_id=&app_key=)     [S-40]   (body is the bare document per binding §2)
  ├─ parse → dispatch on `type`                                [S-41]
  ├─ consumeInbound (@openvtc/trust-tasks)                     [S-42]
  │     transport    = UnauthenticatedTransport (no bearer in Increment 1; in-band issuer is authoritative)
  │     proofPolicy  = verify via DataIntegrityProofVerifier (did:key, eddsa-jcs-2022 only, own key; C-42)
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

Implements the `ReplayGuard` interface exported by `@openvtc/trust-tasks` (read its exact shape from `trust-tasks-ts/src/_runtime/replay.ts` — the design agent copies the signature into DESIGN.md). Semantics per binding §5.1: keyed on `id`; same `id` + same digest → duplicate (return retained response when present); same `id` + different digest → `idConflict`; record is written at the commit point (after all checks, before the handler runs); store unreachable → the guard reports unavailable and the consumer answers `unavailable`/503 and does **not** execute (fail closed, §5.1 item 5). *(Amended, C-3.)* "Reports unavailable" means `claim` **throws**; `consumeInbound` maps the throw to `unavailable`, `retryable: true`.

**Retention** *(amended, C-39)*: `until_at = min(retainUntil + retentionPadMs, now + acceptanceWindowMs + 2 × DEFAULT_SKEW_MS)`, where `now` is `claim`'s `now` argument.
- `retainUntil` is the value the runtime passes (`recordExpiry`: `expiresAt` if present, else `issuedAt + maxAgeMs`).
- `retentionPadMs` defaults to `DEFAULT_SKEW_MS` (60 000). The pad closes a runtime gap: freshness accepts documents up to `issuedAt + maxAgeMs + skewMs`, but `recordExpiry` stops at `issuedAt + maxAgeMs`.
- The cap stops a producer's far-future `expiresAt` from choosing retention. Freshness refuses `issuedAt > now + skew` and refuses once `issuedAt + window + skew < now`, so no claimed document is executable after `now + window + 2·skew`. Without `expiresAt`, `retainUntil + pad = issuedAt + window + skew` is already within the cap.
- `ReplayGuardDeps.acceptanceWindowMs` (default `DEFAULT_ACCEPTANCE_WINDOW_MS`, 300 000) is the window. `core.ts` passes the same value it gives `authenticateChecks`.
- A `retainUntil` of `undefined` makes `claim` throw.
- **Dependence on `requireIssuedAt` (known behaviour, C-56).** The cap is sound only because `authenticateChecks` spreads `CONSEQUENTIAL_FRESHNESS`, whose `requireIssuedAt` is `true`, so every accepted authenticate document carries `issuedAt`. The runtime puts no window bound on a document that has `expiresAt` but no `issuedAt` (OVTC-51), so under a policy without `requireIssuedAt` the capped record would age out while the document is still accepted: a replay hole. `authenticateChecks` must keep `requireIssuedAt: true`; relaxing it requires removing the cap first.
- **Boundary millisecond (known behaviour, C-56, L-30).** With the pad equal to the skew, `until_at` equals the last instant freshness still accepts (`issuedAt + window + skew`, freshness being stale only when `<`), while step 3 below and P7 treat `until_at ≤ now` as expired. At exactly that millisecond an identical resend finds its record expired, deletes it, re-claims, and **the handler runs again**. The cap has the same edge at `now + window + 2·skew`. The **single-use challenge is the mitigation**: the re-run handler's `lookupAndConsume` returns `notFound`, so the resend is refused 422 `auth/authenticate:challengeNotFound` and no second session is minted. One millisecond later, freshness refuses with 422 `expired` before any claim. Accepted for the spike, recorded in FINDINGS §9 item 4 and upstream as OVTC-50.

Exact `claim(id, digest, retainUntil, now)` algorithm (DESIGN §3 numbering):
1. P5 insert `{doc_id:id, app_id, digest, response:null, until_at}`. On 201 → `fresh`, then fire-and-forget P8 (`until_at=lt.<now>`; its failure is ignored).
2. On 409 → P6 read. If `[]` (raced delete), retry step 1 once.
3. If the row's `until_at ≤ now` → P7 delete (`until_at=lte.<now>`), then retry step 1 once.
4. If the row's `app_id ≠` this guard's app, or its `digest ≠ digest` → `conflict` (S-24).
5. Otherwise → `duplicate`. When `response` is null, `inFlight: true` with no `priorResponse`. Otherwise `priorResponse: response, inFlight: false`.
6. Any other status, a second failed retry, or a rejected `fetch` → throw.

*(Amended, C-40, C-59.)*
- **`recordResponse`** issues P9. On a rejected `fetch` or a non-2xx answer it issues P9 once more. If the second attempt also fails, it logs `deps.log?.('replay.record_failed', {failure})`, where `failure` is `"HTTP <status>"` or `"fetch rejected"` (no id, no digest; a throwing log sink is swallowed), and then throws. The runtime swallows that throw (`rt/consume.ts:559-563`), so the record stays in flight and every identical resend is answered 202 for the record's life (OVTC-43, recorded). The log line is what makes that state visible.
- **`release`** is total: it never throws. It issues P10 once. A rejected `fetch` or a non-2xx answer is logged through `deps.log?.('replay.release_failed', {status})` (`status` is the HTTP status, or `null` for a rejected `fetch`; no id, no digest; a throwing log sink is swallowed), and `release` resolves normally. When the handler refuses with `unavailable` because P3 failed and P10 then also fails, the answer is still **503 `unavailable`, `retryable: true`**, never 500. The record stays in flight (202 to identical resends until `until_at`; OVTC-42, recorded).
- `ReplayGuardDeps.log?: (event: string, detail?: Record<string, unknown>) => void`; `core.ts` passes `deps.log`.

### S-23 Sweep

`PostgresChallengeStore.sweep()` deletes `app_tt_challenges` where `expires_at < now - 1h`. Called fire-and-forget from the challenge handler.

### S-24 The replay record is app-scoped *(new, C-3)*

`app_tt_replay.doc_id` is globally unique, but a `PostgresReplayGuard` is constructed per request with the authenticated `appId`. A row written by app A, offered under app B with the same `id`, is `conflict` (409 `idConflict`) whatever its digest. App B's caller **never** receives app A's retained response, which contains an access token. `recordResponse` and `release` filter on `app_id` as well.

**Oracle:** app A completes a sign-in. The identical document is sent with app B's credentials (with `trust_signin_enabled` true for both) → 409, and the body contains no `accessToken`.

### S-25 Payload validation without a schema engine *(new, C-4)*

The npm package ships each task's payload schema as a value (`AuthChallenge_v0_1.SPEC.payloadSchema`, `AuthAuthenticate_v0_3.SPEC.payloadSchema`, refs inlined) but no validator, and NF-3 forbids adding one. `core.ts` exports `subsetSchemaValidator: PayloadValidator`, which implements exactly `SUPPORTED_SCHEMA_KEYWORDS`:
- Annotations, ignored: `$schema`, `$id`, `$anchor`, `title`, `description`.
- `$defs`, and `$ref` restricted to the form `#/$defs/<name>`.
- `type`, `properties`, `additionalProperties` (boolean, or a schema), `required`, `items`, `minLength`, `maxLength`, `pattern`, `format` (`date-time` only, by the rule below), `minimum`, `minItems`, `minProperties`, `propertyNames`.

String length counts Unicode code points. Any other keyword, or another `$ref` form, **throws**; `consumeInbound` turns the throw into `malformedRequest`. `assertSchemaSupported(schema)` throws on the same conditions without a payload. The message of an unsupported-keyword throw contains `unsupported schema keyword "<k>"`, with `<k>` the exact keyword *(C-58)*.

**Sub-schemas** *(amended, C-41)*:
- `items`, `propertyNames` and a schema-valued `additionalProperties` are each **one** sub-schema. `properties` and `$defs` are **maps** from names to sub-schemas. `assertSchemaSupported` applies every rule in S-25 recursively at each of these positions, at any depth.
- **The validator asserts first.** `subsetSchemaValidator.validate(schema, value)` runs `assertSchemaSupported(schema)` over the **whole** schema before looking at `value`, so an unsupported keyword or value anywhere throws, whatever the value is, and never yields `true`.
- **Own properties only.** `required` and `properties` consider only the value's own properties (`Object.hasOwn`).

**Keyword value types** *(amended, C-58)*. `assertSchemaSupported` also throws (with a constant message naming the keyword) unless:
- a single sub-schema position (`items`, `propertyNames`, `additionalProperties`) holds a plain object or a boolean. Array-form `items` throws;
- a map position (`properties`, `$defs`) holds a plain object whose every value is a plain object or a boolean;
- `type` is one string among `string`, `number`, `integer`, `boolean`, `null`, `object`, `array` (a `type` array throws);
- `required` is an array of strings;
- `minLength`, `maxLength`, `minItems`, `minProperties` are non-negative integers, and `minimum` is a finite number;
- `pattern`, `format` and `$ref` are strings.

Annotations are not type-checked. The four pinned schemas satisfy all of this. The point is that a pin bump which changes a schema's shape throws a controlled S-25 error, and never a `TypeError` whose text reaches the wire, or a silent `true`.

**`date-time`** *(amended, C-43, C-55)*. One rule, used both for `format: "date-time"` and for the envelope timestamps (S-41). A value matches when all of the following hold:
- Its shape is `YYYY-MM-DD` `T` `hh:mm:ss`, then optional `.` with one or more digits, then the offset. The offset is `Z` or `±hh:mm` and is **required**. `T` and `Z` may be lower case. Any other separator, including a space, fails.
- `MM` is 01–12, and `DD` is 01 to the number of days in that month. February has 29 days when the year is divisible by 4 and either not by 100 or by 400 (so `2032-02-29` and `2000-02-29` pass; `2031-02-29`, `2100-02-29`, `2031-02-31` and `2031-04-31` fail).
- `hh` is 00–23 (`24:00:00` fails), `mm` is 00–59, and `ss` is 00–59.
- The offset hours are 00–23 and the offset minutes are 00–59 (`+23:59` and `-00:00` pass; `+24:00`, `+23:60` and `+99:99` fail).
- **Leap second, refused.** `ss = 60` fails, although RFC 3339 §5.6 allows it. The runtime's `Date.parse` rejects `:60` anyway, with a false "not a valid RFC 3339 timestamp" message (OVTC-52). Refusing it here gives one consistent, accurate answer. This is a recorded deviation, marked `// SPIKE:` with the phrase `leap second` (NF-5).

**Oracle:** `assertSchemaSupported` passes for the request and response schemas of both pinned tasks. The validator accepts each spec's valid examples and rejects every entry of each task's `payload.invalid-examples.json` under `.spike-deps/dtgwg-trust-tasks-tf/specs/auth/{challenge/0.1,authenticate/0.3}/`. A schema containing `oneOf` makes it throw.

**C-41 oracles.** `{type:"array", items:{enum:["a"]}}`, `{items:{oneOf:[{}]}}`, `{propertyNames:{const:"x"}}`, `{additionalProperties:{not:{}}}` and `{properties:{a:{items:{anyOf:[]}}}}` each make `assertSchemaSupported` throw with `unsupported schema keyword "<k>"` for the named keyword. `validate({type:"array", items:{type:"string", enum:["a"]}}, ["zzz"])` throws. `validate({type:"object", required:["toString"]}, {})` is `false`.

**C-58 oracles.** Each of these makes `assertSchemaSupported` throw, and makes `validate(schema, v)` throw for every `v` (never a `TypeError`, never `true`): `{items:[{enum:["a"]}]}` (with `v = []`), `{items:[{}]}`, `{properties:[]}`, `{$defs:[]}`, `{properties:{a:7}}`, `{required:"a"}`, `{type:["string","null"]}`, `{type:"date"}`, `{minLength:-1}`, `{minItems:1.5}`, `{pattern:7}`.

**C-55 oracles.** `validate({type:"string", format:"date-time"}, v)` is `false` for `2031-02-31T00:00:00Z`, `2031-04-31T00:00:00Z`, `2031-02-29T00:00:00Z`, `2100-02-29T00:00:00Z`, `2031-00-10T00:00:00Z`, `2031-03-00T00:00:00Z`, `2031-03-04T24:00:00Z`, `2031-03-04T25:00:00Z`, `2031-03-04T05:60:00Z`, `2031-03-04T23:59:60Z`, `2031-03-04T05:06:07+24:00`, `2031-03-04T05:06:07+23:60`, `2031-03-04T05:06:07+99:99`, and `true` for `2032-02-29T00:00:00Z`, `2000-02-29T00:00:00Z`, `2031-03-04t05:06:07z`, `2031-03-04T05:06:07.123456789Z`, `2031-03-04T05:06:07-00:00`, `2031-03-04T05:06:07+23:59`.

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

*(Amended, C-48.)* Every app shares this one `localVid`, so audience binding is per service, not per app; app binding rests on `app_tt_challenges.app_id` (S-21) and the app-scoped replay record (S-24). This is a recorded deviation (§1.2). A `// SPIKE:` marker whose line contains `audience` and names `wrongRecipient` goes at the `myVid: deps.localVid` site; one marker covering both `consumeInbound` calls is enough.

**Oracle:** a document whose `recipient` is `did:web:other.example` → 422 `wrongRecipient` with error `issuer === localVid`. A document with no `recipient` → 400 `malformedRequest`.

### S-40 App authentication precedes parsing

`appId`/`appKey` come from the function URL query string (`?app_id=&app_key=`) because the HTTPS binding (§2) requires the body to be the bare document. Missing → `401 {error:"app_id and app_key required"}` (plain JSON, **not** a trust-task-error: binding §4 says missing auth is transport-level). Unknown app or wrong key → `403 {error:"Unknown app or wrong key"}`. `trust_signin_enabled = false` → `403 {error:"Trust Task sign-in is not enabled for this app"}`. Rate limit 120/min per app → `429` plain JSON. Only then is `rawBody` examined.

*(Amended, C-6.)* The order matches `app-data`, which rate-limits *before* the database lookup:
1. Missing credentials → 401.
2. `deps.rateLimiter.hit(appId, now)` → 429 `{error:"Rate limit exceeded — try again in a minute"}`.
3. App lookup (P1, `select=id,app_key,trust_signin_enabled`): a rejected `fetch` or a 5xx → `503 {error:"Service unavailable"}`; any other non-2xx, an empty result or a key mismatch → 403.
4. Not enabled → 403.

Every one of these bodies is plain JSON, never a trust-task-error. Where `trust_signin_enabled` is false, the 403 precedes any challenge or replay store access (zero P2–P13 calls).

*(Amended, C-46, C-54.)* Because step 2 precedes step 3, every request carrying an `app_id` spends that app's budget, whether or not its `app_key` is right and whether or not the app exists. This order is kept (it matches `app-data`), and its consequences are a recorded deviation (§1.2): the limit is per app and per isolate, not per source, it is never `auth/challenge:rateLimited`, and anyone who knows an `app_id` can exhaust that app's budget.

**Limiter memory is bounded** *(amended, C-57)*. `InMemoryRateLimiter` keeps one fixed-window bucket per `app_id` (window 60 000 ms). The key is unauthenticated, so:
- The map never holds more than `MAX_BUCKETS` (10 000) entries. When `hit` is called for an `app_id` that has no bucket and the map is full, it deletes the **oldest** bucket (the first in `Map` insertion order) before inserting the new one.
- When a bucket's window has closed, `hit` deletes it and re-inserts a fresh bucket, so insertion order is window-start order and the oldest bucket is the first one.
- `hit` does no full scan of the map. Its cost is O(1) amortized, whatever the map's size.
- Consequence, accepted: under a flood of more than 10 000 distinct ids within one window, an evicted app's count restarts at zero, so that app can exceed 120/min in that isolate. This adds nothing to the recorded per-isolate deviation, which is already weaker.

**C-57 oracle.** With a fixed `now`, 20 000 `hit`s with distinct ids leave the map at ≤ `MAX_BUCKETS` entries. The most recent id's bucket is present, and its next `hit` counts as its second. An id hit 121 times within one window (with fewer than `MAX_BUCKETS` other ids in between) → the 121st returns `true`. **C-54 oracle.** 120 requests with the right `app_id` and a wrong `app_key` (each 403), then one with the right key, in the same window → 429.

### S-41 Parse and dispatch

`rawBody` must be a JSON object with string `type`; otherwise `400` with a `trust-task-error` whose code is `malformedRequest` (*C-32: every `malformedRequest` this consumer emits has `retryable: false`, SPEC §8.3 default*) (use `rejectWith` from the runtime). `type` not in the registered set → `422` with `unsupportedType`. The two registered URIs are exact-match strings; `…/auth/authenticate/0.2` is **not** registered in Increment 1 (the plugin's current version) — record this in FINDINGS as the compatibility question it is, and make the registered set a single constant `REGISTERED_TYPES` so Increment 2 can add 0.2.

*(Amended, C-7.)*
- **Unparseable body.** `index.ts` passes `rawBody: undefined` for a body that is not valid JSON. That gives 400 `malformedRequest`, the same as a non-object.
- **Unsupported version.** A `type` with the slug of a registered task but a different version (for example `…/auth/authenticate/0.2`, or `…/auth/challenge/0.2`) → 422 **`unsupportedVersion`** (SPEC §8.3: "recognized but its MAJOR.MINOR version is not supported"). Any other `type` → 422 `unsupportedType`. Fragments (`#response`) are not registered: a `#response` posted here → `unsupportedType`.
- **Envelope shape.** For a registered type, `checkFrameworkShape` must pass before `consumeInbound`, else 400 `malformedRequest`. It requires `id` to be a non-empty string and `payload` a JSON object. `issuer`, `recipient`, `issuedAt`, `expiresAt` and `threadId` must be strings when present, and `proof` an object when present. The runtime performs none of these checks (it states that §7.2 item 1 belongs to the caller). *(Amended, C-43, C-55.)* `issuedAt` and `expiresAt`, when present, must also satisfy S-25's `date-time` rule, and `parentThreadId` must be a string when present. Otherwise → 400 `malformedRequest`, `retryable: false`, with a constant message naming the member (for example `"issuedAt is not an RFC 3339 date-time"`). On authenticate this refusal precedes any P3 or P5 call. **Accepted, not checked (recorded deviation):** `type` syntax beyond the exact-match dispatch above, and `ceremony` / `extCritical` placement. Neither task uses them, and dispatch never lets an unregistered `type` reach a handler. A `// SPIKE:` marker whose line contains `envelope` goes in `checkFrameworkShape`.
- **C-43 / C-55 oracles.** `issuedAt: "Tue, 04 Mar 2031 05:06:07 GMT"` → 400 `malformedRequest`. `issuedAt: "2031-03-04T05:06:07.000"` (no offset) → 400, whatever `TZ` is. `expiresAt: "2031-13-01T00:00:00Z"` → 400. `issuedAt: "2031-03-04T05:06:07+02:00"` passes. `parentThreadId: 7` → 400. On authenticate, with the clock set to the instant each would denote: `issuedAt` of `2031-02-31T05:06:07Z`, `2031-04-31T05:06:07Z` or `2031-03-04T24:00:00Z` → 400 `malformedRequest` naming `issuedAt`, zero P3 and P5, no session (each was 200); `2031-03-04T23:59:60Z` → 400 `malformedRequest` from this check (message names `issuedAt`, not the runtime's "not a valid RFC 3339 timestamp"), zero P3 and P5.
- **Error documents without a parsed request** (`errorDocument`): `type = TRUST_TASK_ERROR_TYPE_URI`, `issuer = localVid`, `recipient` = the body's `issuer` when it is a string, `threadId` = the body's `threadId ?? id` when a string, else the error's own `id`. `inResponseTo` is set only when the body's `type` and `id` are strings.

**Oracle:** `…/auth/authenticate/0.2` → 422 `unsupportedVersion`; `…/acl/grant/0.1` → 422 `unsupportedType`; `{type: CHALLENGE_TYPE, payload: {}}` without `id` → 400 `malformedRequest`; body `"not json"` → 400.

### S-42 `consumeInbound` is the pipeline

Both handlers run through `consumeInbound` from `@openvtc/trust-tasks` with: `transport = new UnauthenticatedTransport()` (no bearer in Increment 1; the in-band `issuer` is then authoritative per §4.8.1 — confirm in design phase that `UnauthenticatedTransport` yields that behaviour and does not reject every document as `identityMismatch`); `myVid = deps.localVid`; `now`; `newErrorId = crypto.randomUUID`; `payloadPolicy = {kind:"validate", validate}` where `validate` checks against the task's `payload.schema.json` bundled from the npm package (use the `PayloadSchemaJSON`/equivalent export if present; else vendor the two schema files under `supabase/functions/app-trust-tasks/schemas/` with provenance comment).

For **challenge**: `proofPolicy = {kind:"verify", verify}` **but** absence of proof is not an error (spec: proof OPTIONAL). Confirm the runtime expresses "optional, verify if present" — if it needs a distinct policy kind, use it; if it cannot, run `verifyDetailed` manually and document. `checks = notConsequentialChecks()`. Freshness: `DEFAULT_FRESHNESS`.

For **authenticate**: `proofPolicy = {kind:"verify", verify: new DataIntegrityProofVerifier()}` (hard-required; the construction is superseded by (b) below, C-8 and C-42). `checks = consequentialChecks(new PostgresReplayGuard(...))`. Freshness: `CONSEQUENTIAL_FRESHNESS` with the acceptance window = `deps.acceptanceWindowMs`; `issuedAt` REQUIRED (spec `issuedAtRequirement`), missing → the runtime's `ISSUED_AT_REQUIRED` rejection.

The five outcomes map to HTTP per binding §4 via `status.ts` (S-50).

*(Amended, C-8; design phase resolved the open questions.)*
- **(a) Issuer authority.** `UnauthenticatedTransport` derives no parties, so the in-band `issuer` is authoritative and `identityMismatch` / `suppressed` cannot occur.
- **(b) Optional proof.** "Optional, verify if present" is `{kind:"verify"}` plus the spec's `isProofRequired: false`. Both tasks use the same policy, `proofPolicy = {kind:"verify", verify: new PurposeCheckingVerifier(new DataIntegrityProofVerifier({now: () => deps.now().getTime()}))}`. `PurposeCheckingVerifier` returns false (→ `proofInvalid`, 422) unless `proof.proofPurpose` is one of `SIGNING_PROOF_PURPOSES` (SPEC §4.7.3 item 1), because the upstream verifier does not check it.
  - *(Amended, C-42.)* The inner verifier is `new DataIntegrityProofVerifier({ now: () => deps.now().getTime(), cryptosuites: ["eddsa-jcs-2022"] })`, so a P-256/P-384 `ecdsa-jcs-2019` proof is `proofInvalid`. The chain `core.ts` builds also refuses (`proofInvalid`) unless `proof.verificationMethod === issuer + "#" + issuer.slice("did:key:".length)`, the only method a `did:key` lists (SPEC §4.7.3 item 3). That check is outside `PurposeCheckingVerifier`, whose unit contract is unchanged, and adds no §2 export. Proof verification precedes the replay claim and the handler, so a refused proof writes no replay record, consumes no challenge and creates no member. **Oracles:** an authenticate (or an optional challenge proof) signed `ecdsa-jcs-2019` by a P-256 `did:key` → 422 `proofInvalid`, no P3, no P5, no member; an Ed25519 authenticate with `verificationMethod: did + "#not-the-key"` → 422 `proofInvalid`; the helper/producer flow (`did#<multikey>`) → 200.
- **(c) Schemas.** The schemas are `SPEC.payloadSchema` from `AuthChallenge_v0_1` and `AuthAuthenticate_v0_3`, validated by `subsetSchemaValidator` (S-25). Nothing is vendored.
- **(d) Acceptance window.** `consequentialChecks()` cannot take a window, so authenticate uses `checks = authenticateChecks(guard, acceptanceWindowMs)`, which is `{freshness: {...CONSEQUENTIAL_FRESHNESS, maxAgeMs: acceptanceWindowMs}, replay: {kind:"guard", guard}}`. Its `freshness.requireIssuedAt` must be `true` (inherited from `CONSEQUENTIAL_FRESHNESS`); S-22's retention cap depends on it *(C-56)*.
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

*(Amended, C-44, C-53.)* Steps 1–2 differ from the task spec in two recorded ways (§1.2): consume-before-compare, and **expiry before mismatch**. A document that is both expired and mismatched gets `challengeExpired` (`retryable: true`, record **released**) where the spec would give `challengeMismatch` (`retryable: false`, refusal **retained**). Each carries a `// SPIKE:` marker in `core.ts` (`consume-before-compare` and `expiry before mismatch`, NF-5).

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
- **Self-enrolment** *(amended, C-47)*. The upsert admits any fresh `did:key` as a full member of a trust-enabled app, with no administrator, invitation or ACL step and no expiry (VTI-CLT-010/012/013/014). This is a recorded deviation (§1.2). A `// SPIKE:` marker whose line contains `self-enrolment` goes at the `upsertMemberByDid` call in `core.ts`.

**Oracle:** full producer flow with a fresh `did:key` → one `app_members` row (did set, email null), one `app_sessions` row whose token equals `tokens.accessToken`; `expiresIn == 30*24*3600` within ±2 s; a second sign-in by the same `did:key` → second session row, no second member row; `member_name` on documents the member then creates via `app-data` equals `app_members.name` (null → the existing `app-data` behaviour for null names).

### S-48 Replay semantics end-to-end

Re-sending the **identical** signed authenticate document (same `id`, same bytes) within the acceptance window → `200` with the **retained** `#response` (same `accessToken`), **no** new `app_sessions` row. Same `id` with a different body → `409` `idConflict`. A document whose `issuedAt` is older than the window → `422` `expired`, and it is **not** recorded in `app_tt_replay` (binding §5.1 item 3).

*(Amended, C-14.)*
- **The window's edge.** "Older than the window" means `issuedAt + acceptanceWindowMs + 60 000 (skew) < now` (runtime freshness rule). A document `acceptanceWindowMs + 30 s` old is still accepted, and its replay record must still be live (S-22 pad). At the exact last accepted millisecond the record is already treated as expired; S-22 records that edge and its mitigation *(C-56)*.
- **Retained errors.** A non-retryable refusal is retained too. Re-sending the identical document returns the *same* error document under its code's status, and makes no new store calls beyond P5/P6.

**Additional oracle:** a document `acceptanceWindowMs + 30 s` old completes once. Its identical resend → the retained response, and the session count is unchanged.

**C-56 oracle (pins the known behaviour and its mitigation).** A document with `issuedAt = T` and no `expiresAt` completes at `now = T` (one session). Its identical resend at `now = T + acceptanceWindowMs + 60 000` → 422 `auth/authenticate:challengeNotFound`; the handler ran (one more P3), and the session count is still 1. The same resend at `now = T + acceptanceWindowMs + 60 001` → 422 `expired`, with zero P3 and P5.

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
- `unsupportedType`, `unsupportedVersion`, `unsupportedExtension` *(C-45; never emitted)*, `expired`, `proofRequired`, `proofInvalid`, `identityMismatch`, `wrongRecipient`, `cancelled`, `taskFailed` → 422
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

*(Amended, C-45.)* The retained-error status is a recorded deviation: a `// SPIKE:` marker whose line contains `retained error` goes at the duplicate-with-prior-error branch of `status.ts`; the `suppressed` → 400 branch may share it or carry its own.

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

### S-60 Key custody (VTI-CLT-001, -002, -004, -005; VTI-CLT-006 only against principals on other origins)

*(Heading amended, C-38: VTI-CLT-006 is **not met** on the shared hosting origin; see "Shared origin" below and §1.2.)*

`getOrCreateIdentity` (signature as amended by C-16 and C-37 below): generates Ed25519 via WebCrypto with `extractable: false` when `isEd25519Available()`; otherwise, only if the caller passed `{allowInMemoryFallback: true}`, generates with `@noble/curves` and keeps it in IndexedDB as raw bytes (labelled `custody: "software"`). Returns `{ did, custody, sign(bytes) }`. The private key is never sent anywhere (grep-testable: no network call carries key material). The identity is recorded with `kind: "bootstrap"` in storage (VTI-CLT-004) so Increment 2 can distinguish it from a wallet identity. Generation performs no network I/O (VTI-CLT-005).

*(Amended, C-16.)*
- **Async detection.** `isEd25519Available()` is **async** (`Promise<boolean>`): the only reliable probe is a `crypto.subtle.generateKey({name:"Ed25519"}, false, ["sign","verify"])` attempt.
- **Async signing.** `DeviceIdentity.sign(bytes)` returns `Promise<Uint8Array>`, because WebCrypto signing is async. For the same reason `signTrustTask` cannot sign with a non-extractable key: its `Signer.sign` is synchronous.
- **Public key.** For the WebCrypto path, the public key is exported raw (always allowed for the public half) to build the `did:key`.
- **Software path.** It stores the 32-byte seed under `custody: "software"`, and only when `allowInMemoryFallback` is true. Otherwise it throws `TrustSignInError('unsupported', false, 0)`.
- **Signature.** ~~`getOrCreateIdentity(options?: {store?, allowInMemoryFallback?})`; the default store is `indexedDbIdentityStore()`, persisting under `IDENTITY_KEY`.~~ Superseded by C-37 below.

*(Amended, C-37.)* **One identity per app.**
- The helper keeps a separate Ed25519 key and `did:key` for each app, identified by the `appId` it already receives (`env.APP_ID`, the `cloud_apps.id` uuid). The service VID is **not** used: every app shares `TRUST_TASKS_VID`, so it does not identify the app.
- **Storage key.** `identityKeyForApp(appId)` returns `IDENTITY_KEY_PREFIX + appId.trim().toLowerCase()`, with `IDENTITY_KEY_PREFIX = 'rb.trust-signin.identity.v2:'`. If `appId` is not a string or `appId.trim()` is empty, it throws `TrustSignInError('invalidAppId', false, 0)`.
- **No shared identity.** `IDENTITY_KEY` (`'rb.trust-signin.identity.v1'`) is not exported. The helper never reads or writes that key, nor any key other than `identityKeyForApp(appId)` for the app in hand. Nothing is migrated: no v1 identity was ever deployed.
- **Signature.** `getOrCreateIdentity(options: GetIdentityOptions)`, with `GetIdentityOptions = {appId: string; store?: IdentityStore; allowInMemoryFallback?: boolean}` (`appId` and `options` required). It computes the key first, so an invalid `appId` throws before any store access, then does `store.get(key)` and, when it mints, `store.put(key, record)`. The default store is `indexedDbIdentityStore()`; the database stays `rb-trust-signin`, one entry per app. Everything else above is unchanged.
- **Oracles.** (1) One in-memory store with app ids A and B gives two different DIDs, stored under exactly `identityKeyForApp(A)` and `identityKeyForApp(B)`. (2) A second call for A returns A's DID. (3) `identityKeyForApp('ABC-…') === identityKeyForApp('abc-…')`. (4) `''`, `'   '` or a non-string → `invalidAppId`, zero store calls. (5) No store call uses `'rb.trust-signin.identity.v1'`, and `IDENTITY_KEY` is not exported. (6) S-61's per-app oracle.

*(Amended, C-38.)* **Shared origin.** The private key cannot be exported (`extractable: false`) and is never transmitted, so VTI-CLT-006 holds against principals on other origins. It is **not met** where these apps are hosted: every Community-Hosted app shares one origin and Builder framework previews run same-origin, so any script there can open `rb-trust-signin` and *use* any app's key with `crypto.subtle.sign`, signing in as that person to every app this device has joined. With `custody: 'software'` the seed itself is readable. Per-app keys stop correlation, not this impersonation. The trial-only enablement rule and the per-app-origin production prerequisite are in §1.2.
- **Marker.** A `// SPIKE:` marker whose line contains `shared origin` sits at the key-storage site (inside `identityKeyForApp`, or immediately above the `store.put` in `getOrCreateIdentity`).
- **Header.** The file's header comment must not say, without qualification, that the private key never leaves the device. It says the key cannot be exported and is never sent, but any script on the same origin can use it.

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

*(Amended, C-37.)* **Identity.** When `options.identity` is absent, `signIn` calls `getOrCreateIdentity({ appId, store: options.identityStore })`, with the same `appId` argument it puts in the URL. `SignInOptions.identityStore?: IdentityStore` is optional (default `indexedDbIdentityStore()`). A caller-supplied `options.identity` is used as is. **Oracle:** `signIn(base, A, key, {recipient, identityStore, fetch, …})` with no `identity` signs with the DID found under `identityKeyForApp(A)`; a second `signIn` for app B on the same store uses a different `issuer`.

*(Amended, C-52.)* **Response matching.** After parsing a 200 non-error body, `signIn` requires `body.type === <request type> + "#response"` and `body.threadId === <request id>`, at both the challenge and the authenticate step (the helper sends no `threadId`, and the consumer answers `threadId ?? id`). Otherwise it throws `TrustSignInError('transport', false, 200)` before any further effect. **Oracle:** a 200 challenge response with `threadId` ≠ the request id, or with the authenticate `#response` type → `transport`, not retryable, status 200, no second POST. An authenticate 200 whose `type` is the challenge `#response` → `transport`, and `member_token` is not written.

**Oracle (fixture test):** for a fixed seed, a fixed `now` and fixed ids, `signDocument` with a software identity produces byte-identical JSON to `signTrustTask(doc, signerFromPrivateKey("ed25519", seed), {proofPurpose:"authentication", created})`. `producer.ts` output for the same inputs equals `buildAuthenticateDocument` + `signDocument`.

### S-62 Non-goal: the helper never asks for email

No input field, no `auth_request`. "Sign in with this device" is the UX phrase; the helper exposes `did` so the app can show a short form (`did:key:z6Mk…` last 6 chars).

### S-63 Kit wiring *(new, C-18)*

The helper reaches generated apps only through the kit:
- **Registration.** `src/kit/index.ts` imports `./files/lib/trust-signin.ts?raw` and adds `'/src/lib/trust-signin.ts'` to `KIT_FILES`. `withKitFiles()` then materializes it when a project imports `./lib/trust-signin` or `@/lib/trust-signin`.
- **Imports.** The file uses **bare** specifiers only: `@openvtc/trust-tasks-proof` and `@noble/curves/ed25519.js`. No `npm:` or `@/` aliases are allowed. *(Amended, C-51.)* It does **not** import `@openvtc/trust-tasks`, not even type-only (`collectBarePackages` counts a type-only import, so exports and synced repos would list it in `package.json`). It declares its own local `TrustTaskDocument<P>` type. **Oracle:** no import or export `from '@openvtc/trust-tasks'` in the helper, and `collectBarePackages` over a project containing the materialized helper does not list `@openvtc/trust-tasks`.
- **Version pins.** `src/preview/bundler/versions.ts` `PINNED_VERSIONS` gains `'@openvtc/trust-tasks-proof': '0.1.3'` and `'@noble/curves': '2.4.0'`. *(C-50.)* These entries are advertised as known-good to **every** framework project's system prompt, not only trust-signin ones. Accepted with no code change and recorded in FINDINGS (§9 item 4).
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
4. Every deviation from the two task specs, the binding, RFC 3339 and the VTI client chapter, each with "what closing it requires". *(Amended, C-50, C-53..C-56, C-59.)* At least:
   - unsigned responses / label `local_vid` (closing: a service signing key and a resolvable `did:web`);
   - consume-before-compare (S-44);
   - expiry before mismatch, including the different retryability and replay-record fate (C-44, C-53);
   - 0.2 not registered; no `sessionKey`; no bearer identity mapping; no discovery task;
   - the retained-error status and `suppressed` → 400 (C-45);
   - the `OPTIONS` preflight (S-51);
   - the rate limit: per app and per isolate rather than per source, no `auth/challenge:rateLimited`, and the per-app budget DoS by anyone who knows the `app_id`, even with a wrong `app_key` (C-46, C-54). Closing requires a source identity, parse-before-limit for challenges, and a shared (database or edge) limiter;
   - envelope checks not done: `type` syntax and `ceremony` / `extCritical` placement (C-43); leap seconds refused (C-55);
   - self-enrolment (C-47);
   - per-service audience binding, and `wrongRecipient` where binding 0.2 §3 says `identityMismatch` (C-48);
   - a failed release (C-40, OVTC-42) or a twice-failed `recordResponse` (C-59, OVTC-43) leaving a record in flight, answered 202 for its life;
   - the replay-record boundary millisecond, mitigated only by the single-use challenge, and the cap's dependence on `requireIssuedAt: true` (C-56, OVTC-50, OVTC-51);
   - **the shared hosting origin** (C-38): any same-origin script can use any app's device key and sign in as that person. Closing requires per-app origins; until then, the trial-only enablement rule applies;
   - (N-2, no code change) the `PINNED_VERSIONS` entries for `@openvtc/trust-tasks-proof` and `@noble/curves` are advertised to every framework project's prompt (C-50).
5. What the OpenVTC browser plugin did when pointed at the endpoint (it sends 0.2 — expect `unsupportedType`; record the exact error document it displayed). If it was not tried, say so.
6. The VTI Client Onboarding mapping: which of VTI-CLT-001…006, 010, 012, 013, 014, 016, 040…045 the browser helper and consumer satisfy, and what "rotation" (Step 3) would mean for Community Cloud where the member row is the standing. *(Amended, C-38, C-47, C-50.)* It must state:
   - **VTI-CLT-006 is not met on the shared hosting origin.** The key cannot be exported and is never sent, but any script on `relationalbuilder.org` (another hosted app, or a same-origin Builder preview) can use it to sign in as that person to every app the device has joined, without limit of time; with `custody: 'software'` the seed is readable. Per-app keys (C-37) remove correlation, not impersonation.
   - **The trial-only enablement rule:** `trust_signin_enabled` may be on for a shared-origin app only for the spike trial (owner-controlled test apps, test identities, never real community members).
   - **Per-app origins are a production prerequisite**, with previews isolated from the Builder and from each other. The same isolation would close the email path's `member_token` exposure.
   - **Self-enrolment:** VTI-CLT-010/012/013 (no administrator, invitation or ACL step) and VTI-CLT-014 (the bootstrap identity is not low-trust and never expires) are not met.
7. Revised effort estimates for Increments 2, 3, 4, each with the one fact from this increment that most changed it.

## 10. Increment 2 sketch (not for implementation now)

Accept `did:webvh`/`did:web` issuers: swap `DataIntegrityProofVerifier` (did:key-only) for a verifier that takes a resolver; reuse v1's `resolver.ts` with net-guard (v1 S-31/S-32). Register `auth/authenticate/0.2` for the current browser plugin. Honour `sessionKey`: store on `app_sessions`, and let `app-data` accept a Data Integrity proof by that key on write actions in place of `member_token` — this is the point where Community Cloud's bearer model and the VTI's signed-document model actually meet, and the first increment that forces a change inside `app-data` proper. *(Amended, C-48.)* Increment 2's `sessionKey` proofs must carry their own app binding, for example a per-app recipient VID or an app claim inside the signed payload, because Increment 1's audience binding is per service (§1.2). Add `auth/whoami` (replaces `auth_me`) and `auth/revoke-session` (replaces `auth_signout`).

## 11. Non-functional

- **NF-1** `tsc --noEmit -p tsconfig.functions.json` passes for the function sources (ES2022 + DOM libs; `npm:` specifiers mapped via `paths`).
- **NF-2** `npx vitest run` < 60 s, no network.
- **NF-3** Dev deps only: `vitest`, `@openvtc/trust-tasks@0.26.x`, `@openvtc/trust-tasks-proof@latest-compatible`, `@noble/curves`. Edge function imports `npm:@openvtc/trust-tasks@<pinned>` and `npm:@openvtc/trust-tasks-proof@<pinned>` — pins recorded in `BASE_SHA`.
- **NF-4** No secrets in committed files. `.env.example` gains `TRUST_TASKS_LOCAL_VID=` with a comment.
- **NF-5** Every spike-grade shortcut carries `// SPIKE:`. *(Amended, C-34 → C-49, C-54, C-55.)* The mandatory minimum, grep-testable per file. Every listed phrase must appear **on the same line** as a `// SPIKE:`:
  - `core.ts` (≥ 10 markers): the exact S-30 line `// SPIKE: unsigned responses; local_vid is a label`; `consume-before-compare` (S-44); the S-47 unsigned `#response`; the S-25 subset validator; the rate limiter, whose line contains `per-app`, `rateLimited` and `app_id`, and does **not** contain `APP_KEY` (C-46, C-54); `expiry before mismatch` (C-44); `envelope` (C-43); `self-enrolment` (C-47); `audience` (C-48); `leap second` (C-55, at the `date-time` check).
  - `status.ts` (≥ 1): `retained error` (C-45).
  - `replay.ts` (≥ 1): the S-22 retention pad.
  - `index.ts` (≥ 1): `OPTIONS` (S-51).
  - `src/kit/files/lib/trust-signin.ts` (≥ 2): the software-custody fallback, and `shared origin` (C-38).

  More are allowed.

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

Each `it()` title begins with its requirement id. *(REVIEW-2 additions.)* C-54 and C-57 → `core.auth.test.ts` (or a limiter unit test beside it); C-55 → `schema.test.ts`, plus the envelope cases in `core.auth.test.ts` / `core.authenticate.test.ts`; C-56 → `core.authenticate.test.ts`; C-58 → `schema.test.ts`; C-59 → `replay.test.ts`; the NF-5 phrase rules → `nonfunctional.test.ts`.

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

### Amendments for REVIEW-1 (design agent, 2026-10-28)

These answer `REVIEW-1.md` (verdict REVISE-SPEC). Item numbers (R1-n, N-n, L-n, OVTC-n, Probe x) are that file's. No requirement id was removed, renumbered or reused, and no requirement was weakened. Where an entry changes a `DESIGN.md` §2 signature it says so; `DESIGN.md` §6 lists every such change. The spike's purpose decides each call: a working end-to-end sign-in trial with honest findings, not production hardening. A cheap fix that makes the trial more honest is required; anything else is recorded as a deviation with a `// SPIKE:` marker.

- **C-37 · S-60, DESIGN §2 (helper). Per-app device identity.** *(R1-1, blocker; owner decision: per-app keys plus a recorded risk.)* **This changes §2 signatures** (listed at the end of this entry). New normative text, replacing S-60's "persisting under `IDENTITY_KEY`":
  - **One identity per app.** The helper keeps a separate Ed25519 key and `did:key` for each app. The app is identified by the `appId` the helper already receives (`env.APP_ID`, the `cloud_apps.id` uuid). The service VID is **not** used: every app shares `TRUST_TASKS_VID` (L-27), so it does not identify the app.
  - **Storage key.** `identityKeyForApp(appId)` returns `IDENTITY_KEY_PREFIX + appId.trim().toLowerCase()`, where `IDENTITY_KEY_PREFIX = 'rb.trust-signin.identity.v2:'`. Lower-casing makes two spellings of one uuid one identity. If `appId` is not a string or `appId.trim()` is empty, it throws `TrustSignInError('invalidAppId', false, 0)`.
  - **No shared or default identity remains.** The `IDENTITY_KEY` export (`'rb.trust-signin.identity.v1'`) is removed. The helper never reads or writes that key, nor any key other than `identityKeyForApp(appId)` for the app in hand. The version moves to `v2` so the retired shared form cannot be mistaken for a per-app key. Nothing is migrated: no v1 identity was ever deployed.
  - **`getOrCreateIdentity(options: GetIdentityOptions)`.** `options` is now required and `GetIdentityOptions.appId: string` is required. The function computes the key first, so an invalid `appId` throws before any store access. It then does `store.get(key)` and, when it mints, `store.put(key, record)`, both with that one key. The IndexedDB database stays `rb-trust-signin`, with one entry per app. Everything else in S-60 / C-16 is unchanged: WebCrypto non-extractable first, the software fallback only with `allowInMemoryFallback`, `kind: 'bootstrap'`, no network I/O.
  - **`signIn`.** When `options.identity` is absent, `signIn` calls `getOrCreateIdentity({ appId, store: options.identityStore })`, using the same `appId` argument it puts in the URL. New optional `SignInOptions.identityStore?: IdentityStore` (the default is `indexedDbIdentityStore()`), so the per-app path is testable without IndexedDB. A caller-supplied `options.identity` is used as is: that is the app's choice.
  - **§2 changes (DESIGN §6).** `IDENTITY_KEY` is removed. Added: `IDENTITY_KEY_PREFIX` and `identityKeyForApp(appId: string): string`. `GetIdentityOptions` gains a required `appId`, and `getOrCreateIdentity`'s parameter is no longer optional. `SignInOptions` gains `identityStore?`.
  - **Oracles.** (1) The same in-memory store with app ids A and B gives two different DIDs, stored under exactly `identityKeyForApp(A)` and `identityKeyForApp(B)`. (2) A second call for A returns A's DID unchanged. (3) `identityKeyForApp('ABC-…')` equals `identityKeyForApp('abc-…')`. (4) `''`, `'   '`, or a non-string → `invalidAppId`, with zero store calls. (5) No store call ever uses the key `'rb.trust-signin.identity.v1'`, and `IDENTITY_KEY` is no longer exported. (6) `signIn(base, A, key, {recipient, identityStore, fetch, …})` with no `identity` signs with A's identity: the documents' `issuer` is the DID found under `identityKeyForApp(A)`. A second `signIn` for app B on the same store uses a different `issuer`.

- **C-38 · S-60, §1.2, NF-5, §9 items 4 and 6. The shared-origin risk is recorded.** *(R1-1; L-23.)*
  - **Amended VTI-CLT-006 claim.** S-60's heading lists VTI-CLT-006 as satisfied. That is replaced by: *VTI-CLT-006 is satisfied only against principals on other origins.* The private key cannot be exported (WebCrypto `extractable: false`) and is never transmitted (S-60, S-61). But VTI-CLT-006 ("MUST NOT hold it in storage readable by other principals on the host") is **not met** where these apps are hosted. Every Community-Hosted app is served from one origin, `relationalbuilder.org/s/<slug>/`, and Builder framework previews run project code same-origin too (`allow-same-origin`). Any script there can open the `rb-trust-signin` database and **use** any app's non-extractable key with `crypto.subtle.sign`. "Non-extractable" prevents export, not use. Every app's `APP_ID`/`APP_KEY` is public, so a malicious hosted app (or preview) can sign a valid `auth/authenticate/0.3` for any app this device has joined, and so sign in as that person there, without limit of time. With `custody: 'software'`, the seed itself is readable.
  - **What per-app keys do and do not fix.** C-37 removes cross-app **correlation**: no two apps see the same DID for a person. It does not remove the **impersonation** above. The existing email path has the same class of exposure (`localStorage.member_token` is shared across hosted apps), but the trust path widens it from "read the last token written" to "mint fresh sessions for every joined app".
  - **Known limitation, accepted for the spike only.** `trust_signin_enabled` stays default `false`. In Increment 1 it may be turned on for a shared-origin app only for the spike trial: owner-controlled test apps with test identities, never an app with real community members.
  - **Production prerequisite.** Per-app origins, for example `<slug>.relationalbuilder.org` (each a separate origin for IndexedDB and `localStorage`), with Builder previews isolated from both the Builder origin and each other. Trust sign-in must not be offered outside the trial until hosted apps have them. The same isolation is what would close the `member_token` exposure.
  - **Marker.** A `// SPIKE:` marker whose line contains the phrase `shared origin` is mandatory in `src/kit/files/lib/trust-signin.ts`, at the key-storage site (inside `identityKeyForApp` or immediately above the `store.put` in `getOrCreateIdentity`). The file's header comment must stop saying, without qualification, that the private key never leaves the device. It must say the key cannot be exported and is never sent, but any script on the same origin can use it.
  - **FINDINGS.** §9 item 6 must state VTI-CLT-006 as *not met on the shared hosting origin*, the impersonation path, the trial-only enablement rule, and per-app origins as the production prerequisite. §9 item 4 lists it as a deviation whose closing requires per-app origins.

- **C-39 · S-22. Replay retention is capped at the acceptance window.** *(R1-5; Probe H; OVTC-44.)* This replaces S-22's "`until_at = retainUntil + retentionPadMs`" with:
  - `until_at = min(retainUntil + retentionPadMs, now + acceptanceWindowMs + 2 × DEFAULT_SKEW_MS)`, where `now` is `claim`'s `now` argument.
  - **Why the bound loses nothing.** Freshness refuses `issuedAt > now + skew` and refuses once `issuedAt + acceptanceWindowMs + skew < now` (`rt/freshness.ts:132, 143`). So the consumer is never willing to execute a claimed document after `now + acceptanceWindowMs + 2·skew`. Without `expiresAt`, `retainUntil + pad = issuedAt + window + skew`, which is already within the cap, so the existing S-22/S-48 window-edge behaviour is unchanged. The cap bites only when a producer's `expiresAt` reaches past the window.
  - **New dep (additive §2 change).** `ReplayGuardDeps.acceptanceWindowMs?: number`, default `DEFAULT_ACCEPTANCE_WINDOW_MS` (300 000). `core.ts` passes `deps.acceptanceWindowMs ?? DEFAULT_ACCEPTANCE_WINDOW_MS`, the same value it gives `authenticateChecks`. `retainUntil === undefined` still throws.
  - **Oracles.** (1) A guard `claim` with `retainUntil` = year 9999 and `now = N` writes `until_at === new Date(N + 300_000 + 120_000).toISOString()`. (2) End to end: an authenticate with `expiresAt: "9999-12-31T23:59:59Z"` completes, and its P5 `until_at` is ≤ `now + acceptanceWindowMs + 120 000`, a plain `YYYY-…Z` string with no `+0` extended year. (3) A document without `expiresAt` still gets `until_at = issuedAt + window + 60 000` (the existing pad test). (4) `acceptanceWindowMs: 10_000` gives a cap of `now + 130 000`.

- **C-40 · S-22. `release` is total; `recordResponse` retries once.** *(R1-2 spec basis; N-11; Probes B, C; OVTC-42, -43.)* This replaces S-22's "`recordResponse` = P9 and throws on non-2xx. `release` = P10." with:
  - **`release` never throws.** It issues P10 once. A rejected `fetch` or a non-2xx answer is logged through `deps.log?.('replay.release_failed', {status})` (no id, no digest) and `release` resolves normally. New optional `ReplayGuardDeps.log?: (event: string, detail?: Record<string, unknown>) => void` (additive §2 change); `core.ts` passes `deps.log`.
  - **End-to-end consequence (normative).** When the handler refuses with `unavailable` because P3 failed, and P10 then also fails (rejects, or answers 503), the HTTP answer is **503 `unavailable`, `retryable: true`**, never 500 `internalError`. The record stays in flight, so an identical resend is answered 202 until its `until_at`. That is accepted and recorded (FINDINGS §9 item 4, OVTC-42). The helper already maps 202 to `noResponse`/retryable, and a retry uses new documents.
  - **`recordResponse` retries once.** It issues P9. On a rejected `fetch` or a non-2xx answer it issues P9 once more. If the second attempt also fails, it throws (the runtime swallows it, `rt/consume.ts:553-564`). The residual case (both fail → resends get 202 for the record's life) is recorded as OVTC-43.
  - **DESIGN §3.** P9 may now be issued twice, the second time only after a failed first. P10 is issued at most once.
  - **Oracles.** (1) P3 rejects and P10 rejects → 503 `unavailable`, `retryable: true`, body `issuer === localVid`. Same with P10 answering 503. (2) A unit `release` with a rejecting `fetch` resolves and calls `log` once with `replay.release_failed`. (3) P9 fails once, then succeeds → the identical resend gets 200 and the retained response. (4) P9 fails twice → the first answer is still 200 with the token, and an identical resend gets 202.

- **C-41 · S-25. The schema check walks every sub-schema, and fails closed.** *(R1-3 spec basis; Probe D; N-5.)* Added to S-25:
  - **Sub-schema positions.** `items`, `propertyNames`, and a schema-valued `additionalProperties` are each **one** sub-schema. `properties` and `$defs` are **maps** from names to sub-schemas. `assertSchemaSupported` applies the keyword rule recursively at every one of these positions, at any depth.
  - **The validator asserts first.** `subsetSchemaValidator.validate(schema, value)` runs `assertSchemaSupported(schema)` over the **whole** schema before looking at `value`. An unsupported keyword anywhere therefore throws, whatever the value is, and never yields `true`.
  - **Own properties only.** `required` and `properties` consider only the value's own properties (`Object.hasOwn`). Prototype names such as `toString` are absent.
  - **Oracles.** `{type:"array", items:{enum:["a"]}}`, `{items:{oneOf:[{}]}}`, `{propertyNames:{const:"x"}}`, `{additionalProperties:{not:{}}}` and `{properties:{a:{items:{anyOf:[]}}}}` each make `assertSchemaSupported` throw. `validate({type:"array", items:{type:"string", enum:["a"]}}, ["zzz"])` throws, rather than returning `true`. `validate({type:"object", required:["toString"]}, {})` is `false`. The four pinned schemas still pass.

- **C-42 · §1.1 item 3, S-42. Verification is `eddsa-jcs-2022` / Ed25519 only, and the verification method must be the `did:key`'s own.** *(R1-4 spec basis; Probe A; L-21; OVTC-46, -48.)* This replaces C-8(b)'s verifier construction with:
  - `new PurposeCheckingVerifier(new DataIntegrityProofVerifier({ now: () => deps.now().getTime(), cryptosuites: ["eddsa-jcs-2022"] }))`, for both tasks. That makes the authenticate issuer rule match S-43/C-31's Ed25519-only subject rule.
  - **Verification method.** The proof must also be refused (`proofInvalid`, 422) unless `proof.verificationMethod === issuer + "#" + issuer.slice("did:key:".length)`, the only method a `did:key` document lists (SPEC §4.7.3 item 3). The upstream verifier ignores the fragment. The check sits in the verifier chain `core.ts` builds, not in `PurposeCheckingVerifier`, whose unit contract is unchanged. No §2 export is added.
  - **Consequence.** Because proof verification precedes the replay claim and the handler, a refused proof writes no replay record, consumes no challenge, and creates no member.
  - **Oracles.** (1) An authenticate signed `ecdsa-jcs-2019` by a P-256 `did:key` (`signTrustTask` with a P-256 signer) → 422 `proofInvalid`: no `app_members` row, no P3, no P5. Same for an optional proof on a challenge. (2) An Ed25519 authenticate signed with `verificationMethod: did + "#not-the-key"` → 422 `proofInvalid`. (3) The existing helper/producer flow (`did#<multikey>`) → 200.

- **C-43 · S-41 (C-7). Envelope timestamps must be RFC 3339; the rest of §7.2 item 1 is a recorded deviation.** *(R1-6, L-15; Probe F; OVTC-45.)* Fixed, because it is cheap and the runtime's `Date.parse` makes the verdict depend on the host's time zone:
  - `checkFrameworkShape` additionally requires `issuedAt` and `expiresAt`, when present, to satisfy S-25's `date-time` rule (the same check the validator applies for `format: "date-time"`: full RFC 3339 date and time, offset `Z` or `±hh:mm` **required**, month 01–12, day 01–31; *the range rule is completed by C-55*). Otherwise → 400 `malformedRequest`, `retryable: false`, with a constant message naming the member (for example `"issuedAt is not an RFC 3339 date-time"`). It also requires `parentThreadId` to be a string when present.
  - **Accepted, not checked:** `type` syntax beyond the exact-match dispatch of S-41, and `ceremony` / `extCritical` placement. Neither task uses them, and S-41 dispatch never lets an unregistered `type` reach a handler. A `// SPIKE:` marker whose line contains `envelope` goes in `checkFrameworkShape`.
  - **Oracles.** `issuedAt: "Tue, 04 Mar 2031 05:06:07 GMT"` → 400 `malformedRequest` (it was 200). `issuedAt: "2031-03-04T05:06:07.000"` (no offset) → 400, whatever `TZ` is. `expiresAt: "2031-13-01T00:00:00Z"` → 400. `issuedAt: "2031-03-04T05:06:07+02:00"` passes the shape check. `parentThreadId: 7` → 400. All of these on authenticate show zero P3 and P5 calls.

- **C-44 · S-44 (C-11), §1.2. Expiry before mismatch is a recorded deviation.** *(R1-6, L-4.)* Accepted. The single atomic PATCH (S-21) reports `expired` without returning the stored challenge, so `challengeExpired` wins over `challengeMismatch`, where the task spec compares first (items 3–4). ~~Only the code reported differs: both refuse, and the challenge is burned either way.~~ *Corrected by C-53:* the code, the retryability and the replay record's fate all differ — `challengeExpired` is retryable and its record is released; `challengeMismatch` is not, and its refusal is retained. Both refuse, and the challenge is burned either way. A `// SPIKE:` marker whose line contains `expiry before mismatch` goes where `core.ts` maps `expired` to `challengeExpired`. FINDINGS §9 item 4 lists it beside consume-before-compare. No behaviour change, so the existing test stands.

- **C-45 · S-50 (C-12). The retained-error status is marked; `unsupportedExtension` → 422.** *(R1-6, L-10, L-11; N-7.)*
  - Retained-error status: accepted, and already recorded (R6). A `// SPIKE:` marker whose line contains `retained error` goes in `status.ts` at the duplicate-with-prior-error branch. The `suppressed` → 400 branch (L-11) may share it or carry its own.
  - **Fix.** `statusForCode("unsupportedExtension")` → **422** (a SPEC §8.3 standard code; it was 500). It is still never emitted.
  - **Oracle.** `statusForCode("unsupportedExtension") === 422`. `nonfunctional` finds `retained error` on a `// SPIKE:` line in `status.ts`.

- **C-46 · S-40 (C-6), C-33, §1.2. Rate limiting is a recorded deviation.** *(R1-6, L-12.)* Accepted, not fixed. Answering with `auth/challenge:rateLimited` would need the body parsed before the limit, reversing S-40's order, and the per-source axes need a source identity the function does not have. Recorded:
  - The limit is per app (120/min) and per isolate. It is not per source IP or DID, as challenge 0.1 consumer item 6 asks.
  - The limit is a transport-level 429 plain JSON, never `auth/challenge:rateLimited` (a MUST in item 6).
  - **Per-app budget DoS.** ~~Anyone holding an app's public `APP_KEY`~~ *Corrected by C-54:* anyone who knows an app's `app_id`, even with a wrong `app_key`, can use up that app's budget, denying sign-in, by either path, to every user of that app in that isolate. The email path shares this.
  - **Marker.** The existing rate-limiter `// SPIKE:` line in `core.ts` must also contain `per-app` and `rateLimited` (and, by C-54, `app_id`, not `APP_KEY`).
  - FINDINGS §9 item 4 lists all three, with "closing requires a source identity, parse-before-limit for challenges, and a shared (database or edge) limiter".

- **C-47 · §1.2, S-47. Self-enrolment is a recorded deviation.** *(R1-6, L-24; REVIEW-1 §3.10.)* Accepted, and added to §1.2: *any freshly minted `did:key` becomes a full member of an app with `trust_signin_enabled`, with no administrator, invitation or ACL step (VTI-CLT-010/012/013). The bootstrap DID is not treated as low-trust, and the member row never expires (VTI-CLT-014). This is a Sybil and storage-growth surface, gated only by the per-isolate rate limit.* The email path is gated by inbox possession; this path is not. A `// SPIKE:` marker whose line contains `self-enrolment` goes at the `upsertMemberByDid` call in `core.ts`. FINDINGS §9 items 4 and 6 carry it.

- **C-48 · S-30, §1.2, §10. Audience binding is per service, not per app.** *(R1-6, L-27; L-9.)* Accepted, and added to §1.2: *every Community Cloud app shares `recipient = localVid`, so SPEC §4.8.2 audience binding ties a signed document to Community Cloud, not to the app. App binding in Increment 1 rests entirely on `app_tt_challenges.app_id` (S-21) and the app-scoped replay record (S-24).* §10 gains: *Increment 2's `sessionKey` proofs must carry their own app binding, for example a per-app recipient VID or an app claim inside the signed payload.* A `// SPIKE:` marker whose line contains `audience` goes at the `myVid: deps.localVid` site. One marker covering both `consumeInbound` calls is enough, and it should also name `wrongRecipient` (L-9: the runtime answers `wrongRecipient` where binding 0.2 §3 says `identityMismatch`).

- **C-49 · NF-5 (C-34). Updated marker minimum.** *(R1-6; C-38, C-43..C-48.)* Every listed phrase must appear **on the same line** as a `// SPIKE:` (grep-testable):
  - `core.ts` (≥ 9 markers; ≥ 10 and two more phrase rules by C-54 and C-55, see NF-5): the exact S-30 line `// SPIKE: unsigned responses; local_vid is a label`; `consume-before-compare`; the S-47 unsigned `#response`; the S-25 subset validator; the rate limiter, containing both `per-app` and `rateLimited` (C-46); `expiry before mismatch` (C-44); `envelope` (C-43); `self-enrolment` (C-47); `audience` (C-48).
  - `status.ts` (≥ 1): `retained error` (C-45).
  - `replay.ts` (≥ 1): the retention pad, unchanged.
  - `index.ts` (≥ 1): `OPTIONS`, unchanged.
  - `src/kit/files/lib/trust-signin.ts` (≥ 2): the software-custody fallback, and `shared origin` (C-38).
  More are allowed.

- **C-50 · §9. FINDINGS additions.** *(R1-1, R1-6; N-2.)* §9 item 4's deviation list gains: expiry before mismatch (C-44); retained-error status (C-45, R6); the rate-limit axis, the missing `rateLimited`, and the per-app budget DoS (C-46); envelope checks not done (C-43); self-enrolment (C-47); per-service audience binding and `wrongRecipient` (C-48); a release failure leaving a record in flight (C-40, OVTC-42); and the shared-origin key use (C-38). §9 item 6 gains C-38's VTI-CLT-006 statement and C-47's VTI-CLT-010/012/013/014 statement. Also recorded, with no code change (N-2): S-63's `PINNED_VERSIONS` entries for `@openvtc/trust-tasks-proof` and `@noble/curves` are advertised as known-good to **every** framework project's system prompt, not only trust-signin ones.

- **C-51 · S-63 (C-18), DESIGN §2 (helper imports). The helper no longer imports `@openvtc/trust-tasks`.** *(N-1.)* S-63's import list becomes **`@openvtc/trust-tasks-proof` and `@noble/curves/ed25519.js` only**. The helper declares its own local `TrustTaskDocument<P>` type (structurally: `id`, `type`, optional `issuer`, `recipient`, `issuedAt`, `expiresAt`, `threadId`, `payload: P`, optional `proof`). Reason: `collectBarePackages` counts even a type-only import, so exported and synced repos got `"@openvtc/trust-tasks": "latest"` in `package.json`. Exported function signatures are unchanged in shape. **Oracle:** `kit.test` finds no import or export `from '@openvtc/trust-tasks'` in the helper. `collectBarePackages` over a project containing the materialized helper does not list `@openvtc/trust-tasks`.

- **C-52 · S-61 (C-17). The helper checks that a response answers its request.** *(N-8.)* After parsing a 200 non-error body, `signIn` requires `body.type === <request type> + "#response"` and `body.threadId === <request id>`, for both the challenge and the authenticate step (S-43/C-10: `threadId = threadId ?? id`, and the helper sends no `threadId`). Otherwise it throws `TrustSignInError('transport', false, 200)`. **Oracle:** a 200 challenge response with `threadId` ≠ the request id, or with the authenticate `#response` type, → `transport`, not retryable, status 200, and no second POST. An authenticate 200 whose `type` is the challenge `#response` → `transport`, and `member_token` is not written.

Not changed by this loop, each with the reason, is in `REVIEW-1.md` § *D response*.

**C-37 to C-52 are now applied in place in the spec body** (§0, §1.1, §1.2, §2, S-22, S-25, S-30, S-40, S-41, S-42, S-44, S-47, S-48, S-50, S-60, S-61, S-63, §9, §10, NF-5), each with an *(Amended, C-n)* note, by the REVIEW-2 pass below (R2-1). Where a body text and an entry above differ, the body, with C-53 onward, governs.

### Amendments for REVIEW-2 (design agent, 2026-10-28)

These answer `REVIEW-2.md` (verdict REVISE-SPEC). Item numbers (R2-n, L-n, OVTC-n, Probe x) are that file's. No requirement id was removed, renumbered or reused, and no requirement was weakened. Each is applied in the body as well. None changes a `DESIGN.md` §2 signature; `DESIGN.md` §7 lists the behaviour changes.

- **C-53 · C-44, §1.2, S-44. Expiry before mismatch: the description is corrected.** *(R2-2.)* "Only the code reported differs" was false. `challengeExpired` is `retryable: true` and `challengeMismatch` is `retryable: false` (task `spec.md:55-60`), so a document both expired and mismatched gets a retryable refusal and the runtime **releases** its replay record (`rt/consume.ts:533-535`; an identical resend re-executes and gets `challengeNotFound`), where a plain mismatch has its refusal **retained**. Harmless: the challenge is burned either way, and any retry needs a new challenge. No behaviour change.
- **C-54 · C-46, S-40, §1.2, §9 item 4, NF-5. The rate-limit DoS needs only the `app_id`.** *(R2-3.)* The limiter runs before the key check (S-40 steps 2–3), so a request with the right `app_id` and a wrong `app_key` spends the budget. The text said "anyone holding an app's public `APP_KEY`". **Marker:** the rate-limiter `// SPIKE:` line must also contain `app_id` and must not contain `APP_KEY` (for example `… anyone who knows an app_id can spend its budget, even with a wrong key …`). **Oracle:** 120 wrong-key requests for an app, then one right-key request in the same window → 429. The S-40 order is unchanged.
- **C-55 · S-25, S-41 (C-43), §1.2, NF-5. The `date-time` rule is fully specified.** *(R2-4; Probe A; OVTC-52.)* The rule in S-25 now range-checks the day against the month (with leap years), hour 00–23, minute 00–59, second 00–59, and offset hours 00–23 and minutes 00–59. It applies to `format: "date-time"` and to envelope `issuedAt`/`expiresAt` alike. **Leap seconds are refused** (`ss = 60`), a recorded deviation from RFC 3339 §5.6 marked `// SPIKE:` with the phrase `leap second`, because the runtime's `Date.parse` rejects them anyway with a false message; refusing them in the shape check gives an accurate 400. Before this, `T24:00:00Z`, `2031-02-31` and `2031-04-31` completed a sign-in at a different instant. The oracles are in S-25 and S-41.
- **C-56 · S-22, S-42, S-48, §9 item 4. The boundary millisecond and the `requireIssuedAt` dependence are recorded as known behaviour.** *(R2-7; L-30; Probes D, E; OVTC-50, -51.)* Not fixed. At exactly `issuedAt + window + skew` (and at the cap, `now + window + 2·skew`) the replay record is treated as expired while freshness still accepts, so an identical resend re-runs the handler. The single-use challenge is the mitigation: the re-run gets `challengeNotFound`, and no second session is minted. The retention cap is sound only while `authenticateChecks` keeps `requireIssuedAt: true`. **Oracle:** in S-48, pinning both the edge and the mitigation.
- **C-57 · S-40. The rate limiter's memory is bounded.** *(R2-5; N-3; Probe B.)* The N-3 eviction left the map unbounded within a window and made each new id scan the whole map. The limiter now holds at most `MAX_BUCKETS` (10 000) buckets, evicts the oldest by insertion order when a new id arrives at the cap, re-inserts a bucket whose window has closed, and does no full scan. **Oracle** in S-40.
- **C-58 · S-25 (C-41). Schema positions and keyword values are type-checked; the throw message is fixed.** *(R2-6, R2-8.)* `assertSchemaSupported` throws on a non-object, non-boolean single sub-schema (including array-form `items`), a map that is not an object of objects/booleans, and a wrong-typed value for `type`, `required`, `minLength`, `maxLength`, `minItems`, `minProperties`, `minimum`, `pattern`, `format` or `$ref`. Before this, `{items:[…]}` validated `[]` as `true` and `required:"a"` threw a `TypeError` whose text reached the wire (OVTC-47). An unsupported-keyword throw's message contains `unsupported schema keyword "<k>"`. **Oracles** in S-25. Not reachable with the pinned schemas.
- **C-59 · S-22 (C-40). A twice-failed `recordResponse` is logged.** *(R2-9.)* Before throwing, `recordResponse` calls `deps.log?.('replay.record_failed', {failure})`, with `failure` = `"HTTP <status>"` or `"fetch rejected"` (no id, no digest; a throwing log sink is swallowed and the method still throws its own error). **Oracle:** P9 fails twice → `log` is called exactly once with `replay.record_failed`, and the detail contains neither the document id nor the digest; the first answer is still 200, and an identical resend gets 202 (unchanged from C-40).

Not changed by this pass, each with the reason, is in `REVIEW-2.md` § *D response*.
