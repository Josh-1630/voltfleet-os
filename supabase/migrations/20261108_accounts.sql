-- VoltFleet OS: real accounts with Supabase Auth.
-- Every signed-in user belongs to at most one organisation (a fleet, a charge-point operator, a developer company,
-- or a personal "driver" account). Each organisation has its own private workspace (org_worlds), readable and
-- writable only by its members. Roles are set by the server, never by the browser:
--   fleet -> manager, operator -> operator, developer -> developer, driver -> driver, platform staff -> admin (set by SQL).
-- Writes go through SECURITY DEFINER functions that derive the organisation from auth.uid(); tables have RLS with
-- read-only policies and no direct write grants.

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 80),
  kind text not null check (kind in ('fleet', 'operator', 'developer', 'driver', 'platform')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '' check (char_length(full_name) <= 80),
  role text not null default 'pending' check (role in ('pending', 'manager', 'operator', 'driver', 'developer', 'admin')),
  org_id uuid references public.organizations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists profiles_org_idx on public.profiles(org_id);

create table if not exists public.org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (email ~* '^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,24}$'),
  role text not null check (role in ('manager', 'operator', 'developer')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (org_id, email)
);

create table if not exists public.org_worlds (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  rev bigint not null default 0,
  state_gz text,
  leader_id text,
  leader_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id bigserial primary key,
  org_id uuid references public.organizations(id) on delete cascade,
  actor uuid,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists audit_org_idx on public.audit_log(org_id, at desc);

-- ---------------------------------------------------------------- helpers (no recursion through RLS)
create or replace function public.my_org() returns uuid language sql stable security definer set search_path to '' as
$$ select org_id from public.profiles where id = auth.uid() $$;
create or replace function public.my_role() returns text language sql stable security definer set search_path to '' as
$$ select role from public.profiles where id = auth.uid() $$;
create or replace function public.is_org_admin() returns boolean language sql stable security definer set search_path to '' as
$$ select coalesce((select role in ('manager', 'operator', 'developer', 'admin') from public.profiles where id = auth.uid()), false) $$;

create or replace function public.audit(p_action text, p_detail jsonb default '{}'::jsonb) returns void language sql security definer set search_path to '' as
$$ insert into public.audit_log (org_id, actor, action, detail) values (public.my_org(), auth.uid(), p_action, coalesce(p_detail, '{}'::jsonb)) $$;

-- ---------------------------------------------------------------- RLS: read-only policies, no direct writes
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.org_invites enable row level security;
alter table public.org_worlds enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists "Members read their organisation" on public.organizations;
create policy "Members read their organisation" on public.organizations for select to authenticated using (id = public.my_org());
drop policy if exists "Read own profile and teammates" on public.profiles;
create policy "Read own profile and teammates" on public.profiles for select to authenticated using (id = auth.uid() or (org_id is not null and org_id = public.my_org()));
drop policy if exists "Org admins read invites" on public.org_invites;
create policy "Org admins read invites" on public.org_invites for select to authenticated using (org_id = public.my_org() and public.is_org_admin());
drop policy if exists "Members read their workspace" on public.org_worlds;
create policy "Members read their workspace" on public.org_worlds for select to authenticated using (org_id = public.my_org());
drop policy if exists "Org admins read the audit log" on public.audit_log;
create policy "Org admins read the audit log" on public.audit_log for select to authenticated using (org_id = public.my_org() and public.is_org_admin());

revoke all on public.organizations, public.profiles, public.org_invites, public.org_worlds, public.audit_log from anon, authenticated;
grant select on public.organizations, public.profiles, public.org_invites, public.org_worlds, public.audit_log to authenticated;
revoke all on sequence public.audit_log_id_seq from anon, authenticated;

-- ---------------------------------------------------------------- new users get a profile (no role, no org yet)
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  insert into public.profiles (id, full_name) values (new.id, left(regexp_replace(coalesce(new.raw_user_meta_data->>'full_name', ''), '[<>"`]', '', 'g'), 80))
  on conflict (id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- account functions (all check auth.uid())
create or replace function public.clean_text(p text, n int) returns text language sql immutable set search_path to '' as
$$ select left(btrim(regexp_replace(coalesce(p, ''), '[<>"`[:cntrl:]]', '', 'g')), n) $$;

create or replace function public.my_account() returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare p public.profiles; o public.organizations; u record;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select * into p from public.profiles where id = auth.uid();
  select email, phone, email_confirmed_at, phone_confirmed_at into u from auth.users where id = auth.uid();
  if p.org_id is not null then select * into o from public.organizations where id = p.org_id; end if;
  return jsonb_build_object(
    'id', auth.uid(), 'email', u.email, 'phone', u.phone, 'confirmed', (u.email_confirmed_at is not null or u.phone_confirmed_at is not null),
    'full_name', p.full_name, 'role', p.role,
    'org', case when o.id is null then null else jsonb_build_object('id', o.id, 'name', o.name, 'kind', o.kind) end,
    'members', case when o.id is null then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'full_name', m.full_name, 'role', m.role, 'you', m.id = auth.uid()) order by m.created_at), '[]'::jsonb) from public.profiles m where m.org_id = o.id) end,
    'invites', case when o.id is null or p.role not in ('manager', 'operator', 'developer', 'admin') then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role, 'created_at', i.created_at) order by i.created_at), '[]'::jsonb) from public.org_invites i where i.org_id = o.id and i.accepted_at is null) end
  );
end; $$;

create or replace function public.create_organization(p_kind text, p_name text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare p public.profiles; confirmed boolean; v_name text := public.clean_text(p_name, 80); v_role text; v_org uuid;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select * into p from public.profiles where id = auth.uid() for update;
  if p.id is null then raise exception 'no profile'; end if;
  if p.org_id is not null or p.role <> 'pending' then raise exception 'You already belong to an organisation.'; end if;
  select (email_confirmed_at is not null or phone_confirmed_at is not null) into confirmed from auth.users where id = auth.uid();
  if not confirmed then raise exception 'Confirm your email address first.'; end if;
  v_role := case p_kind when 'fleet' then 'manager' when 'operator' then 'operator' when 'developer' then 'developer' when 'driver' then 'driver' else null end;
  if v_role is null then raise exception 'Choose an account type.'; end if;
  if p_kind = 'driver' and char_length(v_name) < 2 then v_name := coalesce(nullif(public.clean_text(p.full_name, 80), ''), 'My account'); end if;
  if char_length(v_name) < 2 then raise exception 'Give your organisation a name.'; end if;
  if (select count(*) from public.organizations where created_at > now() - interval '1 hour') >= 100 then raise exception 'Too many sign-ups right now. Try again in a few minutes.'; end if;
  insert into public.organizations (name, kind, created_by) values (v_name, p_kind, auth.uid()) returning id into v_org;
  update public.profiles set org_id = v_org, role = v_role, updated_at = now() where id = auth.uid();
  insert into public.org_worlds (org_id) values (v_org);
  perform public.audit('organisation created', jsonb_build_object('kind', p_kind, 'name', v_name));
  return public.my_account();
end; $$;

-- After sign-in: join an organisation that invited this (confirmed) email, or create the one chosen at sign-up.
create or replace function public.complete_signup() returns jsonb language plpgsql security definer set search_path to '' as $$
declare p public.profiles; u record; inv public.org_invites; meta jsonb;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select * into p from public.profiles where id = auth.uid();
  if p.id is null then insert into public.profiles (id) values (auth.uid()) returning * into p; end if;
  if p.org_id is not null then return public.my_account() || jsonb_build_object('status', 'ready'); end if;
  select email, email_confirmed_at, phone_confirmed_at, raw_user_meta_data into u from auth.users where id = auth.uid();
  if u.email_confirmed_at is null and u.phone_confirmed_at is null then return public.my_account() || jsonb_build_object('status', 'unconfirmed'); end if;
  if u.email_confirmed_at is not null and u.email is not null then
    select * into inv from public.org_invites where lower(email) = lower(u.email) and accepted_at is null order by created_at limit 1 for update;
    if inv.id is not null then
      update public.profiles set org_id = inv.org_id, role = inv.role, updated_at = now() where id = auth.uid();
      update public.org_invites set accepted_at = now() where id = inv.id;
      perform public.audit('joined by invite', jsonb_build_object('email', u.email, 'role', inv.role));
      return public.my_account() || jsonb_build_object('status', 'ready');
    end if;
  end if;
  meta := coalesce(u.raw_user_meta_data, '{}'::jsonb);
  if meta->>'account_type' in ('fleet', 'operator', 'developer', 'driver') then
    begin
      return public.create_organization(meta->>'account_type', coalesce(meta->>'org_name', '')) || jsonb_build_object('status', 'ready');
    exception when others then return public.my_account() || jsonb_build_object('status', 'needs_onboarding', 'error', sqlerrm);
    end;
  end if;
  return public.my_account() || jsonb_build_object('status', 'needs_onboarding');
end; $$;

create or replace function public.update_my_name(p_name text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v text := public.clean_text(p_name, 80);
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if char_length(v) < 2 then raise exception 'Enter your full name.'; end if;
  update public.profiles set full_name = v, updated_at = now() where id = auth.uid();
  return public.my_account();
end; $$;

create or replace function public.invite_member(p_email text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare p public.profiles; v_email text := lower(btrim(coalesce(p_email, '')));
begin
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
  if not public.is_org_admin() then raise exception 'Only organisation admins can do this.'; end if;
  delete from public.org_invites where id = p_id and org_id = public.my_org() and accepted_at is null;
  perform public.audit('invite revoked', jsonb_build_object('invite', p_id));
  return public.my_account();
end; $$;

create or replace function public.remove_member(p_user uuid) returns jsonb language plpgsql security definer set search_path to '' as $$
declare me public.profiles; them public.profiles;
begin
  select * into me from public.profiles where id = auth.uid();
  select * into them from public.profiles where id = p_user;
  if me.org_id is null or me.role not in ('manager', 'operator', 'developer') then raise exception 'Only organisation admins can remove people.'; end if;
  if them.id is null or them.org_id is distinct from me.org_id then raise exception 'That person is not in your team.'; end if;
  if them.id = me.id then raise exception 'Use “Delete my account” to leave.'; end if;
  update public.profiles set org_id = null, role = 'pending', updated_at = now() where id = p_user;
  perform public.audit('member removed', jsonb_build_object('user', p_user));
  return public.my_account();
end; $$;

-- Right to erasure: deletes the login and profile; the organisation and its workspace go too if nobody is left.
create or replace function public.delete_my_account() returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_org uuid := public.my_org();
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  perform public.audit('account deleted', '{}'::jsonb);
  delete from auth.users where id = auth.uid();
  if v_org is not null and not exists (select 1 from public.profiles where org_id = v_org) then delete from public.organizations where id = v_org; end if;
  return jsonb_build_object('ok', true);
end; $$;

-- ---------------------------------------------------------------- private workspace sync (same protocol as the demo world)
create or replace function public.org_world_tick(p_client text, p_expected bigint, p_state text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_org uuid := public.my_org(); w public.org_worlds;
begin
  if v_org is null or public.my_role() = 'pending' then raise exception 'No workspace for this account.' using errcode = '42501'; end if;
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
  if p_state is null or char_length(p_state) > 1500000 or p_state !~ '^(gz:|j:)' then raise exception 'state missing, too large or malformed'; end if;
  perform 1 from public.org_worlds where org_id = v_org and updated_at > now() - interval '100 milliseconds';
  if found then raise exception 'too many writes, slow down' using errcode = '54000'; end if;
  update public.org_worlds set rev = rev + 1, state_gz = p_state, updated_at = now() where org_id = v_org returning rev into new_rev;
  if not found then insert into public.org_worlds (org_id, rev, state_gz) values (v_org, 1, p_state) returning rev into new_rev; end if;
  return jsonb_build_object('ok', true, 'rev', new_rev);
end; $$;

-- ---------------------------------------------------------------- platform staff
create or replace function public.admin_overview() returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  if public.my_role() is distinct from 'admin' then raise exception 'Platform admins only.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'accounts', (select count(*) from public.profiles),
    'pending', (select count(*) from public.profiles where role = 'pending'),
    'organisations', (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) from (select kind, count(*) n from public.organizations group by kind) x),
    'signups_7d', (select count(*) from public.profiles where created_at > now() - interval '7 days'));
end; $$;

-- ---------------------------------------------------------------- execute rights: signed-in users only
revoke execute on all functions in schema public from public, anon;
grant execute on function public.my_account(), public.create_organization(text, text), public.complete_signup(), public.update_my_name(text),
  public.invite_member(text), public.revoke_invite(uuid), public.remove_member(uuid), public.delete_my_account(),
  public.org_world_tick(text, bigint, text), public.org_world_push(text), public.admin_overview() to authenticated;
revoke execute on function public.audit(text, jsonb), public.handle_new_user(), public.clean_text(text, int) from authenticated;
grant execute on function public.my_org(), public.my_role(), public.is_org_admin() to authenticated;
-- The public demo world stays open to everyone (it holds sample data only).
grant execute on function public.world_tick(text, text, bigint, text), public.world_push(text, text) to anon, authenticated;

-- Live updates for members' workspaces (Realtime applies the RLS policy above).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'org_worlds') then
    alter publication supabase_realtime add table public.org_worlds;
  end if;
end $$;
