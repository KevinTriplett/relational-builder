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

---

## Phase 2 — writing tests from the specs alone (2026-10-26)

A second agent wrote the test suite using only the task specs, the binding and the packages' public API, without reading the runtime source. It independently reported OVTC-7, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20 and 22. Two separate readers converging on the same items is a reasonable sign they are real. The new items follow.

### OVTC-24 · `docs` · The package README contradicts the shipped schemas

`@openvtc/trust-tasks` README, section "Validating payloads at runtime" (around lines 200–207), tells consumers to fetch `payload.schema.json` from trusttasks.org and wire up §7.2 items 1–2 themselves. But every task module ships `SPEC.payloadSchema` / `PAYLOAD_SCHEMA` with `$ref`s inlined, `consumeInbound` takes a `payloadPolicy`, and the header of `dist/_runtime/consume.d.ts` says item 2 is no longer the caller's job. **Fix:** point that section at `SPEC.payloadSchema` and `payloadPolicy: { kind: "validate" }`. Also list the JSON Schema keywords the shipped schemas use (about 20 in the auth family), so consumers know how small a validator they can get away with (see OVTC-21).

### OVTC-25 · `docs` · No machine-readable valid examples

`specs/auth/challenge/0.1/` and `specs/auth/authenticate/0.3/` ship `payload.invalid-examples.json`, but there is no valid-examples counterpart and no response examples. Valid documents exist only as fenced JSON in `spec.md`, which testers must scrape. **Fix:** add `payload.valid-examples.json` and `response.valid-examples.json`, and check them in CI against the schemas and `consumeInbound`.

### OVTC-26 · `bug` · Challenge length floor is below the spec's own entropy rule (verified)

The `auth/challenge/0.1` response schema has `challenge.minLength: 16` (`specs/auth/challenge/0.1/payload.schema.json:36`). The spec requires at least 128 bits of entropy (`spec.md:76`), which is at least 22 base64url characters. **Fix:** `minLength: 22` plus a base64url `pattern`, or say why the schema floor is deliberately looser.

### OVTC-27 · `bug` · `auth/challenge/0.1` subject binding contradicts `auth/authenticate/0.3`'s acting-party rule (verified)

`specs/auth/challenge/0.1/spec.md:78`: "A successful subsequent authenticate MUST be rejected if its `issuer` does not equal this `subject`." `authenticate/0.3/spec.md:130` compares the challenge subject with the *acting party* (`principal ?? issuer`). A correct proxied 0.3 login (delegate is the `issuer`, principal is the subject) therefore violates the challenge spec's MUST. **Fix:** amend challenge item 3 to say "acting party (`principal` when present, otherwise `issuer`)".

### OVTC-28 · `docs` · `auth/authenticate/0.3` is not self-contained, and its check order is not normative

- `authenticate/0.3/spec.md:136` says the ordinary case proceeds "exactly as auth/authenticate/0.2 items 7–12", so an implementer pinned to 0.3 must read 0.2.
- `:127-131` lists lookup → compare → expiry → subject → consume, but doesn't say whether that order is normative. It also doesn't say whether a failed compare burns the challenge, or whether expiry or mismatch is reported first.

These choices change observable error codes. **Fix:** inline the ordinary-case items, and state the order and the consume-on-failure rule normatively.

### OVTC-29 · `docs` · `challengeExpired` is marked `retryable: true`

`authenticate/0.3/spec.md:55-57`. Under SPEC §8.4 a retry is a bit-identical resend, and resending a document whose challenge has expired can never succeed: the client needs a new challenge and a new signed document. **Fix:** mark it `retryable: false`, or define that `retryable` on this code means "restart the ceremony".

### OVTC-30 · `docs` · Example reuses the challenge `sessionId` as `session.id`

`authenticate/0.3/spec.md:292`: the proxied response example sets `session.id` to the challenge's `sessionId`. That suggests reusing the correlation handle as the session identifier, which an implementer may copy. **Fix:** use a distinct id in the example.

### OVTC-31 · `docs` · Session schema doesn't enforce the prose MUSTs on `amr` / `acr`

`specs/auth/_shared/0.3/session.schema.json:13` does not require `amr` or `acr`. `authenticate/0.3/spec.md:138, 274` say `session.amr` MUST include `"did"`, and give `acr` a default of `"aal1"`. **Fix:** require `amr` with `contains: { const: "did" }` for this task's response, or soften the prose.

### OVTC-32 · `docs` · `authenticate/0.3` reuses the 0.1 tokens schema across versions (minor, verified)

`specs/auth/authenticate/0.3/payload.schema.json:84` refers to `../../_shared/0.1/tokens.schema.json#/$defs/TokenBundle`. That file exists, so this is not a broken link. But `_shared/0.3/` contains only `session.schema.json`, so a reader collecting "the 0.3 shared set" misses TokenBundle. **Fix:** a one-line note in `_shared/0.3/` (or the task spec) that tokens are deliberately reused from 0.1.

### OVTC-33 · `docs` · Binding 0.2 status-table gaps beyond OVTC-19

In `bindings/https/0.2/spec.md`:
- **`suppressed` outcome.** No row covers it (an `identityMismatch` with no transport-authenticated sender), at `:73-91`. The Rust reference server answers it with a generic `malformedRequest` and 400.
- **Extended codes and rate limits.** No row covers extended `slug:local` codes (every `auth/authenticate:*`), and there is no 429 row with `Retry-After`, although `auth/challenge:rateLimited` exists.
- **`errored` lifecycle row.** Its 422 bucket (`:113`) omits `expired` and `cancelled`, which the status table includes (`:83, :86`).
- **When to send 401.** The 401 row ("Missing / invalid `Authorization`", `:80`) sits uneasily with `:47`, where no Authorization header simply means no transport-authenticated sender.

### OVTC-34 · `friction` · No envelope validation in the runtime

`consumeInbound` does no framework-schema check (SPEC §7.2 item 1). A numeric `id`, `payload: null`, or a string `proof` all reach the pipeline. Consumers must write this check themselves; ours does. **Fix:** export a `validateEnvelope` (or the framework schema as a value, as is already done for payloads), and run it at the top of `consumeInbound`.

## Phase 3 — implementing against the libraries (2026-10-28)

Items the implementer found by reading library source because the docs didn't cover them. They come from source reading at the pinned versions (0.26.29 and 0.1.3) and were not separately probed unless marked.

### OVTC-35 · `docs` · The bundled payload schemas aren't pointed at

To validate payloads (see OVTC-21), the implementer had to find the schemas in `dist/auth/challenge/0.1/payload.js` and `dist/auth/authenticate/0.3/payload.js`. Nothing in `GETTING-STARTED.md` says they ship, that they are exported as values, or that they use only local `#/$defs/*` references. **Fix:** a "Validating payloads" section listing the schema exports and the JSON Schema keywords they use, so a consumer can choose or write a validator.

### OVTC-36 · `friction` · A handler-returned error is recorded verbatim, so issuer fixes must happen inside the handler

`consumeInbound` passes an error document returned by the handler through unchanged, and `recordResponse` stores exactly that object (`rt/consume.ts`, `settle`). Runtime-built rejections go through `rejectWithRecipient` with `issuer: request.recipient` (`rt/transport.ts:103`, `rt/document.ts:341`). A consumer working around OVTC-8 therefore has to set the issuer in two places: inside the handler, so the retained copy that duplicates replay is correct, and on the runtime's own rejections afterwards. **Fix:** resolving OVTC-8 removes this. Until then, document where the issuer of each kind of response comes from.

### OVTC-37 · `friction` · `slugFromTypeUri` throws on foreign type URIs

`slugFromTypeUri` throws for any type not under `https://trusttasks.org/spec/` (`rt/codes.ts:180`). A server classifying arbitrary inbound documents has to wrap it in `try`. **Fix:** return `undefined` (or offer `trySlugFromTypeUri`), and document the behaviour.

### OVTC-38 · `bug` · `publicKeyFromDidKey` doesn't check key length, and accepts a fragment

`publicKeyFromDidKey` (`proof/keys.js:17-38`, 0.1.3) checks only the multicodec header, not that the decoded Ed25519 key is 32 bytes, and accepts `did:key:…#fragment`. Our server rejects fragments with its own regex first. **Fix:** reject keys that aren't 32 bytes, and either reject fragments or document that a verification-method id is accepted.

### OVTC-39 · `docs` · `didKeyFromPublicKey` returns a verification method, not a DID

`didKeyFromPublicKey` returns `did:key:<mb>#<mb>`. A consumer storing "the member's DID" from it stores a verification-method id, which won't equal the `issuer` of the documents that member signs. **Fix:** rename it (or add `didFromPublicKey` returning the bare DID), and state the return shape in the JSDoc.

### OVTC-40 · `docs` · Undocumented verifier and signer details

- `DataIntegrityProofVerifier` takes `{ now }` in **milliseconds** and allows `proof.created` up to 60 s in the future. Neither is documented, and both matter to anyone injecting a clock.
- `signTrustTask` formats `created` without milliseconds (`.000Z` becomes `Z`). Fine, but undocumented; a test comparing timestamps trips on it.
- `normalizeCode` maps the 0.1 snake_case codes (and `canceled`) to camelCase. That is useful for mixed-version peers but appears only in source.

**Fix:** a short "Clocks and formats" note in the proof package README, and a sentence on `normalizeCode` in the runtime docs.

### OVTC-41 · `positive` · With the source pinned, the libraries were straightforward to build on

With the package versions pinned and the source available, the whole server (challenge, authenticate, replay, status mapping, member upsert) went from failing tests to green with no changes to the library and no forks. Every gap found was in documentation or a small API shape. The `rt/` runtime source was readable enough to answer each question directly. That's a good sign for adopters, but it depends on OVTC-3 (reading source at a tag), which the docs should not require.

## Phase 4 — review (2026-10-28)

Found by the review agent (R) while reviewing the implementation; copied from `REVIEW-1.md` §6. Each was probed unless it says otherwise.

### OVTC-42 · `bug` · `release` runs outside any try, so a failing release escapes `consumeInbound` and strands the claim

After a handler returns a refusal with `retryable: true`, `consumeInbound` runs `await claim?.guard.release?.(doc.id, claim.digest)` with no `try` (`RT/consume.ts:533-535`). That is exactly when the store is likely to be failing, because the usual reason for a retryable refusal is a store outage.

**What happens.**
- A rejecting `release` turns the whole call into a thrown exception, and the record stays in flight.
- A consumer that maps exceptions to 500 answers `internalError`/non-retryable where the handler said `unavailable`/retryable.
- Every bit-for-bit retry then gets `duplicate`, `inFlight: true` (HTTPS 202) until the record expires.
- The `ReplayGuard` interface (`RT/replay.ts:86-132`) also gives `release` no way to report failure.

**Probe.** A Postgres-backed guard whose challenge store and DELETE both reject: first answer 500. After recovery, the identical resend gets 202. This is the same family as OVTC-9, but on the runtime's own call.

**Fix.** Wrap `release` like `settle` wraps `recordResponse`, and return the handler's refusal unchanged. Document that guards should make `release` total.

### OVTC-43 · `bug` · A swallowed `recordResponse` failure makes a completed execution look in progress

`settle` swallows `recordResponse` errors (`RT/consume.ts:553-564`), and the comment says the duplicate "is still absorbed". It is absorbed, but the guard's record is left with no response. Every identical resend is then answered `duplicate`, `inFlight: true` (`RT/replay.ts` verdict). HTTPS 0.2 §4 maps that to 202, which binding §4.1 defines as "this document … its execution has not finished". That is false: execution finished.

**Probe.** Success with P9 failing, then an identical resend: 200, then 202.

**Fix.** On a `recordResponse` failure, ask the guard to mark the record "completed, nothing retained", so it answers `inFlight: false` and HTTPS 204. For example, add an optional `markCompleted(id)` method, or call `recordResponse(id, undefined)` in a second best-effort attempt.

### OVTC-44 · `bug` · `recordExpiry` lets the producer choose an unbounded retention

`recordExpiry` returns `expiresAt` whenever it is present (`RT/freshness.ts:173-176`). That holds even when `expiresAt` is far later than the point after which `validateFreshness` would refuse the document anyway (`issuedAt + maxAgeMs + skewMs`, `:143`). SPEC §7.2 *Bounding the record* only requires retention "at least as long as it remains willing to execute". Retention past that point is pure cost, and here it is chosen by an unauthenticated producer.

**Probe.** `expiresAt: "9999-12-31T23:59:59Z"` gave `retainUntil` ≈ year 10000. `new Date(...).toISOString()` then yields the extended form `+010000-01-01T…`, which most stores will not parse.

**Fix.** Return `min(expiresAt, issuedAt + maxAgeMs + skewMs)` when both exist. This also fixes OVTC-7 if `skewMs` is included. Optionally, let a consumer cap acceptance of `expiresAt` beyond its window.

### OVTC-45 · `bug` · Envelope timestamps are parsed with `Date.parse`, so non-RFC-3339 values are accepted

`validateFreshness` (`RT/freshness.ts:128`) and `validateBasic` (`RT/document.ts:246`) use `Date.parse` and call the result "not a valid RFC 3339 timestamp" only when it is `NaN`.

**Probe.**
- `issuedAt: "Tue, 04 Mar 2031 05:06:07 GMT"` (RFC 2822) is accepted and the task executes.
- An offset-less `"2031-03-04T05:06:07.000"` is parsed in the **server's local time zone**, so the verdict depends on host TZ.
- `PF/verifier.js:11, 65` enforces a strict dateTimeStamp regex on `proof.created`, so the two packages disagree.

**Fix.** Use one strict RFC 3339 parser, offset required, for `issuedAt` and `expiresAt`. Reject anything else as `malformedRequest`.

### OVTC-46 · `bug` · `DataIntegrityProofVerifier` ignores the verificationMethod fragment

The verifier binds `verificationMethod.split("#")[0]` to `issuer` and decodes the key from the DID part (`PF/verifier.js:79-83`). Whatever follows `#` is never checked. A proof naming `did:key:z6Mk…#not-the-key` verifies.

**Probe.** 200.

SPEC §4.7.3 item 3 requires the verification method to be one the controller document lists for the purpose. A `did:key` document lists only `did:key:<mb>#<mb>`. This is distinct from OVTC-38, which is about `publicKeyFromDidKey` accepting a fragment.

**Fix.** Require the fragment to be absent or equal to the multibase key.

### OVTC-47 · `bug` (minor) · A throwing payload validator's exception text reaches the wire

When `payloadPolicy.validate.validate` throws, its `e.message` is appended to the `malformedRequest` message sent to the producer (`RT/consume.ts:385-403`). The same function deliberately sends a constant for verifier failures, citing SPEC §12.4 (`:435-445`). A third-party JSON Schema engine's exception can name file paths, remote `$ref` hosts or internal state. Not probed for leakage; read from source.

**Fix.** Send a constant for a throw, log the detail, and keep returned `errors` arrays as they are.

### OVTC-48 · `docs` · The verifier's default cryptosuite set is not documented

`new DataIntegrityProofVerifier()` accepts `ecdsa-jcs-2019` with P-256 and P-384 keys, as well as `eddsa-jcs-2022` (`PF/verifier.js:8, 26`). This matches SPEC §4.7.1, which says SHOULD verify P-256. But a consumer that intends Ed25519-only, as ours did, has to read the dist to learn that it must pass `cryptosuites: ["eddsa-jcs-2022"]`.

**Probe.** A P-256 `did:key` signed in through our consumer.

**Fix.** List the default and the option in the README's "What is checked".

### OVTC-49 · `docs` · `auth/authenticate/0.3` does not require `proofPurpose: authentication` on the request proof

SPEC §4.7.3 lets a specification require a purpose. `auth/authenticate/0.3` requires `authentication` only for later session-key proofs (`specs/auth/authenticate/0.3/spec.md:140`). The login proof itself is left open, so a consumer accepts `assertionMethod`, `capabilityInvocation` and `capabilityDelegation` logins. Not probed beyond `core.authenticate.test.ts:203-210`, which shows `assertionMethod` → 200.

**Fix.** State it in the task's `proofRequirement`, since the login proof *is* an authentication, and have the runtime enforce a spec-declared purpose.

## Phase 4 — second review (2026-10-28)

From `REVIEW-2.md` §8, written by the review agent after the first review round.

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

## Phase 4 — final review (2026-10-28)

From `REVIEW-3.md` §6.

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
