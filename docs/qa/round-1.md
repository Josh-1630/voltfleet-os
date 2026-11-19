# VoltFleet OS QA and security relay, round 1: assessment

16 November 2026. Agent 1 of 3. This round is assessment only: no application code was changed.

**Scope.** I covered the web app (all five roles), `sw.js`, the CSP, the Supabase database (live project `kwxadepnkyxgspvvqbzo`, read-only SQL and advisors), both Edge Functions, and the GitHub Pages workflow. Before starting I read `docs/security-review.md` and `docs/accounts.md`. Items those docs already list as open (C, D, E, F, G, H, I) are not repeated here unless something new was found.

**Method.** I read the code and ran Playwright and Chromium against a local server (`python3 -m http.server 8080`), with external hosts blocked.
- The existing probes were re-run: `xss.js`, `csp.js`, `sanit.js` and `t20.js`.
- New scripts live in the session scratchpad under `qa1/`.
- Two in-browser stand-ins for supabase-js reproduce the server functions line for line, so sign-in and sync could be exercised:
  - `qa1/fake-sync.js` keeps the demo world in the test process and applies the exact `world_tick`/`world_push` rules.
  - `qa1/fake-both.js` adds accounts and Realtime callbacks.
- The live database was only read. It has **0 organisations, 0 profiles and 0 org workspaces**, so none of the account-side bugs below has damaged real customer data yet.

## Summary

| ID | Title | Severity | Category | Location |
| --- | --- | --- | --- | --- |
| R1-01 | Signing in replaces the organisation's private workspace with the public demo world, and saves it to the server | Critical | Security / data integrity | `js/app.js:459-469`, `js/cloud.js:122-151`, `js/auth.js:111` |
| R1-02 | A device whose local revision runs ahead of the server's never syncs again, and can freeze the shared world for everyone (happening on the live demo now) | High | Quality / data integrity | `js/core.js:822-829`, `js/cloud.js:59-65, 88`, `20261108_world_hardening.sql:35-38`, `20261109_mfa.sql:61-64` |
| R1-03 | Lost updates: every user action uploads the whole snapshot with no revision check, so concurrent edits overwrite each other | High | Quality / data loss | `js/cloud.js:92-109`, `20261108_world_hardening.sql:7-18`, `20261109_mfa.sql:69-80` |
| R1-04 | A pending invite silently pulls a new sign-up into another organisation (invite squatting) | High | Security / Privacy | `20261108_accounts.sql:150-158`, `20261109_mfa.sql:92-106` |
| R1-05 | Clickjacking guard never runs (dead code after `return VF`); security-review fix 5 is not in effect | Medium | Security | `js/core.js:1057-1067` |
| R1-06 | No owner role: every invitee becomes a full admin and can remove anyone, including the founder | Medium | Security | `20261109_mfa.sql:102, 117-129` |
| R1-07 | Flood throttle covers `world_push` only; `world_tick` (anonymous) and `org_world_tick` are unthrottled, and a NULL revision skips the check | Medium | Security (abuse) | `20261108_world_hardening.sql:20-42`, `20261109_mfa.sql:49-67` |
| R1-08 | Global rate limits (not per user or client) let one actor block sign-ups, OCPP networks and Smartcar connections for everyone | Medium | Security (DoS) | `20261108_accounts.sql:133`, `supabase/functions/ocpp/server.ts:45, 106`, `supabase/functions/smartcar/handler.ts:189` |
| R1-09 | Sync downloads the full snapshot every 2 s on every open tab (about 4 MB a minute), and low-data mode doesn't change this | Medium | Performance | `js/cloud.js:12, 77-90, 139`, `js/ops.js:139` |
| R1-10 | Smartcar `link` trusts a browser-supplied `user_id`; the `state` only proves that a flow was started (Suspected) | Medium | Security | `supabase/functions/smartcar/handler.ts:194-205` |
| R1-11 | WCAG AA failures: `--faint` text contrast is 3.35:1, and several controls have no name | Medium | Accessibility | `styles.css:16`, `js/manager.js:285`, `js/connect.js:343` |
| R1-12 | CSS injection through numeric fields: `sanitizeState` doesn't check types, and values go straight into `style=""` | Low | Security | `js/core.js:836-852`, `js/manager-more.js:151`, `js/manager-ops.js:74`, `js/driver.js:97` |
| R1-13 | Dialogs don't trap or restore keyboard focus | Low | Accessibility | `js/ui.js:168-190` |
| R1-14 | Account & team: pressing Enter in "New password" saves the name and discards the password; "Key copied" can be shown even when the copy failed | Low | Quality | `js/auth.js:274, 315-328` |
| R1-15 | Sign-in page shows any text passed in `?error_description=` (content spoofing) | Low | Security | `js/auth.js:41, 52-56` |
| R1-16 | Service worker caches one-time URLs (`?code=`, `?user_id=&state=`) indefinitely | Low | Security / Privacy | `sw.js:10-16` |
| R1-17 | 2FA gaps: a password alone can enrol an authenticator while a staff account has none, and "last device can't be removed" is enforced only in the UI | Low | Security | `js/auth.js:81, 311`, `docs/accounts.md` |

---

## Critical

### R1-01 Signing in overwrites the private workspace with the public demo world

**What's wrong.**
- At boot, whenever the person isn't already signed in, `app.js` calls `startDemo()` (`js/app.js:459, 467-469`). That runs `VF.cloud.start()` for the public `demo` world:
  - it subscribes Realtime channel `world-demo` (`js/cloud.js:138-140`);
  - it starts a poll interval (`js/cloud.js:144-151`).
- Signing in from the form doesn't reload the page. `afterSignIn` calls `A.enter` (`js/auth.js:102-112`), which calls `VF.cloud.start({ org })` again.
- The demo subscription is never removed. Its callback `adoptRow(p.new)` keeps running and adopts any row with a higher revision into `VF.state`. That is now the organisation's state.
- The demo is at revision 4276+ and a new workspace starts near 0, so the first demo change replaces the private workspace in memory. It is then saved to localStorage under the organisation's key.
- The next user action (`VF.save` → `org_world_push`) writes the demo world into the organisation's row on the server.

**Evidence.** Test script `qa1/signin-to-org.js`:
1. Open the sign-in page.
2. Create a driver account.
3. Simulate another visitor changing the demo world (station 0 renamed `DEMO WORLD MARKER`).

The demo tab was never clicked. Output:

```
on the plain sign-in page, subscriptions: world-demo id=eq.demo
after sign-in: {"mode":"account","key":"voltfleet-os:org:285e…","rev":2,"subs":"world-demo,world-285e…","me":"Private Person"}
private workspace after a demo update: {"mode":"account","rev":5002,"station0":"DEMO WORLD MARKER"}
organisation row on the server: {"rev":3,"station0":"DEMO WORLD MARKER"}
```

`qa1/demo-to-org.js` shows the same result when the person looks at the demo first.

**Impact.**
- Every normal sign-in (new device, after sign-out, after a password reset, after 2FA) destroys that organisation's workspace as soon as the demo world changes, which normally happens every 2 s. The loss reaches every team member through sync.
- Anyone can write the demo world anonymously, so an attacker can plant chosen content (vehicles, stations, tariffs, notices) into the workspace of every organisation whose members sign in while the attacker's snapshot is live.
- After adoption the local revision is far ahead of the organisation's, so R1-02 then stops this device from syncing properly.

**Fix.**
- Make `cloud.start` idempotent per target: keep the channel and interval handles, and `sb.removeChannel(old)` plus `clearInterval(old)` before subscribing to the new target.
- Tag every adopted row with its target and drop rows whose table or id isn't the current target. Do the same check in `adoptRow` and before every `T().push` or `T().tick` call made after an `await`. `pack()` awaits, so `T()` can change between packing and sending.
- Don't start the demo sync on the sign-in screen at all. Start it only when "Try the demo" is chosen.
- Or, simplest of all, do `location.reload()` after a successful sign-in.
- Add a regression test along the lines of `qa1/signin-to-org.js`.

---

## High

### R1-02 A device ahead of the server never syncs again and can freeze everyone

**What's wrong.**
- While sync is down (`status === 'error'`, for example a dropped mobile connection), the app loop calls `VF.save()`. The offline branch sets `VF.state.rev = max(rev, stored) + 1` every second (`js/core.js:822-829`).
- When the connection returns, the device's revision is ahead of the server's. `adoptRow` then ignores every server row whose revision is not higher than the local one (`js/cloud.js:59, 65`), so the device stops receiving other people's changes.
- Its leader ticks get `stale`. The server's stale branch hands it the lease (`world_tick`: `update … set leader_id = p_client, leader_at = now()`, `20261108_world_hardening.sql:35-38`; the same in `org_world_tick`). The client then tries to adopt the server row, which it ignores, so the cycle never ends.
- If that device is the only one leading, no simulation tick ever succeeds again. The lease is renewed every 2 s, so other devices get `not_leader` and quietly simulate locally.
- Every device still shows "Synced across devices".

**Evidence (live database).** At the time of the assessment:

```
worlds.demo: rev 4276, leader_at 2026-11-16 09:24 UTC, updated_at 2026-11-11 15:09 UTC
```

The lease is being renewed, but nothing has been written for 5 days. That is exactly this state.

**Evidence (reproduced).** `qa1/sync-stuck.js` and `qa1/sync-freeze.js` run two tabs against an exact copy of the server rules. Tab A loses the network for 25 s:

```
A offline 25 s             server rev 13 | A {"rev":28,"st":"error"} | B {"rev":13,"leader":true}
A back online (8 s later)  server rev 17 | A {"rev":30,"st":"live"}  | B {"rev":17,"leader":true}
A sees B's change: false        label on A: Synced across devices
B closed; A alone for 30 s: ok ticks 0, stale ticks 10, A rev 30, server rev 16, leader A
```

**Impact.**
- The public demo is frozen today.
- In a team workspace, a member with patchy coverage stops seeing colleagues' changes, and while they hold the lease nobody else's simulation is saved.
- Combined with R1-03, that member's next action overwrites everything the team has done since.
- The status label is misleading.

**Fix.**
- Never invent revisions locally while a cloud target is configured. Keep a separate `localDirty` flag or `pendingOps` counter, and leave `rev` meaning "last server revision".
- On reconnect, always fetch the server row and either adopt it (forced) or re-apply local intents on top of it.
- On the server, have the `stale` branch return the current revision without granting the lease, so a stuck client can't block others.
- Add a watchdog: if N consecutive ticks are `stale`, force-adopt the server row.

### R1-03 Lost updates: blind full-snapshot overwrites

**What's wrong.** `cloud.push` uploads the device's whole snapshot through `world_push` or `org_world_push` (`js/cloud.js:92-109`). Those functions overwrite unconditionally: they take no expected revision and do no merge (`20261108_world_hardening.sql:7-18`, `20261109_mfa.sql:69-80`). Any two actions made within the sync delay (Realtime latency plus up to 2 s of leader tick) overwrite each other. A device that is behind (R1-02) overwrites everything since its last adopted revision.

**Evidence.** `qa1/sync-race.js`: two devices each rename a different vehicle at the same moment.

```
A sees: Van 03 / Edited by B | B sees: Van 03 / Edited by B
server holds: Van 03 / Edited by B | pushes 2
```

A's edit is lost everywhere, including on A's own screen. In `qa1/sync-stuck.js`, B's edit is lost once A pushes:

```
after A pushes: B still sees its own change: Van 01
```

**Impact.** Silent data loss in team workspaces: bookings, dispatches, cancellations, consent changes. This gets worse as more people use one workspace.

**Fix.**
- Short term: give `*_push` an `p_expected` revision and reject stale pushes (as `*_tick` does). On rejection, the client re-fetches, re-applies its action to the fresh state and retries.
- Better: send intents (operations) instead of snapshots, or move to per-record tables. `docs/accounts.md` already lists that as next.

### R1-04 Invite squatting: a pending invite captures a new sign-up without consent

**What's wrong.**
- `complete_signup` looks for a pending invite for the person's email before honouring the account type and organisation name they chose at sign-up (`20261108_accounts.sql:150-158`).
- Any organisation admin can invite any address (`invite_member`, up to 20 an hour and 50 open). Invites never expire.
- When that person later creates their own account, they are silently made a member of the inviting organisation, with the inviter's role. The app goes straight into that workspace (`afterSignIn` → `enter`) with no "You've been invited to X — accept?" step.

```sql
if u.email_confirmed_at is not null and u.email is not null then
  select * into inv from public.org_invites where lower(email) = lower(u.email) and accepted_at is null order by created_at limit 1 for update;
  if inv.id is not null then
    update public.profiles set org_id = inv.org_id, role = inv.role ...   -- before the account_type in meta is considered
```

**Impact.**
- A competitor or attacker can pre-invite target addresses (for example `ops@rival-fleet.com`).
- Victims who later sign up end up in the attacker's workspace. Everything they enter, starting with their name and email, goes to the attacker.
- `personalise()` writes the organisation name into the workspace, so an attacker who names their organisation after the victim's company makes this hard to notice.
- There is no "leave organisation" function. The victim can only delete their account.
- The flow also overrides the chosen type: someone signing up as a Driver would join as a Fleet manager.

**Fix.**
- Never auto-accept. `complete_signup` should return `status: 'invited'` with the inviting organisation's name.
- Add `accept_invite(p_id)` and `decline_invite(p_id)` RPCs and an explicit consent screen.
- Let invites expire (for example after 7 days) and tie them to a single-use token sent by email.
- If the person picked "create my own organisation" at sign-up, prefer that and show the invite as an option.
- Add a `leave_organisation()` RPC.

---

## Medium

### R1-05 The clickjacking guard is dead code

**What's wrong.** The frame guard that `docs/security-review.md` item 5 marks as "Fixed" sits after `return VF;` inside the `core.js` IIFE (`js/core.js:1057` returns, guard at `1059-1067`), so it never runs. It has been unreachable since it was added (`git show 690dd95:js/core.js`: `return VF` at 1055, guard at 1058). GitHub Pages can't send `frame-ancestors`, and `frame-src 'none'` only stops VoltFleet from framing others.

**Evidence.** `qa1/frame.js` frames `http://localhost:8080/?demo` from another origin (`127.0.0.1:8091`):

```
frame-guard present: false
app rendered in frame (auth/demo UI): true
top !== self inside frame: true
```

**Impact.** Any site can frame VoltFleet and overlay decoy UI. Modern browsers partition storage for cross-site frames, which limits attacks on signed-in sessions, but the demo and browsers without partitioning are exposed. The security review's claimed fix is not in effect.

**Fix.**
- Move the block above `return VF;` (or into `app.js` boot), and make boot stop when framed cross-origin, not just add an overlay.
- Add `qa1/frame.js` to the regression checks.
- Longer term, serve the site with `Content-Security-Policy: frame-ancestors 'none'` (open item G).

### R1-06 No owner role: any invitee can remove the founder

**What's wrong.**
- `invite_member` stores the inviter's own role on the invite (`20261109_mfa.sql:102`), so every colleague becomes `manager`, `operator` or `developer`. Those all count as organisation admins (`is_org_admin`).
- `remove_member` lets any of them remove any other member, including the person who created the organisation (`20261109_mfa.sql:117-129`).
- There is no owner, no "last admin" protection, no read-only role, and no notification.

**Impact.** A single compromised or malicious invitee can lock out the founder and every other colleague and take over the workspace. Removed people become `pending`, and on their next sign-in `complete_signup` silently creates a new empty organisation for them.

**Fix.**
- Add `organizations.owner_id` (or `profiles.is_owner`) and let only owners invite admins or remove members. Never allow removing the owner.
- Invite with an explicit role, defaulting to a non-admin member role.
- Write and show audit entries for removals (partly done), and email the person removed.

### R1-07 The write throttle covers `world_push` only

**What's wrong.**
- Security-review fix 2 says writes are "throttled to about 10 a second". Only `world_push` and `org_world_push` check `updated_at > now() - 100 ms`.
- `world_tick` (executable by `anon`; confirmed live with `has_function_privilege('anon', …)` = true) and `org_world_tick` have no throttle (verified in the live function bodies). Any client holding the lease can write a 1.5 MB snapshot as fast as it can send requests.
- The lease is easy to take: wait 6 s, or trigger the `stale` branch, which hands over the lease (R1-02).
- `if w.rev <> p_expected` is NULL when `p_expected` is NULL, and plpgsql treats NULL as false. So a caller that omits the revision skips the stale check entirely.
- Every write is published to all subscribers through Realtime (`worlds` and `org_worlds` are in `supabase_realtime`).

**Impact.** An anonymous visitor can saturate database writes and push multi-megabyte messages to every connected demo visitor (bandwidth amplification). A signed-in member can do the same to their team.

**Fix.**
- Apply the same `updated_at` throttle (or a per-client token bucket) in both `*_tick` functions.
- Reject `p_expected is null`.
- Consider capping the demo snapshot well below 1.5 MB. The live one is 136 KB.

### R1-08 Global rate limits let one actor block everyone

**What's wrong.** These limits count everyone's requests together, not per user, address or client:

| Limit | Where |
| --- | --- |
| `create_organization`: 100 organisations an hour | `20261108_accounts.sql:133` |
| OCPP `createNetwork`: 30 networks an hour, no authentication | `supabase/functions/ocpp/server.ts:45, 106` |
| Smartcar `start`: 500 pending states an hour, no authentication | `supabase/functions/smartcar/handler.ts:189` |

**Impact.**
- With plus-addressed confirmed emails, one person can use up the organisation quota every hour, so every real customer's sign-up fails with "Too many sign-ups right now". `complete_signup` swallows the error into `needs_onboarding`.
- About 30 anonymous POSTs an hour block every new OCPP network.
- About 500 an hour block every Smartcar connection.
- Each organisation also gets a 1.5 MB workspace row, so the 100-an-hour quota also allows about 3.6 GB of storage a day.

**Fix.**
- Keep a global ceiling as a circuit breaker, but add per-user limits (`created_by`, `auth.uid()`) and, for the anonymous Edge Function actions, per-IP limits (`x-forwarded-for`).
- Alternatively, require a signed-in user for `createNetwork` and `start`.
- Alert when the global ceiling is hit, rather than failing silently.

### R1-09 Sync bandwidth: the full snapshot every 2 s on every tab

**What's wrong.**
- The leader writes the whole compressed world every 2 s (`TICK_MS`, `js/cloud.js:12, 77-90`).
- Realtime then delivers the full new row, including `state_gz`, to every subscriber (`js/cloud.js:139`). The live demo snapshot is 135,903 characters, which works out to about 4 MB a minute (about 245 MB an hour) of download per open tab, plus the same upload on the leader.
- The fresh seed is smaller (111 KB of JSON, 31 KB packed: `qa1/perf.js`), but the arrays grow to their caps.
- `VF.saveLocal()` also writes the whole snapshot to localStorage on every tick (12 ms per call with the CPU throttled 4x).
- Low-data mode (`js/ops.js:133-146`) only turns off map tiles and animation. Its card says "Everything you do is saved on this device first and synced later", which isn't true.

**Impact.** For the product's target users (Ghana, prepaid mobile data) a single open dashboard tab can burn hundreds of MB an hour, and the low-data setting gives false reassurance. It also adds avoidable Realtime egress cost.

**Fix.**
- Publish only `rev` and `leader_id` through Realtime (for example a small `world_heads` table or a broadcast channel), and fetch `state_gz` only when the revision changed and the tab is visible.
- Lengthen the tick or diff the snapshot.
- In low-data mode, poll every 30-60 s instead of subscribing.
- Throttle `saveLocal` to every few seconds or to user actions.
- Correct the low-data copy.

### R1-10 Smartcar `link` trusts the browser's `user_id` (Suspected)

**What's wrong.**
- `link` accepts `{ userId, state }` from the browser. The `state` only proves that some caller started a flow: anyone gets a fresh one from the unauthenticated `start` action.
- Nothing proves that `userId` was returned by Smartcar for that `state`.
- The only other check passes when a connection was created after `state.createdAt - 5 min`. It is skipped entirely when Smartcar returns no creation timestamp for any connection (`conns.every((c) => c.createdAt != null) && …`, `handler.ts:201`). The parser guesses four possible field names for that timestamp.
- `user_id` also arrives in the redirect URL and is kept in the service worker cache (R1-16).

**Impact.** If a Smartcar `user_id` leaks (browser history, cache, logs, screenshots), anyone can link that person's vehicles. That gives them battery, location and VIN, plus `control_charge` start and stop, either within 5 minutes of a new connection or at any time if timestamps are missing. I couldn't reach the Smartcar API, so whether `user_id` is meant to be secret and whether `createdAt` is always present is unverified.

**Fix.**
- Use the standard OAuth code flow: the Edge Function exchanges the `code` returned to the redirect URI (with the client secret) and derives the user from Smartcar's response.
- Bind `state` to that exchange and never accept a user id from the browser.
- If the "user_id" variant must stay, fail closed when `createdAt` is missing.

### R1-11 Accessibility: contrast and unlabelled controls

**Evidence.** `qa1/a11y.js` runs axe-core 4.10 (WCAG 2 A/AA) on the sign-in page and several pages per role, in both themes:
- **color-contrast (serious), 15 views (light theme):** `--faint: #7C8A9E` on `#F8FAFC` is 3.35:1, below 4.5:1 for small text (`styles.css:16`). Examples: `.auth-foot`, `.divider`, table hints, `op-live` (24 nodes).
- **button-name (critical):** the grid and table view toggles on My Vehicles are icon-only with an empty `<span>` (`js/manager.js:285` through `C.seg`).
- **select-name (critical), 16 nodes:** the scope selects on Developer → Apps have no label (`js/connect.js:343`).
- **nested-interactive (serious):** focusable stations inside `#m-dash-map` and the driver home map, which has `role="img"`.
- **link-in-text-block (serious):** Developer overview links differ from the surrounding text only by colour (1.15:1).
- **list:** `.att-list` contains `<li role="button">`.
- **scrollable-region-focusable:** two table wrappers on `ad-vehicles`.

**Fix.**
- Darken `--faint` in light mode to at least `#64748B`, which already passes as `--muted`.
- Give `C.seg` an `aria-label` option and use it for icon-only items.
- Add `aria-label` to the scope selects.
- Give the map `role="group"` with a label instead of `role="img"` when it contains controls.
- Underline inline links.

---

## Low

### R1-12 CSS injection through numeric fields

`VF.sanitizeState` (`js/core.js:836-852`) strips `< > " ' `` from strings, but doesn't check that numeric fields are numbers. Several templates put state values straight into `style=""`:
- `width:${d.score}%` (`js/manager-more.js:151`)
- `width:${r.eco}%` (`js/manager-ops.js:74`)
- `left:${b.targetSoc}%` (`js/driver.js:97`)

**Evidence.** `qa1/cssinj.js` sets `fleet.drivers[0].score = "100%;position:fixed;inset:0;z-index:2147483647;background:#c00;…"`. It survives `sanitizeState` unchanged, and on Fleet Management the `<i>` element gets `position: fixed` and a red background at full size. A containing ancestor clips it, so it doesn't cover the screen here.

**Impact.** Anyone can write the demo world, so anyone can restyle elements for every demo visitor (defacement, fake overlays inside cards). Scripts and external images stay blocked by the CSP. A string where a number is expected can also break calculations and crash pages.

**Fix.** Coerce on output (`Number(x) || 0`, or `clamp(+x, 0, 100)`). Better, add a small schema check in `sanitizeState` that forces known numeric fields (`soc`, `score`, `eco`, `targetSoc`, `kw`, `price` …) to finite numbers and drops wrongly typed arrays and objects.

### R1-13 Dialogs don't trap or restore focus

`C.confirm` and `C.modal` (`js/ui.js:168-190`) set `aria-modal="true"`, but the page behind isn't made `inert`, Tab isn't kept inside the dialog, and focus isn't returned to the opener.

**Evidence.** `qa1/mobile.js` opens a confirm dialog and presses Tab:

```
Tab order: OUTSIDE:VoltFleet EV Manager -> OUTSIDE:Collapse sidebar -> OUTSIDE:Dashboard
focus after closing dialog: A nav-link
```

**Fix.** Set `inert` on `#root` while a dialog is open, cycle Tab inside `.dialog`, and remember and restore `document.activeElement`.

### R1-14 Account & team form problems

**Enter in the wrong field.** The whole panel is one `<form id="dlg-form">` whose submit handler is "Save name" (`js/auth.js:315-328`). Pressing Enter in "New password" or in the invite email field submits it.

**Evidence.** `qa1/acct-enter.js`:

```
after Enter in New password -> toasts: ["Name saved"] | dialog open: false | stored password changed: false
```

The person types a new password, presses Enter, sees a success toast, and the password is not changed.

**Clipboard toast.** `auth-copy-secret` (`js/auth.js:274`) calls `navigator.clipboard.writeText()` without `await`, so a rejected promise still shows "Key copied" and leaves an unhandled rejection. `VF.copyText` (`js/core.js`) already handles this correctly and should be reused.

**Fix.** Put the password and invite controls in their own forms (or handle `keydown` Enter for them), and use `VF.copyText`.

### R1-15 Content spoofing on the sign-in page

`A.init` copies `?error_description=` (or `?error=`) into the sign-in error box (`js/auth.js:52-56`), and `friendly()` passes unknown text through unchanged (`js/auth.js:41`). It is escaped, so it can't run code, but any text can be shown on the official page.

**Evidence.** `qa1/spoof.js` shows "Your account is suspended. To restore it, send GHS 50 by MoMo to 024 000 0000 and reply with your password." in the error box. The URL is then cleaned, which hides how the text got there.

**Fix.** Map known Supabase error codes to fixed messages and show a generic "That sign-in link didn't work. Request a new one." for anything else.

### R1-16 The service worker caches one-time URLs

The fetch handler caches every successful same-origin GET under its full URL, query string included (`sw.js:10-16`). This includes navigations that carry the Supabase PKCE `?code=` and the Smartcar `?user_id=…&state=…`. Nothing clears the cache at sign-out.

**Evidence.** `qa1/swcache.js` lists these cache entries:

```
voltfleet-os-v21 http://localhost:8080/?code=0d9a7c1e-one-time-auth-code
voltfleet-os-v21 http://localhost:8080/?user_id=8b1f2c3d-smartcar-user&state=abcDEF123456789012345
```

**Impact.** Identifiers that should be short-lived stay on the device (R1-10). The cache also grows with every query-string variant.

**Fix.**
- Cache navigations under `index.html` only (`request.mode === 'navigate'` → put under `'./'`), and ignore query strings for static assets.
- Never cache URLs with `code`, `state`, `user_id`, `error*` or `token` parameters.
- Clear the cache in `A.signOut`.

### R1-17 Two-factor sign-in gaps

**Password-only enrolment.** Staff must enrol TOTP on first sign-in (`js/auth.js:81`). Supabase allows enrolment at `aal1` while an account has no verified factor, so until the real owner enrols, anyone holding the password can enrol their own authenticator and reach `aal2`. This applies to new staff, invited colleagues, and anyone after the documented "lost phone" reset (`docs/accounts.md`).

**UI-only rule.** `docs/accounts.md` says the last device of a staff account can't be removed. Only the button's `disabled` attribute enforces this (`js/auth.js:311`), so `sb.auth.mfa.unenroll()` from the console removes it. The person then locks themselves out of the workspace until they re-enrol, which reopens the password-only window above.

**Fix.**
- Send staff a one-time enrolment link by email (or require a fresh email OTP before the first enrolment).
- Make the documented reset issue that link instead of just deleting factors.
- If you keep the "last device" rule, enforce it with a server-side check (for example a trigger on `auth.mfa_factors`) or remove the claim from the docs.

---

## Checked and OK

- **Stored XSS:** the existing probe (`xss.js`) plants payloads in 407 text fields and renders every page in all five roles. All clean.
- **Tampered saved state:** `sanit.js` confirms ids, HTML and prototype keys are neutralised. Its CSV check prints FAIL only because the test expects `'=` at position 0; the cell is correctly quoted as `"'=HYPERLINK(…)"`, so the guard works.
- **Scripts and the CSP:** no CSP violations in any role (`csp.js`), and the CSP blocks injected inline scripts (axe could only be injected through DevTools evaluate). No `javascript:` or data-driven `href` or `src` found: all `href` and `src` interpolations are constants or escaped `https` URLs.
- **Privacy of connected vehicles:** a connected (Smartcar) vehicle with name, VIN and location ran for 600 simulated seconds across 14 manager pages and its own detail page. No marker reached `VF.stateJSON` (`qa1/realleak.js`), so real vehicles stay on the device.
- **Database grants and RLS (live):**
  - RLS is on for all six public tables, with select-only policies.
  - `anon` has no SELECT on account tables and only SELECT on `worlds`.
  - Neither `anon` nor `authenticated` can INSERT, UPDATE or DELETE any table.
  - `audit`, `clean_text`, `handle_new_user` and `require_mfa` can't be called by clients.
  - Every account function derives the organisation from `auth.uid()`.
  - Every staff data path checks `mfa_ok()`. Only the harmless `mfa_ok()` is anon-executable.
- **Supabase advisors:** the security warnings list only the intentionally callable `SECURITY DEFINER` functions. Performance shows minor items: two unindexed foreign keys and `auth.uid()` per row in the `profiles` policy.
- **Organisation isolation:** `org_worlds`, `organizations`, `profiles`, `org_invites` and `audit_log` reads are all keyed to `my_org()`. `remove_member` and `revoke_invite` check that the target is in the caller's organisation, and roles can't be set from the browser.
- **Sign-in flows:** `t20.js`, 26 checks, all pass: 2FA enrolment and verification, invite join, sign-out wipes the workspace copy, session survives reload, phone layout.
- **Phone layout:** no horizontal overflow at 393 px on any page of any role, and no page errors (`qa1/mobile.js`).
- **Edge Functions:** secrets are random and stored hashed with constant-time comparison. Inputs (`CP_ID`, keys, OCPP command payloads) are checked against strict patterns. Network-key checks hold for every management action (`own()`). Smartcar commands check that the vehicle belongs to the caller. Both functions are deployed with `verify_jwt: false`, as their design requires.
- **Repository:** no secrets in the repo (`js/config.js` holds only the publishable key). Vendored libraries have fixed versions, and the service worker's precache list matches files on disk.

**Still open from the earlier review** (not re-reported): C (keys in localStorage), D (`?key=` OCPP passwords), E (`ALLOWED_ORIGINS` not verifiable without secrets; the code default still includes `http://localhost:8080`), F (Actions pinned by tag in `.github/workflows/pages.yml`), G (no security headers on Pages).

**Minor notes:** `connect-src` in the production CSP still allows `ws://localhost:8788`. The repository is public and Pages deploys the whole repository (`path: .`), so this report and `docs/security-review.md` will be published at `/docs/…` when pushed.

## Test scripts (session scratchpad, not in the repo)

`/tmp/claude-0/-home-user-voltfleet-os/b0830beb-4ffd-549e-aec9-8a2e2175a44d/scratchpad/qa1/`:

| Script | Finding |
| --- | --- |
| `signin-to-org.js`, `demo-to-org.js` (with `fake-both.js`) | R1-01 |
| `sync-stuck.js`, `sync-freeze.js` (with `fake-sync.js`) | R1-02 |
| `sync-race.js` | R1-03 |
| `frame.js` (with `evil/frame.html`, served on port 8091) | R1-05 |
| `perf.js` | R1-09 |
| `a11y.js` (axe-core installed in `qa1/axe/`) | R1-11 |
| `cssinj.js` | R1-12 |
| `mobile.js` | R1-13 |
| `acct-enter.js` | R1-14 |
| `spoof.js` | R1-15 |
| `swcache.js` | R1-16 |
| `realleak.js` | Checked and OK |
