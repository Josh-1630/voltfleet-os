// Real car photos everywhere: no illustrations, all photos load from the app itself.
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright');
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const run = async (role, pages, shots) => {
    const ctx = await b.newContext({ viewport: { width: 1380, height: 900 }, serviceWorkers: 'block' }); const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(role + ' PAGEERR ' + e.message));
    const ext = []; p.on('request', (r) => { if (r.resourceType() === 'image' && /wiki/.test(r.url())) ext.push(r.url()); });
    await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
    await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(500);
    await p.click(`[data-role="${role}"]`); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1500);
    for (const [hash, prep] of pages) {
      if (prep) await p.evaluate(prep); await p.evaluate((h) => { location.hash = h; }, hash); await p.waitForTimeout(1300);
      await p.evaluate(async () => { for (const i of document.querySelectorAll('.vphoto img')) { i.loading = 'eager'; } await new Promise((r) => setTimeout(r, 600)); });
      const r = await p.evaluate(() => { const imgs = [...document.querySelectorAll('.vphoto img')]; return { n: imgs.length, art: document.querySelectorAll('.vphoto.art').length, broken: imgs.filter((i) => i.complete && !i.naturalWidth).length, local: imgs.every((i) => /\/img\/cars\//.test(i.src)) }; });
      ok(r.n > 0 && r.art === 0 && r.broken === 0 && r.local, `${role} ${hash}: ${r.n} real photos, ${r.art} illustrations, ${r.broken} broken`);
      if (shots[hash]) await p.screenshot({ path: `${OUT}/${shots[hash]}`, fullPage: false });
    }
    ok(ext.length === 0, `${role}: no photos fetched from Wikipedia at runtime`);
    await ctx.close();
  };
  await run('manager', [['m-dashboard'], ['m-vehicles'], ['m-vehicle', "VF.mgr.ui.vehicle=VF.state.fleet.vehicles[5].id"]], { 'm-dashboard': 'photos-dash.png', 'm-vehicles': 'photos-vehicles.png', 'm-vehicle': 'photos-vehicle.png' });
  await run('driver', [['driver-home'], ['driver-vehicle']], { 'driver-home': 'photos-driver.png' });
  await run('admin', [['ad-vehicles', null]], { 'ad-vehicles': 'photos-admin.png' });
  // Connect consent flow brand tiles
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' }); const p = await ctx.newPage();
  await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(500); await p.click('[data-role="driver"]'); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1200);
  await p.evaluate(() => { VF.openConnect(VF.state.connect.apps[0].id, 'consent', VF.user(VF.session.userId).driverId); VF.ui.connect.flow.step = 'brand'; VF.renderConnect(); }); await p.waitForTimeout(800);
  const t = await p.evaluate(() => ({ tiles: document.querySelectorAll('.brand-tile').length, photos: document.querySelectorAll('.brand-tile .vphoto img').length }));
  ok(t.photos >= 8, `Connect brand picker shows real photos (${t.photos}/${t.tiles} tiles)`);
  await p.screenshot({ path: `${OUT}/photos-brands.png` });
  // Low-data mode keeps photos
  await p.evaluate(() => { VF.lite.set(true); location.hash = 'driver-vehicle'; }); await p.waitForTimeout(1200);
  ok(await p.evaluate(() => document.querySelectorAll('.vphoto img').length > 0 && !document.querySelector('.vphoto.art')), 'low-data mode still shows the bundled photos');
  console.log('errors:', errs.length ? errs.join('\n') : 'none'); await b.close();
})();
