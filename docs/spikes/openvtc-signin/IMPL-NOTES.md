# IMPL-NOTES — implementation agent (I), OpenVTC sign-in spike

Progress log for Phase 3 (BRIEF-I.md §5). Updated per file as it goes green.

## Library-source notes

(none yet — files 1–2 implement only against DESIGN.md §3 and the test fixtures;
no library source beyond `GETTING-STARTED.md` was needed.)

## DESIGN §2 signature changes

(none yet — all implemented files keep the stub signatures from `DESIGN.md` §2 / Phase 1.)

## Blockers / test disputes

(none yet. Disputed tests, if any, are logged in `TEST-DISPUTE.md`.)

## Per-file

### 2. `replay.test.ts` → `supabase/functions/app-trust-tasks/replay.ts` (S-22, S-24)

- 16/16 green. `npx tsc --noEmit -p tsconfig.functions.json` clean (zero diagnostics).
- `replay.ts` contains no `Deno.` reference (only "No Deno globals", a hyphen/space,
  which the finish-line grep `grep -rn "Deno\."` does not match).
- One `// SPIKE:` comment (NF-5/C-34 ≥1): the app-scoped guard rationale.
- Implementation notes:
  - `PostgresReplayGuard` keeps the stub's signatures (`claim`, `recordResponse`,
    `release`, `DEFAULT_RETENTION_PAD_MS = DEFAULT_SKEW_MS = 60000`, `ReplayGuardDeps`).
  - `claim`: `retainUntil === undefined` throws before any write (fail-closed; §7.2
    bounds the record to the acceptance window — no window, no claim). Otherwise a
    2-attempt loop: P5 insert (`until_at = retainUntil + retentionPadMs`, body
    `{doc_id, app_id, digest, response:null, until_at}`, `return=minimal`); 201 →
    fire-and-forget P8 sweep then `{kind:'fresh'}`; 409 → `resolveConflict`; any
    other status throws.
  - `resolveConflict` (on a 409): P6 GET `?doc_id=eq.` (select `app_id,digest,response,
    until_at`, prefer absent). Precedence: any row owned by a *different* app →
    `conflict` (S-24, never touched); else no row for us → `retry` (raced delete);
    else our own row: expired (`until_at <= now`) → P7 delete `?doc_id=eq.&until_at=lte.`
    then `retry`; unexpired + different digest → `conflict`; same digest + response
    null → `duplicate{inFlight:true}`; same digest + response set →
    `duplicate{inFlight:false, priorResponse}`.
  - `recordResponse`: P9 PATCH `?doc_id=eq.&app_id=eq.` body `{response}`, `return=minimal`;
    throws on non-2xx. `release`: P10 DELETE
    `?doc_id=eq.&app_id=eq.&digest=eq.&response=is.null` (best-effort; scoped to this
    app's in-flight record only, so a completed record is never released).
  - P8 sweep deletes `until_at < now` (strict); fire-and-forget (`.catch(()=>{})`),
    a failed sweep must not fail the claim. P7 deletes `until_at <= now` (inclusive).
  - `// SPIKE:` is mandatory for `replay.ts` (NF-5 minimum ≥1); the others
    (`challenges`/`status`/`members`) are not.

### 1. `challenges.test.ts` → `supabase/functions/app-trust-tasks/challenges.ts` (S-20, S-21, S-23)

- 18/18 green. `npx tsc --noEmit -p tsconfig.functions.json` clean.
- `challenges.ts` contains no `Deno.` reference (finish-line grep clean).
- Implementation notes:
  - `issue`: 2-attempt loop; a 409 on `session_id` retries once with a fresh uuid
    then throws; any other non-2xx or a rejected fetch throws (S-21 store-failure rule).
    Body matches P2 exactly (`session_id, app_id, subject, challenge, expires_at`),
    `Prefer: return=minimal`. `subject` is `input.subject ?? null` so the no-subject
    case stores `null` (P2 body must carry the `subject` key).
  - `lookupAndConsume`: one atomic PATCH (P3) with
    `session_id=eq.`, `app_id=eq.`, `consumed_at=is.null` and `Prefer: return=representation`.
    `sessionId`/`appId` are `encodeURIComponent`-encoded once; the fake decodes PostgREST-style
    so `+ & = #` and spaces round-trip without a contract violation (S-12 / C-36).
    Expiry is strict `Date.parse(r.expires_at) < now.getTime()` (equality still `ok`).
    A rejected fetch or non-2xx throws; the handler turns that into `unavailable`.
  - `sweep`: fire-and-forget; a store failure must never take down the handler, so
    it swallows the error. Deletes `expires_at < now − 1h` (P4, `lt.`).
  - `generateChallenge`: 32 random bytes → base64url, no padding (43 chars).
    Uses `btoa` + manual `+/=`→`-_`/strip so the module stays Deno-free and
    byte-identical to `Buffer.from(...).toString('base64url')` (what the test expects).
  - `// SPIKE:` comment: not mandatory for `challenges.ts` (NF-5 minimums exclude it).

## Finish-line outputs (from §4)

(pasted after every file is green)
