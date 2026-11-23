// Dashboard navigation: every tile and card on the fleet manager's dashboard opens the page behind its numbers.
const { ROOT, FIX, OUT } = require('../lib.cjs');
const { chromium } = require('playwright');
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: 'block' })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.route(/supabase\.co|cartocdn|osrm|wikipedia|wikimedia|open-meteo|fonts\.g/, (r) => r.abort());
  await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(500);
  await p.click('[data-role="manager"]'); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1500);
  const home = async () => { await p.evaluate(() => { location.hash = 'm-dashboard'; }); await p.waitForTimeout(700); };
  const route = () => p.evaluate(() => location.hash.slice(1));
  // KPI tiles
  const kpis = [['Total vehicles', 'm-vehicles', 'all'], ['Active vehicles', 'm-vehicles', 'in_use'], ['Average battery', 'm-vehicles', 'all'], ['Energy consumed', 'm-energy'], ['Charging cost', 'm-finance'], ['Estimated range', 'm-vehicles', 'all'], ['CO₂ emissions saved', 'm-impact'], ['Available stations', 'm-stations']];
  for (const [label, page, filter] of kpis) {
    await home();
    await p.locator('a.stat-card.kpi', { hasText: label }).first().click(); await p.waitForTimeout(600);
    const r = await route(); const f = await p.evaluate(() => VF.mgr.ui.vfilter);
    const rendered = await p.evaluate(() => !!document.querySelector('#view') && !/could not load/i.test(document.querySelector('#view').textContent));
    ok(r === page && (!filter || f === filter) && rendered, `tile “${label}” opens ${page}${filter ? ' (' + filter + ')' : ''} → ${r}${filter ? ' (' + f + ')' : ''}`);
  }
  // Active vehicles really filters the list
  await home(); await p.locator('a.stat-card.kpi', { hasText: 'Active vehicles' }).click(); await p.waitForTimeout(600);
  ok(await p.evaluate(() => document.querySelector('[data-act="m-vfilter"][data-k="in_use"]').getAttribute('aria-pressed') === 'true'), 'My Vehicles opens with “In use” selected');
  // Hero stats
  for (const [label, page] of [['Grid → network', 'm-stations'], ['Network → your fleet', 'm-sessions'], ['On the road', 'm-tower']]) {
    await home(); await p.locator('.hl-stats > a', { hasText: label }).click(); await p.waitForTimeout(600);
    ok((await route()) === page, `hero “${label}” opens ${page}`);
  }
  // Cards: by title link, and by clicking the card body
  const cards = [['Vehicle overview', 'm-vehicles'], ['Needs attention', 'm-vehicles'], ['Vehicle locations', 'm-tower'], ['Fleet status', 'm-vehicles'], ['Charging activity', 'm-sessions'], ['Energy consumption', 'm-energy'], ['CO₂ emissions saved', 'm-impact'], ['Charging costs', 'm-finance'], ['Vehicle utilisation', 'm-fleet'], ['Battery performance', 'm-health']];
  for (const [title, page] of cards) {
    await home(); await p.locator('.card-go a.card-link', { hasText: title }).first().click(); await p.waitForTimeout(600);
    ok((await route()) === page, `card “${title}” title opens ${page}`);
  }
  for (const [title, page] of [['Fleet status', 'm-vehicles'], ['Charging costs', 'm-finance'], ['Battery performance', 'm-health']]) {
    await home();
    const card = p.locator('section.card-go', { has: p.locator('a.card-link', { hasText: title }) }).first();
    await card.scrollIntoViewIfNeeded(); await p.waitForTimeout(200);
    const box = await card.boundingBox(); await p.mouse.click(box.x + box.width / 2, box.y + box.height - 24); await p.waitForTimeout(600);
    ok((await route()) === page, `clicking inside the “${title}” card opens ${page}`);
  }
  // Controls inside a card keep working and don't navigate
  await home(); await p.click('[data-act="m-dash-days"][data-k="30"]'); await p.waitForTimeout(500);
  ok((await route()) === 'm-dashboard' && (await p.evaluate(() => VF.mgr.ui.dashDays)) === 30, 'the 7/30-day switch changes the chart and stays on the dashboard');
  await home(); const row = await p.$('.att-list li[data-act="m-open-vehicle"]');
  if (row) { await row.click(); await p.waitForTimeout(600); ok((await route()) === 'm-vehicle', 'a “Needs attention” item still opens that vehicle'); } else ok(true, 'no attention items to click (skipped)');
  await home(); const qa = p.locator('.quick-grid button[data-act="m-add-vehicle"]'); await qa.click(); await p.waitForTimeout(400);
  ok((await route()) === 'm-dashboard' && await p.evaluate(() => !document.getElementById('dialog').hidden), 'quick actions still open their dialog');
  await p.keyboard.press('Escape');
  await home(); const map = await p.$('#m-dash-map, .map-wrap'); if (map) { await map.scrollIntoViewIfNeeded(); const bb = await map.boundingBox(); await p.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); await p.waitForTimeout(500); }
  ok((await route()) === 'm-dashboard', 'clicking the map doesn’t leave the dashboard');
  // Keyboard: the links are reachable and work with Enter
  await home(); await p.focus('a.stat-card.kpi >> nth=4'); await p.keyboard.press('Enter'); await p.waitForTimeout(600);
  ok((await route()) === 'm-finance', 'Enter on a focused tile opens its page');
  await home(); await p.focus('.card-go a.card-link >> nth=0'); await p.keyboard.press('Enter'); await p.waitForTimeout(600);
  ok((await route()) === 'm-vehicles', 'Enter on a card title opens its page');
  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await b.close();
})();
