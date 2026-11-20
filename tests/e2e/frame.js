const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ serviceWorkers: 'block' }); const p = await ctx.newPage();
  await ctx.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await p.goto('http://127.0.0.1:8091/frame.html'); await p.waitForTimeout(2500);
  const f = p.frames().find((x) => x.url().includes('8080'));
  console.log('frame url', f.url());
  console.log('frame-guard present:', await f.evaluate(() => !!document.querySelector('.frame-guard')));
  console.log('app rendered in frame (auth/demo UI):', await f.evaluate(() => !!document.querySelector('.auth, #console, .demo-acct')));
  console.log('top !== self inside frame:', await f.evaluate(() => window.top !== window.self));
  await b.close();
})();
