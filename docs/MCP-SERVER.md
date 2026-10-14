# The RT MCP server and the Builder

The Relational Tech MCP server (`mcp.relationaltechproject.org/mcp`, repo
`The-Relational-Technology-Project/rt-mcp-server`, hosted on Railway, deploys
from `main`) is how builders who work in their own tools (Claude Code,
Cursor, Lovable, a chat window) reach the commons. As of server v0.7.0 it
also reaches into the Builder's own backend, so those builders get what
Builder users get: the principles and practices the Builder's AI builds by,
live civic data, prompt seeds, and the community build day wall.

This doc is the Builder-side half of that. The server's README has the
tool-by-tool reference.

## What the Builder publishes for the server

### `/knowledge/*.md` — principles, practice, frames

`scripts/export-builder-knowledge.mjs` renders three markdown documents from
`src/knowledge/` into `public/knowledge/` (and `index.json`). It runs as
`prebuild`, so every Vercel deploy regenerates them; `npm run knowledge`
runs it by hand. The generated files are committed too, so the dev server
and the MCP server's fallback both have them.

| File | Source |
|---|---|
| `builder-principles.md` | `formatPrinciplesForPrompt()` in `src/knowledge/rtp-principles.ts` — the exact block the Builder's system prompt opens with |
| `builder-practice.md` | `BUILDER_PRACTICE_MD` in `src/knowledge/builder-practice.ts` — the Builder's working practices with no stack in them (core loop first, seed one neighbor, relational mechanics, easy for a neighbor, personality from the place, working with the person) |
| `builder-frames.md` | `FRAMES` in `src/knowledge/frames.ts` — civic media, practice-first, relational, microgrants, deliberative |

The server reads these live (10-minute cache) as the `rtp://builder/*`
resources and the `get-builder-guidance` tool. Edit the sources, never the
generated files. `builder-practice.ts` is the one hand-written source: when
the system prompt in `context-builder.ts` learns a new practice worth
carrying outside the Builder, add it there too.

### `commons-bridge` — the Builder's door for outside tools

`supabase/functions/commons-bridge/index.ts`, deployed to the Builder
project with `verify_jwt: false` (see CLAUDE.md for the Management API
command). No account needed; the room key is the credential for the wall.

| Action | What it does |
|---|---|
| `wall` `{event_code}` | One event's demo wall (via `event_showcase_for`), plus the presentation link |
| `share` `{event_code, project_name, builder_name?, one_liner?, demo_url?, screenshot?, contact_label?, contact_value?, email?, via}` | Pins a project to the wall with the service role: no `owner_id`, no deck, `submitted_via` = `mcp`, `email`, or `host` (the Event Admin page's form). A re-share with the same email and project name replaces the card. |
| `civic_endpoints` `{city?}` | Active rows from `city_data_endpoints` through the anon-callable `public_city_data_endpoints()` RPC |
| `seeds` `{query?, limit?}` / `seed` `{share_slug}` | Shared prompts (`prompts.is_shared`), with `?prompt=<slug>` links back into the Builder |
| `POST ?inbound=resend` | The build day inbox (below) |

Per-IP rate limit of 20 requests an hour per warm isolate. Screenshots land
in the public `studio-library` bucket under `event-wall/`, like Share Live's.

### The open-door migration

`supabase/migrations/20261014090000_event_wall_open_door.sql`:

- `event_showcase.owner_id` and `deck_url` become nullable; `submitted_via`
  (`builder` | `mcp` | `email` | `host`, default `builder`; `host` added by
  `20261014120000_event_wall_host_door.sql`) and `submitter_email`
  (service-role only, never granted to clients) are added
- a partial unique index keeps one card per outside builder per project
  per event
- `event_showcase_for()` returns `submitted_via` so the shelf, the show
  page, and the admin page can say "built with their own tools" and skip
  the Slides link
- `public_city_data_endpoints()` lets anyone read the active civic endpoints

Both migrations are applied to production (Oct 14, 2026). The UI treats a
missing `submitted_via` as the Builder's own door.

## The build day inbox (email → wall)

Builders who would rather not wire an MCP server can email their build.
Resend receives the mail and posts an `email.received` webhook to
`commons-bridge?inbound=resend`; the function reads the full email through
Resend's receiving API, finds the room, and pins the card.

What the function reads from an email:

- **Event code:** a plus address (`wall+BUILDJAM@…`), then any uppercase
  token in the subject or the first lines of the body that matches a live
  event code. No live code → a reply explaining what to put in the subject.
- **Project name:** the subject with the code stripped.
- **One-liner:** the first body line that is not a link.
- **Demo link:** the first `http(s)` URL in the body.
- **Picture:** the first image attachment under 4MB.
- **Builder:** the From name; the From address is kept as `submitter_email`.

It always replies: either "it's on the wall" (with the link, and what to
re-send to fill in a card missing its link or picture) or "which build day
is this for?". A re-sent email with the same subject replaces the card.

### Setting it up (one time, in Resend)

1. **Receiving domain.** In Resend, add receiving to `relationalbuilder.org`
   (or a subdomain such as `wall.relationalbuilder.org`) and publish the MX
   record it gives you. Sending from `hello@relationalbuilder.org` already
   works, so only the MX record is new.
2. **Webhook.** Add a webhook for the `email.received` event pointing at
   `https://<project>.supabase.co/functions/v1/commons-bridge?inbound=resend`.
   Copy its signing secret (`whsec_…`).
3. **Secret.** Set `RESEND_WEBHOOK_SECRET` on the Builder project (Management
   API `POST /v1/projects/<ref>/secrets`, or the dashboard). Until it is
   set the inbound path answers 503 and nothing is pinned. `RESEND_API_KEY`
   is already shared across functions. Optional: `WALL_FROM_EMAIL` to reply
   from a different sender.
4. **The slide.** Put the address and the rule on the build day slide:
   "Email it to wall@relationalbuilder.org with the event code in the
   subject: `BUILDJAM: your project's name`. A line about it, a link, and a
   screenshot make the card."

Any address at the receiving domain works (`wall@`, `buildday@`,
`wall+CODE@`); the function only cares about the code.

## What this adds up to at a build day

Four doors onto one wall, all presenting from `/show/CODE` in the order
things were shared:

1. **Relational Builder in the browser:** Share Live → pin (the deck plus the
   card).
2. **Your own AI tool with the MCP server:** the `build-day` prompt sets the
   stance, shows the room, pulls live civic data, and ends with
   `share-to-build-day-wall` (the card, no deck).
3. **The host, from the Event Admin page:** "Add a build made with other
   tools" — the builder tells the host (in person, or by emailing them),
   the host types the card in. No setup, a person in the loop, works for
   every event host. This is the default for builders with their own tools;
   the doors below are for rooms that want it unattended.
4. **Email, unattended:** the code in the subject, a link, a screenshot (the
   card, no deck). Needs the one-time Resend setup above.

Cards without a deck present as a full-screen card (picture, name, line,
builder) or, when there is a live link, as the live app.

## Other things the server now carries from here

- **Prompt seeds** (`search-prompt-seeds`, `get-prompt-seed`): every shared
  prompt in the Builder is now findable from any tool, credited, with a
  link back. Sharing a prompt in the Builder is how a seed enters the
  library.
- **Civic data** (`find-civic-data-endpoints`): the same `city_data_endpoints`
  rows the Builder injects into context, with the fetch recipe generated
  apps use.
- **The Builder's stance** (`relational-builder-stance` prompt,
  `get-builder-guidance` tool): a builder in Claude Code can start a session
  the way a Builder session starts.
