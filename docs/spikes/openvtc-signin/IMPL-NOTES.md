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
