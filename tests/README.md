# VoltFleet OS regression suite

Every check written during QA rounds 1–4 (see `docs/qa/`), as one command. GitHub Actions runs it on every push and
pull request, and **the site is only deployed when it passes** (`.github/workflows/pages.yml`).

```sh
cd tests && npm ci && npx playwright install chromium   # once
cd .. && node tests/run.cjs                               # browser, unit and Edge Function tests
node tests/run.cjs --sql                                  # + database tests (needs Postgres, see below)
node tests/run.cjs xss csp r4-app                         # only some tests
```

The runner serves the app on `http://localhost:8080` and a cross-origin "attacker" page on `127.0.0.1:8091`
(`VF_NO_SERVE=1` to use your own servers). Logs and screenshots go to `tests/out/`. `VF_TEST_JOBS` sets parallelism
(default 3), `VF_TEST_TIMEOUT` the per-file limit in seconds (default 600).

A test file **fails** when it exits non-zero, prints a line starting with `FAIL`, or misses the expectations listed for
it in `run.cjs` (for the older checks that print a summary instead of PASS/FAIL lines).

| Folder | What | Needs |
| --- | --- | --- |
| `e2e/` | The app in Chromium: sign-in and two-factor flows (against `fixtures/fake-supabase.js`), sync conflicts, XSS, CSP, accessibility (axe-core), sign-out privacy, retention, bad data, offline shell, framing, every page in every role | Playwright |
| `unit/` | Sync patch merging (`js/cloud.js`) | Node |
| `functions/` | Both Edge Functions (`supabase/functions/*`) against in-memory stores | Node 22+ (`--experimental-strip-types`) |
| `sql/` | Every migration applied twice to fresh databases, then behaviour tests (sync rules, invitations, two-factor trust, sign-up limits, audit, retention, erasure); output compared with `sql/expected.out` | Postgres 15+ and `psql`; `PGHOST`, `PGUSER`, `PGPASSWORD` |

**Never against the live project.** The browser tests block `*.supabase.co` and third-party hosts, and the CI job also
blocks them in `/etc/hosts`, so demo-mode tests can't write to the live demo world.

When a database change is deliberate, run `tests/sql/run.sh --update`, **read the diff of `sql/expected.out`**, and
commit it with the migration. A new migration also goes into `sql/ORDER`.
