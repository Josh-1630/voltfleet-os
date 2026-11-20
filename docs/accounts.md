# Real accounts (Supabase Auth)

VoltFleet now has real sign-in next to the public demo.

## How it works

| What | How |
| --- | --- |
| Sign in | Email and password, or a one-time email link. Phone codes appear automatically once an SMS provider is switched on in Supabase. |
| Create an account | Pick a type (fleet, charge-point operator, driver, developer), add name, organisation, email and password (10+ characters), then confirm the email. |
| Organisations | The server creates one organisation per new account and sets the role: fleet → manager, operator → operator, developer → developer, driver → driver. The browser can never set a role. |
| Private workspace | Each organisation's data lives in its own row of `public.org_worlds`. Row-level security lets only its members read it, and only server functions (which work out the organisation from the signed-in user) can write it. The demo stays in the public `worlds` row. |
| Team | Organisation admins invite colleagues by email under **avatar → Account & team**. When someone signs in with that (confirmed) email, they are asked whether to join; nobody is added without accepting, and declining sets up the account they chose at sign-up. Invitations expire after 7 days. The person who created the organisation is its owner: only the owner removes people, and the owner can't be removed. Other members can leave under **Account & team**. Admins revoke invites. |
| Your rights | **Account & team** lets you change your name and password, sign out on every device, and delete your account (erasure). An organisation with no members left is deleted with its workspace. Erasure also removes your email address from invitations and the audit log, and your name and contact details from the team's workspace. Leaving or being removed takes your contact details out of it. |
| Audit | Account events (organisation created, invites, removals, deletions, authenticators confirmed) go to `public.audit_log`. So do the in-app security events of a team workspace (revealing personal data, exports, consent changes, key rotation, remote commands…), through `record_event`: members can read the log but nobody can change or delete entries. Org admins see the latest under **Account & team**. |
| Sign-up limits | One person can't use up sign-ups for everyone: at most 3 organisations a day per account, 3 an hour per mailbox (plus-address and Gmail dot variants count as one), 30 an hour per company email domain, and 300 an hour in total. The counters keep only one-way hashes, for 48 hours. Platform admins see sign-ups in the last hour against that ceiling. |
| Two-factor sign-in | Staff accounts (fleet managers, operators, developers, platform admins) must use an authenticator app (TOTP): they set it up right after their first sign-in, then enter a 6-digit code each time. The database enforces it: until a session has the second factor (`aal2`), staff can't read or change the workspace, team, invites or audit log, or delete the account. A password alone can't add an authenticator that counts: the first one is set up from a session opened with an emailed sign-in link (or the confirmation link), and an authenticator added any other way stays "unconfirmed" and opens nothing until the person confirms it from such a link. A backup device added from **Account & team** is confirmed by the authenticator already in use. Drivers can turn two-factor on under **Account & team**. The app won't remove the last device of a staff account; if it is removed some other way, setting up a new one needs the emailed link again. |
| Shared devices | Signing out removes the workspace copy from the browser. It also disconnects any car connected through Smartcar in that account, and removes its key and last location. Keys held by the browser (Smartcar, OCPP network) are kept per account, so another account or the demo on the same browser never sees them. |
| Retention | The server deletes or reduces old data on its own (`20261119_retention.sql`; periods in `docs/qa/round-4.md`): charging transactions are kept 6 years as billing records, with card numbers masked after 90 days; vehicle readings 30 days; the audit log 7 years, without email addresses after the first year; finished invitations 30 days. |

The code is in `js/auth.js` (screens, session, workspace switch, account panel) and `js/cloud.js` (syncs either the demo or your organisation). The server side is `supabase/migrations/20261108_accounts.sql`, with invitations and ownership in `20261116_invites_owner.sql` and conflict-safe sync in `20261116_sync_cas.sql` (all applied to the live project), plus the QA round 3 files `20261117_signup_limits.sql`, `20261117_mfa_trust.sql`, `20261117_audit_events.sql`, `20261117_world_heads.sql` and `20261117_edge_limits.sql` (see `docs/qa/round-3.md` for the order), and the QA round 4 file `20261119_retention.sql` (`docs/qa/round-4.md`).

## Settings to change in the Supabase dashboard (needed before inviting real users)

1. **Authentication → URL Configuration**
   - **Site URL:** `https://voltfleetos.com` (or `https://josh-1630.github.io/voltfleet-os/` until the domain is live).
   - **Redirect URLs:** add `https://voltfleetos.com/**`, `https://www.voltfleetos.com/**`, `https://josh-1630.github.io/voltfleet-os/**` and, for testing, `http://localhost:8080/**`.

   Without these, confirmation and sign-in links send people to the wrong address.
2. **Authentication → Emails → SMTP settings:** add your own email provider (for example Resend, Postmark, Brevo or Amazon SES) with a sender like `no-reply@voltfleetos.com`. Supabase's built-in mailer only sends to members of your Supabase team and is heavily rate-limited, so other people won't get confirmation emails until this is set.
3. **Authentication → Emails → Templates:** brand the "Confirm signup", "Magic link" and "Reset password" emails.
4. **Authentication → Sign In / Providers**
   - Set the minimum password length to 10.
   - Switch on leaked-password protection (on plans that offer it).
   - Keep "Confirm email" on.
5. **Optional: phone sign-in.** Under **Providers → Phone**, connect an SMS provider such as Twilio. The app shows "Use my phone number" automatically once it's on.
6. **Make yourself platform admin.** Sign up once, confirm your email, then run this in the SQL editor with your own email:

   ```sql
   with o as (insert into public.organizations (name, kind) values ('VoltFleet platform', 'platform') returning id)
   update public.profiles set role = 'admin', org_id = (select id from o)
   where id = (select id from auth.users where email = 'YOUR-EMAIL-HERE');
   insert into public.org_worlds (org_id) select org_id from public.profiles where role = 'admin' on conflict do nothing;
   ```

   Platform admins see sign-up totals under **Account & team**.

## Two-factor sign-in: support

- **Lost phone:** after you've confirmed who the person is (for example a call to a known number, or their manager vouching), reset their authenticator in the Supabase SQL editor. At their next sign-in they're emailed a one-time link and set up a new one from it, so someone who only knows their password can't take over the reset:

  ```sql
  delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'person@company.com');
  ```
- **"Confirm your authenticator" for someone who didn't add one:** someone knows their password. Have them change it, then remove the unconfirmed authenticator with the same SQL.
- **Settings:** TOTP is on by default in Supabase (**Authentication → Multi-Factor**). Keep "TOTP enroll" and "TOTP verify" enabled. Phone-based MFA isn't needed.
- **Database rules:** `supabase/migrations/20261109_mfa.sql` (applied) and `20261117_mfa_trust.sql` (email-confirmed authenticators). The magic-link email template is used for the confirmation link, so keep it enabled and branded (see step 3 above).

## What's next

- Single sign-on (SAML) for large customers.
- Real tables per data type (vehicles, sessions, bookings) instead of one workspace snapshot per organisation, so every change is checked row by row and you get finer roles (for example read-only analysts). A read-only role isn't offered before that: every member's browser writes the whole workspace snapshot, so "read-only" would only be a promise in the app.
- CAPTCHA on sign-up and sign-in (Turnstile or hCaptcha). The app is ready: set `VOLTFLEET_CAPTCHA` in `js/config.js` and allow the provider in the CSP of `index.html` (the comment in `config.js` lists the exact additions), deploy, and only then enable it under Supabase **Authentication → Attack Protection** with the secret key. In the other order, every sign-in is refused.
- Daily retention: enable pg_cron (**Integrations → Cron**), then run `20261119_retention.sql` again to schedule it. Without it, the purge still runs at most hourly whenever there is account activity or Edge Function traffic.
