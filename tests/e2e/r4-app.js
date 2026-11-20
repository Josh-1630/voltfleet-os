// QA round 4: app-level fixes. Part A in the demo (no server); part B signed in against the in-memory Supabase stand-in.
//   node qa4/r4-app.js [base]   (base defaults to http://localhost:8080; the committed code can be served elsewhere for "before")
// Made-up data only.
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright');
const fs = require('fs');
const FAKE = fs.readFileSync(FIX + '/fake-supabase.js', 'utf8');
const BASE = process.argv[2] || 'http://localhost:8080';
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const BLOCK = /supabase\.co|fonts\.g|cartocdn|osrm|wikipedia|wikimedia|open-meteo|challenges\.cloudflare/;
(async () => {
  const b = await chromium.launch(); const errs = [];
  const watch = (p) => { p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' '))); p.on('console', (m) => { if (m.type() === 'error' && !/ERR_|status of 4|net::|offline \(test\)/.test(m.text())) errs.push(m.text()); }); };

  // ================================================================ A. demo
  const ctx = await b.newContext({ serviceWorkers: 'block' }); const p = await ctx.newPage(); watch(p);
  const scCalls = [];
  await p.route(BLOCK, (r) => r.abort());
  await p.route(/functions\/v1\/smartcar/, async (r) => { const body = JSON.parse(r.request().postData() || '{}'); scCalls.push(body.action); await r.fulfill({ contentType: 'application/json', body: JSON.stringify(body.action === 'vehicles' ? { vehicles: [] } : { ok: true }) }); });
  await p.addInitScript(() => {
    // R4-05: a photo cache entry with script links, as tampering (or an old bug) could leave on the device.
    try { if (!sessionStorage.getItem('r4-seeded')) { sessionStorage.setItem('r4-seeded', '1'); localStorage.setItem('voltfleet-os:photos-v1', JSON.stringify({ at: Date.now(), map: { 'Zz Test Car': { src: 'javascript:alert(1)', licenseUrl: 'javascript:alert(2)', source: 'https://commons.wikimedia.org/x', artist: 'A', license: 'L' }, __proto__x: {} } })); } } catch (e) {}
  });
  await p.goto(BASE + '/?demo'); await p.waitForTimeout(600);
  const as = async (role) => { await p.evaluate(() => { try { VF.signOut(); } catch (e) {} }); await p.waitForTimeout(400); await p.click(`[data-role="${role}"]`); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1000); };
  const go = async (h) => { await p.evaluate((x) => { location.hash = x; }, h); await p.waitForTimeout(800); };

  // ---------------------------------------------------------------- R4-05 cached photo links are checked again
  const ph = await p.evaluate(() => { const x = VF.photos.map['Zz Test Car']; return x ? { src: x.src, lic: x.licenseUrl, source: x.source } : null; });
  ok(ph && ph.src === '' && ph.lic === '' && ph.source === 'https://commons.wikimedia.org/x', 'R4-05 cached photo entry: javascript: links dropped, https kept: ' + JSON.stringify(ph));

  // ---------------------------------------------------------------- R4-03 retention keeps wallet balances and billing records for 6 years
  await as('driver');
  const wal = await p.evaluate(() => {
    const s = VF.state; const now = VF.now(); const DAY = VF.DAY;
    const u = VF.user(VF.session.userId); const d = s.drivers.find((x) => x.id === u.driverId);
    const st = s.stations[0];
    VF.driverWallet(d, u); // makes sure the wallet exists
    d.wallet.since = now - 3000 * DAY;
    d.wallet.tx.push({ id: 'wt-old', t: now - 2300 * DAY, kind: 'topup', amount: 500, provider: 'MTN MoMo', ref: 'MM-OLD' });
    s.sessions.push({ id: 'se-old7', stationId: st.id, driverId: d.id, start: now - 2300 * DAY, end: now - 2300 * DAY + 3600e3, kwh: 20, cost: 120, type: 'CCS2' });
    s.sessions.push({ id: 'se-800', stationId: st.id, driverId: d.id, start: now - 800 * DAY, end: now - 800 * DAY + 3600e3, kwh: 10, cost: 60, type: 'CCS2' });
    s.settings.retention.sessions = 730; // saved under the old limits
    const before = VF.driverWallet(d, u).balance;
    VF.applyRetention(true);
    const L = VF.driverWallet(d, u);
    return { before, after: L.balance, carry: d.wallet.carry, row: L.rows.some((r) => r.kind === 'carry' && r.label === 'Balance brought forward'), old7: s.sessions.some((x) => x.id === 'se-old7'), s800: s.sessions.some((x) => x.id === 'se-800'), oldTx: d.wallet.tx.some((x) => x.id === 'wt-old'), period: s.settings.retention.sessions };
  });
  ok(Math.abs(wal.before - wal.after) < 0.005, `R4-03 wallet balance unchanged by retention: ${wal.before} -> ${wal.after}`);
  ok(wal.carry === 380 && wal.row && !wal.old7 && !wal.oldTx, 'R4-03 records over 6 years removed, carried forward as one "Balance brought forward" amount (GHS 380)');
  ok(wal.s800 && wal.period === 2190, 'R4-03 a 2-year-old billing record is kept; a period saved as 730 days moves to the 6-year floor (2190)');
  await go('driver-wallet');
  ok(await p.evaluate(() => /Balance brought forward/.test(document.querySelector('#view').textContent)), 'R4-03 wallet page shows the brought-forward line');
  await as('admin'); await go('ad-privacy');
  await p.fill('#ret-s', '30'); await p.dispatchEvent('#ret-s', 'change'); await p.waitForTimeout(300);
  ok(await p.evaluate(() => VF.state.settings.retention.sessions === 2190), 'R4-03 billing retention of 30 days refused (floor 6 years)');
  await p.fill('#ret-s', '3000'); await p.dispatchEvent('#ret-s', 'change'); await p.waitForTimeout(300);
  ok(await p.evaluate(() => VF.state.settings.retention.sessions === 3000), 'R4-03 a longer period (3000 days) is accepted');

  // ---------------------------------------------------------------- R4-06 Connect plan prices
  await go('ad-connect');
  const pr0 = await p.evaluate(() => JSON.stringify(VF.state.connect.pricing));
  const setPrice = async (v) => { await p.evaluate((x) => { const el = document.getElementById('pr-build'); el.value = x; el.dispatchEvent(new Event('change', { bubbles: true })); }, v); await p.waitForTimeout(250); };
  await setPrice(''); const prEmpty = await p.evaluate(() => VF.state.connect.pricing.build);
  await setPrice('1e400'); const prInf = await p.evaluate(() => VF.state.connect.pricing.build);
  await setPrice('2.5'); const prOk = await p.evaluate(() => VF.state.connect.pricing.build);
  ok(prEmpty === JSON.parse(pr0).build && prInf === JSON.parse(pr0).build && prOk === 2.5, `R4-06 Connect price: empty and 1e400 refused, 2.5 saved (${pr0} -> empty ${prEmpty}, 1e400 ${prInf}, ${prOk})`);

  // ---------------------------------------------------------------- R4-08 maintenance cost and vehicle year
  await as('manager');
  const vid = await p.evaluate(() => VF.state.fleet.vehicles.find((v) => !v.real).id);
  await p.evaluate((id) => VF.ACT['m-add-maint']({ dataset: { id } }), vid); await p.waitForTimeout(300);
  await p.fill('#dlg-form [name=type]', 'Brake pads'); await p.fill('#dlg-form [name=cost]', '-500'); await p.click('#dlg-form button[type=submit]'); await p.waitForTimeout(250);
  const neg = await p.evaluate((id) => ({ shown: !!document.getElementById('dlg-error') && !document.getElementById('dlg-error').hidden, saved: VF.state.fleet.vehicles.find((v) => v.id === id).maintenance.some((m) => m.cost < 0) }), vid);
  if (neg.shown) { await p.fill('#dlg-form [name=cost]', '350.5'); await p.click('#dlg-form button[type=submit]'); await p.waitForTimeout(250); }
  const pos = await p.evaluate((id) => VF.state.fleet.vehicles.find((v) => v.id === id).maintenance[0], vid);
  ok(neg.shown && !neg.saved && pos.cost === 350.5 && pos.type === 'Brake pads', 'R4-08 maintenance: a negative cost is refused, 350.50 saved');
  await p.evaluate(() => VF.ACT['m-add-vehicle']()); await p.waitForTimeout(300);
  await p.fill('#dlg-form [name=plate]', 'GR 9999-25'); await p.fill('#dlg-form [name=vin]', 'LGXCE4CB0P0123456'); await p.fill('#dlg-form [name=year]', '99999'); await p.click('#dlg-form button[type=submit]'); await p.waitForTimeout(250);
  const yr = await p.evaluate(() => ({ err: document.getElementById('dlg-error') && !document.getElementById('dlg-error').hidden ? document.getElementById('dlg-error').textContent : '', added: VF.state.fleet.vehicles.some((v) => v.plate === 'GR 9999-25') }));
  await p.evaluate(() => VF.ACT['dlg-close']());
  ok(/model year/i.test(yr.err) && !yr.added, 'R4-08 add vehicle: model year 99999 refused');

  // ---------------------------------------------------------------- R4-07 schematic-map note link is underlined
  await p.evaluate(() => { VF.maps.failed = true; location.hash = 'm-dashboard'; VF.rerender && VF.rerender(); }); await p.waitForTimeout(800);
  const deco = await p.evaluate(() => { const a = document.querySelector('.map-note a'); return a ? getComputedStyle(a).textDecorationLine : 'no link'; });
  ok(/underline/.test(deco), 'R4-07 link in the map note is underlined: ' + deco);

  // ---------------------------------------------------------------- R4-01 device-held keys belong to their owner
  const own = await p.evaluate(() => {
    localStorage.setItem('voltfleet-os:smartcar', JSON.stringify({ byOwner: { 'acct:abc': { key: 'sc-key-of-account', names: {}, vehicles: [] } } }));
    localStorage.setItem('voltfleet-os:ocpp', JSON.stringify({ byOwner: { 'acct:abc': { key: 'net-key-of-account', name: 'Account network' } } }));
    return 'seeded';
  });
  await p.reload(); await p.waitForTimeout(900);
  const demoView = await p.evaluate(() => { VF.real.sync(); VF.ocppNet.sync(); return { sc: VF.real.key, oc: VF.ocppNet.key }; });
  ok(own === 'seeded' && demoView.sc === null && demoView.oc === null, 'R4-01 the demo on the same browser does not load an account\'s Smartcar key or OCPP network key: ' + JSON.stringify(demoView));
  const legacy = await p.evaluate(() => {
    localStorage.setItem('voltfleet-os:ocpp', JSON.stringify({ key: 'legacy-net', name: 'Old' }));
    return true;
  });
  await p.reload(); await p.waitForTimeout(700);
  const leg = await p.evaluate(() => { VF.ocppNet.sync(); return VF.ocppNet.key; });
  ok(legacy && leg === 'legacy-net', 'R4-01 a key saved by an older version stays usable in the demo');
  await ctx.close();

  // ================================================================ B. signed in (in-memory Supabase stand-in)
  const c2 = await b.newContext({ serviceWorkers: 'block' }); const q = await c2.newPage(); watch(q);
  const sc2 = [];
  await q.route(/supabase-2\.118\.0\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE }));
  await q.route(BLOCK, (r) => r.abort());
  await q.route(/functions\/v1\/smartcar/, async (r) => { const body = JSON.parse(r.request().postData() || '{}'); sc2.push(body.action + ':' + (body.key || '')); await r.fulfill({ contentType: 'application/json', body: JSON.stringify(body.action === 'vehicles' ? { vehicles: [{ id: 'veh1', info: { make: 'BYD', model: 'Atto 3' }, summary: { lat: 5.6037, lon: -0.187, soc: 50 }, fetchedAt: Date.now() }] } : { ok: true }) }); });
  await q.goto(BASE + '/'); await q.waitForTimeout(900);
  const off = await q.evaluate(() => ({ slot: !!document.querySelector('.captcha-slot'), script: [...document.scripts].some((s) => /challenges\.cloudflare|hcaptcha/.test(s.src)), on: VF.auth.captchaOn }));
  ok(!off.slot && !off.script && off.on === false, 'CAPTCHA off by default: no widget, no third-party script');
  // a driver account (no second factor needed)
  await q.click('[data-act="auth-mode"][data-k="signup"]'); await q.waitForTimeout(250); await q.click('[data-act="auth-type"][data-k="driver"]'); await q.waitForTimeout(200);
  await q.fill('#auth-signup [name=fullname]', 'Esi Mensah'); await q.fill('#auth-signup [name=email]', 'esi@r4.example'); await q.fill('#auth-signup [name=password]', 'correct-horse-battery'); await q.check('#auth-signup [name=agree]');
  await q.click('#auth-signup button[type=submit]'); await q.waitForTimeout(500);
  await q.evaluate(() => { const db = JSON.parse(localStorage.getItem('fake-sb-db')); for (const u of Object.values(db.users)) u.confirmed = true; localStorage.setItem('fake-sb-db', JSON.stringify(db)); });
  await q.click('[data-act="auth-mode"][data-k="signin"]'); await q.waitForTimeout(200);
  await q.fill('#auth-signin [name=email]', 'esi@r4.example'); await q.fill('#auth-signin [name=password]', 'correct-horse-battery'); await q.click('#auth-signin button[type=submit]'); await q.waitForTimeout(2200);
  const acct = await q.evaluate(() => ({ mode: VF.mode, id: VF.auth.account && VF.auth.account.id, route: location.hash }));
  ok(acct.mode === 'account' && acct.id, 'signed in as a driver account: ' + JSON.stringify(acct));
  // a car connected in this account (as the Smartcar redirect would leave it), then one poll stores its reading
  await q.evaluate(async () => { VF.real.sync(); VF.real.key = 'sc-key-esi'; await VF.real.poll(true); });
  const loaded = await q.evaluate(() => { const v = localStorage.getItem('voltfleet-os:smartcar') || ''; return v.includes('sc-key-esi') && v.includes('5.6037') ? 'sc-key-esi' : v; });
  // R4-04: the person's copy in the workspace snapshot is scrubbed before leaving or deleting
  const scrub = await q.evaluate(async () => {
    const id = VF.auth.account.id; const uid = VF.state.members[id]; const before = Object.assign({}, VF.user(uid));
    await VF.auth.scrubMember(id, true);
    const u = VF.user(uid);
    return { before: { name: before.name, email: before.email }, after: { name: u.name, email: u.email, phone: u.phone }, mapped: !!VF.state.members[id] };
  });
  const server = await q.evaluate(async () => {
    const db = JSON.parse(localStorage.getItem('fake-sb-db')); const w = Object.values(db.worlds).find((x) => x.state_gz);
    if (!w) return null; const t = w.state_gz; let json;
    if (t.startsWith('j:')) json = t.slice(2); else { const bin = atob(t.slice(3)); const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0)); json = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); }
    return { hasEmail: json.includes('esi@r4.example'), hasName: json.includes('Esi Mensah') };
  });
  ok(scrub.before.email === 'esi@r4.example' && scrub.after.name === 'Former member' && scrub.after.email === '' && !scrub.mapped, 'R4-04 erasure: the person\'s name and email are taken out of the workspace snapshot: ' + JSON.stringify(scrub.after));
  ok(server && !server.hasEmail && !server.hasName, 'R4-04 the scrubbed snapshot reached the server before leaving: ' + JSON.stringify(server));
  // if the server refuses the deletion, the person stays a member and their details come back
  await q.evaluate(() => { const o = VF.sb.rpc.bind(VF.sb); VF.sb.rpc = (fn, a) => (fn === 'delete_my_account' ? Promise.resolve({ data: null, error: { message: 'offline (test)' } }) : o(fn, a)); window.__restoreRpc = () => { VF.sb.rpc = o; }; });
  await q.evaluate(() => { VF.ACT['acct-delete'](); }); await q.waitForTimeout(300); await q.click('#dlg-ok'); await q.waitForTimeout(1200);
  const back = await q.evaluate(() => { window.__restoreRpc(); const id = VF.auth.account.id; const u = VF.user(VF.state.members[id]); return { mapped: !!VF.state.members[id], name: u && u.name, email: u && u.email, leaving: !!VF.auth.leaving }; });
  ok(back.mapped && back.name === 'Esi Mensah' && back.email === 'esi@r4.example' && !back.leaving, 'R4-04 a refused deletion puts the member\'s details back: ' + JSON.stringify(back));
  // R4-01 sign-out disconnects the account's cars and removes them from this browser
  await q.evaluate(() => VF.auth.signOut(false)); await q.waitForTimeout(2500);
  const after = await q.evaluate(() => ({ store: localStorage.getItem('voltfleet-os:smartcar'), org: Object.keys(localStorage).filter((k) => k.startsWith('voltfleet-os:org:')).length, signin: !!document.querySelector('.auth') }));
  ok(loaded === 'sc-key-esi' && sc2.includes('disconnect:sc-key-esi'), 'R4-01 signing out disconnects the account\'s connected car on the server: ' + JSON.stringify(sc2));
  ok(after.signin && after.org === 0 && !/sc-key-esi|5\.6037/.test(after.store || ''), 'R4-01 after sign-out no key or vehicle reading (location) of that account is left in the browser: ' + (after.store || 'none'));
  await c2.close();

  // ================================================================ C. CAPTCHA switched on (made-up site key, stub widget)
  const c3 = await b.newContext({ serviceWorkers: 'block', bypassCSP: true }); const r3 = await c3.newPage(); watch(r3);
  await r3.route(/supabase-2\.118\.0\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE }));
  await r3.route(/supabase\.co|fonts\.g|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await r3.route(/js\/config\.js/, async (r) => { const res = await r.fetch(); const body = (await res.text()).replace(/siteKey: ''/, "siteKey: 'test-site-key-0000'"); await r.fulfill({ response: res, body }); });
  await r3.route(/challenges\.cloudflare\.com/, (r) => r.fulfill({ contentType: 'application/javascript', body: "window.turnstile = { n: 0, render(el) { el.textContent = 'stub check'; return 'w' + (++this.n); }, getResponse() { return window.__solved ? 'tok-r4' : ''; }, reset() { window.__resets = (window.__resets || 0) + 1; }, remove() {} };" }));
  await r3.goto(BASE + '/'); await r3.waitForTimeout(1200);
  const on = await r3.evaluate(() => ({ on: VF.auth.captchaOn, slot: !!document.querySelector('#auth-captcha'), rendered: (document.querySelector('#auth-captcha') || {}).textContent }));
  await r3.evaluate(() => { const o = VF.sb.auth.signInWithPassword.bind(VF.sb.auth); VF.sb.auth.signInWithPassword = (a) => { window.__args = a; return o(a); }; });
  await r3.fill('#auth-signin [name=email]', 'kofi@r4.example'); await r3.fill('#auth-signin [name=password]', 'whatever-password'); await r3.click('#auth-signin button[type=submit]'); await r3.waitForTimeout(300);
  const unsolved = await r3.evaluate(() => ({ err: document.getElementById('auth-error').textContent, sent: !!window.__args }));
  await r3.evaluate(() => { window.__solved = true; }); await r3.click('#auth-signin button[type=submit]'); await r3.waitForTimeout(500);
  const solved = await r3.evaluate(() => ({ token: window.__args && window.__args.options && window.__args.options.captchaToken, resets: window.__resets || 0 }));
  ok(on.on && on.slot && on.rendered === 'stub check', 'CAPTCHA on with a site key: widget rendered on the sign-in form');
  ok(/security check/.test(unsolved.err) && !unsolved.sent, 'CAPTCHA on: unsolved check stops the request before it is sent');
  ok(solved.token === 'tok-r4' && solved.resets >= 1, 'CAPTCHA on: the token goes to Supabase Auth with the sign-in, then the widget resets');
  await c3.close();

  const real = errs.filter((e) => !/Failed to load resource/.test(e));
  ok(!real.length, 'no page errors' + (real.length ? ': ' + real.slice(0, 3).join(' | ') : ''));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await b.close();
})();
