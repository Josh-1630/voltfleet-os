const { ROOT, FIX, OUT, AXE: AXE_FILE } = require('../lib.cjs');
if (!AXE_FILE) { console.log('FAIL axe-core not found: npm install (tests/package.json) or set AXE_PATH'); process.exit(1); }
const { chromium } = require('playwright'); const fs = require('fs');
const AXE = fs.readFileSync(AXE_FILE, 'utf8');
const ROLES = { manager: ['m-dashboard', 'm-vehicles', 'm-fleet', 'm-settings'], driver: ['driver-home', 'driver-vehicle'], operator: [], admin: [], developer: [] };
(async () => {
  const b = await chromium.launch(); const agg = {};
  const run = async (p, where) => {
    if (!(await p.evaluate(() => !!window.axe))) await p.evaluate(AXE);
    const r = await p.evaluate(async () => { const res = await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'], resultTypes: ['violations'] }); return res.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, ex: v.nodes.slice(0, 2).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(1, 2).join('')) })); });
    for (const v of r) { const k = v.id; agg[k] = agg[k] || { impact: v.impact, where: [], ex: v.ex }; agg[k].where.push(where + '(' + v.n + ')'); }
  };
  for (const theme of ['light', 'dark']) {
    const p = await b.newPage({ viewport: { width: 1300, height: 900 } });
    await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
    await p.addInitScript((t) => { try { localStorage.setItem('voltfleet-os:theme', t); localStorage.setItem('voltfleet-os:motion', 'reduced'); } catch (e) {} }, theme);
    await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(800);
    await run(p, theme + ':signin');
    for (const [role, pages] of Object.entries(ROLES)) {
      await p.evaluate(() => { try { VF.signOut(); } catch (e) {} }); await p.waitForTimeout(400);
      await p.click(`[data-role="${role}"]`); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1500);
      const list = pages.length ? pages : (await p.evaluate(() => (VF.apps[VF.user(VF.session.userId).role] || { nav: [] }).nav.slice(0, 3).map((n) => n.id)));
      for (const h of list) { await p.evaluate((x) => { location.hash = x; }, h); await p.waitForTimeout(900); await run(p, theme + ':' + h); }
    }
    await p.close();
  }
  for (const [k, v] of Object.entries(agg)) console.log(`${k} [${v.impact}] ${v.where.length} views: ${v.where.slice(0, 6).join(', ')}\n   e.g. ${v.ex.join('\n        ')}`);
  await b.close();
})();
