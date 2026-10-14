-- A fourth door onto the wall: the host.
--
-- At a build day, the simplest way for a builder who used their own tools
-- to get on the wall is to tell the host. The Event Admin page now has a
-- small form for exactly that; the card lands through commons-bridge with
-- submitted_via = 'host', so the wall can say so.

alter table public.event_showcase
  drop constraint if exists event_showcase_submitted_via_check;
alter table public.event_showcase
  add constraint event_showcase_submitted_via_check
  check (submitted_via in ('builder', 'mcp', 'email', 'host'));
