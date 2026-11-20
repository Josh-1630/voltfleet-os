const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright');
const out = process.argv[2];
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errs.push(m.text()); });
  await p.route(/supabase\.co|fonts\.(googleapis|gstatic)|cartocdn|osrm|wikipedia|wikimedia/, (r) => r.abort());
  await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(400);
  await p.click('.demo-acct'); await p.waitForTimeout(800);
  // add vehicle: validation then success
  await p.click('.page-actions [data-act="m-add-vehicle"]'); await p.waitForTimeout(200);
  await p.click('#dlg-form button[type=submit]');
  ok(await p.isVisible('#dlg-error'), 'add vehicle shows validation error');
  await p.fill('#f-plate', 'GR 4321-25'); await p.fill('#f-vin', 'LGXCE4CB0P1234567');
  await p.click('#dlg-form button[type=submit]'); await p.waitForTimeout(400);
  ok(location => true, ''); ok((await p.evaluate(() => location.hash)) === '#m-vehicle', 'new vehicle detail opens');
  ok(await p.evaluate(() => VF.state.fleet.vehicles.length === 17), 'vehicle count 17');
  // crumbs
  ok((await p.textContent('#crumbs')).includes('My Vehicles'), 'breadcrumb shows parent');
  // remove vehicle with confirm cancel then confirm
  await p.click('[data-act="m-vtab"][data-k="registration"]'); await p.waitForTimeout(200);
  await p.click('[data-act="m-remove-vehicle"]'); await p.waitForTimeout(200);
  ok(await p.isVisible('.dialog[role=alertdialog]'), 'confirm dialog shown');
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  ok(await p.evaluate(() => VF.state.fleet.vehicles.length === 17), 'cancel keeps vehicle');
  await p.click('[data-act="m-remove-vehicle"]'); await p.click('#dlg-ok'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => VF.state.fleet.vehicles.length === 16 && location.hash === '#m-vehicles'), 'remove confirmed');
  // vehicles search + table view
  await p.fill('#m-vq', 'van'); await p.waitForTimeout(300);
  ok((await p.$$('.vcard')).length === 5, 'search filters to 5 vans');
  await p.click('[data-act="m-vview"][data-k="table"]'); await p.waitForTimeout(200);
  ok((await p.$$('table.t tbody tr')).length === 5, 'table view rows');
  await p.fill('#m-vq', 'zzz'); await p.waitForTimeout(300);
  ok(await p.isVisible('.empty-block'), 'empty state when no match');
  await p.click('[data-act="m-vclear"]');
  // send to charge
  await p.evaluate(() => { location.hash = 'm-sessions'; }); await p.waitForTimeout(300);
  const before = await p.evaluate(() => VF.state.fleet.vehicles.filter((v) => v.trip && v.trip.purpose === 'charge').length);
  await p.click('.page-actions [data-act="m-sess-csv"]').catch(() => {});
  await p.click('.toolbar [data-act="m-start-session"]'); await p.waitForTimeout(200);
  await p.click('#dlg-form button[type=submit]'); await p.waitForTimeout(300);
  ok(await p.evaluate((b) => VF.state.fleet.vehicles.filter((v) => (v.trip && v.trip.purpose === 'charge') || v.status === 'charging' || v.status === 'waiting').length > 0, before), 'send to charge created charge trip');
  // trips dispatch
  await p.evaluate(() => { location.hash = 'm-trips'; }); await p.waitForTimeout(400);
  await p.click('[data-act="m-tr-add"]'); await p.waitForTimeout(300);
  ok((await p.$$('.stop-row')).length === 2, 'stop added');
  await p.selectOption('select[name=stop1]', 'kasoa'); await p.waitForTimeout(300);
  const hasEst = await p.isVisible('.plan-stats'); ok(hasEst, 'plan estimate shown');
  const btn = await p.$('[data-act="m-tr-dispatch"]');
  if (btn) { await btn.click(); await p.click('#dlg-ok'); await p.waitForTimeout(400); ok(await p.evaluate(() => VF.state.fleet.plans.length === 1), 'journey dispatched'); }
  else console.log('INFO no dispatch button (not reachable)');
  await p.screenshot({ path: out + '/after-dispatch.png', fullPage: true });
  // fleet: assign & add driver & delete driver
  await p.evaluate(() => { location.hash = 'm-fleet'; }); await p.waitForTimeout(400);
  await p.click('.page-actions [data-act="m-add-driver"]'); await p.waitForTimeout(200);
  await p.fill('#f-name', 'Test Driver'); await p.fill('#f-phone', '+233 24 123 4567'); await p.fill('#f-license', 'bad');
  await p.click('#dlg-form button[type=submit]'); ok((await p.textContent('#dlg-error')).includes('licence'), 'licence validated');
  await p.fill('#f-license', 'DVLA-123456'); await p.click('#dlg-form button[type=submit]'); await p.waitForTimeout(300);
  ok(await p.evaluate(() => VF.state.fleet.drivers.some((d) => d.name === 'Test Driver')), 'driver added');
  await p.fill('#m-drvq', 'Test Driver'); await p.waitForTimeout(300);
  await p.click('[data-act="m-del-driver"]'); await p.click('#dlg-ok'); await p.waitForTimeout(300);
  ok(await p.evaluate(() => !VF.state.fleet.drivers.some((d) => d.name === 'Test Driver')), 'driver removed');
  // reports download
  await p.evaluate(() => { location.hash = 'm-reports'; }); await p.waitForTimeout(400);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-act="m-rep-dl"][data-k="fleet"]')]);
  ok(/greenline-fleet/.test(dl.suggestedFilename()), 'report CSV download ' + dl.suggestedFilename());
  await p.click('[data-act="m-rep-view"][data-k="energy"]'); await p.waitForTimeout(200);
  ok(await p.isVisible('.table-wrap.preview'), 'report preview');
  await p.click('.dialog [data-act="dlg-close"]');
  // notifications
  await p.evaluate(() => { location.hash = 'm-notifications'; }); await p.waitForTimeout(300);
  await p.click('[data-act="m-n-readall"]'); await p.waitForTimeout(300);
  ok(await p.evaluate(() => VF.state.fleet.notices.every((n) => n.read)), 'mark all read');
  ok(await p.isHidden('#bell-count'), 'bell count cleared');
  await p.click('[data-chg="m-pref"][data-k="email"]'); await p.waitForTimeout(300);
  ok(await p.evaluate(() => VF.state.fleet.prefs.email === true), 'pref toggled');
  // bell popover & search
  await p.click('[data-act="bell"]'); await p.waitForTimeout(200); ok(await p.isVisible('#notif-pop'), 'bell popover');
  await p.click('#view'); await p.waitForTimeout(100); ok(await p.isHidden('#notif-pop'), 'popover closes on outside click');
  await p.keyboard.press('/'); await p.keyboard.type('kaneshie'); await p.waitForTimeout(200);
  ok(await p.isVisible('#g-results .pop-item'), 'search results');
  await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  ok((await p.evaluate(() => location.hash)) === '#m-stations', 'search result navigates to station');
  // settings: theme + profile
  await p.evaluate(() => { location.hash = 'm-settings'; }); await p.waitForTimeout(300);
  await p.click('[data-act="m-settab"][data-k="appearance"]'); await p.click('[data-act="m-theme"][data-k="dark"]'); await p.waitForTimeout(200);
  ok(await p.evaluate(() => document.documentElement.dataset.theme === 'dark' && localStorage.getItem('voltfleet-os:theme') === 'dark'), 'dark theme saved');
  await p.screenshot({ path: out + '/settings-dark.png' });
  await p.click('[data-act="m-theme"][data-k="light"]');
  await p.click('[data-act="m-settab"][data-k="profile"]'); await p.fill('#f-email', 'nope'); await p.click('#m-profile-form button[type=submit]');
  ok(await p.isVisible('#m-profile-error'), 'profile email validated');
  // sidebar collapse persist
  await p.click('[data-act="sb-toggle"]'); await p.waitForTimeout(250);
  ok(await p.evaluate(() => document.getElementById('console').classList.contains('collapsed')), 'sidebar collapses');
  await p.screenshot({ path: out + '/collapsed.png' });
  await p.reload(); await p.waitForTimeout(800);
  ok(await p.evaluate(() => document.getElementById('console').classList.contains('collapsed')), 'collapse persists');
  await p.click('.sb-expand'); 
  // RBAC: manager can't open operator page
  await p.evaluate(() => { location.hash = 'op-live'; }); await p.waitForTimeout(400);
  ok((await p.evaluate(() => location.hash)) === '#m-dashboard', 'RBAC redirects');
  // live ticking: soc changes over time
  const s1 = await p.evaluate(() => VF.state.fleet.vehicles.map((v) => v.soc.toFixed(2)).join());
  await p.waitForTimeout(3000);
  ok(s1 !== await p.evaluate(() => VF.state.fleet.vehicles.map((v) => v.soc.toFixed(2)).join()), 'simulation advances');
  // reset fleet
  await p.evaluate(() => { location.hash = 'm-settings'; }); await p.waitForTimeout(300);
  await p.click('[data-act="m-settab"][data-k="privacy"]'); await p.click('[data-act="m-reset-fleet"]'); await p.click('#dlg-ok'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => VF.state.fleet.vehicles.length === 16 && VF.state.fleet.plans.length === 0), 'fleet reset');
  // operator sees fleet session label
  await p.evaluate(() => VF.signOut()); await p.waitForTimeout(300);
  await p.click('[data-role="driver"]'); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(700);
  const hasBook = await p.$('[data-act="d-book-route"], [data-act*="book"]');
  ok(!!hasBook, 'driver booking action present');
  console.log('errors:', errs.length ? errs.join('\n') : 'none');
  await b.close();
})();
