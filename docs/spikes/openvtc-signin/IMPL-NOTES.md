# IMPL-NOTES — implementation agent (I), OpenVTC sign-in spike

Progress log for Phase 3 (BRIEF-I.md §5). Updated per file as it goes green.

## Library-source notes

- **File 3 (S-25, the schema subset validator) required reading the real bundled
  schemas, which `GETTING-STARTED.md` did not point at.** They live in
  `node_modules/@openvtc/trust-tasks/dist/auth/challenge/0.1/payload.js` and
  `.../authenticate/0.3/payload.js` (a `src/` mirror exists too). What I needed:
  - `Ext` def = `{ type:'object', minProperties:1, additionalProperties:true,
    propertyNames:{ pattern:"^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)+$" } }` — the
    reverse-DNS `propertyNames` pattern accepts `org.relationalbuilder.cloud`
    (multiple `.`-segments) but rejects a bare `member` (no `.`).
  - `TokenBundle.expiresIn` = `{ type:'integer', minimum:1 }`, so `expiresIn:0`
    must fail.
  - The response schemas resolve through `#/$defs/Response` → `Session` /
    `TokenBundle` / `Ext`, all *local* `$ref`s. Every keyword the bundled schemas
    use is within the supported 20, so `assertSchemaSupported` must not throw on
    them.
  - The 4 red cases (`schema.test.ts` L44, L52/57, L87/94, L138/143/144/145) all
    route through `#/$defs/*` resolution or that `Ext`/`minimum` check, which is
    why the single `LOCAL_REF` bug below explained all of them.

## DESIGN §2 signature changes

(none yet — all implemented files keep the stub signatures from `DESIGN.md` §2 / Phase 1.)

## Blockers / test disputes

(none yet. Disputed tests, if any, are logged in `TEST-DISPUTE.md`.)

## Per-file

### 3. `schema.test.ts` → `supabase/functions/app-trust-tasks/core.ts` (S-25)

- 12/12 green via `npx vitest run tests/app-trust-tasks/schema.test.ts`.
- **Root cause of the 4 reds:** `LOCAL_REF` was a *groupless* regex
  (`/^#\/\$defs\/[^/]+$/`), so `LOCAL_REF.exec(ref)[1]` was always `undefined`.
  `checkSchema`'s `$ref` branch does `const m = LOCAL_REF.exec(schema.$ref);
  const target = m ? defs[m[1]] : undefined;` — with `m[1]` undefined, every
  `#/$defs/<name>` resolution fell through to `false`, failing every schema that
  resolves a local `$ref` (the challenge/0.1 examples, the authenticate/0.3
  response examples, the hand-built `$ref` case, and the `ext` namespace case).
  The `.test()` call site in `checkSchemaNode` was unaffected (it ignores capture
  groups), so the throw-cases kept passing — which is why it looked like 8/12.
- **Fix:** capture group on `LOCAL_REF` → `/^#\/\$defs\/([^/]+)$/`
  (`checkSchema` resolves `#/$defs/X` via `m[1]`). Type-neutral (a regex literal +
  two comment lines); Deno-free (rule 6 safe). No secondary keyword issue: traced
  all 4 red cases through the fixed validator against the real bundled schemas
  (see Library-source notes) — all resolve, `Ext`'s `propertyNames` pattern accepts
  `org.relationalbuilder.cloud` and rejects bare `member`, and `expiresIn:0` fails
  `minimum:1`.
- **Gates run this session:** `npx vitest run …/schema.test.ts` → **12 passed**.
  `npx tsc --noEmit -p tsconfig.functions.json` and the `Deno.` grep could not be
  run because the local Ollama classifier (`qwen3.8-impl-128k`, which gates Bash in
  auto mode) was returning 500s; both are verified-by-inspection as clean
  (the change is type-neutral and `core.ts` has no `Deno.` reference — read in full
  this session) and are re-checked at the §4 finish line.
- `// SPIKE:` comment present in the validator block (NF-5 minimum for `core.ts`).
- Status: **vitest green; commit + tsc/grep gates pending a healthy classifier.**

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
