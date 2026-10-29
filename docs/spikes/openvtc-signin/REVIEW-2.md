# REVIEW-2 — Trust Tasks sign-in spike, Increment 1 (Phase 4 loop, agent R)

Reviewed 2026-10-28 on branch `spike/openvtc-signin` at `02ff917`. BASE_SHA is `6b68ea634f37a70e3a5ef3146d74a02072eda094`. This review covers the REVIEW-1 loop: D's spec amendments C-37 to C-52 (`d3958fd`, `78f5f51`), T's tests (`3d90825`), I's implementation (`ba6d745`) and notes (`02ff917`). The regression review reads `git diff 78f5f51 HEAD -- src supabase tests` (14 files, +992 / −105).

Path shorthands are as in REVIEW-1: `fn/` = `supabase/functions/app-trust-tasks/`, `rt/` = `node_modules/@openvtc/trust-tasks/src/_runtime/`, `pf/` = `node_modules/@openvtc/trust-tasks-proof/dist/`, `up/` = `.spike-deps/dtgwg-trust-tasks-tf/`, `helper` = `src/kit/files/lib/trust-signin.ts`, `spec` = `docs/spikes/openvtc-signin/SPIKE-SPEC.md`, `t/` = `tests/app-trust-tasks/`.

**Probes.** I ran three throwaway vitest files under a scratchpad directory outside the repo, using a scratchpad vitest config that reused the repo's aliases. They drove `handleTrustTask` through `t/fake-postgrest.ts`, the helper's `getOrCreateIdentity`, `InMemoryRateLimiter`, and the runtime's `validateFreshness` / `InMemoryReplayGuard`. All three files have been deleted, and nothing in the repo was touched. Results are quoted below as **Probe A–F**.

---

## 0. Disposition of REVIEW-1 items

### 0.1 Blocker and should-fix items

| Item | Status | Code evidence | Test that pins it |
|---|---|---|---|
| **R1-1** (blocker) shared-origin identity | **partly closed** | **Code: done, as the owner decided.** The key is per app: `helper:202-208` builds `IDENTITY_KEY_PREFIX + appId.trim().toLowerCase()`, and `helper:211-239` reads and writes only that key. Nothing remains of `rb.trust-signin.identity.v1` in the source. The `// SPIKE: shared origin` marker is at `helper:206`. The header (`helper:6-10`) and the `DeviceIdentity` doc comment (`helper:53`) no longer claim unqualified custody. **Spec: not done.** C-37/C-38 live only in the Changelog. The S-60 heading still reads "VTI-CLT-001, -002, -004, -005, **-006**" (`spec:365`), its signature line still says "persisting under `IDENTITY_KEY`" (`spec:374`), and §9 item 6 (`spec:445`), which FINDINGS must follow, does not contain the C-38 statement. See R2-1. | `t/producer-helper.fixture.test.ts:322, 329, 343, 359, 377, 382` (C-37 oracles 1–6); `:129, :165` (S-60 under the per-app key); `t/nonfunctional.test.ts:85` (marker placement) and `:89` (header) |
| R1-2 `release` must be total | **closed** | `fn/replay.ts:135-154`: P10 is issued once. A rejection or non-2xx is logged as `replay.release_failed {status}`, a throwing log sink is swallowed, and the method resolves. `fn/core.ts:352` passes `deps.log`. The IMPL-NOTES "best-effort" wording is corrected (IMPL-NOTES §REVIEW-1 loop, C-40). | `t/core.authenticate.test.ts:689` (P3 + P10 reject → 503 `unavailable`, retryable, then 202) and `:705` (P10 503); `t/replay.test.ts:255, 267, 277` |
| R1-3 schema walker misses `items`/`propertyNames` | **closed** (residual R2-6) | `fn/core.ts:599-605`: `items`, `propertyNames` and `additionalProperties` are walked as one sub-schema each, and `properties` and `$defs` as maps. `validate` asserts first (`:614`). | `t/schema.test.ts:150, 165, 181` |
| R1-4 verifier accepts `ecdsa-jcs-2019` | **closed** | `fn/core.ts:256-265` uses `cryptosuites: ["eddsa-jcs-2022"]`. `DidKeyMethodVerifier` (`:271-283`) also requires `verificationMethod === issuer#<multikey>`. | `t/core.authenticate.test.ts:589, 603, 616`; `t/core.challenge.test.ts:171` |
| R1-5 retention unbounded | **closed** | `fn/replay.ts:165-168` sets `until_at = min(retainUntil + pad, now + window + 2·DEFAULT_SKEW_MS)`. `fn/core.ts:350-352` passes the same `windowMs` it gives `authenticateChecks`. The arithmetic is sound because `CONSEQUENTIAL_FRESHNESS.requireIssuedAt === true` (`rt/freshness.ts:74-78`), so every accepted authenticate document has an `issuedAt` (§4.2). | `t/replay.test.ts:230, 238, 247`; `t/core.authenticate.test.ts:676` |
| **R1-6** unrecorded deviations | **partly closed** | **Code: all markers present** (table 0.3). **Spec body: not done.** C-44, C-46, C-47 and C-48 each say "added to §1.2", but §1.2 (`spec:47-55`) contains none of them. §9 item 4 (`spec:444`) still lists only the original six deviations. §10 (`spec:448-450`) lacks the Increment 2 app-binding sentence (R2-1). Two of the texts also overstate or misstate the behaviour (R2-2, R2-3). | `t/nonfunctional.test.ts:54` (every C-49 phrase on a `// SPIKE:` line) |
| R1-7 test additions | **closed** | — | S-25 and S-42 rows re-graded with the new tests (`t/COVERAGE.md` S-25, S-42 rows). Nested keyword: `t/schema.test.ts:150`. P-256: `t/core.authenticate.test.ts:589`. P3+P10: `:689, :705`. Cap oracle: `t/replay.test.ts:230`, `t/core.authenticate.test.ts:676`. |

### 0.2 Nits

| Item | Status | Evidence (code · test) |
|---|---|---|
| N-1 type-only import leaks into `package.json` | closed | The import is gone, and local `TrustTaskDocument`/`TrustTaskProof` types are at `helper:33-57`. Tests: `t/kit.test.ts:41, 47`. The second runs `materializeSource` and asserts that `@openvtc/trust-tasks` is not a dependency. |
| N-2 `PINNED_VERSIONS` advertised to every project | **partly closed** | Accepted with no code change, to be recorded in FINDINGS (C-50). FINDINGS does not exist yet, and §9 is not amended (R2-1). |
| N-3 rate-limiter map unbounded | **partly closed** | `fn/core.ts:96-98` evicts only closed windows, so the map is still unbounded within a window, and each new id now costs a full scan once past 10 000 (Probe B, R2-5). No test. |
| N-4 `app_key` compared with `!==` | closed | `fn/core.ts:196` uses `constantTimeEqual` with a `typeof` guard. Pinned by the existing `t/core.auth.test.ts:78-82, 105`, where `'wrong-key'` and `'wrong'` differ in length from `KEY_A`. See §4.9 on what the compare still reveals. |
| N-5 `required` uses `in` | closed | `fn/core.ts:648, 655` use `Object.hasOwn`. Test: `t/schema.test.ts:172`. |
| N-6 mislabelled `replay.ts` marker | closed | `fn/replay.ts:1-7`: the header now states that the P8 sweep is global, and the hardening note is no longer a `// SPIKE:`. |
| N-7 `unsupportedExtension` → 500 | closed | `fn/status.ts:37` (422). Test: `t/core.auth.test.ts:304`. |
| N-8 helper does not match the response to the request | closed | `helper:310-314` is called at `:367` (before the second POST) and at `:380` (before `member_token` is written). Tests: `t/producer-helper.fixture.test.ts:416, 424, 432, 442`. The positive end-to-end S-61 test against `handleTrustTask` still passes, so real responses satisfy the check. |
| N-9 concurrent first-call race | **open** (D declined) | `helper:214-237` is still get → mint → `put`, and the last write wins. **Probe C:** two concurrent calls for one app returned different DIDs, and only the second was stored. With per-app keys this also happens on a double-click in a single tab, not only with two tabs. I record my disagreement with "not worth the trial's time": the fix is IndexedDB `add` plus a re-read on `ConstraintError`, about 6 lines. It stays a nit and gets no new id. |
| N-10 `stripDid` is file-wide | closed | `t/app-data.snapshot.test.ts:78, 83` confine undoing to `interface Member`, `resolveMember` and `authVerify`. `:89` is a self-check showing that strays outside those regions are refused. |
| N-11 P9 failure → 202 forever | closed (residual OVTC-43) | `fn/replay.ts:106-127` retries once. Tests: `t/core.authenticate.test.ts:716, 731`; `t/replay.test.ts:284, 295`. The double failure is not logged (R2-9). |
| N-12 unbounded body; module-load throw | **open** (I skipped; D marked optional) | `fn/index.ts:35` is unchanged. |

**Totals: 19 REVIEW-1 items. 13 closed, 4 partly closed (R1-1, R1-6, N-2, N-3), 2 open (N-9, N-12).**

### 0.3 Accepted deviations: marker present, and does the spec text tell the truth?

| C-n | Marker (file:line) | Spec text honest? |
|---|---|---|
| C-44 expiry before mismatch | ✅ `fn/core.ts:392`, directly above the `expired` → `challengeExpired` line | **No, in one clause.** C-44 says "Only the code reported differs: both refuse, and the challenge is burned either way." The task spec marks `challengeExpired` `retryable: true` and `challengeMismatch` `retryable: false` (`up/specs/auth/authenticate/0.3/spec.md:55-60`; `fn/core.ts:393-394`). So a document that is both expired *and* mismatched gets `retryable: true`, and the runtime **releases** its replay record (P10, `rt/consume.ts:533-535`). A plain mismatch has its refusal **retained**. Retryability and the disposition of the replay record differ, not only the code. The effect is harmless, but the text is wrong (R2-2). |
| C-46 rate limiting | ✅ `fn/core.ts:83` (contains `per-app` and `rateLimited`) | **No, in one clause.** C-46 and the marker say "anyone holding an app's public `APP_KEY`" can use up the budget. The limiter is hit **before** the key is checked (`fn/core.ts:190` vs `:196`), so the `app_id` alone is enough, and a request with a wrong key still spends the budget (R2-3). The per-isolate and per-app axes and the missing `rateLimited` are stated correctly. |
| C-47 self-enrolment | ✅ `fn/core.ts:410`, directly above `upsertMemberByDid` | Yes. Gated by `trust_signin_enabled` and the rate limit, no expiry, VTI-CLT-010/012/013/014. However, "added to §1.2" did not happen (R2-1). |
| C-48 audience per service | ✅ `fn/core.ts:319` (names `wrongRecipient` and `identityMismatch`), with a pointer comment at `:361` | Yes. App binding rests on `app_tt_challenges.app_id` and the app-scoped replay record, as REVIEW-1 §3.1 verified. "Added to §1.2 and §10" did not happen (R2-1). |
| C-45 retained error | ✅ `fn/status.ts:74` (duplicate-with-prior branch); `suppressed` has its own marker at `:67` | Yes. |
| (C-38 shared origin) | ✅ `helper:206`, inside `identityKeyForApp` | The code header is honest. The spec body's S-60 heading is not (R2-1). |
| (C-43 envelope) | ✅ `fn/core.ts:462` | Honest about what is skipped. The "full RFC 3339" claim for the timestamp check is not met (R2-4). |

---

## 1. Mechanical checks

### `npx vitest run`

```text
 RUN  v5.0.5 /Users/kevintriplett/Documents/Documents - Kevin’s MacBook Pro/BACKUP/PROJECTS/SOFTWARE/relational-builder

 Test Files  13 passed (13)
      Tests  227 passed | 6 todo (233)
   Start at  20:12:09
   Duration  690ms (import 78%, tests 15%, transform 5%, setup 2%, worker 1%)

exit 0
```

The 6 todos are the real-Postgres migration checks (`t/migration.test.ts:148-153`), unchanged since REVIEW-1.

### `tsc --noEmit -p tsconfig.functions.json` · `tsc --noEmit -p tests/tsconfig.json` · `deno check fn/index.ts`

```text
exit 0 · exit 0 · Check supabase/functions/app-trust-tasks/index.ts — exit 0
```

### `grep -rn "// SPIKE:" supabase/functions/app-trust-tasks/ src/kit/files/lib/trust-signin.ts`

```text
supabase/functions/app-trust-tasks/replay.ts:16:// SPIKE: retention pad — the runtime's recordExpiry stops skewMs before freshness does
supabase/functions/app-trust-tasks/status.ts:67:      // SPIKE: suppressed → 400 — unreachable with UnauthenticatedTransport; answered like trust-tasks-https, no oracle (L-11, C-45).
supabase/functions/app-trust-tasks/status.ts:74:        // SPIKE: retained error — a duplicate whose prior response was an error replays it at that code's status, not the binding's duplicate status (R6, L-10, C-45).
src/kit/files/lib/trust-signin.ts:206:  // SPIKE: shared origin — every app hosted on this origin (and every same-origin preview) can open this database and sign with any app's key (C-38).
src/kit/files/lib/trust-signin.ts:232:    // SPIKE: software custody — the 32-byte seed is stored as plain bytes in IndexedDB, readable
supabase/functions/app-trust-tasks/core.ts:5:// SPIKE: unsigned responses; local_vid is a label
supabase/functions/app-trust-tasks/core.ts:83:// SPIKE: in-isolate per-app rate limiter (120/min per isolate, not per source IP/DID; a transport 429, never auth/challenge:rateLimited; any APP_KEY holder can spend an app's budget) — C-46.
supabase/functions/app-trust-tasks/core.ts:319:    // SPIKE: audience is per service, not per app — every app shares recipient = localVid, so app binding rests on app_tt_challenges.app_id and the app-scoped replay record; the runtime answers wrongRecipient where binding 0.2 §3 says identityMismatch (C-48).
supabase/functions/app-trust-tasks/core.ts:388:  // SPIKE: consume-before-compare — the single atomic PATCH burns the challenge even on a
supabase/functions/app-trust-tasks/core.ts:392:  // SPIKE: expiry before mismatch — the atomic PATCH reports expired without the stored challenge, so challengeExpired wins over challengeMismatch (spec compares first; both refuse and burn) — C-44.
supabase/functions/app-trust-tasks/core.ts:410:  // SPIKE: self-enrolment — any fresh did:key becomes a full member of a trust-enabled app, no admin/invite/ACL step and no expiry (VTI-CLT-010/012/013/014); gated only by the rate limit (C-47).
supabase/functions/app-trust-tasks/core.ts:428:  // SPIKE: the auth/authenticate/0.3 #response is unsigned (spec requires a proof; recorded deviation, §1.2 / C-1).
supabase/functions/app-trust-tasks/core.ts:462:  // SPIKE: envelope checks not done — type syntax beyond S-41's exact-match dispatch, and ceremony/extCritical placement (C-43).
supabase/functions/app-trust-tasks/core.ts:608:// SPIKE: a hand-written draft-2020-12 subset validator (the 20 keywords above, no json-schema
supabase/functions/app-trust-tasks/index.ts:27:  // SPIKE: OPTIONS answers the CORS preflight (204); binding 0.2 §2 item 1 says 405.
exit 0
```

The C-49 minimums are met: `core.ts` 9, `status.ts` 2, `replay.ts` 1, `index.ts` 1, helper 2. Every phrase sits on its marker line, and each marker is at the site C-38 or C-43 to C-48 names.

### `grep -rn "Deno\." supabase/functions/app-trust-tasks/{core,challenges,replay,members,status}.ts`

```text
exit 1   (no matches)
```

### `git diff 6b68ea6… --stat` (working tree)

```text
 53 files changed, 9463 insertions(+), 22 deletions(-)
```

The new entries since REVIEW-1 are `REVIEW-1.md` and the loop's edits. It still includes the owner's uncommitted `.claude/settings.local.json` and `notes.md`, which are not implementation and were left untouched.

### `git diff 6b68ea6… -- supabase/functions/app-data/index.ts`

The same four hunks REVIEW-1 §1 quoted: `email: string | null` and `did` in `interface Member`, and `,did` in the two select lists and in `authVerify`'s returned member. Nothing else changed.

---

## 2. Coverage audit (rows added or re-graded by the loop)

| Row | COVERAGE says | Verdict | Reason |
|---|---|---|---|
| S-25 / C-41 | covered | **agree** | Nested keywords under all three single-schema positions, a map and `$defs` throw (`t/schema.test.ts:150`). The validator throws even when the value never reaches the nested keyword (`:165`, third case), which is the "asserts first" requirement and not an implementation detail. Looseness in the matcher is noted in §5. |
| S-42 / C-42 | covered | **agree** | P-256 is refused on both tasks with **zero P3 and P5** and no member (`t/core.authenticate.test.ts:589`; `t/core.challenge.test.ts:171`). Before the fix this was a 200 (REVIEW-1 Probe A), so the test would have caught the bug. The `#not-the-key` case asserts that the proof really names that method before posting (`:610`). |
| C-39 | covered | **agree** | The unit oracle is exact (`t/replay.test.ts:230`), and "the cap uses claim's `now`" is pinned separately (`:247`). The end-to-end test (`t/core.authenticate.test.ts:676`) asserts only an upper bound, which is acceptable alongside the exact unit test. |
| C-40 | covered | **agree** | The end-to-end tests assert 503 `unavailable`, `retryable: true`, the issuer, **exactly one P10**, and then 202 after recovery. That pins both "never 500" and the recorded residual. The unit tests check that the log carries no id and no digest. |
| C-43 | covered | **agree, against C-43 as written** | Every C-43 oracle is present, including zero P3/P5 and TZ independence. C-43 itself only specifies month 01–12 and day 01–31, so nothing pins hour, minute or offset ranges or day-of-month (R2-4). |
| C-37 | covered | **agree** | All six oracles are asserted, including "zero store calls" for invalid ids, and "no call ever uses the v1 key" by recording every store call. |
| C-38 | partial | **agree** | The header check is a proxy (§5). |
| C-44 / C-46 / C-47 | covered (marker only) | **agree** | The behaviour is unchanged, and the markers are grep-pinned. Whether the text is honest is a review matter (§0.3). |
| C-48 | partial | **agree** | `wrongRecipient` is not asserted, but it is present (`fn/core.ts:319`). |
| C-52 | covered | **agree** | Both steps and both fields are covered, plus "no second POST" and "`member_token` not written". |
| S-52 / N-10 | covered | **agree** | The region-scoped matcher has a self-check showing that out-of-region strays are refused. |
| C-50 | not testable here | agree | — |

No row is downgraded.

---

## 3. Security review (REVIEW-1 §3 questions, re-asked on `02ff917`)

- **3.1 Cross-app challenge.** Unchanged. It is still refused (`fn/challenges.ts` P3 is app-scoped; `t/challenges.test.ts:154-159`).
- **3.2 `app_key` before store reads.** Unchanged in order. The compare is now `constantTimeEqual` (`fn/core.ts:196`). The rate limiter still runs before the key check, which matters for R2-3.
- **3.3 Present-but-unverified proof.** Still impossible. The verifier chain only got stricter (`fn/core.ts:256-283`): a `false` at any layer becomes `proofInvalid` (`rt/consume.ts:425-446`), and no layer can throw. `DidKeyMethodVerifier` reads `doc.issuer` and `doc.proof.verificationMethod` defensively (`:278-280`).
- **3.4 Challenge compare.** Unchanged.
- **3.5 Error leakage.** Nothing new reaches the wire. `release_failed` logs only `{status}` (`fn/replay.ts:150`). The C-43 messages are constants (`fn/core.ts:471`).
  - One new indirect path exists. A schema-keyword value of the wrong type (for example `required: "a"`) would throw a `TypeError` inside `checkSchema`, and its text would reach the producer through OVTC-47. That is not reachable with the pinned schemas (R2-6).
- **3.6 Key material on the wire.** None. The C-52 changes only read responses.
- **3.7 Clock seam.** `grep "Date\.now\|new Date()"` over `fn/*.ts` and the helper still finds only the seams themselves (`fn/index.ts:15`, `helper:358`). The cap uses `claim`'s `now` (`fn/replay.ts:88, 167`).
- **3.8 Replay-guard failure paths.** Fixed as specified (R1-2, N-11). The residuals are recorded: a stuck in-flight record after a failed P10, and 202 after two P9 failures.
- **3.9 Retention.** Capped (R1-5). Probe D found a pre-existing boundary millisecond (R2-7).
- **3.10 Self-enrolment.** Recorded (C-47).
- **Shared origin.** Code-side mitigation (per-app keys) and the risk statement are done. Impersonation by any same-origin script remains, by owner decision. It is enforceable only by the trial-only enablement rule (C-38), which lives only in the Changelog and in a future FINDINGS (R2-1).

---

## 4. Regression review of the loop's diff

### 4.1 Per-app identity: key derivation, races, migration

- **Derivation** (`helper:202-208`). The id is validated before any store access (`:212`). Trimming and lower-casing only *merge* spellings of one id. They cannot make two different apps share a key unless their ids differ only in case or surrounding whitespace, which is impossible for `cloud_apps.id` uuids. `signIn` puts the raw `appId` in the URL (`:362`) and the normalised one in the key. That is consistent, because Postgres `uuid` input is case-insensitive.
- **Race.** **Probe C:** `Promise.all` of two `getOrCreateIdentity({appId:'app-1'})` calls over a store with a 5 ms `get` returned two different DIDs, and the store kept the second. The first caller had already signed with the first DID, so the device ends up with a member row it can never use again. This is N-9, which D declined (§0.2). Nothing the loop added makes it worse, except that a double-click now triggers it for one app as readily as two tabs did before.
- **Migration from v1.** None, by design: C-37 says no v1 identity was ever deployed. That holds: the helper exists only on this unmerged spike branch, and Phase 5 has not run. Any developer browser that ran the v1 helper still has an orphaned `rb.trust-signin.identity.v1` entry in `rb-trust-signin`. That entry is harmless: nothing reads it, and its DID belongs to no deployed app. No item.

### 4.2 Retention-cap arithmetic (`fn/replay.ts:159-168`)

- `until_at = min(retainUntil + pad, now + window + 2·skew)`. Freshness accepts while `issuedAt + window + skew ≥ now'` and `issuedAt ≤ now + skew` (`rt/freshness.ts:132, 143`). The last instant at which an accepted document can be re-presented is therefore `now + window + 2·skew`, and the cap equals it.
- The proof depends on `issuedAt` being present, which `CONSEQUENTIAL_FRESHNESS.requireIssuedAt: true` guarantees (`rt/freshness.ts:77`; `authenticateChecks` spreads it, `fn/core.ts:502`).
- **Without that flag the cap would open a replay hole.** `validateFreshness` places *no* window bound on a document that has `expiresAt` but no `issuedAt` (`rt/freshness.ts:149-155`). **Probe E:** such a document was accepted now and again a year later. The coupling is implicit. If anyone ever relaxes `requireIssuedAt`, they break the guard. The guard's `DEFAULT_SKEW_MS` is likewise coupled only by equality to `CONSEQUENTIAL_FRESHNESS.skewMs` (`rt/freshness.ts:75`). Folded into R2-7, and reported upstream as OVTC-51.
- `Math.min` with finite inputs cannot yield `NaN`, and `toISOString` stays in four-digit years. **Probe:** the end-to-end 9999 case gives a plain `…Z` string (also `t/core.authenticate.test.ts:676`).
- **The boundary millisecond is pre-existing, not new** (R2-7). **Probe D:** with no `expiresAt`, `until_at = issuedAt + 360 s`. A resend at exactly `issuedAt + 360 s` passes freshness (stale only when `<`), the guard treats the row as expired (`until_at ≤ now`, `fn/replay.ts:191`; spec S-22 step 3), deletes it (P7), re-claims, and **the handler runs again** (P3 issued). What stops a second session is only the single-use challenge (`422 challengeNotFound`, sessions still 1). The cap reproduces the same edge at `now + window + 2·skew` (same probe with `expiresAt` 9999 and `issuedAt = now + skew`). One millisecond later both cases give 422 `expired` with no handler run.

### 4.3 `release` totality, the P9 retry, and double-recording

- **`release`** (`fn/replay.ts:135-154`) cannot throw. `restUrl` is pure, `fetch` (synchronous throw or rejection) is inside `try`, and the log call is inside its own `try`.
- **P9 retry** (`:106-127`) reuses one `RequestInit` whose body is a string, so it is re-sendable.
- **Double-recording.** If the first PATCH committed but its answer was lost, the retry writes the same `{response}` to the same `(doc_id, app_id)` row. It is idempotent.
- **Release and record never both happen for one claim.** The runtime calls `release` only for a retryable refusal and `settle` otherwise (`rt/consume.ts:532-540`).
- **What is not done.** When both P9 attempts fail, the guard throws and the runtime swallows it silently (`rt/consume.ts:559-563`, whose comment says "Guards should log their own failures"). The OVTC-43 stuck-in-flight state therefore leaves no log line (R2-9).

### 4.4 Schema walker recursion and fail-closed behaviour (`fn/core.ts:590-606`)

- **Recursion.** Recursion follows only the schema object, which is bundled and finite. It does not follow `$ref`, so recursive `$defs` cannot loop the walker. The validator's `$ref` resolution (`:626-629`) recurses with *payload* depth, but no pinned schema has a self-referential `$def`. Unchanged and not reachable.
- **Fail-closed holds for object sub-schemas.** For **non-object** values at schema positions, the walker returns silently (`:591`).
  - Array-form `items` (`{items:[{enum:["a"]}]}`), array-valued `properties`/`$defs`, and wrong-typed keyword values (`required:"a"`, `type:["string","null"]`) all pass `assertSchemaSupported`.
  - The validator then fails closed for most of them: `checkSchema(array, …)` is `false`, and a `type` array never matches. Two do not:
    - `{items:[…]}` against `[]` returns `true`.
    - `required:"a"` throws a `TypeError`, whose text OVTC-47 forwards to the wire.
  - C-41's "an unsupported keyword anywhere therefore throws" is false for keywords inside an array-form `items`.
  - Not reachable with the pinned schemas, but this is the same class of guard-against-a-pin-bump that R1-3 was about (R2-6).

### 4.5 `DidKeyMethodVerifier` chain order and what it rejects (`fn/core.ts:256-283`)

- **Chain:** `PurposeCheckingVerifier` → `DidKeyMethodVerifier` → `DataIntegrityProofVerifier(eddsa-jcs-2022)`. Cheap string checks run first, and every layer returns `false` rather than throwing, so any refusal is a constant `proofInvalid`. The order has no security effect, because all three must pass.
- **It rejects:**
  - non-`did:key` issuers;
  - an absent issuer while a proof is present;
  - any `verificationMethod` other than `issuer#<multikey>`, which includes a bare DID with no fragment (**Probe F:** a challenge proof with `verificationMethod: did` → 422 `proofInvalid`) and a foreign fragment (T's test);
  - via the inner verifier, P-256 and P-384.

  An issuer whose own string contains `#` cannot pass: the method would have to be `did:key:X#Y#X#Y`, and the inner verifier binds `split("#")[0]` to the issuer.
- **It does not reject anything legitimate.** The helper and the producer both emit `did#<multikey>` (`t/core.authenticate.test.ts:616`).
- **One observation for OpenVTC.** This consumer is stricter than our own OVTC-46 suggestion, which allowed an absent fragment. That is consistent with C-42, and no item is needed.

### 4.6 Strictness of the RFC 3339 check (`fn/core.ts:535, 574-580`, applied at `:470-472`)

**Probe A**: each value goes through `checkFrameworkShape`, then through the full authenticate path with the clock set to the parsed instant.

| `issuedAt` | Shape check | Runtime `Date.parse` | End to end |
|---|---|---|---|
| `2031-03-04t05:06:07z` (lowercase) | pass | same instant | 200 (RFC 3339 §5.6 permits lowercase: fine) |
| `…T05:06:07.123456789Z` | pass | truncated to ms | 200 (fine) |
| `…T05:06:07-00:00` | pass | UTC | 200 (fine) |
| `…T05:06:07+23:59` | pass | parsed | 200 (fine; a valid offset) |
| `…T23:59:60Z` (leap second, **valid** RFC 3339) | pass | `NaN` | 400 `malformedRequest`, runtime message "not a valid RFC 3339 timestamp" |
| `…T25:00:00Z`, `…T05:60:00Z`, `…+24:00`, `…+99:99` | **pass** | `NaN` | 400 from the runtime, not from C-43 (still before P3/P5) |
| `…T24:00:00Z` | **pass** | next day 00:00 | **200, session created** |
| `2031-02-31T…Z`, `2031-04-31T…Z` | **pass** | **rolled to Mar 3 / May 1** | **200, session created** |
| `…+0200`, `2031-03-04 05:06:07Z` | refused | — | 400 (C-43) |

The REVIEW-1 problems (RFC 2822 accepted; the verdict depending on the host TZ) are closed. What remains:
- The regex does not range-check hour, minute, second or offset. Out-of-range values are caught only because V8 happens to reject them, and some impossible dates and times are accepted and normalised to a different instant.
- A valid leap second is refused.
- `isDateTime` is shared with the payload `format: "date-time"` rule, so the same leniency applies there.
- This matches C-43 *as written* ("month 01–12, day 01–31"), so it is primarily a spec gap (R2-4).

### 4.7 C-52 response checks in the browser helper (`helper:310-314`)

- The checks are correct and placed before any effect.
- `threadId === request.id` is right because the helper never sends `threadId` and the consumer uses `threadId ?? id`.
- Error bodies are classified before `answers` runs (`:335-337`), so a `trust-task-error` at 200 is still surfaced by its code.
- 202 and 204 are handled before parsing (`:323-325`).
- No regression: the S-61 end-to-end test against the real core passes.

### 4.8 Rate-limiter eviction (`fn/core.ts:93-106`)

**Probe B.** At a fixed `now`, hits were made with distinct ids:

| Hits | Wall time |
|---|---|
| first 9 000 | 1.0 ms |
| 9 000 → 10 000 | 0.1 ms |
| 10 000 → 11 000 | 38.7 ms |
| 11 000 → 20 000 | **399.9 ms** |

The final map size was **20 000**. Once the map reaches `MAX_BUCKETS` within a window, nothing is evictable, the map keeps growing, and every new id scans the whole map, so the cost is quadratic over a window. After the window closed, one hit evicted everything (size 1).

The key is the unauthenticated `app_id`, and the limiter runs before the lookup, so this is reachable with no credentials. The cost is about 3 ns per entry per new id: real, but small per request. N-3 is not closed, and the change makes the per-request cost worse than before under the same flood (R2-5).

### 4.9 `constantTimeEqual` on `app_key` (`fn/core.ts:196, 679-685`)

- The loop runs `max(len(a), len(b))` iterations, so its duration reveals the **longer** length. A caller sending a 1-character key measures the stored key's length.
- The unknown-app path (`app === null`) skips the compare entirely, so timing also distinguishes "no such app" from "wrong key". The 403 text is the same for both.
- `charCodeAt` past the end yields `NaN | 0 = 0`, and the length XOR keeps a prefix from matching.
- **Impact:** none. `APP_KEY` and `APP_ID` are both public in every generated app's `env.js`, which is why this was a consistency nit. Closed with this note, and no item.

---

## 5. Test quality

T's new tests mostly assert the requirement and not the implementation:
- They count calls by DESIGN §3 id (P3, P5, P9, P10), which is the spec's contract.
- They assert table effects (no member, one session).
- They prove preconditions inside the test, for example that the P-256 document really is `ecdsa-jcs-2019`, that the `#not-the-key` proof really names that method, and that the RFC 2822 string parses to exactly `now`, so the 400 cannot be staleness.
- `t/replay.test.ts:218-224` passes the new deps through a variable so the file type-checks before and after the change. That is a thoughtful touch for red-first tests.

**None passes vacuously on the current code.** I checked each against the pre-loop behaviour from REVIEW-1's probes. P-256 was 200, P3+P10 was 500, the 9999 `until_at` was `+010000…`, `items:{enum}` returned `true`, and RFC 2822 was 200. Each new test would have failed.

Weaknesses (R2-8):
- **The C-41 throw matcher is loose.** `t/schema.test.ts:161` matches `/enum|oneOf|const|not|anyOf/`. Any message containing "not" passes, including a crash such as `"x is not a function"` or `"is not iterable"`. It should assert the `unsupported schema keyword "<k>"` text with the exact keyword for each case. `:165-170` assert only that *something* throws.
- **The C-38 header test does not check for absence.** `t/nonfunctional.test.ts:89` checks for `/export/i` and `/same[- ]origin/i`. It does not assert that an unqualified "never leaves this device" is gone, which is the requirement's wording. COVERAGE calls it a proxy, which is honest, but it is cheap to tighten.
- **Untested new code.** The N-3 eviction (`fn/core.ts:96-98`) has no test. Nothing pins hour, minute or offset ranges, or day-of-month (R2-4).
- **A redundant loop.** The offset-less TZ test (`t/core.authenticate.test.ts:643`) mutates `process.env.TZ` at runtime. Node honours that, and the test is non-vacuous in UTC, because without the C-43 check Date.parse would read the value as `now` and the request would get 200. Because the rejection is regex-based, the loop over three zones adds nothing beyond the first. Harmless.

---

## 6. Protocol-compliance ledger (changes since REVIEW-1 §4)

| # | Deviation | Was | Now |
|---|---|---|---|
| L-4 | Expiry reported before mismatch | ❌ | ✅ `fn/core.ts:392`. The C-44 text understates the difference (R2-2) |
| L-9 | `wrongRecipient` vs `identityMismatch` | 📄 | ✅ `fn/core.ts:319` |
| L-10 | Retained error at its code's status | ❌ | ✅ `fn/status.ts:74` |
| L-11 | `suppressed` → 400 | 📄 | ✅ `fn/status.ts:67` |
| L-12 | Rate-limit axis / no `rateLimited` / budget DoS | ❌ | ✅ `fn/core.ts:83`. The text names the wrong precondition (R2-3) |
| L-15 | §7.2 item 1 partial | ❌ | ✅ Timestamps and `parentThreadId` are checked (`fn/core.ts:466-472`), and the rest is marked (`:462`). Residual leniency: R2-4 |
| L-16 | Subset validator unknown-keyword guarantee | ❌ hole | ✅ for object sub-schemas. Residual for non-object positions: R2-6 |
| L-20 | Retention unbounded | ❌ | ✔ Capped (`fn/replay.ts:165-168`) |
| L-21 | `ecdsa-jcs-2019` accepted | ❌ | ✔ `fn/core.ts:261` |
| L-23 | Shared-origin storage | ❌ | ✅ in code (`helper:206`). Spec body still claims VTI-CLT-006 (R2-1) |
| L-24 | Self-enrolment | ❌ | ✅ `fn/core.ts:410`. Not in §1.2 (R2-1) |
| L-26 | `session.id` stored nowhere | 📄 | 📄 unchanged (optional marker; D declined) |
| L-27 | Audience per service | ❌ | ✅ `fn/core.ts:319`. Not in §1.2 or §10 (R2-1) |
| **L-30** (new) | Replay record treated as expired at the exact last instant freshness still accepts. S-22 step 3 uses `until_at ≤ now` while freshness is stale only when `<` | — | ❌ not recorded. Pre-existing, preserved by the C-39 cap, and backstopped only by the single-use challenge (R2-7) |
| **L-31** (new) | `verificationMethod` restricted to the `did:key`'s own key | — | ✔ conformant with SPEC §4.7.3 item 3 (`fn/core.ts:278-281`) |

SPEC §7.2 items 1–11: item 1 is now partly done, with the rest recorded. Item 11 is correct except for the L-30 boundary millisecond and the recorded stuck-in-flight residuals.

---

## 7. Verdict

### **REVISE-SPEC**

There are no blockers. The code side of every REVIEW-1 blocker and should-fix item is done, and done correctly. I found no regression that creates a new security hole. The one should-fix item is D's: C-37 to C-52 were written only into the Changelog, so the spec body now contradicts both the code and itself on normative points, including the VTI-CLT-006 claim that R1-1 was about. The verdict goes to D because D is the earliest phase with an open should-fix.

- **R2-1 needs no T or I work.** It is a text edit, and no requirement changes. D can also apply the D nits R2-2, R2-3 (spec half), R2-4 and R2-7 in the same pass.
- **The T and I nits do not justify another loop on their own.** I recommend that I take R2-5, R2-6 and R2-9, T take R2-8, and both take R2-4's code and test side, only if D's pass already reopens those phases.
- This is the second review, so REVIEW-3 is the last (G4 hard stop).

**Counts: 0 blockers, 1 should-fix, 8 nits.**

#### Items for D (design)

- **R2-1 · should-fix · D. The REVIEW-1 amendments are not in the spec body, so the body contradicts the code.**
  - **Convention broken.** Every earlier amendment (C-2 to C-22, C-31, C-32, C-34) was applied in place with an *(Amended, C-n.)* note. C-37 to C-52 exist only in the Changelog. The stale body text:
    - S-60's heading still lists **VTI-CLT-006** as satisfied (`spec:365`), the exact claim R1-1 found false. Its signature still says "persisting under `IDENTITY_KEY`" (`spec:374`).
    - S-22 still says `until_at = retainUntil + retentionPadMs` and "`recordResponse` = P9 and throws on non-2xx. `release` = P10." (`spec:144, 154`).
    - S-25 has none of C-41's sub-schema rules (`spec:166-175`).
    - §1.2 (`spec:47-55`) contains none of the deviations that C-44, C-46, C-47 and C-48 say were "added to §1.2".
    - §9 items 4 and 6 (`spec:444-445`) are unchanged.
    - §10 (`spec:448-450`) lacks Increment 2's app-binding requirement.
    - NF-5 (`spec:458`) still states C-34's minimum.
  - **Why it matters.** §9 is the contract FINDINGS is written to, and FINDINGS is the spike's deliverable. A drafter following §9 as written would omit:
    - the shared-origin impersonation risk;
    - the trial-only enablement rule;
    - per-app origins as a production prerequisite;
    - self-enrolment.

    A reader of S-60 would believe custody is VTI-conformant.
  - **Fix.** Apply each C-37 to C-52 edit in place with *(Amended, C-n.)* notes, including:
    - the S-60 heading change;
    - the four §1.2 entries plus shared origin;
    - the §9 item 4 and 6 additions listed in C-50;
    - the §10 sentence;
    - the NF-5 text.

    No requirement changes, so T and I are unaffected.
- **R2-2 · nit · D.** C-44's "Only the code reported differs" is false. `challengeExpired` is `retryable: true` and `challengeMismatch` is `false` (task `spec.md:55-60`; `fn/core.ts:393-394`), so an expired-and-mismatched document gets a retryable refusal and its replay record is **released** (`rt/consume.ts:533-535`), where a plain mismatch is retained. State that retryability and the record's disposition also differ. Both are harmless, since a retry needs a new challenge anyway (OVTC-29).
- **R2-3 · nit · D + I.** C-46 and the marker at `fn/core.ts:83` say "anyone holding an app's public `APP_KEY`". The limiter is hit before the key check (`fn/core.ts:190` vs `:196`), so the **`app_id` alone** spends the budget, and a request with a wrong key counts too. Correct the precondition in C-46, in §9 item 4 and on the marker line. The S-40 order itself is not in question.
- **R2-4 · nit · D, then T and I.** The C-43/S-25 `date-time` rule is not RFC 3339.
  - **What is wrong.** It checks only month 01–12 and day 01–31. Hour 24, impossible dates (Feb 30/31, Apr 31) and out-of-range minutes, seconds and offsets pass the shape check. **Probe A:** `T24:00:00Z`, `2031-02-31` and `2031-04-31` were accepted and normalised to another instant (200 with a session). The others are refused only by the runtime's `Date.parse`. A valid leap second `:60` is refused.
  - **D:** define the rule fully: hour ≤ 23, minute ≤ 59, second ≤ 59 or 60, offset hour ≤ 23 and minute ≤ 59, and day ≤ days-in-month. Say whether leap seconds are accepted. Refusing them is fine, but say so, because the runtime refuses them anyway.
  - **T:** add those cases.
  - **I:** extend `isDateTime` (`fn/core.ts:574-580`).
- **R2-7 · nit · D.** **The replay record is dropped at the exact last accepted millisecond (L-30).**
  - **Cause.** The pad equals `skew`, which makes `until_at` equal to freshness's last accepted instant. S-22 step 3 and P7 treat `until_at ≤ now` as expired, while freshness is stale only when `issuedAt + window + skew < now`.
  - **Effect (Probe D).** At exactly that millisecond the identical document is re-claimed and its handler re-runs. Only the single-use challenge prevents a second session. The C-39 cap has the same edge.
  - **Also record** in S-22 that the C-39 cap is sound only because `requireIssuedAt` is true (§4.2).
  - **Fix.** Pad with `skew + 1 ms` (and cap at `now + window + 2·skew + 1 ms`), or make step 3 and P7 strict (`<`, `lt.`). T would add an exact-edge oracle.

#### Items for I (implementation), only if a phase reopens

- **R2-5 · nit · I.** The N-3 eviction does not bound the map, and it adds a full scan per new id once ≥ 10 000 (**Probe B:** 20 000 entries; 400 ms for 9 000 new ids past the cap versus 1 ms below it). Use a hard cap that drops the oldest insertion-ordered entries when full, or sweep at most once per window. Correct the IMPL-NOTES "N-3 done" line.
- **R2-6 · nit · I.** The C-41 walker silently accepts non-object values at schema positions:
  - array-form `items`;
  - array-valued `properties` and `$defs`;
  - wrong-typed keyword values such as `required:"a"` and `type:[…]`.

  `{items:[…]}` validates `[]` as `true`, and `required:"a"` throws a `TypeError` whose text reaches the wire (OVTC-47). Throw on anything but an object or boolean at a single-schema position, on anything but an object for a map, and on wrong value types for the 20 keywords (`fn/core.ts:590-606`). This is not reachable with the pinned schemas.
- **R2-9 · nit · I.** `recordResponse` throws after two failures, but nothing is logged (`fn/replay.ts:126`), and the runtime swallows it silently (`rt/consume.ts:559-563`). The OVTC-43 state ("every resend gets 202 for the record's life") is therefore invisible. Log `replay.record_failed {failure}` (no id) before throwing, like `release_failed`.

#### Items for T (tests), only if a phase reopens

- **R2-8 · nit · T.**
  - **C-41 matcher.** Tighten it to the `unsupported schema keyword "<k>"` text with the exact keyword (`t/schema.test.ts:161`). Assert the message in `:165-170` too.
  - **C-38 header.** Assert that the header no longer contains an unqualified "never leaves" (`t/nonfunctional.test.ts:89`).
  - **R2-5 limiter.** If R2-5 is done, add a test: the map size is bounded after N distinct ids in one window.

#### Not raised again

- **N-9** (identity race, Probe C) and **N-12** (unbounded body; module-load throw) stay open by D's decision. N-9 is recorded in §0.2 with my disagreement.
- **The `constantTimeEqual` length signal (§4.9).** No impact.

---

## 8. New OpenVTC feedback (for the OpenVTC developer's coding assistant)

Numbered after OVTC-49. Environment as in `OPENVTC-FEEDBACK.md`: `@openvtc/trust-tasks@0.26.29`, `@openvtc/trust-tasks-proof@0.1.3`, Node 24.15.0 under vitest. `RT/` = `trust-tasks-ts/src/_runtime/` at that version. Both bug items were probed.

### OVTC-50 · `bug` · Record expiry and freshness disagree on the boundary millisecond, so OVTC-7's suggested fix still allows one double execution

`validateFreshness` calls a document stale only when `issuedAt + maxAgeMs + skewMs < now` (`RT/freshness.ts:143`), so the instant `issuedAt + maxAgeMs + skewMs` itself is **accepted**. `InMemoryReplayGuard` treats a record as absent when `retainUntil <= now` (`RT/replay.ts:198, 209`).

OVTC-7 asked for `recordExpiry` to include `skewMs`. With that fix, `retainUntil` equals the last accepted instant, and at that one millisecond the guard has already dropped the record while freshness still accepts the document.

**Probe.** With `{skewMs: 60000, maxAgeMs: 300000}`, `validateFreshness` at `issuedAt + 360 000` → `null` (accepted), and at `+ 360 001` → `expired`. `InMemoryReplayGuard.claim('b', D, retainUntil = issuedAt + 360 000, now)` → `fresh`. The same claim at `now = issuedAt + 360 000` → **`fresh` again**. Our Postgres guard, which pads by `skewMs` to work around OVTC-7, showed the handler running a second time at exactly that millisecond.

OVTC-7's suggested regression test (`issuedAt + maxAgeMs + skewMs - 1`) does not reach this edge.

**Fix.** Make the two bounds agree. Either return `issuedAt + maxAgeMs + skewMs + 1` from `recordExpiry`, or have guards drop only when `retainUntil < now`, and document which convention `ReplayGuard` implementers must follow (`RT/replay.ts:90-93` says "past which", which reads as strict). Test at the exact edge.

### OVTC-51 · `docs` / `bug` · `maxAgeMs` does not bound acceptance when `issuedAt` is absent and `expiresAt` is present

`validateFreshness` returns `null` for a document with no `issuedAt` whenever `expiresAt` is present, even when the policy sets `maxAgeMs` (`RT/freshness.ts:149-155`). `recordExpiry` then returns that `expiresAt` (`:173-176`). Under any policy without `requireIssuedAt: true`, `maxAgeMs` is therefore not a maximum: the producer's `expiresAt` replaces it.

**Probe.** Policy `{skewMs: 60000, maxAgeMs: 300000}`, document `{expiresAt: "9999-12-31T23:59:59Z"}` with no `issuedAt`. `validateFreshness` → `null` now, and `null` again one year later. `recordExpiry` → year 9999.

**Why it matters.** A consumer that bounds its replay retention to its acceptance window, which is the natural fix for OVTC-44 and the one we applied, opens a replay hole under such a policy: the record ages out while the document is still accepted. We are safe only because we use `CONSEQUENTIAL_FRESHNESS` (`requireIssuedAt: true`).

**Fix.** Do one of the following:
- also refuse when `expiresAt - now > maxAgeMs + skewMs` if `maxAgeMs` is set; or
- document on `FreshnessPolicy.maxAgeMs` that it applies only to documents carrying `issuedAt`, and that a consumer capping retention must set `requireIssuedAt`.

Scope OVTC-44's suggested `min(…)` to the case where both timestamps exist, as it already says.

### OVTC-52 · `bug` (minor) · Two `Date.parse` behaviours beyond OVTC-45: impossible dates are rolled over, and a valid leap second is refused with a false message

This extends OVTC-45 with facts a strict-parser fix must handle.

- **Rollover.** V8's `Date.parse` accepts `2031-02-31T05:06:07Z` (→ March 3), `2031-04-31T…` (→ May 1) and `…T24:00:00Z` (→ next day). `validateFreshness` and `validateBasic` therefore treat them as valid timestamps for a different instant. A strict parser has to range-check the day against the month and the hour against 23. A regex alone is not enough; ours wasn't.
- **Leap second.** `Date.parse("…T23:59:60Z")` is `NaN`, so the runtime answers `malformedRequest` with "issuedAt is not a valid RFC 3339 timestamp" (`RT/freshness.ts:130`). RFC 3339 §5.6 allows `time-second` 60, so the message is false. Refusing leap seconds is reasonable, but the spec or the message should say that this is a policy.

**Probe.** Through our consumer, which pre-checks the RFC 3339 shape but not these ranges:
- `T24:00:00Z`, `2031-02-31` and `2031-04-31` each completed a sign-in (200);
- `T23:59:60Z` → 400 with the message above.

**Fix.** Fold these into the single RFC 3339 parser OVTC-45 proposes:
- range-check by month, with leap years;
- refuse hour 24;
- either accept `:60` as `:59.999` or refuse it with an accurate message;
- add these three cases to the conformance tests.

---

## D response

Design agent, 2026-10-28. Every C-37 to C-52 amendment is now in the `SPIKE-SPEC.md` body, and the REVIEW-2 nits are Changelog C-53 to C-59, also applied in the body. `DESIGN.md` §7 lists the behaviour changes; there are no §2 signature changes.

| Item | Disposition | Where |
|---|---|---|
| **R2-1** (should-fix) | **Done.** C-37..C-52 applied in place, each with an *(Amended, C-n)* note: §0 (VTI-CLT claim qualified), §1.1 items 3 and 8, **§1.2** (a new "Recorded deviations" list: shared origin with the trial-only rule and the per-app-origin prerequisite, consume-before-compare, expiry before mismatch, rate limiting, self-enrolment, per-service audience, plus pointers to the rest), §2 diagram, **S-22** (retention cap, `release` total, `recordResponse` retry), **S-25** (C-41 sub-schema walk, assert-first, own properties), S-30 (C-48), S-40 (C-46), S-41 (C-43), S-42 (C-42 verifier and method check), S-44 (C-44), S-47 (C-47), S-48, S-50 (C-45), **S-60** (heading no longer claims VTI-CLT-006 unqualified; signature and per-app storage from C-37; shared-origin statement, marker and header rule from C-38), S-61 (C-37 identity, C-52 response matching), S-63 (C-51 imports, C-50 pins note), **§9 items 4 and 6** (the full C-50 lists, with C-38's VTI-CLT-006 statement, the trial-only rule, per-app origins, and C-47's VTI-CLT-010/012/013/014), **§10** (C-48's Increment 2 app-binding sentence), **NF-5** (C-49's list, replacing C-34's). A whole-spec search for stale text (`VTI-CLT-006`, `IDENTITY_KEY`, `APP_KEY`, `retainUntil +`, `01–31`, `type-only`, the bare verifier construction, marker minimums) left only historical Changelog entries. A note after C-52 says they are applied and that the body, with C-53 onward, governs. | spec body; Changelog note after C-52 |
| **R2-2** (nit) | **Done, C-53.** C-44's false sentence is struck through and corrected in place. §1.2 and S-44 state that the code, the retryability and the replay record's fate differ (expired → retryable, released; mismatch → not retryable, retained), and that this is harmless. No behaviour change. | C-44, C-53, §1.2, S-44 |
| **R2-3** (nit) | **Done, C-54.** The precondition is the `app_id` alone, and a wrong-key request still spends the budget. Corrected in C-46, §1.2, S-40 and §9 item 4. NF-5: the rate-limiter `// SPIKE:` line must contain `per-app`, `rateLimited` and `app_id`, and must not contain `APP_KEY`. A new oracle in S-40 pins the behaviour (120 wrong-key requests, then a right-key one → 429). **I:** reword the marker. **T:** the marker rule and the oracle. | C-54, S-40, NF-5 |
| **R2-4** (nit) | **Done, C-55.** The `date-time` rule is fully specified in S-25 and applies to both the payload `format` and the envelope timestamps: day-in-month with Gregorian leap years, hour 00–23 (`24:00` refused), minute and second 00–59, offset hour 00–23 and minute 00–59. **Leap seconds are refused**, recorded as a deviation with a `// SPIKE: … leap second …` marker, because the runtime's `Date.parse` refuses them anyway with a false message. The oracles are in S-25 (unit) and S-41 (end to end, zero P3/P5). **T and I:** yes. | C-55, S-25, S-41, NF-5 |
| **R2-5** (nit, I) | **Spec basis added, C-57.** S-40 now bounds the limiter: at most `MAX_BUCKETS` buckets, evict the first by insertion order, re-insert a bucket on window reset, no full scan, with an oracle. The accepted consequence (an evicted app's count restarts under a > 10 000-id flood) is recorded. **I:** implement and correct the IMPL-NOTES "N-3 done" line. **T:** the oracle. | C-57, S-40 |
| **R2-6** (nit, I) | **Spec basis added, C-58.** S-25 now type-checks schema positions and the typed keywords' values, and fixes the unsupported-keyword message text, with oracles (`{items:[…]}` against `[]` must throw, `required:"a"` must throw an S-25 error, not a `TypeError`). | C-58, S-25 |
| **R2-7** (nit) | **Recorded as known behaviour, C-56, not fixed.** S-22 states the boundary millisecond (at the pad and at the cap) with the single-use challenge as the mitigation, and states that the cap is sound only while `authenticateChecks` keeps `requireIssuedAt: true`. S-42(d) repeats the `requireIssuedAt` requirement. §9 item 4 lists both. S-48 gains an oracle that pins the edge *and* the mitigation (`challengeNotFound`, one session; +1 ms → `expired`, no P3/P5). Rationale: the edge is one millisecond wide, the challenge already blocks a second session, and the upstream fix belongs to OVTC-50, so a spike-local `+1 ms` would diverge from whatever convention the runtime chooses. | C-56, S-22, S-42, S-48, §9 |
| **R2-8** (nit, T) | **No new spec needed, except the message text.** C-58 makes `unsupported schema keyword "<k>"` normative, so the C-41 matcher can assert it with the exact keyword. C-38's header rule ("must not say, without qualification, that the private key never leaves the device") was already normative and is now in S-60. The limiter test has its basis in C-57. | C-58, S-60, C-57 |
| **R2-9** (nit, I) | **Spec basis added, C-59.** After its second failed P9, `recordResponse` logs `replay.record_failed {failure}` (`"HTTP <status>"` or `"fetch rejected"`; no id, no digest; a throwing sink is swallowed), then throws as before. Oracle in C-59. | C-59, S-22 |
| N-9, N-12 | Unchanged (not raised again). N-9's disagreement is noted; the owner may revisit it after the trial. | — |

**Phases reopened.** T and I both have work: R2-3 (marker and oracle), R2-4/C-55, R2-5/C-57, R2-6/C-58, R2-7/C-56 (an oracle only, no code), R2-8 and R2-9/C-59. None changes a §2 signature.
