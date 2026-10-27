# Brief for the implementation agent (I) — Phase 3

You are the implementation agent for the spike in this folder. The plan is `SWARM-PLAN.md` §3 Phase 3; this brief is the operational version of it for a long session with a limited context window. **After every `/compact`, re-read this file before doing anything else.**

You are working in a git worktree on branch `spike/openvtc-signin-impl`. The orchestrator merges your branch after it checks your work.

## 1. Hard rules (never break these)

1. **Never edit anything under `tests/`, or `vitest.config.ts`.** If a test looks wrong, do not change it: add an entry to `docs/spikes/openvtc-signin/TEST-DISPUTE.md` (test file, test title, the spec sentence it contradicts, quoted exactly), then move on to other tests.
2. **Never open `tests/app-trust-tasks/COVERAGE.md`** by any means (Read, cat, grep, head…).
3. **`supabase/functions/app-data/index.ts`:** change only what S-52 permits, as amended by C-30: the `select=` lists in `resolveMember` and `authVerify`, `did` on returned `member` objects, and the two `interface Member` lines. Nothing else.
4. **No installs, no deploys, no pushes, no PRs, no branch changes.** Never run `npm install`/`npm i`/`npm ci`, `supabase …`, `git push`, `git checkout`/`switch`, `git merge`, `git rebase`, or `gh`. Never commit to `main`. The repo's `CLAUDE.md` describes a branch/push/PR workflow for other contributors; **it does not apply to you** — this brief overrides it.
5. **Do not use the `/verify` skill or launch the app.** Your gates are the commands in §4.
6. `core.ts`, `challenges.ts`, `replay.ts`, `members.ts`, `status.ts` must contain no `Deno.` reference. Only `index.ts` may use `Deno`.
7. Every spike-grade shortcut gets a `// SPIKE:` comment (NF-5 as amended by C-34 lists the minimum per file, and S-30 has a mandatory exact line).
8. Do not change an exported signature from `DESIGN.md` §2 unless a test forces it; if you do, record it in `IMPL-NOTES.md` (§5).

## 2. What to read, and when

Read once at the start: `docs/spikes/openvtc-signin/SPIKE-SPEC.md` (including the `## Changelog` at the end, which overrides earlier text) and `docs/spikes/openvtc-signin/DESIGN.md`.

Then **do not read all the tests up front.** Work one test file at a time (§3). For each, read that test file plus whatever it imports from `tests/app-trust-tasks/` (`helpers.ts`, `producer.ts`, `fake-postgrest.ts`) the first time you need them.

Library source is available when the docs aren't enough:
- `node_modules/@openvtc/trust-tasks/src/_runtime/*.ts` — the exact runtime you run (0.26.29).
- `node_modules/@openvtc/trust-tasks-proof/dist/*` — the proof package (0.1.3).
- `.spike-deps/dtgwg-trust-tasks-tf/` — the task specs and the HTTPS binding (read-only).

Note everything you had to read in library source that `GETTING-STARTED.md` didn't tell you; it goes in `IMPL-NOTES.md`.

## 3. Work order: one test file at a time

For each file below, in order:
1. Read the test file.
2. Write or extend the implementation until `npx vitest run tests/app-trust-tasks/<file>.test.ts` passes.
3. Run `npx tsc --noEmit -p tsconfig.functions.json`, and fix any errors.
4. Commit: `git add -A` then `git commit -m "spike(app-trust-tasks): <file> green (S-xx, S-yy…)"`, listing the requirement ids that file covers.
5. Run `/compact`, then re-read this brief.

| # | Test file | Mostly implements |
|---|---|---|
| 1 | `challenges.test.ts` | `challenges.ts` |
| 2 | `replay.test.ts` | `replay.ts` |
| 3 | `schema.test.ts` | payload validator (S-25) |
| 4 | `core.auth.test.ts` | `core.ts` app auth, parse, dispatch; `status.ts` |
| 5 | `core.challenge.test.ts` | challenge handler |
| 6 | `core.authenticate.test.ts` | authenticate handler; `members.ts` |
| 7 | `producer-helper.fixture.test.ts` | `src/kit/files/lib/trust-signin.ts` |
| 8 | `kit.test.ts` | kit wiring (S-63) |
| 9 | `catalog.test.ts` | `src/integrations/catalog.ts`, `ChatPanel.tsx`, `src/cloud/community-cloud.ts` |
| 10 | `migration.test.ts` | `supabase/migrations/…_trust_tasks_signin.sql` |
| 11 | `app-data.snapshot.test.ts` | the S-52 edits to `app-data/index.ts` |
| 12 | `fake-postgrest.test.ts`, `nonfunctional.test.ts` | whatever is still red; `index.ts` |

Earlier files must stay green. Before each commit, also run the full suite (`npx vitest run`) if it's quick; it takes about a second.

A test that has failed 3 serious attempts: re-read the spec section it cites. If the test still looks wrong, dispute it (rule 1). If it looks right, write what is blocking you in `IMPL-NOTES.md` and move on. Don't loop.

## 4. Finish line

When every file is done, run all of these and paste each output at the end of `IMPL-NOTES.md`:

```sh
npx vitest run
npx tsc --noEmit -p tsconfig.functions.json
npx tsc --noEmit -p tsconfig.app.json
npx eslint supabase/functions/app-trust-tasks src/kit/files/lib/trust-signin.ts src/integrations/catalog.ts src/cloud/community-cloud.ts
deno check supabase/functions/app-trust-tasks/index.ts
deno eval 'await import("npm:@openvtc/trust-tasks@0.26.29"); await import("npm:@openvtc/trust-tasks-proof@0.1.3"); console.log("ok")'
grep -rn "Deno\." supabase/functions/app-trust-tasks/{core,challenges,replay,members,status}.ts
git diff 6b68ea634f37a70e3a5ef3146d74a02072eda094 -- supabase/functions/app-data/index.ts
```

The ESLint run must report no problems in those files. The `grep` must print nothing. Then make a final commit, `spike(app-trust-tasks): impl notes`, and stop. Tell the human you are done.

## 5. `docs/spikes/openvtc-signin/IMPL-NOTES.md`

Keep this file as you go, not at the end:
- what you had to read in library source that `GETTING-STARTED.md` did not tell you;
- anything in DESIGN.md §2 you had to change, and why;
- anything blocking a test you could not resolve;
- the finish-line outputs from §4.
