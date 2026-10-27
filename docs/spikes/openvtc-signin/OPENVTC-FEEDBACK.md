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

---

## Phase 1 — design pass against the 0.26.29 source (2026-10-26)

Paths: `RT/` = `@openvtc/trust-tasks@0.26.29` `src/_runtime/`; `PF/` = `@openvtc/trust-tasks-proof@0.1.3` `dist/`; other paths are relative to `dtgwg-trust-tasks-tf` at tag `trust-tasks-ts-v0.26.29`. Items marked **verified** were checked against the source by a second reader; **probed** means a script exercised the installed runtime and saw the behaviour. The rest are from one careful reading with file:line given; treat them as strong leads, not settled fact.

**Update to OVTC-1:** the 0.19 proof types *are* assignable to 0.26.29's `consumeInbound` parameters under both `tsc` (with `skipLibCheck: false`) and `deno check`. Today the cost is only a duplicate install. The suggested fix still applies, because this compatibility is accidental.

### OVTC-7 · `bug` · Replay record can expire before the acceptance window closes (verified, probed)

`RT/freshness.ts:143` accepts a document while `issuedAt + maxAgeMs + skewMs >= now`. `recordExpiry` (`RT/freshness.ts:182`) returns `issuedAt + maxAgeMs`, without `skewMs`. A document accepted in that last `skewMs` is claimed with a `retainUntil` that has already passed. `InMemoryReplayGuard.claim` (`RT/replay.ts:209`) then treats the record as absent, so the same `id` executes a second time. A probe saw two executions for one `id`. This violates SPEC §7.2 *Bounding the record*. **Fix:** include `skewMs` in `recordExpiry`. Add a test that replays a document accepted at `issuedAt + maxAgeMs + skewMs - 1`.

### OVTC-8 · `bug` · Error documents take `issuer` from the request's `recipient` (verified, probed)

`rejectWithRecipient` sets `issuer: request.recipient` (`RT/document.ts:369`). Under `wrongRecipient` the error is therefore issued as the VID the consumer has just said it is *not*. Payload-schema rejections run before the recipient check (`RT/consume.ts:383` vs `:408`), so they inherit the same problem. **Fix:** issue every error document from the consumer's `myVid`.

### OVTC-9 · `bug` · A throwing handler leaves the replay claim in flight forever (probed)

If the handler throws, the exception propagates out of `consumeInbound` (`RT/consume.ts:520`) without releasing the claim. Every identical retry then gets `duplicate` with `inFlight: true` until the record expires. **Fix:** release the claim in a `finally` or `catch`, or document that handlers must never throw and must return a rejection instead.

### OVTC-10 · `bug` · `DataIntegrityProofVerifier` does not check `proofPurpose` (verified)

`PF/verifier.js:50-54` only requires `proofPurpose` to be a non-empty string, so a `keyAgreement` proof verifies. SPEC §4.7.3 item 1 says it MUST be rejected. The README's "What is checked" list does not mention purpose. **Fix:** accept an allowed-purposes option (default `["authentication"]`), and list purpose in the README.

### OVTC-11 · `bug` · `signTrustTask` defaults to `proofPurpose: "assertionMethod"` (verified)

The default is at `PF/sign.js:49`. SPEC §4.7.3 says producers SHOULD sign with `authentication` and SHOULD NOT default to `assertionMethod`. **Fix:** change the default.

### OVTC-12 · `friction` · `Signer.sign` is synchronous, so non-extractable WebCrypto keys cannot be used

`Signer.sign` returns synchronously (`PF/sign.d.ts`). WebCrypto `subtle.sign` is async, so a browser holding a non-extractable Ed25519 key cannot use `signTrustTask`. The `sessionKey` text in the authenticate 0.3 schema itself says the key "SHOULD [be kept] non-extractable (for example, a WebCrypto non-extractable key)". Our spike has to re-implement the signing path and prove with a fixture that it is byte-identical. **Fix:** accept `sign(bytes): Uint8Array | Promise<Uint8Array>`, and make `signTrustTask` async (or add `signTrustTaskAsync`).

### OVTC-13 · `docs`/`bug` · `recipient` is REQUIRED, but there is no first-contact story

Both `auth/challenge/0.1` and `auth/authenticate/0.3` declare the auth service a REQUIRED `recipient` party (verified: `specs/auth/challenge/0.1/spec.md:24`, `specs/auth/authenticate/0.3/spec.md:27`). The runtime rejects a document without an in-band `recipient` as `malformedRequest` (verified: `RT/document.ts:309`). It checks only `doc.recipient` and ignores the transport-derived recipient that SPEC §4.8.1 item 2 and binding 0.2 §3 (`local_vid`) allow. A browser signing in for the first time has to know the auth service's VID *before* its first request, and nothing explains how it learns it (discovery, `.well-known`, out-of-band configuration). **Fix:** either honour the transport-derived recipient in `enforceSpecPolicy`, or document the stricter rule and the intended way for a client to learn the VID.

### OVTC-14 · `bug` · Runtime and binding disagree on a recipient mismatch

Binding 0.2 §3 (`bindings/https/0.2/spec.md:63`) calls a recipient mismatch `identityMismatch`. The runtime returns `wrongRecipient` (`RT/document.ts:264`). **Fix:** pick one and align the other.

### OVTC-15 · `docs` · `auth/authenticate/0.3` contradicts itself on response proofs

The single `proofRequirement: REQUIRED` applies to every variant, so `RESPONSE_SPEC.isProofRequired` is `true` (`src/auth/authenticate/0.3/payload.ts:523`). Yet the spec's own success-response examples are unsigned (`specs/auth/authenticate/0.3/spec.md:282-341`), and the Response section says nothing about signing. **Fix:** declare proof requirements per variant (request vs `#response`), or sign the examples.

### OVTC-16 · `docs` · Problems in the task specs' error examples

- In both specs (`specs/auth/challenge/0.1/spec.md:171-182`, `specs/auth/authenticate/0.3/spec.md:346-358`), the error examples omit the required `retryable` and use `trust-task-error/0.1`, while the runtime emits 0.5.
- Their example messages name DIDs, despite the specs' own caution about enumeration.
- The challenge 0.1 Abstract links `auth/authenticate/0.1` (`spec.md:55`) rather than the current version.

### OVTC-17 · `bug` · `unsupportedExtension` is missing from the code list (verified)

SPEC §8.3 lists `unsupportedExtension`, but it is absent from `STANDARD_CODES` (`RT/codes.ts:11-26`) and from binding 0.2's §4 status table.

### OVTC-18 · `friction` · No HTTP status helper in the TS runtime

Rust has `status_for_code` (`trust-tasks-https/src/status.rs:54`). The TS runtime has nothing equivalent, so every TS consumer has to hand-copy binding 0.2's §4 table. **Fix:** export `httpStatusForOutcome` and `httpStatusForCode`.

### OVTC-19 · `docs` · Binding 0.2 gaps: duplicate-with-error, and CORS preflight

- **A duplicate whose retained response is an error document.** §4 does not cover this case. The Rust server answers it with 200 (`trust-tasks-https/src/server.rs:857-862`), while §4 tells clients that only non-2xx responses are errors.
- **CORS preflight.** §2 item 1 says every method other than POST gets 405, which breaks browser CORS preflight for any web client on another origin. **Fix:** add an explicit allowance for `OPTIONS` preflight.

### OVTC-20 · `friction` · `consequentialChecks(guard)` takes no acceptance window

`consequentialChecks(guard)` (`RT/consume.ts:124`) has no window parameter, so a consumer that needs one must build a `ConsumeChecks` literal by hand. **Fix:** add `consequentialChecks(guard, { maxAgeMs, skewMs })`.

### OVTC-21 · `docs` · No JSON Schema validator ships, and the docs don't say so

The package ships payload schemas as values, and `consumeInbound` accepts a `validate` callback (`RT/consume.ts:200-205`). GETTING-STARTED §3 uses `myValidator` without saying that no validator is bundled. **Fix:** say so, and name one validator known to handle draft 2020-12 and run on Deno and in browsers. Alternatively, ship an optional validator subpath.

### OVTC-22 · `friction` · Proof package has no top-level `"types"` field (verified)

`"types"` appears only inside `exports` (`package.json` of the proof package). TypeScript `paths` mappings and older resolvers that point at the package directory fail with `TS2307`. **Fix:** add a top-level `"types": "./dist/index.d.ts"`.

### OVTC-23 · `positive` · HTTPS binding 0.3 is a small, additive change

Binding 0.3 only adds SSE streaming on top of 0.2, so a consumer built on 0.2 does not need to change to adopt it. This is worth saying in the binding's own changelog or abstract, so readers don't have to diff the two to find out.
