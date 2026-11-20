const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const v = new Set();
  for (const role of ['manager', 'driver', 'operator', 'admin', 'developer']) {
    const p = await b.newPage({ viewport: { width: 1300, height: 900 } });
    await p.addInitScript(() => { document.addEventListener('securitypolicyviolation', (e) => { (window.__csp = window.__csp || []).push(e.violatedDirective + ' ' + e.blockedURI); }); });
    p.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) v.add(role + ': ' + m.text().slice(0, 200)); });
    await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(800);
    await p.click(`[data-role="${role}"]`); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(2500);
    const navs = await p.evaluate(() => (VF.apps[VF.session.role] || { nav: [] }).nav.map((n) => n.id));
    for (const id of navs.slice(0, 12)) { await p.evaluate((h) => { location.hash = h; }, id); await p.waitForTimeout(900); }
    for (const x of await p.evaluate(() => window.__csp || [])) v.add(role + ': ' + x);
    await p.close();
  }
  console.log(v.size ? [...v].join('\n') : 'no CSP violations'); await b.close();
})();
