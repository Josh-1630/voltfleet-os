-- QA round 4 (finding R3-15, and R4-04): retention for what the server keeps, and erasure that reaches every copy.
-- Until now only private.ocpp_log (7 days, in the ocpp function) and private.smartcar_states (1 day) were pruned.
-- private.purge_expired() applies these periods. The reasoning (Ghana Data Protection Act, 2012 (Act 843): keep
-- personal data no longer than the purpose needs; tax law: keep billing records for years):
--
--   what                                 kept for                     why
--   private.ocpp_transactions            6 years; the card number     charging sessions are billing records (the
--                                        (id_tag) is masked to        Revenue Administration Act, 2016 (Act 915) is
--                                        "04•••E5" after 90 days      commonly read as six years); 90 days covers
--                                                                     disputes, after that the card isn't needed
--   private.ocpp_commands                90 days                      operations history (RemoteStart carries a card)
--   private.ocpp_log                     7 days                       debugging only (as the ocpp function does)
--   private.smartcar_cache               30 days since the last       vehicle readings include the car's location;
--                                        reading, or at once when     refetched on the next poll
--                                        no link uses it
--   private.smartcar_links               180 days unused              the browser holding the key is gone; access
--                                                                     ends (the person reconnects)
--   private.smartcar_states              1 day                        one-time sign-in states
--   private.signup_events                48 hours                     abuse limits only (one-way hashes)
--   public.audit_log                     7 years; email addresses     accountability for security events; the
--                                        in entries removed after     invitee's address isn't needed after a year
--                                        1 year
--   public.org_invites                   30 days after accepted,      the membership itself is in profiles; a
--                                        declined or expired          declined invitee is a third party
--   public.mfa_trusted_factors           while the authenticator      a trust mark for a removed authenticator
--                                        exists                       is meaningless
-- Confirm the periods with counsel before launch (security review item I).
--
-- How it runs: at most once an hour (private.maintenance), whichever comes first of
--   * pg_cron, daily at 03:17 UTC, if the extension is enabled (Dashboard -> Integrations -> Cron; then re-run
--     this file, which schedules the job; pg_cron is available on the project but not installed as of 19 Nov 2026);
--   * a trigger after inserts into public.audit_log (sign-ups, invites, record_event...), which never fails the insert;
--   * the ocpp and smartcar Edge Functions, opportunistically (they ignore the call before this file is applied).
--
-- Erasure (R4-04): delete_my_account now also removes the person's email address from invitations
-- (public.org_invites) and from audit entries ("invited", "joined by invite"), which used to keep it after the
-- account was gone. The event itself stays, without the address.
--
-- Safe to re-run. Requires 20261102_ocpp.sql, 20261102_smartcar.sql, 20261116_invites_owner.sql,
-- 20261117_signup_limits.sql and 20261117_mfa_trust.sql.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.maintenance (
  job text primary key,
  last_run timestamptz not null,
  result jsonb
);
revoke all on private.maintenance from public, anon, authenticated;

create index if not exists ocpp_tx_start_idx on private.ocpp_transactions (start_at);
create index if not exists ocpp_cmd_created_idx on private.ocpp_commands (created_at);
create index if not exists ocpp_log_at_idx on private.ocpp_log (at);
create index if not exists smartcar_cache_fetched_idx on private.smartcar_cache (fetched_at);
create index if not exists audit_at_idx on public.audit_log (at);

create or replace function private.purge_expired(p_force boolean default false) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare last timestamptz; r jsonb := '{}'::jsonb; n int;
begin
  -- One run at a time; skip quietly if another session is purging right now.
  if not pg_try_advisory_xact_lock(hashtext('voltfleet:purge_expired')) then return null; end if;
  select m.last_run into last from private.maintenance m where m.job = 'purge_expired';
  if not p_force and last is not null and last > now() - interval '1 hour' then return null; end if;
  insert into private.maintenance (job, last_run) values ('purge_expired', now())
    on conflict (job) do update set last_run = excluded.last_run;

  -- OCPP (the operator's charging network)
  update private.ocpp_transactions set id_tag = case when char_length(id_tag) > 4 then left(id_tag, 2) || '•••' || right(id_tag, 2) else '•••' end
    where coalesce(stop_at, start_at) < now() - interval '90 days' and position('•••' in id_tag) = 0;
  get diagnostics n = row_count; r := r || jsonb_build_object('ocpp_cards_masked', n);
  delete from private.ocpp_transactions where coalesce(stop_at, start_at) < now() - interval '2190 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('ocpp_transactions', n);
  delete from private.ocpp_commands where created_at < now() - interval '90 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('ocpp_commands', n);
  delete from private.ocpp_log where at < now() - interval '7 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('ocpp_log', n);

  -- Smartcar (live vehicle data)
  delete from private.smartcar_links where coalesce(last_used_at, created_at) < now() - interval '180 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('smartcar_links', n);
  delete from private.smartcar_cache c where c.fetched_at < now() - interval '30 days'
    or not exists (select 1 from private.smartcar_links l where l.user_id = c.user_id);
  get diagnostics n = row_count; r := r || jsonb_build_object('smartcar_cache', n);
  delete from private.smartcar_states where created_at < now() - interval '1 day';
  get diagnostics n = row_count; r := r || jsonb_build_object('smartcar_states', n);

  -- Accounts
  delete from private.signup_events where at < now() - interval '48 hours';
  get diagnostics n = row_count; r := r || jsonb_build_object('signup_events', n);
  update public.audit_log set detail = detail - 'email' where at < now() - interval '365 days' and detail ? 'email';
  get diagnostics n = row_count; r := r || jsonb_build_object('audit_emails_removed', n);
  delete from public.audit_log where at < now() - interval '2555 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('audit_log', n);
  delete from public.org_invites where accepted_at < now() - interval '30 days' or declined_at < now() - interval '30 days'
    or (accepted_at is null and expires_at < now() - interval '30 days');
  get diagnostics n = row_count; r := r || jsonb_build_object('org_invites', n);
  delete from public.mfa_trusted_factors t where not exists (select 1 from auth.mfa_factors f where f.id = t.factor_id);
  get diagnostics n = row_count; r := r || jsonb_build_object('mfa_trusted_factors', n);

  update private.maintenance set result = r where job = 'purge_expired';
  return r;
end; $$;
revoke execute on function private.purge_expired(boolean) from public, anon, authenticated;

-- After any audit entry: give the purge a chance to run (at most hourly). It never makes the insert fail.
create or replace function private.purge_after_audit() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  begin perform private.purge_expired(false); exception when others then null; end;
  return null;
end; $$;
revoke execute on function private.purge_after_audit() from public, anon, authenticated;
drop trigger if exists audit_log_purge on public.audit_log;
create trigger audit_log_purge after insert on public.audit_log for each statement execute function private.purge_after_audit();

-- Daily, when pg_cron is enabled (re-run this file after enabling it). cron.schedule with a job name updates it.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('voltfleet-purge-expired', '17 3 * * *', 'select private.purge_expired(true)');
  end if;
end $$;

-- Erasure reaches the invitations and the audit log too (R4-04). Otherwise as in 20261116_invites_owner.sql.
create or replace function public.delete_my_account() returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_org uuid := public.my_org(); v_email text;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  perform public.require_mfa();
  select lower(email) into v_email from auth.users where id = auth.uid();
  perform public.audit('account deleted', '{}'::jsonb);
  if v_email is not null and v_email <> '' then
    delete from public.org_invites where lower(email) = v_email;
    update public.audit_log set detail = detail - 'email' where detail ? 'email' and lower(detail ->> 'email') = v_email;
  end if;
  delete from auth.users where id = auth.uid();
  if v_org is not null then
    if not exists (select 1 from public.profiles where org_id = v_org) then delete from public.organizations where id = v_org;
    else perform public.org_owner(v_org); -- hand ownership to the longest-standing member
    end if;
  end if;
  return jsonb_build_object('ok', true);
end; $$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

notify pgrst, 'reload schema';
