# VoltFleet OS QA and security relay, round 3: verification, fixes and fresh assessment

17 November 2026. Agent 3 of 3. Nothing was committed, pushed or deployed. The live Supabase project was only read: catalog queries, function definitions, Edge Function sources and the security advisor. No DDL or DML.

## Migrations to apply

Apply in this order. Each file is safe to re-run, and each was applied twice to a local Postgres 16 that stands in for the Supabase pieces it uses (`auth.users`, `auth.mfa_factors`, `auth.uid()`, `auth.jwt()`, roles, the `supabase_realtime` publication). The whole repo chain (rounds 1 to 3) was also rebuilt from scratch, twice over, and the round-2 SQL tests give the same results on top of it as without it.

1. `supabase/migrations/20261117_signup_limits.sql`: per-person sign-up limits (R1-08).
   - Adds `private.signup_events` (one-way hashes of the account, mailbox and domain, kept 48 hours) and the internal helpers `private.mailbox_of`, `private.public_mail_domain` and `private.h`.
   - Replaces `create_organization` and `admin_overview` (which now also reports `signups_1h` and `signup_ceiling`).
2. `supabase/migrations/20261117_mfa_trust.sql`: an authenticator only counts once confirmed by email (R1-17).
   - Adds `public.mfa_trusted_factors` (RLS on, no grants). On its first run it trusts every factor already verified, so nobody is locked out. Re-running it trusts nothing new.
   - Adds `email_proof_at()`, `untrusted_factors(uuid)` (internal) and `trust_my_factor(uuid default null)`.
   - Replaces `mfa_ok()`, so every RLS policy and `require_mfa()` call that uses it now requires trusted factors.
   - Replaces `my_account()`, which adds `mfa_trust: {untrusted, email_proof}`.
3. `supabase/migrations/20261117_audit_events.sql`: `record_event(text, text, text)`, an append-only way for members to write security events to `public.audit_log` (R2-07). Adds the index `audit_actor_idx`.
4. `supabase/migrations/20261117_world_heads.sql`: small `world_heads` and `org_world_heads` tables, kept in step by triggers on `worlds` and `org_worlds`, with RLS that mirrors the source tables, added to `supabase_realtime` (R1-09). `worlds` and `org_worlds` stay in the publication for cached app versions.
5. `supabase/migrations/20261117_edge_limits.sql`: nullable `created_by` columns and indexes on `private.ocpp_networks` and `private.smartcar_states`, for the Edge Functions' per-person limits (R1-08).

**Before applying migration 2, check one thing on the live project.** The rule reads the session JWT's `amr` claim. Any sign-in method except `password` counts as proof of the email address; `totp`, `token_refresh`, `anonymous`, `web3` and `mfa/*` don't count either. This is a deny-list on purpose: if the confirmation-link method has an unexpected name, it still counts.
- To check, create one test staff account and open its confirmation link.
- Then check that `select public.my_account()->'mfa_trust'` shows `"email_proof": true` while that session is fresh.
- The live project has 0 users today, so grandfathering affects nobody.

**Order with the web app and functions.** Each piece works with the others old or new:

| Combination | What happens |
| --- | --- |
| New app, old database | Heads tables missing: the app streams the full row as before. `trust_my_factor` and `record_event` missing: ignored, and the email step isn't shown (the app only shows it when `my_account` reports `mfa_trust`). Tested: `t20.js` (round-2 server rules, what is live today) 27/27, `t20-legacy.js` 27/27. |
| Old cached app, new database | Everything works except one case. A staff member enrolling their first authenticator in a cached old version can't confirm it, so they see the enrolment screen again until the page reloads (the service worker fetches the new code first). The live project has no staff accounts yet. |
| New Edge Functions, old database | The functions detect the missing `created_by` column and use the old global limits. Tested in both function test files. |
| New database, old Edge Functions | The new columns are nullable and unused. |

## Edge Functions to redeploy

- **`ocpp`** (`server.ts`, `csms.ts`, `index.ts`):
  - per-person `createNetwork` limits (R1-08);
  - per-connection message limits and connector bounds (R3-10);
  - `logLimit` clamped;
  - unknown charger IDs answer like wrong passwords;
  - malformed IDs no longer cause a 500;
  - optional `OCPP_ALLOW_QUERY_KEY=false` secret (item D). Leave it unset while the in-app simulator is used: browsers can only send the password in `?key=`.
  - Tests: `qa3/fn-test-ocpp.mts`, 28/28.
- **`smartcar`** (`handler.ts`, `index.ts`): per-person `start` limits (R1-08).
  - Tests: `qa3/fn-test-smartcar.mts`, 29/29 (the 22 round-2 checks plus 7 new); `qa2/fn-test-smartcar.mts`, 22/22.
- Both functions read the caller's session from `Authorization: Bearer`. They confirm it with the project's own Auth server (`SUPABASE_URL/auth/v1/user`, using `SUPABASE_ANON_KEY`, which Supabase sets by default) and only for `createNetwork` and `start`. A missing, expired or forged token, or the publishable key, counts as anonymous. No new secrets are needed.

---

## 1. Did the round-2 fixes hold?

Yes. Nothing regressed.

- **Live database matches the repo.** The `md5(pg_get_functiondef)` of all 26 public functions was compared with a database rebuilt from the repo files.
  - 23 are identical.
  - `complete_signup`, `delete_my_account` and `world_tick` differ only in comments, which the migration tool stripped. Their code was read and is the same.
  - Grants are as intended: `anon` can execute only `world_push`, `world_tick` and `mfa_ok`.
  - `org_invites` has `expires_at` and `declined_at`.
  - RLS is on for all six public tables.
- **R1-02 is fixed live.** The demo world is no longer frozen: rev 4307, written and leased at 17:05 UTC on 17 November. On 16 November, `updated_at` had been 5 days old while the lease kept renewing.
- **`smartcar` deployed code matches `handler.ts`** in the repo, including the fail-closed `link` check (version 2). `ocpp` (version 1) matches the repo as it was before this round.
- **Security advisor:** only the expected "SECURITY DEFINER callable" warnings.
- **Baseline suite.** `qa3/run-all.sh` on the code as committed (`qa3/base/`) matched round 2's final run:
  - t20 27/27, t20-legacy 27/27;
  - sync-cas 10/10; sync-legacy 7/9 (the expected simultaneous-edit race on the old server);
  - xss clean, csp clean, axe clean;
  - t17 26/26, t18 23/1 (known), t19 11/1 (known), t21 11/1 (known), t3 35, t15 15;
  - all qa1 and qa2 single checks behave as fixed.

---

## 2. Earlier findings

| ID | Sev. | Status after round 3 | What changed this round | Proof (scripts in `scratchpad/qa3/`) |
| --- | --- | --- | --- | --- |
| R1-01 Sign-in overwrites the org workspace | Critical | **Fixed** (round 2), holds | — | `signin`, `demo2org`: org row keeps `Airport City Hub` |
| R1-02 Device ahead never syncs; freeze | High | **Fixed**, live too | Live demo verified unfrozen | live query above; `sync-cas` |
| R1-03 Lost updates | High | **Fixed** (CAS live) | — | `sync-cas` 10/10 |
| R1-04 Invite squatting | High | **Fixed**, live | — | `t20`, `test_invites.sql` |
| R1-05 Clickjacking guard dead | Medium | **Fixed** | Plus `frame-ancestors 'none'` in `netlify.toml` if hosted there | `frame` |
| R1-06 No owner | Medium | **Partly fixed** (owner done) | Read-only role **not done**, on purpose: see "Left open" | — |
| R1-07 Throttle gaps | Medium | **Fixed**, live | — | `test_sync.sql` |
| R1-08 Global rate limits | Medium | **Fixed in part** (needs migrations 1 and 5 and both functions) | See "R1-08 in detail" | `test_r3.sql`, `fn-test-ocpp.mts`, `fn-test-smartcar.mts` |
| R1-09 Sync bandwidth | Medium | **Partly fixed** (needs migration 4) | The writer no longer downloads its own writes | `heads.js` |
| R1-10 Smartcar `link` trusts `user_id` | Medium | **Fixed, fail-closed** (deployed) | — | `fn` 22/22 |
| R1-11 WCAG AA | Medium | **Fixed** | New screens checked too | `a11y`, `a11y-r3` |
| R1-12 CSS injection | Low | **Fixed** | — | `cssinj` |
| R1-13 Dialog focus | Low | **Fixed** | — | `mobile` |
| R1-14 Enter in wrong field | Low | **Fixed** | — | `acct` |
| R1-15 Sign-in page spoofing | Low | **Fixed** | — | `spoof` |
| R1-16 SW caches one-time URLs | Low | **Fixed** | Cache now `voltfleet-os-v23` | `swcache` |
| R1-17 2FA gaps | Low | **Fixed** (needs migration 2) | See "R1-17 in detail" | `t20-r3.js`, `test_r3.sql` |
| R2-01 to R2-06 | — | **Fixed**, hold | — | `badref`, `removed`, `sc-redirect`, `sync-cas`, `t18` |
| R2-07 Shared-snapshot audit trail and secrets | Info | **Fixed** for what can be (needs migration 3) | See "R2-07 in detail" | `t20-r3.js`, `r3-app.js` |
| R2-08 Extra files published | Info | **Resolved** (Pages publishes only app files) | `netlify.toml` now does the same | — |
| Review C, E, F, G | — | Open | D: setting added. G: headers in `netlify.toml` if hosted there | — |

### R1-08 in detail

**Sign-ups (`create_organization`).** One global counter is replaced by four limits, so one person can no longer block everyone:

| Limit | Value |
| --- | --- |
| Per account | 3 organisations a day (create, leave, create again) |
| Per mailbox | 3 an hour. `ama+1@gmail.com`, `a.m.a@googlemail.com` and `ama@gmail.com` count as one mailbox. |
| Per company email domain | 30 an hour. Public webmail domains (gmail.com and similar) are exempt: the mailbox rule covers them. |
| Global circuit breaker | 300 an hour |

- The counters keep only SHA-256 hashes, for 48 hours. They survive account deletion, so "sign up, create, delete, repeat" still counts.
- A transaction-scoped advisory lock stops two parallel requests from both slipping under a limit.
- Admins see `signups_1h` against the ceiling under Account & team.

**Proof.** `test_r3.sql`:
- the 4th plus-address variant is refused, and so is the Gmail dot variant;
- another Gmail user still gets in;
- a catch-all domain gets 30 organisations, then refused;
- the same account's 4th organisation in a day is refused;
- no plain address is stored.

**OCPP `createNetwork` and Smartcar `start`.**
- Signed-in people have their own allowance: 5 networks a day, and 20 pending connections an hour.
- Anonymous requests (the public demo) share a separate pool: 20 networks an hour, and 300 connections an hour.
- Global ceilings stay as circuit breakers: 200 networks an hour, and 1000 connections an hour.
- So an anonymous script can still use up the anonymous pool, but it can no longer lock out signed-in customers.
- The app sends the session only for these two actions, and only in account mode. The demo stays anonymous.

**Proof.** The function tests show:
- anonymous pool full, then refused with a sign-in hint;
- the publishable key and forged tokens count as anonymous;
- a signed-in user still succeeds;
- the per-user cap holds;
- the pool frees up after an hour;
- the legacy fallback works before migration 5.

**Not done, needs a decision:**
- **CAPTCHA.** Supabase Auth's CAPTCHA (Turnstile or hCaptcha) on sign-up and on the anonymous Edge Function actions. This is a dashboard setting plus a site key in the app.
- **Per-IP limits.** Still not used: the client address isn't trustworthy at the function (see round 2).
- **Push rates.** `world_push` and `org_world_push` still allow about 10 writes a second (the round-2 throttle). That stays as it is until per-record tables replace the snapshot.

### R1-17 in detail

**How trust works.** A staff session passes `mfa_ok()` only when every verified authenticator on the account is in `mfa_trusted_factors`. `trust_my_factor` adds one, and only:
- (a) from a session that proved the email address in the last 60 minutes (an emailed sign-in link, the sign-up confirmation link, a reset link, SSO); or
- (b) from an `aal2` session while every other verified factor is already trusted, which covers adding a backup device.

**The app flow.**
- A staff member signing in with only a password and no authenticator sees "Confirm it's you": the app emails a one-time sign-in link, and the QR code appears after the link is opened in the same browser.
- Someone who arrives from the confirmation link enrols directly.
- After verifying a new authenticator, the app calls `trust_my_factor`.
- An unconfirmed authenticator gets a "Confirm your authenticator" screen.

**The attack it stops.** Someone who knows the password enrols and verifies a factor from the browser console, bypassing the UI. They now reach `aal2`, but:
- `my_account` says `mfa_required`;
- the workspace read returns nothing;
- `trust_my_factor` refuses;
- `invite_member` refuses.

**The "last device" rule.** It no longer matters for security. Setting up a new authenticator after removing the last one needs the email step. `docs/accounts.md` is updated, including the lost-phone procedure.

**What it can't prevent.** An attacker with the password can enrol a factor on a brand-new staff account before its owner does. That locks the owner out of the workspace, not in. They then need support (the same SQL reset), and the docs say so.

**Proof.**
- `t20-r3.js`, 35/35:
  - password-only sign-in: no QR code;
  - the console-enrolled factor gets no data, can't be trusted and can't invite;
  - after a support reset: email link, then enrol, then the workspace;
  - the backup device is trusted without email;
  - the invited colleague's confirmation-link session enrols directly.
- `test_r3.sql`:
  - stale (2-hour-old) proof refused;
  - `aal1` refused;
  - fresh link plus `aal2` accepted;
  - backup device trusted through rule (b);
  - someone else's factor refused;
  - drivers unaffected;
  - grandfathering only on the first run.

### R1-09 in detail

**Done (migration 4 plus `js/cloud.js`).**
- The app subscribes to `world_heads` / `org_world_heads` (revision, lease holder, time) instead of the row with `state_gz`.
- It downloads the snapshot only when the revision is newer than the one it holds.
- It falls back to the full row when the table doesn't exist. It probes once per start, and only "relation does not exist" errors switch it to the fallback.

**Proof.** `heads.js`, two demo tabs for 30 s:
- the leader's downloads went from 386 kB to 32 kB in the final run (453 to 32 kB in an earlier run). It no longer receives its own writes;
- the follower's are unchanged (386 to 414 kB);
- sync stays correct in both modes, with no page errors.

**Not done.** A follower still downloads every simulation step (about 140 kB every 2 s on the demo) because it renders each one. That needs the simulation on the server, or per-record tables. Both are architecture work. A heads table alone can't save those bytes.

### R2-07 in detail

**Audit trail.**
- In a team workspace, each security event the app records also goes to `record_event`: revealing personal data, exports, consent changes, erasure, retention changes, secret rotation, webhooks, Connect grants and revocations, remote commands, booking cancellations, access denials.
- The server fills in the actor, the organisation and the time.
- It accepts only known event names, caps the detail at 300 characters a field, and allows 200 events per person per hour.
- Members can read `audit_log` but have no write grant: direct `insert`, `update` and `delete` all fail (`test_r3.sql`).
- The in-app trail stays in the snapshot, for display.

**Developer secrets.**
- App client secrets and webhook signing secrets are no longer kept in the shared snapshot.
- New ones come from `crypto.getRandomValues` (24 bytes), are shown once in that tab with a copy button, and are forgotten on leaving the page.
- The snapshot keeps `secretTail` (the last 4 characters) and a masked value.
- Existing worlds are scrubbed on load. The masked value keeps the field's shape, so cached app versions don't break.
- "Reveal" is gone.

**Proof.** `r3-app.js`, plus `repro-orig.js`: 4 plaintext secrets in the committed code, 0 now.

**Remaining.** What an event *says* is still what the browser reported. When Connect becomes a real API, secrets must be issued and stored (hashed) on the server.

---

## 3. New findings (round 3)

| ID | Title | Severity | Status |
| --- | --- | --- | --- |
| R3-01 | Connect API keeps serving a driver's vehicle data after they switch vehicle data off or delete their account | Medium (privacy) | Fixed |
| R3-02 | Developer app and webhook secrets are predictable and stored in plaintext in the shared snapshot | Medium | Fixed |
| R3-03 | Roadside rescue: a second tap charges the fee again; a finished rescue can be "cancelled" for a refund | Low (money) | Fixed |
| R3-04 | Erasure and "download my data" are incomplete; withdrawing "share arrival time" leaves shared arrival times | Medium (privacy) | Fixed |
| R3-05 | Retention periods are shown in the admin console but never applied | Medium (privacy) | Fixed |
| R3-06 | CSV job import breaks on quoted commas, Excel's BOM and semicolon files; keeps formula prefixes | Low | Fixed |
| R3-07 | Quiet hours that don't cross midnight never release queued messages | Low | Fixed |
| R3-08 | Emptying a numeric field saves 0: free charging, 0-day retention; settings unbounded | Medium (integrity) | Fixed |
| R3-09 | V2G floor and service booking accept any value; a bad floor turns vehicles' charge into NaN | Low | Fixed |
| R3-10 | OCPP function: one charger connection can flood the database; unbounded connector ids; 500s on bad input; charger IDs can be listed | Medium (DoS) | Fixed (redeploy `ocpp`) |
| R3-11 | OCPP message log shows full card numbers, although the page says they are masked | Low (privacy) | Fixed |
| R3-12 | Google Fonts receives every visitor's IP address; CSP allows `ws://localhost:8788` | Low (privacy) | Fixed |
| R3-13 | Fault-report privacy text is wrong; the outage risk bar has no accessible name | Low | Fixed |
| R3-14 | Route geometry goes to the public OSRM demo server; map tiles reveal the area viewed | Info (privacy) | Open: hosting decision |
| R3-15 | No retention on OCPP transactions (card numbers), the OCPP command history and the Smartcar cache (vehicle location) | Low (privacy) | Open: retention periods are a product and legal decision |
| R3-16 | `netlify.toml` would publish the whole repository, without security headers | Low | Fixed |
| R3-17 | One unreachable precache file left the whole app without offline support | Low | Fixed |
| R3-18 | Developer console accepted `http://` and `#fragment` OAuth redirect URIs | Low | Fixed |

The evidence for most new findings comes from `qa3/repro-orig.js`. It runs the same checks against the committed code (served unchanged from `git archive HEAD` on port 8082) and against the working tree.

| Check | Committed | Now |
| --- | --- | --- |
| Connect API after "vehicle data off" | 200 | 403 |
| Connect API after erasure | 200 | 401 |
| Plaintext secrets in snapshot | 4 | 0 |
| Rescue fees for two taps | 300 | 150 |
| Fee kept after "cancelling" a finished rescue | 0 | 150 |
| Live Connect grants after erasure | 1 | 0 |
| Wallet number after erasure | `020 *** 6473` | `—` |
| Alert preferences after erasure | kept | gone |
| Quiet-hours message at 16:00 | `queued` | `simulated` |
| Retention after emptying the field | 0 | 730 |
| `applyRetention` | missing | function |
| Operator price after emptying the field | 0 | 0.45 |

### R3-01 Connect ignores the driver's choices (Medium, privacy)

**What's wrong.**
- A driver can switch vehicle data off ("Disconnect vehicle") or delete their account.
- The Connect API (`js/connect.js` `callApi`, `backgroundCall`, `emitForDriver`) only checked `grant.revoked`. So third-party apps kept getting battery, odometer and location for that vehicle, and webhooks kept firing.
- Erasure (`VF.eraseDriver`) never revoked the grants.
- This contradicts the consent screen and the "delete my account" promise. Under Act 843, the data subject's withdrawal of consent and erasure must reach processors too.

**Fix.**
- A grant is live only while the driver exists, isn't deleted, and has vehicle data on.
- Paused grants answer `403 VEHICLE_DATA_PAUSED`.
- Erased drivers' grants are revoked, and answer `401 ACCESS_REVOKED`.
- Each app gets `vehicle.disconnected` with `reason: account_deleted, delete_data_within_days: 30`.
- Background calls and webhooks skip paused grants.

### R3-02 Predictable, shared Connect secrets (Medium)

**What's wrong.** The seeded client secrets were `vfs_` plus `VF.hash(appId + 's1')`, which can be computed by anyone. Webhook secrets were `hash(url)`. Rotation used `Math.random`. All of them lived in the shared snapshot: readable and replaceable by every workspace member, and by everyone in the demo.

**Fix.** See "R2-07 in detail".

### R3-03 Rescue charged twice; refund after completion (Low)

**What's wrong.**
- `d-rescue` had no guard against an active rescue. A second tap (two tabs, or a double click on a slow phone) sent another van and debited another GHS 150. The first fee stayed, and cancelling refunded only the second.
- `d-rescue-cancel` refunded a rescue that had already been completed.

**Fix.**
- One active rescue at a time, re-checked after the confirmation dialog.
- Rescue is only available when the car is stranded or below 10%.
- A finished rescue can't be cancelled.

### R3-04 Incomplete erasure and data export (Medium, privacy)

**What's wrong.**
- **Erasure.** It cleared the profile, consents and vehicle identifiers, but left:
  - the wallet's payment method (network and masked phone number);
  - alert preferences (channel and language);
  - the rescue record (with its location-sharing state);
  - the pre-cool schedule;
  - Connect grants (R3-01).
- **"Download my data".** It omitted the same data, plus notifications and connected apps. Act 843 gives the data subject a right to their personal data and to its deletion; the copy and the erasure must both be complete.
- **Arrival times.** Withdrawing "share arrival time" left the arrival times already shared with stations.

**Fix.**
- Erasure also removes the wallet method (amounts and references stay as pseudonymous billing records, like charging sessions), alert preferences, the rescue record and the pre-cool schedule. It resets shared arrival times to the booked slot and drops the driver's open data requests.
- The export adds `wallet`, `alertPreferences`, `roadsideRescue`, `cabinPreCool`, `connectedApps` and `notifications`.
- Withdrawing ETA consent resets that driver's shared arrival times to the slot.

### R3-05 Retention not applied (Medium, privacy)

**What's wrong.**
- **Settings never applied.** Admin → Privacy offers retention periods (billing records 730 days, live arrival times 1 day, audit log 7 years), and the driver's delete screen promises billing records are deleted after them. Nothing applied them: Act 843's retention principle was a label.
- **Emptied field saves 0.** Clearing a field saved `0` (`Number('')`). Once retention is applied, that would delete every billing record.

**Fix.**
- `VF.applyRetention` runs hourly (simulated time) on the leading device. It removes:
  - sessions past their period;
  - audit entries past theirs;
  - live arrival times of past bookings (reduced to the booked slot).
- The inputs only accept whole days within legal and practical bounds (sessions 30–3650, arrival times 0–30, audit 365–3650, grace 0–90).

**Remaining (R3-15).** Server-side data has no retention yet: OCPP transactions, commands, the Smartcar cache and `audit_log`.

### R3-06 CSV job import (Low)

**What's wrong.** `O.parseJobs` split on commas.
- A quoted client name like `"Makola, wholesale"` shifted every column, so the row was dropped or got the wrong place.
- Excel's UTF-8 BOM made the header check fail ("Use the columns…").
- Semicolon exports (French/European Excel) didn't work.
- Fractional hours were accepted.
- Names kept formula prefixes (`=HYPERLINK(...)`), which matter if they are exported again.

**Fix.**
- An RFC 4180 reader: quotes, escaped quotes and line breaks inside fields; BOM ignored; separator auto-detected.
- Whole hours only.
- Names and refs lose control characters, angle brackets, quotes and leading `= + - @`.
- Pastes over 200 kB are refused.

### R3-07 Quiet hours never ending (Low)

**What's wrong.** The release hook tested `to <= hour < from`. That is never true for a window that doesn't cross midnight (for example 13:00–15:00), so queued SMS and WhatsApp messages stayed queued for ever. The label also printed `13:00–015:00`.

**Fix.** One `inQuiet` rule decides both queuing and release. The label is padded properly.

### R3-08 Empty numeric fields save 0 (Medium, integrity)

**What's wrong.**
- **Operator pricing.** Clearing a price field saved 0 (`Number('')` is 0, and the check was only `>= 0`). That made charging free at every site of that operator, and the change was audited as a normal pricing change.
- **Charger capacity.** `1e400` saved `Infinity`, which becomes `null` in the snapshot.
- **Admin settings.** `reserve`, `tz` and `currency` took any number or string, for example a 900 % reserve or currency `G$`.

**Fix.**
- Prices: 0–1000, non-empty, finite.
- Band names: 40 characters, cleaned.
- Charger capacity: 10–10,000 kW.
- Admin settings: reserve 5–30 %, time zone −12 to +14, currency a 3-letter code.
- A refused value is restored on screen.

### R3-09 V2G floor and service booking (Low)

- `i-v2g-floor` stored `+el.value` unchecked. During a grid event, `Math.max(floor, …)` with `NaN` set vehicles' charge to `NaN`, which breaks every page that shows it.
  - Fix: the floor accepts only the offered values and is clamped (30–90 %) when the config loads.
- Service booking now:
  - checks that the day is one of those offered;
  - limits the estimate to 0–1,000,000;
  - cleans notes and caps them at 200 characters.

### R3-10 OCPP Edge Function abuse (Medium, DoS)

**What's wrong.** Anyone can create a network and charger without signing in, and then holds a valid charger password.
- **Writes per message.** Every message did one `updateChargePoint` (last-seen) plus two log inserts.
- **No message limit.** There was no limit per connection, so one connection could write as fast as it could send.
- **Unbounded connector IDs.** `StatusNotification` and `MeterValues` accepted any connector ID, so a client could create unlimited `ocpp_connectors` rows.
- **Bad input gave 500s.** A negative `logLimit` gave a 500 from Postgres, and so did a malformed `%`-escape in the charger ID.
- **Listable IDs.** Unknown charger IDs answered 404 and known ones 401, so IDs could be listed.

**Fix.**
- **Token bucket.** 60 messages burst, 10 a second. Over the limit, calls get `CALLERROR "Too many messages; slow down"` with no database writes; after 200 refused messages in a row, the socket closes with 1008.
- **Message size and IDs.** Messages over 64 kB and message IDs over 36 characters are ignored.
- **Connector bounds.** 0–50 (1–50 for `StartTransaction`).
- **Last-seen.** Written at most every 5 s.
- **Log limit.** `logLimit` clamped to whole numbers from 1 to 200.
- **One answer.** Unknown IDs and wrong passwords give the same 401; a malformed ID is a 401 too.
- **Network names.** Lose control characters and angle brackets.

**Proof.** `fn-test-ocpp.mts`: a flood of 200 messages gives 55 processed and 145 refused without writes, then a disconnect; a normal connection is unaffected.

### R3-11 Card numbers in the OCPP log (Low, privacy)

**What's wrong.** The Real chargers page masks card numbers (`04•••E5`) in sessions and in the card list. The raw message log printed the full JSON (`Authorize {"idTag":"04A1B2C3D4E5"}`, and `RemoteStartTransaction` too).

**Fix.** `idTag` and `parentIdTag` are masked at any depth before display. The 180-character cut now happens before escaping (it used to be able to split an HTML entity).

### R3-12 Third-party font requests (Low, privacy)

**What's wrong.** Every page load fetched CSS and fonts from Google, which tells Google the visitor's IP address and the page (Referer). That is an avoidable transfer of personal data to a third party. Data minimisation and transfer rules under Act 843 favour not doing it.

**Fix.** Geist and Geist Mono (SIL Open Font License, Latin and Latin Extended, about 84 kB) now ship in `fonts/` with the license. They are precached by the service worker and published by `pages.yml`. The CSP drops `fonts.googleapis.com`, `fonts.gstatic.com` and the unused `ws://localhost:8788`.

### R3-13 Copy and accessibility (Low)

- "The operator sees the issue and your booking code" was untrue: no booking code is sent. It now says what is actually sent (station, issue, the driver's note).
- The 8-hour outage risk bar is now `role="img"` with a summary label.
- `a11y-r3.js` (axe) found no violations on the new screens: "Confirm it's you", the one-time secret, the station sheet, light and dark.

### R3-14 Third parties that see locations (Info, privacy)

- **OSRM.** `js/map.js` sends route coordinates to the public OSRM demo server. Today these are simulated places only (real vehicles never get a route line), so no personal data goes there. With real telematics, run your own OSRM, or route on the server.
- **Map tiles.** Tile requests (CARTO by default) show which area a person is looking at.
- **Weather.** Open-Meteo gets only the fixed Accra coordinates.

No change was made. This is a hosting decision.

### R3-15 No retention on server data (Low, privacy)

- `private.ocpp_transactions` keeps card numbers (`id_tag`) indefinitely, and `ocpp_commands` keeps every command.
- `private.smartcar_cache` keeps the last location of disconnected vehicles until the last link of that user is removed.
- `public.audit_log` keeps everything.
- Only `ocpp_log` (7 days) and `smartcar_states` (1 day) are pruned.

The periods are a product and legal decision for Act 843. Suggested: 24 months for transactions, with `id_tag` masked after 90 days; commands 90 days; audit log 7 years. Once the periods are chosen, the purge can go in the functions' existing cleanup paths.

### R3-16 `netlify.toml` (Low)

**What's wrong.** It published `.` (the whole repository) with only a cache header.

**Fix.** It now builds the same allow-list `_site` as `pages.yml` and sends `frame-ancestors 'none'`, HSTS, `nosniff`, `Referrer-Policy` and `Permissions-Policy`. It is only used if the site moves to Netlify.

### R3-17 Service worker install is all-or-nothing (Low)

**What's wrong.** `cache.addAll(SHELL)` rejects as a unit. One file that can't be fetched (a dropped connection on a 2G phone during install, a blocked font) left the app with no offline cache at all. This showed up because the round-2 `swcache.js` blocks every URL containing "fonts", and the fonts are now local.

**Fix.** Each file is cached on its own; anything missed is cached on first use (network first).

**Proof.**
- `qa2/swcache.js`, with the fonts blocked: 41 entries, offline shell served.
- `qa3/swcache.js`, fonts allowed: 45 entries.

### R3-18 OAuth redirect URIs (Low)

**What's wrong.** `dev-redirect` accepted any `http(s)://` text. OAuth requires TLS redirect URIs, except loopback for development, and no fragment (RFC 6749 §3.1.2).

**Fix.** The URI is parsed: `https:` only (`http:` only for `localhost` and `127.0.0.1`), no `#`, at most 300 characters.

**Proof.** `r3-app.js`.

---

## 4. Other areas reviewed, no change needed

- **Service worker.** Apart from R3-17: network-first; same-origin GETs only; no query-string or navigation leaks (R1-16 holds); no personal data cached (the workspace lives in localStorage and is wiped at sign-out).
- **CSP.** `script-src 'self'`, no inline scripts. `style-src 'unsafe-inline'` remains, needed by `style=` attributes. R1-12's numeric coercion keeps those attributes safe.
- **MoMo wallet.** It never asks for a PIN, and amounts are taken from fixed lists. It is all simulated: review item H (signed webhooks, idempotent payouts, server-side amounts) still applies before going live.
- **Payouts.** `O.payHome` is idempotent per month and driver. The outbox masks phone numbers.
- **Intel.** Planner inputs are bounded (`num()` helpers). Weather comes from fixed coordinates.

## 5. Changed files

- **App:**
  - `js/auth.js` (email-confirmed authenticators, audit mirroring, session bearer helper);
  - `js/cloud.js` (heads);
  - `js/connect.js`;
  - `js/driver.js`, `js/driver-plus.js`;
  - `js/ops.js`, `js/manager-ops.js`;
  - `js/admin.js`;
  - `js/operator.js`;
  - `js/intel.js`, `js/manager-intel.js`;
  - `js/ocpp.js`, `js/smartcar.js`;
  - `index.html` (CSP, fonts), `styles.css` (`@font-face`), `fonts/` (new);
  - `sw.js` (`voltfleet-os-v23`, fonts precached, files cached one by one).
- **Server:** the five migrations, `supabase/functions/ocpp/*`, `supabase/functions/smartcar/*`.
- **Hosting:** `.github/workflows/pages.yml` (copies `fonts`), `netlify.toml`.
- **Docs:** `docs/accounts.md`, `docs/security-review.md`, this file.

## 6. Regression results

All runs: Chromium/Playwright against `python3 -m http.server 8080` (working tree), external hosts aborted. Full outputs are in `scratchpad/qa3/final/`; the baseline on the committed code is in `qa3/base/`. Runner: `qa3/run-all.sh` (`OUT=qa3/final`).

| Suite | Result |
| --- | --- |
| `t20.js` (sign-in, 2FA, invitations; round-2 server rules = live today) | 27/27, no page errors |
| `qa2/t20-legacy.js` (pre-round-2 rules) | 27/27 |
| `qa3/t20-r3.js` (round-3 server rules: email-confirmed authenticators, audit events) | 35/35, no page errors |
| `qa2/sync-cas.js cas` / `legacy` | 10/10 / 9/9 |
| `qa3/heads.js` (R1-09) | 4/4. Leader 386 kB to 32 kB; sync correct with and without the head tables |
| `qa2/patch-unit.js` | 10/10 |
| `qa3/r3-app.js` (R3-01 to R3-13, R3-18 in the demo) | 25/25, no page errors |
| `qa3/repro-orig.js` | Before/after table in section 3 (committed code on port 8082, working tree on 8080) |
| `qa3/fn-test-ocpp.mts` | 28/28 |
| `qa3/fn-test-smartcar.mts` / `qa2/fn-test-smartcar.mts` | 29/29 / 22/22 |
| `qa3/sql/run-sql.sh` (local Postgres 16) | All 13 migrations applied twice on fresh databases. Round-2 `test_sync.sql` and `test_invites.sql` give identical output with and without round 3. `test_r3.sql` as described. Grandfathering only on the first run. |
| `xss.js` | Clean in all five roles (407–408 planted fields, 48 pages) |
| `csp.js` | No CSP violations (with the tightened policy) |
| `qa1/a11y.js` / `qa3/a11y-r3.js` (axe, WCAG 2 A/AA, light and dark) | No violations / none on the new screens |
| `qa1/frame.js`, `qa1/spoof.js`, `qa1/acct-enter.js`, `qa1/cssinj.js`, `qa1/mobile.js` | Fixed behaviour holds; no overflow at 393 px |
| `qa2/swcache.js` / `qa3/swcache.js` | No query URLs cached; offline shell served (41 / 45 entries, cache `voltfleet-os-v23`) |
| `qa2/signin-to-org.js`, `qa2/demo-to-org.js`, `qa2/removed-member.js` (3/3), `qa2/badref.js` | Org row keeps `Airport City Hub`; removed member wiped; 0 page errors in all roles |
| `t17.js` | 26/26 |
| `t18.js` | 23 PASS, 1 FAIL: the known "low-data mode: no photos" |
| `t19.js` | 12/12. The known flaky "rescue completes" passed this time |
| `t21.js` | 11 PASS, 1 FAIL: the known "m-fleet" (no photos by design) |
| `t3.js shots` / `t15.js shots` / `t1.js shots` | 35 / 15 / every manager page renders without overflow. Only blocked external images are logged. |
| `sanit.js` | Tampered state neutralised. The CSV check is the known false FAIL. |

Known expected failures (as briefed): t18 "low-data mode: no photos", t21 "m-fleet", the sanit.js CSV regex, and t19 "rescue completes" (passed this run).

**One test artifact, fixed.** In the full run, `qa2/swcache.js` first failed ("offline: app shell served: false"). It aborts every URL containing "fonts", which now includes the app's own font files, and `cache.addAll` failed as a unit. The service worker now caches files one by one (R3-17), and the re-run passes. `xss`, `csp`, `a11y`, `frame` and both `swcache` scripts were re-run after the last two edits (`sw.js`, the redirect check in `connect.js`); the results above are those re-runs.

## 7. Left open

- **R1-06 read-only role.**
  - Not done: it isn't clean today. Every member's browser runs the simulation and writes the whole workspace snapshot. On the server, a "viewer" would have to be refused by `org_world_push` and `org_world_tick`. Every page of five apps would then need its actions disabled, and the sync would need never to lead.
  - Until per-record tables exist, "read-only" would be a UI promise that a console call breaks. `docs/accounts.md` now says so.
  - The email to a removed member needs an email provider and a product decision on wording.
- **R1-08 remainder:**
  - CAPTCHA for sign-ups and the anonymous function actions (dashboard setting plus site key);
  - per-IP limits (no trustworthy client address);
  - push rates (snapshot model).
- **R1-09 remainder.** Followers still download each simulation step. Needs the simulation on the server, or per-record tables.
- **R1-17 edge.**
  - An attacker with the password can block (not enter) a brand-new staff account by enrolling first. The owner then needs a support reset.
  - Verify the live `amr` value once before applying migration 2 (see above).
- **`*_push` transition.** `p_expected` should become required in a later migration, once cached clients from before 16 November are gone.
- **R3-14, R3-15.** Hosting and retention decisions.
- **Review items.**
  - C: device keys in localStorage.
  - D: set `OCPP_ALLOW_QUERY_KEY=false` once real chargers connect.
  - E: set the `ALLOWED_ORIGINS` secret; the code default still includes localhost, kept for local testing.
  - F: Actions pinned by tag.
  - G: GitHub Pages can't send headers.
  - H: payments.
  - I: compliance registration and DPIA.
- **R1-10.** Still to verify against the Smartcar sandbox that `createdAt` is present.
