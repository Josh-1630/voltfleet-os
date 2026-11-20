const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium, devices } = require('playwright');
const out = process.argv[2];
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const page = async (opts, role) => {
    const ctx = await b.newContext(opts); const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED|status of 4/.test(m.text())) errs.push(m.text()); });
    await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia/, (r) => r.abort());
    await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(400);
    await p.click(`[data-role="${role}"]`); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1800);
    return { ctx, p };
  };
  // DRIVER
  let { ctx, p } = await page({ viewport: { width: 1440, height: 960 } }, 'driver');
  ok(await p.isVisible('.d-battery .db-ring'), 'driver: live battery hero');
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('.db-orbit')).animationName === 'orbit'), 'driver: orbit ring turns');
  const s1 = await p.textContent('[data-live="soc"]'); await p.waitForTimeout(3500); const s2 = await p.textContent('[data-live="soc"]');
  ok(await p.evaluate(() => /db-fill/.test(document.querySelector('[data-live="gauge"]').getAttribute('class'))), `driver: ring updates live (${s1} -> ${s2})`);
  ok(!!(await p.$('.progress.road .car-dot')), 'driver: car rides along the trip bar');
  ok(await p.evaluate(() => !!document.querySelector('.aurora')), 'driver: ambient background');
  await p.screenshot({ path: out + '/drv-desktop.png' });
  await p.evaluate(() => { const d = VF.driver(VF.user(VF.session.userId).driverId); const v = VF.driverVehicle(d.id); v.status = 'charging'; VF.rerender(); });
  await p.waitForTimeout(400);
  ok(await p.evaluate(() => document.querySelector('.d-battery').classList.contains('is-charging') && !!document.querySelector('.db-bolt')), 'driver: charging pulse and bolt');
  await ctx.close();
  ({ ctx, p } = await page({ ...devices['iPhone 13'] }, 'driver'));
  ok(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) === 0, 'driver: no horizontal scroll on phone');
  await p.screenshot({ path: out + '/drv-phone.png' });
  await ctx.close();
  // OPERATOR
  ({ ctx, p } = await page({ viewport: { width: 1440, height: 960 } }, 'operator'));
  ok(await p.isVisible('.op-hero .op-flow'), 'operator: network live hero');
  ok((await p.$$('.op-flow .st-node')).length >= 3, `operator: station nodes (${(await p.$$('.op-flow .st-node')).length})`);
  ok((await p.$$('.op-flow .fp')).length > 0, `operator: energy particles (${(await p.$$('.op-flow .fp')).length})`);
  ok((await p.$$('.op-kpis .stat-card')).length === 6 && (await p.$$('.op-kpis .spark-tile')).length === 2 && !!(await p.$('.bars-tile')) && !!(await p.$('.dots-tile.wide')), 'operator: bento tiles with graphics');
  ok(await p.isVisible('.ticker .tk'), 'operator: live ticker');
  ok((await p.$$('.st-meter')).length >= 3 && (await p.$$('.conn-row.is-charging')).length > 0, 'operator: station load meters and charging rows');
  const l1 = await p.textContent('[data-live="op-hload"]'); await p.waitForTimeout(4000); const l2 = await p.textContent('[data-live="op-hload"]');
  console.log(`INFO operator load ${l1} -> ${l2} kW`);
  await p.screenshot({ path: out + '/op-desktop.png' });
  await p.evaluate(() => VF.theme.set('dark')); await p.waitForTimeout(500); await p.screenshot({ path: out + '/op-dark.png' }); await p.evaluate(() => VF.theme.set('light'));
  await p.evaluate(() => { VF.motion.set('reduced'); VF.rerender(); }); await p.waitForTimeout(300);
  ok((await p.$$('.op-flow .fp')).length === 0, 'operator: Reduced motion stops particles');
  await p.evaluate(() => VF.motion.set('full'));
  for (const pg of ['op-stations', 'op-bookings', 'op-pricing', 'op-reports', 'op-alerts', 'op-ocpp']) { await p.evaluate((h) => { location.hash = h; }, pg); await p.waitForTimeout(400); }
  await ctx.close();
  ({ ctx, p } = await page({ ...devices['iPhone 13'] }, 'operator'));
  ok(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) === 0, 'operator: no horizontal scroll on phone');
  await p.screenshot({ path: out + '/op-phone.png' });
  console.log('errors:', errs.length ? errs.join('\n') : 'none'); await b.close();
})();
