// Real sign-in flows against the in-memory Supabase stand-in.
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium, devices } = require('playwright');
const fs = require('fs');
const FAKE = fs.readFileSync(FIX + '/fake-supabase.js', 'utf8');
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: 'block' }); const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' ')));
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_|status of 4|net::|offline \(test\)/.test(m.text())) errs.push(m.text()); });
  await p.route(/supabase-2\.118\.0\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE }));
  await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  const wait = (ms) => p.waitForTimeout(ms);
  await p.goto('http://localhost:8080/'); await wait(900);
  ok(await p.isVisible('.auth-tabs') && (await p.textContent('.auth-head h2')).trim() === 'Sign in', 'sign-in screen with tabs');
  await p.screenshot({ path: OUT + '/auth-signin.png' });
  // wrong password
  await p.fill('#auth-signin [name=email]', 'nobody@example.com'); await p.fill('#auth-signin [name=password]', 'whatever123'); await p.click('#auth-signin button[type=submit]'); await wait(400);
  ok((await p.textContent('#auth-error')).includes('Wrong email or password'), 'wrong password message');
  // sign up (email confirmation required)
  await p.click('[data-act="auth-mode"][data-k="signup"]'); await wait(300);
  await p.click('[data-act="auth-type"][data-k="fleet"]');
  await p.fill('#auth-signup [name=fullname]', 'Ama Owusu'); await p.fill('#auth-signup [name=org]', 'Kumasi Couriers'); await p.fill('#auth-signup [name=email]', 'ama@kumasi.example'); await p.fill('#auth-signup [name=password]', 'short');
  await p.check('#auth-signup [name=agree]'); await p.click('#auth-signup button[type=submit]'); await wait(300);
  ok((await p.textContent('#auth-error')).includes('10 characters'), 'password policy enforced');
  await p.fill('#auth-signup [name=password]', 'correct-horse-battery'); await p.click('#auth-signup button[type=submit]'); await wait(500);
  ok((await p.textContent('.auth-head h2')).includes('Check your email'), 'confirmation screen after sign-up');
  await p.screenshot({ path: OUT + '/auth-check.png' });
  // sign in before confirming
  await p.click('[data-act="auth-mode"][data-k="signin"]'); await wait(200);
  await p.fill('#auth-signin [name=email]', 'ama@kumasi.example'); await p.fill('#auth-signin [name=password]', 'correct-horse-battery'); await p.click('#auth-signin button[type=submit]'); await wait(400);
  ok((await p.textContent('#auth-error')).includes('Confirm your email'), 'unconfirmed sign-in blocked');
  // confirm (as if the email link was opened) and sign in
  await p.evaluate(() => { const db = JSON.parse(localStorage.getItem('fake-sb-db')); for (const u of Object.values(db.users)) u.confirmed = true; localStorage.setItem('fake-sb-db', JSON.stringify(db)); });
  await p.click('#auth-signin button[type=submit]'); await wait(1500);
  ok((await p.textContent('.auth-head h2')).includes('Protect your account') && await p.isVisible('.mfa-qr'), 'staff must set up two-factor (QR shown)');
  ok(await p.evaluate(() => VF.mode !== 'account' && !VF.session), 'no workspace before two-factor');
  await p.screenshot({ path: OUT + '/auth-mfa-enroll.png' });
  await p.fill('#auth-mfa-enroll [name=code]', '000000'); await p.click('#auth-mfa-enroll button[type=submit]'); await wait(500);
  ok((await p.textContent('#auth-error')).includes('didn’t work'), 'wrong code rejected');
  await p.fill('#auth-mfa-enroll [name=code]', '123456'); await p.click('#auth-mfa-enroll button[type=submit]'); await wait(1800);
  const st = await p.evaluate(() => ({ mode: VF.mode, role: VF.user(VF.session.userId).role, name: VF.user(VF.session.userId).name, org: VF.state.fleet.org.name, key: VF.STORE_KEY, hash: location.hash }));
  ok(st.mode === 'account' && st.role === 'manager' && st.name === 'Ama Owusu' && st.org === 'Kumasi Couriers' && /voltfleet-os:org:/.test(st.key), 'signed in to private workspace: ' + JSON.stringify(st));
  await p.screenshot({ path: OUT + '/auth-dashboard.png' });
  // Second sign-in asks for the code
  await p.evaluate(() => VF.auth.sb.auth.signOut()); await p.goto('http://localhost:8080/'); await wait(1200);
  await p.fill('#auth-signin [name=email]', 'ama@kumasi.example'); await p.fill('#auth-signin [name=password]', 'correct-horse-battery'); await p.click('#auth-signin button[type=submit]'); await wait(1200);
  ok((await p.textContent('.auth-head h2')).includes('Two-factor sign-in'), 'returning staff asked for code');
  await p.screenshot({ path: OUT + '/auth-mfa.png' });
  await p.fill('#auth-mfa [name=code]', '123456'); await p.click('#auth-mfa button[type=submit]'); await wait(1800);
  ok(await p.evaluate(() => VF.mode === 'account' && VF.user(VF.session.userId).name === 'Ama Owusu'), 'code accepted, back in workspace');
  // Workspace sync to the server
  await p.evaluate(() => { VF.state.fleet.vehicles[0].name = 'Van Marker'; VF.save(); }); await wait(800);
  ok(await p.evaluate(() => { const db = JSON.parse(localStorage.getItem('fake-sb-db')); return Object.values(db.worlds).some((w) => w.rev > 0 && w.state_gz); }), 'workspace saved to the organisation row');
  // Role pages from other roles are refused
  await p.evaluate(() => { location.hash = 'admin-overview'; }); await wait(600);
  ok(!/admin/.test(await p.evaluate(() => location.hash)), 'other role pages refused');
  // Account & team
  await p.click('[data-act="acct-menu"], .acct-btn, #acct-btn').catch(() => {}); await wait(200);
  await p.evaluate(() => VF.ACT['auth-acct']()); await wait(800);
  ok(await p.isVisible('#acct-invite-email'), 'account & team panel');
  await p.fill('#acct-invite-email', 'kofi@kumasi.example'); await p.click('[data-act="acct-invite"]'); await wait(800);
  ok((await p.textContent('.dialog')).includes('kofi@kumasi.example'), 'invite listed');
  ok((await p.textContent('.acct-mfa')).includes('On') && !!(await p.$('[data-act="acct-mfa-remove"][disabled]')), 'account panel: two-factor on, last device protected');
  await p.click('[data-act="acct-mfa-add"]'); await wait(800); await p.fill('#acct-mfa-form [name=code]', '123456'); await p.click('[data-act="acct-mfa-verify"]'); await wait(900);
  ok((await p.$$('[data-act="acct-mfa-remove"]')).length === 2, 'backup authenticator added');
  await p.screenshot({ path: OUT + '/auth-account.png' });
  await p.click('[data-act="dlg-close"]').catch(() => {});
  // Sign out wipes the local workspace copy
  await p.evaluate(() => VF.signOut()); await wait(1800);
  const after = await p.evaluate(() => ({ orgKeys: Object.keys(localStorage).filter((k) => k.startsWith('voltfleet-os:org:')).length, signin: !!document.querySelector('.auth-tabs') }));
  ok(after.orgKeys === 0 && after.signin, 'sign-out returns to sign-in and wipes workspace copy');
  // Invited colleague signs up (autoconfirm) and lands in the same workspace with the saved data
  await p.evaluate(() => localStorage.setItem('fake-autoconfirm', '1'));
  await p.click('[data-act="auth-mode"][data-k="signup"]'); await wait(200);
  await p.fill('#auth-signup [name=fullname]', 'Kofi Mensah'); await p.fill('#auth-signup [name=org]', 'Ignored Org'); await p.fill('#auth-signup [name=email]', 'kofi@kumasi.example'); await p.fill('#auth-signup [name=password]', 'another-good-passphrase'); await p.check('#auth-signup [name=agree]');
  await p.click('#auth-signup button[type=submit]'); await wait(1500);
  // QA round 2 (R1-04): the invitation is offered, never accepted on the person's behalf
  ok((await p.textContent('.auth-head h2')).includes('invited') && (await p.textContent('.invite-list')).includes('Kumasi Couriers') && await p.evaluate(() => VF.mode !== 'account'), 'invitation needs consent: offered, not joined yet');
  await p.screenshot({ path: OUT + '/auth-invite.png' });
  await p.click('[data-act="auth-invite-accept"]'); await wait(1500);
  ok(await p.isVisible('.mfa-qr'), 'invited staff colleague must set up two-factor');
  await p.fill('#auth-mfa-enroll [name=code]', '123456'); await p.click('#auth-mfa-enroll button[type=submit]'); await wait(2000);
  const k = await p.evaluate(() => ({ name: VF.user(VF.session.userId).name, org: VF.state.fleet.org.name, marker: VF.state.fleet.vehicles.some((v) => v.name === 'Van Marker'), uid: VF.session.userId }));
  ok(k.name === 'Kofi Mensah' && k.org === 'Kumasi Couriers' && k.marker && k.uid !== 'u-fm1', 'invited colleague joins the same workspace: ' + JSON.stringify(k));
  await p.evaluate(() => VF.signOut()); await wait(1600);
  // Driver account
  await p.click('[data-act="auth-mode"][data-k="signup"]'); await wait(200); await p.click('[data-act="auth-type"][data-k="driver"]'); await wait(200);
  ok(!(await p.$('#auth-signup [name=org]')), 'driver sign-up has no organisation field');
  await p.fill('#auth-signup [name=fullname]', 'Esi Driver'); await p.fill('#auth-signup [name=email]', 'esi@driver.example'); await p.fill('#auth-signup [name=password]', 'driver-pass-phrase'); await p.check('#auth-signup [name=agree]');
  await p.click('#auth-signup button[type=submit]'); await wait(2200);
  const dr = await p.evaluate(() => ({ role: VF.user(VF.session.userId).role, name: VF.user(VF.session.userId).name, hash: location.hash }));
  ok(dr.role === 'driver' && dr.name === 'Esi Driver' && /driver-/.test(dr.hash), 'driver account lands in driver app: ' + JSON.stringify(dr));
  // Reload keeps the session
  await p.reload(); await wait(2000);
  ok(await p.evaluate(() => VF.mode === 'account' && VF.user(VF.session.userId).name === 'Esi Driver'), 'session survives reload');
  await p.evaluate(() => VF.signOut()); await wait(1500);
  // Demo still available
  await p.click('[data-act="auth-mode"][data-k="demo"]'); await wait(300);
  ok((await p.$$('[data-role]')).length === 5 && (await p.$$('.demo-acct')).length > 0, 'demo tab keeps demo accounts');
  await p.click('.demo-acct'); await wait(1200);
  ok(await p.evaluate(() => VF.mode === 'demo' && VF.STORE_KEY === 'voltfleet-os:v2'), 'demo uses the public demo world');
  // Phone
  const ph = await b.newPage({ ...devices['iPhone 13'], serviceWorkers: 'block' }); await ph.route(/supabase-2\.118\.0\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE })); await ph.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await ph.goto('http://localhost:8080/'); await ph.waitForTimeout(900); await ph.click('[data-act="auth-mode"][data-k="signup"]'); await ph.waitForTimeout(300);
  ok(await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, 'sign-up fits a phone');
  await ph.screenshot({ path: OUT + '/auth-signup-phone.png', fullPage: true });
  console.log('errors:', errs.length ? errs.join('\n') : 'none'); await b.close();
})();
