\set ON_ERROR_STOP 0
\pset format unaligned
\pset tuples_only on
create or replace function pg_temp.as_user(uid text, aal text, amr text default '[{"method":"password","timestamp":1}]') returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', uid, 'aal', aal, 'role', 'authenticated', 'amr', amr::json)::text, false) $$;
create or replace function pg_temp.amr(m text, ago interval) returns text language sql as $$ select json_build_array(json_build_object('method', m, 'timestamp', extract(epoch from now() - ago)::bigint))::text $$;
-- ---------------------------------------------------------------- R1-08 sign-up limits
insert into auth.users (id, email, email_confirmed_at) select ('00000000-0000-0000-0000-1' || lpad(i::text, 11, '0'))::uuid, 'ama+' || i || '@gmail.com', now() from generate_series(1, 5) i;
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-200000000001', 'a.m.a@googlemail.com', now()), ('00000000-0000-0000-0000-200000000002', 'kofi@gmail.com', now());
do $$ declare i int; r text; begin
  for i in 1..5 loop
    perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-1' || lpad(i::text, 11, '0'), 'aal', 'aal1', 'role', 'authenticated')::text, false);
    begin r := public.create_organization('driver', 'Ama ' || i)->'org'->>'name'; raise notice 'plus-address % -> %', i, r; exception when others then raise notice 'plus-address % -> REFUSED: %', i, sqlerrm; end;
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-200000000001', 'aal', 'aal1', 'role', 'authenticated')::text, false);
  begin r := public.create_organization('driver', 'Dots')->'org'->>'name'; raise notice 'gmail dot variant -> %', r; exception when others then raise notice 'gmail dot variant -> REFUSED: %', sqlerrm; end;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-200000000002', 'aal', 'aal1', 'role', 'authenticated')::text, false);
  begin r := public.create_organization('driver', 'Kofi')->'org'->>'name'; raise notice 'other gmail user -> %', r; exception when others then raise notice 'other gmail user -> REFUSED: %', sqlerrm; end;
end $$;
-- company domain: 30/h
insert into auth.users (id, email, email_confirmed_at) select gen_random_uuid(), 'u' || i || '@catchall.example', now() from generate_series(1, 32) i;
do $$ declare r record; ok int := 0; bad int := 0; last text; begin
  for r in select id from auth.users where email like '%@catchall.example' order by email loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.id, 'aal', 'aal1', 'role', 'authenticated')::text, false);
    begin perform public.create_organization('fleet', 'Catch ' || r.id); ok := ok + 1; exception when others then bad := bad + 1; last := sqlerrm; end;
  end loop;
  raise notice 'catch-all domain: % created, % refused (%)', ok, bad, last;
end $$;
-- per-account: create, leave (not owner?) -> use a direct reset to simulate leave loops
do $$ declare i int; uid uuid := '00000000-0000-0000-0000-200000000002'; begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'aal', 'aal1', 'role', 'authenticated')::text, false);
  for i in 1..3 loop
    update public.profiles set org_id = null, role = 'pending' where id = uid;
    delete from private.signup_events where mailbox_hash = private.h('kofi@gmail.com') and user_hash <> private.h(uid::text);
    begin perform public.create_organization('driver', 'Again'); raise notice 'same account, org % -> ok', i + 1; exception when others then raise notice 'same account, org % -> REFUSED: %', i + 1, sqlerrm; end;
  end loop;
end $$;
select 'signup events stored: ' || count(*) || ', any plain address stored: ' || bool_or(mailbox_hash like '%@%') from private.signup_events;
select 'normalise: ' || private.mailbox_of('A.M.A+x@GoogleMail.com') || ' ' || private.mailbox_of('Kofi+test@Company.example');
reset role;
-- ---------------------------------------------------------------- R1-17 trusted authenticators
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ('00000000-0000-0000-0000-300000000001', 'boss@trust.example', now(), '{"account_type":"fleet","org_name":"Trust Fleet"}');
select pg_temp.as_user('00000000-0000-0000-0000-300000000001', 'aal1'); set role authenticated;
select 'staff signup: ' || (public.complete_signup()->>'status');
reset role;
insert into auth.mfa_factors (id, user_id, status) values ('00000000-0000-0000-0000-3000000000f1', '00000000-0000-0000-0000-300000000001', 'verified');
select pg_temp.as_user('00000000-0000-0000-0000-300000000001', 'aal2'); set role authenticated;
select 'password-only enrolment, aal2: mfa_ok=' || public.mfa_ok() || ' my_account.mfa_required=' || (public.my_account()->>'mfa_required') || ' trust=' || (public.my_account()->'mfa_trust')::text;
select 'workspace readable: ' || count(*) from public.org_worlds;
select 'invite blocked: ' || public.invite_member('x@trust.example')::text;
select 'trust without email proof: ' || public.trust_my_factor('00000000-0000-0000-0000-3000000000f1')::text;
reset role; select pg_temp.as_user('00000000-0000-0000-0000-300000000001', 'aal2', pg_temp.amr('magiclink', '2 hours')); set role authenticated;
select 'trust with stale email proof (2 h): ' || public.trust_my_factor('00000000-0000-0000-0000-3000000000f1')::text;
reset role; select pg_temp.as_user('00000000-0000-0000-0000-300000000001', 'aal1', pg_temp.amr('magiclink', '1 minute')); set role authenticated;
select 'trust at aal1: ' || public.trust_my_factor(null)::text;
reset role; select pg_temp.as_user('00000000-0000-0000-0000-300000000001', 'aal2', pg_temp.amr('magiclink', '1 minute')); set role authenticated;
select 'trust with fresh email link, aal2: mfa_required=' || (public.trust_my_factor('00000000-0000-0000-0000-3000000000f1')->>'mfa_required');
reset role; select pg_temp.as_user('00000000-0000-0000-0000-300000000001', 'aal2'); set role authenticated;
select 'later password+code session: mfa_ok=' || public.mfa_ok() || ' workspace rows=' || (select count(*) from public.org_worlds);
reset role; insert into auth.mfa_factors (id, user_id, status) values ('00000000-0000-0000-0000-3000000000f2', '00000000-0000-0000-0000-300000000001', 'verified');
select pg_temp.as_user('00000000-0000-0000-0000-300000000001', 'aal2'); set role authenticated;
select 'backup device just verified: mfa_ok=' || public.mfa_ok();
select 'trust backup (already has a trusted device): mfa_required=' || (public.trust_my_factor('00000000-0000-0000-0000-3000000000f2')->>'mfa_required');
select 'after trusting backup: mfa_ok=' || public.mfa_ok();
select 'someone else''s factor: ' || public.trust_my_factor('00000000-0000-0000-0000-3000000000f9')::text;
reset role;
select 'audit: ' || string_agg(action || ' ' || (detail->>'how'), ', ') from public.audit_log where action like 'two-factor%';
select 'driver unaffected: ' || (select public.mfa_ok() from (select pg_temp.as_user('00000000-0000-0000-0000-100000000001', 'aal1')) x);
-- ---------------------------------------------------------------- R2-07 audit events
select pg_temp.as_user('00000000-0000-0000-0000-300000000001', 'aal2'); set role authenticated;
select 'record_event ok: ' || coalesce(public.record_event('reveal-pii', 'drv-x (name, email, phone)', 'Support ticket')::text, 'void');
select 'record_event unknown: ' || coalesce(public.record_event('drop table', null, null)::text, 'void');
delete from public.audit_log;
update public.audit_log set action = 'x';
insert into public.audit_log (action) values ('forged');
reset role;
select 'events in log: ' || count(*) || ' latest: ' || max(action) from public.audit_log where action like 'app: %';
select pg_temp.as_user('00000000-0000-0000-0000-300000000001', 'aal1'); set role authenticated;
select 'record_event at aal1 (staff): ' || coalesce(public.record_event('export', 't', null)::text, 'void');
reset role;
select 'anon can record: ' || has_function_privilege('anon', 'public.record_event(text,text,text)', 'execute');
-- ---------------------------------------------------------------- R1-09 heads
select 'demo head before: ' || coalesce((select rev::text from public.world_heads where id = 'demo'), 'none');
set role anon;
select 'tick: ' || public.world_tick('demo', 'cA', coalesce((select rev from public.worlds where id = 'demo'), 0), 'gz:x')::text;
reset role;
select 'heads follow: worlds rev=' || (select rev from public.worlds where id = 'demo') || ' head rev=' || (select rev from public.world_heads where id = 'demo');
create temp table h0 as select updated_at from public.world_heads where id = 'demo';
select pg_sleep(0.05);
update public.worlds set leader_at = clock_timestamp() where id = 'demo';
select 'lease-only update leaves head alone: ' || ((select updated_at from public.world_heads where id = 'demo') = (select updated_at from h0))::text;
select 'org heads: ' || count(*) || ' (org_worlds: ' || (select count(*) from public.org_worlds) || ')' from public.org_world_heads;
select pg_temp.as_user('00000000-0000-0000-0000-300000000001', 'aal2'); set role authenticated;
select 'member reads own head: ' || count(*) from public.org_world_heads;
reset role; select pg_temp.as_user('00000000-0000-0000-0000-200000000002', 'aal1'); set role authenticated;
select 'driver reads other heads: ' || count(*) from public.org_world_heads;
reset role; set role anon;
select 'anon reads org heads: ' || count(*) from public.org_world_heads;
select 'anon reads demo head: ' || count(*) from public.world_heads;
reset role;
select 'publication: ' || string_agg(tablename, ',' order by tablename) from pg_publication_tables where pubname = 'supabase_realtime';
