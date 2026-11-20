// Account & team: pressing Enter in "New password" or the invite field submits the outer "Save name" form.
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright'); const fs = require('fs');
const FAKE = fs.readFileSync(FIX + '/fake-supabase.js', 'utf8');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ serviceWorkers: 'block' }); const p = await ctx.newPage();
  await p.route(/supabase-2\.118\.0\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE }));
  await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await p.goto('http://localhost:8080/'); await p.waitForTimeout(800);
  await p.evaluate(() => localStorage.setItem('fake-autoconfirm', '1'));
  await p.click('[data-act="auth-mode"][data-k="signup"]'); await p.click('[data-act="auth-type"][data-k="driver"]');
  await p.fill('#auth-signup [name=fullname]', 'Esi Driver'); await p.fill('#auth-signup [name=email]', 'esi@example.com'); await p.fill('#auth-signup [name=password]', 'original-password-1');
  await p.check('#auth-signup [name=agree]'); await p.click('#auth-signup button[type=submit]'); await p.waitForTimeout(2000);
  await p.evaluate(() => VF.ACT['auth-acct']()); await p.waitForTimeout(800);
  const toasts = []; await p.exposeFunction('__toast', (t) => toasts.push(t)); await p.evaluate(() => { const o = VF.toast; VF.toast = (m) => { window.__toast(m); o(m); }; });
  await p.fill('#acct-new-pass', 'brand-new-password-2'); await p.press('#acct-new-pass', 'Enter'); await p.waitForTimeout(800);
  const pw = await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('fake-sb-db')).users)[0].password);
  console.log('after Enter in New password -> toasts:', JSON.stringify(toasts), '| dialog open:', await p.evaluate(() => !document.getElementById('dialog').hidden), '| stored password changed:', pw === 'brand-new-password-2');
  await b.close();
})();
