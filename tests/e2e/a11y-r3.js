// QA round 3: axe (WCAG 2 A/AA) on the screens this round added or changed: "Confirm it's you" (R1-17), the developer
// credentials with a one-time secret (R2-07), the driver station sheet risk bar, light and dark.
const { ROOT, FIX, OUT, AXE: AXE_FILE } = require('../lib.cjs');
if (!AXE_FILE) { console.log('FAIL axe-core not found: npm install (tests/package.json) or set AXE_PATH'); process.exit(1); }
const { chromium } = require('playwright'); const fs = require('fs');
const AXE = fs.readFileSync(AXE_FILE, 'utf8');
const FAKE = fs.readFileSync(FIX + '/fake-supabase.js', 'utf8');
(async () => {
  const b = await chromium.launch(); const found = [];
  const run = async (p, where) => {
    if (!(await p.evaluate(() => !!window.axe))) await p.evaluate(AXE);
    const r = await p.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'], resultTypes: ['violations'] })).violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0].target.join(' ')}`));
    console.log(where + ': ' + (r.length ? r.join(' | ') : 'no violations')); found.push(...r);
  };
  for (const theme of ['light', 'dark']) {
    const p = await (await b.newContext({ serviceWorkers: 'block' })).newPage();
    await p.route(/supabase-2\.118\.0\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE }));
    await p.route(/supabase\.co|fonts\.g|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
    await p.addInitScript((t) => { try { localStorage.setItem('fake-r3', '1'); localStorage.setItem('voltfleet-os:theme', t); localStorage.setItem('voltfleet-os:motion', 'reduced'); } catch (e) {} }, theme);
    await p.goto('http://localhost:8080/'); await p.waitForTimeout(800);
    // a confirmed staff account signs in with its password -> "Confirm it's you"
    await p.evaluate(() => { const db = { users: { u1: { id: 'u1', email: 'ama@x.example', password: 'correct-horse-battery', confirmed: true, meta: { account_type: 'fleet', org_name: 'Kumasi Couriers' } } }, profiles: { u1: { id: 'u1', full_name: 'Ama', role: 'pending', org_id: null } }, orgs: {}, invites: [], worlds: {} }; localStorage.setItem('fake-sb-db', JSON.stringify(db)); });
    await p.fill('#auth-signin [name=email]', 'ama@x.example'); await p.fill('#auth-signin [name=password]', 'correct-horse-battery'); await p.click('#auth-signin button[type=submit]'); await p.waitForTimeout(1500);
    const h = await p.textContent('.auth-head h2'); if (!/Confirm/.test(h)) console.log('unexpected screen: ' + h);
    await run(p, theme + ':mfa-email');
    await p.click('#auth-mfa-email button[type=submit]'); await p.waitForTimeout(500); await run(p, theme + ':mfa-email-sent');
    await p.evaluate(() => VF.auth.sb.auth.signOut()); await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(800);
    await p.click('[data-act="auth-mode"][data-k="demo"]').catch(() => {}); await p.waitForTimeout(300);
    await p.click('[data-role="developer"]'); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1200);
    await p.evaluate(() => { location.hash = 'dev-apps'; }); await p.waitForTimeout(900); await p.click('[data-act="dev-rotate"]'); await p.waitForTimeout(500);
    await run(p, theme + ':dev-apps (one-time secret)');
    await p.evaluate(() => VF.signOut()); await p.waitForTimeout(500); await p.click('[data-role="driver"]'); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1200);
    await p.evaluate(() => { VF.ui.driver.sheet = { type: 'station', id: VF.state.stations[0].id }; VF.renderSheet(); }); await p.waitForTimeout(500);
    await run(p, theme + ':driver station sheet');
    await p.close();
  }
  console.log(found.length ? `${found.length} violations` : 'no violations on the round-3 screens');
  await b.close();
})();
