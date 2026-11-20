// R4: snapshots that pass sanitizeState + repairState but reference unknown models, depots, drivers or vehicles in
// the fleet and driver lists (anyone can write the demo world). Every manager and driver page is opened.
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright');
(async () => {
  const base = process.argv[2] || 'http://localhost:8080';
  const b = await chromium.launch(); const p = await b.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message + ' @ ' + String(e.stack || '').split('\n').slice(1, 3).join(' ')));
  await p.route(/supabase\.co|fonts\.g|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await p.goto(base + '/?demo'); await p.waitForTimeout(800);
  await p.evaluate(() => {
    const st = JSON.parse(VF.stateJSON(VF.state)); const f = st.fleet;
    f.vehicles[0].model = 'Nonexistent Car'; f.vehicles[1].depot = 'dp-missing'; f.vehicles[2].driverId = 'fd-missing';
    f.drivers[0].vehicleId = 'fv-missing'; st.vehicles[0].model = 'Ghost EV';
    st.bookings[0] && (st.bookings[0].driverId = 'd-missing'); st.sessions[0] && (st.sessions[0].driverId = 'd-missing');
    VF.sanitizeState(st); if (VF.repairState) VF.repairState(st); VF.state = st; VF.ensureFleet && VF.ensureFleet(); VF.onRemoteState && VF.onRemoteState();
  });
  const res = {};
  for (const role of ['manager', 'driver', 'operator', 'admin']) {
    await p.evaluate(() => { try { VF.signOut(); } catch (e) {} }); await p.waitForTimeout(300);
    try { await p.click(`[data-role="${role}"]`, { timeout: 2000 }); await p.click('.demo-acct:not([disabled])', { timeout: 2000 }); } catch (e) { res[role] = 'sign-in screen broken'; continue; }
    await p.waitForTimeout(800);
    const pages = await p.evaluate((r) => Object.keys(VF.apps[r].pages), role);
    let bad = 0, failed = [];
    for (const pg of pages) {
      const before = errs.length;
      await p.evaluate((h) => { location.hash = h; }, pg); await p.waitForTimeout(350);
      const f = await p.evaluate(() => !!document.querySelector('#view') && /could not load/i.test(document.querySelector('#view').textContent));
      if (f || errs.length > before) { bad++; failed.push(pg); }
    }
    res[role] = { pages: pages.length, broken: bad, failed: failed.slice(0, 8) };
  }
  console.log(JSON.stringify(res));
  const total = Object.values(res).reduce((n, r) => n + (typeof r === 'object' ? r.broken : 1), 0);
  console.log(total ? 'FAIL' : 'PASS', 'pages broken by dangling fleet/vehicle references:', total, '| errors:', [...new Set(errs)].slice(0, 4).join(' | '));
  await b.close();
})();
