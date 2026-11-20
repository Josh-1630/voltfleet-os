-- Minimal stand-in for the Supabase platform pieces the migrations rely on (local test only).
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role supabase_auth_admin nologin;
grant usage on schema public to anon, authenticated, service_role;
create schema auth; grant usage on schema auth to anon, authenticated;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text, email_confirmed_at timestamptz, phone_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade, status text, factor_type text default 'totp', created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub', '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
create publication supabase_realtime;
create schema private;
-- worlds (created on the live project by migrations 20261102_shared_world_sync / lock_world_ids, not in the repo)
create table public.worlds (id text primary key check (char_length(id) <= 40), rev bigint not null default 0, state_gz text, leader_id text, leader_at timestamptz, updated_at timestamptz not null default now(), constraint worlds_demo_only check (id = 'demo'));
alter table public.worlds enable row level security;
create policy "Anyone can read the demo world" on public.worlds for select using (true);
grant select on public.worlds to anon, authenticated;
alter publication supabase_realtime add table public.worlds;
