// QA R3-14 (hardening pass): map tiles come from a third party, and the tiles requested show where the map looks. A map
// showing a real (connected) car stops at zoom 13 (tiles ~5 km across); simulated vehicles keep full detail.
const { ROOT, FIX, OUT } = require('../lib.cjs');
const { chromium } = require('playwright');
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
(async () => {
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  let zooms = [];
  await p.route(/basemaps\.cartocdn\.com\/[a-z_]+\/(\d+)\//, (r) => { zooms.push(+r.request().url().match(/cartocdn\.com\/[a-z_]+\/(\d+)\//)[1]); r.fulfill({ contentType: 'image/png', body: PNG }); });
  await p.route(/supabase\.co|osrm|wikipedia|wikimedia|open-meteo|fonts\.g/, (r) => r.abort());
  await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(500);
  await p.click('[data-role="manager"]'); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1200);
  // The fleet dashboard map shows every vehicle, so it includes a real car whenever one is connected.
  const open = async (real) => {
    await p.evaluate((real) => { for (const v of VF.state.fleet.vehicles) v.real = false; const v = VF.state.fleet.vehicles[3]; if (real) { v.real = true; v.loc = { lat: 5.6037, lon: -0.187, at: VF.now() }; } location.hash = 'm-vehicles'; }, real);
    await p.waitForTimeout(500); zooms = [];
    await p.evaluate(() => { location.hash = 'm-dashboard'; }); await p.waitForTimeout(1800);
    return p.evaluate(() => { const i = VF.maps.instances['m-dash-map']; return i && i.el.isConnected ? { max: i.map.getMaxZoom(), z: i.map.getZoom() } : null; });
  };
  ok(await p.evaluate(() => VF.maps.enabled()), 'street maps are on (tiles served by the test)');
  const sim = await open(false);
  ok(sim && sim.max === 18, 'only simulated vehicles: full map detail (max zoom ' + (sim && sim.max) + ')');
  const real = await open(true);
  ok(real && real.max === 13 && real.z <= 13, 'a real car on the map: zoom capped at 13 (' + JSON.stringify(real) + ')');
  await p.evaluate(() => { const i = VF.maps.instances['m-dash-map']; i.map.setZoom(17); }); await p.waitForTimeout(500);
  ok(await p.evaluate(() => VF.maps.instances['m-dash-map'].map.getZoom()) <= 13, 'zooming in by hand stays at 13');
  ok(zooms.length > 0 && Math.max(...zooms) <= 13, 'a real car on the map: even after zooming in, no tile above zoom 13 is requested (max ' + (zooms.length ? Math.max(...zooms) : 'none') + ')');
  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await b.close();
})();
