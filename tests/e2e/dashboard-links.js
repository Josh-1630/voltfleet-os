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
  // Live pages re-draw parts of themselves every few seconds: find the element afresh on each try, then click at a
  // point inside it (pick gets its size).
  const clickIn = async (loc, pick) => {
    for (let i = 0; i < 6; i++) {
      try { const r = await loc.evaluate((el) => { el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { w: b.width, h: b.height }; }, null, { timeout: 3000 }); await loc.click({ position: pick(r), timeout: 3000 }); return true; } catch (e) { await p.waitForTimeout(300); }
    }
    return false;
  };
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
    await clickIn(card, (r) => ({ x: r.w / 2, y: r.h - 24 })); await p.waitForTimeout(600);
    ok((await route()) === page, `clicking inside the “${title}” card opens ${page}`);
  }
  // Controls inside a card keep working and don't navigate
  await home(); await p.click('[data-act="m-dash-days"][data-k="30"]'); await p.waitForTimeout(500);
  ok((await route()) === 'm-dashboard' && (await p.evaluate(() => VF.mgr.ui.dashDays)) === 30, 'the 7/30-day switch changes the chart and stays on the dashboard');
  await home(); const row = p.locator('.att-list li[data-act="m-open-vehicle"]').first();
  if (await row.count()) { await clickIn(row, (r) => ({ x: r.w / 2, y: r.h / 2 })); await p.waitForTimeout(600); ok((await route()) === 'm-vehicle', 'a “Needs attention” item still opens that vehicle'); } else ok(true, 'no attention items to click (skipped)');
  await home(); const qa = p.locator('.quick-grid button[data-act="m-add-vehicle"]'); await qa.click(); await p.waitForTimeout(400);
  ok((await route()) === 'm-dashboard' && await p.evaluate(() => !document.getElementById('dialog').hidden), 'quick actions still open their dialog');
  await p.keyboard.press('Escape');
  // Click the map's background (markers open their vehicle or station on purpose, and they move).
  await home(); await p.evaluate(() => { const w = document.querySelector('.map-wrap'); const bg = w.querySelector('svg, .lmap') || w; bg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }); await p.waitForTimeout(500);
  ok((await route()) === 'm-dashboard', 'clicking the map doesn’t leave the dashboard (' + await route() + ')');
  // Keyboard: the links are reachable and work with Enter
  await home(); await p.focus('a.stat-card.kpi >> nth=4'); await p.keyboard.press('Enter'); await p.waitForTimeout(600);
  ok((await route()) === 'm-finance', 'Enter on a focused tile opens its page');
  await home(); await p.focus('.card-go a.card-link >> nth=0'); await p.keyboard.press('Enter'); await p.waitForTimeout(600);
  ok((await route()) === 'm-vehicles', 'Enter on a card title opens its page');

  // ================================================================ operator: Live network
  const as = async (role) => { await p.evaluate(() => { try { VF.signOut(); } catch (e) {} }); await p.waitForTimeout(400); await p.click(`[data-role="${role}"]`); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1500); };
  await as('operator');
  const opHome = async () => { await p.evaluate(() => { location.hash = 'op-live'; }); await p.waitForTimeout(700); };
  for (const [label, page] of [['Available', 'op-stations'], ['Charging now', 'op-stations'], ['Upcoming bookings', 'op-bookings'], ['Faulted', 'op-alerts']]) {
    await opHome(); await p.locator('a.stat-card.kpi', { hasText: label }).first().click(); await p.waitForTimeout(600);
    ok((await route()) === page, `operator tile “${label}” opens ${page} → ${await route()}`);
  }
  for (const [label, page] of [['Load now', 'op-pricing'], ['Energy today', 'op-reports'], ['Revenue today', 'op-reports']]) {
    await opHome(); await p.locator('.hl-stats > a', { hasText: label }).click(); await p.waitForTimeout(600);
    ok((await route()) === page, `operator hero “${label}” opens ${page}`);
  }
  for (const [title, page] of [['Arriving in the next 4 hours', 'op-bookings'], ['OCPP messages', 'op-alerts']]) {
    await opHome(); await p.locator('.card-go a.card-link', { hasText: title }).click(); await p.waitForTimeout(600);
    ok((await route()) === page, `operator panel “${title}” opens ${page}`);
  }
  await opHome();
  const st2 = await p.evaluate(() => { const c = document.querySelectorAll('[data-op-station]')[1]; return c ? c.dataset.opStation : null; });
  const stCard = p.locator(`[data-op-station="${st2}"]`);
  await clickIn(stCard, (r) => ({ x: r.w - 30, y: 70 }));
  await p.waitForTimeout(600);
  ok((await route()) === 'op-stations' && (await p.evaluate(() => VF.ui.operator ? VF.ui.operator.station : null)) === st2, `clicking a station card opens Stations with that station selected (${st2})`);
  await opHome(); const btn = p.locator('[data-op-station] [data-act]:not([data-act="op-open"])').first();
  if (await btn.count()) { const r0 = await route(); for (let i = 0; i < 4; i++) { try { await btn.evaluate((b) => b.click(), null, { timeout: 3000 }); break; } catch (e) { await p.waitForTimeout(300); } } await p.waitForTimeout(500); const r1 = await route(); await p.keyboard.press('Escape'); ok(r1 === 'op-live', 'a connector button inside a station card runs its own action and doesn’t leave the page (' + r0 + ' → ' + r1 + ')'); }
  // ================================================================ admin: Platform overview
  await as('admin');
  const adHome = async () => { await p.evaluate(() => { location.hash = 'ad-overview'; }); await p.waitForTimeout(700); };
  for (const [label, page] of [['Stations online', 'ad-network'], ['Connectors free', 'ad-network'], ['Charging now', 'ad-network'], ['Bookings today', 'ad-network'], ['Energy today', 'ad-network'], ['Network revenue', 'ad-network'], ['Drivers', 'ad-users']]) {
    await adHome(); await p.locator('a.kpi.go', { hasText: label }).first().click(); await p.waitForTimeout(600);
    ok((await route()) === page, `admin tile “${label}” opens ${page} → ${await route()}`);
  }
  for (const [title, page] of [['Network map', 'ad-network'], ['Operators', 'ad-network'], ['System health', 'ad-system'], ['Sessions by vehicle make', 'ad-vehicles']]) {
    await adHome(); await p.locator('.card-go a.card-link', { hasText: title }).first().click(); await p.waitForTimeout(600);
    ok((await route()) === page, `admin panel “${title}” opens ${page}`);
  }
  await adHome(); const sh = p.locator('section.card-go', { has: p.locator('a.card-link', { hasText: 'System health' }) });
  await clickIn(sh, (r) => ({ x: r.w / 2, y: r.h - 20 })); await p.waitForTimeout(600);
  ok((await route()) === 'ad-system', 'clicking inside the System health panel opens System');
  await adHome(); await p.evaluate(() => { const w = document.querySelector('[data-live="ad-map"]'); const bg = w.querySelector('svg, .lmap') || w; bg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }); await p.waitForTimeout(500);
  ok((await route()) === 'ad-overview', 'clicking the admin map doesn’t leave the overview');
  await adHome(); const kv = await p.evaluate(() => document.querySelector('a.kpi.go .value') && document.querySelector('a.kpi.go .value').textContent);
  await p.waitForTimeout(2500);
  ok(await p.evaluate(() => document.querySelectorAll('a.kpi.go').length === 7), 'admin tiles stay links after the live refresh (' + kv + ')');

  // ================================================================ driver: Home
  await as('driver');
  const dHome = async () => { await p.evaluate(() => { location.hash = 'driver-home'; }); await p.waitForTimeout(800); };
  await dHome();
  const links = await p.evaluate(() => [...document.querySelectorAll('#view .card-go a.card-link, #view a.db-status')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })));
  ok(links.length >= 5, `driver home has linked cards: ${links.map((l) => l.text.slice(0, 24) + ' → ' + l.href).join(', ')}`);
  for (const [i, l] of links.entries()) {
    await dHome(); await p.locator('#view .card-go a.card-link, #view a.db-status').nth(i).click(); await p.waitForTimeout(600);
    ok((await route()) === l.href.slice(1), `driver “${l.text.slice(0, 30)}” opens ${l.href.slice(1)} → ${await route()}`);
  }
  const want = { 'Vehicle health': 'driver-vehicle', 'Chargers on your route': 'driver-charge', 'Range today': 'driver-vehicle' };
  for (const [title, page] of Object.entries(want)) ok(links.some((l) => l.text.startsWith(title) && l.href === '#' + page), `“${title}” links to ${page}`);
  await dHome(); await clickIn(p.locator('#view section.d-battery'), (r) => ({ x: r.w / 2, y: r.h - 16 })); await p.waitForTimeout(600);
  ok((await route()) === 'driver-vehicle', 'tapping the battery card opens My vehicle');
  await dHome(); await clickIn(p.locator('section.card-go', { has: p.locator('a.card-link', { hasText: 'Vehicle health' }) }), (r) => ({ x: r.w / 2, y: r.h - 16 })); await p.waitForTimeout(600);
  ok((await route()) === 'driver-vehicle', 'tapping inside the Vehicle health card opens My vehicle');
  await dHome(); const seeAll = p.locator('[data-act="d-go"][data-tab="driver-charge"]').first(); await seeAll.click(); await p.waitForTimeout(600);
  ok((await route()) === 'driver-charge', 'buttons inside cards keep working (“See all”)');
  await dHome(); await p.evaluate(() => { const w = document.querySelector('#d-mapwrap'); const bg = w && (w.querySelector('svg, .lmap') || w); if (bg) bg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }); await p.waitForTimeout(500);
  ok((await route()) === 'driver-home', 'tapping the map stays on Home (' + await route() + ')');
  await p.evaluate(() => { location.hash = 'driver-charge'; }); await p.waitForTimeout(800);
  ok(await p.evaluate(() => ![...document.querySelectorAll('#view [data-href]')].some((x) => x.dataset.href === '#driver-charge')), 'no card links to the page it is already on');
  await p.setViewportSize({ width: 390, height: 844 }); await dHome();
  await clickIn(p.locator('section.card-go', { has: p.locator('a.card-link', { hasText: 'Chargers on your route' }) }), (r) => ({ x: r.w - 12, y: 14 })); await p.waitForTimeout(600);
  ok((await route()) === 'driver-charge', 'on a phone, tapping a card opens its page');
  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await b.close();
})();
