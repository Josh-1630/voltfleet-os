-- Smartcar connections for VoltFleet EV Manager.
-- Lives in a private schema that the public Data API does not expose; only the `smartcar` Edge Function
-- (connecting with the database URL) reads or writes it. No vehicle data ever enters the shared demo world.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- One-time `state` values for the Connect flow (stored hashed, valid for 30 minutes).
create table if not exists private.smartcar_states (
  state_hash text primary key,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
-- A browser that completed Connect holds an access key; only its SHA-256 hash is stored.
create table if not exists private.smartcar_links (
  id bigserial primary key,
  key_hash text not null unique,
  user_id text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists smartcar_links_user on private.smartcar_links (user_id);
-- Last reading per vehicle, so polling devices don't trigger a paid Smartcar request every time.
create table if not exists private.smartcar_cache (
  vehicle_id text primary key,
  user_id text not null,
  info jsonb,
  payload jsonb,
  fetched_at timestamptz
);
create index if not exists smartcar_cache_user on private.smartcar_cache (user_id);
-- The application-level Smartcar token (OAuth client credentials, valid one hour).
create table if not exists private.smartcar_app_token (
  id int primary key check (id = 1),
  access_token text not null,
  expires_at timestamptz not null
);
revoke all on all tables in schema private from public, anon, authenticated;
