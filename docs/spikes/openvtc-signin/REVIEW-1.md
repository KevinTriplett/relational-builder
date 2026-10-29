# REVIEW-1 — Trust Tasks sign-in spike, Increment 1 (Phase 4, agent R)

Reviewed 2026-10-28 on branch `spike/openvtc-signin` at `f4b1cc0`. BASE_SHA is `6b68ea634f37a70e3a5ef3146d74a02072eda094`. Inputs: `SPIKE-SPEC.md` (with Changelog C-1 to C-36), `DESIGN.md`, `IMPL-NOTES.md`, `TEST-DISPUTE.md`, `SWARM-PLAN.md` §3, `tests/app-trust-tasks/**` and `COVERAGE.md`, the pinned library source, `.spike-deps/dtgwg-trust-tasks-tf/` and `.spike-deps/dtgwg-vti-spec/spec/07-clients.md`.

Path shorthands: `fn/` = `supabase/functions/app-trust-tasks/`, `rt/` = `node_modules/@openvtc/trust-tasks/src/_runtime/`, `pf/` = `node_modules/@openvtc/trust-tasks-proof/dist/`, `up/` = `.spike-deps/dtgwg-trust-tasks-tf/`, `helper` = `src/kit/files/lib/trust-signin.ts`.

**Probes.** I ran one Deno script (`deno run -A --no-config`) and one schema walker. Both lived in the session scratchpad, outside the repo, and both have been deleted. The script drove `fn/core.ts`'s `handleTrustTask` through the test suite's `fake-postgrest.ts`, using the pinned `npm:` packages. Results are quoted below as **Probe A–K**.

---

## 1. Mechanical checks

### `npx vitest run`

```text
 RUN  v5.0.5 /Users/kevintriplett/Documents/Documents - Kevin’s MacBook Pro/BACKUP/PROJECTS/SOFTWARE/relational-builder

 Test Files  13 passed (13)
      Tests  181 passed | 6 todo (187)
   Start at  18:11:39
   Duration  921ms (import 86%, tests 9%, transform 4%, setup 1%)

exit 0
```

### `tsc --noEmit -p tsconfig.functions.json`

```text
exit 0
```

### `grep -rn "// SPIKE:" supabase/functions/app-trust-tasks/ src/kit/files/lib/trust-signin.ts`

```text
supabase/functions/app-trust-tasks/replay.ts:7:// SPIKE: app-scoped Postgres guard so a different app can never run this app's
supabase/functions/app-trust-tasks/replay.ts:17:// SPIKE: retention pad — the runtime's recordExpiry stops skewMs before freshness does
supabase/functions/app-trust-tasks/core.ts:5:// SPIKE: unsigned responses; local_vid is a label
supabase/functions/app-trust-tasks/core.ts:80:// SPIKE: in-isolate rate limiter — per Supabase isolate, not global (same as app-data).
supabase/functions/app-trust-tasks/core.ts:349:  // SPIKE: consume-before-compare — the single atomic PATCH burns the challenge even on a
supabase/functions/app-trust-tasks/core.ts:387:  // SPIKE: the auth/authenticate/0.3 #response is unsigned (spec requires a proof; recorded deviation, §1.2 / C-1).
supabase/functions/app-trust-tasks/core.ts:559:// SPIKE: a hand-written draft-2020-12 subset validator (the 20 keywords above, no json-schema
supabase/functions/app-trust-tasks/index.ts:27:  // SPIKE: OPTIONS answers the CORS preflight (204); binding 0.2 §2 item 1 says 405.
src/kit/files/lib/trust-signin.ts:188:    // SPIKE: software custody — the 32-byte seed is stored as plain bytes in IndexedDB, readable
exit 0
```

The NF-5 / C-34 minimums are met: `core.ts` has 5, including the exact S-30 line; `replay.ts` has 2; `index.ts` has 1; the helper has 1. Each marker sits at the shortcut NF-5 names. One marker is mislabelled: `replay.ts:7` marks app scoping, which is hardening, not a shortcut (nit N-6). Several deviations have **no** marker; see §4.

### `grep -rn "Deno\." supabase/functions/app-trust-tasks/{core,challenges,replay,members,status}.ts`

```text
exit 1   (no matches)
```

### `git diff 6b68ea6… --stat`

```text
 .claude/settings.local.json                        |   8 +-
 .env.example                                       |   5 +
 .gitignore                                         |   3 +
 docs/spikes/openvtc-signin/BASE_SHA                |  34 ++
 docs/spikes/openvtc-signin/BRIEF-I.md              |  82 +++
 docs/spikes/openvtc-signin/DESIGN.md               | 331 +++++++++++
 docs/spikes/openvtc-signin/IMPL-NOTES.md           | 430 ++++++++++++++
 docs/spikes/openvtc-signin/OPENVTC-FEEDBACK.md     | 254 ++++++++
 .../openvtc-signin/SPIKE-SPEC-v1-oob-deferred.md   | 298 ++++++++++
 docs/spikes/openvtc-signin/SPIKE-SPEC.md           | 587 +++++++++++++++++++
 docs/spikes/openvtc-signin/SWARM-PLAN.md           | 166 ++++++
 docs/spikes/openvtc-signin/TEST-DISPUTE.md         |  39 ++
 docs/spikes/openvtc-signin/WEB2-DEVELOPER-GUIDE.md | 229 ++++++++
 docs/spikes/openvtc-signin/notes.md                |  42 ++
 eslint.config.js                                   |   2 +-
 package-lock.json                                  | 373 +++++++++++-
 package.json                                       |   7 +-
 src/cloud/community-cloud.ts                       |  22 +
 src/components/Chat/ChatPanel.tsx                  |   3 +
 src/integrations/catalog.ts                        |  27 +
 src/kit/files/lib/trust-signin.ts                  | 341 +++++++++++
 src/kit/index.ts                                   |   3 +
 src/preview/bundler/versions.ts                    |   3 +
 supabase/functions/app-data/index.ts               |   9 +-
 supabase/functions/app-trust-tasks/challenges.ts   | 130 +++++
 supabase/functions/app-trust-tasks/core.ts         | 636 +++++++++++++++++++++
 supabase/functions/app-trust-tasks/index.ts        |  48 ++
 supabase/functions/app-trust-tasks/members.ts      |  74 +++
 supabase/functions/app-trust-tasks/replay.ts       | 170 ++++++
 supabase/functions/app-trust-tasks/status.ts       |  88 +++
 .../20261027090000_trust_tasks_signin.sql          |  47 ++
 tests/app-trust-tasks/COVERAGE.md                  |  70 +++
 tests/app-trust-tasks/app-data.snapshot.test.ts    |  56 ++
 tests/app-trust-tasks/catalog.test.ts              |  93 +++
 tests/app-trust-tasks/challenges.test.ts           | 226 ++++++++
 tests/app-trust-tasks/core.auth.test.ts            | 398 +++++++++++++
 tests/app-trust-tasks/core.authenticate.test.ts    | 578 +++++++++++++++++++
 tests/app-trust-tasks/core.challenge.test.ts       | 167 ++++++
 tests/app-trust-tasks/fake-postgrest.test.ts       |  63 ++
 tests/app-trust-tasks/fake-postgrest.ts            | 383 +++++++++++++
 tests/app-trust-tasks/helpers.ts                   | 189 ++++++
 tests/app-trust-tasks/kit.test.ts                  |  39 ++
 tests/app-trust-tasks/migration.test.ts            | 154 +++++
 tests/app-trust-tasks/nonfunctional.test.ts        |  62 ++
 .../producer-helper.fixture.test.ts                | 298 ++++++++++
 tests/app-trust-tasks/producer.ts                  | 116 ++++
 tests/app-trust-tasks/replay.test.ts               | 216 +++++++
 tests/app-trust-tasks/schema.test.ts               | 147 +++++
 tests/setup.ts                                     |  17 +
 tests/tsconfig.json                                |  32 ++
 tsconfig.functions.json                            |  32 ++
 vitest.config.ts                                   |  32 ++
 52 files changed, 7837 insertions(+), 22 deletions(-)
```

This diff compares the base against the working tree, so it includes the owner's uncommitted edits to `.claude/settings.local.json`, `notes.md` and `SWARM-PLAN.md`. None of those are implementation.

### `git diff 6b68ea6… -- supabase/functions/app-data/index.ts`

```diff
@@ -335,8 +335,9 @@ Deno.serve(async (req: Request) => {
 interface Member {
   id: string;
-  email: string;
+  email: string | null;
   name: string | null;
+  did: string | null;
 }
@@ -356,7 +357,7 @@ async function resolveMember(appId: string, tokenRaw: unknown): Promise<Member |
-    restUrl(`/app_members?id=eq.${sessions[0].member_id}&select=id,email,name`),
+    restUrl(`/app_members?id=eq.${sessions[0].member_id}&select=id,email,name,did`),
@@ -587,7 +588,7 @@ async function authVerify(appId: string, body: Record<string, unknown>): Promise
-    restUrl(`/app_members?app_id=eq.${encodeURIComponent(appId)}&email=eq.${encodeURIComponent(email)}&select=id,email,name`),
+    restUrl(`/app_members?app_id=eq.${encodeURIComponent(appId)}&email=eq.${encodeURIComponent(email)}&select=id,email,name,did`),
@@ -625,7 +626,7 @@ async function authVerify(appId: string, body: Record<string, unknown>): Promise
-  return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name } });
+  return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name, did: member.did } });
```

There are exactly four hunks, and each is permitted by S-52 / C-30. Nothing else changed.

---

## 2. Coverage audit

For each row marked `covered`, I opened the named tests and asked whether they assert the requirement or only exercise the code path. Rows already marked `partial` or `not testable here` were spot-checked and are not repeated unless I disagree.

| Req | COVERAGE says | Verdict | Evidence / reason |
|---|---|---|---|
| S-11 | covered | **agree** | `core.authenticate.test.ts:480-490` asserts `doc_id`, `app_id` and `digest === documentDigest(doc)`. It also asserts that the digest differs from the digest computed without `proof`, so the proof really is included, and that the retained response equals the response sent. |
| S-12 | covered | **agree** | `fake-postgrest.ts:196-299` throws on any unmodelled path, operator, select set, header, `Prefer` value or body member, and `helpers.ts:66-70` fails every test that left a violation. This is a real contract check. |
| S-20 | covered | **agree** | `challenges.test.ts:36-105` covers the exact P2 body, 32 bytes requested, 43-char base64url, retry once on 409 then throw, and throw on reject/503. |
| S-21 | covered | **agree, with a caveat** | **Concurrency (`challenges.test.ts:161-169`) is real at the implementation level.** `Promise.all` starts both calls, and each reaches its first `await fetch` before either continues. A read-then-write implementation (GET, then PATCH without `consumed_at=is.null`) would interleave and return two `ok`s, so the test would catch it. The fake applies the PATCH atomically (`fake-postgrest.ts:324-329`). The test therefore proves "one conditional UPDATE", not Postgres row locking; that last step rests on READ COMMITTED re-evaluating the WHERE clause, which is sound but untested until Phase 5. App scoping is asserted directly: `challenges.test.ts:154-159` shows another app's row is `notFound` **and left unconsumed**. |
| S-22 | covered | **agree; note gaps** | **Fail-closed non-execution is asserted, not just the 503.** `core.authenticate.test.ts:559-567` makes P5 reject, then asserts 503 `unavailable` with `retryable: true`, **zero P3 calls** (the handler never ran) and zero sessions. At guard level, `replay.test.ts:120-131` covers reject, 503 and 500 on P5 and 503 on P6. Two gaps are not part of S-22's text but matter (R1-2, N-11): `release` failing (P10 reject or non-2xx) and `recordResponse` failing are never exercised end to end. Probes B and C show both leave the record stuck in flight. |
| S-23 | covered | agree | `challenges.test.ts:202-225`; `core.challenge.test.ts` (S-43/S-23 pair). |
| S-24 | covered | **agree** | `core.authenticate.test.ts:569-577`: the same signed document under app B → 409, with no `accessToken` anywhere in the body, and one session. `replay.test.ts:194-216` is the guard-level equivalent. |
| S-25 | covered | **downgrade → partial** | S-25 says "Any other keyword … **throws**". `schema.test.ts:72-85` puts the bad keyword only at the top level, under `properties`, or under `$defs`. `assertSchemaSupported` does not descend into `items` or `propertyNames` sub-schemas (`fn/core.ts:552-555` iterates `Object.values(items)` as if `items` were a map of sub-schemas). **Probe D:** `{items:{enum:[…]}}`, `{items:{oneOf:[…]}}` and `{propertyNames:{const:…}}` do not throw. `subsetSchemaValidator.validate({type:"array",items:{type:"string",enum:["a"]}}, ["zzz"])` returns **true**, so the validator fails open. The pinned schemas only use `type`, `minLength` and `pattern` under `items`/`propertyNames` (walker probe), so nothing is exploitable today. But the guard that DESIGN R5 relies on against a future pin bump does not work. See R1-3 and R1-7. |
| S-30 | covered | agree | `helpers.ts:110-116` checks `issuer === localVid` on every error. The S-47 success test checks it on responses (`core.authenticate.test.ts:51`). |
| S-40 | covered | agree | The order, plain-JSON bodies, and zero P2–P13 calls when disabled are all asserted. |
| S-41 | covered | agree | |
| S-42 | covered | **downgrade → partial** | Two parts are not asserted. (1) §1.1 item 3 / S-42 restrict verification to `eddsa-jcs-2022`, but no test offers an `ecdsa-jcs-2019` (P-256 `did:key`) proof. **Probe A:** one is accepted, and a `did:key:zDna…` member is created (R1-4). (2) "Optional proof does not leak into authenticate" is covered only through `proofRequired` on an absent proof and `proofInvalid` on tampering, which is enough for that clause. The clock seam is genuinely exercised: every document is dated 2031 (`helpers.ts:16`). |
| S-43 | covered | agree | The C-31 cases are present. |
| S-45, S-46 | covered | agree | Each asserts no session and no member row. |
| S-47 | partial | **agree; the second-sign-in clause is real** | `core.authenticate.test.ts:92-104` reuses one identity, then asserts `app_members` length 1, `app_sessions` length 2, different tokens, and the same `ext` member id. |
| S-48 | covered | **agree** | **Identical replay:** `core.authenticate.test.ts:468-478` asserts 200 and `again.body` deep-equal to the first body (so the same `accessToken`), session count still 1, and only P1/P5/P6 issued, meaning the handler did not run. **Different body:** `:492-503` re-signs with a different `created` → 409 `idConflict`, no token in the body, one session. Expired-not-recorded and the window edge are both asserted. One gap: "different body" is only tested as a re-signed proof, never as a changed payload. That suffices, because the digest covers both. |
| S-49 | covered | agree | Source grep plus the call list. |
| S-52 | covered | **agree; minor looseness** | **The test compares against the base commit, not the working tree.** `app-data.snapshot.test.ts:42` reads `git show ${BASE_SHA}:supabase/functions/app-data/index.ts`, and `:17` diffs the working tree against `BASE_SHA`. One looseness: `stripDid` and `isDidField` (`:28-30`) apply to every line in the file, so a `, did: x }` added to *any* object literal, or a `did: string \| null;` line added to *any* interface, would pass (N-10). |
| S-61, S-62, S-70 | covered | agree | S-61's "no key material" test (`producer-helper.fixture.test.ts:217-225`) checks hex, base64 and base64url encodings of the seed on the wire. |
| NF-2, NF-3 | covered | agree | |
| NF-5 | covered | agree on counts | Counts are met. Missing markers are a §4 matter, not a test matter. |

**Rows downgraded:** S-25 and S-42, both from `covered` to `partial`.

---

## 3. Security review

**3.1 Can a challenge issued for app A be consumed via app B?** No. P3 always carries `app_id=eq.<authenticated appId>` (`fn/challenges.ts:87-91`), and the app id comes from the query string only after the key check (`fn/core.ts:180-188`). Under app B, a challenge from app A is `notFound` and stays unconsumed (`challenges.test.ts:154-159`). The replay record is app-scoped too (`fn/replay.ts:132`; S-24 test).

There is one structural point the spec did not anticipate. Every Community Cloud app shares one `recipient` (`localVid`), so SPEC §4.8.2 audience binding binds a signed document to *Community Cloud*, not to the app. App binding rests entirely on the challenge row's `app_id`. That holds today, but Increment 2's `sessionKey` proofs will need their own app binding (ledger L-27).

**3.2 Is `app_key` compared before any store read?** Yes for the challenge and replay stores. P1 (`cloud_apps`) is necessarily read in order to compare the key (`fn/core.ts:185-188`). No P2–P13 call precedes the key check or the enabled check (`core.auth.test.ts`, "zero P2–P13 calls"). The comparison is a plain `!==` (`fn/core.ts:187`), which is not constant-time. That is harmless because `APP_KEY` ships in every generated app's `env.js`, and it matches `app-data` (N-4). The rate limiter runs before the lookup on an unauthenticated `appId` and keeps a never-evicted `Map` entry per distinct string (`fn/core.ts:84, 182`). That is an in-isolate memory growth vector, shared with `app-data` (N-3).

**3.3 Can authenticate run with a proof that was present but not verified?** No. Both tasks use the same `{kind:"verify"}` policy (`fn/core.ts:242-247`). The runtime verifies whenever `proof !== undefined` and maps a `false` or a throw to `proofInvalid` (`rt/consume.ts:425-446`). Absence is judged separately by `enforceSpecPolicy` against `AuthAuthenticate_v0_3.SPEC.isProofRequired === true` (`rt/document.ts:317-323`), and the handler runs only after that check (`rt/consume.ts:462, 520`). `proof: null` and non-object proofs are refused earlier by `checkFrameworkShape` (`fn/core.ts:427`). The challenge's optional-proof behaviour comes from the *spec object* (`isProofRequired:false`), not from the policy, so it cannot leak.

**But the verifier is wider than the spec allows:** `new DataIntegrityProofVerifier({now})` accepts `ecdsa-jcs-2019` with P-256 and P-384 `did:key`s (`pf/verifier.js:8, 26`). **Probe A:** a P-256 issuer completes a subject-agnostic sign-in and becomes a member, while the same DID named as `subject` is refused `subjectNotRecognized` (R1-4).

**3.4 Is the challenge comparison constant-time?** `constantTimeEqual` (`fn/core.ts:630-636`) walks `max(len)` UTF-16 units and folds in the length difference. As a JS approximation, that is fine. It is also moot as an oracle, because the challenge is consumed *before* the compare (`fn/core.ts:351-354`), so every guess burns it.

**3.5 Does any trust-task-error leak a stored challenge, a token or a stack trace?** No.
- Handler messages are the constants at `fn/core.ts:140-154`. `core.authenticate.test.ts:383-403` asserts that no DID, challenge or sessionId appears in them.
- The 500 path emits the constant `"internal error"` and logs `e.message` server-side only (`fn/core.ts:170-175`). **Probe I:** a thrown `"secret-host:5432 boom"` produced the body `{"code":"internalError","message":"internal error","retryable":false}`.
- Runtime rejections use constant wire messages for `proofInvalid`, `idConflict` and `unavailable` (`rt/consume.ts:572-582`).
- One residual path is the runtime's own: a *throwing* payload validator's exception text is appended to the `malformedRequest` message (`rt/consume.ts:391, 400`). With this validator that text is only `S-25: unsupported schema keyword …`, about a server schema, so nothing sensitive leaks (OVTC-47).
- Retained responses are never served across apps (S-24).
- R8 stands as documented: the identical signed document returns the token within the window. R1-5 extends how long that token sits at rest.

**3.6 Does the browser helper ever transmit private key material (S-60)?** No. Only `toMultibase(signature)` and public identifiers go on the wire (`helper:247-250, 267`). The seed and `CryptoKey`s are used only in `fromRecord` (`helper:145-157`) and the store `put` (`helper:193`).

**However, the custody claim does not hold where these apps are hosted (R1-1, blocker).**
- **Shared origin.** Community Hosting serves every published app from one origin: `${APP_URL}/s/${slug}/`, with `APP_URL` defaulting to `https://relationalbuilder.org` (`supabase/functions/publish-site/index.ts:198, 286, 492`; `vercel.json:11-12`). The Builder's own framework preview also runs project code same-origin (`src/components/preview/FrameworkPreview.tsx:233`, `sandbox="… allow-same-origin"`).
- **One identity per origin.** The helper keeps one identity per origin: database `rb-trust-signin`, key `rb.trust-signin.identity.v1` (`helper:17, 111, 169-170`).
- **Correlation.** Every hosted app therefore sees the same DID for a person, which correlates them across apps.
- **Impersonation.** Any script in any other hosted app or preview can open that database and call `crypto.subtle.sign` with the non-extractable key. Non-extractable stops export, not use. That script can produce a valid `auth/authenticate/0.3` document for *any* app, since every app's `APP_ID`/`APP_KEY` are public in its `env.js`, and so mint a `member_token` as that person's member in every app this device has joined, indefinitely.
- **VTI.** This breaks VTI-CLT-006 ("MUST NOT hold it in storage readable by other principals on the host", `07-clients.md:71-73`), which S-60 claims to satisfy.
- **Escalation over the email path.** The email path already shares `localStorage.member_token` across hosted apps (`src/integrations/catalog.ts:303`), so the *class* of exposure predates this spike. The escalation is from "read the last token written" to "mint fresh sessions for every app, forever".

**3.7 Clock seam.** Every `consumeInbound` call takes `now: deps.now().getTime()` and `clock: () => deps.now().toISOString()` (`fn/core.ts:284-286, 323-325`).
- The verifier gets `now: () => deps.now().getTime()` (`:245`).
- Stores get `deps.now` (`:275, :314`); the guard gets the runtime's `now`.
- `errorDocument` uses `deps.now()` (`:444`).
- The rate limiter gets `deps.now().getTime()` (`:182`).
- `grep -n "Date\.now\|new Date()"` over `fn/*.ts` and the helper finds only the seams themselves: `fn/index.ts:15` (`now: () => new Date()`) and the helper's default `options.now` (`helper:306`). No path bypasses the seam.

**3.8 Replay-guard failure paths (new).**
- **Release.** After a retryable handler refusal, the runtime awaits `guard.release` *outside* any try (`rt/consume.ts:533-535`). `PostgresReplayGuard.release` awaits `fetch` unguarded (`fn/replay.ts:102-109`), even though IMPL-NOTES line 241 calls it "best-effort".
  - **Probe B1:** P3 and P10 both reject. The response is **500 `internalError`, `retryable:false`**, where it should be 503 `unavailable`, and the record stays `response:null`.
  - **Probe B2:** after the store recovers, the identical resend gets **202**.
  - **Probe B3:** a P10 answering 503 is ignored. The response is 503, but the resend still gets 202.
  - The helper shows 500 `internalError` / non-retryable as "fall back to email" (`src/integrations/catalog.ts:274`) for what was a transient outage. See R1-2.
- **Record.** **Probe C:** if P9 (`recordResponse`) fails after a successful sign-in, every identical resend gets 202 "in progress" for the record's lifetime. This originates in the runtime (`rt/consume.ts:559-563` swallows the failure) and is only mitigable here (N-11, OVTC-43).

**3.9 Retention is producer-controlled (new).** `retainUntil` is the document's `expiresAt` whenever one is present (`rt/freshness.ts:173-176`), even when it lies far beyond the acceptance window. The guard stores `retainUntil + pad` verbatim (`fn/replay.ts:121`).
- **Probe H:** `expiresAt: "9999-12-31T23:59:59Z"` gives `until_at = "+010000-01-01T00:00:59.000Z"`. The row is never swept, and it holds the retained `#response` with its bearer token. That extended-year string is also not a timestamp Postgres accepts in PostgREST's usual input form, so on a real database such a document would get a permanent 503 (unverified; Phase 5).
- **Cost to an attacker.** Writing a retained row needs no valid challenge, because the claim precedes the handler. A non-retryable `challengeNotFound` is retained (`rt/consume.ts:536`). So anyone holding any app's public credentials and any `did:key` can write permanent rows at the rate-limit pace (120/min per isolate per app).
- **Fix.** The spec (S-22) fixes `until_at = retainUntil + pad` exactly, so a cap needs a spec change (R1-5).

**3.10 Self-enrolment (new; ledger L-23).** Any freshly minted `did:key` becomes a full member: `upsertMemberByDid` runs with no administrator, ACL or invitation (`fn/core.ts:370`). The email path is gated by inbox possession. This path is gated by nothing beyond `trust_signin_enabled` and the per-isolate rate limit. That is a Sybil and storage-growth surface and a departure from VTI-CLT-010/013, and neither spec §1.2 nor a `// SPIKE:` marker records it. Spec §1.2 mentions only rotation (Step 3).

---

## 4. Protocol-compliance ledger

Legend: ✅ marked `// SPIKE:` at the site · 📄 recorded in SPIKE-SPEC but not marked in code · ❌ neither, or the code differs from what the spec records · ✔ conformant, listed for completeness.

| # | Deviation | Source rule | Code | Status |
|---|---|---|---|---|
| L-1 | `#response` of `auth/authenticate/0.3` unsigned | task spec `proofRequirement: REQUIRED` (`up/specs/auth/authenticate/0.3/spec.md:31-33`), SPEC §7.3 item 8 | `fn/core.ts:5, 387` | ✅ |
| L-2 | `local_vid` is a label: no service DID, nothing resolves it | binding 0.2 §3 / §6.2 | `fn/core.ts:5`, `fn/index.ts:16` | ✅ |
| L-3 | Consume before compare (task items 3→6 reordered) | authenticate 0.3 consumer items 3, 6 | `fn/core.ts:349-354` | ✅ |
| L-4 | **Expiry reported before mismatch** (`challengeExpired` beats `challengeMismatch`), where the task order is compare (item 3) then expiry (item 4) | authenticate 0.3 items 3–4 (`spec.md:128-129`) | `fn/core.ts:352-354`; test `core.authenticate.test.ts:345-351` | ❌ S-44/C-11 chose this order but record only consume-before-compare as a deviation; the marker at `:349` does not cover it |
| L-5 | `sessionKey` refused | authenticate 0.3 item 11 (MAY refuse) | `fn/core.ts:364` | ✔ conformant (S-45) |
| L-6 | Proxied form refused | items 7.1/7.2 (policy refusal permitted) | `fn/core.ts:359-363` | ✔ conformant (S-46) |
| L-7 | `auth/authenticate/0.2` not registered (plugin incompatibility) | — (scope) | `fn/core.ts:36-37` comment | 📄 S-41, FINDINGS |
| L-8 | `OPTIONS` → 204 instead of 405 | binding 0.2 §2 item 1 | `fn/index.ts:27-28` | ✅ |
| L-9 | Recipient mismatch answered `wrongRecipient`, binding says `identityMismatch` | binding 0.2 §3 (`spec.md:63`) | runtime `rt/document.ts:264-270`, inherited | 📄 S-30 (FINDINGS); no marker where `myVid` is passed |
| L-10 | Retained **error** answered under its code's status, binding says 200 | binding 0.2 §4 (`spec.md:93`) | `fn/status.ts:70-73` | 📄 S-50/C-12 (R6); ❌ no marker |
| L-11 | `suppressed` → 400 generic (unreachable) | binding 0.2 §4 has no row | `fn/status.ts:64-66` | 📄 S-50; comment, no marker (nit) |
| L-12 | Rate limiting: per-app, per-isolate, transport 429 plain JSON. Not per source (IP/DID), and never `auth/challenge:rateLimited` | challenge 0.1 consumer item 6 (`spec.md:83`) | `fn/core.ts:80-99, 182-184` | 📄 S-40/C-33 record the 429. The marker at `:80` covers only "in-isolate". ❌ The per-app axis means any holder of the public `APP_KEY` can exhaust every user's sign-in budget for that app. Not recorded |
| L-13 | No bearer→VID mapping (`UnauthenticatedTransport`) | binding 0.2 §2 item 2 | `fn/core.ts:277, 316` | ✔ conformant (an absent header means no sender); 📄 FINDINGS item 4 |
| L-14 | No discovery task / `TrustTaskHTTPS` service entry | binding 0.2 §6.2 (SHOULD), SPEC §10 | — | 📄 §1.2 |
| L-15 | **§7.2 item 1 only partially done.** `checkFrameworkShape` checks member *types* only. Timestamps are not checked as RFC 3339, and `type` format, `parentThreadId`, `ceremony` and `extCritical` placement are not checked | SPEC §7.2 item 1, §4.2 | `fn/core.ts:420-429` | ❌ C-7 defines the check this narrowly without calling it a deviation; no marker. **Probe F:** `issuedAt: "Tue, 04 Mar 2031 05:06:07 GMT"` → **200**. An offset-less `issuedAt` is parsed as server-local time (it gave 400 on this machine; on Supabase, which runs UTC, it would be accepted) |
| L-16 | §7.2 item 2 via a hand-written subset validator | SPEC §7.2 item 2 | `fn/core.ts:559-572` | ✅. ❌ but the "unknown keyword throws" guarantee has a hole (R1-3) |
| L-17 | §7.2 items 3–8, 11, 13 | SPEC §7.2 | runtime `rt/consume.ts:379-518` | ✔ |
| L-18 | §7.2 item 10: authorization = verified proof (ordinary form) + `trust_signin_enabled` | SPEC §7.2 item 10; task "Authorization" (`spec.md:148`) | `fn/core.ts:188` | ✔ |
| L-19 | §7.2 item 12: re-evaluate before effect | SPEC §7.2 item 12 | n/a (no deferred execution) | ✔ |
| L-20 | Binding §5.1 item 7 (retain ≥ willingness) | binding 0.2 §5.1 | `fn/replay.ts:17-20, 121` | ✅ pad. ❌ retention is unbounded above, controlled by the producer (R1-5) |
| L-21 | Proof cryptosuite: `ecdsa-jcs-2019` accepted | spike §1.1 item 3 (`eddsa-jcs-2022` only); SPEC §4.7.1 only says SHOULD verify P-256 | `fn/core.ts:245` | ❌ contradicts the spike spec, and contradicts S-43's Ed25519-only subject rule (R1-4) |
| L-22 | VTI-CLT-006 software custody | VTI `07-clients.md:71-73` | `helper:188` | ✅ |
| L-23 | **VTI-CLT-006 shared-origin storage.** The identity is readable and usable by every app on `relationalbuilder.org` | VTI-CLT-006, -002 | `helper:17, 111, 169`; `publish-site/index.ts:198` | ❌ (R1-1) |
| L-24 | **VTI-CLT-010/012/013/014 enrolment.** No administrator enrolment or narrow-scope entry; the bootstrap DID is not treated as low-trust; the member never expires | VTI `07-clients.md:88-104` | `fn/core.ts:370`; `fn/members.ts:35-53` | ❌ §1.2 covers only Step 3 rotation; no marker (R1-6) |
| L-25 | VTI-CLT-040: no `auth/refresh`; re-sign-in after 30 days | VTI-CLT-040 | — | 📄 §1.2 |
| L-26 | `session.id` is minted but stored nowhere, so no introspection or revocation by id | authenticate 0.3 "Session … revocable state" (`spec.md:38-39`) | `fn/core.ts:377` | 📄 S-47; comment, no marker (nit) |
| L-27 | **Audience binding is per service, not per app.** All apps share `recipient = localVid` | SPEC §4.8.2 | `fn/core.ts:283, 322` | ❌ not anticipated. Safe today only because of `app_tt_challenges.app_id`; record it for Increment 2 |
| L-28 | Accepted `proofPurpose`: any of the four signing relationships | SPEC §4.7.3 (did:key implicit relationships) | `fn/core.ts:50-55, 468-472` | ✔ conformant; the task spec could require `authentication` (OVTC-49) |
| L-29 | The client does not run `consumeInbound(RESPONSE_SPEC)` on responses (would fail `proofRequired`) | §1.2 | `helper:313-330` | 📄 §1.2 |

**SPEC §7.2 items 1–11 skipped or weakened by the code:** item 1 (L-15, partial). Item 11 has an edge: duplicate absorption is correct, but probes B and C show stuck in-flight records answered with 202 when nothing is running. The remaining items are delegated to the runtime and verified above.

---

## 5. Verdict

### **REVISE-SPEC**

There are blocker and should-fix items for D, T and I. D is the earliest phase, so the verdict goes there. The T and I items are listed so that one loop can close them after D amends the spec.

**Counts:** 1 blocker, 6 should-fix, 12 nits.

#### Items for D (design)

- **R1-1 · blocker · D.** **Device identity is shared by every app on the hosting origin.**
  - **Problem.** S-60 specifies one `IDENTITY_KEY` in one default IndexedDB store. Community-hosted apps all live on `relationalbuilder.org/s/<slug>/` (`publish-site/index.ts:198, 286, 492`; `vercel.json:11`), and so do Builder previews (`FrameworkPreview.tsx:233`).
  - **Consequences.** (a) One DID per person across all hosted apps, which is cross-app correlation. (b) Any other hosted app or preview can sign authenticate documents with the non-extractable key and get a `member_token` in every app the device has joined. This violates VTI-CLT-006, which S-60 cites as satisfied (`helper:6-8` claims "The private key never leaves this device").
  - **D must decide and amend S-60 / §1.2.** Minimum: scope the identity per app (key `…v1:<app_id>`) so DIDs do not correlate across apps. Record that same-origin scripts can still *use* the key: only origin isolation of hosted sites closes this, and the same holds for the existing `localStorage.member_token`. Then state whether `trust_signin_enabled` may be turned on for an app served from the shared origin before isolation exists. Add the result to FINDINGS §9 item 6.
- **R1-5 · should-fix · D.** **Replay retention has no upper bound.** S-22 sets `until_at = retainUntil + pad`. The runtime's `retainUntil` is the producer's `expiresAt` when present (`rt/freshness.ts:173-176`). So retention, including a retained bearer token, is chosen by the producer and can be permanent (Probe H). Such rows can be written without a valid challenge (§3.9). Amend S-22 to cap `until_at`, for example `min(retainUntil, now + acceptanceWindowMs + 2·DEFAULT_SKEW_MS) + pad`. The consumer refuses the document after that bound anyway (`rt/freshness.ts:132, 143`), so the cap loses nothing. Alternatively, refuse `expiresAt` beyond the window. Add the oracle: `expiresAt` in 9999 → `until_at` within the cap.
- **R1-6 · should-fix · D.** **Record the deviations the spec does not anticipate,** and have I mark each with `// SPIKE:`:
  - L-4: expiry before compare.
  - L-10: retained error status.
  - L-12: per-app rate-limit axis and no `auth/challenge:rateLimited`, including the per-app budget DoS.
  - L-15: partial §7.2 item 1 envelope check. Either widen C-7 to validate `issuedAt`/`expiresAt` as RFC 3339 with an offset, reusing the S-25 date-time rule, or record it as a deviation.
  - L-24: self-enrolment versus VTI-CLT-010/013, a Sybil and storage-growth surface. Mark it at `fn/core.ts:370`.
  - L-27: per-service audience binding.

  FINDINGS §9 item 4 is incomplete without these.

#### Items for T (tests), after D

- **R1-7 · should-fix · T.**
  - Downgrade S-25 and S-42 in `COVERAGE.md` to `partial` (§2).
  - Add a test that a bad keyword nested under `items` and under `propertyNames` throws (R1-3).
  - Add a test that an `ecdsa-jcs-2019` / P-256 `did:key` authenticate is refused `proofInvalid` (R1-4).
  - Add an end-to-end test for P3 failure followed by P10 failure (`reject` and 503): the answer must stay 503 `unavailable`, `retryable:true`, and must never be 500 (R1-2).
  - Add the R1-5 retention-cap oracle once D amends S-22.

#### Items for I (implementation), after D and T

- **R1-2 · should-fix · I.** `PostgresReplayGuard.release` must never throw. Wrap P10 in try/catch, log any non-2xx or rejection through a log seam, and return (`fn/replay.ts:102-109`). Today a failed release escapes `consumeInbound` (`rt/consume.ts:534`) and becomes a non-retryable 500 `internalError` (Probe B1). Also correct IMPL-NOTES line 241 ("best-effort").
- **R1-3 · should-fix · I.** `checkSchemaNode` (`fn/core.ts:552-556`) must recurse into `items` and `propertyNames` as single sub-schemas, not iterate their values. Keep `properties` and `$defs` as maps. Today unknown keywords there are silently ignored, and the validator fails open (Probe D).
- **R1-4 · should-fix · I.** Construct the verifier with `cryptosuites: ["eddsa-jcs-2022"]` (`fn/core.ts:245`) per §1.1 item 3. That makes authenticate's issuer rule match S-43's Ed25519-only subject rule (Probe A).
- Implement R1-5 and the R1-6 markers once D amends the spec.

#### Nits (do not justify a REVISE on their own; owner in brackets)

- **N-1 [I].** The helper's type-only `import type … from '@openvtc/trust-tasks'` (`helper:10`) is picked up by `collectBarePackages` (`src/project/build-for-publish.ts:121-132`). Exported or synced repos therefore get `"@openvtc/trust-tasks": "latest"` (`:149`), contradicting IMPL-NOTES §8 ("never reaches esm.sh"; it reaches `package.json`). Pin it, or inline the one type.
- **N-2 [D/I].** Adding `@openvtc/trust-tasks-proof` and `@noble/curves` to `PINNED_VERSIONS` (`src/preview/bundler/versions.ts:35-37`) advertises them as "known-good" in the system prompt for **every** framework project (`src/knowledge/context-builder.ts:108-110`), not only trust-signin ones.
- **N-3 [I].** The `InMemoryRateLimiter` map keyed by an unauthenticated `appId` is never evicted (`fn/core.ts:84, 182`). Same as `app-data`.
- **N-4 [I].** `app_key` is compared with `!==` (`fn/core.ts:187`). The key is public, so this only matters for consistency.
- **N-5 [I].** The validator's `required` uses `in`, so prototype names count as present. `required:["toString"]` is satisfied by `{}` (`fn/core.ts:599`, Probe E). Use `Object.hasOwn`, and likewise for `k in props` (`:606`).
- **N-6 [I].** `replay.ts:4-8`: the header says no record is "swept by another app", but P8 (`:164-169`) sweeps every app's expired rows (harmless). Its `// SPIKE:` labels hardening rather than a shortcut.
- **N-7 [I].** `statusForCode("unsupportedExtension")` → 500 (`fn/status.ts:21-45`, Probe K). It is a SPEC §8.3 standard code and should be 422. It is never emitted today (OVTC-17).
- **N-8 [I].** The helper does not check that a `#response` it reads is the response type for its own request (`type`, `threadId === doc.id`; `helper:313-330`).
- **N-9 [I].** `getOrCreateIdentity` loads a stored `software` record even when `allowInMemoryFallback` is false. Two concurrent first calls each mint an identity, and the second overwrites the first (`helper:168-195`).
- **N-10 [T].** S-52 `stripDid` and `isDidField` are file-wide (`app-data.snapshot.test.ts:28-30`). Scope them to `resolveMember`, `authVerify` and `interface Member`.
- **N-11 [I].** When `recordResponse` (P9) fails after success, identical resends get 202 for the record's life (Probe C). Consider one retry of P9. The real fix is upstream (OVTC-43).
- **N-12 [I].** `fn/index.ts:35` reads an unbounded body (`req.text()`), and `fn/index.ts:16` throws at module load if `SUPABASE_URL` is unset.

#### What the implementer added beyond the brief (IMPL-NOTES), judged

| Addition | Belongs? |
|---|---|
| `detachAppFromProject` removes `TRUST_TASKS_URL` and `TRUST_TASKS_VID` (`src/cloud/community-cloud.ts:340`) | Yes. It is the symmetric counterpart of the attach. |
| `trustTasksVid()` returns `''` for an invalid URL | Yes. It keeps `trustSigninConnected` false instead of throwing. |
| The outer try/catch in `handleTrustTask` (`fn/core.ts:167-176`) | Yes. DESIGN §2 says "never throws", and Probe I shows nothing leaks. |
| The `fetch` arrow wrapper (`fn/index.ts:12`) | Yes. |
| `lookupApp` mapping JSON-parse failure → 503 | Yes. |
| `TrustSignInError('issuerMismatch')` and the `'transport', 200` codes for a malformed 200 | Yes. |
| Extra guidance about `shortDid` and `retryable` | Yes. That said, R1-2 currently makes a transient outage look non-retryable, so the guidance's "fall back to email" fires wrongly. |

---

## 6. New OpenVTC feedback (for the OpenVTC developer's coding assistant)

These are numbered after the existing OVTC-41. Environment: `@openvtc/trust-tasks@0.26.29` and `@openvtc/trust-tasks-proof@0.1.3`, Deno 2.9.7, as in `OPENVTC-FEEDBACK.md`. `RT/` = `trust-tasks-ts/src/_runtime/` and `PF/` = `trust-tasks-ts-proof` dist, both at those versions. Each item was **probed** unless it says otherwise.

### OVTC-42 · `bug` · `release` runs outside any try, so a failing release escapes `consumeInbound` and strands the claim

After a handler returns a refusal with `retryable: true`, `consumeInbound` runs `await claim?.guard.release?.(doc.id, claim.digest)` with no `try` (`RT/consume.ts:533-535`). That is exactly when the store is likely to be failing, because the usual reason for a retryable refusal is a store outage.

**What happens.**
- A rejecting `release` turns the whole call into a thrown exception, and the record stays in flight.
- A consumer that maps exceptions to 500 answers `internalError`/non-retryable where the handler said `unavailable`/retryable.
- Every bit-for-bit retry then gets `duplicate`, `inFlight: true` (HTTPS 202) until the record expires.
- The `ReplayGuard` interface (`RT/replay.ts:86-132`) also gives `release` no way to report failure.

**Probe.** A Postgres-backed guard whose challenge store and DELETE both reject: first answer 500. After recovery, the identical resend gets 202. This is the same family as OVTC-9, but on the runtime's own call.

**Fix.** Wrap `release` like `settle` wraps `recordResponse`, and return the handler's refusal unchanged. Document that guards should make `release` total.

### OVTC-43 · `bug` · A swallowed `recordResponse` failure makes a completed execution look in progress

`settle` swallows `recordResponse` errors (`RT/consume.ts:553-564`), and the comment says the duplicate "is still absorbed". It is absorbed, but the guard's record is left with no response. Every identical resend is then answered `duplicate`, `inFlight: true` (`RT/replay.ts` verdict). HTTPS 0.2 §4 maps that to 202, which binding §4.1 defines as "this document … its execution has not finished". That is false: execution finished.

**Probe.** Success with P9 failing, then an identical resend: 200, then 202.

**Fix.** On a `recordResponse` failure, ask the guard to mark the record "completed, nothing retained", so it answers `inFlight: false` and HTTPS 204. For example, add an optional `markCompleted(id)` method, or call `recordResponse(id, undefined)` in a second best-effort attempt.

### OVTC-44 · `bug` · `recordExpiry` lets the producer choose an unbounded retention

`recordExpiry` returns `expiresAt` whenever it is present (`RT/freshness.ts:173-176`). That holds even when `expiresAt` is far later than the point after which `validateFreshness` would refuse the document anyway (`issuedAt + maxAgeMs + skewMs`, `:143`). SPEC §7.2 *Bounding the record* only requires retention "at least as long as it remains willing to execute". Retention past that point is pure cost, and here it is chosen by an unauthenticated producer.

**Probe.** `expiresAt: "9999-12-31T23:59:59Z"` gave `retainUntil` ≈ year 10000. `new Date(...).toISOString()` then yields the extended form `+010000-01-01T…`, which most stores will not parse.

**Fix.** Return `min(expiresAt, issuedAt + maxAgeMs + skewMs)` when both exist. This also fixes OVTC-7 if `skewMs` is included. Optionally, let a consumer cap acceptance of `expiresAt` beyond its window.

### OVTC-45 · `bug` · Envelope timestamps are parsed with `Date.parse`, so non-RFC-3339 values are accepted

`validateFreshness` (`RT/freshness.ts:128`) and `validateBasic` (`RT/document.ts:246`) use `Date.parse` and call the result "not a valid RFC 3339 timestamp" only when it is `NaN`.

**Probe.**
- `issuedAt: "Tue, 04 Mar 2031 05:06:07 GMT"` (RFC 2822) is accepted and the task executes.
- An offset-less `"2031-03-04T05:06:07.000"` is parsed in the **server's local time zone**, so the verdict depends on host TZ.
- `PF/verifier.js:11, 65` enforces a strict dateTimeStamp regex on `proof.created`, so the two packages disagree.

**Fix.** Use one strict RFC 3339 parser, offset required, for `issuedAt` and `expiresAt`. Reject anything else as `malformedRequest`.

### OVTC-46 · `bug` · `DataIntegrityProofVerifier` ignores the verificationMethod fragment

The verifier binds `verificationMethod.split("#")[0]` to `issuer` and decodes the key from the DID part (`PF/verifier.js:79-83`). Whatever follows `#` is never checked. A proof naming `did:key:z6Mk…#not-the-key` verifies.

**Probe.** 200.

SPEC §4.7.3 item 3 requires the verification method to be one the controller document lists for the purpose. A `did:key` document lists only `did:key:<mb>#<mb>`. This is distinct from OVTC-38, which is about `publicKeyFromDidKey` accepting a fragment.

**Fix.** Require the fragment to be absent or equal to the multibase key.

### OVTC-47 · `bug` (minor) · A throwing payload validator's exception text reaches the wire

When `payloadPolicy.validate.validate` throws, its `e.message` is appended to the `malformedRequest` message sent to the producer (`RT/consume.ts:385-403`). The same function deliberately sends a constant for verifier failures, citing SPEC §12.4 (`:435-445`). A third-party JSON Schema engine's exception can name file paths, remote `$ref` hosts or internal state. Not probed for leakage; read from source.

**Fix.** Send a constant for a throw, log the detail, and keep returned `errors` arrays as they are.

### OVTC-48 · `docs` · The verifier's default cryptosuite set is not documented

`new DataIntegrityProofVerifier()` accepts `ecdsa-jcs-2019` with P-256 and P-384 keys, as well as `eddsa-jcs-2022` (`PF/verifier.js:8, 26`). This matches SPEC §4.7.1, which says SHOULD verify P-256. But a consumer that intends Ed25519-only, as ours did, has to read the dist to learn that it must pass `cryptosuites: ["eddsa-jcs-2022"]`.

**Probe.** A P-256 `did:key` signed in through our consumer.

**Fix.** List the default and the option in the README's "What is checked".

### OVTC-49 · `docs` · `auth/authenticate/0.3` does not require `proofPurpose: authentication` on the request proof

SPEC §4.7.3 lets a specification require a purpose. `auth/authenticate/0.3` requires `authentication` only for later session-key proofs (`specs/auth/authenticate/0.3/spec.md:140`). The login proof itself is left open, so a consumer accepts `assertionMethod`, `capabilityInvocation` and `capabilityDelegation` logins. Not probed beyond `core.authenticate.test.ts:203-210`, which shows `assertionMethod` → 200.

**Fix.** State it in the task's `proofRequirement`, since the login proof *is* an authentication, and have the runtime enforce a spec-declared purpose.

---

## D response

Design agent, 2026-10-28. The spec is amended by Changelog **C-37 to C-52** in `SPIKE-SPEC.md`. `DESIGN.md` §2 and §3 are updated in place, and the new §6 lists the changes. The only §2 signature changes are in the helper (C-37, C-51) and additive fields on `ReplayGuardDeps` (C-39, C-40).

| Item | Covered by | Note |
|---|---|---|
| **R1-1** (blocker) | C-37, C-38, C-50 | Owner decision: per-app keys plus a recorded risk. The identity is keyed by `appId` (`rb.trust-signin.identity.v2:<appId>`), and no shared or default key remains. The S-60 VTI-CLT-006 claim is amended to "met only against other origins". `// SPIKE: … shared origin` is marked at the key-storage site. Enablement on the shared origin is for the trial only, and per-app origins are a production prerequisite in FINDINGS §9 items 4 and 6. |
| R1-2 (I) | C-40 | Spec basis: `release` is total and logs. The P3+P10 failure → 503 `unavailable` oracle is normative. Also P9 gets one retry (N-11). |
| R1-3 (I) | C-41 | Sub-schema positions are defined. The validator asserts the whole schema first (it fails closed), and `required` uses own properties (N-5). |
| R1-4 (I) | C-42 | `cryptosuites: ["eddsa-jcs-2022"]` is normative, with the P-256 oracle. Added: the `verificationMethod` must be the `did:key`'s own (OVTC-46), because the check is cheap and the trial is more honest for it. |
| **R1-5** | C-39 | `until_at = min(retainUntil + pad, now + window + 2·skew)`. The guard gets `acceptanceWindowMs`. |
| **R1-6** L-4 | C-44 | Accepted deviation, with the marker `expiry before mismatch`. |
| R1-6 L-10 (and L-11) | C-45 | Accepted (already R6), with the marker `retained error` in `status.ts`. |
| R1-6 L-12 | C-46 | Accepted: per-app/per-isolate axis, plain 429, no `auth/challenge:rateLimited`, and the per-app budget DoS recorded. The rate-limiter marker must say `per-app` and `rateLimited`. |
| R1-6 L-15 | C-43 | **Fixed:** `issuedAt`/`expiresAt` must be RFC 3339 with an offset, and `parentThreadId` must be a string. `ceremony`/`extCritical`/`type` syntax are accepted, with the marker `envelope`. |
| R1-6 L-24 | C-47 | Accepted, added to §1.2, with the marker `self-enrolment` at `upsertMemberByDid`. |
| R1-6 L-27 (and L-9) | C-48 | Accepted, added to §1.2 and §10 (Increment 2 needs its own app binding), with the marker `audience` at `myVid`, naming `wrongRecipient`. |
| R1-6 (markers, FINDINGS) | C-49, C-50 | The NF-5 minimum is rewritten as grep-testable phrases. The FINDINGS §9 item 4 and item 6 lists are completed. |
| R1-7 (T) | C-37..C-52 oracles | Every T item now has a spec basis. COVERAGE downgrades of S-25/S-42 need no spec change. |
| N-1 | C-51 | The helper drops the `@openvtc/trust-tasks` import and uses a local type. |
| N-2 | C-50 | Recorded in FINDINGS, with no code change: the pins are needed for esm.sh, and the prompt side effect is minor. |
| N-3, N-4, N-12 | none | Implementation hygiene, with no spec rule involved. Optional for I. |
| N-5 | C-41 | |
| N-6 | none | The mislabelled marker is extra (NF-5 allows more). I may reword it. |
| N-7 | C-45 | `unsupportedExtension` → 422. |
| N-8 | C-52 | Response `type` and `threadId` are checked. |
| N-9 | none | The concurrent first-call race remains (now per app). Its worst case is a second member row for that app, which is the same as a lost identity, which S-70 already tells the user about. Not worth the trial's time. |
| N-10 (T) | none | S-52 already confines the diff to `resolveMember`/`authVerify`/`interface Member`. Tightening the test is T's call, within the existing text. |
| N-11 | C-40 | One P9 retry. The residual is OVTC-43. |
| L-26 (`session.id` stored nowhere) | none | Already in S-47. A marker is optional. |
