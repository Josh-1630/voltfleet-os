# VoltFleet OS QA and security relay, round 2: fixes and fresh assessment

16 November 2026. Agent 2 of 3. Nothing was committed, pushed or deployed. The live Supabase project was only read: catalog queries and function definitions, no DDL or DML.

## Migrations to apply

Apply in this order. Each file is safe to re-run. All three were applied twice to a local Postgres 16 that stands in for the Supabase pieces they use (`auth.users`, `auth.uid()`, `auth.jwt()`, roles, the `supabase_realtime` publication). The whole repo chain was also rebuilt from scratch with them.

1. `supabase/migrations/20261116_worlds_baseline.sql`: records the `public.worlds` table, which exists live but was never in the repo (R2-04). Every statement is guarded, so it changes nothing on the live project.
2. `supabase/migrations/20261116_sync_cas.sql`: compare-and-swap writes and lease fixes (R1-02, R1-03, R1-07).
   - Replaces `world_push(text,text)` with `world_push(text,text,bigint default null)`, and `org_world_push(text)` with `org_world_push(text,bigint default null)`.
   - Replaces `world_tick` and `org_world_tick`.
   - Re-grants execute rights and sends `notify pgrst, 'reload schema'`.
3. `supabase/migrations/20261116_invites_owner.sql`: invitations need consent and expire, and organisations get an owner (R1-04, R1-06).
   - Adds the columns `org_invites.expires_at` and `declined_at`, plus three indexes.
   - Adds the functions `my_invitations`, `accept_invite`, `decline_invite`, `leave_organization` and `org_owner` (internal).
   - Replaces `my_account`, `complete_signup`, `invite_member`, `remove_member` and `delete_my_account`.

**Order with the web app.** The new client works with both the current live functions and the new ones. It detects whether `p_expected` is accepted (`VF.cloud.cas`), so the app and the migrations can ship in either order. Until migrations 2 and 3 are live:
- lost updates (R1-03) are only narrowed, not closed;
- invitations still auto-join (R1-04);
- the stuck-leader freeze (R1-02, server side) can still be caused by old cached clients.

**Transition note.** In `*_push`, `p_expected` is optional so that app versions cached before this change keep working. Those old clients still overwrite blindly. A later migration should make it required (for example in a week).

## Edge Functions to redeploy

- **`smartcar`** (`supabase/functions/smartcar/handler.ts`): `link` now fails closed when Smartcar reports no connection time (R1-10).
  - Before deploying, check against the Smartcar sandbox that `/v3/connections` returns a `createdAt`-style field. If it doesn't, linking is refused with a clear message, and the proper fix (the OAuth code exchange) becomes necessary.
  - Tests: `qa2/fn-test-smartcar.mts`, 22/22 pass, including 2 new cases.
- **`ocpp`**: unchanged.

---

## Round-1 findings

| ID | Sev. | Status | What changed | Proof (scripts in the session scratchpad) |
| --- | --- | --- | --- | --- |
| R1-01 Sign-in overwrites the org workspace with the demo world | Critical | **Fixed** (client only) | See "R1-01 in detail" below. | `qa2/signin-to-org.js` and `qa2/demo-to-org.js` (the qa1 scripts, now matching the demo channel by filter): demo update ignored, org row keeps `Airport City Hub`. The same script against the original code (`qa2/signin-to-org-orig.js`, port 8081) still shows `DEMO WORLD MARKER` in the org row. |
| R1-02 Device ahead of the server never syncs; freeze | High | **Fixed** (client). Server half in migration 2 | See "R1-02 and R1-03 in detail" below. | `qa2/sync-cas.js cas` and `qa2/sync-cas.js legacy`: "offline device does not invent revisions", "A is synced again", "A alone: N ticks saved, A rev = server rev". With the new rules, "a stuck client with a stale revision can't freeze the world" (7 ticks in 16 s). Original code: `A rev 36, server 22, label "This device only"`, FAIL. |
| R1-03 Lost updates from blind snapshot overwrites | High | **Fixed with migration 2**, **Partly fixed** without it | See "R1-02 and R1-03 in detail" below. | `qa2/sync-cas.js cas`: 10/10 (simultaneous edits kept on the server and on both devices; same-counter new records both kept; offline edit plus other device's edit both kept). `legacy`: 8/9; the simultaneous same-id create still collides. Original code fails 3 of the first 3 checks. Unit tests: `qa2/patch-unit.js` 10/10. |
| R1-04 Invite squatting (silent auto-join) | High | **Fixed** (needs migration 3) | `complete_signup` never joins on its own: it returns `status:'invited'` with the open invitations. The new "You've been invited" screen offers **Join** / **No thanks** and says what joining shares. Declining continues with the account type chosen at sign-up. Invitations expire after 7 days, and re-inviting renews them. Admins see Invited / Declined / Expired. | Local SQL `qa2/sql/test_invites.sql`: victim gets `invited`, no org; declining creates their own org; accepting joins; expired invite not offered; accept refused when already in an org. `t20.js`: new check "invitation needs consent: offered, not joined yet" (screenshot `shots/auth-invite.png`). |
| R1-05 Clickjacking guard was dead code | Medium | **Fixed** | Guard moved above `return VF`. A cross-origin frame sets `VF.framed`, and `boot()` stops, so nothing renders or runs. The "open VoltFleet" link drops the query string. | `qa1/frame.js`: `frame-guard present: true`, `app rendered in frame: false`. |
| R1-06 No owner; any invitee can remove the founder | Medium | **Partly fixed** (needs migration 3) | The creator is the owner (`organizations.created_by`). If they delete their account, the longest-standing member takes over. Only the owner removes people, and the owner can't be removed. Members can **Leave organisation**. The panel shows "Owner" and hides Remove for non-owners. **Not done:** a non-admin/read-only member role and an email to the removed person both need a product decision. | `test_invites.sql`: "The organisation's owner can't be removed"; owner can't leave; non-owners can. |
| R1-07 Throttle covers push only; NULL skips the check | Medium | **Fixed** (migration 2) | `*_tick` rejects `p_expected is null`. The `stale` path writes nothing (no lease renewal). Successful ticks are limited to about 1/s per lease holder (`too_fast`). Pushes lock the row and keep the 100 ms throttle. Demo snapshot capped at 750 kB (live is 136 kB). | `qa2/sql/test_sync.sql`: `expected revision required`, `too_fast`, `stale` without lease change, oversize rejected, `anon` can't execute `org_world_*`. |
| R1-08 Global rate limits let one actor block everyone | Medium | **Not fixed** | See "Why R1-08 is open" below. | — |
| R1-09 Sync bandwidth | Medium | **Partly fixed** | See "R1-09 in detail" below. | `qa2/sync-cas.js` (sync still correct); `qa2/perf-save.js`. |
| R1-10 Smartcar `link` trusts the browser's `user_id` | Medium | **Fixed, fail-closed** (redeploy `smartcar`) | A link is accepted only if Smartcar reports a connection created during this Connect flow (from 5 min before it started). Missing timestamps now refuse instead of passing. The OAuth code exchange remains the better long-term design. | `qa2/fn-test-smartcar.mts`: "link refused when Smartcar gives no connection time", "link refused for a connection made days before this flow"; earlier 20 checks still pass. |
| R1-11 WCAG AA: contrast, unnamed controls | Medium | **Fixed** (for the views scanned) | See "R1-11 in detail" below. | `qa1/a11y.js` (axe 4.10, WCAG 2 A/AA, light and dark, sign-in plus 3–4 pages per role): **no violations**. |
| R1-12 CSS injection through numeric fields | Low | **Fixed** | `sanitizeState` turns strings in known numeric fields (`score`, `eco`, `targetSoc`, `soc`, `kw`, `price`, …) back into numbers (or 0). The four `style=""` interpolations coerce with `clamp(+x || 0, 0, 100)`, and the shown text is escaped. | `qa1/cssinj.js`: `score after sanitizeState: 0`, no injected styled elements. |
| R1-13 Dialogs don't trap or restore focus | Low | **Fixed** | While a dialog is open, `#root` is `inert`, Tab and Shift+Tab cycle inside, and Escape closes. Focus returns to the element that opened it. | `qa1/mobile.js`: `Tab order: in-dialog:Cancel -> in-dialog:Confirm -> in-dialog:Cancel -> in-dialog:Confirm`. (Its dialog is opened from script, so there is no opener to return to.) |
| R1-14 Enter in "New password" saves the name; false "Key copied" | Low | **Fixed** | Enter in the password field, the invite email field or the authenticator code field runs that section's own action. "Copy key" uses `VF.copyText` (awaits, falls back, reports failure). | `qa1/acct-enter.js`: `toasts: ["Password changed"] … stored password changed: true`. |
| R1-15 Sign-in page shows any `?error_description=` text | Low | **Fixed** | URL text is never shown: known codes (`otp_expired`, `access_denied`, `email_not_confirmed`) get fixed messages, anything else a generic one. The error parameters are removed from the URL. | `qa1/spoof.js`: `"That sign-in link didn't work. Request a new one."` |
| R1-16 Service worker caches one-time URLs | Low | **Fixed** | Navigations are cached only as the app shell (`./`). URLs with a query string are never stored. The offline fallback still serves the shell. Cache renamed `voltfleet-os-v22`, so older caches, including stored `?code=` entries, are deleted on activation. | `qa2/swcache.js`: `no query URLs cached`, `cache entries: 41`, `offline: app shell served: true`. |
| R1-17 2FA: password-only enrolment; last-factor rule UI-only | Low | **Not fixed** (docs corrected) | Closing the enrolment window needs an email-verified enrolment step, which is a Supabase Auth configuration and product decision. Enforcing "last device" on the server would need a trigger on `auth.mfa_factors`. That runs inside GoTrue's own deletes (user deletion, admin reset), which can't be tested safely without the live auth service. `docs/accounts.md` no longer claims a server-side rule. | — |

### R1-01 in detail

- **Generation teardown.** `cloud.start()` starts a new "generation" each time it is called:
  - it removes the previous Realtime channel and clears the previous poll;
  - it resets the write and read queue;
  - every async step (Realtime callback, adopt, tick, push, poll) checks the generation before touching state, so anything still in flight for the demo is dropped.
- **Lazy demo sync.** The demo world now syncs only once the demo is used: the "Try the demo" tab, `?demo`, a demo account, or a restored demo session. It never runs behind the sign-in form.
- **Demo accounts.** Demo accounts can only be used in demo mode.

### R1-02 and R1-03 in detail

**R1-02, client.** `VF.state.rev` now only ever holds a revision the server returned for the current target.
- Offline actions are kept as pending changes. The revision is never counted up locally.
- A world that was never confirmed is force-adopted (with pending changes re-applied).
- On reconnect the poll re-subscribes, adopts and pushes.
- The label says "Offline · changes kept on this device" while actions are waiting.

**R1-02, server (migration 2).** The `stale` branch no longer grants or renews the lease.

**R1-03, with migration 2.** Every write sends the revision it was based on. When someone else wrote first:
1. the device fetches the newer world;
2. it re-applies its own unconfirmed actions on top. Each action is recorded as a small patch (record-level diff by `id`, prepend/append for logs, values otherwise);
3. it retries.

Writes and adopts run in one queue, so an update never interleaves with a write. A record created with the same counter id on two devices (ids come from `seq++`) is kept on both sides under a new id (R2-05).

**R1-03, without migration 2.** The client checks the head revision before an unconditional push. That narrows the window but does not close it.

### Why R1-08 is open

The per-client limits that would fix this need a client address the functions can trust. On Supabase Edge, `x-forwarded-for` can be partly supplied by the caller, and the trusted hop is not documented. If the limit keyed on a value shared by everyone (a proxy address), a per-client limit of a few an hour would become a global one, which is worse than today.

Recommended, as a product or config decision:
- turn on Supabase Auth CAPTCHA (Turnstile/hCaptcha) for sign-ups;
- require a signed-in user for OCPP `createNetwork` and Smartcar `start`;
- then limit per `auth.uid()`.

### R1-09 in detail

**Done:**
- Hidden tabs drop their Realtime channel and poll only when visible again.
- Low-data mode doesn't stream, checks every 45 s, and never leads, so it doesn't upload the world every 2 s.
- The local copy is written at most every 5 s, or at once when it holds unsent changes. It used to be written every tick.
- The low-data card now says what actually happens.

**Not done:** Realtime still carries the full row (`state_gz`) to every visible tab. The real fix needs either:
- a small `world_heads` table or broadcast channel with the state fetched on change, or
- per-record tables (already listed as next in `docs/accounts.md`).

### R1-11 in detail

- `--faint` is now `#5F6E82` (light) and `#7E949A` (dark), and `--muted` is now `#5B6B7F`.
- `.pill.bad` uses a darker red text (`--bad-ink`).
- `C.seg` takes an accessible name for icon-only items (grid/table toggle).
- The API scope selects are labelled.
- The map SVG is `role="group"` (it holds focusable stations).
- The "Needs attention" lists use `role="none"`.
- Scrollable table wrappers are focusable.
- Inline links in running or muted text are underlined.

---

## New findings (round 2)

| ID | Title | Severity | Status |
| --- | --- | --- | --- |
| R2-01 | A world that passes `sanitizeState` but has dangling references crashes pages for every demo visitor | Medium | Fixed |
| R2-02 | A person removed from a team keeps seeing the workspace, and its copy stays on their device | Medium (privacy) | Fixed |
| R2-03 | Smartcar redirect handler shows URL text and also takes over sign-in error redirects | Low | Fixed |
| R2-04 | The repo's migrations can't rebuild the database (`public.worlds` missing) | Low | Fixed (migration 1) |
| R2-05 | Counter-based ids (`'x' + (++seq)`) collide across devices | Low | Fixed (sync merge) |
| R2-06 | "Restore power" doesn't take effect until the next simulation step | Low | Fixed |
| R2-07 | Audit trail and developer "app secrets" live in the shared snapshot, so any member (anyone, in the demo) can rewrite them | Info | Not fixed (architecture) |
| R2-08 | GitHub Pages publishes `voltfleet-os.zip` (an old copy of the app) and `docs/qa/*` | Info | Not fixed (owner decision) |

### R2-01 Inconsistent worlds crash pages for everyone (Medium)

**What's wrong.** Anyone can write the demo world without signing in. `sanitizeState` neutralises markup but doesn't check references. A snapshot with a station on an unknown map node, a station whose operator is missing, or a driver account without a car throws in the page code (`PLACES[node].lat`, `VF.operator(id).pricing`, `driverVehicle(...).model`). Every visitor then sees "This page could not load", or a dead sign-in screen, until someone resets the demo.

**Evidence.** `qa2/badref.js` against the original code (port 8081):

```
{"manager":{"pageErrors":5,"failedPage":true},"driver":{"pageErrors":4,"failedPage":true},"operator":"sign-in screen broken","admin":"sign-in screen broken"}
Cannot read properties of undefined (reading 'lat') | (reading 'pricing') | (reading 'model')
```

**Fix.** `VF.repairState()` runs after `sanitizeState` on every world taken from the server, from localStorage or from another tab.
- It drops the records the app can't show:
  - stations with an unknown node or operator;
  - sessions and bookings for missing stations;
  - driver, operator and developer accounts whose driver/car, operator or developer org is missing.
- A world without the core lists is refused. The device keeps its own world and takes the server's revision, so its next write replaces the broken one.

After the fix, all four roles render with 0 page errors.

### R2-02 Removed team members keep the workspace (Medium, privacy)

**What's wrong.** After `remove_member`, RLS hides the workspace row. The removed person's open app kept running on its local copy, and the copy stayed in localStorage. Sync just failed quietly, so they kept seeing the team's data, and it stayed on the device.

**Evidence.** `qa2/removed-member-orig.js`: `FAIL … {"signin":false,"orgKeys":2}`.

**Fix.** When the poll finds the workspace unreadable after it had been synced, the app checks `my_account`. If the organisation is gone, it says "You no longer have access to this workspace" and signs out, which wipes the copy. It checks at most once a minute and does nothing when offline.

**Proof.** `qa2/removed-member.js`: `PASS after removal: back on the sign-in page, workspace copy wiped {"signin":true,"orgKeys":0}`.

### R2-03 Smartcar redirect spoofing and sign-in collision (Low)

**What's wrong.** `VF.real.handleRedirect` treated any `?error=` as a Smartcar redirect. Two consequences:
- **Spoofing.** It showed `error_description` in a toast ("Smartcar: …"), the same content spoofing as R1-15.
- **Collision.** It also caught Supabase sign-in link errors (`?error=access_denied&error_code=otp_expired`), toasted "Vehicle connection cancelled." and moved the person to `#m-vehicles`.

**Evidence.** `qa2/sc-redirect.js` against the original code:

```
?error=access_denied&error_code=otp_expi -> toasts "Vehicle connection cancelled."
?error=server_error&state=… -> toasts "Smartcar: Call 024 000 0000 to unlock your car"
```

**Fix.** A redirect counts as Smartcar's only with `user_id`, or with `error` plus a `state` this tab started. Messages are fixed text.

**Proof.** Now: no Smartcar toast for the sign-in error, and "Smartcar couldn't connect the vehicle. Try again." for the crafted text.

### R2-04 The database can't be rebuilt from the repo (Low)

**What's wrong.** `public.worlds` was created on the live project by `20261102085222 shared_world_sync` and `20261102085352 lock_world_ids`. Those files aren't in the repo. Every later migration depends on that table, so a fresh project or branch can't be built from the repo.

**Fix.** `20261116_worlds_baseline.sql` records the table, its constraints, policy, grants and publication exactly as read from the live catalog. It is guarded, so it is a no-op on the live project.

**Proof.** A fresh local database built from the repo files (baseline → hardening → accounts → mfa → sync_cas → invites_owner) applies with no errors.

### R2-05 Counter-based ids collide across devices (Low)

**What's wrong.** New records get ids from shared counters (`'wt' + (++VF.state.seq)`, `'dp' + fleet.seq++`, …). Two devices acting at the same moment create the same id. Under the old whole-snapshot overwrite, one record silently vanished. Under a naive merge, the two would be fused into one.

**Fix.** When a re-applied action inserts an id that a different record already holds, the action's record gets a new id (`dp4-xxxx`). The rename also applies to the device's later pending actions, and `seq` counters never move backwards.

**Proof.** `qa2/sync-cas.js cas`: `ids unique (dp4-…, dp4)`. `qa2/patch-unit.js`: rename and follow-up cases.

**Remaining.** Making ids collision-free at the source (random suffixes) would remove the need for this.

### R2-06 "Restore power" waits for the next simulation step (Low)

**What's wrong.** On Control Tower, `O.restore` called `gridTick()` with no elapsed simulation time, so it returned at once. The depot stayed down until the next step (up to 1 s, and longer if this device wasn't leading), and the page re-rendered still showing the outage. `t18.js` "restore power" failed depending on timing.

**Fix.** `O.restore` applies the restore immediately.

**Proof.** `t18.js`: `PASS restore power`.

### R2-07 Shared-snapshot audit trail and "secrets" (Info)

The in-app audit trail (`VF.state.audit`), consent records and the developer console's app secrets (`vfs_…`, generated with `Math.random`) are part of the shared world. Any workspace member, or anyone at all in the demo, can rewrite them by pushing a snapshot. They are simulated today.

Recommendation: never treat them as real secrets or as evidence. If Connect becomes a real API, issue keys on the server. If the audit trail matters legally, keep it server-side (`public.audit_log` already is).

### R2-08 Extra files published (Info)

The Pages workflow uploads the whole repository (`path: .`). That publishes `voltfleet-os.zip` (the 29 Oct app code, no secrets) and these QA reports. Consider an allow-list artifact or `_site` folder.

---

## Other changes

- `docs/accounts.md`: describes invitation consent, expiry, owner and leave; drops the server-side "last device" claim.
- `docs/security-review.md`: item 5 notes that the guard only took effect now.
- `sw.js`: cache bumped to `voltfleet-os-v22`. Changed cached files: `cloud.js`, `auth.js`, `app.js`, `core.js`, `ui.js`, `ops.js`, `manager*.js`, `driver.js`, `connect.js`, `smartcar.js`, `styles.css`.
- Test fake `fake-supabase.js` (scratchpad) now implements the new server rules. `localStorage['fake-legacy']='1'` gives the old ones. `t20.js` now accepts the invitation explicitly, and `qa2/t20-legacy.js` runs the same flow against the old rules.
- **Recording cost.** Recording an action (the patch) costs about 16 ms per user action with the CPU slowed 4x on the 112 kB seed (6 ms before). That is per action, not per frame (`qa2/perf-save.js`).

## Regression results

All runs used Chromium/Playwright against `python3 -m http.server 8080`, with external hosts aborted. Scratchpad: `/tmp/claude-0/-home-user-voltfleet-os/b0830beb-4ffd-549e-aec9-8a2e2175a44d/scratchpad`; full outputs are in `qa2/final/`.

| Suite | Result |
| --- | --- |
| `t20.js` (real sign-in, 2FA, invitations, against the new server rules) | 27/27 PASS (one new check: invitation consent), no page errors |
| `qa2/t20-legacy.js` (same flow against the live function behaviour) | 27/27 PASS: the old client-visible behaviour still works before the migrations |
| `qa2/sync-cas.js cas` | 10/10 PASS |
| `qa2/sync-cas.js legacy` | 9/9 PASS in the final run. An earlier run failed the simultaneous same-id create: without migration 2 the race is narrowed, not closed. |
| `qa2/patch-unit.js` | 10/10 PASS |
| `qa2/signin-to-org.js`, `qa2/demo-to-org.js` | Org workspace untouched by demo updates (`Airport City Hub` on device and server) |
| `qa2/removed-member.js` | 3/3 PASS |
| `qa2/badref.js` | 0 page errors in all four roles (the original code had 9 errors and two broken sign-in screens) |
| `qa2/sc-redirect.js` | Sign-in link errors no longer trigger the Smartcar handler; no URL text shown |
| `qa2/fn-test-smartcar.mts` (Node 22 strip-types) | 22/22 PASS |
| Local Postgres: `qa2/sql/test_sync.sql`, `qa2/sql/test_invites.sql`, fresh rebuild of every repo migration | As described above; all migrations apply twice without error |
| `xss.js` | Clean in all five roles (407–410 planted fields, 48 pages) |
| `csp.js` | No CSP violations |
| `sanit.js` | Tampered state neutralised. The CSV check is the known false FAIL. |
| `qa1/frame.js`, `qa2/swcache.js`, `qa1/spoof.js`, `qa1/acct-enter.js`, `qa1/cssinj.js`, `qa1/mobile.js` | All show the fixed behaviour (see the table above); no horizontal overflow at 393 px |
| `qa1/a11y.js` (axe) | No WCAG A/AA violations on the scanned views, light and dark |
| `t17.js` | 26 PASS, 0 FAIL |
| `t18.js` | 23 PASS, 1 FAIL: the known "low-data mode: no photos". "Restore power" now passes reliably (R2-06). |
| `t19.js` | 11 PASS, 1 FAIL: the known flaky "rescue completes" |
| `t21.js` | 11 PASS, 1 FAIL: the known "m-fleet" |
| `t3.js shots` | 35 PASS |
| `t15.js shots` | 15 PASS |
| `t1.js shots` | Every manager page renders with no overflow and no page errors (it only logs aborted external requests) |

Known expected failures (as briefed):
- t18 "low-data mode: no photos…";
- t19 "rescue completes" (timing);
- t21 "m-fleet" (no photos by design);
- sanit.js CSV check (the guard works; the test expects `'=` at position 0).

## Left open

- **R1-08:** see "Why R1-08 is open" above.
- **R1-17:** needs an email-verified enrolment step.
- **R1-09 remainder:** a heads table or per-record sync.
- **R1-06 remainder:** a read-only role and a removal email.
- **R1-03 without migration 2:** only narrowed.
- **R2-07, R2-08:** not fixed (architecture and owner decision).
- **R1-10:** fail-closed until verified with the Smartcar sandbox.
- **`*_push` transition:** `p_expected` should become required once old cached clients are gone.
- **Earlier review items still open:** C, D, E, F, G from `docs/security-review.md`.
