// Tampered saved state (including ids and prototype keys) must be neutralised on load; CSV cells must not start formulas.
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_|status of 4|net::/.test(m.text())) errs.push(m.text()); });
  await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(400);
  await p.click('[data-role="manager"]'); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1200);
  await p.evaluate(() => {
    const s = VF.state; s.fleet.vehicles[0].id = 'x" onmouseover="window.__x=1'; s.fleet.vehicles[1].name = '<img src=x onerror=window.__x=2>';
    s.stations[0].name = '"><svg onload=window.__x=3>'; s.rev = (s.rev || 0) + 1000;
    const raw = JSON.parse(VF.stateJSON ? '{"state":' + VF.stateJSON(s) + '}' : JSON.stringify({ state: s }));
    raw.state.__proto__polluted = 1; const txt = JSON.stringify(raw).replace('"__proto__polluted":1', '"__proto__":{"polluted":true}');
    localStorage.setItem(VF.STORE_KEY, txt); window.__saved = 1;
  });
  await p.reload(); await p.waitForTimeout(1500);
  const r = await p.evaluate(() => ({ id: VF.state.fleet.vehicles[0].id, name: VF.state.fleet.vehicles[1].name, st: VF.state.stations[0].name, polluted: ({}).polluted === true || VF.state.polluted === true }));
  console.log(JSON.stringify(r));
  const pages = ['m-dashboard', 'm-vehicles', 'm-stations', 'm-tower', 'm-smart', 'm-fleet'];
  let inj = 0; for (const h of pages) { await p.evaluate((x) => { location.hash = x; }, h); await p.waitForTimeout(600); inj += await p.evaluate(() => document.querySelectorAll('img[src="x"], svg[onload], [onmouseover]').length + (window.__x ? 100 : 0)); }
  console.log((inj === 0 && !/["<>]/.test(r.id + r.name + r.st) && !r.polluted ? 'PASS' : 'FAIL') + ' tampered state neutralised (injected=' + inj + ')');
  const csv = await p.evaluate(() => VF.csv([['=HYPERLINK("http://x")', '-12.5', '+cmd', '@SUM(1)', 'plain', -3]]));
  console.log((/^"?'=HYPERLINK/.test(csv) && csv.includes(',-12.5,') && csv.includes("'+cmd") && csv.includes("'@SUM") ? 'PASS' : 'FAIL') + ' CSV formula guard: ' + csv);
  console.log('errors:', errs.length ? errs.join('\n') : 'none'); await b.close();
})();
