# Swarm plan: four-agent TDD build of the Trust Tasks sign-in spike

> Revised 2026-10-18 for `SPIKE-SPEC.md` v2 (Increment 1: `auth/challenge` + `auth/authenticate` over `@openvtc/trust-tasks`). Phases, gates and roles are unchanged from v1; file names, the design agent's reading list, the abort condition and the manual trial are updated.

Companion to `SPIKE-SPEC.md`. That document says *what*; this one says *who does what, in what order, with what handoffs*, for an orchestrated set of four LLM agents. It is tool-agnostic — it works with Claude Code subagents, a `Workflow` script, or hand-run sessions — but the artifact contracts are binding so the agents can be swapped.

---

## 1. Principles that shape the plan

**Tests are written before code, from the spec, by an agent that has not seen the code.** This is the whole point of the four-agent split. If the Test agent reads the Implementer's output first, it will test what the code does rather than what the spec says, and the spike's main value (finding out where the spec is wrong or the protocol is awkward) evaporates.

**The spec is the only shared truth.** Agents communicate through files in the repo, never through chat summaries. Every disagreement is resolved by amending `SPIKE-SPEC.md` (by the Design agent) and re-running downstream agents, not by an agent quietly deviating.

**One agent, one brief, one deliverable per phase.** An agent that is asked to "design and implement" will anchor on its own design. An agent asked to "implement and review" will approve its own work. Keep the roles disjoint.

**A reviewer that only reads the diff will miss most of what matters here.** The Reviewer must run the tests, grep for `// SPIKE:` markers, and check the spec coverage matrix — mechanical checks, not vibes.

**Expect the spec to be wrong somewhere.** `SPIKE-SPEC.md` was written from reading code, not running it. Several claims are already flagged for the Design phase: that `UnauthenticatedTransport` makes the in-band `issuer` authoritative rather than rejecting everything (S-42); that the runtime can express "proof optional, verify if present" for `auth/challenge` (S-42); the exact `ReplayGuard` interface (S-22); whether `auth/authenticate/0.3#response` requires a signed response (§1.2); and whether the npm package exports payload schemas for runtime validation (S-42). The Design phase exists to catch more of these before anyone writes tests against a fiction.

## 2. The four agents

| Agent | Reads | Writes | Must not read |
|---|---|---|---|
| **D — Design** | `SPIKE-SPEC.md`, the relational-builder repo, `@openvtc/trust-tasks` and `@openvtc/trust-tasks-proof` source (node_modules after install), `.spike-deps/dtgwg-trust-tasks-tf/` (GETTING-STARTED.md, SPEC.md §4.8.1/§7.2/§8, bindings/https/0.2, specs/auth/*), Supabase edge-function docs | `docs/spikes/openvtc-signin/DESIGN.md`, amendments to `SPIKE-SPEC.md` (tracked in a `## Changelog` section), stub files with signatures only | nothing restricted |
| **T — Test** | `SPIKE-SPEC.md` (as amended), `DESIGN.md` §"Public interfaces" and §"Fake PostgREST contract" only, `.spike-deps/dtgwg-trust-tasks-tf/specs/auth/{challenge/0.1,authenticate/0.3,_shared/0.3}/*` and `bindings/https/0.2/spec.md` | `tests/app-trust-tasks/**`, `vitest.config.ts`, `tests/app-trust-tasks/COVERAGE.md` | any implementation file under `supabase/functions/app-trust-tasks/` other than the stubs' exported signatures; `src/kit/files/lib/trust-signin.ts` |
| **I — Implement** | `SPIKE-SPEC.md`, `DESIGN.md`, `tests/app-trust-tasks/**`, the repo | `supabase/functions/app-trust-tasks/**`, migration, `catalog.ts`, `community-cloud.ts`, `src/kit/files/lib/trust-signin.ts` | `COVERAGE.md` (so it cannot game the matrix) |
| **R — Review** | everything | `docs/spikes/openvtc-signin/REVIEW-<n>.md`, `FINDINGS.md` skeleton | nothing restricted |

The orchestrator (you, or a thin script) owns phase transitions and the stop conditions in §5. It never writes code.

## 3. Phases and handoffs

```
Phase 0  Orchestrator: bootstrap branch, install deps, pin versions
Phase 1  D: design pass → DESIGN.md + spec amendments + stubs           [gate G1]
Phase 2  T: write failing tests from spec → tests/, COVERAGE.md          [gate G2]
Phase 3  I: make tests pass → implementation                           [gate G3]
Phase 4  R: review → REVIEW-1.md  ──fail──▶ back to I (or D if spec bug) [gate G4]
Phase 5  Orchestrator + human: manual wallet trial, FINDINGS.md
```

### Phase 0 — Bootstrap (orchestrator, deterministic, no LLM)

1. `git checkout -b spike/openvtc-signin` from the fork's `main`. Record the base SHA in `docs/spikes/openvtc-signin/BASE_SHA`.
2. `npm i -D vitest @openvtc/trust-tasks @openvtc/trust-tasks-proof @noble/curves`. Record the resolved versions in `BASE_SHA` (the registry publishes often; the spike pins).
3. Clone `https://github.com/trustoverip/dtgwg-trust-tasks-tf` (shallow) into `.spike-deps/dtgwg-trust-tasks-tf` (gitignored) so agents can read `GETTING-STARTED.md`, `SPEC.md`, the two task specs, the HTTPS binding, and `trust-tasks-ts/src/_runtime/*`. Also clone `https://github.com/trustoverip/dtgwg-vti-spec` for `spec/07-clients.md`.
   3a. **Deno smoke test before anything else:** `deno eval 'import "npm:@openvtc/trust-tasks@<ver>"; import "npm:@openvtc/trust-tasks-proof@<ver>"; console.log("ok")'`. If this fails and no `esm.sh`/vendoring fix works within an hour, stop and write FINDINGS (see §5).
4. Create the empty `docs/spikes/openvtc-signin/` tree and copy `SPIKE-SPEC.md` and this file into it.
5. Verify `npx vitest run --passWithNoTests` executes with zero tests and exits 0.

### Phase 1 — Design (agent D)

**Brief to D** (verbatim, fill the brackets):

> You are the design agent for a spike described in `docs/spikes/openvtc-signin/SPIKE-SPEC.md`. Read it fully. Then read, in this order: `supabase/functions/app-data/index.ts` lines 1–200 and 340–640; `supabase/migrations/20260702060000_neighbor_accounts.sql`; `src/integrations/catalog.ts` lines 240–300; `src/cloud/community-cloud.ts` lines 1–120 and the `setVar` calls near line 309; `src/kit/` (how `withKitFiles()` materializes files into generated apps); `.spike-deps/dtgwg-trust-tasks-tf/GETTING-STARTED.md` §3 and §4; `SPEC.md` §4.8.1, §7.2, §8; `bindings/https/0.2/spec.md`; `specs/auth/challenge/0.1/spec.md`; `specs/auth/authenticate/0.3/spec.md`; `trust-tasks-ts/src/_runtime/{consume,transport,replay,freshness,document}.ts`; `trust-tasks-ts-proof/README.md` and its `src/`.
>
> Produce `docs/spikes/openvtc-signin/DESIGN.md` with exactly these sections: (1) **Resolved questions** — answer, each with file:line evidence: does `UnauthenticatedTransport` make the in-band `issuer` authoritative (S-42)? how does the runtime express proof-optional-verify-if-present (S-42)? the exact `ReplayGuard` interface (S-22)? does `auth/authenticate/0.3` or the HTTPS binding require a signed `#response` (§1.2)? does the npm package export payload JSON schemas usable at runtime (S-42)? what does the runtime do on `recipient` absent vs present-and-mismatched (S-30)? Plus any other spec statement you found false; (2) **Public interfaces** — the exact exported TypeScript signatures of every function, class, and type in `core.ts`, `store.ts`, `resolver.ts`, `signer.ts`, `members.ts`, with one-line doc comments and *no bodies*; (3) **Fake PostgREST contract** — the exact list of URL shapes (path + query operators + headers) the implementation will issue, so the test agent's fake can be built to that list; (4) **Spec amendments** — a diff-style list of changes you are making to `SPIKE-SPEC.md`, each justified by a fact from the code, appended to the spec under `## Changelog`; (5) **Risks you could not resolve by reading** — things only running code will answer.
>
> Also create the six files under `supabase/functions/app-trust-tasks/` and the stub `src/kit/files/lib/trust-signin.ts`, containing only the signatures from section 2, each function body being `throw new Error("not implemented")`. Do not write any logic. Do not write tests. Do not modify `app-data/index.ts`.
>
> You are allowed to amend the spec. You are not allowed to weaken a requirement without stating in the Changelog what fact made it unachievable.

**Gate G1** (orchestrator checks, mechanical):
- `DESIGN.md` has all five sections; §1 explicitly resolves S-50.
- Stubs exist, `tsc --noEmit -p tsconfig.functions.json` passes on them.
- Every `S-nn` in the spec is still present or has a Changelog entry explaining its removal/renumbering.
- Spot-check: pick two claims in §1 and verify the cited file:line yourself. If either is wrong, re-run D with the correction; do not proceed.

### Phase 2 — Tests (agent T)

**Brief to T:**

> You are the test agent. Your only inputs are `docs/spikes/openvtc-signin/SPIKE-SPEC.md` (read all of it, including the Changelog), `docs/spikes/openvtc-signin/DESIGN.md` **section 2 and section 3 only**, the two task specs, the shared session/tokens schemas and the HTTPS binding under `.spike-deps/dtgwg-trust-tasks-tf/`. Do not open any other file under `supabase/functions/app-trust-tasks/` or `src/kit/files/lib/`; you are testing the specification, not an implementation.
>
> Write vitest tests under `tests/app-trust-tasks/` following the table in spec §12. Build `tests/app-trust-tasks/producer.ts` — the test-side producer (mint `did:key`, build and sign the two documents with `@openvtc/trust-tasks-proof`) — from the task specs alone. Every `it()` title begins with the requirement id it verifies. Build `tests/app-trust-tasks/fake-postgrest.ts` to exactly the contract in DESIGN.md §3 and make it throw on any unmodeled path or operator.
>
> Write `tests/app-trust-tasks/COVERAGE.md`: a table with one row per `S-nn` and `NF-n` in the spec, columns `requirement | test file | test title(s) | status`. Status is `covered`, `partial` (say what is missing), or `not testable here` (say why — e.g. needs a real wallet). A requirement with no row is a failure of your task.
>
> Run `npx vitest run`. Every test must **fail** (stubs throw) except pure-spec tests like `app-data.snapshot.test.ts` and `catalog.test.ts`, which may pass or fail depending on the base. Report the counts. A test that passes against stubs is a bug in the test; fix it.
>
> If the spec is ambiguous or untestable as written, do not guess: write the test for the strictest reasonable reading, and list the ambiguity in `COVERAGE.md` under `## Spec ambiguities` with the exact sentence from the spec.

**Gate G2:**
- `COVERAGE.md` has a row for every requirement id (orchestrator greps spec ids vs. coverage ids; the sets must match).
- `npx vitest run` shows ≥ 1 failing test per `covered` row of the core/store/resolver/signer tables, and no test that passes only because stubs throw (grep for `.toThrow()` on `"not implemented"` — none allowed).
- `## Spec ambiguities`, if non-empty, goes back to D for a Changelog entry **before** Phase 3. T then updates affected tests. Loop at most twice; after that, the orchestrator decides.

### Phase 3 — Implement (agent I)

**Brief to I:**

> You are the implementation agent. Read `SPIKE-SPEC.md`, `DESIGN.md`, and every file under `tests/app-trust-tasks/`. Do **not** read `tests/app-trust-tasks/COVERAGE.md`. Your job is to make `npx vitest run` pass by filling in the stubs under `supabase/functions/app-trust-tasks/` and `src/kit/files/lib/trust-signin.ts`, writing the migration, the `catalog.ts` and `community-cloud.ts` additions, and `index.ts`.
>
> Rules: you may not edit any file under `tests/` — if a test is wrong, stop and write `docs/spikes/openvtc-signin/TEST-DISPUTE.md` naming the test and the spec sentence it contradicts, then continue with other tests. You may not edit `app-data/index.ts` beyond what S-52 permits. Every shortcut the spec calls spike-grade gets a `// SPIKE:` comment. `core.ts` and its siblings must import nothing from `Deno`. Run `npx vitest run`, `tsc --noEmit -p tsconfig.functions.json`, and the Deno smoke import from Phase 0 step 3a before you finish; paste all outputs at the end of `docs/spikes/openvtc-signin/IMPL-NOTES.md` along with: what you had to read in `trust-tasks-ts` source that `GETTING-STARTED.md` did not tell you; anything in DESIGN.md §2 you had to change and why.
>
> Work test file by test file in this order: challenges, replay, core.auth, core.challenge, core.authenticate, producer-helper fixture, catalog, migration, snapshot. Commit after each file's tests go green with message `spike(app-trust-tasks): <file> green (S-xx…)`.

**Gate G3:**
- `npx vitest run` exit 0, or every failure is named in `TEST-DISPUTE.md`.
- `tsc` passes.
- `git diff BASE_SHA -- supabase/functions/app-data/index.ts` touches only lines permitted by S-52 (orchestrator eyeballs; it should be < 10 lines).
- `grep -rn "Deno\." supabase/functions/app-trust-tasks/{core,challenges,replay,members,status}.ts` returns nothing.
- `TEST-DISPUTE.md`, if present, goes to D (spec bug) or T (test bug) — D decides which, in one short note — and the affected party fixes, then I re-runs the affected tests. Loop at most twice.

### Phase 4 — Review (agent R)

**Brief to R:**

> You are the review agent. You have read access to everything. Produce `docs/spikes/openvtc-signin/REVIEW-1.md` with these sections, each with concrete file:line evidence:
>
> (1) **Mechanical checks** — run and paste: `npx vitest run`; `tsc --noEmit -p tsconfig.functions.json`; `grep -rn "// SPIKE:" supabase/functions/app-trust-tasks/ src/kit/files/lib/trust-signin.ts`; `grep -rn "Deno\." supabase/functions/app-trust-tasks/{core,challenges,replay,members,status}.ts`; `git diff <BASE_SHA> --stat`; `git diff <BASE_SHA> -- supabase/functions/app-data/index.ts`.
> (2) **Coverage audit** — for each row in `COVERAGE.md` marked `covered`, open the named test and state whether it actually asserts the requirement or merely exercises the code path. Downgrade rows you disagree with and say why. Pay particular attention to S-21 (is the consume-concurrency test real or does it serialize?), S-22 (fail-closed when the replay store is unreachable — is *non-execution* asserted, not just the 503?), S-47 (second sign-in by the same DID → no second member row), S-48 (identical replay returns the retained response with the *same* token and no new session row; different body under same id → 409), S-52 (snapshot compared against the base commit, not the working tree).
> (3) **Security review** — specifically: can a challenge issued for app A be consumed via app B (S-21 app scoping)? Is `app_key` compared before any store read (S-40)? Can the authenticate handler run with a proof that was *present but not verified* (the challenge handler's optional-proof policy must not leak into authenticate)? Is the challenge comparison constant-time? Does any `trust-task-error` leak a stored challenge, a token, or a stack trace? Does the browser helper ever transmit private key material (S-60)? Does `consumeInbound` get a `now` from `deps.now` everywhere, or does any path call `Date.now()` directly (clock seam)?
> (4) **Protocol-compliance ledger** — list every deviation from the two task specs, the HTTPS binding 0.2, and the VTI Client Onboarding chapter (start from spec §1.2, S-30, S-44 note, S-45, S-46) and confirm each is marked `// SPIKE:`. Add any you find that the spec did not anticipate — in particular anything in SPEC.md §7.2 items 1–11 the code skips.
> (5) **Verdict** — `APPROVE`, `REVISE-IMPL` (list items for I), `REVISE-SPEC` (list items for D), or `REVISE-TESTS` (list items for T). One verdict; if several apply, choose the earliest phase.
>
> Do not fix anything yourself. Do not soften a finding because the spec calls this a spike; your job is to say what is true about the code.

**Gate G4:** verdict `APPROVE` → Phase 5. Otherwise route to the named agent with `REVIEW-n.md` as an additional input, then re-run R producing `REVIEW-(n+1).md`. Hard stop after `REVIEW-3.md`; whatever is open becomes a FINDINGS item.

### Phase 5 — Manual trial and findings (orchestrator + human)

1. Deploy `app-trust-tasks` to the fork's Supabase project via the Management API recipe in the repo's `CLAUDE.md` (`verify_jwt: false`); set `TRUST_TASKS_LOCAL_VID`. Measure cold-start latency with `curl -w '%{time_total}'` on a `malformedRequest` probe, three times.
2. Enable `trust_signin_enabled` on one test `cloud_apps` row by SQL.
3. In the Builder, generate a small tool with Community Cloud + `TRUST_TASKS_URL` set; confirm the model emits `signIn` from `./lib/trust-signin`; sign in from two browsers; confirm two member rows, documents stamped, and that the email path still works in the same app.
4. Point the OpenVTC VTA browser plugin (built from source per its README) at the endpoint and record exactly what it sends (`auth/authenticate/0.2` expected) and the exact `trust-task-error` it receives. This is the Increment 2 compatibility evidence.
5. Agent R (or D) drafts `FINDINGS.md` from `IMPL-NOTES.md`, `REVIEW-*.md`, `COVERAGE.md`, and your trial notes, following spec §9. A human edits it. This is the actual deliverable of the spike.

## 4. Artifact contracts (summary)

| Artifact | Producer | Consumers | Format rule |
|---|---|---|---|
| `SPIKE-SPEC.md` + `## Changelog` | human → D amends | all | requirement ids never reused; removals are Changelog entries |
| `DESIGN.md` | D | T (§2–3 only), I, R | five fixed sections |
| stubs | D | T (signatures), I | bodies throw `not implemented` |
| `tests/app-trust-tasks/**`, `COVERAGE.md` | T | I (tests only), R | `it()` titles start with `S-nn`/`NF-n` |
| implementation | I | R | `// SPIKE:` markers; Deno-free core |
| `IMPL-NOTES.md`, `TEST-DISPUTE.md` | I | D, T, R | — |
| `REVIEW-n.md` | R | orchestrator, routed agent | one verdict |
| `FINDINGS.md` | R/D draft, human final | Kevin, (optionally) Josh | spec §9 questions answered with evidence |

## 5. Stop conditions and budgets

- **Loop caps:** G2 ambiguity loop ≤ 2; G3 dispute loop ≤ 2; G4 review loop ≤ 3. Exceeding a cap is not failure; it is a finding ("the spec/protocol was unclear here") and goes into FINDINGS.md.
- **Token budget guidance:** D and R are the expensive agents (they read the most); give them the strongest model you have. T and I can run on a cheaper model *if* the spec and design are tight; if G2 or G3 loop more than once, upgrade them.
- **Abort the spike** (and write FINDINGS anyway) if Phase 0 step 3a shows `@openvtc/trust-tasks` or `@openvtc/trust-tasks-proof` cannot be loaded in Deno via `npm:` **and** no `esm.sh`/vendoring workaround exists in under an hour. That alone is a decisive finding about deployability on Supabase.
- **Do not** let any agent install dependencies, deploy to Supabase, or touch the fork's `main`. Those are orchestrator/human actions.

## 6. Running it with Claude Code (one concrete option)

Each phase is a fresh `Agent` (general-purpose) with the brief above as its full prompt plus the file paths it may read. Use `isolation: "worktree"` for I so a bad run is discarded cleanly. Do not use a single long-lived session for all four roles — the role separation is the mechanism, and context bleed defeats it. If you use the `Workflow` tool, model it as `pipeline([D]) → T → I → R` with `R`'s verdict driving a bounded retry; keep the agent count at four plus retries (well under the medium guideline).

## 7. What would make this plan fail

Honest list, so you can watch for it:

- **T peeks at implementation** (via a careless glob, or because the orchestrator ran I first). Symptom: tests pass on the first run of Phase 3 with suspiciously few I commits. Fix: re-run T from scratch.
- **D over-designs.** A 2,000-line DESIGN.md with architecture diagrams is a sign D is solving a different problem. Section 2 should be signatures; section 3 should be a URL list. Cap D at ~400 lines.
- **R rubber-stamps.** If `REVIEW-1.md` is `APPROVE` with no downgraded coverage rows and no new ledger entries, run R again with a different model and the instruction "assume the previous reviewer missed at least three things."
- **The fake PostgREST drifts from real PostgREST.** The spike's tests cannot prove the store works against Supabase; only Phase 5 can. Treat the fake as a contract, not as truth, and say so in FINDINGS.
- **The registry publishes a new `@openvtc/trust-tasks` mid-spike** (it is at 0.26.x and moves weekly). Pinned, so the code keeps working, but the findings may be stale on arrival. Note the pins and the upstream HEAD date in FINDINGS.
- **The spec's did:key-only verifier hides the real cost.** Increment 1 deliberately avoids DID resolution. Do not let FINDINGS present Increment 1's effort as representative of wallet-identity support; Increment 2's resolver and net-guard are where that cost lives.
