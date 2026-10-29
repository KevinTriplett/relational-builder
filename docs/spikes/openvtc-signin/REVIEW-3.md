# REVIEW-3 — Trust Tasks sign-in spike, Increment 1 (Phase 4, final review, agent R)

Reviewed 2026-10-28 on branch `spike/openvtc-signin` at `1300518`. BASE_SHA is `6b68ea634f37a70e3a5ef3146d74a02072eda094`. This review covers the REVIEW-2 loop: D's body pass and C-53 to C-59 (`dd68367`, with `## D response` in `REVIEW-2.md`), T's tests (`65288de`), I's code (`5889ce6`) and notes (`1300518`). The regression review reads `git diff 590c701 HEAD -- src supabase tests` (8 files, +448 / −35; code is `core.ts` +87/−16 and `replay.ts` +7/−1; no `src/` change).

**This is the last review.** SWARM-PLAN Gate G4 makes `REVIEW-3.md` the hard stop: everything still open is listed in §5 "Open items for FINDINGS", and none of it is routed back for another loop.

Path shorthands are as in REVIEW-1 and REVIEW-2: `fn/` = `supabase/functions/app-trust-tasks/`, `rt/` = `node_modules/@openvtc/trust-tasks/src/_runtime/`, `up/` = `.spike-deps/dtgwg-trust-tasks-tf/`, `helper` = `src/kit/files/lib/trust-signin.ts`, `spec` = `docs/spikes/openvtc-signin/SPIKE-SPEC.md`, `t/` = `tests/app-trust-tasks/`.

**Probes.** I ran two throwaway vitest files and one Node script from a scratchpad directory outside the repo. A scratchpad vitest config reused the repo's `npm:` aliases and `tests/setup.ts`. The probes drove `subsetSchemaValidator`, `assertSchemaSupported`, `InMemoryRateLimiter`, `PostgresReplayGuard`, and `handleTrustTask` through `t/fake-postgrest.ts`, and walked the pinned payload schemas. The scratchpad directory has been deleted, and nothing in the repo was touched except this file. Results are quoted as **Probe A–E**.

---

## 0. Disposition

### 0.1 REVIEW-2 items

| Item | Status | Code / spec evidence | Test that pins it |
|---|---|---|---|
| **R2-1** (should-fix, D) C-37..C-52 only in the Changelog | **closed** | Applied in place with *(Amended, C-n)* notes: §0 (`spec:19`, VTI-CLT-006 qualified), §1.1 items 3 and 8 (`:38, :43`), §1.2 "Recorded deviations" (`:57-64`), S-22 (`:155-175`), S-25 (`:194-224`), S-30 (`:254`), S-40 (`:270-278`), S-41 (`:287-288`), S-42(b)/(d) (`:306, :308`), S-44 (`:338`), S-47 (`:367`), S-48 (`:376, :381`), S-50 (`:413`), S-60 heading and body (`:435-457`), S-61 (`:480-482`), S-63 (`:494-495`), §9 items 4 and 6 (`:530-550`), §10 (`:555`), NF-5 (`:563-570`). The Changelog note at `:786` says the body governs. §2 below found one remaining body/code disagreement (R3-1, nit). | Not testable (text). |
| R2-2 (nit, D) C-44 "only the code differs" | **closed** | C-44 struck through and corrected (`spec:752`); C-53 (`:792`); §1.2 (`:60`) and S-44 (`:338`) state that retryability and the record's fate differ. No code change; marker `fn/core.ts:396` unchanged. | Existing `t/core.authenticate.test.ts` S-44 "expired AND mismatched" and "retryable refusal releases the claim" tests (COVERAGE row C-53). |
| R2-3 (nit, D+I) DoS precondition is the `app_id` | **closed** | Marker `fn/core.ts:83` now reads "anyone who knows an app_id can spend its budget, even with a wrong key — C-46, C-54" and no longer contains `APP_KEY`. Spec: C-54 (`:793`), §1.2 (`:61`), S-40 (`:270`), §9 item 4 (`:537`). Order unchanged (`fn/core.ts:194` limiter before `:200` key compare). | `t/core.auth.test.ts:110` (120 wrong-key 403s, then right key → 429, no extra P1); `t/nonfunctional.test.ts:99` (marker phrases, no `APP_KEY`). |
| R2-4 (nit, D→T→I) `date-time` not RFC 3339 | **closed** | `fn/core.ts:579-599`: `daysInMonth` with Gregorian leap years; hour ≤ 23, minute ≤ 59, second ≤ 59 (leap second refused, marker `:595`), offset hour ≤ 23 and minute ≤ 59. `checkFrameworkShape` uses the same function (`:475`). Spec S-25 (`:211-216`). **Probe A** (§3.1) found no mismatch in 16 362 generated cases. | `t/schema.test.ts:193` (13 refused, 6 accepted); `t/core.authenticate.test.ts:689-713` (Feb 31, Apr 31, `T24:00` and `:60` → 400 naming `issuedAt`, zero P3/P5, no session); `t/nonfunctional.test.ts:106`. |
| R2-5 (nit, I) limiter unbounded within a window | **closed** (residual R3-2, R3-5) | `fn/core.ts:93-110`: delete-and-reinsert on window reset, evict `keys().next()` at the cap, no scan. IMPL-NOTES "N-3 done" line corrected (`IMPL-NOTES.md:463`). **Probe B**: size stays 10 000; 11 000 new ids past the cap take 11 ms (REVIEW-2: 400 ms for 9 000). | `t/core.auth.test.ts:135, :149` (bound, survivor, count). Eviction order and reset re-insertion are not pinned (R3-5). |
| R2-6 (nit, I) walker accepts non-object positions / wrong value types | **closed** (residual R3-3) | `fn/core.ts:611-676`: `checkKeywordValue` type-checks all 15 non-annotation keywords; maps are checked to hold only objects or booleans before recursion. **Probe C**: every C-58 case throws an `S-25:` `Error`. | `t/schema.test.ts:215-256` (11 schemas × assert and × 8–9 values for validate; not `TypeError`; never `true`; pinned schemas still pass). |
| R2-7 (nit, D) boundary millisecond (L-30) | **recorded, not fixed** (accepted deviation) | C-56 (`spec:795`); S-22 (`:161-162`); S-42(d) (`:308`); S-48 (`:376, :381`); §9 item 4 (`:542`). No code change, consistent with the D response's rationale (upstream OVTC-50 decides the convention). | `t/core.authenticate.test.ts:717` (`requireIssuedAt: true`), `:735` (edge: handler re-runs, `challengeNotFound`, one session), and the `+60 001` test (422 `expired`, zero P3/P5). |
| R2-8 (nit, T) loose matchers | **closed** | — | C-41 tests assert `unsupported schema keyword "<k>"` with the exact keyword (`t/schema.test.ts:154-186`); `t/nonfunctional.test.ts:90` asserts no unqualified "never leaves" sentence, with a self-check on concrete inputs (`:112`); limiter tests added (`t/core.auth.test.ts:135-165`). |
| R2-9 (nit, I) silent double P9 failure | **closed** | `fn/replay.ts:126-132`: `replay.record_failed {failure}` in its own try, then the unchanged throw. **Probe D**: `{failure:"fetch rejected"}` and `{failure:"HTTP 503"}`; a throwing sink still yields the guard's own error; a single failure logs nothing. | `t/replay.test.ts:308, 324, 333, 343` (unit and end to end; no id or digest in the log). |

**R2 totals: 9 items. 8 closed (2 with residuals carried as R3-2, R3-3, R3-5), 1 recorded as an accepted deviation (R2-7).**

### 0.2 REVIEW-1 items that REVIEW-2 left partly closed or open

| Item | Status now | Evidence |
|---|---|---|
| **R1-1** (blocker) shared-origin identity | **closed** | The code side was closed in REVIEW-2. The spec side is now done: §0 (`spec:19`), §1.2 shared-origin bullet with the trial-only rule and the per-app-origin prerequisite (`:58`), S-60 heading and "Shared origin" paragraph (`:435-457`), §9 item 6 (`:547-549`). Helper header (`helper:6-10`) and marker (`helper:206`) unchanged and honest. |
| **R1-6** unrecorded deviations | **closed** | §1.2 now lists C-38, C-44/C-53, C-46/C-54, C-47 and C-48, with pointers to C-43, C-45, C-55, C-56, C-59 and S-51 (`spec:57-64`). §9 item 4 (`:530-544`) and §10 (`:555`) carry the C-50 and C-48 additions. Every one has its marker (§1). |
| N-2 `PINNED_VERSIONS` advertised to every project | **closed as accepted** | S-63 (`spec:495`) and §9 item 4 last bullet (`:544`). No code change, by decision. Listed for FINDINGS. |
| N-3 limiter map unbounded | **closed** | By C-57 (R2-5 above). |
| N-9 concurrent first-call identity race | **open (declined by D)** | `helper:211-238` is unchanged: `get` → mint → `put`, last write wins. REVIEW-2 Probe C still applies (two concurrent calls → two DIDs, only the second stored). My disagreement stands: the fix is about 6 lines. Listed for FINDINGS. |
| N-12 unbounded body; module-load throw | **open (declined)** | `fn/index.ts:33-37` reads and parses the whole body with `req.text()` before the credentials are even checked, so it is reachable without an `app_id`. Listed for FINDINGS. |

---

## 1. Mechanical checks

### `npx vitest run`

```text
 RUN  v5.0.5 /Users/kevintriplett/Documents/Documents - Kevin’s MacBook Pro/BACKUP/PROJECTS/SOFTWARE/relational-builder

 Test Files  13 passed (13)
      Tests  286 passed | 6 todo (292)
   Duration  630ms (import 75%, tests 19%, transform 4%, setup 2%, worker 1%)

exit 0
```

The 6 todos are the real-Postgres migration checks (`t/migration.test.ts`), unchanged since REVIEW-1.

### `tsc --noEmit -p tsconfig.functions.json` · `tsc --noEmit -p tests/tsconfig.json` · `deno check fn/index.ts`

```text
exit 0 · exit 0 · Check supabase/functions/app-trust-tasks/index.ts — exit 0
```

### `npx eslint .`

```text
✖ 21 problems (20 errors, 1 warning)
```

This matches the baseline of 21. `npx eslint supabase/functions/app-trust-tasks tests/app-trust-tasks src/kit/files/lib/trust-signin.ts` prints nothing (0 problems in spike files).

### `grep -rn "// SPIKE:" supabase/functions/app-trust-tasks/ src/kit/files/lib/trust-signin.ts`

```text
supabase/functions/app-trust-tasks/replay.ts:16:// SPIKE: retention pad — the runtime's recordExpiry stops skewMs before freshness does
supabase/functions/app-trust-tasks/status.ts:67:      // SPIKE: suppressed → 400 — unreachable with UnauthenticatedTransport; answered like trust-tasks-https, no oracle (L-11, C-45).
supabase/functions/app-trust-tasks/status.ts:74:        // SPIKE: retained error — a duplicate whose prior response was an error replays it at that code's status, not the binding's duplicate status (R6, L-10, C-45).
supabase/functions/app-trust-tasks/core.ts:5:// SPIKE: unsigned responses; local_vid is a label
supabase/functions/app-trust-tasks/core.ts:83:// SPIKE: in-isolate per-app rate limiter (120/min per isolate, not per source IP/DID; a transport 429, never auth/challenge:rateLimited; anyone who knows an app_id can spend its budget, even with a wrong key) — C-46, C-54.
supabase/functions/app-trust-tasks/core.ts:323:    // SPIKE: audience is per service, not per app — every app shares recipient = localVid, so app binding rests on app_tt_challenges.app_id and the app-scoped replay record; the runtime answers wrongRecipient where binding 0.2 §3 says identityMismatch (C-48).
supabase/functions/app-trust-tasks/core.ts:392:  // SPIKE: consume-before-compare — the single atomic PATCH burns the challenge even on a
supabase/functions/app-trust-tasks/core.ts:396:  // SPIKE: expiry before mismatch — the atomic PATCH reports expired without the stored challenge, so challengeExpired wins over challengeMismatch (spec compares first; both refuse and burn) — C-44.
supabase/functions/app-trust-tasks/core.ts:414:  // SPIKE: self-enrolment — any fresh did:key becomes a full member of a trust-enabled app, no admin/invite/ACL step and no expiry (VTI-CLT-010/012/013/014); gated only by the rate limit (C-47).
supabase/functions/app-trust-tasks/core.ts:432:  // SPIKE: the auth/authenticate/0.3 #response is unsigned (spec requires a proof; recorded deviation, §1.2 / C-1).
supabase/functions/app-trust-tasks/core.ts:466:  // SPIKE: envelope checks not done — type syntax beyond S-41's exact-match dispatch, and ceremony/extCritical placement (C-43).
supabase/functions/app-trust-tasks/core.ts:595:  // SPIKE: leap second refused (ss = 60 fails, although RFC 3339 §5.6 allows it; the runtime's Date.parse rejects it anyway, OVTC-52) — C-55.
supabase/functions/app-trust-tasks/core.ts:679:// SPIKE: a hand-written draft-2020-12 subset validator (the 20 keywords above, no json-schema
supabase/functions/app-trust-tasks/index.ts:27:  // SPIKE: OPTIONS answers the CORS preflight (204); binding 0.2 §2 item 1 says 405.
src/kit/files/lib/trust-signin.ts:206:  // SPIKE: shared origin — every app hosted on this origin (and every same-origin preview) can open this database and sign with any app's key (C-38).
src/kit/files/lib/trust-signin.ts:232:    // SPIKE: software custody — the 32-byte seed is stored as plain bytes in IndexedDB, readable
exit 0
```

NF-5 as amended is met exactly: `core.ts` has **10** markers (the minimum is 10), and each phrase is on its marker line: the exact S-30 line, `consume-before-compare`, the unsigned `#response`, the subset validator, the rate limiter (`per-app`, `rateLimited`, `app_id`, no `APP_KEY`), `expiry before mismatch`, `envelope`, `self-enrolment`, `audience`, and `leap second`. `status.ts` has 2, `replay.ts` 1, `index.ts` 1, and the helper 2. IMPL-NOTES says `core.ts` "now has 11 markers". That is wrong: it has 10 (R3-6).

### `grep -rn "Deno\." supabase/functions/app-trust-tasks/{core,challenges,replay,members,status}.ts`

```text
exit 1   (no matches)
```

### `git diff 6b68ea6… --stat` (working tree)

```text
 54 files changed, 10599 insertions(+), 22 deletions(-)
```

This includes the owner's uncommitted `.claude/settings.local.json` and `notes.md`, which were left untouched.

### `git diff 6b68ea6… -- supabase/functions/app-data/index.ts`

The same four hunks as REVIEW-1 and REVIEW-2: `email: string | null` and `did: string | null` in `interface Member`, and `,did` in the two select lists and in `authVerify`'s returned member. Nothing else.

---

## 2. Spec consistency

**Verdict: the body is now coherent with the code and the Changelog, with one ordering disagreement (R3-1).** I re-read §0–§11 against `fn/*.ts`, the helper, and C-37..C-59.

- **§1.2 recorded deviations** (`spec:57-64`). Each bullet matches the code and has its marker:
  - shared origin (`helper:206`);
  - consume-before-compare (`fn/core.ts:392`);
  - expiry before mismatch, now with the correct retryability and record-fate text (`:396`);
  - rate limiting with the `app_id` precondition (`:83`);
  - self-enrolment (`:414`);
  - per-service audience and `wrongRecipient` (`:323`).

  The "also recorded elsewhere" pointer list (`:64`) names C-43, C-55, C-45, S-51, C-40/C-59 and C-56, and each target section says the same thing as the code. The unsigned `#response` paragraph (`:53`) is the first bullet, as the list says.
- **S-60** (`spec:435-457`). The heading now reads "VTI-CLT-001, -002, -004, -005; VTI-CLT-006 only against principals on other origins". The stale `IDENTITY_KEY` signature is struck through and superseded (`:446`). The C-37 per-app storage key, C-38 marker placement, and header rule all match `helper:1-10, 200-238`. Note: -003 (`did:key` identifier) is not listed in the heading but is met; §0 says "VTI-CLT-001…005", which includes it, so the two are consistent.
- **S-22** (`spec:151-175`). The retention cap formula, the `requireIssuedAt` dependence, the boundary millisecond, `release` totality, and the `recordResponse` retry and `record_failed` log all match `fn/replay.ts:84-187`. One disagreement remains in the claim algorithm (R3-1). Step 3 (own expired row → P7 delete → retry) is listed **before** step 4 (another app's row → `conflict`). The code checks the other app **first** (`fn/replay.ts:194`, before the expiry test at `:197`). For a row of app A that has expired and is then offered under app B, the spec's order gives B a P7 delete and a fresh claim, while the code gives B a 409 `idConflict`. The code agrees with S-24 ("a row written by app A, offered under app B with the same id, is `conflict` … whatever its digest", `spec:183`), so the spec contradicts itself and the code picks S-24. Both outcomes are safe. No test pins the cross-app expired case (`t/replay.test.ts:195` uses a live row).
- **§9** (`spec:523-551`). Item 4 now carries the full C-50 list plus C-53..C-56 and C-59. Item 6 carries the C-38 VTI-CLT-006 statement, the trial-only rule, per-app origins, and the C-47 VTI-CLT-010/012/013/014 statement. A FINDINGS drafter following §9 will no longer omit the shared-origin risk or self-enrolment. §9 does **not** ask for the declined nits (N-9, N-12) or for this review's new items. §5 below supplies them.
- **NF-5** (`spec:563-570`). It matches the code exactly (§1). The minimum of 10 for `core.ts` means removing any one marker fails `t/nonfunctional.test.ts:54`, which is intended.
- **Historical text with amendment notes.** S-40's first paragraph still lists the pre-C-6 order in prose (`spec:260`), §5's `CoreDeps` sketch predates C-22 (`:228-240`), and S-42 still shows `consequentialChecks(...)` (`:299`). Each is followed by an *(Amended, C-n)* note that supersedes it, which is the convention every earlier amendment used. These are not inconsistencies, and I raise no item.

---

## 3. Regression review (`git diff 590c701 HEAD -- src supabase tests`)

No `src/` file changed. The code changes are `fn/core.ts` (limiter, `isDateTime`, `checkKeywordValue`) and `fn/replay.ts` (`record_failed`).

### 3.1 `isDateTime` calendar and offset logic (`fn/core.ts:536, 579-599`)

**Probe A**, through `subsetSchemaValidator.validate({type:"string",format:"date-time"}, v)`. The second column is what `Date.parse` reads.

| Value | `isDateTime` | `Date.parse` |
|---|---|---|
| `1900-02-29T00:00:00Z` | **false** (correct: 1900 is not a leap year) | `1900-03-01` (rolled over) |
| `2000-02-29T00:00:00Z` | **true** (correct: divisible by 400) | same instant |
| `2400-02-29T00:00:00Z` | **true** (correct) | same instant |
| `2100-02-29T00:00:00Z` | false (correct) | rolled to `03-01` |
| `0000-02-29T00:00:00Z` | true (proleptic Gregorian year 0 is a leap year) | same instant; freshness then refuses it as stale |
| `…T05:06:07+00:00` | true | `05:06:07Z` |
| `…T05:06:07-23:59` | true | next day `05:05:07Z` |
| `…T05:06:07-24:00`, `…+00:60` | false | `NaN` |
| `…T05:06:07.Z`, a trailing `\n`, `+02031-…`, `2031-3-04…` | false | `NaN` |

Two exhaustive sweeps were also run:
- **Days.** Years 0001, 1900, 1996, 2000, 2023, 2024, 2100, 2400 and 9999; every month; days 00–32; offsets `Z`, `+00:00`, `-23:59` and `+14:00`. That is 14 256 cases, with zero disagreements against the true calendar, and no value accepted that `Date.parse` reads as `NaN`.
- **Times.** Hours 00–25, minutes and seconds in {0, 59, 60}, offset hours in {0, 23, 24}, offset minutes in {0, 59, 60}. That is 2 106 cases, with zero disagreements.

So every value `isDateTime` accepts is one `Date.parse` reads as the same wall-clock instant: the rollover REVIEW-2 found is gone.

**End to end.** An authenticate whose `issuedAt` is `2031-03-03T05:07:07-23:59` (the clock's instant, written at −23:59) → 200. `issuedAt: 1900-02-29T00:00:00Z` with the clock at `1900-03-01` → 400 `malformedRequest` "issuedAt is not an RFC 3339 date-time". The calls were P1, P2, P4, P1, with no P3 and no P5.

**Assessment: correct.** The regex is anchored, `$` without `m` admits no trailing newline, and the offset groups are only range-checked when present. The leap-second refusal is a recorded deviation with its marker. One cosmetic point: the comment above `DATE_TIME` (`:534-535`) still describes only the month check (R3-6).

### 3.2 The bounded limiter: eviction order and window reset (`fn/core.ts:93-110`)

**Probe B**, reading the private map:

- **Eviction is oldest-first.** After 10 000 ids at `t`, `id0` was hit 120 more times (the 121st returned `true`) and stayed first in the map. One new id evicted `id0`, and `id0`'s next hit returned `false` (count restarted), re-inserting it at the end. This is the accepted C-57 consequence, behaving as specified.
- **In-window hits do not reorder.** A hit within the window updates the bucket in place, so insertion order is window-start order, as C-57 says.
- **Window reset.** A hit at exactly `windowStart + 60 000` stays in the same window (`count: 2`, order `[a, b]`). At `+60 001` the bucket is deleted and re-inserted (`count: 1`, order `[b, a]`). That matches app-data's `> 60 000` semantics. A closed-window id re-hit at the cap is re-inserted without evicting anyone (size stays 10 000).
- **Cost.** 11 000 new ids past the cap take 11.2 ms, against 0.7 ms for the first 9 000. Per operation that is still O(1); the difference is `Map` delete churn.
- **Bypass arithmetic.** With 10 000 junk ids between bursts, app `V` got 360 requests through in one window (three bursts of 120) for 30 000 junk requests. That is the accepted C-57 consequence: to gain 120 requests, an attacker spends 10 000.

**New residual (R3-2): the map is bounded in entries, not in bytes.** The key is the raw, unauthenticated `app_id` query parameter (`fn/index.ts:39`), with no length or shape check before `hit`. **Probe B7:** 10 000 buckets keyed by 8 KB `app_id`s (each parsed through `URL.searchParams`, so not shared ropes) retained **≈ 95 MB** of heap. A Supabase edge isolate has a memory ceiling in that range, so an attacker who needs no credentials can push an isolate toward OOM. That would deny sign-in, and the email path is not affected because app-data has its own isolate. I did not verify the gateway's maximum URL length, so the size per key that is actually reachable is unconfirmed. This is not a regression: before C-57 the map had no bound at all. But C-57's "memory is bounded" claim is true only in entries.

### 3.3 `checkKeywordValue` completeness (`fn/core.ts:611-676`)

**Coverage against C-58.** All 15 non-annotation keywords in `SUPPORTED_SCHEMA_KEYWORDS` are checked:
- `items`, `propertyNames` and `additionalProperties`: a sub-schema;
- `properties` and `$defs`: an object of sub-schemas;
- `type`: one of seven names;
- `required`: an array of strings;
- `minLength`, `maxLength`, `minItems` and `minProperties`: a non-negative integer;
- `minimum`: a finite number (`NaN` throws, **Probe C8**);
- `pattern`, `format` and `$ref`: a string, with `$ref` also local.

The five annotations are unchecked, as C-58 allows. Map recursion runs only after the value check, so the `as object` cast at `:620` is safe. **C-58 is fully implemented.**

What C-58 does not cover (**Probe C**). None of these is reachable with the pinned schemas, and all are the same "guard against a pin bump" class as R1-3 and R2-6 (R3-3):

- **`pattern` is type-checked but never compiled at assert time.** `validate({type:"string", pattern:"("}, "x")` throws a native `SyntaxError: Invalid regular expression: /(/: Unterminated group` from `new RegExp` at `:711`, and `assertSchemaSupported({pattern:"("})` does not throw. The schema text would reach the wire through OVTC-47, which is exactly what C-58 set out to prevent (it named only `TypeError`).
- **`$ref` siblings are silently ignored.** `checkSchema` returns at `:697-701` as soon as it sees `$ref`. `validate({$defs:{A:{type:"string"}}, $ref:"#/$defs/A", minLength:5}, "a")` → **`true`**, and `{…, $ref, additionalProperties:false}` against `{evil:1}` → **`true`**. Draft 2020-12 applies sibling keywords alongside `$ref`, so this fails open. The pinned schemas have `$ref` siblings today, but only `description`, `$schema` and `$defs` (a walk of all four pinned schemas found 17 such nodes), so nothing is lost now. A pin bump that adds an assertion beside a `$ref` would be ignored without any error.
- **`pattern` is compiled without the `u` flag.** `^\p{L}+$` against `"abc"` → `false`. This fails closed. JSON Schema patterns are ECMA-262 with Unicode semantics. The pinned patterns are ASCII, so there is no effect today.
- **`format` values other than `date-time` are ignored.** `{format:"uri"}` passes anything. That is allowed (2020-12 treats `format` as an annotation by default), and the pinned schemas use only `date-time`. No item.

### 3.4 `record_failed` logging (`fn/replay.ts:110-133`)

- The log call is only on the path after both attempts have failed. A single failure followed by success returns at `:117` and logs nothing (**Probe D**, `g4`: 2 calls, no log).
- `failure` is the last attempt's failure: `"HTTP 503"`, or `"fetch rejected"` when the last attempt was the rejection. That matches the thrown text and T's reading 5.
- The detail is exactly `{failure}`. The id and the digest are in neither the log nor the thrown message.
- The sink is wrapped in its own `try`, so a throwing sink cannot replace the guard's error (**Probe D**, `g3`: the message is still "replay recordResponse failed twice (HTTP 503)").
- The runtime still swallows the throw (`rt/consume.ts:559-563`), so the OVTC-43 in-flight state remains. It is now visible in logs, which is all C-59 asked for.

**Correct.**

### 3.5 Tests added this loop

The tests assert the requirement, not the implementation. Three examples:
- The C-55 end-to-end tests first prove that `Date.parse` rolls the value over, so the 400 cannot be staleness.
- The C-58 tests run every schema against 8–9 values and exclude `TypeError` explicitly.
- `bucketsOf` finds the map by type, not by field name.

One gap: the C-57 tests pin the bound, the survivor and the count, but **not** which bucket is evicted or the reset re-insertion (R3-5). An implementation that evicted the *newest* existing bucket, or never re-inserted on reset, would pass all three. Probe B shows the current code is right. COVERAGE already marks C-57 `partial`, but for "no full scan", not for this.

---

## 4. Whole-spike security sweep

What each attacker can still do that is **neither fixed nor recorded**. Recorded items (shared origin, self-enrolment, the per-app budget DoS, per-service audience, unsigned responses, in-flight residuals, the boundary millisecond) are not repeated here.

**Hostile app (another hosted app, or a same-origin preview).**
- Everything material is recorded under C-38: it can use any app's device key, read `localStorage.member_token`, and so sign in as the user anywhere the device has joined.
- **Cross-app id squatting** is theoretically possible: `app_tt_replay.doc_id` is a global primary key (S-10), so app B's record for id X makes app A's later document with id X a 409 (S-24). It requires knowing a victim's random UUID document id before the victim sends it. A same-origin attacker could learn it, but that attacker can already sign as the victim. No item.
- Nothing new.

**Hostile member (holds a valid `did:key`, or none at all).**
- Cannot reach another member's session: the challenge is app-scoped, the subject is bound, the proof is Ed25519 with the `did:key`'s own method only, and the upsert is keyed on `(app_id, did)`.
- **Unrecorded:** the limiter memory pressure above, which needs no credentials (R3-2).
- **Unrecorded:** the unbounded body read before the credentials check (N-12, declined, but not in §9). A large or deeply nested JSON body costs parse, schema walk and JCS canonicalisation before any refusal.

**Network attacker or anyone who obtains a copy of a request.**
- TLS protects the exchange.
- `app_id` and `app_key` travel in the query string and so appear in access logs. Both are public anyway.
- **Unrecorded (R3-4): a retained authenticate response hands the `member_token` to anyone who re-presents the signed request.**
  - **Mechanism.** S-48 requires an identical resend to receive the retained `#response` "with the same `accessToken`" (`t/core.authenticate.test.ts:469`). `UnauthenticatedTransport` binds nothing to the presenter (DESIGN Q1). So for up to `until_at` (≤ window + 2·skew = 420 s with defaults, C-39), the signed request body is a bearer credential for a fresh session token.
  - **Who can get it.** Anyone who sees the request but not the response: request-body logging at a proxy, APM or error reporter (for example a Sentry breadcrumb), a HAR file attached to a support ticket, or a browser extension that observes requests.
  - **Binding.** Binding 0.2 §3 says as much in general ("a captured request body can be re-sent by anyone holding the token", `up/bindings/https/0.2/spec.md:140`). Replaying a retained result is a **SHOULD** (§5.1 item 4, `:160`), not a MUST. The binding's own `204` row ("completed execution for which no response was retained", `:78`) is the conformant alternative, and the helper already treats 204 as `noResponse`/retryable with new documents (S-61, `spec:477`).
  - **Impact today.** Nil in the trial (test identities). This is a design decision for production, not a code bug.
  - **Upstream.** `auth/authenticate/0.3` declares `exposure.discloses: none` although its response carries a usable session token (OVTC-53).

No other unrecorded path found. Re-checked from REVIEW-1 §3:
- app-scoped challenge and replay;
- the order of `app_key` and store reads;
- no present-but-unverified proof;
- the constant-time challenge compare;
- no error text with stored secrets (the schema `TypeError` path is closed; R3-3's `SyntaxError` path is not reachable);
- no key material on the wire;
- the clock seam (`grep "Date\.now\|new Date()"` still finds only `fn/index.ts:15` and the helper's `options.now` default).

---

## 5. Verdict

### **APPROVE** (with nits)

Every REVIEW-1 and REVIEW-2 blocker and should-fix item is closed in code and in the spec body, the loop introduced no regression, and the C-53..C-59 changes are correct on probing:
- the `isDateTime` sweeps found zero disagreements;
- eviction and reset behave as specified;
- C-58 is complete as written;
- `record_failed` is correct.

The remaining items are nits. By G4 they are not routed for another loop; they go to FINDINGS.

**Counts: 0 blockers, 0 should-fix, 6 nits.**

- **R3-1 · nit · D.** S-22's claim algorithm lists "own expired row → P7 → retry" (step 3) before "another app's row → `conflict`" (step 4). The code checks the other app first (`fn/replay.ts:194` before `:197`), and S-24 (`spec:183`) agrees with the code ("whatever its digest"). Swap steps 3 and 4 in S-22, or state that another app's row is `conflict` even when expired (it is swept by P8 later). No behaviour change, and no test covers the cross-app expired case.
- **R3-2 · nit · D + I.** The C-57 limiter is bounded in entries, not bytes. **Probe B7:** 10 000 buckets with 8 KB `app_id`s hold ≈ 95 MB in one isolate, reachable with no credentials. Pre-existing (worse before C-57). Closing it needs either a uuid shape check on `app_id` before the limiter (401/403; a spec change to S-40's order, which C-6 fixed to match app-data), or a limiter keyed on a bounded value (for example the first 64 characters, or a hash).
- **R3-3 · nit · I.** C-58 leaves two pin-bump holes in the subset validator:
  - `pattern` is not compiled in `assertSchemaSupported`, so an invalid pattern throws a native `SyntaxError` with the schema text at validate time (`fn/core.ts:711`; reaches the wire via OVTC-47).
  - Assertion keywords beside a `$ref` are silently ignored (`:697-701`; Probe C2/C3: `true` where 2020-12 gives `false`).

  Neither is reachable with the pins. Closing it: compile `pattern` (with `u`) at assert time and throw an S-25 error; refuse any non-annotation sibling of `$ref` at assert time.
- **R3-4 · nit (trial) · D.** The retained authenticate `#response` turns the signed request into a bearer credential for its replay lifetime (≤ 420 s). See §4. Production decision: either retain the response with `tokens` removed and answer duplicates of a completed authenticate with 204, which binding 0.2 §4 permits and the helper already handles, or bind duplicates to a transport identity (Increment 2's `sessionKey`). Recorded upstream as OVTC-53.
- **R3-5 · nit · T.** The C-57 tests do not pin *which* bucket is evicted (the oldest) or that a closed window re-inserts at the end. Evicting the newest existing bucket would pass all three tests (`t/core.auth.test.ts:135-165`). Probe B shows the code is right.
- **R3-6 · nit · I (docs).**
  - `IMPL-NOTES.md` (REVIEW-2 loop, C-55) says `core.ts` "now has 11 markers". It has 10, exactly the NF-5 minimum.
  - The `DATE_TIME` comment (`fn/core.ts:534-535`) still describes only the month check.

### Open items for FINDINGS

Everything not fixed at the G4 stop. Each has one line on its production impact. FINDINGS §9 item 4 already requires the first group. The second and third groups are **not** in §9, and the FINDINGS drafter should add them.

**Accepted deviations (recorded in §1.2 / §9, with markers)**

1. **Unsigned `auth/authenticate/0.3#response`; `local_vid` is a label** (C-1, S-30). Production: a client validating responses with `consumeInbound` rejects them; closing needs a service signing key and a resolvable `did:web`.
2. **Shared hosting origin** (C-38). Production: any same-origin script can sign in as the user to every app the device joined; per-app origins are a hard prerequisite; until then, trial-only enablement.
3. **Software custody fallback** (`helper:232`, opt-in). Production: the seed is readable by any same-origin script; acceptable only behind per-app origins.
4. **Consume-before-compare** (S-44). Production: a wrong guess burns the challenge; safe, a mild client-UX cost.
5. **Expiry before mismatch** (C-44, C-53). Production: a different code, retryability and record fate for an expired-and-wrong document; harmless.
6. **Rate limiting per app and per isolate, transport 429, budget DoS by `app_id` alone** (C-46, C-54). Production: anyone can lock an app's users out of sign-in (both paths) per isolate; needs a source identity and a shared limiter.
7. **C-57 eviction resets an app's count under a flood of more than 10 000 ids** (S-40). Production: the per-app limit is bypassable at about 83 junk requests per extra request; subsumed by item 6's fix.
8. **Self-enrolment** (C-47). Production: Sybil and storage growth; VTI-CLT-010/012/013/014 not met; needs an invite, admin or ACL step, or a low-trust tier with expiry.
9. **Audience per service, `wrongRecipient` vs `identityMismatch`** (C-48). Production: app binding rests on the challenge and replay rows; Increment 2 `sessionKey` proofs need their own app binding.
10. **Envelope checks not done** (`type` syntax, `ceremony`/`extCritical`; C-43). Production: none for these two tasks; it matters once a task uses them.
11. **Leap second refused** (C-55). Production: a producer stamping `:60` gets 400; negligible.
12. **Retained-error status and `suppressed` → 400** (C-45). Production: clients see a retained error at its own status; the binding is silent (OVTC-19).
13. **`OPTIONS` preflight → 204** (S-51). Production: needed by browsers; a binding gap (OVTC-19).
14. **Failed `release` or twice-failed `recordResponse` leaves a record in flight** (C-40, C-59; OVTC-42/43). Production: identical resends get 202 for up to 420 s; the helper retries with new documents; now logged.
15. **Boundary millisecond and the `requireIssuedAt` coupling** (C-56; OVTC-50/51). Production: one millisecond per document in which the handler re-runs (blocked by the single-use challenge); relaxing `requireIssuedAt` would open a replay hole.
16. **`auth/authenticate/0.2` not registered; no `sessionKey`; no bearer identity mapping; no discovery task** (§1.2, S-41). Production: the current OpenVTC browser plugin cannot sign in (Increment 2).
17. **`PINNED_VERSIONS` advertised to every framework project** (N-2, C-50). Production: prompt noise and a pin every project inherits; harmless.

**Declined review items**

18. **N-9: concurrent first-call identity race** (`helper:211-238`). Production: a double-click or two tabs on first sign-in mints two DIDs, and one member row becomes permanently unusable; fix with IndexedDB `add` plus a re-read on `ConstraintError`.
19. **N-12: body read and parsed before any credential check; unbounded size** (`fn/index.ts:33-37`). Production: unauthenticated CPU and memory cost per request; needs a size cap before `req.text()`.
20. **L-26: `session.id` stored nowhere** (S-47). Production: no introspection or revocation by session id; Increment 2's `auth/whoami` and `auth/revoke-session` need it stored.

**New in REVIEW-3**

21. **R3-1: S-22 step order vs S-24.** Production: none (doc only).
22. **R3-2: limiter bounded in entries, not bytes** (≈ 95 MB at 8 KB ids). Production: an unauthenticated memory-pressure DoS on an isolate; validate `app_id` shape before the limiter.
23. **R3-3: subset validator pin-bump holes** (`pattern` compile, `$ref` siblings). Production: a schema change in a pin bump could leak schema text or fail open; replace with a real validator (or close both) before bumping `@openvtc/trust-tasks`.
24. **R3-4: retained authenticate response is a bearer credential for re-presenters.** Production: a leaked request body (logs, HAR, error reporting) yields a session token for up to 420 s; retain without `tokens` and answer 204, or bind to a transport identity.
25. **R3-5, R3-6: test and doc nits.** Production: none.

**Also for FINDINGS (process, not code).** The fake PostgREST is a contract, not proof (6 migration todos; SWARM-PLAN §7). Phase 5's local real-Postgres run is the first check of it. The S-71 coupling between `TRUST_TASKS_LOCAL_VID` and `TRUST_TASKS_VID` must be in the operator notes.

---

## 6. New OpenVTC feedback

Numbered after OVTC-52. The environment is as in `OPENVTC-FEEDBACK.md` (`@openvtc/trust-tasks@0.26.29`, `@openvtc/trust-tasks-proof@0.1.3`). The upstream spec was read at `f42a6dc` (the pinned tag) and not re-checked at HEAD. I checked OVTC-1..52 for overlap: none mentions `exposure`, `discloses` or a credential in a retained response (OVTC-36 is about the error issuer in retained responses, not secrecy).

### OVTC-53 · `docs` / `bug` (spec) · `auth/authenticate/0.3` declares `exposure.discloses: none`, but its response carries a usable session token, and the duplicate rule replays it to any presenter

**The declaration.** `specs/auth/authenticate/0.3/spec.md:42-46` declares:

```yaml
exposure:
  discloses: none
  ingests: metadata
  actsAsSubject: true
```

The `#response` payload carries `tokens.accessToken` (examples at `:302`, `:334`). SPEC §7.3 item 14 (`SPEC.md:1076`) defines `discloses: secret` as "confidential material the caller retains, such as released credential material or a **usable session blob**", and `none` as "an acknowledgement or a determination only". An access token is the first, not the second. The rationale text discusses only `actsAsSubject` and the inbound identifiers.

**Why it matters to a consumer.** SPEC §7.2 item 11 and binding 0.2 §5.1 item 4 (**SHOULD** "answer a duplicate with the result the first execution produced") together make a consumer that retains the `#response` return the *same* access token to anyone who re-presents a byte-identical request within the record's life. Over a transport with no authenticated party (`UnauthenticatedTransport`, which these two tasks are designed for), that makes the signed request a bearer credential for the replay window. Anyone who sees the request but not the response can use it: request-body logging, HAR files, error reporters.

A consumer that decides what to retain by reading `exposure.discloses` (the purpose items 14 and 18 give the classes) is told there is nothing secret to protect. The task is still *consequential* via `actsAsSubject: true`, so freshness and replay rules apply. Only the confidentiality signal is wrong.

**Evidence.** Our consumer follows the SHOULD. Its test "re-sending the identical signed document → 200 with the retained `#response` (same `accessToken`), no new session row" passes. The document is the only thing presented, and the private key is not needed for the resend.

**Suggested fix.**
1. Declare `discloses: secret` on `auth/authenticate/0.3` (and 0.2, and any task returning a `TokenBundle`), with a rationale naming `tokens`.
2. Add one sentence to SPEC §7.2 item 11 or binding §5.1 item 4: where a task's `discloses` is `secret` and the transport authenticates no party, a consumer **SHOULD NOT** replay the retained response to a duplicate. Instead it SHOULD answer as "completed, no response retained" (binding `204`), or retain a redacted response. The producer's retry with a new document then obtains a new token through a new challenge.
3. Consider the same note in `ReplayGuard`'s documentation, since `recordResponse` stores the full response by default.

---

## D response

Design agent, 2026-10-29. The owner chose to fix **R3-2** and **R3-4** before the Phase 5 trial, in one short D → T → I pass with no further review. **R3-1, R3-3, R3-5 and R3-6 stay as FINDINGS items** (§5, items 21, 23 and 25). The amendments are Changelog **C-60 to C-62**, each applied in the `SPIKE-SPEC.md` body in the same commit. `DESIGN.md` §8 lists the §2 additions (`APP_ID_PATTERN`, `COMPLETED_RECORD`, and the export of `isErrorDocument`) and the behaviour changes.

| Item | Disposition | Where |
|---|---|---|
| **R3-4** (nit, trial) | **Fixed, C-60 (consumer) and C-62 (helper, confirmed with no code change).** I took the first production option: the guard never stores a success `#response`. `recordResponse` writes `COMPLETED_RECORD` (`{completed: true}`) for a success and writes an error document unchanged. In `claim`, only a stored error document becomes `priorResponse`. Any other non-null record (the marker, or a full success document left by an earlier build) is `{duplicate, inFlight: false}` with no prior, which S-50 already maps to **204 with no body**, as binding 0.2 §4 says for "duplicate of a completed execution for which no response was retained" (§5.1 item 4 permits it). **Retained errors are unchanged:** their messages are constant and name no DID, challenge or token, so replaying one discloses nothing. **The challenge task is unchanged:** it has no replay guard and retains nothing, and its response is a single-use nonce bound to the app and the subject, not a credential. This **replaces S-48's "same `accessToken`" oracle**; the exact test changes are below. **Helper:** `postDocument` already turns 202/204 into `noResponse` before reading any body, so the C-52 checks never run, nothing hangs, and no token is written. I kept it **retryable** rather than make it a non-retryable `transport` error: a new `signIn` with new documents does succeed, and binding §4 says a producer MUST NOT treat a 202/204 duplicate answer as a failed Trust Task. Accepted cost (DESIGN R14): a producer that loses the 200 and re-sends identical bytes must start again, and the first session row is orphaned until its TTL. OVTC-53 stands upstream unchanged; this consumer now does its suggestion 2 locally. | C-60, C-62; S-11, S-22, S-24, S-48, S-50, S-61, §1.2, §9 item 4 |
| **R3-2** (nit) | **Fixed, C-61.** S-40's order becomes: 401 → **`app_id` shape** → lowercase → 429 → lookup → disabled. An `app_id` that does not match `APP_ID_PATTERN` (the canonical 8-4-4-4-12 hex uuid, either case, which is what `cloud_apps.id uuid default gen_random_uuid()` serializes to) gets **403 `Unknown app or wrong key`**, with no limiter hit and no PostgREST call. I chose 403 over 400 to stay consistent with S-40: an unknown app is 403, the existing test already expects 403 for `not-a-uuid`, and a separate 400 would tell a prober "malformed" apart from "unknown". Every limiter key is now 36 characters, so C-57's entry bound is also a byte bound (at most 10 000 × 36 characters, against ≈ 95 MB in Probe B7). Lowercasing makes case variants of one uuid share a bucket, and it also keeps S-24's `app_id` comparison exact against PostgREST's lowercase output (an uppercase `APP_ID` used to make an app's own replay rows look like another app's, giving 409). **C-54's claim is unchanged** ("anyone who knows an `app_id`" still holds for a real one), so the limiter's `// SPIKE:` line keeps its text. `InMemoryRateLimiter` is not touched. | C-61; S-40, §1.2, §9 item 4 |

### Test changes T must make

**Existing assertions that change (C-60):**
- `t/core.authenticate.test.ts:469` "S-48 re-sending the identical signed document → 200 with the retained #response (same accessToken)…": `expect(again.status).toBe(200)` → `204`; `expect(again.body).toEqual(res.body)` → `toBeUndefined()`. Keep the session count (1) and `['P1','P5','P6']`. Retitle it as S-48 / C-60 "→ 204, no body".
- `t/core.authenticate.test.ts:481` "S-11 … response retained": `expect(app_tt_replay[0].response).toEqual(res.body)` → `toEqual({completed: true})`, and also assert that `JSON.stringify(app_tt_replay)` contains neither the `accessToken`, nor `session.id`, nor `"tokens"`.
- `t/core.authenticate.test.ts:518` window edge: `again.status` 200 → 204; `again.body` `toEqual(first.body)` → `toBeUndefined()`.
- `t/core.authenticate.test.ts:798` C-40 oracle 3: `again.status` 200 → 204; `again.body` `toEqual(first.body)` → `toBeUndefined()`. Add `app_tt_replay[0].response` `toEqual({completed: true})`.
- `t/replay.test.ts:78` "after recordResponse (P9), a duplicate returns {priorResponse, inFlight:false}": P9 body → `{response: {completed: true}}`; `claim` → `toEqual({kind: 'duplicate', inFlight: false})` plus `not.toHaveProperty('priorResponse')`.
- `t/replay.test.ts:184` (runtime-drive test): `priorResponse` `toEqual(first.response)` → `toBeUndefined()`; `executions` stays 1.
- `t/replay.test.ts:292` C-40 "P9 failing once … response is stored": `toEqual({done: true})` → `toEqual({completed: true})`.

**Existing assertion that changes (C-61):**
- `t/core.auth.test.ts:78` "S-40 unknown app, wrong key, or a non-uuid app_id → 403 (one P1 lookup)": remove `'not-a-uuid'` from the loop. Its `callIds() == ['P1']` and P1-query assertions would now fail, because a malformed id makes no call. Drop "or a non-uuid app_id" from the title. The case moves to the C-61 test.

**Unchanged (and checked):** the 409 re-signed test (`:493`), the retained-error test (`:535`), the 202 in-flight test (`:548`), S-24 (`:570`, and in `replay.test.ts`), C-56 (`:735`, `:745`), C-40 oracle 4 (`:813`), the release test in `replay.test.ts` (a stored marker is non-null, so it is still not released), C-59, the S-40 401 and 429 tests, C-54, C-57, S-50 `mapOutcomeToHttp`, and NF-5 (no marker added or changed).

**New tests:** the C-60 oracles (S-48, S-22: an error document stored and replayed; a pre-C-60 success row gives no prior and, end to end, 204 with no token; `COMPLETED_RECORD` is `{completed: true}` and frozen; P9's request body never contains the token); the C-61 oracles 1–6 (S-40); and the C-62 additions to `producer-helper.fixture.test.ts:266` (no `setItem`, exactly two fetches). Update the S-48 and S-61 rows in `COVERAGE.md`, and add rows for C-60 to C-62.
