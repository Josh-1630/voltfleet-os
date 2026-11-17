-- QA round 2 (findings R1-02, R1-03, R1-07): consistent sync for the shared demo world and organisation workspaces.
--  * *_push takes the revision the device's change was based on (p_expected) and refuses to overwrite a newer
--    world: it returns {ok:false, reason:'stale', rev} and the app re-applies its change on the newer world.
--    p_expected stays optional for a transition period so app versions cached before this change keep working.
--  * *_tick requires p_expected (a NULL used to skip the check), no longer hands the lease to a device whose
--    revision is wrong (that let one stuck device freeze the world for everyone), and is limited to about one
--    write a second per lease holder.
--  * The demo snapshot is capped at 750 kB (it is ~140 kB in steady state); workspaces keep the 1.5 MB cap.
-- Safe to re-run: functions are dropped/replaced, grants re-applied. The client in js/cloud.js works with both
-- the old and the new functions (it detects whether p_expected is accepted).

drop function if exists public.world_push(text, text);
create or replace function public.world_push(p_id text, p_state text, p_expected bigint default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare w public.worlds%rowtype;
begin
  if p_id is distinct from 'demo' then raise exception 'unknown world'; end if;
  if p_state is null or char_length(p_state) > 750000 or p_state !~ '^(gz:|j:)' then raise exception 'state missing, too large or malformed'; end if;
  select * into w from public.worlds where id = p_id for update;
  if not found then
    if coalesce(p_expected, 0) <> 0 then return jsonb_build_object('ok', false, 'reason', 'stale', 'rev', 0); end if;
    insert into public.worlds (id, rev, state_gz) values (p_id, 1, p_state);
    return jsonb_build_object('ok', true, 'rev', 1);
  end if;
  if w.updated_at > now() - interval '100 milliseconds' then raise exception 'too many writes, slow down' using errcode = '54000'; end if;
  if p_expected is not null and w.rev <> p_expected then return jsonb_build_object('ok', false, 'reason', 'stale', 'rev', w.rev); end if;
  update public.worlds set rev = w.rev + 1, state_gz = p_state, updated_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'rev', w.rev + 1);
end; $$;

create or replace function public.world_tick(p_id text, p_client text, p_expected bigint, p_state text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare w public.worlds%rowtype; holds boolean;
begin
  if p_id is distinct from 'demo' then raise exception 'unknown world'; end if;
  if p_state is null or char_length(p_state) > 750000 or p_state !~ '^(gz:|j:)' then raise exception 'state missing, too large or malformed'; end if;
  if p_client is null or p_client !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'bad client id'; end if;
  if p_expected is null then raise exception 'expected revision required'; end if;
  select * into w from public.worlds where id = p_id for update;
  if not found then
    if p_expected <> 0 then return jsonb_build_object('ok', false, 'reason', 'stale', 'rev', 0, 'leader', false); end if;
    insert into public.worlds (id, rev, state_gz, leader_id, leader_at) values (p_id, 1, p_state, p_client, now());
    return jsonb_build_object('ok', true, 'rev', 1, 'leader', true);
  end if;
  holds := coalesce(w.leader_id = p_client and w.leader_at > now() - interval '6 seconds', false);
  if not holds and w.leader_id is not null and w.leader_at > now() - interval '6 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'not_leader', 'rev', w.rev, 'leader', false);
  end if;
  -- Wrong revision: tell the device, but don't renew or grant the lease (no write at all).
  if w.rev <> p_expected then return jsonb_build_object('ok', false, 'reason', 'stale', 'rev', w.rev, 'leader', holds); end if;
  if holds and w.leader_at > now() - interval '900 milliseconds' then return jsonb_build_object('ok', false, 'reason', 'too_fast', 'rev', w.rev, 'leader', true); end if;
  update public.worlds set rev = w.rev + 1, state_gz = p_state, leader_id = p_client, leader_at = now(), updated_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'rev', w.rev + 1, 'leader', true);
end; $$;

drop function if exists public.org_world_push(text);
create or replace function public.org_world_push(p_state text, p_expected bigint default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_org uuid := public.my_org(); w public.org_worlds;
begin
  if v_org is null or public.my_role() = 'pending' then raise exception 'No workspace for this account.' using errcode = '42501'; end if;
  perform public.require_mfa();
  if p_state is null or char_length(p_state) > 1500000 or p_state !~ '^(gz:|j:)' then raise exception 'state missing, too large or malformed'; end if;
  select * into w from public.org_worlds where org_id = v_org for update;
  if w.org_id is null then
    if coalesce(p_expected, 0) <> 0 then return jsonb_build_object('ok', false, 'reason', 'stale', 'rev', 0); end if;
    insert into public.org_worlds (org_id, rev, state_gz) values (v_org, 1, p_state);
    return jsonb_build_object('ok', true, 'rev', 1);
  end if;
  if w.updated_at > now() - interval '100 milliseconds' then raise exception 'too many writes, slow down' using errcode = '54000'; end if;
  if p_expected is not null and w.rev <> p_expected then return jsonb_build_object('ok', false, 'reason', 'stale', 'rev', w.rev); end if;
  update public.org_worlds set rev = w.rev + 1, state_gz = p_state, updated_at = now() where org_id = v_org;
  return jsonb_build_object('ok', true, 'rev', w.rev + 1);
end; $$;

create or replace function public.org_world_tick(p_client text, p_expected bigint, p_state text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_org uuid := public.my_org(); w public.org_worlds; holds boolean;
begin
  if v_org is null or public.my_role() = 'pending' then raise exception 'No workspace for this account.' using errcode = '42501'; end if;
  perform public.require_mfa();
  if p_state is null or char_length(p_state) > 1500000 or p_state !~ '^(gz:|j:)' then raise exception 'state missing, too large or malformed'; end if;
  if p_client is null or p_client !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'bad client id'; end if;
  if p_expected is null then raise exception 'expected revision required'; end if;
  select * into w from public.org_worlds where org_id = v_org for update;
  if w.org_id is null then insert into public.org_worlds (org_id) values (v_org) returning * into w; end if;
  holds := coalesce(w.leader_id = p_client and w.leader_at > now() - interval '6 seconds', false);
  if not holds and w.leader_id is not null and w.leader_at > now() - interval '6 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'not_leader', 'rev', w.rev, 'leader', false);
  end if;
  if w.rev <> p_expected then return jsonb_build_object('ok', false, 'reason', 'stale', 'rev', w.rev, 'leader', holds); end if;
  if holds and w.leader_at > now() - interval '900 milliseconds' then return jsonb_build_object('ok', false, 'reason', 'too_fast', 'rev', w.rev, 'leader', true); end if;
  update public.org_worlds set rev = w.rev + 1, state_gz = p_state, leader_id = p_client, leader_at = now(), updated_at = now() where org_id = v_org;
  return jsonb_build_object('ok', true, 'rev', w.rev + 1, 'leader', true);
end; $$;

-- Execute rights (dropped functions lose theirs; new functions are executable by PUBLIC by default).
revoke execute on function public.world_push(text, text, bigint), public.org_world_push(text, bigint) from public;
grant execute on function public.world_push(text, text, bigint), public.world_tick(text, text, bigint, text) to anon, authenticated;
revoke execute on function public.org_world_push(text, bigint), public.org_world_tick(text, bigint, text) from anon;
grant execute on function public.org_world_push(text, bigint), public.org_world_tick(text, bigint, text) to authenticated;

notify pgrst, 'reload schema';
