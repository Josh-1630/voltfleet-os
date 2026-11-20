const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext(); const p = await ctx.newPage();
  await ctx.route(/supabase\.co|fonts\.g|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await p.goto('http://localhost:8080/'); await p.waitForTimeout(2500);
  await p.goto('http://localhost:8080/?code=0d9a7c1e-one-time-auth-code'); await p.waitForTimeout(1500);
  await p.goto('http://localhost:8080/?user_id=8b1f2c3d-smartcar-user&state=abcDEF123456789012345'); await p.waitForTimeout(1500);
  const keys = await p.evaluate(async () => { const out = []; for (const n of await caches.keys()) { const c = await caches.open(n); for (const r of await c.keys()) if (/\?/.test(r.url)) out.push(n + ' ' + r.url); } return out; });
  console.log(keys.join('\n') || 'no query URLs cached');
  const all = await p.evaluate(async () => { const c = await caches.open((await caches.keys())[0]); return (await c.keys()).length; });
  console.log('cache entries:', all, '| cache names:', await p.evaluate(async () => (await caches.keys()).join(',')));
  await ctx.setOffline(true); await p.goto('http://localhost:8080/?demo').catch((e) => console.log('offline nav failed', e.message)); await p.waitForTimeout(1500);
  console.log('offline: app shell served:', await p.evaluate(() => !!document.querySelector('#root') && !!window.VF));
  await b.close();
})();
