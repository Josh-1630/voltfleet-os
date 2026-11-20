// Phone layout: horizontal overflow per page and role; dialog focus containment.
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium, devices } = require('playwright');
(async () => {
  const b = await chromium.launch(); const out = [];
  for (const role of ['manager', 'driver', 'operator', 'admin', 'developer']) {
    const ctx = await b.newContext({ ...devices['Pixel 5'], serviceWorkers: 'block' }); const p = await ctx.newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
    await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(700);
    await p.click(`[data-role="${role}"]`); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1500);
    const navs = await p.evaluate(() => (VF.apps[VF.user(VF.session.userId).role] || { nav: [] }).nav.map((n) => n.id));
    for (const h of navs) {
      await p.evaluate((x) => { location.hash = x; }, h); await p.waitForTimeout(700);
      const o = await p.evaluate(() => { const W = document.documentElement.clientWidth; const sw = document.documentElement.scrollWidth; const wide = [...document.querySelectorAll('#view *')].filter((e) => { const r = e.getBoundingClientRect(); if (r.width === 0) return false; let a = e.parentElement; while (a && a.id !== 'view') { const cs = getComputedStyle(a); if (/(auto|scroll|hidden)/.test(cs.overflowX)) return false; a = a.parentElement; } return r.right > W + 2; }).slice(0, 2).map((e) => e.tagName.toLowerCase() + '.' + [...e.classList].join('.') + ' right=' + Math.round(e.getBoundingClientRect().right)); return { W, sw, wide }; });
      if (o.sw > o.W + 1 || o.wide.length) out.push(`${role}/${h}: page ${o.sw}px > ${o.W}px viewport ${o.wide.join(' | ')}`);
    }
    if (errs.length) out.push(role + ' errors: ' + [...new Set(errs)].join(' | '));
    await ctx.close();
  }
  console.log(out.length ? out.join('\n') : 'no horizontal overflow at 393px');
  // focus containment in a confirm dialog
  const p = await b.newPage({ viewport: { width: 1300, height: 900 } });
  await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(600); await p.click('[data-role="manager"]'); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1200);
  await p.evaluate(() => { VF.c.confirm({ title: 'Test', body: 'x', danger: true }); }); await p.waitForTimeout(200);
  const seq = []; for (let i = 0; i < 4; i++) { await p.keyboard.press('Tab'); seq.push(await p.evaluate(() => (document.activeElement.closest('.dialog') ? 'in-dialog:' : 'OUTSIDE:') + (document.activeElement.textContent || document.activeElement.getAttribute('aria-label') || document.activeElement.tagName).trim().slice(0, 30))); }
  console.log('Tab order from an open confirm dialog:', seq.join(' -> '));
  await p.keyboard.press('Escape'); await p.waitForTimeout(100);
  console.log('focus after closing dialog:', await p.evaluate(() => document.activeElement.tagName + ' ' + (document.activeElement.id || document.activeElement.className)));
  await b.close();
})();
