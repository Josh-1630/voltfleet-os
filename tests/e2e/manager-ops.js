const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium, devices } = require('playwright');
const out = OUT;
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const open = async (opts) => {
    const ctx = await b.newContext(opts); const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message + ' ' + (e.stack || '').split('\n')[1]));
    p.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED|status of 4|net::/.test(m.text())) errs.push(m.text()); });
    await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
    await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(400);
    await p.click('[data-role="manager"]'); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1500);
    return { ctx, p };
  };
  const go = async (p, h) => { await p.evaluate((x) => { location.hash = x; }, h); await p.waitForTimeout(2200); };
  let { ctx, p } = await open({ viewport: { width: 1440, height: 1000 } });
  ok((await p.$$('.intel-tile')).length === 4, 'dashboard: intelligence strip');
  ok((await p.$$('.nav a[href="#m-smart"], [href="#m-smart"]')).length > 0, 'nav: smart charging link');
  // Engine sanity
  const eng = await p.evaluate(() => { const pl = VF.intel.plan(); const h = VF.intel.health(); const r = VF.intel.optimizeRoutes(); const v = VF.intel.v2g(); const roi = VF.intel.roi();
    return { cost: pl.cost, base: pl.costBase, pct: pl.savingsPct, ready: pl.ready, total: pl.total, peak: pl.peak, peakBase: pl.peakBase, green: pl.greenPct, flagged: h.flagged.length, score: h.score, routes: r.routes.length, km: r.km, bkm: r.base.km, onTime: r.onTime, bOn: r.base.onTime, un: r.unassigned.length, v2gOut: v.out, v2gNet: v.net, enrolled: v.enrolled, eNow: roi.energyNow, eNext: roi.energyNext, up: [roi.uptimeNow, roi.uptimeNext], hour: VF.hourOf(VF.now()) }; });
  console.log('INFO', JSON.stringify(eng));
  ok(eng.cost < eng.base && eng.total > 10, `smart plan cheaper than baseline (${eng.pct.toFixed(1)}%)`);
  ok(eng.peak <= eng.peakBase + 0.01, 'smart plan peak <= baseline');
  ok(eng.flagged > 0 && eng.flagged < 30, `health flags (${eng.flagged})`);
  ok(eng.routes > 0 && eng.km <= eng.bkm, `routes optimised (${eng.km.toFixed(0)} vs ${eng.bkm.toFixed(0)})`);
  for (const pg of ['m-smart', 'm-health', 'm-routes', 'm-v2g', 'm-impact']) {
    await go(p, pg);
    const h1 = await p.textContent('.view h1, .topbar h1, h1').catch(() => '');
    const charts = await p.$$eval('.chart-slot', (s) => s.map((x) => x.innerHTML.length));
    ok(charts.every((n) => n > 50), `${pg}: charts drawn (${charts.join(',')}) title=${(h1 || '').trim()}`);
    await p.screenshot({ path: `${out}/i-${pg}.png`, fullPage: true });
  }
  // Interactions
  await go(p, 'm-smart');
  await p.click('[data-act="i-strategy"][data-k="green"]'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => VF.state.fleet.intel.strategy === 'green'), 'strategy switch');
  await p.click('[data-act="i-apply"]'); await p.waitForTimeout(300); await p.click('#dlg-ok'); await p.waitForTimeout(500);
  ok(await p.evaluate(() => !!VF.state.fleet.intel.applied), 'apply plan');
  await go(p, 'm-health');
  const hasBook = await p.$('[data-act="i-book"]');
  if (hasBook) { await hasBook.click(); await p.waitForTimeout(300); await p.click('#dlg-form button[type="submit"]'); await p.waitForTimeout(500); }
  ok(await p.evaluate(() => VF.state.fleet.intel.workOrders.length === 1), 'book service creates work order');
  await p.click('[data-act="i-wo-done"]'); await p.waitForTimeout(500);
  ok(await p.evaluate(() => VF.state.fleet.intel.workOrders[0].status === 'done' && Object.keys(VF.state.fleet.intel.fixed).length === 1), 'complete work order');
  await go(p, 'm-routes');
  await p.click('label.chip.toggle:has(input[data-k="traffic"])'); await p.waitForTimeout(500);
  ok(await p.evaluate(() => VF.state.fleet.intel.factors.traffic === false), 'factor toggle');
  const rs = await p.$$('[data-act="i-rsel"]'); if (rs[1]) { await rs[1].click(); await p.waitForTimeout(400); }
  ok(!!(await p.$('.rt-list li.on')), 'route select');
  const disp = await p.$('.view [data-act="i-dispatch"]');
  if (disp) { await disp.click(); await p.waitForTimeout(300); await p.click('#dlg-ok'); await p.waitForTimeout(600); }
  ok(await p.evaluate(() => !!VF.state.fleet.intel.routesDispatched), 'dispatch/approve routes');
  await go(p, 'm-v2g');
  await p.click('[data-act="i-event"]'); await p.waitForTimeout(300); await p.click('#dlg-ok'); await p.waitForTimeout(2500);
  const ev = await p.evaluate(() => ({ e: VF.state.fleet.intel.event, live: !!document.querySelector('.v2g-live.on') }));
  ok(ev.live && ev.e.kwh >= 0, `grid event live (kWh ${ev.e && ev.e.kwh && ev.e.kwh.toFixed(2)})`);
  await p.screenshot({ path: `${out}/i-v2g-event.png` });
  await p.click('[data-act="i-event-stop"]'); await p.waitForTimeout(800);
  await go(p, 'm-impact');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-act="i-esg-csv"]')]);
  ok(/esg/.test(dl.suggestedFilename()), 'ESG export ' + dl.suggestedFilename());
  await p.click('[data-act="i-scale"][data-k="10000"]'); await p.waitForTimeout(300);
  // dark theme
  await p.evaluate(() => VF.theme.set('dark')); await go(p, 'm-smart'); await p.screenshot({ path: `${out}/i-smart-dark.png` }); await p.evaluate(() => VF.theme.set('light'));
  await go(p, 'm-dashboard'); await p.screenshot({ path: `${out}/i-dash.png` });
  await ctx.close();
  ({ ctx, p } = await open({ ...devices['iPhone 13'] }));
  for (const pg of ['m-smart', 'm-health', 'm-routes', 'm-v2g', 'm-impact', 'm-dashboard']) {
    await go(p, pg); const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok(over <= 0, `${pg}: no horizontal scroll on phone (${over})`);
    await p.screenshot({ path: `${out}/i-phone-${pg}.png`, fullPage: pg !== 'm-dashboard' });
  }
  console.log('errors:', errs.length ? errs.join('\n') : 'none'); await b.close();
})();
