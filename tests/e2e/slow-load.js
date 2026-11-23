// A slow connection: the app's last scripts arrive seconds after the first ones, so timers started by early
// modules fire before later modules exist. Found under load in CI ("VF.route is not a function" from ocpp.js).
const { ROOT, FIX, OUT } = require('../lib.cjs');
const { chromium } = require('playwright');
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(); const p = await (await b.newContext({ serviceWorkers: 'block' })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.route(/supabase\.co|cartocdn|osrm|wikipedia|wikimedia|open-meteo|fonts\.g/, (r) => r.abort());
  await p.route(/\/js\/app\.js/, async (r) => { await new Promise((done) => setTimeout(done, 2500)); r.continue(); });
  await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(4500);
  ok(errs.length === 0, 'no errors while the last script is still downloading' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  ok(await p.evaluate(() => !!document.querySelector('[data-role="manager"]')), 'the app starts once it arrives');
  await b.close();
})();
