-- OCPP 1.6J central system for VoltFleet (Edge Function `ocpp`). Private schema: not exposed by the Data API.
create schema if not exists private;
create table if not exists private.ocpp_networks (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);
create table if not exists private.ocpp_charge_points (
  id text primary key,
  network_id uuid not null references private.ocpp_networks (id) on delete cascade,
  label text not null,
  password_hash text not null,
  auth_mode text not null default 'open' check (auth_mode in ('open', 'list')),
  vendor text, model text, serial text, firmware text,
  status text,
  boot_at timestamptz, last_seen timestamptz,
  connected boolean not null default false,
  instance text,
  created_at timestamptz not null default now()
);
create index if not exists ocpp_cp_network on private.ocpp_charge_points (network_id);
create table if not exists private.ocpp_connectors (
  cp_id text not null references private.ocpp_charge_points (id) on delete cascade,
  connector_id int not null,
  status text not null,
  error_code text, info text,
  power_w double precision, energy_wh double precision, soc double precision,
  updated_at timestamptz not null default now(),
  primary key (cp_id, connector_id)
);
create table if not exists private.ocpp_transactions (
  id bigserial primary key,
  cp_id text not null references private.ocpp_charge_points (id) on delete cascade,
  connector_id int not null,
  id_tag text not null,
  id_tag_status text,
  meter_start bigint not null,
  meter_stop bigint,
  start_at timestamptz not null,
  stop_at timestamptz,
  reason text,
  last_meter_wh double precision,
  last_power_w double precision
);
create index if not exists ocpp_tx_cp on private.ocpp_transactions (cp_id, id desc);
create table if not exists private.ocpp_commands (
  id bigserial primary key,
  cp_id text not null references private.ocpp_charge_points (id) on delete cascade,
  action text not null,
  payload jsonb not null default '{}',
  status text not null default 'queued',
  unique_id text,
  result jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz, done_at timestamptz
);
create index if not exists ocpp_cmd_pending on private.ocpp_commands (cp_id, status);
create table if not exists private.ocpp_log (
  id bigserial primary key,
  cp_id text not null references private.ocpp_charge_points (id) on delete cascade,
  dir text not null, kind text not null, action text,
  payload jsonb,
  at timestamptz not null default now()
);
create index if not exists ocpp_log_cp on private.ocpp_log (cp_id, id desc);
create table if not exists private.ocpp_id_tags (
  network_id uuid not null references private.ocpp_networks (id) on delete cascade,
  id_tag text not null,
  status text not null default 'Accepted',
  label text,
  primary key (network_id, id_tag)
);
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;
