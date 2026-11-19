-- QA round 3 (finding R1-17): an authenticator only counts once the account's owner has confirmed it by email.
-- Supabase lets anyone who holds a staff account's password enrol an authenticator while the account has none
-- (new staff, invited colleagues, anyone after a "lost phone" reset). Until now that was enough to reach the
-- second factor (aal2) and so the team's data. Now a staff session passes mfa_ok() only when every verified
-- authenticator on the account is "trusted". A factor becomes trusted through trust_my_factor(), which needs
-- one of:
--   (a) proof of the email address in this session: the session was opened from an emailed link or code within
--       the last 60 minutes. That is any JWT amr sign-in method other than a password (or token refresh, anonymous
--       or wallet sign-in): otp, magiclink, email/signup, invite, recovery, email_change, and also SSO/OAuth, which
--       prove the identity through the provider. A deny-list is used so a renamed method can't lock people out; or
--   (b) the session already reached aal2 while every other verified factor on the account was trusted, which
--       covers adding a backup device from Account & team.
-- An attacker with only the password can still enrol a factor, but it stays untrusted, so they get no data; the
-- real person sees "confirm by email" (or asks support to reset the authenticator). Nothing here touches the
-- auth schema: it only reads auth.mfa_factors and the session's JWT.
-- Removing the last authenticator is no longer a security hole either: setting one up again needs the email step.
-- Factors already verified when this migration first runs are trusted (grandfathered) once; re-running the file
-- does not trust anything new. Safe to re-run. Requires 20261116_invites_owner.sql (my_account) and 20261109_mfa.sql.

do $$ begin
  if to_regclass('public.mfa_trusted_factors') is null then
    create table public.mfa_trusted_factors (
      factor_id uuid primary key,
      user_id uuid not null references auth.users(id) on delete cascade,
      how text not null check (how in ('email', 'trusted factor', 'existing')),
      trusted_at timestamptz not null default now()
    );
    -- First run only: everything already verified stays usable.
    insert into public.mfa_trusted_factors (factor_id, user_id, how)
      select f.id, f.user_id, 'existing' from auth.mfa_factors f where f.status::text = 'verified';
  end if;
end $$;
create index if not exists mfa_trusted_factors_user_idx on public.mfa_trusted_factors (user_id);
alter table public.mfa_trusted_factors enable row level security;
revoke all on public.mfa_trusted_factors from public, anon, authenticated;

-- When did this session last prove the email address (or another identity than the password)? null: never.
create or replace function public.email_proof_at() returns timestamptz language sql stable set search_path to '' as $$
  select max(to_timestamp((e ->> 'timestamp')::double precision))
  from jsonb_array_elements(case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]'::jsonb end) e
  where coalesce(e ->> 'method', '') <> '' and e ->> 'method' not in ('password', 'totp', 'token_refresh', 'anonymous', 'web3', 'phone')
    and e ->> 'method' not like 'mfa/%'
    and (e ->> 'timestamp') ~ '^[0-9]+(\.[0-9]+)?$'
$$;

-- Verified authenticators on this account that nobody has confirmed by email.
create or replace function public.untrusted_factors(p_user uuid) returns int language sql stable security definer set search_path to '' as $$
  select count(*)::int from auth.mfa_factors f
  where f.user_id = p_user and f.status::text = 'verified'
    and not exists (select 1 from public.mfa_trusted_factors t where t.factor_id = f.id)
$$;

create or replace function public.mfa_ok() returns boolean language sql stable security definer set search_path to '' as $$
  select coalesce((select role in ('pending', 'driver') from public.profiles where id = auth.uid()), true)
      or (coalesce(auth.jwt() ->> 'aal', '') = 'aal2' and public.untrusted_factors(auth.uid()) = 0)
$$;

-- Confirm an authenticator (null: every verified one on the account). See (a) and (b) above.
create or replace function public.trust_my_factor(p_factor uuid default null) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_proof timestamptz := public.email_proof_at(); v_how text; n int := 0;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then raise exception 'Enter a code from your authenticator first.' using errcode = '42501'; end if;
  if p_factor is not null and not exists (select 1 from auth.mfa_factors where id = p_factor and user_id = auth.uid() and status::text = 'verified') then
    raise exception 'That authenticator isn’t set up on your account.';
  end if;
  if v_proof is not null and v_proof > now() - interval '60 minutes' then v_how := 'email';
  elsif p_factor is not null
    and exists (select 1 from public.mfa_trusted_factors t join auth.mfa_factors f on f.id = t.factor_id where t.user_id = auth.uid() and f.status::text = 'verified' and f.id <> p_factor)
    and not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status::text = 'verified' and f.id <> p_factor
                    and not exists (select 1 from public.mfa_trusted_factors t where t.factor_id = f.id)) then v_how := 'trusted factor';
  else
    raise exception 'Confirm it’s you by email first: open the sign-in link we email you.' using errcode = '42501';
  end if;
  insert into public.mfa_trusted_factors (factor_id, user_id, how)
    select f.id, f.user_id, v_how from auth.mfa_factors f
    where f.user_id = auth.uid() and f.status::text = 'verified' and (p_factor is null or f.id = p_factor)
  on conflict (factor_id) do nothing;
  get diagnostics n = row_count;
  if n > 0 then
    insert into public.audit_log (org_id, actor, action, detail) values (public.my_org(), auth.uid(), 'two-factor device confirmed', jsonb_build_object('how', v_how, 'devices', n));
  end if;
  return public.my_account();
end; $$;

-- my_account also says whether an authenticator still needs confirming, and whether this session can do it
-- without another email (mfa_trust is absent on older servers, so the app knows the rule isn't there).
create or replace function public.my_account() returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare p public.profiles; o public.organizations; u record; ok boolean := public.mfa_ok(); v_proof timestamptz := public.email_proof_at();
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select * into p from public.profiles where id = auth.uid();
  select email, phone, email_confirmed_at, phone_confirmed_at into u from auth.users where id = auth.uid();
  if p.org_id is not null then select * into o from public.organizations where id = p.org_id; end if;
  return jsonb_build_object(
    'id', auth.uid(), 'email', u.email, 'phone', u.phone, 'confirmed', (u.email_confirmed_at is not null or u.phone_confirmed_at is not null),
    'full_name', p.full_name, 'role', p.role,
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'), 'mfa_required', not ok,
    'mfa_trust', jsonb_build_object('untrusted', public.untrusted_factors(auth.uid()), 'email_proof', v_proof is not null and v_proof > now() - interval '60 minutes'),
    'org', case when o.id is null then null else jsonb_build_object('id', o.id, 'name', o.name, 'kind', o.kind) end,
    'owner', o.id is not null and o.created_by = auth.uid(),
    'members', case when o.id is null or not ok then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'full_name', m.full_name, 'role', m.role, 'you', m.id = auth.uid(), 'owner', m.id = o.created_by) order by m.created_at), '[]'::jsonb) from public.profiles m where m.org_id = o.id) end,
    'invites', case when o.id is null or not ok or p.role not in ('manager', 'operator', 'developer', 'admin') then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role, 'created_at', i.created_at, 'expires_at', i.expires_at, 'expired', i.expires_at <= now(), 'declined', i.declined_at is not null) order by i.created_at), '[]'::jsonb) from public.org_invites i where i.org_id = o.id and i.accepted_at is null) end
  );
end; $$;

revoke execute on function public.email_proof_at(), public.untrusted_factors(uuid), public.trust_my_factor(uuid) from public, anon;
revoke execute on function public.untrusted_factors(uuid) from authenticated;
grant execute on function public.trust_my_factor(uuid), public.email_proof_at(), public.mfa_ok(), public.my_account() to authenticated;
grant execute on function public.mfa_ok() to anon; -- as before (harmless: anon has no profile)

notify pgrst, 'reload schema';
