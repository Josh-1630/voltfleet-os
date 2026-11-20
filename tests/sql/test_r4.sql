\set ON_ERROR_STOP 0
\pset format unaligned
\pset tuples_only on
-- Round 4: server retention (20261119_retention.sql) and erasure of email addresses. Made-up data only.
create or replace function pg_temp.as_user(uid text, aal text) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', uid, 'aal', aal, 'role', 'authenticated', 'amr', json_build_array(json_build_object('method','password','timestamp',1)))::text, false) $$;
-- the fixtures' own audit inserts must not run the purge before the test does
insert into private.maintenance (job, last_run) values ('purge_expired', now()) on conflict (job) do update set last_run = now();
-- ---------------------------------------------------------------- fixtures: one OCPP network, one Smartcar user, old and new rows
insert into private.ocpp_networks (id, key_hash, name) values ('00000000-0000-0000-0000-4000000000a1', 'h-net-r4', 'R4 network') on conflict do nothing;
insert into private.ocpp_charge_points (id, network_id, label, password_hash) values ('R4-CP1', '00000000-0000-0000-0000-4000000000a1', 'R4', 'x') on conflict do nothing;
insert into private.ocpp_transactions (cp_id, connector_id, id_tag, meter_start, start_at, stop_at) values
  ('R4-CP1', 1, '04A1B2C3D4E5', 0, now() - interval '100 days', now() - interval '100 days' + interval '1 hour'),   -- masked, kept
  ('R4-CP1', 1, 'AB12CD34', 0, now() - interval '10 days', now() - interval '10 days' + interval '1 hour'),         -- untouched
  ('R4-CP1', 1, 'OLDCARD999', 0, now() - interval '2200 days', now() - interval '2200 days' + interval '1 hour'),  -- deleted (over 6 years)
  ('R4-CP1', 2, 'ABC', 0, now() - interval '95 days', null);                                                       -- short tag, open: masked
insert into private.ocpp_commands (cp_id, action, payload, created_at) values ('R4-CP1', 'RemoteStartTransaction', '{"idTag":"04A1B2C3D4E5"}', now() - interval '91 days'), ('R4-CP1', 'Reset', '{}', now() - interval '1 day');
insert into private.ocpp_log (cp_id, dir, kind, action, at) values ('R4-CP1', 'in', 'call', 'Heartbeat', now() - interval '8 days'), ('R4-CP1', 'in', 'call', 'Heartbeat', now());
insert into private.smartcar_links (key_hash, user_id, created_at, last_used_at) values ('k-old', 'sc-user-old', now() - interval '400 days', now() - interval '200 days'), ('k-new', 'sc-user-new', now() - interval '5 days', now()) on conflict do nothing;
insert into private.smartcar_cache (vehicle_id, user_id, payload, fetched_at) values
  ('veh-old-user', 'sc-user-old', '{"lat":5.6}', now()),            -- its only link is unused for 200 days: link and cache go
  ('veh-stale', 'sc-user-new', '{"lat":5.6}', now() - interval '31 days'),  -- stale reading: goes
  ('veh-fresh', 'sc-user-new', '{"lat":5.6}', now()),              -- kept
  ('veh-orphan', 'sc-user-none', '{"lat":5.6}', now()) on conflict do nothing;  -- no link at all: goes
insert into private.smartcar_states (state_hash, created_at) values ('st-old', now() - interval '2 days'), ('st-new', now()) on conflict do nothing;
insert into private.signup_events (user_hash, mailbox_hash, domain_hash, at) values ('u', 'm', 'd', now() - interval '3 days'), ('u', 'm', 'd', now());
insert into public.audit_log (action, detail, at) values ('invited', '{"email":"ama@example.org","role":"manager"}', now() - interval '400 days'),
  ('invited', '{"email":"kofi@example.org","role":"manager"}', now() - interval '10 days'), ('ancient', '{}', now() - interval '2600 days');
select 'before: tx=' || (select count(*) from private.ocpp_transactions where cp_id = 'R4-CP1') || ' cmd=' || (select count(*) from private.ocpp_commands where cp_id = 'R4-CP1')
  || ' cache=' || (select count(*) from private.smartcar_cache) || ' links=' || (select count(*) from private.smartcar_links);
-- ---------------------------------------------------------------- purge
select 'not callable by API roles: anon=' || has_function_privilege('anon', 'private.purge_expired(boolean)', 'execute') || ' authenticated=' || has_function_privilege('authenticated', 'private.purge_expired(boolean)', 'execute');
select 'purge (forced): ' || private.purge_expired(true)::text;
select 'second call within the hour (throttled): ' || coalesce(private.purge_expired(false)::text, 'skipped');
select 'tx after: ' || string_agg(id_tag || case when stop_at is null then '(open)' else '' end, ', ' order by start_at) from private.ocpp_transactions where cp_id = 'R4-CP1';
select 'commands left: ' || string_agg(action, ', ') from private.ocpp_commands where cp_id = 'R4-CP1';
select 'log rows left: ' || count(*) from private.ocpp_log where cp_id = 'R4-CP1';
select 'smartcar cache left: ' || string_agg(vehicle_id, ', ' order by vehicle_id) from private.smartcar_cache;
select 'smartcar links left: ' || string_agg(key_hash, ', ') from private.smartcar_links;
select 'states left: ' || string_agg(state_hash, ', ') from private.smartcar_states where state_hash like 'st-%';
select 'signup events older than 48 h: ' || count(*) from private.signup_events where at < now() - interval '48 hours';
select 'audit: old email kept=' || exists (select 1 from public.audit_log where detail ->> 'email' = 'ama@example.org') || ' recent email kept=' || exists (select 1 from public.audit_log where detail ->> 'email' = 'kofi@example.org')
  || ' old event kept=' || exists (select 1 from public.audit_log where action = 'invited' and at < now() - interval '300 days') || ' 7-year-old entry kept=' || exists (select 1 from public.audit_log where action = 'ancient');
-- ---------------------------------------------------------------- trigger: an audit insert can run the purge, and never fails because of it
update private.maintenance set last_run = now() - interval '2 hours' where job = 'purge_expired';
insert into private.smartcar_states (state_hash, created_at) values ('st-old2', now() - interval '2 days');
insert into public.audit_log (action, detail) values ('r4 trigger test', '{}');
select 'audit insert ran the purge: old state gone=' || (not exists (select 1 from private.smartcar_states where state_hash = 'st-old2')) || ', last run fresh=' || ((select last_run from private.maintenance where job = 'purge_expired') > now() - interval '1 minute');
-- a purge error never blocks the insert
alter table private.maintenance rename to maintenance_x;
insert into public.audit_log (action, detail) values ('r4 trigger with broken purge', '{}');
select 'insert survives a failing purge: ' || exists (select 1 from public.audit_log where action = 'r4 trigger with broken purge');
alter table private.maintenance_x rename to maintenance;
-- ---------------------------------------------------------------- invitations and trusted factors
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ('00000000-0000-0000-0000-500000000001', 'owner@r4.example', now(), '{"account_type":"fleet","org_name":"R4 Fleet"}');
select pg_temp.as_user('00000000-0000-0000-0000-500000000001', 'aal1'); set role authenticated; select 'owner signup: ' || (public.complete_signup()->>'status'); reset role;
insert into public.org_invites (org_id, email, role, created_at, expires_at, declined_at) select org_id, 'declined@r4.example', 'manager', now() - interval '40 days', now() - interval '33 days', now() - interval '35 days' from public.profiles where id = '00000000-0000-0000-0000-500000000001';
insert into public.org_invites (org_id, email, role, created_at, expires_at) select org_id, 'fresh@r4.example', 'manager', now(), now() + interval '7 days' from public.profiles where id = '00000000-0000-0000-0000-500000000001';
insert into auth.mfa_factors (id, user_id, status) values ('00000000-0000-0000-0000-5000000000f1', '00000000-0000-0000-0000-500000000001', 'verified');
insert into public.mfa_trusted_factors (factor_id, user_id, how) values ('00000000-0000-0000-0000-5000000000f1', '00000000-0000-0000-0000-500000000001', 'email'), ('00000000-0000-0000-0000-5000000000f9', '00000000-0000-0000-0000-500000000001', 'email');
select 'purge: ' || private.purge_expired(true)::text;
select 'invites left: ' || string_agg(email, ', ') from public.org_invites where email like '%@r4.example';
select 'trusted factors left: ' || string_agg(right(factor_id::text, 2), ', ') from public.mfa_trusted_factors where user_id = '00000000-0000-0000-0000-500000000001';
-- ---------------------------------------------------------------- erasure: delete_my_account removes the address from invitations and the audit log
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-500000000002', 'Leaver@R4.example', now());
select pg_temp.as_user('00000000-0000-0000-0000-500000000001', 'aal2'); set role authenticated;
select 'invite leaver: ' || jsonb_array_length(public.invite_member('leaver@r4.example')->'invites'); reset role;
select pg_temp.as_user('00000000-0000-0000-0000-500000000002', 'aal1'); set role authenticated;
select 'leaver signup: ' || (public.complete_signup()->>'status');
select 'leaver accepts: ' || coalesce(public.accept_invite((public.my_invitations()->0->>'id')::uuid)->'org'->>'name', 'no');
reset role;
select 'before erasure: address in invites=' || exists (select 1 from public.org_invites where lower(email) = 'leaver@r4.example') || ' in audit=' || (select count(*) from public.audit_log where lower(detail ->> 'email') = 'leaver@r4.example');
insert into auth.mfa_factors (id, user_id, status) values ('00000000-0000-0000-0000-5000000000f2', '00000000-0000-0000-0000-500000000002', 'verified');
insert into public.mfa_trusted_factors (factor_id, user_id, how) values ('00000000-0000-0000-0000-5000000000f2', '00000000-0000-0000-0000-500000000002', 'email');
select pg_temp.as_user('00000000-0000-0000-0000-500000000002', 'aal2'); set role authenticated;
select 'leaver deletes account: ' || public.delete_my_account()::text; reset role;
select 'after erasure: address in invites=' || exists (select 1 from public.org_invites where lower(email) = 'leaver@r4.example') || ' in audit=' || (select count(*) from public.audit_log where lower(detail ->> 'email') = 'leaver@r4.example')
  || ' events kept=' || (select count(*) from public.audit_log where action in ('invited', 'joined by invite') and org_id = (select org_id from public.profiles where id = '00000000-0000-0000-0000-500000000001'))
  || ' login gone=' || (not exists (select 1 from auth.users where id = '00000000-0000-0000-0000-500000000002'));
select 'other people''s addresses untouched: ' || exists (select 1 from public.audit_log where detail ->> 'email' = 'kofi@example.org');
select 'grants: anon delete_my_account=' || has_function_privilege('anon', 'public.delete_my_account()', 'execute') || ' authenticated=' || has_function_privilege('authenticated', 'public.delete_my_account()', 'execute');
