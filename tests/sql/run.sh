#!/bin/bash
# Database tests: every migration applied twice to fresh databases, then the behaviour tests. Output is compared with
# sql/expected.out (reviewed by hand in QA rounds 2-4). Needs psql and a Postgres 15+ server: PGHOST/PGUSER/PGPASSWORD.
# Usage: tests/sql/run.sh            -> prints PASS/FAIL lines
#        tests/sql/run.sh --update   -> rewrites expected.out after a deliberate change (review the diff!)
set -u
T=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$T/../.." && pwd); cd "$ROOT"
P="psql -X -q ${PGHOST:+-h $PGHOST} -U ${PGUSER:-postgres}"
ORDER=$(cat "$T/ORDER")
$P -d postgres -c "select 1" >/dev/null 2>&1 || { echo "FAIL cannot reach Postgres (set PGHOST/PGUSER/PGPASSWORD)"; exit 1; }
OUTF=$(mktemp); ERR=$(mktemp); fails=0
clean() { grep -v "wal_level\|HINT\|CONTEXT\|^LINE\|^ *\^\|^$\|STATEMENT\|^INSERT\|^NOTICE" | sed -E 's/psql:[^ ]* //; s/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<uuid>/g; s/[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.]+(\+00:00|\+00)?/<time>/g'; }
for db in vft vfi vfr vf4; do
  $P -d postgres -c "drop database if exists $db" -c "create database $db" 2>&1 | grep -v NOTICE
  $P -d $db -v ON_ERROR_STOP=1 -f "$T/shim-noworlds.sql" >/dev/null 2>&1
  for pass in 1 2; do for f in $ORDER; do
    $P -d $db -v ON_ERROR_STOP=1 -f supabase/migrations/$f.sql >/dev/null 2>"$ERR" && continue
    echo "FAIL migration $f (database $db, pass $pass): $(head -3 "$ERR")"; fails=1
  done; done
done
[ $fails = 0 ] && echo "PASS every migration applies twice on fresh databases"
{
echo "== test_sync.sql"; $P -d vft -f "$T/test_sync.sql" 2>&1 | clean
echo "== test_invites.sql"; $P -d vfi -f "$T/test_invites.sql" 2>&1 | clean
echo "== test_r3.sql"; $P -d vfr -f "$T/test_r3.sql" 2>&1 | clean
echo "== grandfathering"; PSQL="$P" bash "$T/grandfather.sh" 2>&1 | clean
echo "== edge columns"; $P -d vfr -At -c "select table_name || '.' || column_name from information_schema.columns where table_schema='private' and column_name='created_by' order by 1"
echo "== test_r4.sql"; $P -d vf4 -f "$T/test_r4.sql" 2>&1 | clean
} > "$OUTF"
for i in 1 2; do $P -d vf4 -v ON_ERROR_STOP=1 -f supabase/migrations/$(echo $ORDER | awk '{print $NF}').sql >/dev/null 2>"$ERR" || { echo "FAIL latest migration re-run $i: $(head -3 "$ERR")"; fails=1; }; done
if [ "${1:-}" = "--update" ]; then cp "$OUTF" "$T/expected.out"; echo "expected.out updated"; exit 0; fi
if diff -u "$T/expected.out" "$OUTF" > "$ERR"; then echo "PASS database behaviour matches expected.out"; else echo "FAIL database behaviour differs from expected.out:"; head -60 "$ERR"; fails=1; fi
rm -f "$OUTF" "$ERR"; exit $fails
