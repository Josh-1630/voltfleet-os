# VoltFleet OS security review

8 November 2026. Scope: the web app (all five role apps), the Supabase database and its two public functions, the Smartcar and OCPP Edge Functions, the GitHub Pages deployment, and the repository itself.

**Method**
- Read the code and the database configuration.
- Ran Supabase's own security advisor.
- Ran a dynamic stored-XSS probe. It plants attack strings in 407 text fields of the shared data, opens every page, detail view, sheet, popover, search and login screen in all five roles, and reports any injected element or executed code.
- Tested tampered saved state, checked CSV export, and recorded Content Security Policy violations with real network access.

## Summary

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | Stored cross-site scripting through shared demo data | High | **Fixed** |
| 2 | Anyone could write unlimited worlds or flood the shared world | High | **Fixed (limited)**; full fix needs sign-in (see A) |
| 3 | No Content Security Policy; an inline event handler | Medium | **Fixed** |
| 4 | Spreadsheet formula injection in CSV exports | Medium | **Fixed** |
| 5 | Clickjacking (the app could be framed by another site) | Medium | **Fixed** (frame guard; it only took effect in QA round 2, see `docs/qa/round-2.md` R1-05) |
| 6 | Smartcar sign-in accepted a missing `state` check | Low | **Fixed** |
| 7 | Links from the Wikipedia API not restricted to https | Low | **Fixed** |
| 8 | Prototype pollution from tampered saved data | Low | **Fixed** |
| 9 | Sign-in page said demo data "stays in this browser" (it's shared) | Privacy | **Fixed** (accurate warning) |
| A | No real sign-in: roles are chosen in the browser | Critical for production | **Fixed for real accounts** (Supabase Auth, server-set roles, private workspaces with RLS; see `docs/accounts.md`). The public demo stays open by design. |
| B | Shared demo world is readable by anyone with the public key | High for production | **Resolved for customers:** real accounts work in private workspaces; the demo holds sample data only |
| C | Device keys held in localStorage | Medium | Mitigated by CSP; fix with A |
| D | OCPP password accepted in the URL (`?key=`) | Medium | Open: production setting. Set the `OCPP_ALLOW_QUERY_KEY=false` secret once real chargers connect (QA round 3) |
| E | Edge Functions allow `http://localhost:8080` in CORS | Low | Open: one secret to set |
| F | GitHub Actions pinned by tag, not commit SHA | Low | Open |
| G | GitHub Pages can't send security headers | Low | Open on GitHub Pages: hosting choice. `netlify.toml` sets them if the site moves to Netlify |

## Fixed in this release

**1. Stored XSS (High).** Every visitor shares one demo world in Supabase. The button-group component (`C.seg` in `js/ui.js`) put labels into the page without escaping, and depot names reach it on the Smart Charging page. The probe showed planted code running there.
- **Fix:** labels are escaped.
- **Second layer:** every snapshot loaded from the cloud or this device now passes `VF.sanitizeState` (`js/core.js`), which:
  - replaces `< > " ' \``;
  - reduces ids to plain tokens;
  - drops prototype keys.
- **Re-test:** the full probe is clean in all five roles. A tampered saved state (an id with an attribute breakout, `<img onerror>`, `<svg onload>`) renders inert.

**2. Shared world abuse (High → limited).** `world_push` and `world_tick` run as `SECURITY DEFINER` and anyone may call them, by design for the no-login demo. Before this fix they accepted any world id, so anyone could create unlimited 1.5 MB rows, and there was no flood limit. Migration `supabase/migrations/20261108_world_hardening.sql`, applied to the live project:
- only the `demo` world can be written;
- snapshots must be in the app's format and at most 1.5 MB;
- writes are throttled to about 10 a second, and the client retries;
- direct table writes are revoked.

Verified: a write to another world id is refused, and anon has no table INSERT/UPDATE grant.

*Remaining:* anyone can still overwrite the single demo world. Fix 1 and the CSP stop that from becoming code execution; only sign-in can stop the overwrite itself (A).

**3. Content Security Policy (Medium).** There was none, and `js/photos.js` used an inline `onerror`.
- `index.html` now sets a strict CSP: scripts only from this site, no inline scripts or handlers, `object-src 'none'`, `base-uri 'self'`, `frame-src 'none'`, and network access only to the hosts the app uses.
- It also sets a `Referrer-Policy`.
- The photo fallback is now a delegated listener.
- No violations were recorded across all roles with live network access.

**4. CSV injection (Medium).** Exported cells that start with `=`, `+`, `-` or `@` (for example a vehicle named `=HYPERLINK(...)`) could run as formulas in Excel or Sheets. They now get a leading apostrophe; plain numbers are unchanged.

**5. Clickjacking (Medium).** GitHub Pages can't send `frame-ancestors`, so the app now refuses to run inside another site's frame and offers to open in its own window.

**6. Smartcar OAuth state (Low).** If the browser lost the stored `state` (for example a cleared session), the redirect was accepted anyway. It now requires an exact match.

**7. URLs from Wikipedia (Low).** Photo, licence and source links from the API are accepted only as plain `https://` URLs, including links already cached on the device.

**8. Prototype pollution (Low).** `__proto__`, `constructor` and `prototype` keys are dropped from loaded state.

**9. Privacy notice.** The sign-in page now says demo data is shared with every visitor, so people don't type real personal details.

## Checked and fine

**Edge Functions (Smartcar, OCPP)**
- Secrets (device keys, network keys, charger passwords, OAuth states) are generated on the server from `crypto.getRandomValues`, 18–32 bytes.
- They are stored only as SHA-256 hashes and compared in constant time.
- Inputs are checked against strict patterns.
- Connection attempts and network creation are rate-limited.
- The Smartcar client secret lives only in Supabase secrets.

**Database**
- Row-level security is on for `public.worlds`, with read-only access for anonymous users.
- The `private` schema (OCPP, Smartcar) has no grants for `anon` or `authenticated`, so it can't be reached through the API.

**Repository and app**
- No secrets in the repository; `js/config.js` holds only the publishable key.
- Third-party scripts (Leaflet, supabase-js, qrcode) are vendored with fixed versions, not loaded from CDNs.
- The service worker caches only same-origin GET requests.
- Real (Smartcar) vehicles are stripped from every save, so they never reach the shared world.

## Update, 8 November 2026: real accounts

Real sign-in is now in place (`docs/accounts.md`). Each organisation has a private workspace in `public.org_worlds`, readable only by its members through RLS and writable only through server functions that derive the organisation from the signed-in user. Roles are set on the server; invites need a confirmed email; account deletion is self-service.

Tested in the live database with temporary users, removed afterwards:
- anonymous callers can't use the account functions or read profiles;
- unconfirmed accounts can't create organisations or write workspaces;
- one organisation can't see another's workspace, organisation or people;
- direct writes to profiles and invites are refused, so nobody can make themselves admin;
- invites join the right organisation;
- account deletion removes the login.

The Supabase advisor's remaining warnings list functions that signed-in users may call by design; each checks the caller itself.

**9 November 2026:** two-factor sign-in (TOTP) is now required for staff accounts and enforced in the database: RLS policies and server functions check the session's `aal2` level, tested with temporary users (removed afterwards). See `docs/accounts.md`.

**17 November 2026 (QA round 3, `docs/qa/round-3.md`):**
- Staff authenticators only count once confirmed from an emailed link, so a password alone can't reach the team's data (`20261117_mfa_trust.sql`).
- Sign-ups, OCPP networks and Smartcar connections have per-person limits; anonymous traffic can't use up signed-in customers' allowance (`20261117_signup_limits.sql`, `20261117_edge_limits.sql`, both Edge Functions).
- Team workspaces also record security events in the server's append-only audit log (`20261117_audit_events.sql`), and developer app secrets are no longer kept in the shared snapshot.
- Fonts are served by the app itself, so Google no longer receives every visitor's IP address; the CSP no longer allows Google Fonts or `ws://localhost:8788`.
- `netlify.toml` now publishes only the app files and sends the headers of item G, for when the site is served from Netlify.

**20 November 2026 (QA round 4, `docs/qa/round-4.md`):**
- **Retention on the server.** Server data now has retention periods (`20261119_retention.sql`):
  - OCPP transactions are kept 6 years as billing records, with card numbers masked after 90 days; commands 90 days;
  - Smartcar readings (location) 30 days, unused vehicle links 180 days;
  - audit log 7 years, with email addresses removed after 1 year;
  - finished invitations 30 days.
- **Erasure.** Deleting an account also removes the email address from invitations and the audit log, and the person's details from the team workspace.
- **Shared devices.** Signing out disconnects cars connected in that account and removes their key and last location from the browser. Device keys are kept per account, so another account or the demo never loads them.
- **Demo resilience.** A crafted demo snapshot with unknown vehicle models or dangling fleet links can no longer break pages or stop the shared simulation.
- **Billing retention.** The in-app floor is now 6 years (tax records). Retention no longer changes wallet balances.
- **CAPTCHA.** Support for Turnstile or hCaptcha is ready in the app and off until a site key is set (`js/config.js`).

## Open items and how to fix them

**A. Real sign-in and server-side authorisation (Critical before real customers).** Today anyone can choose any role, including Admin. Role checks run only in the browser, and the simulation runs in visitors' browsers. Before production:
- **Sign-in:** Supabase Auth. Phone OTP for drivers; email with MFA, or SSO, for fleet, operator and admin staff.
- **Roles and tenancy:** roles and organisation id in JWT `app_metadata`, set only by the server.
- **Data:** replace the single shared world with normal tables per organisation (vehicles, sessions, bookings, drivers) protected by RLS policies that check `auth.uid()` and organisation, and make admin actions (revealing personal data, taking stations offline) server-side functions that check the role and write the audit log.
- **Simulation:** run it on the server, or remove it, so clients only send intents.

**B. Public demo data.** Until A is done, anything typed into the demo is readable by anyone with the public key. The sign-in page now warns about this. Don't use the demo with real drivers' data.

**C. Keys in browser storage.** The Smartcar device key and the OCPP network key sit in `localStorage`, where an XSS bug could read them. The CSP makes that much harder. Since QA round 4 they are kept per account and the Smartcar key is removed at sign-out. The OCPP key isn't removed, because only its hash exists on the server; a server action that reissues it to the network's creator would allow that. With A, move them to HttpOnly, Secure, SameSite cookies or server-side sessions.

**D. OCPP password in the URL.** `?key=` exists because browsers can't send WebSocket auth headers (the in-app charger simulator needs it). Real chargers should use HTTP Basic auth (OCPP security profile 1 or 2) over TLS, or client certificates (profile 3). Add an `OCPP_ALLOW_QUERY_KEY=false` setting for production so passwords never appear in access logs.

**E. CORS.** Set the `ALLOWED_ORIGINS` secret on both Edge Functions to `https://voltfleetos.com,https://www.voltfleetos.com,https://josh-1630.github.io` so the deployed functions no longer accept `localhost`.

**F. Supply chain.** Pin `actions/checkout`, `configure-pages`, `upload-pages-artifact` and `deploy-pages` to commit SHAs, and turn on Dependabot for GitHub Actions.

**G. Security headers.** GitHub Pages can't send `Strict-Transport-Security` with preload, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options` or `Permissions-Policy`. Serve voltfleetos.com through Cloudflare (free) or Netlify/Cloudflare Pages with these headers set; the app works unchanged.

**H. When payments and messaging go live**
- Verify every provider webhook signature (Mobile Money, SMS, WhatsApp).
- Make payouts idempotent.
- Compute amounts on the server.
- Never collect Mobile Money PINs (the app already doesn't).
- Keep provider keys in server secrets.

**I. Compliance (Ghana)**
- Register with the Data Protection Commission under the Data Protection Act, 2012 (Act 843).
- Complete a data-protection impact assessment for telematics and location.
- Confirm retention periods. The ones now in place are listed in `docs/qa/round-4.md`: 6 years for billing records, under Act 915 as commonly read; Act 843 minimisation for everything else.
- Have a lawyer review consent texts.

## Re-running the checks

The test scripts used here live in the session scratchpad and aren't in the repository. To keep these checks, add a stored-XSS probe (plant payloads in every text field, render every page per role, fail on any injected element) and a CSP-violation check to CI, and run Supabase's security advisor after every database change.
