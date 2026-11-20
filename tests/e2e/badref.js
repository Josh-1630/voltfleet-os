// R2: a snapshot that passes sanitizeState but has a dangling reference (anyone can write the demo world).
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message + ' @ ' + (e.stack || '').split('\n')[1]));
  await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await p.goto((process.argv[2] || 'http://localhost:8080') + '/?demo'); await p.waitForTimeout(800);
  // what an attacker's snapshot would do after adoption: same path as cloud.js (sanitizeState then VF.state = st)
  await p.evaluate(() => { const st = JSON.parse(VF.stateJSON(VF.state)); st.stations[0].node = 'nowhere'; st.stations[1].operatorId = 'op-missing'; { const du = st.users.find((u) => u.role === 'driver'); du.driverId = 'd-missing'; } VF.sanitizeState(st); if (VF.repairState) VF.repairState(st); VF.state = st; VF.onRemoteState && VF.onRemoteState(); });
  const res = {};
  for (const role of ['manager', 'driver', 'operator', 'admin']) {
    await p.evaluate(() => { try { VF.signOut(); } catch (e) {} }); await p.waitForTimeout(300);
    const before = errs.length;
    try { await p.click(`[data-role="${role}"]`, { timeout: 2000 }); await p.click('.demo-acct:not([disabled])', { timeout: 2000 }); } catch (e) { res[role] = 'sign-in screen broken'; continue; }
    await p.waitForTimeout(2500);
    res[role] = { pageErrors: errs.length - before, failedPage: await p.evaluate(() => !!document.querySelector('#view') && /could not load/.test(document.querySelector('#view').textContent)), shell: !!(await p.$('#console')) };
  }
  console.log(JSON.stringify(res)); console.log('distinct errors:', [...new Set(errs)].slice(0, 5).join(' | '));
  await b.close();
})();
