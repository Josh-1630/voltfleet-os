// QA round 3: app-level fixes in the demo (no server): CSV import, quiet hours, roadside rescue, Connect privacy
// (consent and erasure), one-time secrets, data export completeness, retention, settings validation, OCPP card masking.
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright');
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ serviceWorkers: 'block', acceptDownloads: true }); const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' ')));
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_|status of 4|net::/.test(m.text())) errs.push(m.text()); });
  await p.route(/supabase\.co|fonts\.g|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(500);
  const as = async (role) => { await p.evaluate(() => { try { VF.signOut(); } catch (e) {} }); await p.waitForTimeout(500); await p.click(`[data-role="${role}"]`); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1200); };
  const go = async (h) => { await p.evaluate((x) => { location.hash = x; }, h); await p.waitForTimeout(900); };

  // ---------------------------------------------------------------- R3-06 CSV job import
  await as('manager');
  const csv = await p.evaluate(() => {
    const r1 = VF.ops.parseJobs('﻿ref,client,place,kg,from,to\r\nPO-1,"Makola, wholesale",Accra Central,640,8,11\nPO-2,"=HYPERLINK(""http://x"")",Osu,80,10,13\n"PO-3","Multi\nline client",Tema,900,8,12\nPO-4,Bad hours,Osu,10,9.5,12\n');
    const r2 = VF.ops.parseJobs('ref;client;place;kg;from;to\nPO-9;Pharmacy;Madina;45;9;12\n');
    const r3 = VF.ops.parseJobs('ref,client,place,kg,from,to\n' + 'x,'.repeat(120000));
    return { n: r1.jobs && r1.jobs.length, names: r1.jobs && r1.jobs.map((j) => j.name), bad: r1.bad, err: r1.error, semi: r2.jobs && r2.jobs.map((j) => j.name + '@' + j.node), big: r3.error };
  });
  ok(csv.n === 3 && csv.names[0] === 'Makola, wholesale' && csv.names[2] === 'Multi line client', 'CSV: quoted comma and line break kept in one field, Excel BOM ignored: ' + JSON.stringify(csv.names));
  ok(csv.names[1] === 'HYPERLINK( http://x )' && csv.bad.length === 1, 'CSV: formula prefix and quotes stripped from names; fractional hours refused');
  ok(csv.semi && csv.semi[0] === 'Pharmacy@madina', 'CSV: semicolon-separated export (European Excel) works');
  ok(/too large/.test(csv.big || ''), 'CSV: oversized paste refused');

  // ---------------------------------------------------------------- R3-07 quiet hours that don't cross midnight
  const q = await p.evaluate(() => {
    const c = VF.ops.cfg(); const save = { quiet: Object.assign({}, c.quiet), hourOf: VF.hourOf };
    c.quiet = { on: true, from: 13, to: 15 }; VF.hourOf = () => 14;
    VF.ops.send('restored', { depot: 'Test depot' }, 'manager');
    const queued = c.outbox[0].status;
    VF.hourOf = () => 16; VF.tickHooks.forEach((f) => { try { f(); } catch (e) { /* other hooks */ } });
    const after = c.outbox[0].status;
    VF.hourOf = save.hourOf; c.quiet = save.quiet;
    return { queued, after, inQ: [VF.ops.inQuiet({ on: true, from: 21, to: 6 }, 23), VF.ops.inQuiet({ on: true, from: 21, to: 6 }, 7), VF.ops.inQuiet({ on: true, from: 13, to: 15 }, 14)] };
  });
  ok(q.queued === 'queued' && q.after === 'simulated' && q.inQ.join() === 'true,false,true', 'quiet hours 13–15: queued at 14:00, released at 16:00 (used to stay queued forever)');

  // ---------------------------------------------------------------- settings validation and retention (admin)
  await as('admin'); await go('ad-privacy');
  const before = await p.evaluate(() => VF.state.settings.retention.sessions);
  await p.fill('#ret-s', ''); await p.dispatchEvent('#ret-s', 'change'); await p.waitForTimeout(300);
  await p.fill('#ret-a', '10'); await p.dispatchEvent('#ret-a', 'change'); await p.waitForTimeout(300);
  const ret = await p.evaluate(() => VF.state.settings.retention);
  ok(ret.sessions === before && ret.audit === 2555, 'retention: an emptied field or 10-day audit log is refused (used to save 0 days): ' + JSON.stringify(ret));
  await go('ad-system'); await p.fill('#s-res', '900'); await p.dispatchEvent('#s-res', 'change'); await p.fill('#s-cur', 'G$'); await p.dispatchEvent('#s-cur', 'change'); await p.waitForTimeout(300);
  ok(await p.evaluate(() => VF.state.settings.reserve === 10 && VF.state.settings.currency === 'GHS'), 'settings: reserve 900% and currency "G$" refused');
  const rr = await p.evaluate(() => {
    const s = VF.state; const now = VF.now(); const DAY = VF.DAY;
    s.sessions.push(Object.assign({}, s.sessions[0], { id: 'old-se', start: now - 2300 * DAY, end: now - 2300 * DAY + 3600e3 }));
    const b = s.bookings.find((x) => x.status !== 'confirmed') || s.bookings[0]; const st = b.status; b.status = 'completed'; b.end = now - 3 * DAY; b.start = b.end - 3600e3; b.eta = b.start + 600e3;
    s.audit.push({ t: now - 3000 * DAY, actor: 'u-admin', role: 'admin', action: 'export', target: 'ancient', reason: null });
    VF.applyRetention(true);
    return { oldSession: s.sessions.some((x) => x.id === 'old-se'), eta: b.eta === b.start, audit: s.audit.some((a) => a.target === 'ancient') };
  });
  ok(!rr.oldSession && rr.eta && !rr.audit, 'retention applied: 6.3-year-old billing record (floor now 6 years, R4-03), 3-day-old arrival time and 8-year-old audit entry removed');

  // ---------------------------------------------------------------- Connect: secrets never in the snapshot
  await as('developer'); await go('dev-apps');
  const sec = await p.evaluate(() => ({ plain: VF.state.connect.apps.filter((a) => !/•/.test(a.secret)).length, wh: VF.state.connect.webhooks.filter((w) => !/•/.test(w.secret)).length, revealBtn: !!document.querySelector('[data-act="dev-secret"]') }));
  ok(sec.plain === 0 && sec.wh === 0 && !sec.revealBtn, 'Connect: no plaintext app or webhook secret in the shared snapshot, no "Reveal"');
  await p.click('[data-act="dev-rotate"]'); await p.waitForTimeout(400);
  const rot = await p.evaluate(() => { const id = Object.keys(VF.ui.connect.fresh)[0]; const s = VF.ui.connect.fresh[id]; return { s, inSnap: VF.stateJSON(VF.state).includes(s), shown: document.body.textContent.includes(s), tail: VF.state.connect.apps.find((a) => a.id === id).secretTail === s.slice(-4) }; });
  ok(/^vfs_[0-9a-f]{48}$/.test(rot.s) && !rot.inSnap && rot.shown && rot.tail, 'Connect: rotated secret is random (crypto), shown once in this tab, never written to the snapshot');
  await go('dev-overview'); await go('dev-apps');
  ok(await p.evaluate(() => !Object.keys(VF.ui.connect.fresh).length && !document.body.textContent.match(/vfs_[0-9a-f]{48}/)), 'Connect: leaving the page forgets it');

  const redir = await p.evaluate(() => { const a = VF.state.connect.apps.find((x) => x.id === 'app1'); const r0 = a.redirect; const tryUri = (v) => { VF.CHG['dev-redirect']({ value: v, dataset: { id: 'app1' } }); return a.redirect; };
    return { http: tryUri('http://evil.example/cb') === r0, js: tryUri('javascript:alert(1)') === r0, frag: tryUri('https://x.example/cb#t') === r0, local: tryUri('http://localhost:3000/cb') === 'http://localhost:3000/cb', https: tryUri('https://app.fleetpay.example/cb') === 'https://app.fleetpay.example/cb' }; });
  ok(Object.values(redir).every(Boolean), 'Connect redirect URIs: https only (http just for localhost), no fragments: ' + JSON.stringify(redir));
  // ---------------------------------------------------------------- Connect: consent and erasure reach third-party apps
  // Call the simulated Connect API as the FleetPay developer, without leaving the current page.
  const api = (did, ep) => p.evaluate(([did, ep]) => { const s0 = VF.session, r0 = VF.rerender; VF.rerender = () => {}; try { VF.session = { userId: 'u-dev1' }; const g = VF.state.connect.grants.find((x) => x.driverId === did && x.appId === 'app1'); if (!g) return { status: 'no grant' }; VF.ui.connect.app = 'app1'; VF.ui.connect.ex = { ep, vid: g.vid, action: 'START' }; VF.ACT['dev-send'](); const l = VF.ui.connect.last; return { status: l.status, code: l.body && l.body.code }; } finally { VF.session = s0; VF.rerender = r0; } }, [did || 'd1', ep || 'battery']);
  ok((await api()).status === 200, 'Connect API: driver d1 shares battery with FleetPay (baseline)');
  await as('driver'); // demo driver is d1
  await p.evaluate(() => { const u = VF.user(VF.session.userId); VF.ACT['d-consent']({ dataset: { k: 'telematics', v: '0' } }); return u.driverId; });
  const paused = await api();
  ok(paused.status === 403 && paused.code === 'VEHICLE_DATA_PAUSED', 'Connect API: after the driver switches vehicle data off, apps get 403 VEHICLE_DATA_PAUSED (used to keep returning data): ' + JSON.stringify(paused));
  ok(await p.evaluate(() => VF.state.connect.grants.some((g) => g.driverId === 'd1' && !g.revoked)), 'grant kept while paused (the driver can switch back on)');
  await p.evaluate(() => { VF.ACT['d-consent']({ dataset: { k: 'telematics', v: '1' } }); });
  ok((await api()).status === 200, 'Connect API: switched back on, data flows again');

  // ---------------------------------------------------------------- driver: rescue, export, consent withdrawal, erasure
  await as('driver');
  const res = await p.evaluate(async () => {
    const u = VF.user(VF.session.userId); const d = VF.driver(u.driverId); const v = VF.driverVehicle(d.id);
    const bal = () => VF.driverWallet(d, u).balance;
    v.soc = 50; d.rescue = null; const b0 = bal();
    await VF.ACT['d-rescue'](); const refusedHealthy = !d.rescue;
    v.soc = 6; VF.c.confirm = async () => true;
    await VF.ACT['d-rescue'](); const ref1 = d.rescue && d.rescue.ref; await VF.ACT['d-rescue']();
    const charged = b0 - bal(); const sameRescue = d.rescue.ref === ref1;
    d.rescue.eta = VF.now() - 1; VF.tickHooks.forEach((f) => { try { f(); } catch (e) {} });
    const done = d.rescue.status; VF.ACT['d-rescue-cancel'](); const afterCancel = b0 - bal();
    return { refusedHealthy, charged, sameRescue, done, afterCancel };
  });
  ok(res.refusedHealthy && res.charged === 150 && res.sameRescue, 'rescue: refused with a healthy battery; a second tap doesn’t send a second van or charge twice (fee ' + res.charged + ')');
  ok(res.done === 'done' && res.afterCancel === 150, 'rescue: a finished rescue can’t be "cancelled" for a refund');
  const eta = await p.evaluate(() => { const u = VF.user(VF.session.userId); const d = VF.driver(u.driverId); const b = VF.state.bookings.find((x) => x.driverId === d.id) || VF.state.bookings[0]; b.driverId = d.id; b.eta = b.start + 777e3; VF.ACT['d-consent']({ dataset: { k: 'shareEta', v: '0' } }); return b.eta === b.start; });
  ok(eta, 'withdrawing "share arrival time" drops the live arrival times already shared');
  await go('driver-privacy');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.evaluate(() => VF.ACT['d-export']({ dataset: { mode: 'dl' } }))]);
  const exp = JSON.parse(require('fs').readFileSync(await dl.path(), 'utf8'));
  ok(exp.wallet && exp.wallet.transactions.length > 0 && exp.roadsideRescue && Array.isArray(exp.connectedApps) && exp.connectedApps.length > 0 && 'alertPreferences' in exp && Array.isArray(exp.notifications), 'data export now includes wallet, rescue, connected apps, alert preferences, notifications: ' + Object.keys(exp).join(','));
  const er = await p.evaluate(() => {
    const u = VF.user(VF.session.userId); const d = VF.driver(u.driverId); d.alertPrefs = { ch: 'sms', lang: 'tw' }; d.precool = { at: VF.now() + 3600e3 };
    const did = d.id; VF.ACT['d-delete-yes']();
    const grants = VF.state.connect.grants.filter((g) => g.driverId === did);
    return { revoked: grants.length && grants.every((g) => g.revoked), notice: VF.state.connect.deliveries.some((x) => x.event === 'vehicle.disconnected' && x.payload.data && x.payload.data.reason === 'account_deleted'), wallet: d.wallet && d.wallet.method && d.wallet.method.to, prefs: d.alertPrefs, rescue: d.rescue, precool: d.precool, did };
  });
  ok(er.revoked && er.notice, 'erasure revokes every Connect grant and tells the apps to delete the data (they used to keep live access)');
  ok(er.wallet === '—' && er.prefs === undefined && er.rescue === null && er.precool === null, 'erasure clears wallet number, alert preferences, rescue record and pre-cool schedule: ' + JSON.stringify(er));
  const gone = await api(er.did, 'location');
  ok(gone.status === 401, 'Connect API: erased driver’s vehicle answers 401 ACCESS_REVOKED');

  // ---------------------------------------------------------------- operator: OCPP log masks card numbers
  await p.evaluate(() => { VF.ACT['ad-reset-yes'] && VF.ACT['ad-reset-yes'](); }); await p.waitForTimeout(400);
  await as('operator');
  await p.evaluate(() => { const O = VF.ocppNet; if (O.sync) O.sync(); O.key = 'k'.repeat(30); O.poll = async () => {}; O.data = { network: { id: 'n', name: 'Test net' }, serverTime: Date.now(), heartbeat: 60, chargePoints: [], transactions: [], commands: [], idTags: [], log: [{ id: 1, cpId: 'CP-1', dir: 'in', kind: 'CALL', action: 'Authorize', payload: { idTag: '04A1B2C3D4E5' }, at: Date.now() }, { id: 2, cpId: 'CP-1', dir: 'out', kind: 'CALL', action: 'RemoteStartTransaction', payload: { connectorId: 1, idTag: 'CARD-778899', chargingProfile: { parentIdTag: 'PARENT-123456' } }, at: Date.now() }] }; });
  await go('op-ocpp');
  const logTxt = await p.evaluate(() => (document.querySelector('.oc-log') || {}).textContent || '');
  ok(logTxt.includes('Authorize') && !/04A1B2C3D4E5|CARD-778899|PARENT-123456/.test(logTxt) && logTxt.includes('04•••E5'), 'OCPP message log masks card numbers (idTag, parentIdTag), like the rest of the page');

  const price = await p.evaluate(() => {
    const u = VF.user(VF.session.userId); const o = VF.operator(u.operatorId); const k = Object.keys(o.pricing).find((x) => typeof o.pricing[x] === 'number'); const before = o.pricing[k];
    VF.CHG['op-price']({ value: '', dataset: { k } }); const afterEmpty = o.pricing[k];
    VF.CHG['op-price']({ value: '1e400', dataset: { k } }); const afterHuge = o.pricing[k];
    const st = VF.state.stations.find((x) => x.operatorId === o.id); const cap0 = st.capKw; VF.CHG['op-cap']({ value: '1e400', dataset: { id: st.id } });
    return { k, before, afterEmpty, afterHuge, cap: st.capKw === cap0 };
  });
  ok(price.afterEmpty === price.before && price.afterHuge === price.before && price.cap, 'operator pricing: an emptied price field no longer makes charging free; infinite values refused: ' + JSON.stringify(price));
  console.log('errors:', errs.length ? errs.join('\n') : 'none');
  console.log(fails ? `${fails} FAILED` : 'all passed');
  await b.close();
})();
