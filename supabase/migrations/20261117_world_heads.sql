-- QA round 3 (finding R1-09, remainder): live updates without the snapshot in every message.
-- Realtime used to send the whole new row of public.worlds / public.org_worlds (state_gz, ~140 kB for the demo)
-- to every subscribed tab on every simulation step, including back to the device that had just written it.
-- These small "head" tables carry only the revision, the lease holder and the time. They are kept up to date by
-- triggers and published instead; the app subscribes to them and downloads the snapshot only when the revision
-- is newer than the one it already holds (so the writer never downloads its own write again).
-- worlds and org_worlds stay in the publication for app versions cached before this change; a later migration
-- can drop them once those are gone. Read access mirrors the source tables (RLS: anyone for the demo, members
-- with the second factor for workspaces). Safe to re-run. Requires 20261116_worlds_baseline.sql and
-- 20261108_accounts.sql; uses mfa_ok() from 20261109_mfa.sql.

create table if not exists public.world_heads (
  id text primary key,
  rev bigint not null default 0,
  leader_id text,
  updated_at timestamptz not null default now()
);
create table if not exists public.org_world_heads (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  rev bigint not null default 0,
  leader_id text,
  updated_at timestamptz not null default now()
);

create or replace function public.sync_world_head() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if tg_op = 'UPDATE' and new.rev is not distinct from old.rev then return null; end if; -- lease-only change: nothing new to fetch
  if tg_table_name = 'worlds' then
    insert into public.world_heads (id, rev, leader_id, updated_at) values (new.id, new.rev, new.leader_id, now())
    on conflict (id) do update set rev = excluded.rev, leader_id = excluded.leader_id, updated_at = excluded.updated_at;
  else
    insert into public.org_world_heads (org_id, rev, leader_id, updated_at) values (new.org_id, new.rev, new.leader_id, now())
    on conflict (org_id) do update set rev = excluded.rev, leader_id = excluded.leader_id, updated_at = excluded.updated_at;
  end if;
  return null;
end; $$;
revoke execute on function public.sync_world_head() from public, anon, authenticated;

drop trigger if exists worlds_head on public.worlds;
create trigger worlds_head after insert or update on public.worlds for each row execute function public.sync_world_head();
drop trigger if exists org_worlds_head on public.org_worlds;
create trigger org_worlds_head after insert or update on public.org_worlds for each row execute function public.sync_world_head();

-- Backfill (and keep in step on re-run).
insert into public.world_heads (id, rev, leader_id, updated_at) select id, rev, leader_id, updated_at from public.worlds
on conflict (id) do update set rev = excluded.rev, leader_id = excluded.leader_id;
insert into public.org_world_heads (org_id, rev, leader_id, updated_at) select org_id, rev, leader_id, updated_at from public.org_worlds
on conflict (org_id) do update set rev = excluded.rev, leader_id = excluded.leader_id;

alter table public.world_heads enable row level security;
alter table public.org_world_heads enable row level security;
drop policy if exists "Anyone can read the demo head" on public.world_heads;
create policy "Anyone can read the demo head" on public.world_heads for select using (true);
drop policy if exists "Members read their workspace head" on public.org_world_heads;
create policy "Members read their workspace head" on public.org_world_heads for select to authenticated using (org_id = public.my_org() and public.mfa_ok());
revoke all on public.world_heads, public.org_world_heads from anon, authenticated;
grant select on public.world_heads to anon, authenticated;
grant select on public.org_world_heads to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'world_heads') then
      alter publication supabase_realtime add table public.world_heads;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'org_world_heads') then
      alter publication supabase_realtime add table public.org_world_heads;
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';
