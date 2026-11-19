-- QA round 3 (finding R1-08): sign-up limits that one person can't use up for everyone.
-- create_organization used one global counter (100 organisations an hour). Anyone with a mailbox that takes
-- plus-addresses could confirm 100 accounts an hour and block every real customer's sign-up. Now:
--  * per account: at most 3 organisations a day (create, leave, create again…);
--  * per mailbox: at most 3 an hour, counting plus-address and Gmail dot variants of one address as one
--    mailbox (ama+1@…, a.ma@gmail.com and ama@gmail.com are the same person);
--  * per company domain: at most 30 an hour (public webmail domains such as gmail.com are exempt; there the
--    mailbox rule applies);
--  * a global circuit breaker of 300 an hour, so a flood across many domains still can't fill the database.
-- The counters live in private.signup_events: a one-way hash of the normalised mailbox and of the domain, with a
-- timestamp, kept for 48 hours (abuse prevention only; no address is stored). They survive account deletion, so
-- "sign up, create, delete, repeat" is still counted.
-- admin_overview also reports sign-ups in the last hour against the ceiling, so admins see when it bites.
-- Safe to re-run. Requires 20261116_invites_owner.sql (for its my_account) and 20261109_mfa.sql.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.signup_events (
  id bigserial primary key,
  user_hash text not null,
  mailbox_hash text not null,
  domain_hash text not null,
  public_domain boolean not null default false,
  at timestamptz not null default now()
);
create index if not exists signup_events_at_idx on private.signup_events (at);
create index if not exists signup_events_mailbox_idx on private.signup_events (mailbox_hash, at);
create index if not exists signup_events_domain_idx on private.signup_events (domain_hash, at);
create index if not exists signup_events_user_idx on private.signup_events (user_hash, at);
revoke all on private.signup_events from public, anon, authenticated;

-- The mailbox an address really delivers to: lower case, "+tag" removed, and for Gmail the dots too.
create or replace function private.mailbox_of(p_email text) returns text language sql immutable set search_path to '' as $$
  select case when p_email is null or position('@' in p_email) = 0 then lower(coalesce(p_email, ''))
    else (with parts as (select lower(split_part(p_email, '@', 1)) as l, lower(split_part(p_email, '@', 2)) as d)
          select case when d in ('gmail.com', 'googlemail.com') then replace(split_part(l, '+', 1), '.', '') || '@gmail.com'
                      else split_part(l, '+', 1) || '@' || d end from parts) end
$$;
create or replace function private.public_mail_domain(p_domain text) returns boolean language sql immutable set search_path to '' as $$
  select lower(coalesce(p_domain, '')) in ('gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'outlook.com',
    'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
    'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'zoho.com', 'zohomail.com')
$$;
create or replace function private.h(p text) returns text language sql immutable set search_path to '' as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex')
$$;
revoke execute on function private.mailbox_of(text), private.public_mail_domain(text), private.h(text) from public, anon, authenticated;

create or replace function public.create_organization(p_kind text, p_name text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare p public.profiles; u record; v_name text := public.clean_text(p_name, 80); v_role text; v_org uuid;
  v_mbox text; v_domain text; v_public boolean; v_user text; v_mhash text; v_dhash text;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select * into p from public.profiles where id = auth.uid() for update;
  if p.id is null then raise exception 'no profile'; end if;
  if p.org_id is not null or p.role <> 'pending' then raise exception 'You already belong to an organisation.'; end if;
  select email, phone, email_confirmed_at, phone_confirmed_at into u from auth.users where id = auth.uid();
  if u.email_confirmed_at is null and u.phone_confirmed_at is null then raise exception 'Confirm your email address first.'; end if;
  v_role := case p_kind when 'fleet' then 'manager' when 'operator' then 'operator' when 'developer' then 'developer' when 'driver' then 'driver' else null end;
  if v_role is null then raise exception 'Choose an account type.'; end if;
  if p_kind = 'driver' and char_length(v_name) < 2 then v_name := coalesce(nullif(public.clean_text(p.full_name, 80), ''), 'My account'); end if;
  if char_length(v_name) < 2 then raise exception 'Give your organisation a name.'; end if;

  -- Limits (QA R1-08). One sign-up at a time, so two requests can't both slip under a limit.
  perform pg_advisory_xact_lock(hashtext('voltfleet:create_organization'));
  delete from private.signup_events where at < now() - interval '48 hours';
  v_user := private.h(auth.uid()::text);
  if u.email is not null and u.email_confirmed_at is not null then
    v_mbox := private.mailbox_of(u.email); v_domain := lower(split_part(u.email, '@', 2));
  else
    v_mbox := 'phone:' || regexp_replace(coalesce(u.phone, ''), '\D', '', 'g'); v_domain := 'phone';
  end if;
  v_public := v_domain = 'phone' or private.public_mail_domain(v_domain);
  v_mhash := private.h(v_mbox); v_dhash := private.h(v_domain);
  if (select count(*) from private.signup_events where user_hash = v_user and at > now() - interval '24 hours') >= 3 then
    raise exception 'You’ve set up several organisations today. Try again tomorrow, or ask support.' using errcode = '54000';
  end if;
  if (select count(*) from private.signup_events where mailbox_hash = v_mhash and at > now() - interval '1 hour') >= 3 then
    raise exception 'Too many sign-ups from this email address. Try again in an hour.' using errcode = '54000';
  end if;
  if not v_public and (select count(*) from private.signup_events where domain_hash = v_dhash and at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many sign-ups from your organisation’s email domain right now. Try again in an hour, or ask a colleague to invite you.' using errcode = '54000';
  end if;
  if (select count(*) from private.signup_events where at > now() - interval '1 hour') >= 300 then
    raise exception 'Too many sign-ups right now. Try again in a few minutes.' using errcode = '54000';
  end if;

  insert into public.organizations (name, kind, created_by) values (v_name, p_kind, auth.uid()) returning id into v_org;
  update public.profiles set org_id = v_org, role = v_role, updated_at = now() where id = auth.uid();
  insert into public.org_worlds (org_id) values (v_org);
  insert into private.signup_events (user_hash, mailbox_hash, domain_hash, public_domain) values (v_user, v_mhash, v_dhash, v_public);
  perform public.audit('organisation created', jsonb_build_object('kind', p_kind, 'name', v_name));
  return public.my_account();
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
    'signups_1h', (select count(*) from private.signup_events where at > now() - interval '1 hour'),
    'signup_ceiling', 300,
    'staff_with_2fa', (select count(distinct f.user_id) from auth.mfa_factors f join public.profiles p on p.id = f.user_id where f.status = 'verified' and p.role in ('manager', 'operator', 'developer', 'admin')));
end; $$;

revoke execute on function public.create_organization(text, text), public.admin_overview() from public, anon;
grant execute on function public.create_organization(text, text), public.admin_overview() to authenticated;

notify pgrst, 'reload schema';
