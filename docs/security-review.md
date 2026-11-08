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
| 5 | Clickjacking (the app could be framed by another site) | Medium | **Fixed** (frame guard) |
| 6 | Smartcar sign-in accepted a missing `state` check | Low | **Fixed** |
| 7 | Links from the Wikipedia API not restricted to https | Low | **Fixed** |
| 8 | Prototype pollution from tampered saved data | Low | **Fixed** |
| 9 | Sign-in page said demo data "stays in this browser" (it's shared) | Privacy | **Fixed** (accurate warning) |
| A | No real sign-in: roles are chosen in the browser | Critical for production | Open: architecture work |
| B | Shared demo world is readable by anyone with the public key | High for production | Open: same fix as A |
| C | Device keys held in localStorage | Medium | Mitigated by CSP; fix with A |
| D | OCPP password accepted in the URL (`?key=`) | Medium | Open: production setting |
| E | Edge Functions allow `http://localhost:8080` in CORS | Low | Open: one secret to set |
| F | GitHub Actions pinned by tag, not commit SHA | Low | Open |
| G | GitHub Pages can't send security headers | Low | Open: hosting choice |

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

## Open items and how to fix them

**A. Real sign-in and server-side authorisation (Critical before real customers).** Today anyone can choose any role, including Admin. Role checks run only in the browser, and the simulation runs in visitors' browsers. Before production:
- **Sign-in:** Supabase Auth. Phone OTP for drivers; email with MFA, or SSO, for fleet, operator and admin staff.
- **Roles and tenancy:** roles and organisation id in JWT `app_metadata`, set only by the server.
- **Data:** replace the single shared world with normal tables per organisation (vehicles, sessions, bookings, drivers) protected by RLS policies that check `auth.uid()` and organisation, and make admin actions (revealing personal data, taking stations offline) server-side functions that check the role and write the audit log.
- **Simulation:** run it on the server, or remove it, so clients only send intents.

**B. Public demo data.** Until A is done, anything typed into the demo is readable by anyone with the public key. The sign-in page now warns about this. Don't use the demo with real drivers' data.

**C. Keys in browser storage.** The Smartcar device key and the OCPP network key sit in `localStorage`, where an XSS bug could read them. The CSP makes that much harder. With A, move them to HttpOnly, Secure, SameSite cookies or server-side sessions.

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
- Confirm retention periods.
- Have a lawyer review consent texts.

## Re-running the checks

The test scripts used here live in the session scratchpad and aren't in the repository. To keep these checks, add a stored-XSS probe (plant payloads in every text field, render every page per role, fail on any injected element) and a CSP-violation check to CI, and run Supabase's security advisor after every database change.
