-- Two-factor sign-in (TOTP) for staff accounts.
-- Staff roles (manager, operator, developer, admin) must have signed in with a second factor (JWT aal = 'aal2')
-- before they can read or change their organisation's workspace, team, audit log or platform data.
-- Drivers and accounts that haven't finished sign-up are not required to (drivers can opt in).

create or replace function public.mfa_ok() returns boolean language sql stable security definer set search_path to '' as $$
  select coalesce((select role in ('pending', 'driver') from public.profiles where id = auth.uid()), true)
      or coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;
grant execute on function public.mfa_ok() to authenticated;

-- Read policies: staff only see team data after the second factor.
drop policy if exists "Members read their organisation" on public.organizations;
create policy "Members read their organisation" on public.organizations for select to authenticated using (id = public.my_org() and public.mfa_ok());
drop policy if exists "Read own profile and teammates" on public.profiles;
create policy "Read own profile and teammates" on public.profiles for select to authenticated using (id = auth.uid() or (org_id is not null and org_id = public.my_org() and public.mfa_ok()));
drop policy if exists "Org admins read invites" on public.org_invites;
create policy "Org admins read invites" on public.org_invites for select to authenticated using (org_id = public.my_org() and public.is_org_admin() and public.mfa_ok());
drop policy if exists "Members read their workspace" on public.org_worlds;
create policy "Members read their workspace" on public.org_worlds for select to authenticated using (org_id = public.my_org() and public.mfa_ok());
drop policy if exists "Org admins read the audit log" on public.audit_log;
create policy "Org admins read the audit log" on public.audit_log for select to authenticated using (org_id = public.my_org() and public.is_org_admin() and public.mfa_ok());

create or replace function public.require_mfa() returns void language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.mfa_ok() then raise exception 'Two-factor sign-in required.' using errcode = '42501'; end if;
end; $$;
revoke execute on function public.require_mfa() from public, anon, authenticated;

-- my_account tells the app whether a second factor is still needed, and hides team data until it is.
create or replace function public.my_account() returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare p public.profiles; o public.organizations; u record; ok boolean := public.mfa_ok();
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select * into p from public.profiles where id = auth.uid();
  select email, phone, email_confirmed_at, phone_confirmed_at into u from auth.users where id = auth.uid();
  if p.org_id is not null then select * into o from public.organizations where id = p.org_id; end if;
  return jsonb_build_object(
    'id', auth.uid(), 'email', u.email, 'phone', u.phone, 'confirmed', (u.email_confirmed_at is not null or u.phone_confirmed_at is not null),
    'full_name', p.full_name, 'role', p.role,
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'), 'mfa_required', not ok,
    'org', case when o.id is null then null else jsonb_build_object('id', o.id, 'name', o.name, 'kind', o.kind) end,
    'members', case when o.id is null or not ok then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'full_name', m.full_name, 'role', m.role, 'you', m.id = auth.uid()) order by m.created_at), '[]'::jsonb) from public.profiles m where m.org_id = o.id) end,
    'invites', case when o.id is null or not ok or p.role not in ('manager', 'operator', 'developer', 'admin') then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role, 'created_at', i.created_at) order by i.created_at), '[]'::jsonb) from public.org_invites i where i.org_id = o.id and i.accepted_at is null) end
  );
end; $$;

-- Writes that need the second factor for staff
create or replace function public.org_world_tick(p_client text, p_expected bigint, p_state text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_org uuid := public.my_org(); w public.org_worlds;
begin
  if v_org is null or public.my_role() = 'pending' then raise exception 'No workspace for this account.' using errcode = '42501'; end if;
  perform public.require_mfa();
  if p_state is null or char_length(p_state) > 1500000 or p_state !~ '^(gz:|j:)' then raise exception 'state missing, too large or malformed'; end if;
  if p_client is null or p_client !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'bad client id'; end if;
  select * into w from public.org_worlds where org_id = v_org for update;
  if w.org_id is null then insert into public.org_worlds (org_id) values (v_org) returning * into w; end if;
  if w.leader_id is distinct from p_client and w.leader_at > now() - interval '6 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'not_leader', 'rev', w.rev, 'leader', false);
  end if;
  if w.rev <> p_expected then
    update public.org_worlds set leader_id = p_client, leader_at = now() where org_id = v_org;
    return jsonb_build_object('ok', false, 'reason', 'stale', 'rev', w.rev, 'leader', true);
  end if;
  update public.org_worlds set rev = w.rev + 1, state_gz = p_state, leader_id = p_client, leader_at = now(), updated_at = now() where org_id = v_org;
  return jsonb_build_object('ok', true, 'rev', w.rev + 1, 'leader', true);
end; $$;

create or replace function public.org_world_push(p_state text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_org uuid := public.my_org(); new_rev bigint;
begin
  if v_org is null or public.my_role() = 'pending' then raise exception 'No workspace for this account.' using errcode = '42501'; end if;
  perform public.require_mfa();
  if p_state is null or char_length(p_state) > 1500000 or p_state !~ '^(gz:|j:)' then raise exception 'state missing, too large or malformed'; end if;
  perform 1 from public.org_worlds where org_id = v_org and updated_at > now() - interval '100 milliseconds';
  if found then raise exception 'too many writes, slow down' using errcode = '54000'; end if;
  update public.org_worlds set rev = rev + 1, state_gz = p_state, updated_at = now() where org_id = v_org returning rev into new_rev;
  if not found then insert into public.org_worlds (org_id, rev, state_gz) values (v_org, 1, p_state) returning rev into new_rev; end if;
  return jsonb_build_object('ok', true, 'rev', new_rev);
end; $$;

create or replace function public.update_my_name(p_name text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v text := public.clean_text(p_name, 80);
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  perform public.require_mfa();
  if char_length(v) < 2 then raise exception 'Enter your full name.'; end if;
  update public.profiles set full_name = v, updated_at = now() where id = auth.uid();
  return public.my_account();
end; $$;

create or replace function public.invite_member(p_email text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare p public.profiles; v_email text := lower(btrim(coalesce(p_email, '')));
begin
  perform public.require_mfa();
  select * into p from public.profiles where id = auth.uid();
  if p.org_id is null or p.role not in ('manager', 'operator', 'developer') then raise exception 'Only organisation admins can invite people.'; end if;
  if v_email !~ '^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,24}$' then raise exception 'Enter a valid email address.'; end if;
  if exists (select 1 from public.profiles m join auth.users a on a.id = m.id where m.org_id = p.org_id and lower(a.email) = v_email) then raise exception 'That person is already in your team.'; end if;
  if (select count(*) from public.org_invites where org_id = p.org_id and accepted_at is null) >= 50 then raise exception 'Too many open invitations. Revoke some first.'; end if;
  if (select count(*) from public.audit_log where org_id = p.org_id and action = 'invited' and at > now() - interval '1 hour') >= 20 then raise exception 'Too many invitations this hour.'; end if;
  insert into public.org_invites (org_id, email, role, invited_by) values (p.org_id, v_email, p.role, auth.uid())
  on conflict (org_id, email) do update set created_at = now(), invited_by = excluded.invited_by, accepted_at = null;
  perform public.audit('invited', jsonb_build_object('email', v_email, 'role', p.role));
  return public.my_account();
end; $$;

create or replace function public.revoke_invite(p_id uuid) returns jsonb language plpgsql security definer set search_path to '' as $$
begin
  perform public.require_mfa();
  if not public.is_org_admin() then raise exception 'Only organisation admins can do this.'; end if;
  delete from public.org_invites where id = p_id and org_id = public.my_org() and accepted_at is null;
  perform public.audit('invite revoked', jsonb_build_object('invite', p_id));
  return public.my_account();
end; $$;

create or replace function public.remove_member(p_user uuid) returns jsonb language plpgsql security definer set search_path to '' as $$
declare me public.profiles; them public.profiles;
begin
  perform public.require_mfa();
  select * into me from public.profiles where id = auth.uid();
  select * into them from public.profiles where id = p_user;
  if me.org_id is null or me.role not in ('manager', 'operator', 'developer') then raise exception 'Only organisation admins can remove people.'; end if;
  if them.id is null or them.org_id is distinct from me.org_id then raise exception 'That person is not in your team.'; end if;
  if them.id = me.id then raise exception 'Use “Delete my account” to leave.'; end if;
  update public.profiles set org_id = null, role = 'pending', updated_at = now() where id = p_user;
  perform public.audit('member removed', jsonb_build_object('user', p_user));
  return public.my_account();
end; $$;

create or replace function public.delete_my_account() returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_org uuid := public.my_org();
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  perform public.require_mfa();
  perform public.audit('account deleted', '{}'::jsonb);
  delete from auth.users where id = auth.uid();
  if v_org is not null and not exists (select 1 from public.profiles where org_id = v_org) then delete from public.organizations where id = v_org; end if;
  return jsonb_build_object('ok', true);
end; $$;

create or replace function public.admin_overview() returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  if public.my_role() is distinct from 'admin' then raise exception 'Platform admins only.' using errcode = '42501'; end if;
  perform public.require_mfa();
  return jsonb_build_object(
    'accounts', (select count(*) from public.profiles),
    'pending', (select count(*) from public.profiles where role = 'pending'),
    'organisations', (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) from (select kind, count(*) n from public.organizations group by kind) x),
    'signups_7d', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'staff_with_2fa', (select count(distinct f.user_id) from auth.mfa_factors f join public.profiles p on p.id = f.user_id where f.status = 'verified' and p.role in ('manager', 'operator', 'developer', 'admin')));
end; $$;

-- Platform support: reset a staff member's authenticator after verifying who they are (run by the platform owner).
--   delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'person@company.com');
