# Spike: OpenVTC wallet sign-in for Community Cloud neighbor accounts

> **SUPERSEDED 2026-10-18.** This v1 spec (wallet sign-in via rp-sdk `auth/oob/*`) is retained as the plan for **Increment 3** in `SPIKE-SPEC.md`. Do not implement it first. See `SPIKE-SPEC.md` §0 for why.

**Status:** spike / experiment. Not intended for merge upstream without a separate proposal.
**Repo:** fork of `relational-builder` (Josh Nesbit / Relational Tech Project).
**Author of spec:** Kevin Triplett, 2026-10-17. Specs derived from reading `app-data/index.ts` (commit 2026-10-14), `supabase/migrations/20260702060000_neighbor_accounts.sql`, `src/integrations/catalog.ts`, and `@openvtc/rp-sdk` 0.3.1 source (`src/oob/service.ts`, `test/oob/helpers.ts`, commit 70a8240 2026-10-15).

This document is written for an LLM coding assistant. Every numbered requirement (`S-nn`) is phrased so a second LLM can turn it into a test case without reading the codebase. Where a requirement names a function, file, table, or constant, that name is binding.

---

## 0. Why this spike, in one paragraph

Community Cloud (the `app-data` Supabase edge function) gives LLM-generated community tools a zero-setup JSON document store plus "neighbor accounts": email → 6-digit code → opaque 30-day `member_token`. This spike adds a **second** way to obtain exactly the same `member_token`: the member scans a QR / taps a trigger link, approves in an OpenVTC-compatible wallet, and their VTA signs a grant. The spike's purpose is to learn what adopting the OpenVTC protocol surface actually costs in a real codebase. It must not change the email path's behavior in any way.

## 1. Scope

### 1.1 In scope

1. A new Supabase edge function `supabase/functions/app-signin/index.ts` implementing the server side of the OpenVTC `auth/oob/*` sign-in protocol via `@openvtc/rp-sdk`'s `OobSignInService`, returning a Community Cloud `member_token` on success.
2. A Postgres-backed `OobRequestStore` implementation (the SDK ships only an in-memory store).
3. Schema migration: `app_members` gains a nullable `did` column; `email` becomes nullable; new tables `app_oob_requests` and `app_oob_seen_ids`.
4. `app-data` changes limited to: `resolveMember` selects and returns `did`; member stamping tolerates `email = null`.
5. Prompt guidance: a new `WALLET_SIGNIN_GUIDANCE` block in `src/integrations/catalog.ts`, emitted only when the app's Community Cloud backend has wallet sign-in enabled.
6. A minimal static demo page (`public/spike/wallet-signin.html`) using `@openvtc/rp-sdk/browser` to exercise the flow by hand against a real wallet.
7. A vitest harness (the repo has none today) that tests the edge function's pure core under Node.

### 1.2 Out of scope (explicitly)

- Builder/steward sign-in (Supabase Auth) — untouched.
- Per-app service DIDs. The spike uses **one** service DID for the whole Community Cloud.
- `did:webvh` for the service identity. The spike uses **`did:web`** (static `/.well-known/did.json`). Rationale: `did:key` is refused by `buildTriggerLink` (VTI-LNK-102); `did:webvh` requires a VTA + log hosting + witnesses, which is the cost we want to measure *later*, not now.
- Holding the service key in a VTA. The spike holds a raw Ed25519 private key in a Supabase secret. **This is a spike-grade shortcut and must be labeled as such in code comments.**
- Membership gating (`isActiveMember`). The spike returns `true` for every syntactically valid DID (open enrollment), because Community Cloud tools are public-by-design. See S-40.
- Session-key (`K_b`) bound trust tasks after sign-in. Generated apps keep using bearer `member_token`.
- The VTI-LNK-082 portal hardening requirements (no third-party scripts, `frame-ancestors 'none'`). Generated apps load from esm.sh and the Builder previews them in an iframe; both violate VTI-LNK-082. The spike **records** this as a protocol-compliance gap and does not fix it. See §8.
- Legacy SIOPv2 `verifyIdToken` path (deprecated upstream).

## 2. Architecture

```
Generated app (static, any origin)
  │  @openvtc/rp-sdk/browser createSignIn({ endpoint, serviceDid, ... })
  │  POST <COMMUNITY_CLOUD_URL minus "app-data" plus "app-signin">
  │       body: { app_id, app_key, document: <OobDocument> }
  ▼
app-signin edge function (Deno)
  ├─ validate app_id/app_key against cloud_apps   (same as app-data)
  ├─ OobSignInService.handle(document, conn)     (@openvtc/rp-sdk via npm: specifier)
  │     store    = PostgrestOobRequestStore       (app_oob_requests, app_oob_seen_ids)
  │     resolver = DidKeyDocumentResolver(WebvhOrWebResolver)  (see S-31)
  │     signer   = Ed25519 key from secret SIGNIN_SERVICE_KEY
  │     redeemExt→ mint member_token (app_members upsert by did, app_sessions insert)
  └─ respond { status, body }  where body.ext["org.relationalbuilder.cloud"] = { member_token, member }
```

Wallet side is unchanged upstream software (VTA browser plugin / Keyring); the spike does not modify it.

### 2.1 Why a sibling function rather than extending `app-data`

`app-data` is ~950 lines with no module boundaries; Supabase edge functions in this repo share no code (there is no `_shared/`). A sibling keeps the diff reviewable, matches the existing `app-capabilities` precedent, and lets the generated-app snippet derive the URL with the same `.replace(/app-data$/, "app-signin")` idiom already used for capabilities. The ~20 lines of app-key validation are duplicated knowingly.

### 2.2 File layout (binding)

```
supabase/functions/app-signin/
  index.ts        Deno.serve glue only: parse request, call core, write response. ≤ 60 lines.
  core.ts         Pure, dependency-injected handler. No Deno globals. Tested under Node.
  store.ts        PostgrestOobRequestStore (implements OobRequestStore over PostgREST fetch).
  resolver.ts     DID document resolver(s) for member DIDs.
  signer.ts       Ed25519 EddsaJcsSigner from a base64url seed.
  members.ts      upsertMemberByDid, mintMemberToken (PostgREST).
supabase/migrations/2026MMDD000000_wallet_signin.sql
src/integrations/catalog.ts                    (+ WALLET_SIGNIN_GUIDANCE, + key names)
src/cloud/community-cloud.ts                   (+ setVar for WALLET_SIGNIN_URL, SERVICE_DID)
public/spike/wallet-signin.html                 demo page
public/.well-known/did.json                     service DID document (did:web)
tests/app-signin/*.test.ts                      vitest
vitest.config.ts, package.json (devDeps: vitest, @openvtc/rp-sdk)
docs/spikes/openvtc-signin/FINDINGS.md          filled in at the end (see §9)
```

`core.ts`, `store.ts`, `resolver.ts`, `signer.ts`, `members.ts` must import nothing Deno-specific. All I/O goes through an injected `fetch`-compatible function and an injected `now(): Date`. `index.ts` is the only file that touches `Deno.env`, `Deno.serve`.

## 3. Data model

### S-10 Migration is additive and idempotent

Migration `wallet_signin.sql` must be re-runnable (`if not exists` / `if exists` guards everywhere) and must:

- `alter table public.app_members alter column email drop not null;`
- `alter table public.app_members add column if not exists did text;`
- `create unique index if not exists app_members_app_did_idx on public.app_members (app_id, did) where did is not null;`
- `alter table public.app_members add constraint app_members_identity_chk check (email is not null or did is not null);` (guarded with a `do $$ ... if not exists ... $$` block).
- Create `public.app_oob_requests (request_id text primary key, app_id uuid not null references public.cloud_apps(id) on delete cascade, version integer not null, state text not null, record jsonb not null, claim_deadline timestamptz not null, updated_at timestamptz not null default now())`.
- Create `public.app_oob_seen_ids (doc_id text primary key, until_at timestamptz not null)`.
- Enable RLS on both new tables with **no** policies (service-role only, matching `app_sessions`).
- Index `app_oob_requests (app_id, claim_deadline)`.

**Test oracle:** apply migration twice against a scratch Postgres; second run is a no-op with no error. Existing `app_members` rows (all have `email`) remain valid. Inserting `(app_id, did=null, email=null)` fails the check constraint. Inserting two rows with the same `(app_id, did)` fails; two rows with `did=null` succeed.

### S-11 `record` is the source of truth

`app_oob_requests.record` holds the full `OobRequestRecord` JSON exactly as the SDK produced it. `version`, `state`, `claim_deadline` are **denormalized copies** used only for the compare-and-set predicate and cleanup. The store must never reconstruct a record from columns; it returns `record` as-is.

## 4. PostgrestOobRequestStore (`store.ts`)

Implements `OobRequestStore` from `@openvtc/rp-sdk`:

```ts
interface OobRequestStore {
  create(record: OobRequestRecord): Promise<void>;
  get(requestId: string): Promise<OobRequestRecord | undefined>;
  compareAndSet(requestId: string, expectedVersion: number, next: OobRequestRecord): Promise<boolean>;
  rememberDocumentId(id: string, untilMs: number): Promise<boolean>;
}
```

Constructor: `new PostgrestOobRequestStore({ restUrl: (path) => string, headers: () => Record<string,string>, fetch: typeof fetch, appId: string, now?: () => Date })`.

### S-20 `create` inserts or throws on duplicate

`create(record)` POSTs one row. If PostgREST returns 409 (unique violation on `request_id`), `create` **throws** an `Error` whose message contains `"duplicate requestId"` (mirrors `MemoryOobRequestStore`). Any other non-2xx throws with the status in the message.

### S-21 `get` returns the stored record or `undefined`

`get(id)` returns `record` for a row with matching `request_id` **and** matching `appId`; returns `undefined` when no row. Rows belonging to a different `app_id` are invisible (return `undefined`).

### S-22 `compareAndSet` is atomic on `version`

`compareAndSet(id, expectedVersion, next)` issues a single `PATCH /app_oob_requests?request_id=eq.<id>&app_id=eq.<appId>&version=eq.<expectedVersion>` with `Prefer: return=representation`, body `{version: next.version, state: next.state, record: next, claim_deadline: <from next>, updated_at: now}`. Returns `true` iff exactly one row was returned. Returns `false` (and changes nothing) when zero rows match. It must never read-then-write; the version predicate lives in the URL.

**Test oracle:** two concurrent `compareAndSet(id, 1, …)` calls against the same row — exactly one returns `true`. (Test with a fake PostgREST that honors the `version=eq.` filter and serializes requests.)

### S-23 `rememberDocumentId` is insert-or-reject

`rememberDocumentId(docId, untilMs)` POSTs `{doc_id, until_at}`. Returns `true` on 201; returns `false` on 409 (already seen). Before inserting, it may opportunistically `DELETE /app_oob_seen_ids?until_at=lt.<now>`; failure of that delete must not affect the return value.

**Test oracle:** second call with the same id returns `false`. After `now` advances past `until_at` and the row is purged, the same id returns `true` again.

### S-24 Expired-request sweep

The store exposes `sweepExpired(): Promise<void>` that `DELETE`s `app_oob_requests` where `claim_deadline < now - 1 hour` and `state in (consumed, declined, cancelled, expired)` **or** `claim_deadline < now - 24 hours` regardless of state. `core.ts` calls it on every `auth/oob/request` (fire-and-forget; errors logged, not surfaced). Rationale: no cron in the spike.

## 5. Resolver (`resolver.ts`)

### S-30 `did:key` resolves in-process

The resolver chain starts with `DidKeyDocumentResolver` from rp-sdk, so Ed25519 `did:key` members resolve with no network. This is what tests use.

### S-31 `did:web` and `did:webvh` resolve over HTTPS with a cache

A fallback resolver handles `did:web` (fetch `https://<host>/.well-known/did.json` or path form per the did:web spec) and `did:webvh` (fetch `did.jsonl`, take the **last** entry's `state` as the document — the spike does **not** verify the webvh hash chain; label this in a comment as a known gap). Documents are cached in a `Map` keyed by DID for 10 minutes using injected `now`. Any method other than these three throws `Error("no resolver for <method>")`.

### S-32 Resolver network policy

Resolution refuses hosts that are `localhost`, `*.localhost`, `*.local`, `*.internal`, IP literals in private/loopback ranges, and any non-`https:` scheme, unless constructed with `{ allowInsecure: true }` (dev only; never set in `index.ts` from a hardcoded value — only from env `SIGNIN_ALLOW_INSECURE=1`). Refusal throws before any fetch. (Mirrors `vti-didcomm-js` net-guard.)

## 6. Signer (`signer.ts`)

### S-35 Ed25519 EddsaJcsSigner from seed

`signerFromSeed(seedB64url: string, verificationMethod: string): EddsaJcsSigner` decodes a 32-byte seed, derives the Ed25519 keypair with `@noble/curves/ed25519`, and returns `{ verificationMethod, sign(input) → 64-byte signature }`. A seed that does not decode to exactly 32 bytes throws. The function also exposes `publicKeyMultibase` so an operator script can emit the `did.json`.

### S-36 Service DID document is consistent with the signer

A script `scripts/spike/make-service-did.mjs` prints a `did:web` document for `SIGNIN_SERVICE_DOMAIN` with one Multikey verification method `#key-1` listed under both `authentication` and `assertionMethod`, and services `SignInPortal` (origin) and `TrustTaskHTTPS` (`<function base url>`). **Test:** the document produced for a seed, fed to the resolver, lets `verifyOobDocument` verify a document signed with `signerFromSeed(seed, "<did>#key-1")`.

## 7. Core handler (`core.ts`)

Signature:

```ts
export interface CoreDeps {
  fetch: typeof fetch;
  now: () => Date;
  restUrl: (path: string) => string;
  svcHeaders: () => Record<string, string>;
  serviceDid: string;
  serviceName: string;      // "Community Cloud" unless env overrides
  portalOrigin: string;     // the origin generated apps are served from, see S-45
  signer: EddsaJcsSigner;
  resolver: DidDocumentResolver;
  redeemHoldMs?: number;    // default 4000 (see S-44)
}
export interface CoreRequest { app_id?: unknown; app_key?: unknown; document?: unknown; }
export interface CoreConn { ip?: string; userAgent?: string; signal?: AbortSignal; }
export async function handleSignIn(deps: CoreDeps, body: CoreRequest, conn: CoreConn): Promise<{ status: number; body: unknown }>;
```

### S-40 App authentication precedes everything

If `app_id` or `app_key` is missing → `401 {error:"app_id and app_key required"}`. If `cloud_apps` has no row with that id, or `app_key` mismatches → `403 {error:"Unknown app or wrong key"}`. If the matching `cloud_apps` row has `wallet_signin_enabled = false` (new boolean column, default `false`, added in the migration) → `403 {error:"Wallet sign-in is not enabled for this app"}`. Only after these checks is `document` examined. (This is the Community Cloud trust boundary; the OobSignInService never sees a document for an unknown app.)

### S-41 Documents route to the SDK unchanged

A valid app with any `document` → `OobSignInService.handle(document, conn)` is called exactly once with the document **unmodified** and `conn = { ip, browser, os, location:"unknown", signal }` where `browser`/`os` are parsed from `userAgent` by a tiny deterministic parser (`"Chrome" | "Firefox" | "Safari" | "Other"`, `"iOS" | "Android" | "macOS" | "Windows" | "Linux" | "Other"`). The handler returns `{ status: result.status, body: result.body }` for every result that has no `session`.

**Test oracle:** feed a malformed `document` (e.g. `{}`) → status is whatever the SDK returns (a `trust-task-error` with `malformedRequest`), and `handleSignIn` must not throw.

### S-42 Service construction per app

One `OobSignInService` is constructed **per `(app_id)`** with: `serviceDid`, `serviceName` = the `cloud_apps.name` (so the wallet shows the tool's name, not "Community Cloud"), `origin = deps.portalOrigin`, `store = new PostgrestOobRequestStore({... appId})`, `resolver`, `responseSigner = signer`, `isActiveMember: async () => true`, `displayName` per S-46, `redeemHoldMs`, `now`. Services may be memoized in a module-level `Map<appId, OobSignInService>` within one isolate; correctness must not depend on memoization (store is the truth).

### S-43 Redeem success mints a Community Cloud session

`redeemExt(session)` is implemented so that when the SDK's `handle` returns `result.session` (a successful `auth/oob/redeem`), the core:

1. Upserts `app_members` by `(app_id, did = session.subject)`; on insert sets `name = session.displayName` unless `displayName === session.subject` (a bare DID is not a name → `name = null`); on existing row leaves `name` unchanged. `email` stays `null` for DID-created members.
2. Inserts `app_sessions` with a 64-hex-char token generated exactly as `authVerify` does (`crypto.randomUUID()` ×2, dashes stripped), `expires_at = now + min(30 days, session.notAfter - now)`.
3. Returns `{ "org.relationalbuilder.cloud": { member_token, member: { id, did, name, email: null } } }` as the `ext` of the redeem response.

The response body is the SDK's redeem `#response` document with that `ext` merged in (the SDK does the merge; the core only supplies `redeemExt`).

**Test oracle:** drive request→claim→prove→grant(approve)→redeem with the rp-sdk test wallet helpers against `handleSignIn` using `MemoryOobRequestStore` substituted for the Postgrest store **and** a fake PostgREST for `app_members`/`app_sessions`. Assert: one `app_members` row with the member's DID; one `app_sessions` row whose token equals the token in `ext`; `expires_at ≤ now + 30d`. A second full sign-in by the same DID yields a **second** session row and **no** second member row.

### S-44 Redeem hold is short and poll-safe

`redeemHoldMs` defaults to **4000** (the SDK default is 25 000). Rationale: Supabase edge-function isolates do not share the SDK's in-memory `waiters`; a long hold wastes wall-clock and the browser SDK already re-polls. The hold value is injectable so tests use `0`.

### S-45 Portal origin and `K_b` origin binding

The SDK's `verifyOobGrant` binds the grant to `origin`. Because generated apps are served from many origins (preview blob URLs, `*.vercel.app`, community hosting, custom domains), the spike sets `portalOrigin` from the **request's `Origin` header** when, and only when, that origin appears in a per-app allowlist `cloud_apps.wallet_signin_origins text[]` (new column). An `Origin` not in the list → `403 {error:"Origin not allowed for wallet sign-in"}` before the SDK is called. Empty list = refuse all. This is the spike's substitute for a fixed `SignInPortal` service; it must be called out in FINDINGS.md as a divergence from the VTI design (which assumes one portal origin per service DID).

### S-46 Display name

`displayName(did)` returns the existing `app_members.name` for `(app_id, did)` if a row exists, else `undefined` (SDK then shows the DID).

### S-47 Rate limiting

Per `app_id`, at most 120 documents per minute (same constant and same in-memory bucket approach as `app-data`). Over limit → `429 {error:"Rate limit exceeded — try again in a minute"}` without touching the SDK or the store.

### S-48 CORS and method

`OPTIONS` → 204 with the same CORS headers `app-data` uses (`Access-Control-Allow-Origin: *`, methods `POST, OPTIONS`, headers `Content-Type, Authorization`). Non-`POST` → 405. Non-JSON body → `400 {error:"Invalid JSON"}`. `Cache-Control: no-store` on every response.

### S-49 Nothing here touches email

`core.ts` has no code path that sends email, reads `RESEND_API_KEY`, or references `app_login_codes`. (Grep-testable.)

## 8. Browser side and generated-app guidance

### S-50 Demo page

`public/spike/wallet-signin.html` is a single static page that: reads `app_id`, `app_key`, `service_did`, `endpoint` from query string; imports `createSignIn, isEd25519Available` from `@openvtc/rp-sdk/browser` (via esm.sh, pinned to `0.3.1`); shows a "Sign in with wallet" button disabled with an explanatory message when `isEd25519Available()` is false; on click calls `start()`; renders each `onStateChange` state as text; on `signedIn` extracts `state.ext["org.relationalbuilder.cloud"].member_token`, stores it in `localStorage.member_token`, and calls `app-data` `auth_me` to display the member. The page is served with `Referrer-Policy: no-referrer` and `Cache-Control: no-store` via `vercel.json` headers for the `/spike/*` path.

The `endpoint` passed to `createSignIn` is the `app-signin` function URL. Because `createSignIn` POSTs the bare document and `app-signin` expects `{app_id, app_key, document}`, the page passes a custom `fetch` wrapper if the SDK's `createSignIn` exposes one; **if it does not** (check `src/browser/*.ts` in 0.3.1), the core must *also* accept a bare document and read `app_id`/`app_key` from query parameters `?app_id=&app_key=` on the function URL. Which path was needed goes into FINDINGS.md. (**Design agent: resolve this before implementation and record the decision.**)

### S-51 Prompt guidance

`WALLET_SIGNIN_GUIDANCE: string[]` in `catalog.ts` is appended to the system prompt only when the project's env has `WALLET_SIGNIN_URL` and `SERVICE_DID` set (new keys, `WALLET_SIGNIN_KEYS = ['WALLET_SIGNIN_URL','SERVICE_DID']`). It instructs the model to: offer "Sign in with wallet" **alongside** email-code sign-in, never instead of it; use `createSignIn` from `@openvtc/rp-sdk/browser`; treat `ext["org.relationalbuilder.cloud"].member_token` identically to the token from `auth_verify`; hide the button when `isEd25519Available()` is false. It must not describe VTAs, DIDs, or credentials to the end user beyond the phrase "sign in with your wallet app".

**Test oracle:** `buildSystemPrompt` (or whatever function assembles guidance) includes `WALLET_SIGNIN_GUIDANCE` iff both keys are set; the existing `COMMUNITY_CLOUD_GUIDANCE` is byte-identical before and after this change.

### S-52 Email path is byte-identical

A snapshot test of `app-data/index.ts`'s `authRequest`, `authVerify`, and the `auth_*` dispatch block shows **no diff** against the base commit except: the `select=` lists in `resolveMember` and `authVerify`'s member read gain `,did`, and the returned `member` objects gain a `did` field (which is `null` for email members).

## 9. Findings document (deliverable of the spike)

`docs/spikes/openvtc-signin/FINDINGS.md` must be written last and answer, with evidence (file paths, line counts, test names, timings):

1. Lines of code added, by file; lines changed in `app-data`.
2. Which rp-sdk APIs were sufficient as documented, which needed source reading, which were missing (e.g., a `fetch` seam in `createSignIn`).
3. Every protocol-compliance deviation taken (did:web instead of did:webvh; raw key instead of VTA; open enrollment; VTI-LNK-082; multi-origin portal; unverified webvh chain) and what closing each one would require.
4. What a real wallet did when pointed at the demo page (which wallet, version, outcome, screenshots if any). If no wallet was available, say so.
5. Supabase-specific friction: npm specifiers in Deno, cold-start time with `@noble/*`, isolate statelessness vs the SDK's waiters.
6. A revised difficulty estimate for Tier A (neighbor sign-in), Tier B (builder sign-in), Tier C (studios as VTCs), each with the one fact learned here that most changed the estimate.

## 10. Non-functional requirements

- **NF-1** `tsc --noEmit` passes for `supabase/functions/app-signin/*.ts` under a `tsconfig.functions.json` targeting ES2022 + DOM + `"types": []`, with `npm:` imports mapped via `paths` to the installed package for type-checking.
- **NF-2** All new tests run with `npx vitest run` in under 60 s with no network access.
- **NF-3** No new runtime dependency in `package.json` other than `@openvtc/rp-sdk` (dev, for tests and types). The edge function imports `npm:@openvtc/rp-sdk@0.3.1` directly.
- **NF-4** No secret, seed, or key appears in any committed file. `.env.example` gains `SIGNIN_SERVICE_SEED=`, `SIGNIN_SERVICE_DOMAIN=`, `SIGNIN_ALLOW_INSECURE=` with comments.
- **NF-5** Every spike-grade shortcut is marked in code with the literal comment prefix `// SPIKE:` so a reviewer can grep for them.

## 11. Test strategy (for the test-writing agent)

Tests live in `tests/app-signin/`. Use vitest. Import `core.ts`, `store.ts`, `resolver.ts`, `signer.ts`, `members.ts` directly (they are Deno-free by S-2.2). Use rp-sdk's **published** test helpers only if they are exported from the package; otherwise copy `test/oob/helpers.ts` from the rp-sdk repo (Apache-2.0) into `tests/app-signin/rp-helpers.ts` with attribution, and use `didKey()`, `makeDid()`, `requestDoc/claimDoc/identifyDoc/proveDoc/grantDoc/redeemDoc`, `MapResolver`.

Provide a **fake PostgREST** (`tests/app-signin/fake-postgrest.ts`): an in-memory table map that understands the subset of PostgREST this code uses — `select=`, `eq.`, `lt.`, `in.(...)`, `is.null`, `order=`, `limit=`, `Prefer: return=representation`, 409 on unique violations for `app_oob_requests.request_id`, `app_oob_seen_ids.doc_id`, and `(app_id, did)` on `app_members`. Expose it as a `fetch`-compatible function. The fake must reject any URL path it does not model (throw), so unmodeled PostgREST usage fails loudly.

Minimum test files and what each covers:

| File | Requirements |
|---|---|
| `migration.test.ts` | S-10 (uses a real Postgres via `pg-mem` or `embedded-postgres` if available; otherwise parses the SQL for required statements and marks the behavioral assertions `todo`) |
| `store.test.ts` | S-20…S-24 against fake PostgREST; concurrency case for S-22 |
| `resolver.test.ts` | S-30…S-32 including every refused host class |
| `signer.test.ts` | S-35, S-36 round trip through rp-sdk `verifyOobDocument` |
| `core.auth.test.ts` | S-40, S-45, S-47, S-48, S-49 |
| `core.flow.test.ts` | S-41, S-42, S-43, S-44, S-46 — full happy path, decline path, expired-claim path, replayed-document path, second sign-in by same DID, sign-in by a DID from another app's store (must be invisible per S-21) |
| `catalog.test.ts` | S-51 |
| `app-data.snapshot.test.ts` | S-52 (string-level assertion against the base commit's file, fetched via `git show <base>:supabase/functions/app-data/index.ts`) |

Each test name must cite its requirement id, e.g. `it("S-22 compareAndSet: concurrent writers — exactly one wins")`.
