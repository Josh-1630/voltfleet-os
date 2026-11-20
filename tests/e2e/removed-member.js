// R2-02: a person removed from the team stops seeing the workspace and its local copy is wiped.
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright'); const fs = require('fs');
const FAKE = fs.readFileSync(FIX + '/fake-supabase.js', 'utf8');
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ serviceWorkers: 'block' }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.route(/supabase-2\.118\.0\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE }));
  await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await p.goto('http://localhost:8080/'); await p.waitForTimeout(900);
  await p.evaluate(() => localStorage.setItem('fake-autoconfirm', '1'));
  await p.click('[data-act="auth-mode"][data-k="signup"]'); await p.click('[data-act="auth-type"][data-k="driver"]');
  await p.fill('#auth-signup [name=fullname]', 'Esi Driver'); await p.fill('#auth-signup [name=email]', 'esi@example.com'); await p.fill('#auth-signup [name=password]', 'original-password-1');
  await p.check('#auth-signup [name=agree]'); await p.click('#auth-signup button[type=submit]'); await p.waitForTimeout(2500);
  ok(await p.evaluate(() => VF.mode === 'account' && Object.keys(localStorage).some((k) => k.startsWith('voltfleet-os:org:'))), 'signed in, workspace copy on this device');
  await p.evaluate(() => { const db = JSON.parse(localStorage.getItem('fake-sb-db')); for (const pr of Object.values(db.profiles)) { pr.org_id = null; pr.role = 'pending'; } localStorage.setItem('fake-sb-db', JSON.stringify(db)); });
  await p.waitForTimeout(9000);
  const st = await p.evaluate(() => ({ signin: !!document.querySelector('.auth'), orgKeys: Object.keys(localStorage).filter((k) => k.startsWith('voltfleet-os:org:')).length }));
  ok(st.signin && st.orgKeys === 0, 'after removal: back on the sign-in page, workspace copy wiped ' + JSON.stringify(st));
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
})();
