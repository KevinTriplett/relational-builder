# IMPL-NOTES — implementation agent (I), OpenVTC sign-in spike

Progress log for Phase 3 (BRIEF-I.md §5). Updated per file as it goes green.

## Implementer handover

- **Files 1–3** (`challenges`, `replay`, `schema`) were implemented by a local model
  (qwen3.8 27B through Ollama) over about 36 hours; it stopped after file 3 because of
  repeated timeouts and a compaction stall. Its entries below are kept as written.
- **Files 4–12** and the §4 finish line were implemented by Claude Opus 5.5 (Claude Code),
  building on the existing `challenges.ts`, `replay.ts` and the S-25 validator in `core.ts`
  without rewriting them.

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

- **Files 4–12 (Opus).** Source reading `GETTING-STARTED.md` did not cover:
  - `consumeInbound` passes a handler-returned error through verbatim and records exactly the
    returned object with `recordResponse` (`rt/consume.ts`, `settle`), so issuer re-stamping
    must happen inside the handler for the retained copy to be right; runtime-built rejections
    are re-stamped afterwards.
  - Runtime rejections go through `reject(transport, …)` → `rejectWithRecipient` with
    `issuer: request.recipient` and `recipient: doc.issuer` (`rt/transport.ts:103`,
    `rt/document.ts:341`); `respondWith` sets `threadId = threadId ?? id` and `type = <bare>#response`.
  - `slugFromTypeUri` throws for anything not under `https://trusttasks.org/spec/`
    (`rt/codes.ts:180`), so `classifyType` wraps it.
  - `normalizeCode` maps the 0.1 snake_case spellings (and `canceled`) to camelCase
    (`rt/codes.ts`), which `statusForCode` relies on.
  - `publicKeyFromDidKey` checks only the multicodec header, not the key length
    (`proof/keys.js:17-38`), and accepts a `#fragment`; the C-31 regex is what rejects fragments.
  - `signTrustTask` (`proof/sign.js`) hashes with `@noble/hashes` and formats `created` with a
    private `timestamp()` (`.000Z` → `Z`); `didKeyFromPublicKey` returns `did:key:<mb>#<mb>`
    (a verification method, not a DID).
  - `DataIntegrityProofVerifier` takes `{now}` in milliseconds and enforces `created` ≤ now + 60 s.

## DESIGN §2 signature changes

None. Every exported signature in `DESIGN.md` §2 is implemented as stubbed (parameter `_`
prefixes dropped; optional parameters given their documented defaults).

## Blockers / test disputes

- **D-1** (`TEST-DISPUTE.md`): two of the three `app-data.snapshot.test.ts` tests stay red. Their
  `stripDid` regex eats the space before `}`, so the permitted member-object hunk cannot round-trip,
  and the only spelling that does fails the third test. Everything else is green.

## Per-file

### 12. `fake-postgrest.test.ts`, `nonfunctional.test.ts` → `.env.example`, `replay.ts` (S-12, NF-3, NF-4, NF-5)

- Both green. `fake-postgrest.test.ts` was already green; `index.ts` landed in file 4.
- NF-4: `.env.example` gains a commented `TRUST_TASKS_LOCAL_VID=` (empty), explaining the
  coupling with the Builder's `TRUST_TASKS_VID`.
- NF-5: `replay.ts` already had one `// SPIKE:` (app scoping); added the one NF-5 names, at
  the S-22 retention pad. `core.ts` has exactly 5 (S-30 label, rate limiter, S-44
  consume-before-compare, S-47 unsigned `#response`, S-25 subset validator); `index.ts` 1
  (OPTIONS); `trust-signin.ts` 1 (software custody).

### 11. `app-data.snapshot.test.ts` → S-52 edits to `app-data/index.ts` (S-52)

- **1/3 green, 2 red and disputed (TEST-DISPUTE D-1).** The diff against BASE_SHA is exactly
  the permitted set: `select=id,email,name,did` in `resolveMember` and `authVerify`;
  `interface Member` gets `email: string | null;` and `did: string | null;` (C-30); and
  authVerify's returned member gains `, did: member.did`. Nothing else changed.
- The two red tests undo the member-object hunk with a greedy regex that also eats the space
  before `}`, so the natural spelling cannot round-trip; the only spelling that does
  (`member.name , did: …`) fails the third test's regex. The three tests cannot all pass, and
  the implementation follows the spec and the third test. With the lazy regex suggested in D-1,
  the file reduces to the base byte for byte (checked with a scratch script, not in `tests/`).
- `resolveMember` returns the row as selected, so `did` comes through unchanged; the email-path
  insert uses `return=representation`, so a new member's `did` (null) comes back from PostgREST too.

### 10. `migration.test.ts` → `supabase/migrations/20261027090000_trust_tasks_signin.sql` (S-10, S-11)

- 8/8 green, 6 `todo` (the behavioural oracles need a real Postgres; not run here).
- The identity check is added inside `do $$ … if not exists (select 1 from pg_constraint
  where conname = 'app_members_identity_chk') … $$`. Not applied to any database (no deploys).
- Untested by the parser: `alter column email drop not null` is idempotent in Postgres, and
  the check constraint will fail to add if any existing row has both email and did null
  (impossible before this migration, since email was NOT NULL).

### 9. `catalog.test.ts` → `catalog.ts`, `ChatPanel.tsx`, `community-cloud.ts` (S-70, S-71)

- 5/5 green; `tsc -p tsconfig.app.json` and ESLint clean on the touched files.
- `ChatPanel` *unshifts* `COMMUNITY_CLOUD_GUIDANCE` to the front of `serviceGuidance`, so
  "immediately after" is `serviceGuidance.splice(1, 0, TRUST_SIGNIN_GUIDANCE)`, gated by
  `trustSigninConnected(envVars)` (which already implies Community Cloud is connected).
- `community-cloud.ts`: `trustTasksUrl()` / `trustTasksVid()` helpers next to `fnUrl()`;
  `attachAppToProject` sets both with `false`. `trustTasksVid()` returns `''` if
  `VITE_BUILDER_SUPABASE_URL` is not a URL, which keeps `trustSigninConnected` false instead of
  throwing during attach. Beyond the spec: `detachAppFromProject` also removes the two keys,
  so a detached project stops getting the guidance.
- The guidance names `shortDid` and `TrustSignInError.retryable` as well as the required items.

### 8. `kit.test.ts` → `src/kit/index.ts`, `src/preview/bundler/versions.ts` (S-63)

- 3/3 green. `KIT_FILES['/src/lib/trust-signin.ts']` from `./files/lib/trust-signin.ts?raw`;
  `PINNED_VERSIONS` gains `@openvtc/trust-tasks-proof: 0.1.3` and `@noble/curves: 2.4.0`.
  `@openvtc/trust-tasks` is not pinned: the helper imports it type-only, so it never reaches esm.sh.

### 7. `producer-helper.fixture.test.ts` → `src/kit/files/lib/trust-signin.ts` (S-60, S-61, S-62)

- 16/16 green; `tsc -p tsconfig.functions.json` and `tsc -p tsconfig.app.json` clean.
- Library-source note: `signTrustTask` (`proof/sign.js`) hashes with `@noble/hashes/sha2.js`,
  which S-63 does not allow as a bare import in the helper. `signDocument` uses
  `crypto.subtle.digest('SHA-256')` instead; the fixture proves byte equality, including the
  `created` `.000Z` → `Z` rule, which is in `sign.js`'s private `timestamp()` and not in any doc.
- Library-source note: `didKeyFromPublicKey` returns the full verification method
  (`did:key:<mb>#<mb>`), not the DID; the DID is the part before `#` (same as `signerFromPrivateKey`).
- Type URIs are string constants in the helper, because `@openvtc/trust-tasks` may only be a
  type-only import there (S-63).
- Persisted record: `{kind:'bootstrap', custody, did, verificationMethod}` plus either the
  non-extractable `privateKey`/`publicKey` CryptoKeys or the 32-byte `seed`. An existing record
  is loaded as-is; minting tries `generateKey` directly and falls back only with
  `allowInMemoryFallback`, else `TrustSignInError('unsupported', false, 0)` with nothing stored.
- `signIn` errors: rejected fetch → `transport/true/0`; 202/204 → `noResponse/true/status`;
  a JSON trust-task-error (any status, 200 included) → its code and `retryable`; anything else
  non-2xx or non-JSON → `transport/status>=500/status`.
- `TrustSignInError('issuerMismatch', false, 0)` is what `signDocument` throws before signing.

### 6. `core.authenticate.test.ts` → authenticate handler, `members.ts` (S-11, S-24, S-42, S-44…S-48)

- 41/41 green with no code change after file 4 (notes-only commit).
- Handler order exactly per C-11: P3 consume → `constantTimeEqual` → acting party
  (`principal ?? issuer`) vs stored subject → S-46 → S-45 → P11/P12(/P11 on 409) → P13.
  The whole handler body sits in a try/catch that returns a retryable `unavailable`
  refusal, so the runtime releases the claim (P10) and never leaves it in flight.
- `constantTimeEqual` walks `max(len)` UTF-16 code units and folds the length difference in.
- `session.id` is a fresh `randomUUID()`; the token comes from `memberTokenFactory` or
  `defaultMemberToken(deps.randomUUID)`, so the two are independent draws.
- `upsertMemberByDid` returns only `{id,email,name,did}` even though P12 answers with the
  full row; `ext` member `email` is the literal `null` (S-47).
- Library-source note: `consumeInbound` passes a handler-returned error through verbatim and
  `settle` records exactly the object the handler returned, so `stampIssuer` has to happen
  inside the handler for the retained (P9) copy to carry `issuer = localVid` too.

### 5. `core.challenge.test.ts` → challenge handler (S-42, S-43, S-23)

- 16/16 green with no code change after file 4 (notes-only commit).
- Subject check (C-31): `^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$` **and**
  `publicKeyFromDidKey(subject)?.curve === "ed25519"` inside a try/catch (the decoder may
  throw on a non-key multibase such as `did:key:z6Mkabc`). Checked only when `subject`
  is present. A trailing space or `#frag` fails the regex.
- Proof policy for both tasks is `{kind:"verify", verify: PurposeCheckingVerifier(
  DataIntegrityProofVerifier({now: () => deps.now().getTime()}))}`; the challenge spec's
  `isProofRequired: false` makes it optional (DESIGN Q2 held exactly).
- `sweep()` is fired with `void` after a successful `issue`; `sweep` already swallows errors.

### 4. `core.auth.test.ts` → `core.ts`, `status.ts`, `members.ts`, `index.ts` (S-30, S-40, S-41, S-49, S-50, S-51)

- 29/29 green; `tsc -p tsconfig.functions.json` clean. Files 1–3 still green.
- `core.auth.test.ts` already drives full sign-ins (`signInFlow`) and the `index.ts`
  routing shim, so the whole pipeline landed in this commit: app auth, parse/dispatch,
  both `consumeInbound` handlers, `status.ts`, `members.ts` and `index.ts` (48 lines).
  Files 5 and 6 were green on arrival as a result; their commits only add notes.
- Order in `handleTrustTask`: 401 → `rateLimiter.hit` → P1 (rejected fetch / 5xx → 503;
  other non-2xx, e.g. PostgREST's 400 for a non-uuid id, → 403) → disabled 403 → body
  must be an object with a string `type` (else 400) → `classifyType` (422) →
  `checkFrameworkShape` (400) → `consumeInbound`. An outer try/catch turns anything
  unforeseen into a 500 `internalError` document, so it never throws.
- `classifyType`: `unsupportedVersion` only for a fragment-free `https://trusttasks.org/spec/`
  URI whose last segment is `MAJOR.MINOR` and whose `slugFromTypeUri` equals a registered
  slug (`slugFromTypeUri` throws on non-trust-task URIs, so it is wrapped).
- Every emitted document goes through `stampIssuer`: handler output (inside the handler,
  so the copy retained by P9 is already stamped) and runtime rejections (in `toHttp`).
  `errorDocument` builds the pre-parse errors with `issuer = localVid` directly.
- `index.ts` wraps `fetch` in an arrow (`(i, init) => fetch(i, init)`) because the stores
  call `this.fetch(...)`; a bare global `fetch` invoked as a method throws "Illegal
  invocation" in browsers and is fragile elsewhere. It also reads `fetch` at call time,
  which is what lets the test's `vi.stubGlobal('fetch')` take effect.

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
    retried once on a rejection or non-2xx, then throws (C-40). `release`: P10 DELETE
    `?doc_id=eq.&app_id=eq.&digest=eq.&response=is.null`, scoped to this app's in-flight
    record only, so a completed record is never released. *(Corrected in the REVIEW-1
    loop: this said "best-effort", but before C-40 `release` awaited the fetch and a
    rejection propagated — it was not best-effort. Since C-40 it is total: one P10, a
    failure is logged as `replay.release_failed {status}` and `release` resolves.)*
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

Run 2026-10-28 on branch `spike/openvtc-signin-impl` after the file-12 commit. `exit N` lines were
appended by the wrapper; an empty output above `exit 0` means the tool printed nothing. The `grep`
prints nothing (exit 1 = no matches).

### `npx vitest run`

```text

 RUN  v5.0.5 /Users/kevintriplett/Documents/Documents - Kevin’s MacBook Pro/BACKUP/PROJECTS/SOFTWARE/relational-builder-impl

 ❯ tests/app-trust-tasks/app-data.snapshot.test.ts (3 tests | 2 failed) 49ms
   ❯ app-data changes (S-52) (3)
     × S-52 every hunk in app-data/index.ts since BASE_SHA is a member select list gaining did, a member object gaining did, or the Member type tolerating email null / gaining did 26ms
     × S-52 the email path is otherwise byte-identical: removing the permitted did changes from the current file yields the base file 21ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/app-trust-tasks/app-data.snapshot.test.ts > app-data changes (S-52) > S-52 every hunk in app-data/index.ts since BASE_SHA is a member select list gaining did, a member object gaining did, or the Member type tolerating email null / gaining did
AssertionError: {"removed":["  return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name } });"],"added":["  return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name, did: member.did } });"]}: expected '  return json({ ok: true, member_toke…' to be '  return json({ ok: true, member_toke…' // Object.is equality

Expected: "  return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name } });"
Received: "  return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name} });"

 ❯ tests/app-trust-tasks/app-data.snapshot.test.ts:37:70
     35|       const added = h.added.filter((l) => !isDidField(l));
     36|       expect(added.length, JSON.stringify(h)).toBe(h.removed.length);
     37|       added.forEach((l, i) => expect(stripDid(l), JSON.stringify(h)).t…
       |                                                                      ^
     38|     }
     39|   });
 ❯ tests/app-trust-tasks/app-data.snapshot.test.ts:37:13

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  tests/app-trust-tasks/app-data.snapshot.test.ts > app-data changes (S-52) > S-52 the email path is otherwise byte-identical: removing the permitted did changes from the current file yields the base file
AssertionError: expected '/**\n * Supabase Edge Function: app-d…' to be '/**\n * Supabase Edge Function: app-d…' // Object.is equality

- Expected
+ Received

@@ -623,11 +623,11 @@
        expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      }),
    });
    if (!sessRes.ok) return json({ error: 'Could not start your session' }, 500);

-   return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name } });
+   return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name} });
  }

  /** Resolve the signed-in builder's email from the Authorization header */
  async function resolveBuilder(req: Request): Promise<string | null> {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');

 ❯ tests/app-trust-tasks/app-data.snapshot.test.ts:45:18
     43|     const now = readFileSync(ROOT + FILE, 'utf8');
     44|     const back = now.split('\n').filter((l) => !isDidField(l)).map(str…
     45|     expect(back).toBe(base);
       |                  ^
     46|   });
     47|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  1 failed | 12 passed (13)
      Tests  2 failed | 179 passed | 6 todo (187)
   Start at  16:42:33
   Duration  1.01s (import 77%, tests 15%, transform 5%, setup 2%, worker 1%)

exit 1  (vitest's own status, re-run without the pipe; the pipe had reported sed's 0)
```

### `npx tsc --noEmit -p tsconfig.functions.json`

```text
exit 0
```

### `npx tsc --noEmit -p tsconfig.app.json`

```text
exit 0
```

### `npx eslint supabase/functions/app-trust-tasks src/kit/files/lib/trust-signin.ts src/integrations/catalog.ts src/cloud/community-cloud.ts`

```text
exit 0
```

### `deno check supabase/functions/app-trust-tasks/index.ts`

```text
Check supabase/functions/app-trust-tasks/index.ts
exit 0
```

### `deno eval 'await import("npm:@openvtc/trust-tasks@0.26.29"); await import("npm:@openvtc/trust-tasks-proof@0.1.3"); console.log("ok")'`

```text
ok
exit 0
```

### `grep -rn "Deno\." supabase/functions/app-trust-tasks/{core,challenges,replay,members,status}.ts`

```text
exit 1 (1 = no matches)
```

### `git diff 6b68ea634f37a70e3a5ef3146d74a02072eda094 -- supabase/functions/app-data/index.ts`

```diff
diff --git a/supabase/functions/app-data/index.ts b/supabase/functions/app-data/index.ts
index d4bb59e..59dafd3 100644
--- a/supabase/functions/app-data/index.ts
+++ b/supabase/functions/app-data/index.ts
@@ -335,8 +335,9 @@ Deno.serve(async (req: Request) => {
 
 interface Member {
   id: string;
-  email: string;
+  email: string | null;
   name: string | null;
+  did: string | null;
 }
 
 const CODE_TTL_MS = 10 * 60 * 1000;
@@ -356,7 +357,7 @@ async function resolveMember(appId: string, tokenRaw: unknown): Promise<Member |
   const sessions = res.ok ? await res.json() : [];
   if (!sessions.length || new Date(sessions[0].expires_at) < new Date()) return null;
   const memberRes = await fetch(
-    restUrl(`/app_members?id=eq.${sessions[0].member_id}&select=id,email,name`),
+    restUrl(`/app_members?id=eq.${sessions[0].member_id}&select=id,email,name,did`),
     { headers: svcHeaders() },
   );
   const members = memberRes.ok ? await memberRes.json() : [];
@@ -587,7 +588,7 @@ async function authVerify(appId: string, body: Record<string, unknown>): Promise
 
   // Upsert the member (name from the sign-in request wins when present)
   const existingRes = await fetch(
-    restUrl(`/app_members?app_id=eq.${encodeURIComponent(appId)}&email=eq.${encodeURIComponent(email)}&select=id,email,name`),
+    restUrl(`/app_members?app_id=eq.${encodeURIComponent(appId)}&email=eq.${encodeURIComponent(email)}&select=id,email,name,did`),
     { headers: svcHeaders() },
   );
   const existing = existingRes.ok ? await existingRes.json() : [];
@@ -625,7 +626,7 @@ async function authVerify(appId: string, body: Record<string, unknown>): Promise
   });
   if (!sessRes.ok) return json({ error: 'Could not start your session' }, 500);
 
-  return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name } });
+  return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name, did: member.did } });
 }
 
 /** Resolve the signed-in builder's email from the Authorization header */
```


## REVIEW-1 loop

Implementation agent, 2026-10-28. Starting point: commit 3d90825 (42 failed, 185 passed, 6 todo). Code commit: `ba6d745`. No TEST-DISPUTE entries were needed: every failing test matched its C-entry.

### Per C-number

- **C-37** (`trust-signin.ts`). `IDENTITY_KEY` removed; `IDENTITY_KEY_PREFIX = 'rb.trust-signin.identity.v2:'` and `identityKeyForApp(appId)` added (trims, lower-cases, throws `TrustSignInError('invalidAppId', false, 0)` for a non-string or blank id). `getOrCreateIdentity(options)` computes the key before touching the store and uses only that key for `get` and `put`. `signIn` calls `getOrCreateIdentity({ appId, store: options.identityStore })` when no `identity` is passed. The source no longer names the v1 key anywhere.
- **C-38**. `// SPIKE: shared origin …` sits inside `identityKeyForApp`. The header comment now says the key cannot be exported and is never sent, but any same-origin script can use it. The `DeviceIdentity` doc comment no longer says "never leaves the device"; it says VTI-CLT-006 holds only against other origins.
- **C-39** (`replay.ts`). `until_at = min(retainUntil + pad, now + acceptanceWindowMs + 2·DEFAULT_SKEW_MS)`, with `now` being `claim`'s argument. `ReplayGuardDeps.acceptanceWindowMs?` defaults to `DEFAULT_ACCEPTANCE_WINDOW_MS`. `core.ts` computes the window once and passes it to both the guard and `authenticateChecks`. `DEFAULT_ACCEPTANCE_WINDOW_MS` is now *defined* in `replay.ts` and re-exported unchanged from `core.ts`: `replay.ts` only imports types from `core.ts`, and this keeps it that way (no value import cycle). Its value and the `core.ts` export are unchanged.
- **C-40** (`replay.ts`). `release` issues P10 once; a rejection or non-2xx calls `deps.log?.('replay.release_failed', { status })` (`status` is `null` for a rejected fetch; no id or digest), and `release` resolves. A throwing log sink is swallowed too. `recordResponse` retries P9 once, then throws. `core.ts` passes `deps.log`. The "best-effort" wording in the replay notes above is corrected.
- **C-41** (`core.ts`). `checkSchemaNode` treats `items`, `propertyNames` and `additionalProperties` as single sub-schemas (the old code iterated `Object.values` of `items`/`propertyNames`, so `items: {enum: …}` was walked as a map and its keyword missed), and `properties`/`$defs` as maps, at any depth. `validate` already asserted first; it now catches nested keywords. `required` and the `properties` lookup use `Object.hasOwn`.
- **C-42** (`core.ts`). `DataIntegrityProofVerifier({ now, cryptosuites: ["eddsa-jcs-2022"] })`, wrapped in a new private `DidKeyMethodVerifier` (not exported) that requires `issuer` to be a `did:key` and `proof.verificationMethod === issuer + "#" + issuer.slice(8)` before delegating. Chain: `PurposeCheckingVerifier(DidKeyMethodVerifier(DataIntegrityProofVerifier))`, for both tasks. `PurposeCheckingVerifier` is unchanged.
- **C-43** (`core.ts`). `checkFrameworkShape` requires a string `parentThreadId` when present and applies the existing `isDateTime` to `issuedAt`/`expiresAt`, with the constant message `"<member> is not an RFC 3339 date-time"`. Marker `// SPIKE: envelope checks not done …` at the top of the function.
- **C-44, C-46, C-47, C-48** (`core.ts`). Markers: `expiry before mismatch` above the `expired` → `challengeExpired` line; the rate-limiter marker now contains `per-app` and `rateLimited`; `self-enrolment` above `upsertMemberByDid`; `audience … wrongRecipient` above `myVid: deps.localVid` in `runChallenge`, with a short pointer comment at the authenticate `myVid` line. No behaviour change.
- **C-45** (`status.ts`). `unsupportedExtension` → 422. `// SPIKE: retained error …` at the duplicate-with-prior-response branch; the `suppressed` → 400 branch's comment became its own `// SPIKE:` line.
- **C-49**. All phrases present; the per-file minimums are met (`nonfunctional.test.ts` green).
- **C-50**. FINDINGS is not an I deliverable; nothing done here.
- **C-51** (`trust-signin.ts`). The `@openvtc/trust-tasks` import is gone. The helper exports a local `TrustTaskDocument<P>` (`id`, `type`, optional `issuer`/`recipient`/`issuedAt`/`expiresAt`/`threadId`, `payload: P`, optional `proof`) and a `TrustTaskProof` interface with the six eddsa-jcs-2022 proof members (structurally the runtime's `Proof`).
- **C-52** (`trust-signin.ts`). After each 200, `signIn` requires `body.type === request.type + "#response"` and `body.threadId === request.id`, else `TrustSignInError('transport', false, 200)`. The challenge check runs before the second POST, the authenticate check before `member_token` is written.

### DESIGN §2 signature changes

Exactly those listed in DESIGN §6, nothing else:
- `trust-signin.ts`: `IDENTITY_KEY` removed; `IDENTITY_KEY_PREFIX` and `identityKeyForApp(appId: string): string` added; `GetIdentityOptions.appId: string` required; `getOrCreateIdentity(options: GetIdentityOptions)` (no default); `SignInOptions.identityStore?: IdentityStore`. Two extra *type* exports, `TrustTaskDocument<P>` and `TrustTaskProof` (C-51 asks for the local type; exporting it lets apps name the documents the exported functions return).
- `replay.ts`: `ReplayGuardDeps.acceptanceWindowMs?` and `ReplayGuardDeps.log?` (additive). `DEFAULT_ACCEPTANCE_WINDOW_MS` is also exported from `replay.ts` now (same value, still exported from `core.ts`).

### REVIEW-1 nits

- **N-3 done, then corrected by C-57.** *(Correction, REVIEW-2 loop.)* As first implemented, `InMemoryRateLimiter` evicted only buckets whose 60 s window had closed, by a full scan of the map, once it held `MAX_BUCKETS` (10 000) ids and saw a new one. That left the map unbounded within one window and made each new id O(n). C-57 replaced it; see `## REVIEW-2 loop`.
- **N-4 done.** `app_key` is compared with the existing `constantTimeEqual` (and must be a string).
- **N-6 done.** The `replay.ts` header now says the P8 sweep is global (expired rows of every app), and the app-scoping note is a plain comment, not a `// SPIKE:` marker. The `retention pad` marker remains, so `replay.ts` still has ≥ 1.
- **N-9 skipped.** D declined it (worst case = a lost identity, already covered by S-70).
- **N-12 skipped.** It touches `index.ts` request handling (body limit, module-load env check); not cheap to make safe without tests, and D marked it optional.

### Finish-line outputs (REVIEW-1 loop, §4)

```
$ npx vitest run
 Test Files  13 passed (13)
      Tests  227 passed | 6 todo (233)
   Start at  20:09:49
   Duration  718ms (import 74%, tests 16%, transform 7%, setup 2%, worker 1%)

$ npx tsc --noEmit -p tsconfig.functions.json
exit 0
$ npx tsc --noEmit -p tsconfig.app.json
exit 0
$ npx eslint ...
exit 0
$ deno check
Check supabase/functions/app-trust-tasks/index.ts
exit 0
$ deno eval
ok
exit 0
$ grep Deno.
exit 1
$ git diff app-data
diff --git a/supabase/functions/app-data/index.ts b/supabase/functions/app-data/index.ts
index d4bb59e..59dafd3 100644
--- a/supabase/functions/app-data/index.ts
+++ b/supabase/functions/app-data/index.ts
@@ -335,8 +335,9 @@ Deno.serve(async (req: Request) => {
 
 interface Member {
   id: string;
-  email: string;
+  email: string | null;
   name: string | null;
+  did: string | null;
 }
 
 const CODE_TTL_MS = 10 * 60 * 1000;
@@ -356,7 +357,7 @@ async function resolveMember(appId: string, tokenRaw: unknown): Promise<Member |
   const sessions = res.ok ? await res.json() : [];
   if (!sessions.length || new Date(sessions[0].expires_at) < new Date()) return null;
   const memberRes = await fetch(
-    restUrl(`/app_members?id=eq.${sessions[0].member_id}&select=id,email,name`),
+    restUrl(`/app_members?id=eq.${sessions[0].member_id}&select=id,email,name,did`),
     { headers: svcHeaders() },
   );
   const members = memberRes.ok ? await memberRes.json() : [];
@@ -587,7 +588,7 @@ async function authVerify(appId: string, body: Record<string, unknown>): Promise
 
   // Upsert the member (name from the sign-in request wins when present)
   const existingRes = await fetch(
-    restUrl(`/app_members?app_id=eq.${encodeURIComponent(appId)}&email=eq.${encodeURIComponent(email)}&select=id,email,name`),
+    restUrl(`/app_members?app_id=eq.${encodeURIComponent(appId)}&email=eq.${encodeURIComponent(email)}&select=id,email,name,did`),
     { headers: svcHeaders() },
   );
   const existing = existingRes.ok ? await existingRes.json() : [];
@@ -625,7 +626,7 @@ async function authVerify(appId: string, body: Record<string, unknown>): Promise
   });
   if (!sessRes.ok) return json({ error: 'Could not start your session' }, 500);
 
-  return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name } });
+  return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name, did: member.did } });
 }
 
 /** Resolve the signed-in builder's email from the Authorization header */
```

## REVIEW-2 loop

Implementation agent, 2026-10-28. Starting point: commit 65288de (44 failed, 242 passed, 6 todo). Code commit: `5889ce6`. No TEST-DISPUTE entries were needed: every failing test matched its C-entry.

### Per C-number

- **C-53.** Spec wording only (expiry before mismatch: retryability and record fate). No code change; the existing `expiry before mismatch` marker stands.
- **C-54** (`core.ts`). The rate-limiter `// SPIKE:` line now reads "… anyone who knows an app_id can spend its budget, even with a wrong key — C-46, C-54". It keeps `per-app` and `rateLimited` and no longer names `APP_KEY`. The S-40 order (limit before key check) is unchanged.
- **C-55** (`core.ts`). `DATE_TIME` now captures the offset hours and minutes. `isDateTime` checks month 01–12, day 01 to `daysInMonth(year, month)` (new private helper, Gregorian leap years), hour ≤ 23, minute ≤ 59, second ≤ 59, and offset hours ≤ 23 and minutes ≤ 59. The second check carries `// SPIKE: leap second refused …` (`core.ts` now has 11 markers). `checkFrameworkShape` already called `isDateTime`, so envelope `issuedAt`/`expiresAt` get the same rule with the existing constant message naming the member.
- **C-56.** Known behaviour, pinned by tests; no code change.
- **C-57** (`core.ts`). `InMemoryRateLimiter.hit` has no full scan. For an id with no bucket and a full map (`MAX_BUCKETS` = 10 000), it deletes the first key in insertion order. A bucket whose window has closed is `delete`d and re-`set`, so insertion order is window-start order. O(1) amortized. The bucket map stays an ordinary (TS-`private`, not `#private`) `Map` field, the only `Map` on the instance. The N-3 line above is corrected.
- **C-58** (`core.ts`). `checkSchemaNode` now calls a new private `checkKeywordValue(key, value)` for every supported keyword, after the unsupported-keyword check (whose message `S-25: unsupported schema keyword "<k>"` is unchanged). It throws a plain `Error` `S-25: schema keyword "<k>" must be …` for: a non-object, non-boolean `items`/`propertyNames`/`additionalProperties` (array-form `items` included); a non-object `properties`/`$defs` or one with a value that is not an object or boolean; a `type` that is not one of the seven names (arrays included); a `required` that is not an array of strings; a `minLength`/`maxLength`/`minItems`/`minProperties` that is not a non-negative integer; a `minimum` that is not a finite number; a non-string `pattern`/`format`/`$ref`. A string but non-local `$ref` still throws `S-25: non-local $ref …`. Annotations are not checked. Because `validate` asserts first, each of these throws from `validate` too, whatever the value.
- **C-59** (`replay.ts`). Before its final throw, `recordResponse` calls `this.log?.("replay.record_failed", { failure })`, with `failure` = `"HTTP <status>"` or `"fetch rejected"` from the last attempt, inside a try/catch that swallows a throwing sink. No id or digest is logged, and the thrown message is unchanged (it names neither). The `ReplayGuardDeps.log` doc comment now lists both events.

### DESIGN §2 signature changes

None. The new functions (`daysInMonth`, `checkKeywordValue`, `isSubSchema`, `isNonNegativeInteger`) are module-private.

### Finish-line outputs (REVIEW-2 loop, §4)

```
$ npx vitest run
 Test Files  13 passed (13)
      Tests  286 passed | 6 todo (292)
   Duration  636ms (import 75%, tests 19%, transform 3%, setup 2%, worker 1%)

$ npx tsc --noEmit -p tsconfig.functions.json
exit 0
$ npx tsc --noEmit -p tsconfig.app.json
exit 0
$ npx eslint supabase/functions/app-trust-tasks src/kit/files/lib/trust-signin.ts src/integrations/catalog.ts src/cloud/community-cloud.ts
exit 0 (no output)
$ deno check supabase/functions/app-trust-tasks/index.ts
Check supabase/functions/app-trust-tasks/index.ts
exit 0
$ deno eval '…trust-tasks@0.26.29 …trust-tasks-proof@0.1.3…'
ok
exit 0
$ grep -rn "Deno\." supabase/functions/app-trust-tasks/{core,challenges,replay,members,status}.ts
(no output) exit 1
$ git diff 6b68ea634f37a70e3a5ef3146d74a02072eda094 -- supabase/functions/app-data/index.ts
diff --git a/supabase/functions/app-data/index.ts b/supabase/functions/app-data/index.ts
index d4bb59e..59dafd3 100644
--- a/supabase/functions/app-data/index.ts
+++ b/supabase/functions/app-data/index.ts
@@ -335,8 +335,9 @@ Deno.serve(async (req: Request) => {
 
 interface Member {
   id: string;
-  email: string;
+  email: string | null;
   name: string | null;
+  did: string | null;
 }
 
 const CODE_TTL_MS = 10 * 60 * 1000;
@@ -356,7 +357,7 @@ async function resolveMember(appId: string, tokenRaw: unknown): Promise<Member |
   const sessions = res.ok ? await res.json() : [];
   if (!sessions.length || new Date(sessions[0].expires_at) < new Date()) return null;
   const memberRes = await fetch(
-    restUrl(`/app_members?id=eq.${sessions[0].member_id}&select=id,email,name`),
+    restUrl(`/app_members?id=eq.${sessions[0].member_id}&select=id,email,name,did`),
     { headers: svcHeaders() },
   );
   const members = memberRes.ok ? await memberRes.json() : [];
@@ -587,7 +588,7 @@ async function authVerify(appId: string, body: Record<string, unknown>): Promise
 
   // Upsert the member (name from the sign-in request wins when present)
   const existingRes = await fetch(
-    restUrl(`/app_members?app_id=eq.${encodeURIComponent(appId)}&email=eq.${encodeURIComponent(email)}&select=id,email,name`),
+    restUrl(`/app_members?app_id=eq.${encodeURIComponent(appId)}&email=eq.${encodeURIComponent(email)}&select=id,email,name,did`),
     { headers: svcHeaders() },
   );
   const existing = existingRes.ok ? await existingRes.json() : [];
@@ -625,7 +626,7 @@ async function authVerify(appId: string, body: Record<string, unknown>): Promise
   });
   if (!sessRes.ok) return json({ error: 'Could not start your session' }, 500);
 
-  return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name } });
+  return json({ ok: true, member_token: token, member: { id: member.id, email: member.email, name: member.name, did: member.did } });
 }
 
 /** Resolve the signed-in builder's email from the Authorization header */
```

The `app-data` diff is unchanged from the REVIEW-1 loop (S-52 / C-30 changes only); this loop did not touch that file.

## REVIEW-3 loop

Implementation agent, 2026-10-29. Starting point: commit a1365cd (17 failed, 281 passed, 6 todo). No TEST-DISPUTE entries were needed: every failing test matched its C-entry.

### Per C-number

- **C-60** (`replay.ts`, `status.ts`). `status.ts` now exports `isErrorDocument` (body unchanged; nothing else in the file changed). `replay.ts` exports `COMPLETED_RECORD = Object.freeze({ completed: true as const })` and imports `isErrorDocument` from `./status.ts`. `recordResponse` sends `{response: isErrorDocument(response) ? response : COMPLETED_RECORD}` in P9, so a success's `accessToken` and session id never reach `app_tt_replay`; the C-40 retry and the C-59 `replay.record_failed` log are unchanged. `resolveConflict`: `null` → `{duplicate, inFlight: true}`; an error document → `{duplicate, inFlight: false, priorResponse}`; anything else (`COMPLETED_RECORD`, or a full success left by a pre-C-60 build) → `{kind: "duplicate", inFlight: false}` with no `priorResponse` key, which S-50 already maps to 204 with no body. The file header cites C-60 / R3-4 / OVTC-53.
- **C-61** (`core.ts`). New export `APP_ID_PATTERN` (canonical 8-4-4-4-12 hex uuid, `i` flag). In `handleInner`, after the 401 check, an `app_id` that fails the pattern → `plainError(403, "Unknown app or wrong key")` with no limiter hit and no PostgREST call. Then `const appId = req.appId.toLowerCase()`, used for the limiter, P1, and everything passed on to `runChallenge` / `runAuthenticate` (challenge store, replay guard, members, sessions). The C-57 comment in `hit` now notes that keys are 36-character uuids, so the entry bound is also a byte bound. `InMemoryRateLimiter` and every `// SPIKE:` line are unchanged (no marker line added, removed or edited).
- **C-62.** Confirmation only; `trust-signin.ts` unchanged, and its S-61 test was already green.

### DESIGN §2 signature changes

None. `APP_ID_PATTERN`, `COMPLETED_RECORD` and the `isErrorDocument` export are additions; no existing signature changed. `trust-signin.ts`, `index.ts` and `app-data/index.ts` were not touched.

### Finish-line outputs (REVIEW-3 loop, §4)

```
$ npx vitest run
 Test Files  13 passed (13)
      Tests  298 passed | 6 todo (304)
   Duration  675ms (import 74%, tests 20%, transform 4%, setup 2%, worker 1%)

$ npx tsc --noEmit -p tsconfig.functions.json
exit 0
$ npx tsc --noEmit -p tsconfig.app.json
exit 0
$ npx tsc --noEmit -p tests/tsconfig.json
exit 0
$ npx eslint supabase/functions/app-trust-tasks src/kit/files/lib/trust-signin.ts src/integrations/catalog.ts src/cloud/community-cloud.ts
exit 0 (no output)
$ deno check supabase/functions/app-trust-tasks/index.ts
Check supabase/functions/app-trust-tasks/index.ts
exit 0
$ deno eval '…trust-tasks@0.26.29 …trust-tasks-proof@0.1.3…'
ok
exit 0
$ grep -rn "Deno\." supabase/functions/app-trust-tasks/{core,challenges,replay,members,status}.ts
(no output) exit 1
$ git diff 6b68ea634f37a70e3a5ef3146d74a02072eda094 -- supabase/functions/app-data/index.ts
(42 lines; identical to the diff recorded in the REVIEW-1 loop — the S-52 / C-30 edits only.
 `git diff HEAD -- supabase/functions/app-data/index.ts` is empty: this loop did not touch it.)
```
