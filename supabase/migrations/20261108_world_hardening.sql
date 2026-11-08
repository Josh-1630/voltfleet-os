-- Harden the shared demo world (security review, Nov 2026).
-- The demo world is intentionally writable without sign-in, so these functions must limit the blast radius:
--  * only the one known world id ('demo') can be written: no unbounded new rows (storage abuse)
--  * snapshots must be the app's own format ('gz:' or 'j:' prefix) and at most 1.5 MB
--  * world_push is throttled to about 10 writes a second (flooding)
--  * direct table writes are revoked; reads stay public for the demo
create or replace function public.world_push(p_id text, p_state text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare new_rev bigint;
begin
  if p_id is distinct from 'demo' then raise exception 'unknown world'; end if;
  if p_state is null or char_length(p_state) > 1500000 or p_state !~ '^(gz:|j:)' then raise exception 'state missing, too large or malformed'; end if;
  perform 1 from public.worlds where id = p_id and updated_at > now() - interval '100 milliseconds';
  if found then raise exception 'too many writes, slow down' using errcode = '54000'; end if;
  update public.worlds set rev = rev + 1, state_gz = p_state, updated_at = now() where id = p_id returning rev into new_rev;
  if not found then insert into public.worlds (id, rev, state_gz) values (p_id, 1, p_state) returning rev into new_rev; end if;
  return jsonb_build_object('ok', true, 'rev', new_rev);
end; $$;

create or replace function public.world_tick(p_id text, p_client text, p_expected bigint, p_state text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare w public.worlds%rowtype;
begin
  if p_id is distinct from 'demo' then raise exception 'unknown world'; end if;
  if p_state is null or char_length(p_state) > 1500000 or p_state !~ '^(gz:|j:)' then raise exception 'state missing, too large or malformed'; end if;
  if p_client is null or p_client !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'bad client id'; end if;
  select * into w from public.worlds where id = p_id for update;
  if not found then
    insert into public.worlds (id, rev, state_gz, leader_id, leader_at) values (p_id, 1, p_state, p_client, now());
    return jsonb_build_object('ok', true, 'rev', 1, 'leader', true);
  end if;
  if w.leader_id is distinct from p_client and w.leader_at > now() - interval '6 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'not_leader', 'rev', w.rev, 'leader', false);
  end if;
  if w.rev <> p_expected then
    update public.worlds set leader_id = p_client, leader_at = now() where id = p_id;
    return jsonb_build_object('ok', false, 'reason', 'stale', 'rev', w.rev, 'leader', true);
  end if;
  update public.worlds set rev = w.rev + 1, state_gz = p_state, leader_id = p_client, leader_at = now(), updated_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'rev', w.rev + 1, 'leader', true);
end; $$;

revoke insert, update, delete, truncate on public.worlds from anon, authenticated;
