-- QA round 3 (finding R1-08): per-person limits in the Edge Functions.
-- OCPP createNetwork and Smartcar start were limited by one global counter each (30 networks / 500 pending
-- connections an hour), so one anonymous script could block every operator and driver. The functions now
-- record who asked: the signed-in user's id when the request carries a valid Supabase session, otherwise null
-- (anonymous, for the public demo). Signed-in people get their own allowance; anonymous requests share a
-- separate pool, so anonymous traffic can no longer lock out signed-in customers. See supabase/functions/*.
-- The functions also work before this migration is applied (they fall back to the old global counting).
-- Safe to re-run. Requires 20261102_ocpp.sql and 20261102_smartcar.sql.

alter table private.ocpp_networks add column if not exists created_by uuid;
create index if not exists ocpp_networks_created_idx on private.ocpp_networks (created_at);
create index if not exists ocpp_networks_created_by_idx on private.ocpp_networks (created_by, created_at);

alter table private.smartcar_states add column if not exists created_by uuid;
create index if not exists smartcar_states_created_idx on private.smartcar_states (created_at);
create index if not exists smartcar_states_created_by_idx on private.smartcar_states (created_by, created_at);

revoke all on all tables in schema private from public, anon, authenticated;
