// R4-01 before/after: a car connected while signed in; then sign out and open the demo on the same browser.
//   node qa4/signout-probe.js [base]   Uses only APIs present in both the committed and the new code.
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright');
const fs = require('fs');
const FAKE = fs.readFileSync(FIX + '/fake-supabase.js', 'utf8');
const BASE = process.argv[2] || 'http://localhost:8080';
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ serviceWorkers: 'block' }); const q = await ctx.newPage(); const calls = [];
  await q.route(/supabase-2\.118\.0\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE }));
  await q.route(/supabase\.co|fonts\.g|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await q.route(/functions\/v1\/smartcar/, async (r) => { const body = JSON.parse(r.request().postData() || '{}'); calls.push(body.action); await r.fulfill({ contentType: 'application/json', body: JSON.stringify(body.action === 'vehicles' ? { vehicles: [{ id: 'veh1', info: { make: 'BYD', model: 'Atto 3' }, summary: { lat: 5.6037, lon: -0.187, soc: 50 }, fetchedAt: Date.now() }] } : { ok: true }) }); });
  await q.goto(BASE + '/'); await q.waitForTimeout(900);
  await q.click('[data-act="auth-mode"][data-k="signup"]'); await q.waitForTimeout(250); await q.click('[data-act="auth-type"][data-k="driver"]'); await q.waitForTimeout(200);
  await q.fill('#auth-signup [name=fullname]', 'Yaw Boateng'); await q.fill('#auth-signup [name=email]', 'yaw@r4.example'); await q.fill('#auth-signup [name=password]', 'correct-horse-battery'); await q.check('#auth-signup [name=agree]');
  await q.click('#auth-signup button[type=submit]'); await q.waitForTimeout(500);
  await q.evaluate(() => { const db = JSON.parse(localStorage.getItem('fake-sb-db')); for (const u of Object.values(db.users)) u.confirmed = true; localStorage.setItem('fake-sb-db', JSON.stringify(db)); });
  await q.click('[data-act="auth-mode"][data-k="signin"]'); await q.waitForTimeout(200);
  await q.fill('#auth-signin [name=email]', 'yaw@r4.example'); await q.fill('#auth-signin [name=password]', 'correct-horse-battery'); await q.click('#auth-signin button[type=submit]'); await q.waitForTimeout(2200);
  await q.evaluate(async () => { if (VF.real.sync) VF.real.sync(); VF.real.key = 'sc-key-yaw'; await VF.real.poll(true); });
  await q.evaluate(() => VF.auth.signOut(false)); await q.waitForTimeout(2500);
  await q.goto(BASE + '/?demo'); await q.waitForTimeout(1200);
  await q.click('[data-role="manager"]'); await q.click('.demo-acct:not([disabled])'); await q.waitForTimeout(1500);
  const r = await q.evaluate(() => ({ stored: /sc-key-yaw/.test(localStorage.getItem('voltfleet-os:smartcar') || ''), location: /5\.6037/.test(localStorage.getItem('voltfleet-os:smartcar') || ''), demoKey: VF.real.key, carInDemoFleet: VF.state.fleet.vehicles.some((v) => v.real) }));
  console.log(JSON.stringify(Object.assign(r, { serverCalls: calls })));
  const leak = r.stored || r.location || r.carInDemoFleet || r.demoKey;
  console.log((leak ? 'FAIL' : 'PASS') + ' after sign-out the next person (demo) gets no key, reading or car of the account; disconnect sent: ' + calls.includes('disconnect'));
  await b.close();
})();
