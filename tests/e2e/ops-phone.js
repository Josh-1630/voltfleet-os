const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium, devices } = require('playwright');
const out = OUT;
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const open = async (opts) => {
    const ctx = await b.newContext(opts); const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' ')));
    p.on('console', (m) => { if (m.type() === 'error' && !/ERR_|status of 4|net::/.test(m.text())) errs.push(m.text()); });
    await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
    await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(400);
    await p.click('[data-role="manager"]'); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1500);
    return { ctx, p };
  };
  const go = async (p, h, w) => { await p.evaluate((x) => { location.hash = x; }, h); await p.waitForTimeout(w || 2200); };
  let { ctx, p } = await open({ viewport: { width: 1440, height: 1000 } });
  for (const pg of ['m-tower', 'm-drivers', 'm-electrify', 'm-finance', 'm-alerts', 'm-smart', 'm-routes']) {
    await go(p, pg); const h1 = (await p.textContent('h1').catch(() => '')).trim();
    ok((await p.$$('.stat-card')).length >= 4, `${pg}: renders (${h1})`);
    await p.screenshot({ path: `${out}/v3-${pg}.png`, fullPage: true });
  }
  // Outage flow
  await go(p, 'm-tower');
  await p.click('[data-act="o-outage"][data-id="dp2"]'); await p.waitForTimeout(300); await p.click('#dlg-ok'); await p.waitForTimeout(1200);
  const o = await p.evaluate(() => ({ down: !VF.state.fleet.ops.grid.dp2.up, ex: VF.ops.exceptions().some((x) => /outage/i.test(x.title)), ob: VF.state.fleet.ops.outbox.filter((m) => m.type === 'outage').length, plan: VF.intel.plan().depots.find((d) => d.depotId === 'dp2').slots.filter((s) => s.down).length }));
  ok(o.down && o.ex && o.ob >= 1 && o.plan > 0, `outage: depot down, exception, ${o.ob} messages, ${o.plan} plan hours on backup`);
  await p.screenshot({ path: `${out}/v3-tower-outage.png` });
  // Wait for the result instead of a fixed delay (CI machines are slower; the tower page also re-draws live).
  for (let i = 0; i < 3; i++) { try { await p.click('[data-act="o-restore"]', { timeout: 3000 }); break; } catch (e) { await p.waitForTimeout(300); } }
  const restored = await p.waitForFunction(() => VF.state.fleet.ops.grid.dp2.up, null, { timeout: 5000 }).then(() => true, () => false);
  ok(restored, 'restore power');
  // Hourly pricing
  await go(p, 'm-smart'); await p.click('[data-act="i-tmode"][data-k="hourly"]'); await p.waitForTimeout(800);
  const hp = await p.evaluate(() => { const s = VF.intel.plan().depots[0].slots.map((x) => x.price); return { n: new Set(s).size, pct: VF.intel.plan().savingsPct }; });
  ok(hp.n > 6, `hourly prices vary (${hp.n} distinct) · savings ${hp.pct.toFixed(1)}%`);
  await p.click('[data-act="i-tmode"][data-k="tou"]'); await p.waitForTimeout(500);
  // Scorecards
  await go(p, 'm-drivers'); await p.click('[data-act="o-sc-send"]'); await p.waitForTimeout(500);
  ok(await p.evaluate(() => VF.state.fleet.ops.outbox.some((m) => m.type === 'scorecard')), 'scorecard sent');
  // Electrify
  await go(p, 'm-electrify'); await p.click('[data-act="o-plan-add"]'); await p.waitForTimeout(500);
  ok(await p.evaluate(() => VF.state.fleet.ops.plan.length === 1), 'added to transition plan');
  // Finance tabs
  await go(p, 'm-finance'); const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-act="o-attr-csv"]')]); ok(/client/.test(dl.suggestedFilename()), 'attribution CSV');
  await p.click('[data-act="o-fin-tab"][data-k="battery"]'); await p.waitForTimeout(600); await p.screenshot({ path: `${out}/v3-fin-battery.png`, fullPage: true });
  await p.click('[data-act="o-fin-tab"][data-k="home"]'); await p.waitForTimeout(600);
  await p.click('[data-act="o-pay"]'); await p.waitForTimeout(300); await p.click('#dlg-ok'); await p.waitForTimeout(600);
  ok(await p.evaluate(() => Object.keys(VF.state.fleet.ops.payouts).length > 0 && VF.state.fleet.ops.outbox.some((m) => m.type === 'reimbursement_paid')), 'MoMo payouts + receipts');
  await p.screenshot({ path: `${out}/v3-fin-home.png`, fullPage: true });
  // Alerts: language change and Twi segments
  await go(p, 'm-alerts');
  const seg = await p.evaluate(() => VF.ops.segments(VF.ops.render('low_battery', 'tw', { vehicle: 'Van 03', soc: 14, station: 'Spintex' })));
  ok(seg.ucs === true, `Twi SMS uses Unicode (${seg.n} chars, ${seg.segs} SMS)`);
  await p.selectOption('select[data-chg="o-lang"] >> nth=0', 'ha'); await p.waitForTimeout(500);
  ok(await p.evaluate(() => Object.values(VF.state.fleet.ops.lang).includes('ha')), 'driver language saved');
  // Routes: import jobs + dispatch messages
  await go(p, 'm-routes'); await p.click('[data-act="o-jobs-import"]'); await p.waitForTimeout(300); await p.click('#dlg-form button[type="submit"]'); await p.waitForTimeout(1500);
  const rj = await p.evaluate(() => ({ n: VF.intel.optimizeRoutes().jobs.length, ref: VF.intel.optimizeRoutes().jobs[0].ref }));
  ok(rj.n === 6 && /PO-/.test(rj.ref), `imported jobs used by optimiser (${rj.n})`);
  const disp = await p.$('.view [data-act="i-dispatch"]'); if (disp) { await disp.click(); await p.waitForTimeout(300); await p.click('#dlg-ok'); await p.waitForTimeout(600); }
  ok(await p.evaluate(() => VF.state.fleet.ops.outbox.some((m) => m.type === 'route_dispatched')), 'drivers messaged on dispatch');
  // Lite mode
  await go(p, 'm-settings'); await p.evaluate(() => { VF.mgr.ui.setTab = 'appearance'; VF.rerender(); }); await p.waitForTimeout(500);
  await p.click('[data-act="lite-set"][data-k="on"]'); await p.waitForTimeout(500);
  await go(p, 'm-vehicles');
  ok(await p.evaluate(() => document.documentElement.hasAttribute('data-lite') && !VF.maps.enabled()), 'low-data mode: schematic maps (bundled photos stay, see photos.js)');
  await p.click('[data-act="lite-set"][data-k="off"]').catch(() => {}); await p.evaluate(() => VF.lite.set(false));
  await ctx.close();
  ({ ctx, p } = await open({ ...devices['iPhone 13'] }));
  for (const pg of ['m-tower', 'm-drivers', 'm-electrify', 'm-finance', 'm-alerts']) { await go(p, pg, 1500); const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); ok(over <= 0, `${pg}: phone fits (${over})`); }
  await go(p, 'm-tower'); await p.screenshot({ path: `${out}/v3-phone-tower.png`, fullPage: true });
  console.log('errors:', errs.length ? errs.join('\n') : 'none'); await b.close();
})();
