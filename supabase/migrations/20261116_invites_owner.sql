-- QA round 2 (findings R1-04, R1-06): invitations need the invitee's consent and expire; organisations have an owner.
--  * complete_signup no longer joins an organisation on its own. If open invitations exist for the confirmed
--    email, it returns status 'invited' with the inviting organisations, and the person accepts or declines one
--    (accept_invite / decline_invite). Declining continues with the account type chosen at sign-up.
--  * Invitations expire after 7 days (re-inviting renews them) and can be declined.
--  * The person who created an organisation is its owner (organizations.created_by). The owner can't be removed;
--    only the owner removes people (if the owner deleted their account, the longest-standing member takes over).
--  * leave_organization lets a member who isn't the owner leave a workspace.
-- Safe to re-run (add column if not exists, create or replace). Requires 20261109_mfa.sql.

alter table public.org_invites add column if not exists expires_at timestamptz not null default (now() + interval '7 days');
alter table public.org_invites add column if not exists declined_at timestamptz;
create index if not exists org_invites_email_idx on public.org_invites (lower(email));
create index if not exists org_invites_invited_by_idx on public.org_invites (invited_by);
create index if not exists organizations_created_by_idx on public.organizations (created_by);

-- Open invitations for the signed-in person's confirmed email (name of the organisation, role, expiry).
create or replace function public.my_invitations() returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'org_name', o.name, 'org_kind', o.kind, 'role', i.role, 'invited_at', i.created_at, 'expires_at', i.expires_at) order by i.created_at), '[]'::jsonb)
  from public.org_invites i join public.organizations o on o.id = i.org_id join auth.users u on u.id = auth.uid()
  where u.email_confirmed_at is not null and u.email is not null and lower(i.email) = lower(u.email)
    and i.accepted_at is null and i.declined_at is null and i.expires_at > now()
$$;

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
    'owner', o.id is not null and o.created_by = auth.uid(),
    'members', case when o.id is null or not ok then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'full_name', m.full_name, 'role', m.role, 'you', m.id = auth.uid(), 'owner', m.id = o.created_by) order by m.created_at), '[]'::jsonb) from public.profiles m where m.org_id = o.id) end,
    'invites', case when o.id is null or not ok or p.role not in ('manager', 'operator', 'developer', 'admin') then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role, 'created_at', i.created_at, 'expires_at', i.expires_at, 'expired', i.expires_at <= now(), 'declined', i.declined_at is not null) order by i.created_at), '[]'::jsonb) from public.org_invites i where i.org_id = o.id and i.accepted_at is null) end
  );
end; $$;

create or replace function public.complete_signup() returns jsonb language plpgsql security definer set search_path to '' as $$
declare p public.profiles; u record; invs jsonb; meta jsonb;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select * into p from public.profiles where id = auth.uid();
  if p.id is null then insert into public.profiles (id) values (auth.uid()) returning * into p; end if;
  if p.org_id is not null then return public.my_account() || jsonb_build_object('status', 'ready'); end if;
  select email, email_confirmed_at, phone_confirmed_at, raw_user_meta_data into u from auth.users where id = auth.uid();
  if u.email_confirmed_at is null and u.phone_confirmed_at is null then return public.my_account() || jsonb_build_object('status', 'unconfirmed'); end if;
  -- Invitations are offered, never accepted on the person's behalf.
  invs := public.my_invitations();
  if jsonb_array_length(invs) > 0 then return public.my_account() || jsonb_build_object('status', 'invited', 'pending_invites', invs); end if;
  meta := coalesce(u.raw_user_meta_data, '{}'::jsonb);
  if meta->>'account_type' in ('fleet', 'operator', 'developer', 'driver') then
    begin
      return public.create_organization(meta->>'account_type', coalesce(meta->>'org_name', '')) || jsonb_build_object('status', 'ready');
    exception when others then return public.my_account() || jsonb_build_object('status', 'needs_onboarding', 'error', sqlerrm);
    end;
  end if;
  return public.my_account() || jsonb_build_object('status', 'needs_onboarding');
end; $$;

create or replace function public.accept_invite(p_id uuid) returns jsonb language plpgsql security definer set search_path to '' as $$
declare p public.profiles; u record; inv public.org_invites;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select * into p from public.profiles where id = auth.uid() for update;
  if p.org_id is not null then raise exception 'You already belong to an organisation. Leave it first.'; end if;
  select email, email_confirmed_at into u from auth.users where id = auth.uid();
  if u.email_confirmed_at is null or u.email is null then raise exception 'Confirm your email address first.'; end if;
  select * into inv from public.org_invites where id = p_id and lower(email) = lower(u.email) for update;
  if inv.id is null or inv.accepted_at is not null or inv.declined_at is not null then raise exception 'This invitation is no longer open.'; end if;
  if inv.expires_at <= now() then raise exception 'This invitation has expired. Ask for a new one.'; end if;
  update public.profiles set org_id = inv.org_id, role = inv.role, updated_at = now() where id = auth.uid();
  update public.org_invites set accepted_at = now() where id = inv.id;
  perform public.audit('joined by invite', jsonb_build_object('email', u.email, 'role', inv.role));
  return public.my_account() || jsonb_build_object('status', 'ready');
end; $$;

create or replace function public.decline_invite(p_id uuid) returns jsonb language plpgsql security definer set search_path to '' as $$
declare u record; inv public.org_invites;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select email, email_confirmed_at into u from auth.users where id = auth.uid();
  update public.org_invites set declined_at = now() where id = p_id and u.email is not null and lower(email) = lower(u.email) and accepted_at is null and declined_at is null returning * into inv;
  if inv.id is not null then insert into public.audit_log (org_id, actor, action, detail) values (inv.org_id, auth.uid(), 'invite declined', jsonb_build_object('email', u.email)); end if;
  return public.complete_signup();
end; $$;

create or replace function public.invite_member(p_email text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare p public.profiles; v_email text := lower(btrim(coalesce(p_email, '')));
begin
  perform public.require_mfa();
  select * into p from public.profiles where id = auth.uid();
  if p.org_id is null or p.role not in ('manager', 'operator', 'developer') then raise exception 'Only organisation admins can invite people.'; end if;
  if v_email !~ '^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,24}$' then raise exception 'Enter a valid email address.'; end if;
  if exists (select 1 from public.profiles m join auth.users a on a.id = m.id where m.org_id = p.org_id and lower(a.email) = v_email) then raise exception 'That person is already in your team.'; end if;
  if (select count(*) from public.org_invites where org_id = p.org_id and accepted_at is null and declined_at is null and expires_at > now()) >= 50 then raise exception 'Too many open invitations. Revoke some first.'; end if;
  if (select count(*) from public.audit_log where org_id = p.org_id and action = 'invited' and at > now() - interval '1 hour') >= 20 then raise exception 'Too many invitations this hour.'; end if;
  insert into public.org_invites (org_id, email, role, invited_by, expires_at) values (p.org_id, v_email, p.role, auth.uid(), now() + interval '7 days')
  on conflict (org_id, email) do update set created_at = now(), invited_by = excluded.invited_by, role = excluded.role, accepted_at = null, declined_at = null, expires_at = now() + interval '7 days';
  perform public.audit('invited', jsonb_build_object('email', v_email, 'role', p.role));
  return public.my_account();
end; $$;

-- The owner: the creator, or (if they deleted their account) the longest-standing member, who takes over.
create or replace function public.org_owner(p_org uuid) returns uuid language plpgsql security definer set search_path to '' as $$
declare o uuid;
begin
  select created_by into o from public.organizations where id = p_org;
  if o is null or not exists (select 1 from public.profiles where id = o and org_id = p_org) then
    select id into o from public.profiles where org_id = p_org order by created_at limit 1;
    if o is not null then update public.organizations set created_by = o where id = p_org; end if;
  end if;
  return o;
end; $$;

create or replace function public.remove_member(p_user uuid) returns jsonb language plpgsql security definer set search_path to '' as $$
declare me public.profiles; them public.profiles; v_owner uuid;
begin
  perform public.require_mfa();
  select * into me from public.profiles where id = auth.uid();
  select * into them from public.profiles where id = p_user;
  if me.org_id is null or me.role not in ('manager', 'operator', 'developer') then raise exception 'Only organisation admins can remove people.'; end if;
  if them.id is null or them.org_id is distinct from me.org_id then raise exception 'That person is not in your team.'; end if;
  if them.id = me.id then raise exception 'Use “Leave organisation” or “Delete my account” to leave.'; end if;
  v_owner := public.org_owner(me.org_id);
  if them.id = v_owner then raise exception 'The organisation’s owner can’t be removed.'; end if;
  if me.id is distinct from v_owner then raise exception 'Only the organisation’s owner can remove people.'; end if;
  update public.profiles set org_id = null, role = 'pending', updated_at = now() where id = p_user;
  perform public.audit('member removed', jsonb_build_object('user', p_user));
  return public.my_account();
end; $$;

create or replace function public.leave_organization() returns jsonb language plpgsql security definer set search_path to '' as $$
declare me public.profiles;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  perform public.require_mfa();
  select * into me from public.profiles where id = auth.uid() for update;
  if me.org_id is null then raise exception 'You are not in an organisation.'; end if;
  if public.org_owner(me.org_id) = me.id then raise exception 'You own this organisation, so you can’t leave it. Delete your account instead, or ask support to transfer ownership.'; end if;
  perform public.audit('member left', '{}'::jsonb);
  update public.profiles set org_id = null, role = 'pending', updated_at = now() where id = auth.uid();
  return public.my_account();
end; $$;

create or replace function public.delete_my_account() returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_org uuid := public.my_org();
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  perform public.require_mfa();
  perform public.audit('account deleted', '{}'::jsonb);
  delete from auth.users where id = auth.uid();
  if v_org is not null then
    if not exists (select 1 from public.profiles where org_id = v_org) then delete from public.organizations where id = v_org;
    else perform public.org_owner(v_org); -- hand ownership to the longest-standing member
    end if;
  end if;
  return jsonb_build_object('ok', true);
end; $$;

revoke execute on function public.my_invitations(), public.accept_invite(uuid), public.decline_invite(uuid), public.leave_organization(), public.org_owner(uuid) from public, anon;
grant execute on function public.my_invitations(), public.accept_invite(uuid), public.decline_invite(uuid), public.leave_organization() to authenticated;
revoke execute on function public.org_owner(uuid) from authenticated;
grant execute on function public.my_account(), public.complete_signup(), public.invite_member(text), public.remove_member(uuid), public.delete_my_account() to authenticated;

notify pgrst, 'reload schema';
