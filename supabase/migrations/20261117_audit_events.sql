-- QA round 3 (finding R2-07): an audit trail members can't rewrite.
-- The in-app audit trail (who revealed personal data, exported, changed consent, rotated a key…) is part of the
-- workspace snapshot, so any member could edit or delete entries by writing a snapshot. In a signed-in workspace
-- the app now also records each of these events here, in public.audit_log, which members can read (admins, after
-- the second factor) but never change: there are no write grants, and this function only appends.
--  * actor and organisation come from the session, never from the browser;
--  * only known event names are accepted, the detail is capped at 2 kB of plain text fields;
--  * at most 200 events per person per hour, so it can't be used to flood the log.
-- What an event says (its target and reason) is still what the browser reported; what is guaranteed is that it
-- happened, who sent it and when, and that nobody removed it afterwards. Safe to re-run. Requires 20261109_mfa.sql.

create index if not exists audit_actor_idx on public.audit_log (actor, at desc);

create or replace function public.record_event(p_action text, p_target text default null, p_reason text default null)
returns void language plpgsql security definer set search_path to '' as $$
declare v_org uuid := public.my_org();
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if v_org is null or public.my_role() = 'pending' then raise exception 'No workspace for this account.' using errcode = '42501'; end if;
  perform public.require_mfa();
  if p_action is null or p_action not in ('reveal-pii', 'data-export', 'erasure', 'consent-change', 'retention-change', 'station-status', 'export',
      'reveal-secret', 'rotate-secret', 'webhook-create', 'connect-grant', 'connect-revoke', 'app-status', 'pricing-change', 'remote-command',
      'booking-cancel', 'access-denied') then
    raise exception 'Unknown event.';
  end if;
  if (select count(*) from public.audit_log where actor = auth.uid() and at > now() - interval '1 hour') >= 200 then
    raise exception 'too many events, slow down' using errcode = '54000';
  end if;
  insert into public.audit_log (org_id, actor, action, detail)
  values (v_org, auth.uid(), 'app: ' || p_action, jsonb_build_object('target', nullif(public.clean_text(p_target, 300), ''), 'reason', nullif(public.clean_text(p_reason, 300), ''), 'source', 'app'));
end; $$;

revoke execute on function public.record_event(text, text, text) from public, anon;
grant execute on function public.record_event(text, text, text) to authenticated;

notify pgrst, 'reload schema';
