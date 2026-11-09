# Real accounts (Supabase Auth)

VoltFleet now has real sign-in next to the public demo.

## How it works

| What | How |
| --- | --- |
| Sign in | Email and password, or a one-time email link. Phone codes appear automatically once an SMS provider is switched on in Supabase. |
| Create an account | Pick a type (fleet, charge-point operator, driver, developer), add name, organisation, email and password (10+ characters), then confirm the email. |
| Organisations | The server creates one organisation per new account and sets the role: fleet → manager, operator → operator, developer → developer, driver → driver. The browser can never set a role. |
| Private workspace | Each organisation's data lives in its own row of `public.org_worlds`. Row-level security lets only its members read it, and only server functions (which work out the organisation from the signed-in user) can write it. The demo stays in the public `worlds` row. |
| Team | Organisation admins invite colleagues by email under **avatar → Account & team**. People join when they sign up with that email and confirm it, so an unconfirmed email can't take an invite. Admins can remove members and revoke invites. |
| Your rights | **Account & team** lets you change your name and password, sign out on every device, and delete your account (erasure). An organisation with no members left is deleted with its workspace. |
| Audit | Account events (organisation created, invites, removals, deletions) go to `public.audit_log`. Org admins see the latest under **Account & team**. |
| Two-factor sign-in | Staff accounts (fleet managers, operators, developers, platform admins) must use an authenticator app (TOTP): they set it up right after their first sign-in, then enter a 6-digit code each time. The database enforces it: until a session has the second factor (`aal2`), staff can't read or change the workspace, team, invites or audit log, or delete the account. Drivers can turn it on under **Account & team**. People can add a backup device, and the last device of a staff account can't be removed. |
| Shared devices | Signing out removes the workspace copy from the browser. |

The code is in `js/auth.js` (screens, session, workspace switch, account panel) and `js/cloud.js` (syncs either the demo or your organisation). The server side is `supabase/migrations/20261108_accounts.sql`, already applied to the live project.

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

- **Lost phone:** after you've confirmed who the person is (for example a call to a known number, or their manager vouching), reset their authenticator in the Supabase SQL editor. They'll be asked to set up a new one at their next sign-in:

  ```sql
  delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'person@company.com');
  ```
- **Settings:** TOTP is on by default in Supabase (**Authentication → Multi-Factor**). Keep "TOTP enroll" and "TOTP verify" enabled. Phone-based MFA isn't needed.
- **Database rules:** `supabase/migrations/20261109_mfa.sql` (applied).

## What's next

- Single sign-on (SAML) for large customers.
- Real tables per data type (vehicles, sessions, bookings) instead of one workspace snapshot per organisation, so every change is checked row by row and you get finer roles (for example read-only analysts).
