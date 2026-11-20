const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
  await p.route(/supabase\.co/, (r) => r.abort());
  await p.route(/fonts\.(googleapis|gstatic)/, (r) => r.abort());
  await p.goto('http://localhost:8080/?demo');
  await p.waitForTimeout(800);
  await p.screenshot({ path: process.argv[2] + '/login.png' });
  await p.click('.demo-acct');
  await p.waitForTimeout(1200);
  const pages = ['m-dashboard', 'm-vehicles', 'm-stations', 'm-sessions', 'm-trips', 'm-fleet', 'm-energy', 'm-reports', 'm-notifications', 'm-settings'];
  for (const pg of pages) {
    await p.evaluate((h) => { location.hash = h; }, pg);
    await p.waitForTimeout(700);
    const ow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const t = await p.textContent('#view-title');
    console.log(pg, 'title=', t, 'overflow=', ow);
    await p.screenshot({ path: `${process.argv[2]}/${pg}.png`, fullPage: true });
  }
  await p.evaluate(() => { VF.ACT['m-open-vehicle']({ dataset: { id: 'fv1' } }); });
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${process.argv[2]}/m-vehicle.png`, fullPage: true });
  console.log('errors:', errs.length ? errs.join('\n') : 'none');
  await b.close();
})();
