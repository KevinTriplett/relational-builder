-- The event wall opens to builders who brought their own tools.
--
-- A community build day used to have one door onto the demo wall: build in
-- Relational Builder, sign in, Share Live, pin. Builders who bring their
-- own AI (Claude Code, Cursor, Lovable, a chat window) had no door at all.
-- Now the room key is the door: the `commons-bridge` edge function takes the
-- event code plus a project name, a line, a link, and a picture, and pins
-- the project to the wall on the builder's behalf (reached through the RT
-- MCP server's share-to-build-day-wall tool, or by email). Those entries
-- have no Builder account behind them and no Share Live deck, so both
-- columns relax; `submitted_via` says which door an entry came through,
-- and `submitter_email` (never readable by clients) lets the function
-- replace a re-sent entry and the host reach the builder.
--
-- Also here: the civic-data endpoint list, readable without an account
-- through one narrow RPC, so an outside builder's AI can find a city's
-- live open-data MCP server the way the Builder does.

alter table public.event_showcase
  alter column owner_id drop not null,
  alter column deck_url drop not null,
  add column if not exists submitted_via text not null default 'builder',
  add column if not exists submitter_email text;

-- Which door: builder (Share Live), mcp (an AI tool through the RT MCP
-- server), email (the build day inbox). Anything else is a bug.
alter table public.event_showcase
  drop constraint if exists event_showcase_submitted_via_check;
alter table public.event_showcase
  add constraint event_showcase_submitted_via_check
  check (submitted_via in ('builder', 'mcp', 'email'));

-- One card per outside builder per project per event: a re-sent email or a
-- second tool call replaces the card instead of doubling it (the bridge
-- deletes then inserts, like Share Live does; the index keeps a race from
-- producing two).
create unique index if not exists event_showcase_outside_key
  on public.event_showcase (event_code, lower(submitter_email), project_name)
  where owner_id is null and submitter_email is not null;

grant select (submitted_via) on public.event_showcase to anon, authenticated;
-- submitter_email stays service-role only on purpose: no grant.

-- The presentation RPC hands out which door too, so the show page and the
-- shelf can say "built with their own tools" on a card with no deck.
drop function if exists public.event_showcase_for(text);

create or replace function public.event_showcase_for(p_code text)
returns table (
  id uuid,
  event_name text,
  owner_id uuid,
  builder_name text,
  project_name text,
  one_liner text,
  screenshot_url text,
  deck_url text,
  demo_url text,
  contact_label text,
  contact_value text,
  submitted_via text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.event_name, s.owner_id, s.builder_name, s.project_name,
         s.one_liner, s.screenshot_url, s.deck_url, s.demo_url,
         s.contact_label, s.contact_value, s.submitted_via, s.created_at
  from public.event_showcase s
  where upper(s.event_code) = upper(trim(coalesce(p_code, '')))
  order by s.created_at asc;
$$;

revoke all on function public.event_showcase_for(text) from public;
grant execute on function public.event_showcase_for(text) to anon, authenticated;

-- ── Live civic data, findable without an account ─────────────────────
-- city_data_endpoints is readable by signed-in builders only. The
-- endpoints themselves are public, keyless MCP servers run by partner
-- networks, so the list is not a secret; this RPC hands out the active
-- rows' public columns to anyone, and nothing else.

create or replace function public.public_city_data_endpoints()
returns table (slug text, city text, kind text, mcp_url text, notes text)
language sql
stable
security definer
set search_path = public
as $$
  select e.slug, e.city, e.kind, e.mcp_url, e.notes
  from public.city_data_endpoints e
  where e.active
  order by e.city asc;
$$;

revoke all on function public.public_city_data_endpoints() from public;
grant execute on function public.public_city_data_endpoints() to anon, authenticated;
