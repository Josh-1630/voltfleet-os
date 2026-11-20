\set ON_ERROR_STOP 0
\pset format unaligned
\pset tuples_only on
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('00000000-0000-0000-0000-0000000000a1','owner@fleet.example', now(), '{"full_name":"Owner","account_type":"fleet","org_name":"Owner Fleet"}'),
 ('00000000-0000-0000-0000-0000000000b2','victim@rival.example', now(), '{"full_name":"Victim","account_type":"fleet","org_name":"Rival Fleet"}'),
 ('00000000-0000-0000-0000-0000000000c3','colleague@fleet.example', now(), '{"full_name":"Colleague","account_type":"driver"}');
create or replace function pg_temp.as_user(uid text, aal text) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', uid, 'aal', aal, 'role', 'authenticated')::text, false) $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1','aal2'); set role authenticated;
select 'owner signup: ' || (public.complete_signup()->>'status');
select 'invite victim: ' || jsonb_array_length(public.invite_member('victim@rival.example')->'invites');
select 'invite colleague: ' || jsonb_array_length(public.invite_member('colleague@fleet.example')->'invites');
reset role; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2','aal1'); set role authenticated;
select 'victim signup status (no auto-join): ' || (public.complete_signup()->>'status') || ' org=' || coalesce(public.my_account()->'org'->>'name','none');
select 'victim sees invites: ' || (public.my_invitations()->0->>'org_name');
select 'victim declines -> own org: ' || (public.decline_invite((public.my_invitations()->0->>'id')::uuid)->'org'->>'name');
reset role; select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3','aal1'); set role authenticated;
select 'colleague status: ' || (public.complete_signup()->>'status');
select 'colleague accepts: ' || (public.accept_invite((public.my_invitations()->0->>'id')::uuid)->'org'->>'name') || ' role=' || (public.my_account()->>'role');
select 'accept again: ' || (public.accept_invite('00000000-0000-0000-0000-000000000000'::uuid)::text);
reset role; select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3','aal2'); set role authenticated;
select 'colleague (admin, not owner) removes owner: ' || public.remove_member('00000000-0000-0000-0000-0000000000a1')::text;
select 'colleague leaves: ' || coalesce(public.leave_organization()->>'role','?');
reset role;
-- expired invite
update public.org_invites set expires_at = now() - interval '1 minute', accepted_at = null where email = 'colleague@fleet.example';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3','aal1'); set role authenticated;
select 'expired invite offered? ' || jsonb_array_length(public.my_invitations());
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1','aal2'); set role authenticated;
select 'owner flag: ' || (public.my_account()->>'owner') || ' invites listed: ' || (public.my_account()->'invites')::text;
select 'owner leaves: ' || public.leave_organization()::text;
reset role;
select 'grants: anon accept=' || has_function_privilege('anon','public.accept_invite(uuid)','execute') || ' auth org_owner=' || has_function_privilege('authenticated','public.org_owner(uuid)','execute');
