-- Trust Tasks sign-in spike, Increment 1 (docs/spikes/openvtc-signin/SPIKE-SPEC.md S-10, S-11).
-- Additive and re-runnable: every create/add is guarded; nothing is dropped or rewritten.

-- Members may now be identified by a DID instead of an email.
alter table public.app_members alter column email drop not null;
alter table public.app_members add column if not exists did text;
create unique index if not exists app_members_app_did_idx
  on public.app_members (app_id, did) where did is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_members_identity_chk') then
    alter table public.app_members
      add constraint app_members_identity_chk check (email is not null or did is not null);
  end if;
end
$$;

-- Per-app opt-in; off by default.
alter table public.cloud_apps add column if not exists trust_signin_enabled boolean not null default false;

-- Outstanding auth/challenge sessions (S-20, S-21). Consumed by one atomic PATCH.
create table if not exists public.app_tt_challenges (
  session_id  text primary key,
  app_id      uuid not null references public.cloud_apps(id) on delete cascade,
  subject     text,
  challenge   text not null,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists app_tt_challenges_app_expires_idx on public.app_tt_challenges (app_id, expires_at);

-- SPEC §7.2 item 11 duplicate-execution record, keyed on the document id alone (S-11, S-22).
-- digest = sha256Hex(canonicalJson(document)) including proof; response = retained #response.
create table if not exists public.app_tt_replay (
  doc_id   text primary key,
  app_id   uuid not null references public.cloud_apps(id) on delete cascade,
  digest   text not null,
  response jsonb,
  until_at timestamptz not null
);
create index if not exists app_tt_replay_until_idx on public.app_tt_replay (until_at);

-- Service-role only, like app_sessions: RLS on, no policies.
alter table public.app_tt_challenges enable row level security;
alter table public.app_tt_replay enable row level security;
