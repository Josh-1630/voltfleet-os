# VoltFleet OS QA and security relay, round 4: verification, fixes and fresh assessment

19–20 November 2026. Agent 4. Nothing was committed, pushed or deployed. The live Supabase project was only read: catalog queries, function definitions, table row counts and the security advisor. No DDL or DML.

## Summary

- **Round 3 holds**, on the code and on the live project. The full round-3 suite on the committed code gave the same results as round 3's own final run. The live database matches the repo: every function's definition is identical to a database rebuilt from the migrations, except the two that differ only in comments (as round 3 noted). Grants, RLS and the advisor are as intended. Every server table that holds personal data is still empty, and there are 0 users.
- **Open items.**
  - R3-15 (server retention) is implemented in a new migration. It runs without pg_cron, and also with it once it's enabled.
  - The billing retention floor is now 6 years.
  - The Netlify `Permissions-Policy` is correct as it is: the app uses neither geolocation nor the camera. One retired feature name was replaced.
  - CAPTCHA support is ready but off.
  - R1-06, R1-09 and the `p_expected` change stay open, for the reasons given below.
- **Fresh audit: 8 findings fixed, 2 informational.**
  - 4 Medium, all fixed:
    - sign-out leaves a car's key and location on a shared device;
    - one crafted demo snapshot breaks 28 pages and stops the shared simulation;
    - retention changes wallet balances, and its floor was too short for tax records;
    - erasure leaves the email address on the server and the person's details in the team workspace.
  - 4 Low, all fixed.

## Migrations to apply

There is one migration. It is safe to re-run. The whole chain (14 files) was applied twice to fresh local Postgres 16 databases, the new file was applied twice more on top, and the round-2 and round-3 SQL tests give identical output with it.

1. `supabase/migrations/20261119_retention.sql` (R3-15, R4-04):
   - adds `private.maintenance` and `private.purge_expired(p_force boolean default false)`, which runs at most once an hour (periods below);
   - adds a statement trigger on `public.audit_log` that runs the purge after inserts. It never fails the insert;
   - schedules a daily pg_cron job, but only if the `pg_cron` extension is already enabled. It is available on the project but not installed. To use it, enable it under **Dashboard → Integrations → Cron**, then run this file again;
   - adds 5 indexes;
   - replaces `delete_my_account()`. It now also removes the person's email address from `org_invites` and from audit entries; the events themselves are kept.

**Order with the app and the functions.** Each works with the other old or new:

| Combination | What happens |
| --- | --- |
| New app, old database | Everything works. The app changes need no new server functions. Erasure in the team workspace happens in the app; the email in invitations and the audit log is erased only once the migration is applied. |
| Old cached app, new database | Unaffected. `delete_my_account` keeps its signature and result. |
| New Edge Functions, old database | The opportunistic `select private.purge_expired(false)` fails and is ignored. It is fire-and-forget, with no `await`. |
| New database, old Edge Functions | The purge still runs, from the audit trigger and from pg_cron if enabled. |

## Edge Functions to redeploy

Both functions have a one-line change in `index.ts` only (`ocpp/index.ts`, `smartcar/index.ts`). At most once an hour per instance, they give the database purge a chance to run:
- `ocpp`: after the existing weekly-log prune (every 200 log writes);
- `smartcar`: on `start` and on each `vehicles` poll.

- No new secrets.
- No change to request handling: `server.ts`, `csms.ts` and `handler.ts` are untouched.
- Parse-checked with `esbuild@0.24.0` (all 5 files).
- Function tests: `qa3/fn-test-ocpp.mts` 28/28, `qa3/fn-test-smartcar.mts` 29/29, `qa2/fn-test-smartcar.mts` 22/22.

Redeploying is optional; the purge also runs without it.

## Deploy order

1. Web app (GitHub Pages): no new files. The service worker cache is now `voltfleet-os-v24`.
2. `20261119_retention.sql`.
3. Optionally, `ocpp` and `smartcar`.
4. Optionally, enable pg_cron and run the migration again.

---

## 1. Did round 3 hold?

Yes. Nothing regressed.

- **Suite on the committed code** (`qa4/base/`, the round-3 runner unchanged) is identical to round 3's run, with one difference:
  - t20 27/27, t20-legacy 27/27, t20-r3 35/35;
  - sync-cas 10/10, sync-legacy 9/9;
  - heads 4/4, r3-app 25/25;
  - functions 28/29/22;
  - xss and csp clean;
  - the known failures only.
  - **The difference:** axe found one violation in dark mode on the fleet dashboard when map tiles can't load. That is new finding R4-07, not a regression in round-3 code: the schematic-map note's link was never underlined.
- **Live database** (read-only):
  - The `md5(pg_get_functiondef)` of all 34 public and private functions was compared with a local rebuild. 31 are identical. `complete_signup` and `world_tick` differ only in comments, as round 3 reported. `delete_my_account` differs only because this round replaces it. So all five round-3 migrations are live exactly as in the repo (`qa4/live-md5.txt`, `qa4/local-md5.txt`).
  - Grants: `anon` can execute only `world_push`, `world_tick` and `mfa_ok`. Internal helpers (`audit`, `untrusted_factors`, `sync_world_head`, `private.*`) can't be executed by `authenticated`.
  - RLS is on for every public table. The `private` schema has no grants.
  - Row counts: `ocpp_*`, `smartcar_*`, `audit_log` and `signup_events` are all 0, and `auth.users` has 0 rows. Nothing can be lost to the new retention periods.
  - Security advisor: only the expected "SECURITY DEFINER callable" warnings, and "RLS without policy" on `mfa_trusted_factors`, which is intentional.
  - Edge Functions: `smartcar` v3 and `ocpp` v2, both `verify_jwt: false`, as briefed.
- **Live check still open:** whether the `amr` claim lists the confirmation link as expected (round 3's note before migration 2). Nobody has signed up yet, so it can't be observed.

## 2. Open items

| Item | Status | What was done |
| --- | --- | --- |
| R3-15 server retention | **Fixed** (needs the migration) | `private.purge_expired`, periods below. Runs from the audit trigger, the Edge Functions and pg_cron. Card numbers are masked rather than deleted, so billing records stay. |
| Billing retention floor 30 days | **Fixed** | Floor 6 years (2190 days), default 2190; details under R4-03. |
| `netlify.toml` `Permissions-Policy` | **Checked, no breakage** | The app calls no `navigator.geolocation`, `getUserMedia` or camera `<input capture>`. Positions are simulated or come from Smartcar on the server, and car photos are bundled (no uploads). So `geolocation=()` and `camera=()` stay. `interest-cohort` (retired; browsers log an unknown-feature error) is replaced by `browsing-topics`. A comment says to use `(self)` if a feature starts using one. |
| R1-08 CAPTCHA | **Prepared, off** | See below. |
| R1-08 per-IP limits | Open | Still no trustworthy client address at the functions (round 2). |
| R1-09 followers download every step | Open | Needs the simulation on the server, or per-record tables. A heads table can't save those bytes. |
| R1-06 read-only role | Open | Same reason as round 3: every member's browser writes the whole snapshot, so "read-only" would be a promise a console call breaks. |
| `p_expected` required in `*_push` | Open, on purpose | It went live on 17 November, three days ago. Making it required now turns any tab still open on a pre-16 November version into "This device only". The service worker is network-first, so a reload fixes it, but a phone PWA resumed from memory may not reload. Suggested after 1 December: `drop function public.world_push(text,text,bigint)`, recreate it without the default, and the same for `org_world_push`. The new app always sends it (`cloud.cas`). |

### Retention periods (R3-15)

Grounded in the data-minimisation and retention principles of Ghana's Data Protection Act, 2012 (Act 843), and in tax record-keeping. The Revenue Administration Act, 2016 (Act 915) is commonly read as requiring records to be kept for six years. Confirm both with counsel before launch (security review item I).

| Data | Kept | Why |
| --- | --- | --- |
| `private.ocpp_transactions` | 6 years. The card number (`id_tag`) is masked to `04•••E5` after 90 days. | Charging sessions are billing records. 90 days covers disputes; the card number isn't needed after that. |
| `private.ocpp_commands` | 90 days | Operations history; `RemoteStartTransaction` carries a card number. |
| `private.ocpp_log` | 7 days | Debugging (as the function already did). |
| `private.smartcar_cache` | 30 days since the last reading; at once when no link uses it | Readings include the car's location and are refetched on the next poll. |
| `private.smartcar_links` | 180 days unused | The browser holding the key is gone. The person reconnects. |
| `private.smartcar_states` | 1 day | One-time states. |
| `private.signup_events` | 48 hours | Abuse limits. It was only pruned when someone signed up. |
| `public.audit_log` | 7 years. Email addresses are removed after 1 year. | Accountability for security events. The invitee's address isn't needed after a year. |
| `public.org_invites` | 30 days after accepted, declined or expired | Membership lives in `profiles`. A declined invitee is a third party. |
| `public.mfa_trusted_factors` | While the authenticator exists | Orphan rows are removed. |

### CAPTCHA (R1-08 remainder)

`js/config.js` has `window.VOLTFLEET_CAPTCHA = { provider: 'turnstile', siteKey: '' }`.

**While the site key is empty, nothing changes:** no widget, and no third-party script is loaded (tested).

**With a public site key** (`turnstile` or `hcaptcha`):
- the provider's script is loaded only on the sign-in screens;
- a widget is shown on sign-up, password sign-in, the emailed-link forms (including "Confirm it's you"), password reset, the phone code and "Send it again";
- the token goes to Supabase Auth as `options.captchaToken`;
- the widget resets after each request (tokens are single-use);
- an unsolved check stops the request before it is sent.

The CSP in `index.html` is not changed. A meta CSP can only be tightened at runtime, so the config comment gives the exact additions.

**Order to switch it on:**
1. Put the site key in `js/config.js`.
2. Allow the provider in the CSP.
3. Deploy.
4. Only then enable CAPTCHA under **Supabase → Authentication → Attack Protection**, with the secret key.

Doing step 4 first would refuse every sign-in from the app. No keys are in the repo.

---

## 3. New findings (round 4)

| ID | Severity | Status | Finding |
| --- | --- | --- | --- |
| R4-01 | Medium (privacy) | Fixed | Signing out on a shared device left the Smartcar access key and the last readings, including the car's location, in the browser. The next person (the demo, or another account) saw the car and could send it charge commands. The OCPP network key loaded for anyone on that browser. |
| R4-02 | Medium (DoS) | Fixed | A demo snapshot whose fleet has a vehicle of an unknown model, or dangling depot, driver or vehicle links, passed `sanitizeState` and `repairState`. It broke 28 pages in 4 roles and crashed the leading device's simulation step (`fleetTick`), freezing the shared demo for everyone. |
| R4-03 | Medium (money, legal) | Fixed | Retention removed old charging sessions, so wallets got the money back: GHS 180 in the test. The billing floor of 30 days (default 730) was below tax record-keeping, and the driver's delete screen said "as the law requires". |
| R4-04 | Medium (privacy) | Fixed (server part needs the migration) | Erasure was incomplete. After `delete_my_account`, the email address stayed in `org_invites` and in audit entries. The team workspace snapshot kept the person's name, email and phone after deletion, leaving or removal. |
| R4-05 | Low | Fixed | The check on cached photo links never ran: `https()` was used before its `const` declaration, threw, and the catch kept the cache. Cached `javascript:` links stayed in the credits list. |
| R4-06 | Low | Fixed | Connect plan prices: an emptied field saved $0 and `1e400` saved Infinity, the same issue as R3-08, missed in `js/connect.js`. |
| R4-07 | Low (accessibility) | Fixed | The link in the schematic-map note ("Settings → Integrations") had 1.34:1 contrast with the text around it and no underline. |
| R4-08 | Low (integrity) | Fixed | Maintenance records took negative costs, lowering reported spend. Add and edit vehicle took any model year (0, 99999) and unlisted model or depot values. Assigning a driver who was meanwhile removed threw. |
| R4-09 | Info | Open (verify once) | Rule (b) of `trust_my_factor` (a backup device is trusted from an `aal2` session) relies on Supabase Auth refusing to enrol a second factor from an `aal1` session ("AAL2 required to enrol a new factor"). Current GoTrue does refuse, but check once on the live project with a test staff account. A database-side check isn't possible: verifying the new factor moves `auth.sessions.factor_id` to the new, untrusted factor. |
| R4-10 | Info | Open | `private.signup_events` stores unsalted SHA-256 hashes of mailboxes and domains. Addresses can be guessed by hashing candidates, so these are pseudonymous, not anonymous. Mitigated by 48-hour retention and the private schema. A keyed hash (pgsodium, or a secret held in `private`) would fix it. |

Before and after: the round-4 tests run against the committed code (`git archive HEAD` served on port 8082) and the working tree.

| Check | Committed | Now |
| --- | --- | --- |
| After sign-out, Smartcar key and location left in the browser, and the car in the next person's (demo) fleet | yes / yes / yes, no disconnect | none, disconnect sent (`signout-probe.js`) |
| Pages broken by a crafted fleet snapshot (4 roles) | 28 + simulation crash | 0 (`badref4.js`) |
| Wallet balance across retention | 441.65 → 621.65 | unchanged, GHS 380 brought forward |
| Billing retention of 30 days | accepted | refused (floor 2190) |
| Cached `javascript:` photo links | kept | dropped |
| Connect price emptied / `1e400` | 0 / 0 | refused / refused |
| Negative maintenance cost; model year 99999 | saved; saved | refused; refused |
| Map-note link underline | none | underline; axe clean |

### R4-01 Shared device keeps someone else's car (Medium, privacy)

**What's wrong.**
- `js/smartcar.js` keeps the device key and the readings (`summary` with `lat`/`lon`) in `localStorage['voltfleet-os:smartcar']` for "this device".
- Sign-out (`VF.auth.signOut`) removed the workspace copy and the account cache, but not this.
- On the next load, `app.js` boots, `VF.real.poll()` runs and the car is injected into whatever fleet is shown: the demo, or another account's workspace.
- The OCPP network key worked the same way, for the "Real chargers" page.

**Fix.**
- **Per-owner storage.** Both stores are now keyed by owner: `acct:<id>` for a signed-in account, `demo` otherwise (`R.sync()` / `O.sync()`). Another account, or the demo, never loads them. The top-level fields keep the demo's entry, so cached older versions still find their own key.
- **Sign-out.** Signing out first disconnects the account's cars on the server (`disconnect`, at most 4 s) and removes their key and readings. It also clears the per-tab charger passwords and Smartcar state.
- **OCPP key kept.** The OCPP key is scoped but not wiped. The server keeps only its hash, so wiping it would orphan the operator's network. Someone with the device and the browser's developer tools can still read it. The proper fix is a server-side "reissue key for the creator" action, using round 3's `created_by`.
- **Smartcar redirect.** The redirect handler waits for sign-in to finish (`VF.authReady`), so the link lands under the right owner.

### R4-02 Crafted fleet snapshot breaks the demo (Medium, DoS)

**What's wrong.** Anyone can write the demo world. R2-01's `repairState` checks stations, sessions, bookings and accounts, but not vehicle models or the fleet. `VF.MODELS[v.model].eff` throws in `fleetTick` on the leading device, so the simulation stops for every visitor, and in 28 pages (all 21 manager pages, plus driver, operator and admin pages).

**Fix.** `repairState`:
- drops vehicles of unknown models or places, from both the driver vehicles and the fleet;
- moves vehicles with an unknown depot to the first depot;
- cuts dangling `driverId` and `vehicleId` links;
- defaults `maintenance` to a list;
- reseeds the fleet when its lists are unusable.

The round-2 checks still pass (`badref.js`).

### R4-03 Retention and money (Medium)

**What's wrong.**
- A wallet's balance is computed from its transactions plus charging sessions. `applyRetention` (round 3) deleted sessions but not the wallet's top-ups, so every removed charge was credited back.
- Ghana's tax law expects business records to be kept for years, but the floor was 30 days.

**Fix.**
- **Carry-forward.** Before pruning, each wallet's removed transactions and sessions are carried forward as one `carry` amount, shown as "Balance brought forward" (`carry` and `carryAt` are sanitised numbers).
- **Floor and limits.** `RET_LIMITS.sessions` is 2190–3650 days, with a comment citing Act 915 and Act 843. Values saved under the old limits move into range. The seed default is 2190.
- **Admin field.** It says why.
- **Driver's delete screen.** It now says "6 years, as tax law requires".
- **Minimisation.** The records stay pseudonymous; erasure removes the rest.

### R4-04 Erasure reaches every copy (Medium, privacy)

**Server.** `delete_my_account` now removes the person's address from `org_invites` and from `audit_log` details. The "invited" and "joined by invite" events stay, without the address.

**App.** Before deleting the account or leaving, and after removing someone, `scrubMember` takes the person's copy out of the team workspace:
- erasure: name, email and phone;
- leaving or removal: email and phone. The name stays, so the team can still read who did what.

It then waits up to 5 s for the write. While leaving, a workspace arriving from another device doesn't put the details back. If the server refuses (offline, second factor needed), they are restored.

### R4-05 to R4-08 (Low)

- **R4-05.** `https()` is declared before the cache is read. Cached entries are rebuilt with checked links, and prototype keys are skipped.
- **R4-06.** Connect prices: 0–1000, non-empty, finite, rounded to cents. A refused value is restored on screen.
- **R4-07.** `.map-note a` is underlined.
- **R4-08.**
  - Maintenance cost: 0–10,000,000, two decimals; type and notes capped.
  - Add and edit vehicle: model and depot must be from the lists; model year 2010–2030.
  - `fleet.assign` and `m-assign` ignore a driver who no longer exists.

## 4. Other areas reviewed, no change needed

- **`js/ui.js`.** Every `C.*` helper that takes text escapes it (`badge`, `stat` label, `empty`, `seg`, charts, `donut`, `legend`, `field`, `input`, `select`, dialogs). `card` and `table` take HTML from callers by design; the stored-XSS probe (407 fields, 5 roles) stays clean. Dialog focus trap and Escape behave as fixed in round 2.
- **`js/app.js` routing and boot.**
  - Role-gated routing logs `access-denied`.
  - The frame guard stops boot.
  - Demo accounts work only in demo mode.
  - The service worker registers only top-level.
- **`js/auth.js`.**
  - Password reset (`PASSWORD_RECOVERY` → `recover`), magic link, the `mfa-email` screen and URL error handling are fine.
  - The session lives in supabase-js storage (`voltfleet-os:auth`), which sign-out removes. Sign-out now also clears device keys (R4-01).
  - No Cache Storage or IndexedDB holds personal data: the service worker caches only same-origin shell files.
- **Photos.**
  - The 14 bundled car photos carry no EXIF or GPS metadata (checked with Pillow).
  - The app has no photo upload, so there's no user-photo EXIF risk.
  - The Wikipedia fallback sends only model names.
- **`js/map.js` (R3-14).**
  - OSRM is used only for simulated trips. Smartcar vehicles get `trip: null`, so their position is never sent for routing.
  - Map tiles for a real vehicle's page do reveal the area around the car to the tile provider. That is still R3-14, a hosting decision: a self-hosted tile server, or a lower zoom for real vehicles.
- **`js/install.js`, `js/motion.js`.** No issues. The QR code encodes only the app URL; the vendored generator is loaded on demand from the same site.
- **Money.** Top-ups use fixed amounts and wallets from lists. Rescue is guarded (R3-03). Balances can go negative because bookings don't check the balance, but payments are simulated: review item H applies before going live.
- **Round-3 code.**
  - `connect.js` secret handling: one-time display, `getRandomValues`, nothing stored.
  - `ops.js` CSV parsing.
  - `cloud.js` heads path: probe once, fall back only on "relation does not exist", no self-download.
  - The 20261117 migrations: every SECURITY DEFINER function sets `search_path` to `''`; grants are revoked from `public`/`anon` and internal helpers from `authenticated`.
  - `create_organization` takes a transaction advisory lock.
  - `record_event`'s 200-an-hour count isn't locked, so parallel requests can slip a few past it. Harmless.

## 5. Changed files

- **App:**
  - `js/core.js` (`repairState`, retention default, `NUM_KEYS`);
  - `js/admin.js` (retention floor, carry-forward);
  - `js/driver-plus.js`, `js/driver.js`;
  - `js/photos.js`;
  - `js/connect.js`;
  - `js/manager.js`, `js/fleet.js`;
  - `js/smartcar.js`, `js/ocpp.js`;
  - `js/auth.js` (sign-out, `scrubMember`, CAPTCHA);
  - `js/app.js` (`VF.authReady`, CAPTCHA mount);
  - `js/cloud.js` (`cloud.flush`);
  - `js/config.js` (`VOLTFLEET_CAPTCHA`, empty);
  - `styles.css`;
  - `sw.js` (`voltfleet-os-v24`).
- **No new shell files.**
- **Server:** `supabase/migrations/20261119_retention.sql`, `supabase/functions/ocpp/index.ts`, `supabase/functions/smartcar/index.ts`.
- **Hosting:** `netlify.toml`.
- **Docs:** this file, `docs/security-review.md`, `docs/accounts.md`.

## 6. Test results

All runs use Chromium/Playwright against `python3 -m http.server 8080` (working tree), with external hosts aborted. Runner: `qa4/run-all.sh` (`OUT=qa4/final`). The baseline on the committed code is in `qa4/base/`.

| Suite | Result |
| --- | --- |
| `qa4/r4-app.js` (R4-01, R4-03 to R4-08, CAPTCHA off and on, demo and signed-in) | 25/25, no page errors. Committed code: 10 of the first 11 fail (`r4-app.orig.out`). |
| `qa4/badref4.js` (R4-02) | 0 pages broken (committed: 28, plus a simulation crash) |
| `qa4/signout-probe.js` (R4-01) | PASS (committed: FAIL, key, location and car left; no disconnect) |
| `qa4/sql/run-sql.sh` (local Postgres 16) | All 14 migrations applied twice on fresh databases, plus 2 extra re-runs of the new file. `test_r4.sql` as expected: retention periods, masking, throttle, trigger (survives a failing purge), invitations, orphan trust rows, erasure of addresses, grants. Round-2 and round-3 SQL output identical. |
| Edge Functions | esbuild parse 5/5; `fn-test-ocpp` 28/28; `fn-test-smartcar` (r3) 29/29; (r2) 22/22 |
| `t20.js` / `t20-legacy.js` / `t20-r3.js` | 27/27 / 27/27 / 35/35 |
| `sync-cas` cas / legacy | 10/10 / 9/9 |
| `heads.js` / `patch-unit.js` | 4/4 / 10/10 |
| `qa4/r3-app.js` (round 3's checks; retention case moved past the 6-year floor; OCPP owner synced before injecting test data) | 25/25 |
| `xss.js` / `csp.js` | clean in 5 roles / no violations |
| `qa1/a11y.js` / `qa3/a11y-r3.js` (axe) | no violations (the baseline's R4-07 violation is gone) / none |
| `frame`, `spoof`, `acct-enter`, `cssinj`, `mobile`, `signin-to-org`, `demo-to-org`, `removed-member` (3/3), `badref` | fixed behaviour holds |
| `qa3/swcache.js` | 45 entries, cache `voltfleet-os-v24`, offline shell served, no query URLs |
| `t17` / `t18` / `t19` / `t21` | 26/26 / 23 + the known "low-data: no photos" / 11 + the known flaky "rescue completes" / 11 + the known "m-fleet" |
| `t1` / `t3` / `t15` shots | only blocked external images logged |
| `sanit.js` | the known stale CSV regex FAIL only |

## 7. Left open

- **R1-06 read-only role, R1-09 follower bandwidth, R1-08 per-IP limits.** These need per-record tables or a server-side simulation. Unchanged since round 3.
- **`p_expected` required.** After 1 December (see section 2).
- **CAPTCHA switch-on.** A product decision, plus a site key and the CSP edit.
- **OCPP network key on a shared device.** Scoped, not wiped (R4-01). Fix with a server "reissue key to its creator" action.
- **R3-14.** Tiles and OSRM hosting.
- **R4-09.** Verify the GoTrue enrolment rule once.
- **R4-10.** Keyed hashes for sign-up counters.
- **pg_cron.** Enable it if a daily run is wanted regardless of traffic.
- **Retention periods.** Have counsel confirm them (security review item I). The live `amr` check from round 3 is still to do.
- **Review items C to I.** Unchanged.
