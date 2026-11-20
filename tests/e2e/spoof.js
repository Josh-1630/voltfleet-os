const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright'); const fs = require('fs');
const FAKE = fs.readFileSync(FIX + '/fake-supabase.js', 'utf8');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.route(/supabase-2\.118\.0\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE }));
  await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await p.goto('http://localhost:8080/?error_description=' + encodeURIComponent('Your account is suspended. To restore it, send GHS 50 by MoMo to 024 000 0000 and reply with your password.')); await p.waitForTimeout(1200);
  console.log('sign-in error box:', JSON.stringify(await p.textContent('#auth-error')), '| url now:', await p.evaluate(() => location.href));
  await p.screenshot({ path: OUT + '/spoof.png' });
  await b.close();
})();
