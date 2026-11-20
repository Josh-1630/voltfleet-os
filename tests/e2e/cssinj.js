// CSS injection through numeric fields that survive sanitizeState (shared demo world is writable by anyone).
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1300, height: 900 } });
  await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(500);
  await p.click('[data-role="manager"]'); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1500);
  const navs = await p.evaluate(() => VF.apps.manager ? VF.apps.manager.nav.map((n) => n.id) : Object.keys(VF.apps));
  console.log('manager pages', navs.join(','));
  await p.evaluate(() => {
    const evil = '100%;position:fixed;inset:0;z-index:2147483647;background:#c00;width:100vw;height:100vh';
    const st = JSON.parse(VF.stateJSON(VF.state));
    st.fleet.drivers[0].score = evil;           // a string where a number is expected
    VF.sanitizeState(st);                        // what every cloud snapshot goes through
    window.__after = st.fleet.drivers[0].score;
    st.rev = (VF.state.rev || 0) + 1; VF.state = st; VF.ensureFleet && VF.ensureFleet();
  });
  console.log('score after sanitizeState:', await p.evaluate(() => window.__after));
  const page = process.argv[3] || 'm-fleet';
  await p.evaluate((h) => { location.hash = h; }, page); await p.waitForTimeout(1200);
  const r = await p.evaluate(() => { const els = [...document.querySelectorAll('[style*="position:fixed"]')]; return els.map((e) => { const cs = getComputedStyle(e); const rc = e.getBoundingClientRect(); return { tag: e.tagName, pos: cs.position, bg: cs.backgroundColor, z: cs.zIndex, w: Math.round(rc.width), h: Math.round(rc.height) }; }); });
  console.log('page', page, 'injected styled elements:', JSON.stringify(r));
  const top = await p.evaluate(() => { const e = document.elementFromPoint(650, 450); return e.tagName + ' ' + (e.getAttribute('style') || '').slice(0, 60); });
  console.log('element at centre of screen:', top);
  await p.screenshot({ path: process.argv[2] || '/dev/null' });
  await b.close();
})();
