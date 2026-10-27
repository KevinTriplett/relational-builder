# OpenVTC for web2 developers: what it is, how it maps to what you know, and how to adopt it one task at a time

*Written 2026-10-18 by Kevin Triplett, from reading the OpenVTC repos, the ToIP VTI specification, the Trust Tasks framework (`trustoverip/dtgwg-trust-tasks-tf`), and a real web2 codebase (`relational-builder`). Companion to `SPIKE-SPEC.md` and `SWARM-PLAN.md` in this folder. Where I state a fact about a moving target I give the date; where I'm inferring, I say so.*

---

## 1. Who this is for, and the one idea to hold onto

You build web apps the normal way: a React/Vue front end, a Node/Rails/Django API, Postgres, sessions or JWTs, email or OAuth sign-in, maybe Supabase or Firebase doing half of that for you. You've heard of DIDs and verifiable credentials and found the literature either theological or impenetrable. You've been pointed at OpenVTC and asked whether your app could "use it."

The one idea: **OpenVTC's lead developer does not want you to rewrite your app.** His words, lightly paraphrased: think of the VTI services as *sidecars* to what you already run; "you can still have the old designs, it is ok"; Trust Tasks is the integration library, and an existing system can start by speaking exactly one task and grow from there. Demanding DIDs-only, credentials-only, privacy-by-design on day one is "open heart surgery while the patient is running a marathon."

So this guide does three things. Section 2 explains the architecture in terms you already have. Section 3 is blunt about what is actually different, because the differences are real and some of them are uncomfortable. Sections 4–5 lay out a step-by-step path that keeps your Postgres, your API, and your users, and Section 6 is for people building community platforms — posts, events, DMs, group chats — where the mapping is both most promising and most fraught.

## 2. The architecture, in your vocabulary

### 2.1 The cast

| OpenVTC / VTI term | What it most resembles | What it actually is |
|---|---|---|
| **DID** (`did:key`, `did:web`, `did:webvh`) | A user id / service account id | A globally unique identifier whose controller proves control with a key pair. `did:key` is literally a public key in a string (no network, no hosting). `did:web` is a JSON document at `https://host/.well-known/did.json`. `did:webvh` adds a hash-chained, witnessed history of key rotations. |
| **VTA — Verifiable Trust Agent** | Your KMS/HSM + a Vault instance + the "account" row, as one service | A key custodian that holds a person's or service's keys, mints DIDs, enforces an ACL over who may use which key for what, and signs things on request. Keys are meant never to leave it. It runs as a server (self-hosted, or rented from the "VTA Farm"). |
| **VTC — Verifiable Trust Community** | Your `groups`/`orgs` table + membership logic + an admin panel, as a service | A service with its own VTA that admits members by policy, issues membership credentials, keeps a roster and a trust registry, and exposes an admin UI. |
| **Mediator** | A message broker your clients can reach through NAT; roughly "SNS/SQS for encrypted peer-to-peer messages" | A DIDComm v2 relay. Parties that can't be dialled directly (phones, laptops, agents behind firewalls) pick up messages here. |
| **DID Host** | Static file hosting for `did.json` | Publishes DID documents so others can resolve them. |
| **Trust Registry** | A permissions/allow-list service other orgs can query | Answers "is X authorized/recognized by authority Y for action Z" (TRQP). |
| **Verifiable Credential (VC)** | A signed JWT claim set | A signed JSON document asserting facts about a subject, verifiable against the issuer's DID. Membership, personhood, endorsement, relationship (VRC), witness. |
| **Trust Task** | A typed, signed JSON-RPC call | One JSON document: `id, type, issuer, recipient, issuedAt, payload, proof`. `type` is a URI like `https://trusttasks.org/spec/auth/authenticate/0.3`. Responses are the same shape with `#response` appended; errors are `trust-task-error`. Transport-agnostic (HTTPS, DIDComm, TSP). |
| **Transports: HTTPS, DIDComm v2, TSP** | REST; an encrypted queue; a lower-level encrypted channel | Three carriers for the *same* Trust Task documents. HTTPS is `POST /trust-tasks`. You can start with HTTPS alone. |
| **Client** (VTI spec chapter 11) | An API client with a service token | Anything acting under *granted* authority rather than its own — a CLI, a headless service, an agent runtime, a mobile approver. It mints its own key, gets enrolled in a VTA's ACL out-of-band, then rotates off its bootstrap key. |

### 2.2 The shape of a request, side by side

What you write today:

```
POST /api/login            Authorization: Bearer <session>
{ "email": "a@x.org", "code": "123456" }
→ 200 { "token": "…" }
```

What a Trust Task looks like on the wire (HTTPS binding 0.2, real task `auth/authenticate/0.3`):

```
POST /trust-tasks          Content-Type: application/json
{
  "id": "urn:uuid:…",
  "type": "https://trusttasks.org/spec/auth/authenticate/0.3",
  "issuer": "did:key:z6Mk…",
  "recipient": "did:web:yourapp.example",
  "issuedAt": "2026-10-18T14:00:00Z",
  "payload": { "challenge": "…", "sessionId": "…" },
  "proof": { "type": "DataIntegrityProof", "cryptosuite": "eddsa-jcs-2022", "verificationMethod": "did:key:z6Mk…#z6Mk…", "proofPurpose": "authentication", "proofValue": "z…" }
}
→ 200 { "type": "https://trusttasks.org/spec/auth/authenticate/0.3#response", "threadId": "urn:uuid:…", "payload": { "session": {…}, "tokens": { "accessToken": "…", "tokenType": "Bearer", "expiresIn": 2592000 } }, … }
```

Three things to notice. The *method* is in the body (`type`), not the path — every task goes to one endpoint. The *caller's identity* is in the body (`issuer`) and proven by the `proof`, not by a cookie. And the response carries a `threadId` echoing the request `id`, which is how correlation works when the transport isn't request/response (queues, DIDComm).

### 2.3 The consumer pipeline you'd otherwise hand-roll

The framework spec (§7.2) defines what a receiver must do with every inbound document, and the libraries implement it so you don't: validate the envelope against the framework schema; dispatch on `type`; cross-check the in-band `issuer` against whatever the transport authenticated (bearer token → DID map) and refuse `identityMismatch`; check `recipient` is you; check freshness (`issuedAt` within a window, `expiresAt` not passed); verify the proof; validate the payload against the task's JSON Schema; and — for "consequential" tasks like granting access or opening a session — keep a **replay record keyed on the document `id`** so the same document can't execute twice and a different document under the same `id` is a `409 idConflict`. In TypeScript this is one call, `consumeInbound(...)` from `@openvtc/trust-tasks`, with your handler as a callback. You've written most of that pipeline before, badly, under deadline; here it is normative and tested across four languages.

### 2.4 Where the libraries are (as of 2026-10-18)

The OpenVTC GitHub org has no "how to build on this" guide; its `vti-setup/developer/` folder is for *participants*, not app developers. The developer material lives in the **ToIP** repos:

- `trustoverip/dtgwg-trust-tasks-tf` — `GETTING-STARTED.md` (runnable round trip in Rust, TS, Go, Dart, plus "the four traps"), `SPEC.md` (normative framework), `bindings/https/0.2/spec.md` (wire format), `specs/<family>/<task>/<ver>/` (every task with `spec.md` and `payload.schema.json`). npm: `@openvtc/trust-tasks` (generated types + runtime, 0.26.x), `@openvtc/trust-tasks-proof` (Data Integrity sign/verify, `did:key` offline).
- `trustoverip/dtgwg-vti-spec` — the VTI specification; `spec/07-clients.md` is the chapter the lead points newcomers to.
- `trusttasks.org` — the registry website (JS-rendered; read the repo if you're a bot).
- `OpenVTC/rp-sdk-js` — relying-party SDK for the QR/trigger-link wallet sign-in (`auth/oob/*`) and `confirm/*` consent. Useful later, not first.
- `OpenVTC/vti-didcomm-js` — browser/Node DIDComm v2 primitives. Later still.
- `OpenVTC/wiki` (published at OpenVTC.github.io/wiki) — the best *conceptual* map, candid about gaps.

## 3. What is actually different, and why it will fight you

This section exists because a guide that only reassures is a marketing document.

### 3.1 Identity is a key, not a row

In your app, a user *is* a row in `users` with an email; everything else hangs off the primary key you minted. In VTI, a party *is* whoever controls a private key; the DID is derived from or points to that key, and *you never mint it*. Your `users.id` becomes a local cache of someone else's identifier. Consequences: you cannot "reset" a user's identity, there's no password-reset email for a lost `did:key`, and two devices are two identities unless the person has a VTA (or wallet) holding their key across devices. The practical answer for consumer apps is that the *bootstrap* identity is a per-browser `did:key` and the *durable* identity, if the person wants one, is a wallet/VTA-held `did:webvh` that they link later. Design your `members` table so a member can have several DIDs and, for the transition, still an email.

### 3.2 Authorization is a signed document, not a session

Every operation that matters is meant to be reachable only as a signed Trust Task ("the signed door"). The session (bearer token) is still there — `auth/authenticate` returns one — but the spec is explicit that a prior authorization is never evidence that a later request is authorized (VTI-CLT-041), and that a human step-up binds to *one operation's payload digest*, not to a session. If your API has `PUT /groups/:id/settings` guarded by "is admin in session," the VTI way is a signed `acl/update`-shaped document whose proof names the admin. You do **not** have to convert all your endpoints. You do have to accept that for the ones you convert, the bearer token stops being the thing that authorizes.

### 3.3 Privacy by construction, which collides with moderation by observation

Pairwise DIDs (a different identifier per relationship), correlation-scope declarations on credentials, MLS-encrypted "data rooms" whose host cannot read records, mediators that can't see plaintext — the stack is built so that infrastructure operators learn as little as possible. That is the point. It is also the opposite of how most community platforms do trust & safety: by having the server see everything, run classifiers, and let moderators read reports with full context. If you adopt data rooms for DMs or private groups, your moderators lose the ability to read them. That may be exactly what your members want; it is a product decision, not a technical one, and it should be made deliberately before you touch `rooms/*`.

### 3.4 The record of truth leaves your database

Membership becomes a credential the *member* holds, not only a row you hold. Relationships become VRCs between two people, not a `follows` join table. Your database still caches these, but the authoritative artefact is a signed document that survives your outage, your acquisition, or your decision to delete the row. For a platform used to owning the social graph, this is the real philosophical shift the lead dev separated from the technical one. You can defer it. You should know it's there.

### 3.5 The user carries infrastructure

For anything beyond `did:key`-in-a-browser, a person needs a wallet (browser plugin, Keyring mobile app) and usually a VTA (self-hosted or from the VTA Farm). Today that is early-adopter territory. Any flow you ship that *requires* it will have single-digit-percent uptake; any flow that *offers* it alongside email/OAuth will be used by the people who care and ignored by everyone else, which is fine.

### 3.6 Everything is pre-1.0 and moving weekly

Between 2026-10-07 and 2026-10-17 the relying-party SDK changed its primary sign-in protocol, the VTI dropped its REST management surface in favour of Trust Tasks only, and the wiki was already stale against the code. `@openvtc/trust-tasks` is at 0.26.x. Pin everything, record the pins, and expect to re-read specs when you bump. Also: much of this documentation is AI-assisted (every repo has a `CLAUDE.md`), which makes it thorough and uniformly phrased but not a guarantee the prose matches behaviour. Trust tests and examples over READMEs.

## 4. The migration path: one task at a time

The ordering principle is **adopt the Trust Task that replaces something you already do, with the identity method that costs your users nothing, and only then widen.** Each step below is independently shippable and independently reversible.

### Step 0 — Inventory your "doors"

List every place a party proves who they are or asks you to do something consequential: sign-in, join a group, grant a role, post, DM, confirm a payment, delete an account. For each, note what authenticates it today (cookie, JWT, API key, nothing) and whether it is *consequential* in the framework's sense (grants access, moves value, discloses, irreversible). This list is your migration backlog and most of it will never move; that's expected.

### Step 1 — Stand up `POST /trust-tasks` and speak two tasks

Add one endpoint. Register exactly `auth/challenge/0.1` and `auth/authenticate/0.3`. Verify proofs for `did:key` issuers only (offline, no resolver). On success mint **the same session/token your email or OAuth path mints**, and return it in the `TokenBundle.accessToken`. The browser side mints a `did:key` (WebCrypto Ed25519, non-extractable), stores it in IndexedDB, and signs the authenticate document. Users see a "Sign in with this device" button beside the ones they know.

Why this first: it touches no existing table semantics except making `email` nullable and adding `did`; it exercises the whole consumer pipeline, the proof library, the replay guard, and the error vocabulary; it is compatible with the OpenVTC browser plugin's own sign-in (which posts `auth/challenge` → `auth/authenticate/0.2` to a relying party's `/trust-tasks`); and it needs no wallet, VTA, mediator, or DID hosting. `SPIKE-SPEC.md` in this folder is a complete, test-oriented specification of this step for one real codebase.

What you'll learn: whether the libraries load in your runtime (Deno/Node/edge), what the replay record costs you in a shared database, and how the framework's error documents feel in your client code.

### Step 2 — Accept wallet identities and bind a session key

Swap the `did:key`-only verifier for one with a resolver (`did:web`, `did:webvh`) behind a network guard (refuse loopback/private hosts, https only — `vti-didcomm-js` has a reference `net-guard`). Register `auth/authenticate/0.2` too, for the current plugin. Honour `payload.sessionKey`: a per-login `did:key` that may sign subsequent documents as the session's subject, with `proofPurpose: authentication`, for the session's lifetime only. Add `auth/whoami` and `auth/revoke-session`. Now a person with a wallet signs in as their durable persona, and your API can start accepting *signed* writes from that session instead of bearer-only writes. This is the first step that changes your write path, so scope it to one resource.

### Step 3 — Make one consequential action a signed door

Pick the smallest irreversible admin action you have — remove a member, change a role — and expose it as a Trust Task (the `acl/*` family maps well: `acl/grant`, `acl/revoke`, `acl/change-role`, `acl/update`). Require a verified proof from a DID you've recorded as an admin. Keep the old button working through the old route for admins who haven't linked a DID. Measure how many use the new door. This teaches you the "signed door" model with real stakes and a trivially small blast radius.

### Step 4 — Issue your first credential

Your membership record becomes a Verifiable Credential you *issue* to the member, in addition to the row you keep. Start with a plain membership credential (the DTG credential spec and `OpenVTC/dtg-credentials` define the shapes; the VTC does this natively). To issue, you need a signing key for *your community*, which is the first moment you want a VTA (or, for a spike, a `did:web` with a key in your secrets manager, clearly labelled as temporary). Members with wallets receive and hold it; members without it see nothing change. You've now made your membership portable without changing a single feature.

### Step 5 — Consent and confirmation for sensitive actions

Where you'd today pop a "Are you sure?" modal or send a confirmation email for a payment, a deletion, or a data export, send a `confirm/request/0.1` to the member's wallet and verify the `confirm/response/0.1` (`rp-sdk-js` implements the verifier). The signed response *is* the record of consent, retainable in your audit log, and it can't be produced by a compromised session alone. Falls back to your existing modal for members without a wallet.

### Step 6 — Decide, deliberately, about the heavy pieces

Only here do the big questions arrive: do you want a VTC (your community as a first-class VTI service with its own VTA, join policies, trust registry)? Do you want the QR/trigger-link cross-device sign-in (`auth/oob/*`, `rp-sdk-js`, needs a `did:web`/`did:webvh` service identity)? Do you want pairwise relationship credentials (VRCs) for connections? Do you want MLS-encrypted data rooms for private spaces? Each is a product decision with the trade-offs from Section 3 attached. You will make them far better after Steps 1–5 than before.

### What never moves

Your public read paths (feeds, search, SEO pages), your analytics, your email transport, most of your CRUD. Trust Tasks are for the places where *who asked* and *that they asked* need to survive as evidence. Everything else stays REST, stays Postgres, stays boring.

## 5. Practical notes from doing Step 1 against a real codebase

These come from `relational-builder` (a Vite/React + Supabase app whose "Community Cloud" backend already had email-code sign-in and a document store):

- **One endpoint, body is the bare document.** The HTTPS binding wants `POST /trust-tasks` with the Trust Task as the whole body. If your platform needs an app key, put it in the query string, not the body, or you've forked the wire format.
- **Replay record and challenge store must be shared.** Edge/serverless isolates don't share memory. The TS library ships `InMemoryReplayGuard`; you will write a Postgres one on day one. Key it on the document `id`, store the canonical digest *including proof*, and fail closed (503, no execution) if the store is unreachable.
- **Consume the challenge atomically.** A single `UPDATE … SET consumed_at = now() WHERE session_id = ? AND consumed_at IS NULL RETURNING *` is simpler and safer than the spec's compare-then-consume ordering on a REST-ish database API; document the deviation.
- **Set party members and `issuedAt` before signing.** Trap 4.1 from the getting-started guide. A field filled after signing isn't covered by the proof → `proofInvalid`, which looks like a broken signature and isn't.
- **Transport identity vs in-band identity.** If you have no bearer-token→DID mapping yet, use the "unauthenticated transport" mode so the in-band `issuer` is authoritative; verify in the library source that this is what it does, because the alternative is every document failing `identityMismatch`.
- **Make the registered type set a constant.** You'll add versions (`0.2` for the current plugin) and families over time; dispatch should be data, not a `switch`.
- **Mark every shortcut.** `// SPIKE:` on unsigned responses, label-only service DIDs, did:key-only verification. Grep for them before you call anything production.

## 6. For community platforms: posts, events, DMs, group chats

This section is for people building or extending platforms like Hylo (open source: a Node/GraphQL API over Postgres with a React client; groups containing posts of several kinds — discussions, requests/offers, events, projects — plus direct messages and group chat) and Mighty Networks (closed SaaS: spaces, feeds, events, courses, chat, with integration via SSO, webhooks/Zapier and a member API rather than source access). *I'm describing these from general knowledge as of mid-2026; verify current integration surfaces before planning.*

### 6.1 The mapping, feature by feature

| Your feature | Nearest VTI/Trust Tasks concept | How faithful the mapping is |
|---|---|---|
| **Member account** | A DID (bootstrap `did:key`, durable `did:webvh` persona) + a **membership credential** issued by the community | Good. Account becomes "DID(s) + credentials we issued + our local profile cache." |
| **Group / Space / Network** | A **VTC** (community service with its own VTA, join policy, roster, trust registry) — or, lighter, just a credential-issuing context inside *your* service | Good conceptually; heavy operationally if every group becomes a VTC. Start with your platform as *one* issuer with per-group credential types. |
| **Join request / approval / invite** | VTC `join-requests/*` and `members/*` tasks; `vetting/*` for peer identity vetting; invitation credential | Good. This is the best-developed part of the VTC. |
| **Roles (admin, moderator, member)** | `acl/*` entries and role credentials; `members/promote-to-admin`, `members/admin-remove` | Good. |
| **Public post / event in a feed** | *No direct task.* Stays in Postgres. Optionally **signed** by the author's DID (a Data Integrity proof over the post) so provenance survives export | Partial, by design. Feeds are read-heavy, searchable, moderated — exactly what VTI doesn't try to replace. |
| **RSVP / sign-up to an event** | `confirm/request` + `confirm/response` (signed consent) if you want a verifiable record; otherwise a plain write under a signed session | Reasonable. Overkill for most RSVPs; right for commitments that matter (volunteer shifts, paid events). |
| **Connections / follows / "I know this person"** | **VRC** (`vrc/relationships/propose`, `issue`): peer-to-peer relationship credentials, usually under pairwise DIDs | Strong fit for *mutual* trust relationships; poor fit for asymmetric follows. The VRC logic today lives in Rust (`openvtc-core`) and the TUI; there is no JS library for it yet. |
| **Direct messages** | DIDComm v2 via a mediator, or a two-member **data room** | Technically yes; product cost high (see 6.3). |
| **Group chat / private channel** | **Data room** (`rooms/*`): MLS-encrypted shared space with records, blobs, epochs, invitations, membership credentials, curate (pin/retract) | The closest primitive, and the most consequential adoption decision you'll make. |
| **Endorsements / testimonials** | `credentials/endorsements` (VTC), endorsement credential | Good. |
| **Reporting / moderation queue** | Partially `rooms/records/curate` (demote/retract/pin) and VTC `admin/*`; nothing for content classification | Weak. See 6.3. |
| **Cross-community reputation** | Trust registry (`registry/*`, TRQP) and cross-community recognition | Good — this is a capability you probably *don't* have today and could gain. |

### 6.2 A path for community platforms specifically

Follow Section 4, with these substitutions.

**Step 1 as written** — `/trust-tasks` with `did:key` sign-in beside your existing login. For Hylo this is a new resolver/route on the API and a small client module; for a Mighty Networks operator it is *not possible inside Mighty* — you'd stand up a sidecar service that speaks `/trust-tasks` and bridges to Mighty via its SSO/OIDC (if your plan supports it) and member API. The sidecar *is* the lead developer's model; it's just that for closed platforms it's the only model.

**Step 4 before Step 2** — issue a **membership credential per group** as soon as you can sign anything. For a community platform, portable membership is the single most valuable thing this stack offers: a member of your mutual-aid group can prove it to a partner organization's tool without you building an integration, and your group's membership survives your platform. Issue it to members who have a wallet; cache its existence for everyone.

**Step 3 on moderation actions** — remove-member and change-role are your highest-stakes admin actions and already map to `acl/*`/`members/*`. Make them signed doors first.

**Then VRCs for the "relational" layer** — if your platform's point is relationships between people (not followers), `vrc/relationships/propose` + `issue` is the right primitive, and OpenVTC's own tooling (the TUI, the vetting flow) is built around it. Budget for the fact that you'll be implementing against schemas in TypeScript with no reference library. Consider whether a pairwise DID per relationship is something your UX can explain; if not, the DTG credential spec lets a credential declare `issuerScope: public` and use the persona DID, at a correlation cost.

**Data rooms last, and only for the tier where end-to-end is the feature** — see 6.3.

### 6.3 The hard conversation: encrypted rooms vs. a platform that can see

Data rooms (`rooms/*`) are the VTI's answer to "a private space with records and files." They are MLS group-encrypted: the room's host stores ciphertext, membership changes advance a key epoch, removed members can't read what's written after, and the member's keys live with their VTA or wallet. Records can be listed, read, written, curated (pinned, demoted, retracted) — enough to build a channel.

What you lose: server-side search over room content, server-side notifications with content previews, link unfurling, content classifiers, and moderators reading a reported thread in context unless a member hands them the plaintext. What you gain: a credible claim that your platform *cannot* read members' private conversations — which for organizing, mutual aid, health, or anything adversarial is sometimes the whole reason people would come.

This is why it goes last. By the time you've done identity, membership credentials and signed admin actions, you'll know whether your members want *that* trade, for *which* spaces. A reasonable end state is three tiers: public feeds unchanged in Postgres; private groups as signed-write Postgres with membership credentials gating access; and a small number of "sealed" rooms that are genuinely end-to-end, with your moderation story for those being membership and curation rather than reading.

### 6.4 Things that will bite community platforms in particular

Notifications and email digests assume you hold an email; DID-only members break every "we'll email you" path. Keep email optional-but-encouraged for the transition, and treat a mediator-delivered DIDComm notification as a later enhancement.

Search and discovery over signed or sealed content needs rethinking: signed-but-public content indexes fine; sealed content doesn't, by design.

Account recovery for a lost `did:key` is "make a new one and have an admin re-admit you" unless the person has a wallet. Say so in the UI.

Analytics on relationships gets harder when relationships are pairwise credentials you didn't issue and may not even see. If your business model is the social graph, read Section 3.4 again.

Interoperability is the prize. A membership credential issued by your platform and recognized via a trust registry by a neighbouring platform's tools is a kind of federation that today requires bespoke APIs on both sides. It is the reason to put up with the rest.

## 7. A checklist before you start

- You can state, in one sentence, which *one* task you'll speak first and what existing behaviour it replaces.
- You've pinned `@openvtc/trust-tasks` and `@openvtc/trust-tasks-proof` versions and recorded the upstream commit date.
- You've confirmed the libraries load in your runtime (a one-line import smoke test) before anyone designs anything.
- Your `members` table can hold a DID and a nullable email, with a check that at least one is present.
- You have a shared (not in-memory) replay record and challenge store, and they fail closed.
- Every shortcut is marked and listed, so "we'll fix that later" is a grep, not a memory.
- Your users have a visible, working path that does *not* require a wallet, and the new path sits beside it.
- Someone has read `GETTING-STARTED.md` §4 ("the four traps") and `SPEC.md` §7.2 end to end. It's an hour. It saves a week.

## 8. Further reading, in the order that helped

1. `trustoverip/dtgwg-trust-tasks-tf/GETTING-STARTED.md` — start here, run the round trip.
2. `trustoverip/dtgwg-trust-tasks-tf/SPEC.md` §4.8.1, §7.2, §8 — identity precedence, consumer pipeline, errors.
3. `trustoverip/dtgwg-trust-tasks-tf/bindings/https/0.2/spec.md` — the wire format you'll actually implement.
4. `trustoverip/dtgwg-vti-spec/spec/07-clients.md` — Client Onboarding and Lifecycle; the chapter the OpenVTC lead points newcomers to.
5. `OpenVTC/wiki` (`content/overview.md`, `content/concepts/trust-tasks.md`, `content/concepts/data-rooms.md`) — the conceptual map.
6. `OpenVTC/verifiable-trust-infrastructure/docs/02-vta/integration-guide.md` — when you're ready for a VTA to hold your service key.
7. The First Person Project white paper and the DTG credential spec — for the "why" behind personhood and relationship credentials.
