-- QA round 2 (finding R2-04): the public.worlds table was created on the live project by migrations that are not
-- in this repository (20261102085222 shared_world_sync, 20261102085352 lock_world_ids), so the database could not
-- be rebuilt from the repo. This file records that table as it exists live (read from the live catalog on
-- 16 Nov 2026). On the live project it changes nothing: every statement is guarded.
-- Order: apply before 20261108_world_hardening.sql on a fresh database.

create table if not exists public.worlds (
  id text primary key,
  rev bigint not null default 0,
  state_gz text,
  leader_id text,
  leader_at timestamptz,
  updated_at timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.worlds'::regclass and conname = 'worlds_id_check') then
    alter table public.worlds add constraint worlds_id_check check (char_length(id) <= 40);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.worlds'::regclass and conname = 'worlds_demo_only') then
    alter table public.worlds add constraint worlds_demo_only check (id = 'demo');
  end if;
end $$;

alter table public.worlds enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'worlds' and policyname = 'Anyone can read the demo world') then
    create policy "Anyone can read the demo world" on public.worlds for select using (true);
  end if;
end $$;
revoke insert, update, delete, truncate on public.worlds from anon, authenticated;
grant select on public.worlds to anon, authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'worlds') then
    alter publication supabase_realtime add table public.worlds;
  end if;
end $$;
