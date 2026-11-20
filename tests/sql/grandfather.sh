#!/bin/bash
# Factors verified before 20261117_mfa_trust.sql first runs stay usable; re-running the file trusts nothing new.
T=$(cd "$(dirname "$0")" && pwd); cd "$T/../.."
P=${PSQL:-psql -X -q -U postgres}
$P -d postgres -c "drop database if exists vf5" -c "create database vf5" 2>&1 | grep -v NOTICE
$P -d vf5 -v ON_ERROR_STOP=1 -f "$T/shim-noworlds.sql" >/dev/null 2>&1
for f in 20261116_worlds_baseline 20261108_world_hardening 20261108_accounts 20261109_mfa 20261116_sync_cas 20261116_invites_owner; do $P -d vf5 -v ON_ERROR_STOP=1 -f supabase/migrations/$f.sql >/dev/null 2>&1 || echo FAIL $f; done
$P -d vf5 -c "insert into auth.users (id,email,email_confirmed_at) values ('00000000-0000-0000-0000-000000000001','old@x.example',now()); insert into auth.mfa_factors (id,user_id,status) values ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-000000000001','verified'), ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-000000000001','unverified');"
$P -d vf5 -v ON_ERROR_STOP=1 -f supabase/migrations/20261117_mfa_trust.sql >/dev/null 2>&1 || echo FAIL first
$P -d vf5 -c "insert into auth.mfa_factors (id,user_id,status) values ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-000000000001','verified');"
$P -d vf5 -v ON_ERROR_STOP=1 -f supabase/migrations/20261117_mfa_trust.sql >/dev/null 2>&1 || echo FAIL rerun
$P -d vf5 -At -c "select 'trusted after first run + re-run: ' || string_agg(right(factor_id::text, 2) || '/' || how, ', ' order by factor_id) from public.mfa_trusted_factors"
