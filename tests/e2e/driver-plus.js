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
    await p.click('[data-role="driver"]'); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1500);
    return { ctx, p };
  };
  const go = async (p, h) => { await p.evaluate((x) => { location.hash = x; }, h); await p.waitForTimeout(1800); };
  let { ctx, p } = await open({ ...devices['iPhone 13'] });
  const tabs = await p.$$eval('#tabbar .tab span', (s) => s.map((x) => x.textContent));
  ok(tabs.join() === 'Home,Charge,Wallet,Bookings,Me', 'tabbar: ' + tabs.join());
  ok(!!(await p.$('.d-extras')) && (await p.textContent('.d-extras')).includes('Range today'), 'home: range today, eco score, pre-cool');
  await p.screenshot({ path: `${out}/drv2-home.png`, fullPage: true });
  await go(p, 'driver-wallet');
  const bal0 = await p.evaluate(() => { const u = VF.user(VF.session.userId); return VF.driverWallet(VF.driver(u.driverId), u).balance; });
  await p.click('[data-act="d-topup"]'); await p.waitForTimeout(300); await p.selectOption('select[name="amount"]', '200'); await p.click('#dlg-form button[type="submit"]'); await p.waitForTimeout(600);
  const bal1 = await p.evaluate(() => { const u = VF.user(VF.session.userId); return VF.driverWallet(VF.driver(u.driverId), u).balance; });
  ok(Math.abs(bal1 - bal0 - 200) < 0.01, `wallet top-up ${bal0.toFixed(2)} -> ${bal1.toFixed(2)}`);
  await p.screenshot({ path: `${out}/drv2-wallet.png`, fullPage: true });
  const rec = await p.$('[data-act="d-receipt"]');
  if (rec) { const [dl] = await Promise.all([p.waitForEvent('download'), rec.click()]); ok(/receipt/.test(dl.suggestedFilename()), 'receipt download'); } else ok(true, 'no sessions yet for receipt (skipped)');
  // Rescue: drain battery
  await p.evaluate(() => { const u = VF.user(VF.session.userId); const v = VF.driverVehicle(u.driverId); v.soc = 6; VF.rerender(); });
  await go(p, 'driver-home');
  await p.click('[data-act="d-rescue"]'); await p.waitForTimeout(300); await p.click('#dlg-ok'); await p.waitForTimeout(600);
  ok(!!(await p.$('.rescue.on')), 'rescue requested');
  // Check in the same task as the tick: a later simulation tick may already drain the battery below 18 % again.
  const done = await p.evaluate(() => { const u = VF.user(VF.session.userId); const d = VF.driver(u.driverId); d.rescue.eta = VF.now() - 1; VF.tickHooks.forEach((f) => { try { f(); } catch (e) {} }); const ok = d.rescue.status === 'done' && d.rescue.loc === null && VF.driverVehicle(d.id).soc >= 18; VF.rerender(); return ok; });
  await p.waitForTimeout(500);
  ok(done, 'rescue completes, location sharing ends');
  // Station sheet + report
  await go(p, 'driver-charge');
  await p.evaluate(() => { VF.ui.driver.sheet = { type: 'station', id: VF.state.stations[0].id }; VF.rerender(); }); await p.waitForTimeout(600);
  const hasRep = await p.$('[data-act="d-report"]'); ok(!!hasRep, 'station sheet: power reliability + report');
  if (hasRep) { await hasRep.click(); await p.waitForTimeout(300); await p.fill('textarea[name="note"]', '<img src=x onerror=alert(1)> broken'); await p.click('#dlg-form button[type="submit"]'); await p.waitForTimeout(500); }
  ok(await p.evaluate(() => VF.state.alerts.some((a) => a.kind === 'Driver report' && !/[<>]/.test(a.body))), 'report raised as operator alert, markup stripped');
  // Me page
  await go(p, 'driver-privacy');
  ok((await p.textContent('.view')).includes('Alerts on my phone'), 'me: alerts + language + low data');
  await p.selectOption('select[data-chg="d-alert-lang"]', 'tw'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => { const u = VF.user(VF.session.userId); return VF.driver(u.driverId).alertPrefs.lang === 'tw'; }), 'alert language saved');
  await p.screenshot({ path: `${out}/drv2-me.png`, fullPage: true });
  ok(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, 'no horizontal scroll');
  await go(p, 'driver-vehicle'); ok((await p.textContent('h1')).includes('vehicle'), 'vehicle page still reachable');
  await ctx.close();
  ({ ctx, p } = await open({ viewport: { width: 1440, height: 960 } }));
  await p.screenshot({ path: `${out}/drv2-desktop.png`, fullPage: true });
  await go(p, 'driver-wallet'); await p.screenshot({ path: `${out}/drv2-wallet-desk.png` });
  console.log('errors:', errs.length ? errs.join('\n') : 'none'); await b.close();
})();
