# Feedback for OpenVTC / Trust Tasks maintainers (from a consumer spike)

**Audience:** the OpenVTC developer's coding assistant working in `trustoverip/dtgwg-trust-tasks-tf` (and sibling OpenVTC repos). Each item is self-contained: what we observed, evidence you can re-run, why it matters to a consumer, and a suggested change. Items are appended phase by phase; earlier items are not rewritten, only marked *Resolved* or *Corrected* if later evidence changes them.

**Who we are:** a web2 app (Relational Builder, Supabase edge functions on Deno + a Vite/React front end) adopting exactly two tasks, `auth/challenge/0.1` and `auth/authenticate/0.3`, over the HTTPS binding, with `did:key` issuers verified offline. The full spec of what we are building is `SPIKE-SPEC.md` in this folder; the plan is `SWARM-PLAN.md`.

**Severity scale:** `bug` (wrong behaviour or breaks consumers) · `friction` (costs a consumer real time; easy to fix upstream) · `docs` (missing or misleading documentation) · `positive` (worked well; worth keeping or documenting).

## Environment the evidence comes from

| | |
|---|---|
| `@openvtc/trust-tasks` | 0.26.29 (npm), pinned exact |
| `@openvtc/trust-tasks-proof` | 0.1.3 (npm), pinned exact |
| `@noble/curves` | 2.4.0 |
| Upstream source read | `dtgwg-trust-tasks-tf` @ tag `trust-tasks-ts-v0.26.29` (`f42a6dc`, 2026-10-21). Upstream HEAD at time of reading: `10904af` (2026-10-27), where `trust-tasks-ts` is 0.27.8 |
| `dtgwg-vti-spec` | `a85dc84` (2026-10-22) |
| Runtimes | Node 24.15.0, Deno 2.9.7 (macOS arm64) |

---

## Phase 0 — install and load (2026-10-26)

### OVTC-1 · `bug` · `@openvtc/trust-tasks-proof` pins an old `@openvtc/trust-tasks` range, so consumers get two copies

**Observed.** Every published version of `@openvtc/trust-tasks-proof` (0.1.0 through 0.1.3) declares `"@openvtc/trust-tasks": "^0.19.0"` under `dependencies`. On a 0.x version a caret means `>=0.19.0 <0.20.0`. A consumer on any current `@openvtc/trust-tasks` (0.26.x, 0.27.x) therefore gets a second, nested copy:

```
$ npm ls @openvtc/trust-tasks
├─┬ @openvtc/trust-tasks-proof@0.1.3
│ └── @openvtc/trust-tasks@0.19.22
└── @openvtc/trust-tasks@0.26.29
```

Deno does the same: `deno eval 'await import("npm:@openvtc/trust-tasks-proof@0.1.3")'` downloads `trust-tasks-0.19.22.tgz` in addition to the consumer's own version.

**Evidence.** `trust-tasks-ts-proof/package.json:30` at tag `trust-tasks-ts-v0.26.29`; `npm view @openvtc/trust-tasks-proof@<v> dependencies` for v in 0.1.0–0.1.3.

**Why it matters.** The proof package only imports *types* from the core package (`trust-tasks-ts-proof/src/verifier.ts:1` imports `ProofVerifier` and `TrustTaskDocument`; `src/sign.ts:1` imports `TrustTaskDocument`, both `import type`), so runtime behaviour is unaffected. But the types a consumer gets from `DataIntegrityProofVerifier` and `signTrustTask` are the 0.19 shapes. When those are passed into 0.26's `consumeInbound`, `tsc` checks a 0.19 `ProofVerifier` against a 0.26 `ProofVerifier`. Whether that type-checks now depends on the two shapes staying structurally compatible by luck. We have not yet confirmed whether it does; Phase 1 will add the result here. It also adds a redundant download to every install.

**Suggested change.** Because the import is type-only, make `@openvtc/trust-tasks` a `peerDependency` with a range covering every core version the proof package is tested against (for example `">=0.19.0 <1.0.0"`), and keep it as a `devDependency` for the package's own build. Alternatively, have the release tooling (`release-plz.toml` / workspace bump) move this range whenever `trust-tasks-ts` is released. Either way, add a CI check that installs the proof package next to the *current* core package and runs `tsc` on a file that passes `new DataIntegrityProofVerifier()` to `consumeInbound`.

### OVTC-2 · `docs` · No "current versions" guidance for a new consumer

**Observed.** A new consumer has to choose a version for each layer, and the repo doesn't say which ones go together:
- **HTTPS binding:** `bindings/https/` has 0.1, 0.2 and 0.3. Both 0.2 and 0.3 say `status: draft`, and `GETTING-STARTED.md` names no binding version at all.
- **`auth/authenticate`:** `specs/auth/authenticate/` has 0.1, 0.2 and 0.3. The OpenVTC browser plugin sends 0.2, and the newest is 0.3.
- **npm packages:** `@openvtc/trust-tasks` went from 0.26.29 (2026-10-21) to 0.27.8 (2026-10-26) in five days, and `@openvtc/trust-tasks-proof` is on its own 0.1.x track.

**Why it matters.** A relying party that wants to work with the plugin *and* follow the newest spec has to work out on its own that it should accept two `auth/authenticate` versions. It also has no way to tell which binding version the runtime implements.

**Suggested change.** Add a short table near the top of `GETTING-STARTED.md`, or in a `COMPATIBILITY.md` it links to, and regenerate it at each release. Columns: npm package version → framework version → HTTPS binding version(s) implemented → per-task versions known to work together. Add one line saying which `auth/authenticate` version(s) the current OpenVTC browser plugin sends and which a relying party should accept.

### OVTC-3 · `docs` · Tell consumers to read runtime source at their pinned version, not at HEAD

**Observed.** The guide and the README send readers to `trust-tasks-ts/src/_runtime/*` to understand `consumeInbound`, `ReplayGuard`, transports and freshness. A shallow clone of the repo gives HEAD (0.27.8), but anyone who installed a week earlier is running 0.26.x. The per-package tags `trust-tasks-ts-v<ver>` and `trust-tasks-ts-proof-v<ver>` exist and are correct. We confirmed that the `_runtime/` source at tag `trust-tasks-ts-v0.26.29` is byte-identical to `node_modules/@openvtc/trust-tasks/src/_runtime/`. Nothing in the docs mentions these tags.

**Suggested change.** Add one paragraph to `GETTING-STARTED.md`: "The npm package ships its TypeScript source under `src/`. Read that, or check out tag `trust-tasks-ts-v<your version>`, rather than `main`." Note also that the proof package's tags follow its own version numbers. At tag `trust-tasks-ts-v0.26.29` the proof package's source is 0.1.2, while npm's latest is 0.1.3.

### OVTC-4 · `friction` · `@openvtc/trust-tasks-proof` ships no source

**Observed.** `@openvtc/trust-tasks` ships `src/` alongside `dist/`, which was very useful (see OVTC-3). `@openvtc/trust-tasks-proof` ships only `dist/`, `README.md` and `LICENSE`. Its `"files"` field is `["dist"]`.

**Suggested change.** Ship `src/` (or source maps that include the sources) in the proof package too, so a consumer can read the exact `DataIntegrityProofVerifier` and `signTrustTask` code they run.

### OVTC-5 · `positive` · Both packages load in Deno through `npm:` specifiers

**Observed.** `deno eval` importing `npm:@openvtc/trust-tasks@0.26.29` and `npm:@openvtc/trust-tasks-proof@0.1.3` succeeds on Deno 2.9.7: about 4.5 s with a cold cache, and no `esm.sh` or vendoring needed. All runtime exports the integration needs are present: `consumeInbound`, `UnauthenticatedTransport`, `consequentialChecks`, `notConsequentialChecks`, `rejectWith`, `DEFAULT_FRESHNESS`, `CONSEQUENTIAL_FRESHNESS`. From the proof package: `DataIntegrityProofVerifier`, `signTrustTask`, `signerFromPrivateKey`, `didKeyFromPublicKey`, `publicKeyFromDidKey` and the multibase helpers. Supabase Edge Functions, Deno Deploy and Netlify Edge all run Deno, so this is likely to be a common deployment target.

**Suggested change.** Add a Deno / edge-function snippet to `GETTING-STARTED.md` §1 next to the Rust, TS, Go and Dart lines:

```ts
import { consumeInbound } from "npm:@openvtc/trust-tasks@<ver>";
```

Note there that the in-memory `ReplayGuard` is unsafe on serverless runtimes, because isolates don't share memory.

### OVTC-6 · `docs` · Note for consumers who clone the spec repo inside their own project

**Observed.** We cloned `dtgwg-trust-tasks-tf` into a git-ignored folder inside our project so our tools could read the specs. Our `vitest run` then found and ran the upstream repo's own `*.test.ts` files, and some of them failed in our environment. Our ESLint run went from 21 to 246 problems for the same reason. `.gitignore` does not affect either tool.

**Suggested change.** This is minor and partly a consumer issue. If the docs recommend cloning the repo for reference, add one line: "Exclude the clone from your test runner and linter."
