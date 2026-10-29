/* VoltFleet Connect — the developer platform.
   Third-party apps (fleet managers, insurers, ride-hailing, energy companies) get one API for any EV make.
   Drivers grant access through the Connect consent flow, scope by scope, and can revoke it at any time.
   Apps only ever see a per-app vehicle ID: never the driver's name, phone, plate or VIN. */
'use strict';
(function () {
  const { esc, clamp, sum, fmt, icon, pill, hash } = VF;
  const MIN = VF.MIN, DAY = VF.DAY;
  const ui = VF.ui.connect = { app: null, ex: { app: null, vid: '', ep: 'battery', action: 'START' }, last: null, flow: null, vin: '', compat: null, reveal: {}, whOpen: null, delivery: null, addTest: 'Tesla Model 3' };

  // ---------------------------------------------------------------- reference
  const SCOPES = {
    read_vehicle_info: 'Make, model and year',
    read_battery: 'Battery level and range',
    read_charge: 'Charging status',
    control_charge: 'Start and stop charging',
    read_odometer: 'Odometer',
    read_tires: 'Tyre pressure',
    read_location: 'Location',
    control_security: 'Lock and unlock',
  };
  const ENDPOINTS = [
    { id: 'vehicles', method: 'GET', path: '/v1/vehicles', scope: null, field: null, label: 'List connected vehicles' },
    { id: 'info', method: 'GET', path: '/v1/vehicles/{id}', scope: 'read_vehicle_info', field: null, label: 'Vehicle info' },
    { id: 'battery', method: 'GET', path: '/v1/vehicles/{id}/battery', scope: 'read_battery', field: 'soc', label: 'Battery level and range' },
    { id: 'charge', method: 'GET', path: '/v1/vehicles/{id}/charge', scope: 'read_charge', field: 'charging', label: 'Charging status' },
    { id: 'charge-cmd', method: 'POST', path: '/v1/vehicles/{id}/charge', scope: 'control_charge', field: 'remote', label: 'Start or stop charging', body: ['START', 'STOP'] },
    { id: 'odometer', method: 'GET', path: '/v1/vehicles/{id}/odometer', scope: 'read_odometer', field: 'odo', label: 'Odometer' },
    { id: 'tires', method: 'GET', path: '/v1/vehicles/{id}/tires/pressure', scope: 'read_tires', field: 'tyres', label: 'Tyre pressure' },
    { id: 'location', method: 'GET', path: '/v1/vehicles/{id}/location', scope: 'read_location', field: 'location', label: 'Location' },
    { id: 'security', method: 'POST', path: '/v1/vehicles/{id}/security', scope: 'control_security', field: 'remote', label: 'Lock or unlock', body: ['LOCK', 'UNLOCK'] },
  ];
  const EVENTS = { 'vehicle.connected': 'A driver connected a vehicle', 'vehicle.disconnected': 'A driver revoked access', 'charge.started': 'Charging started', 'charge.completed': 'Charging finished', 'battery.low': 'Battery fell below 20%' };
  const SOURCE = { BYD: 'oem_api', Tesla: 'oem_api', Rivian: 'aggregator', Hyundai: 'aggregator', Kia: 'aggregator', Volkswagen: 'aggregator', Ford: 'aggregator', Nissan: 'obd_dongle', MG: 'obd_dongle' };
  const SOURCE_LABEL = { oem_api: 'Carmaker API', aggregator: 'Aggregator', obd_dongle: 'Plug-in device' };
  const SOURCE_PHRASE = { oem_api: "the carmaker's API", aggregator: 'a data aggregator', obd_dongle: 'a plug-in device' };
  const WMI = { LGX: 'BYD', LC0: 'BYD', '5YJ': 'Tesla', '7SA': 'Tesla', XP7: 'Tesla', LRW: 'Tesla', '7FC': 'Rivian', '7PD': 'Rivian', KMH: 'Hyundai', KM8: 'Hyundai', KNA: 'Kia', KND: 'Kia', SJN: 'Nissan', JN1: 'Nissan', '1N4': 'Nissan', WVW: 'Volkswagen', WVG: 'Volkswagen', LFV: 'Volkswagen', '1FT': 'Ford', WF0: 'Ford', LSJ: 'MG', SDP: 'MG' };
  const VIN_EXAMPLES = [['LGXCE4CB0P0012345', 'BYD'], ['XP7YGCEK5PB123456', 'Tesla'], ['7FCTGAAA1PN012345', 'Rivian'], ['SJNFAAZE1U0123456', 'Nissan']];
  const PLANS = { free: { name: 'Sandbox', note: 'Test vehicles only, plus 1 live vehicle' }, build: { name: 'Build', note: 'Per live vehicle per month' }, scale: { name: 'Scale', note: 'Volume rate, 99.9% SLA, dedicated support' } };
  const shortScope = (k) => k.replace(/^read_/, '').replace(/^control_(.*)/, '$1 control').replace('_', ' ');
  const sourceOf = (make) => SOURCE[make] || 'obd_dongle';
  const oemRow = (make) => VF.OEMS.find((o) => o.id === make) || VF.OEMS[VF.OEMS.length - 1];
  function capable(make, field) {
    if (!field) return true;
    if (field === 'remote' && sourceOf(make) === 'obd_dongle') return false;
    const i = VF.TELEMETRY_FIELDS.findIndex((f) => f[0] === field);
    return oemRow(make).cov[i] > 0;
  }
  const appVid = (appId, key) => 'veh_' + hash(appId + ':' + key).toLowerCase();
  const C = () => VF.state.connect;
  const app = (id) => C().apps.find((a) => a.id === id);
  const org = (id) => C().orgs.find((o) => o.id === id);
  const me = () => VF.user(VF.session.userId);
  const myApps = () => C().apps.filter((a) => a.orgId === me().orgId);
  const liveGrants = (appId) => C().grants.filter((g) => g.appId === appId && !g.revoked);

  // ---------------------------------------------------------------- seed
  VF.seedConnect = function () {
    const s = VF.state; const now = VF.now(); const r = VF.mulberry32(77);
    if (!s.users.some((u) => u.id === 'u-dev1')) s.users.push({ id: 'u-dev1', role: 'developer', name: 'Esi Quansah', email: 'esi@fleetpay.example', phone: '+233 24 555 7781', orgId: 'org1', demo: true, joined: now - 60 * DAY });
    const orgs = [{ id: 'org1', name: 'FleetPay Ghana', kind: 'EV financing' }, { id: 'org2', name: 'Kumasi Ride', kind: 'Ride-hailing' }, { id: 'org3', name: 'SafeDrive Insurance', kind: 'Pay-per-km insurance' }];
    const sc = (req, opt) => req.map((x) => ({ scope: x, required: true })).concat((opt || []).map((x) => ({ scope: x, required: false })));
    const creds = (id) => ({ clientId: 'vfc_' + hash(id + 'c').toLowerCase() + hash(id + 'd').toLowerCase().slice(0, 4), secret: 'vfs_' + hash(id + 's1').toLowerCase() + hash(id + 's2').toLowerCase() + hash(id + 's3').toLowerCase() });
    const apps = [
      Object.assign({ id: 'app1', orgId: 'org1', name: 'FleetPay Fleet Manager', mode: 'live', plan: 'build', status: 'active', redirect: 'https://app.fleetpay.example/connect/callback', scopes: sc(['read_vehicle_info', 'read_battery', 'read_charge', 'read_odometer'], ['read_location', 'control_charge']), createdAt: now - 55 * DAY }, creds('app1')),
      Object.assign({ id: 'app2', orgId: 'org1', name: 'FleetPay Sandbox', mode: 'test', plan: 'free', status: 'active', redirect: 'http://localhost:3000/callback', scopes: sc(Object.keys(SCOPES)), createdAt: now - 58 * DAY }, creds('app2')),
      Object.assign({ id: 'app3', orgId: 'org2', name: 'Kumasi Ride Driver', mode: 'live', plan: 'build', status: 'active', redirect: 'https://kumasiride.example/oauth', scopes: sc(['read_vehicle_info', 'read_battery', 'read_charge'], ['read_location']), createdAt: now - 40 * DAY }, creds('app3')),
      Object.assign({ id: 'app4', orgId: 'org3', name: 'SafeDrive Pay-per-km', mode: 'live', plan: 'scale', status: 'active', redirect: 'https://safedrive.example/vf/callback', scopes: sc(['read_vehicle_info', 'read_odometer']), createdAt: now - 120 * DAY }, creds('app4')),
    ];
    const grants = [];
    const sims = s.drivers.filter((d) => d.sim && !d.deleted);
    const grant = (a, d, extraOpt, ago) => {
      const v = VF.driverVehicle(d.id); const make = VF.model(v).oem;
      const scopes = a.scopes.filter((x) => x.required || (extraOpt && extraOpt.includes(x.scope))).map((x) => x.scope);
      grants.push({ id: 'g' + (++s.seq), appId: a.id, vehicleId: v.id, driverId: d.id, vid: appVid(a.id, v.id), scopes, source: sourceOf(make), at: now - ago, revoked: false });
    };
    grant(apps[0], VF.driver('d1'), ['control_charge'], 21 * DAY);
    sims.slice(0, 11).forEach((d) => grant(apps[0], d, r() < 0.35 ? ['read_location'] : r() < 0.5 ? ['control_charge'] : [], Math.floor(r() * 50) * DAY));
    grant(apps[2], VF.driver('d2'), [], 12 * DAY);
    sims.slice(8, 15).forEach((d) => grant(apps[2], d, r() < 0.4 ? ['read_location'] : [], Math.floor(r() * 35) * DAY));
    sims.slice(14, 23).forEach((d) => grant(apps[3], d, [], Math.floor(r() * 110) * DAY));
    const tv = (id, model, soc, node) => ({ id, appId: 'app2', model, vid: appVid('app2', id), soc, odo: Math.round(5000 + r() * 30000), node, plugged: soc < 50, charging: soc < 50, locked: true, tyres: [36, 36, 35, 36], createdAt: now - 30 * DAY });
    const usage = {};
    for (const a of apps) { const base = { app1: 3200, app2: 420, app3: 2100, app4: 900 }[a.id]; usage[a.id] = Array.from({ length: 30 }, (_, i) => Math.round(base * (0.7 + i / 30 * 0.5) * (0.85 + r() * 0.3))); usage[a.id][29] = Math.round(usage[a.id][29] * 0.45); }
    s.connect = {
      orgs, apps, grants, usage, requests: [], deliveries: [], track: {},
      testVehicles: [tv('tv1', 'Tesla Model 3', 72, 'airport'), tv('tv2', 'BYD Atto 3', 41, 'spintex'), tv('tv3', 'Nissan Leaf', 88, 'osu')],
      webhooks: [{ id: 'wh1', appId: 'app1', url: 'https://api.fleetpay.example/hooks/voltfleet', events: ['charge.started', 'charge.completed', 'battery.low', 'vehicle.disconnected'], secret: 'whsec_' + hash('wh1').toLowerCase() + hash('wh1b').toLowerCase(), active: true }],
      pricing: { build: 1.5, scale: 1.1 },
    };
    syncTrack();
    for (let i = 0; i < 14; i++) backgroundCall(now - (14 - i) * 3 * MIN);
    const evs = ['charge.completed', 'charge.started', 'battery.low', 'charge.completed', 'charge.started', 'charge.completed'];
    grants.filter((g) => g.appId === 'app1').slice(0, 6).forEach((g, i) => {
      deliver('app1', evs[i], g.vid, evs[i] === 'battery.low' ? { percentRemaining: 0.18 } : { state: evs[i] === 'charge.started' ? 'CHARGING' : 'NOT_CHARGING', energy_kwh: evs[i] === 'charge.completed' ? +(18 + r() * 20).toFixed(2) : undefined });
      s.connect.deliveries[0].t = now - (6 - i) * 11 * MIN;
    });
  };
  VF.ensureConnect = () => { if (!VF.state.connect) VF.seedConnect(); };
  const resetOrig = VF.reset;
  VF.reset = () => { resetOrig(); VF.seedConnect(); };

  // ---------------------------------------------------------------- the API (simulated server)
  function resolve(a, vid) {
    if (a.mode === 'test') { const t = C().testVehicles.find((x) => x.appId === a.id && x.vid === vid); return t ? { test: t, make: VF.MODELS[t.model].oem, model: t.model } : null; }
    const g = C().grants.find((x) => x.appId === a.id && x.vid === vid);
    if (!g) return null;
    const v = VF.vehicle(g.vehicleId);
    return { grant: g, v, make: VF.model(v).oem, model: v.model };
  }
  const err = (status, type, code, description) => ({ status, body: { type, code, description, docURL: `https://docs.voltfleetos.com/errors/${type.toLowerCase()}#${code.toLowerCase()}` } });
  function vehicleState(x) {
    if (x.test) { const t = x.test; const m = VF.MODELS[t.model]; const p = VF.PLACES[t.node]; return { soc: t.soc, kwh: m.kwh, range: t.soc / 100 * m.kwh / (m.eff * 1.05), odo: t.odo, plugged: t.plugged, charging: t.charging, kw: t.charging ? Math.min(11, m.ac) : 0, lat: p.lat, lon: p.lon, tyres: t.tyres, locked: t.locked }; }
    const v = x.v; const m = VF.model(v);
    const pos = v.trip && !v.trip.done ? VF.posAt(v.trip, v.trip.doneKm) : VF.PLACES[v.node];
    let charging = v.status === 'charging', kw = 0, plugged = charging || v.status === 'waiting';
    if (!v.sim && v.chargingAt) { const c = VF.connector(v.chargingAt.connectorId); kw = c && c.session ? c.session.kw : 0; }
    if (v.sim) for (const st of VF.state.stations) for (const c of st.connectors) if (c.session && c.session.driverId === v.driverId) { charging = true; plugged = true; kw = c.session.kw; }
    return { soc: v.soc, kwh: m.kwh, range: VF.rangeKm(v), odo: v.odo, plugged, charging, kw, lat: pos.lat, lon: pos.lon, tyres: v.tyres, locked: v.locked !== false };
  }
  function callApi(appId, epId, vid, action, origin) {
    const a = app(appId); const ep = ENDPOINTS.find((e) => e.id === epId);
    const t0 = VF.now(); const ms = Math.round(140 + Math.random() * 420);
    let res;
    const path = ep.path.replace('{id}', vid || '{id}');
    if (a.status !== 'active') res = err(403, 'PERMISSION', 'APP_SUSPENDED', 'This application is suspended. Contact VoltFleet support.');
    else if (ep.id === 'vehicles') {
      const ids = a.mode === 'test' ? C().testVehicles.filter((t) => t.appId === a.id).map((t) => t.vid) : liveGrants(a.id).map((g) => g.vid);
      res = { status: 200, body: { vehicles: ids, paging: { count: ids.length, offset: 0 } } };
    } else {
      const x = resolve(a, vid);
      if (!x) res = err(404, 'RESOURCE_NOT_FOUND', 'VEHICLE', 'No vehicle with this ID is connected to your application.');
      else if (x.grant && x.grant.revoked) res = err(401, 'AUTHENTICATION', 'ACCESS_REVOKED', 'The vehicle owner revoked access. Ask them to reconnect through VoltFleet Connect.');
      else if (x.grant && !x.grant.scopes.includes(ep.scope)) res = err(403, 'PERMISSION', 'SCOPE_NOT_GRANTED', `The owner did not grant ${ep.scope}.`);
      else if (!capable(x.make, ep.field)) res = err(501, 'COMPATIBILITY', 'VEHICLE_NOT_CAPABLE', `${x.make} vehicles connected through ${SOURCE_PHRASE[x.test ? sourceOf(x.make) : x.grant.source]} do not support this endpoint.`);
      else res = respond(ep, x, action);
    }
    const meta = { 'VF-Request-Id': 'req_' + hash(String(t0) + Math.random()).toLowerCase(), 'VF-Data-Age': res.status === 200 && ep.method === 'GET' ? new Date(t0 - Math.round(Math.random() * 30e3)).toISOString() : undefined };
    const entry = { t: t0, appId, method: ep.method, path, status: res.status, ms, origin: origin || 'server' };
    C().requests.unshift(entry); if (C().requests.length > 300) C().requests.length = 300;
    C().usage[appId][29]++;
    return Object.assign({ ms, meta, method: ep.method, path, body: res.body, status: res.status }, ep.body ? { reqBody: { action } } : {});
  }
  function respond(ep, x, action) {
    const st = vehicleState(x); const unit = { 'VF-Unit-System': 'metric' };
    switch (ep.id) {
      case 'info': return { status: 200, body: { id: x.test ? x.test.vid : x.grant.vid, make: x.make.toUpperCase(), model: x.model.replace(/^\S+\s/, ''), year: 2023, ports: VF.MODELS[x.model].ports, source: x.test ? 'simulated' : x.grant.source } };
      case 'battery': return { status: 200, body: { percentRemaining: +(st.soc / 100).toFixed(3), range: Math.round(st.range), capacity_kwh: st.kwh }, unit };
      case 'charge': return { status: 200, body: { isPluggedIn: st.plugged, state: st.charging ? (st.soc >= 99 ? 'FULLY_CHARGED' : 'CHARGING') : 'NOT_CHARGING', power_kw: +st.kw.toFixed(1) } };
      case 'odometer': return { status: 200, body: { distance: Math.round(st.odo) } };
      case 'tires': return { status: 200, body: { frontLeft: Math.round(st.tyres[0] * 6.895), frontRight: Math.round(st.tyres[1] * 6.895), backLeft: Math.round(st.tyres[2] * 6.895), backRight: Math.round(st.tyres[3] * 6.895), unit: 'kPa' } };
      case 'location': return { status: 200, body: { latitude: +st.lat.toFixed(5), longitude: +st.lon.toFixed(5) } };
      case 'charge-cmd': {
        if (!st.plugged) return err(409, 'VEHICLE_STATE', 'CHARGE_UNPLUGGED', 'The vehicle is not plugged in.');
        if (x.test) { x.test.charging = action === 'START'; return { status: 200, body: { status: 'success', message: `Charging ${action === 'START' ? 'started' : 'stopped'}` } }; }
        if (action === 'STOP' && st.charging) {
          for (const s2 of VF.state.stations) for (const c of s2.connectors) if (c.session && c.session.driverId === x.v.driverId) { VF.ocpp(s2.id, c.id, '←', 'StopTransaction', 'requested via VoltFleet Connect API'); VF.endSession(s2, c); c.status = 'Finishing'; c.until = VF.now() + 3 * MIN; }
          return { status: 200, body: { status: 'success', message: 'Charging stopped' } };
        }
        return { status: 200, body: { status: 'success', message: action === 'START' ? 'Charging is already in progress' : 'Vehicle was not charging' } };
      }
      case 'security': {
        if (x.test) x.test.locked = action === 'LOCK'; else x.v.locked = action === 'LOCK';
        return { status: 200, body: { status: 'success', message: `Vehicle ${action === 'LOCK' ? 'locked' : 'unlocked'}` } };
      }
    }
    return err(400, 'VALIDATION', 'UNKNOWN_ENDPOINT', 'Unknown endpoint.');
  }
  // Partner servers polling in the background, so usage and logs move like a real platform
  function backgroundCall(t) {
    const g = VF.pick(C().grants.filter((x) => !x.revoked && app(x.appId).mode === 'live')); if (!g) return;
    const a = app(g.appId);
    const eps = ENDPOINTS.filter((e) => e.method === 'GET' && e.id !== 'vehicles' && a.scopes.some((x) => x.scope === e.scope));
    const ep = Math.random() < 0.04 ? ENDPOINTS.find((e) => e.id === 'location') : VF.pick(eps);
    const out = callApi(a.id, ep.id, g.vid, null, 'server');
    if (t) C().requests[0].t = t;
    return out;
  }

  // ---------------------------------------------------------------- webhooks
  function deliver(appId, event, vid, data) {
    for (const w of C().webhooks.filter((x) => x.appId === appId && x.active && x.events.includes(event))) {
      const ok = Math.random() > 0.04;
      C().deliveries.unshift({ id: 'dl' + (++VF.state.seq), t: VF.now(), webhookId: w.id, appId, event, status: ok ? 200 : 503, attempts: ok ? 1 : 2, payload: { id: 'evt_' + hash(String(Math.random())).toLowerCase(), type: event, created_at: new Date(VF.now()).toISOString(), vehicle_id: vid, data } });
    }
    if (C().deliveries.length > 150) C().deliveries.length = 150;
  }
  function emitForDriver(driverId, event, dataFn) {
    for (const g of C().grants) if (g.driverId === driverId && !g.revoked) deliver(g.appId, event, g.vid, dataFn(g));
  }
  function syncTrack() {
    const live = {};
    for (const st of VF.state.stations) for (const c of st.connectors) if (c.session && c.session.driverId) live[c.session.driverId] = { id: c.session.id, st: st.id, kw: c.session.kw, soc: c.session.soc };
    C().track.live = live;
  }
  // Location data (the station) is only included when the app was granted read_location.
  const where = (g, stationId) => (g.scopes.includes('read_location') ? { station: VF.station(stationId).name } : {});
  function connectTick() {
    const c = C(); if (!c) return;
    const prev = c.track.live || {};
    syncTrack();
    const live = c.track.live;
    for (const d in live) if (!prev[d] || prev[d].id !== live[d].id) emitForDriver(d, 'charge.started', (g) => Object.assign({ state: 'CHARGING', percentRemaining: +(live[d].soc / 100).toFixed(2) }, where(g, live[d].st)));
    for (const d in prev) if (!live[d] || live[d].id !== prev[d].id) {
      const s = VF.state.sessions.find((x) => x.id === prev[d].id);
      if (s) emitForDriver(d, 'charge.completed', (g) => Object.assign({ state: 'NOT_CHARGING', energy_kwh: +s.kwh.toFixed(2), percentRemaining: +((s.socEnd || 80) / 100).toFixed(2) }, where(g, s.stationId)));
    }
    for (const v of VF.state.vehicles) if (!v.sim) {
      const k = 'low' + v.id;
      if (v.soc < 20 && !c.track[k]) { c.track[k] = true; emitForDriver(v.driverId, 'battery.low', () => ({ percentRemaining: +(v.soc / 100).toFixed(2) })); }
      if (v.soc > 25) c.track[k] = false;
    }
    if (Math.random() < 0.45) backgroundCall();
    for (const a of c.apps) if (a.mode === 'live' && a.status === 'active') c.usage[a.id][29] += Math.floor(Math.random() * 3);
  }
  VF.tickHooks = (VF.tickHooks || []).concat(connectTick);

  // ---------------------------------------------------------------- Connect consent flow (modal)
  const BRANDS = VF.OEMS.filter((o) => o.id !== 'Any other EV').map((o) => o.id);
  VF.openConnect = (appId, mode, driverId) => { ui.flow = { appId, mode, driverId, step: 'intro', brand: null, optional: {}, error: null }; VF.renderConnect(); };
  VF.renderConnect = () => {
    const el = document.getElementById('modal'); if (!el) return;
    const html = ui.flow ? flowHTML() : '';
    el.hidden = !html; VF.setHTML(el, html);
  };
  function flowHTML() {
    const f = ui.flow; const a = app(f.appId); const o = org(a.orgId);
    const appMark = `<span class="app-mark">${esc(o.name.split(' ').map((p) => p[0]).join('').slice(0, 2))}</span>`;
    const head = `<div class="cx-head"><span class="cx-logos">${appMark}<span class="cx-dots">···</span><span class="app-mark vf">${icon('bolt')}</span></span><button class="icon-btn" data-act="cx-close" aria-label="Close">${icon('close')}</button></div>`;
    const drv = f.mode === 'driver' ? VF.driver(f.driverId) : null;
    const dv = drv ? VF.driverVehicle(drv.id) : null;
    let body = '';
    if (f.step === 'intro') {
      body = `<h2>${esc(a.name)} uses VoltFleet Connect to link to your vehicle</h2>
        <ul class="check-list"><li>${icon('lock')}<span><strong>Secure.</strong> You sign in with your carmaker or pair a VoltFleet device. ${esc(o.name)} never sees your password.</span></li>
        <li>${icon('eye')}<span><strong>You choose.</strong> You approve each permission. Location is always optional.</span></li>
        <li>${icon('shield')}<span><strong>Private.</strong> ${esc(o.name)} gets a vehicle ID, not your name, phone, plate or VIN. Revoke access any time in the VoltFleet app.</span></li></ul>
        <button class="btn primary big" data-act="cx-step" data-step="brand">Continue</button>
        <p class="faint small center">By continuing you agree to the VoltFleet Connect privacy notice.${f.mode === 'test' ? ' Test mode: no real vehicle is connected.' : ''}</p>`;
    } else if (f.step === 'brand') {
      body = `<h2>Select your vehicle's brand</h2><div class="brand-grid">${BRANDS.map((b) => `<button type="button" class="brand-tile${dv && VF.model(dv).oem === b ? ' mine' : ''}" data-act="cx-brand" data-b="${b}"><strong>${esc(b)}</strong><span class="faint small">${SOURCE_LABEL[sourceOf(b)]}</span></button>`).join('')}
        <button type="button" class="brand-tile wide" data-act="cx-brand" data-b="OBD"><strong>Another EV</strong><span class="faint small">Pair a VoltFleet plug-in device</span></button></div>`;
    } else if (f.step === 'login') {
      const dongle = f.brand === 'OBD' || sourceOf(f.brand) === 'obd_dongle';
      body = dongle
        ? `<h2>Pair your VoltFleet device</h2><p class="muted small">Plug the device into the car's OBD-II port (under the steering wheel), then enter the code printed on it.</p>
           <label class="field"><span>Pairing code</span><input class="input" id="cx-code" value="VF-48213" autocomplete="off"></label>
           <button class="btn primary big" data-act="cx-login">Pair device</button>`
        : `<h2>Sign in to ${esc(f.brand)}</h2><p class="muted small">Use the account from your ${esc(f.brand)} app. Your password goes to ${esc(f.brand)} only${sourceOf(f.brand) === 'aggregator' ? ', through our certified data partner' : ''}.</p>
           <label class="field"><span>Email</span><input class="input" id="cx-email" value="${f.mode === 'driver' ? esc(VF.user(drv.userId).email || '') : 'test@example.com'}" autocomplete="off"></label>
           <label class="field"><span>Password</span><input class="input" id="cx-pass" type="password" value="demo-password" autocomplete="off"></label>
           <button class="btn primary big" data-act="cx-login">Sign in</button>`;
      if (f.error) body += `<div class="note warn">${icon('warn')}<span>${esc(f.error)}</span></div>`;
      body += '<p class="faint small center">Demo: no credentials are sent anywhere.</p>';
    } else if (f.step === 'consent') {
      const veh = f.mode === 'driver' ? dv.model : testModelFor(f.brand);
      body = `<h2>Allow ${esc(a.name)} to:</h2>
        <div class="veh-pick">${icon('car')}<div><strong>${esc(veh)}</strong><div class="faint small">${f.mode === 'driver' ? esc(dv.plate || '') : 'Simulated test vehicle'}</div></div>${icon('check')}</div>
        <div class="toggles">${a.scopes.map((x) => `<label class="toggle"><span><strong>${esc(SCOPES[x.scope])}</strong><span class="muted small">${x.required ? 'Required by this app' : 'Optional'}${x.scope === 'read_location' ? ' · shared only while the app needs it' : ''}</span></span><input type="checkbox" role="switch" id="cx-${x.scope}" data-chg="cx-opt" data-s="${x.scope}" ${x.required ? 'checked disabled' : f.optional[x.scope] ? 'checked' : ''}></label>`).join('')}</div>
        <button class="btn primary big" data-act="cx-allow">Allow</button><button class="btn ghost" data-act="cx-close">Deny</button>`;
    } else if (f.step === 'done') {
      body = `<div class="empty-state">${icon('check')}<h2>Connected</h2><p class="muted">${f.mode === 'driver' ? `${esc(a.name)} can now use the permissions you approved. Manage or revoke this in Vehicle → Connected apps.` : 'A test vehicle was added to this app. Call it from the API explorer.'}</p></div>
        <button class="btn primary big" data-act="cx-close">Return to ${esc(f.mode === 'driver' ? 'VoltFleet' : a.name)}</button>`;
    }
    const steps = ['intro', 'brand', 'login', 'consent', 'done'];
    return `<div class="modal-backdrop" data-act="cx-close"></div><div class="connect-card" role="dialog" aria-modal="true" aria-label="VoltFleet Connect">${head}<div class="cx-body">${body}</div><div class="cx-progress">${steps.map((s) => `<i class="${steps.indexOf(s) <= steps.indexOf(f.step) ? 'on' : ''}"></i>`).join('')}</div><div class="cx-foot faint small">${icon('bolt')}Secured by VoltFleet Connect</div></div>`;
  }
  const testModelFor = (brand) => (brand === 'OBD' ? 'Nissan Leaf' : Object.keys(VF.MODELS).find((n) => VF.MODELS[n].oem === brand) || 'BYD Atto 3');

  // ---------------------------------------------------------------- driver: connected apps
  VF.connectedAppsHTML = (driverId) => {
    if (!VF.state.connect) return '';
    const gs = C().grants.filter((g) => g.driverId === driverId && !g.revoked);
    const available = C().apps.filter((a) => a.mode === 'live' && a.status === 'active' && !gs.some((g) => g.appId === a.id));
    return `<section class="card span-12"><div class="card-head"><h3>Connected apps</h3><span class="faint small">via VoltFleet Connect</span></div>
      <p class="muted small">Apps you allowed to use your vehicle data. They see a vehicle ID, never your name, phone or plate.</p>
      ${gs.length ? `<ul class="plain-list">${gs.map((g) => { const a = app(g.appId); return `<li><div><strong>${esc(a.name)}</strong><div class="faint small">${esc(org(a.orgId).name)} · since ${VF.fmtDate(g.at)}</div><div class="chips" style="margin-top:6px">${g.scopes.map((x) => `<span class="chip yes">${esc(SCOPES[x])}</span>`).join('')}</div></div><button class="btn small ghost danger" data-act="cx-revoke" data-id="${g.id}">Revoke</button></li>`; }).join('')}</ul>` : '<p class="small faint">No apps connected.</p>'}
      ${available.length ? `<button class="btn" data-act="cx-open-driver" data-app="${available[0].id}">${icon('plus') || ''}Connect ${esc(available[0].name)} (demo)</button>` : ''}</section>`;
  };

  // ---------------------------------------------------------------- developer pages
  function selApp() {
    const list = myApps();
    if (!ui.app || !list.some((a) => a.id === ui.app)) ui.app = (list.find((a) => a.mode === 'live') || list[0]).id;
    return app(ui.app);
  }
  const appSeg = (act) => `<div class="seg" role="group" aria-label="Application">${myApps().map((a) => `<button type="button" data-act="${act || 'dev-app'}" data-id="${a.id}" aria-pressed="${ui.app === a.id}">${esc(a.name)} <span class="n">${a.mode === 'test' ? 'test' : 'live'}</span></button>`).join('')}</div>`;
  const modePill = (a) => (a.mode === 'live' ? pill('ok', 'Live') : pill('warn', 'Test'));
  const statusCls = (s) => (s < 300 ? 'ok' : s < 500 ? 'warn' : 'bad');
  function vehicleCount(a) { return a.mode === 'test' ? C().testVehicles.filter((t) => t.appId === a.id).length : liveGrants(a.id).length; }
  function monthlyBill(a) { return a.plan === 'free' ? 0 : liveGrants(a.id).length * C().pricing[a.plan]; }
  function requestRows(list) {
    if (!list.length) return '<tr><td colspan="5" class="empty">No requests yet.</td></tr>';
    return list.map((r) => `<tr><td class="num small">${VF.fmtTime(r.t)}</td><td class="small">${esc(app(r.appId).name)}</td><td class="mono small"><strong>${r.method}</strong> ${esc(r.path)}</td><td>${pill(statusCls(r.status) + ' plain', String(r.status))}</td><td class="r num small">${r.ms} ms</td></tr>`).join('');
  }
  function pageOverview() {
    const apps = myApps(); const ids = apps.map((a) => a.id);
    const today = sum(apps, (a) => C().usage[a.id][29]);
    const reqs = C().requests.filter((r) => ids.includes(r.appId));
    const errs = reqs.filter((r) => r.status >= 400).length;
    const deliv = C().deliveries.filter((d) => ids.includes(d.appId));
    const live = sum(apps.filter((a) => a.mode === 'live'), (a) => liveGrants(a.id).length);
    return `<section class="kpis" data-live="dv-kpis">${devKpis(apps, today, reqs, errs, deliv, live)}</section>
      <div class="grid g-main">
        <section class="panel"><div class="panel-head"><div><h2>API calls</h2><div class="sub">Per day, last 30 days</div></div><div class="legend">${apps.map((a, i) => `<span><i class="s${i}"></i>${esc(a.name)}</span>`).join('')}</div></div><div class="panel-body"><div class="chart-slot" data-chart="dev-usage"></div></div></section>
        <section class="panel"><div class="panel-head"><h2>Get started</h2></div><div class="panel-body"><ol class="steps">
          <li><strong>Create an app</strong><span class="muted small">Done: ${apps.length} apps with client ID and secret.</span></li>
          <li><strong>Add VoltFleet Connect to your product</strong><span class="muted small">Drivers pick their brand, sign in and approve permissions. <button class="link-btn accent" data-act="dev-preview" data-id="${apps.find((a) => a.mode === 'test').id}">Try it in test mode</button></span></li>
          <li><strong>Call the API</strong><span class="muted small">One set of endpoints for every make. <a href="#dev-explorer">Open the explorer</a></span></li>
          <li><strong>Subscribe to webhooks</strong><span class="muted small">Get charge and battery events instead of polling. <a href="#dev-webhooks">Set up webhooks</a></span></li>
        </ol></div></section>
      </div>
      <section class="panel"><div class="panel-head"><div><h2>Recent requests</h2><div class="sub">Live log from your servers and the explorer</div></div></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Time</th><th>App</th><th>Request</th><th>Status</th><th class="r">Latency</th></tr></thead><tbody data-live="dv-reqs">${requestRows(reqs.slice(0, 12))}</tbody></table></div></section>`;
  }
  function devKpis(apps, today, reqs, errs, deliv, live) {
    return [
      VF.kpi('Live vehicles', live, '', `${apps.length} apps`),
      VF.kpi('API calls today', fmt.n(today), '', 'all apps'),
      VF.kpi('Error rate', reqs.length ? (errs / reqs.length * 100).toFixed(1) : '0.0', '%', 'last 300 requests', errs / Math.max(1, reqs.length) > 0.1 ? 'bad' : ''),
      VF.kpi('Webhooks delivered', deliv.filter((d) => d.status === 200).length, '', `${deliv.filter((d) => d.status !== 200).length} retried`),
      VF.kpi('This month', '$' + fmt.n(sum(apps, monthlyBill), 2), '', 'estimated bill'),
    ].join('');
  }
  function drawUsage(slot) {
    const apps = myApps(); const data = [];
    for (let i = 0; i < 30; i++) { const v = {}; apps.forEach((a, k) => { v['s' + k] = C().usage[a.id][i]; }); data.push({ label: VF.fmtDate(VF.now() - (29 - i) * DAY), values: v }); }
    slot.innerHTML = VF.barChart(data, apps.map((a, k) => ({ key: 's' + k, label: a.name, cls: 'bar s' + k })), Math.max(300, slot.clientWidth || 600), { label: 'API calls per day' });
  }

  function pageApps() {
    return myApps().map((a) => {
      const shown = ui.reveal[a.id];
      return `<section class="panel"><div class="panel-head"><div><h2>${esc(a.name)}</h2><div class="sub">${esc(org(a.orgId).name)} · created ${VF.fmtDate(a.createdAt)} · ${vehicleCount(a)} ${a.mode === 'test' ? 'test' : 'connected'} vehicles</div></div><div class="row">${modePill(a)}${pill('accent plain', PLANS[a.plan].name + ' plan')}<button class="btn small primary" data-act="dev-preview" data-id="${a.id}">${icon('car')}Preview Connect</button></div></div>
        <div class="panel-body grid g-2">
          <div class="stack">
            <div class="cred"><span class="faint small">Client ID</span><code>${esc(a.clientId)}</code><button class="icon-btn" data-act="dev-copy" data-v="${esc(a.clientId)}" aria-label="Copy client ID">${icon('copy')}</button></div>
            <div class="cred"><span class="faint small">Client secret</span><code>${shown ? esc(a.secret) : 'vfs_' + '•'.repeat(24) + a.secret.slice(-4)}</code><button class="btn small ghost" data-act="dev-secret" data-id="${a.id}">${shown ? 'Hide' : 'Reveal'}</button><button class="btn small ghost danger" data-act="dev-rotate" data-id="${a.id}">Rotate</button></div>
            <label class="field"><span>Redirect URI</span><input class="input" id="ru-${a.id}" value="${esc(a.redirect)}" data-chg="dev-redirect" data-id="${a.id}"></label>
            <div class="row"><span class="faint small">Mode</span><div class="seg" role="group">${['test', 'live'].map((m) => `<button type="button" data-act="dev-mode" data-id="${a.id}" data-m="${m}" aria-pressed="${a.mode === m}">${m === 'test' ? 'Test' : 'Live'}</button>`).join('')}</div></div>
          </div>
          <div style="min-width:0"><div class="faint small" style="margin-bottom:6px">Permissions this app asks drivers for</div><div class="table-wrap"><table class="t"><thead><tr><th>Permission</th><th>Scope</th><th>Ask as</th></tr></thead><tbody>
            ${Object.entries(SCOPES).map(([k, l]) => { const x = a.scopes.find((y) => y.scope === k); return `<tr><td>${esc(l)}</td><td class="mono small">${k}</td><td><select class="select" id="sc-${a.id}-${k}" data-chg="dev-scope" data-id="${a.id}" data-s="${k}"><option value="off" ${!x ? 'selected' : ''}>Not requested</option><option value="req" ${x && x.required ? 'selected' : ''}>Required</option><option value="opt" ${x && !x.required ? 'selected' : ''}>Optional</option></select></td></tr>`; }).join('')}
          </tbody></table></div><p class="faint small" style="margin-top:6px">Ask only for what your product needs. Location can't be made required.</p></div>
        </div></section>`;
    }).join('');
  }

  function pageVehicles() {
    const a = selApp();
    let rows;
    if (a.mode === 'test') rows = C().testVehicles.filter((t) => t.appId === a.id).map((t) => `<tr><td class="mono small">${t.vid}</td><td>${esc(t.model)}</td><td>${pill('warn plain', 'Simulated')}</td><td class="small">All</td><td class="num small">${VF.fmtDate(t.createdAt)}</td><td>${pill('ok', 'Active')}</td><td><button class="btn small ghost" data-act="dev-tv-del" data-id="${t.id}">Remove</button></td></tr>`);
    else rows = C().grants.filter((g) => g.appId === a.id).map((g) => { const v = VF.vehicle(g.vehicleId); return `<tr><td class="mono small">${g.vid}</td><td>${esc(v.model)}</td><td>${pill(g.source === 'oem_api' ? 'accent plain' : g.source === 'aggregator' ? 'charge plain' : 'plain', SOURCE_LABEL[g.source])}</td><td class="small">${g.scopes.map((x) => esc(shortScope(x))).join(', ')}</td><td class="num small">${VF.fmtDate(g.at)}</td><td>${g.revoked ? pill('bad', 'Revoked') : pill('ok', 'Active')}</td><td></td></tr>`; });
    return `<div class="row between">${appSeg()}${a.mode === 'test' ? `<div class="row"><select class="select" id="tv-model" data-chg="dev-tv-model">${Object.keys(VF.MODELS).map((n) => `<option ${ui.addTest === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select><button class="btn primary" data-act="dev-tv-add">${icon('car')}Add test vehicle</button></div>` : ''}</div>
      <section class="panel"><div class="panel-head"><div><h2>${a.mode === 'test' ? 'Test vehicles' : 'Connected vehicles'}</h2><div class="sub">${a.mode === 'test' ? 'Simulated cars that behave like real ones; free and unlimited calls' : 'Each vehicle appears under an ID unique to this app. You never receive the owner\'s name, phone, plate or VIN.'}</div></div></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Vehicle ID</th><th>Model</th><th>Connected through</th><th>Granted</th><th>Since</th><th>Status</th><th></th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="7" class="empty">No vehicles yet. Share your Connect link with drivers.</td></tr>'}</tbody></table></div></section>`;
  }

  function pageExplorer() {
    const a = selApp();
    const vids = a.mode === 'test' ? C().testVehicles.filter((t) => t.appId === a.id).map((t) => [t.vid, t.model]) : C().grants.filter((g) => g.appId === a.id).map((g) => [g.vid, VF.vehicle(g.vehicleId).model + (g.revoked ? ' (revoked)' : '')]);
    if (!vids.some(([v]) => v === ui.ex.vid)) ui.ex.vid = vids.length ? vids[0][0] : '';
    const ep = ENDPOINTS.find((e) => e.id === ui.ex.ep);
    const path = ep.path.replace('{id}', ui.ex.vid || '{id}');
    const curl = `curl -X ${ep.method} "https://api.voltfleetos.com${path}" \\\n  -H "Authorization: Bearer $ACCESS_TOKEN" \\\n  -H "VF-Unit-System: metric"${ep.body ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '{"action": "${ui.ex.action}"}'` : ''}`;
    const r = ui.last;
    return `<div class="row between">${appSeg()}</div>
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><h2>Request</h2>${modePill(a)}</div><div class="panel-body stack">
          <label class="field"><span>Endpoint</span><select class="select" id="ex-ep" data-chg="dev-ex" data-k="ep">${ENDPOINTS.map((e) => `<option value="${e.id}" ${e.id === ep.id ? 'selected' : ''}>${e.method} ${e.path.replace('/v1/vehicles', '…')} · ${esc(e.label)}</option>`).join('')}</select></label>
          ${ep.id !== 'vehicles' ? `<label class="field"><span>Vehicle</span><select class="select" id="ex-vid" data-chg="dev-ex" data-k="vid">${vids.map(([v, l]) => `<option value="${v}" ${v === ui.ex.vid ? 'selected' : ''}>${v} · ${esc(l)}</option>`).join('')}</select></label>` : ''}
          ${ep.body ? `<label class="field"><span>Action</span><select class="select" id="ex-act" data-chg="dev-ex" data-k="action">${ep.body.map((b) => `<option ${b === ui.ex.action ? 'selected' : ''}>${b}</option>`).join('')}</select></label>` : ''}
          ${ep.scope ? `<div class="faint small">Needs scope <code>${ep.scope}</code></div>` : ''}
          <pre class="code">${esc(curl)}</pre>
          <div class="row"><button class="btn primary" data-act="dev-send">${icon('play')}Send request</button><button class="btn ghost" data-act="dev-copy" data-v="${esc(curl)}">${icon('copy')}Copy cURL</button></div>
        </div></section>
        <section class="panel"><div class="panel-head"><h2>Response</h2>${r ? `<span class="row" style="gap:8px">${pill(statusCls(r.status), String(r.status))}<span class="num small faint">${r.ms} ms</span></span>` : ''}</div><div class="panel-body">
          ${r ? `<div class="faint small mono" style="margin-bottom:6px">${r.method} ${esc(r.path)} · ${esc(r.meta['VF-Request-Id'])}${r.meta['VF-Data-Age'] ? ' · data age ' + esc(r.meta['VF-Data-Age']) : ''}</div><pre class="code">${esc(JSON.stringify(r.body, null, 2))}</pre>` : '<div class="empty">Send a request to see the response.</div>'}
          <p class="faint small" style="margin-top:8px">Errors you may see: <code>403 SCOPE_NOT_GRANTED</code> when the driver didn't allow a permission, <code>501 VEHICLE_NOT_CAPABLE</code> when a make can't support an endpoint, <code>401 ACCESS_REVOKED</code> after the driver revokes access.</p>
        </div></section>
      </div>`;
  }

  function decodeVin(vin) {
    vin = (vin || '').trim().toUpperCase();
    if (vin.length !== 17) return { error: 'A VIN has 17 characters.' };
    if (/[IOQ]/.test(vin)) return { error: 'VINs never contain the letters I, O or Q.' };
    const make = WMI[vin.slice(0, 3)];
    return { vin, make: make || null };
  }
  function pageCompat() {
    const c = ui.compat;
    let result = '';
    if (c && c.error) result = `<div class="note warn">${icon('warn')}<span>${esc(c.error)}</span></div>`;
    else if (c) {
      const make = c.make || 'Any other EV'; const src = c.make ? sourceOf(c.make) : 'obd_dongle';
      const models = Object.entries(VF.MODELS).filter(([, m]) => m.oem === c.make);
      result = `<div class="stack"><div class="row between"><div><div class="eyebrow">${esc(c.vin)}</div><h3>${c.make ? esc(c.make) : 'Make not recognised'}</h3><div class="muted small">${c.make ? 'Compatible' : 'Supported with a VoltFleet plug-in device'} · connects through ${SOURCE_LABEL[src].toLowerCase()}</div></div>${pill(c.make ? 'ok' : 'warn', c.make ? 'Compatible' : 'Device needed')}</div>
        <table class="t"><thead><tr><th>Endpoint</th><th>Scope</th><th>Available</th></tr></thead><tbody>${ENDPOINTS.filter((e) => e.scope).map((e) => { const ok = capable(make, e.field) && !(src === 'obd_dongle' && e.field === 'remote'); return `<tr><td>${esc(e.label)}</td><td class="mono small">${e.scope}</td><td>${ok ? pill('ok plain', 'Yes') : pill('plain', 'No')}</td></tr>`; }).join('')}</tbody></table>
        ${models.length ? `<p class="small muted">Models in the catalog: ${models.map(([n, m]) => `${esc(n)} (${esc(m.ports.join(', '))})`).join('; ')}</p>` : ''}</div>`;
    }
    return `<div class="grid g-main">
      <section class="panel"><div class="panel-head"><div><h2>Check a vehicle</h2><div class="sub">Before you onboard a car, check what VoltFleet can read and control. Same as <code>GET /v1/compatibility?vin=…</code></div></div></div>
        <div class="panel-body stack"><div class="row" style="flex-wrap:nowrap"><input class="input grow mono" id="vin" maxlength="17" placeholder="17-character VIN" value="${esc(ui.vin)}" data-inp="dev-vin"><button class="btn primary" data-act="dev-vin">Check</button></div>
          <div class="row small"><span class="faint">Try:</span>${VIN_EXAMPLES.map(([v, m]) => `<button class="btn small ghost" data-act="dev-vin-ex" data-v="${v}">${m}</button>`).join('')}</div>${result}</div></section>
      <section class="panel"><div class="panel-head"><div><h2>Coverage by make</h2><div class="sub">How each brand connects</div></div></div><div class="panel-body"><ul class="plain-list">${BRANDS.map((b) => `<li><span><strong>${esc(b)}</strong></span>${pill(sourceOf(b) === 'oem_api' ? 'accent plain' : sourceOf(b) === 'aggregator' ? 'charge plain' : 'plain', SOURCE_LABEL[sourceOf(b)])}</li>`).join('')}<li><span><strong>Any other EV</strong></span>${pill('plain', 'Plug-in device')}</li></ul></div></section>
    </div>`;
  }

  function pageWebhooks() {
    const a = selApp();
    const hooks = C().webhooks.filter((w) => w.appId === a.id);
    const dl = C().deliveries.filter((d) => d.appId === a.id).slice(0, 25);
    const sel = ui.delivery && C().deliveries.find((d) => d.id === ui.delivery);
    return `<div class="row between">${appSeg()}<button class="btn primary" data-act="dev-wh-new">${icon('plus') || ''}Add endpoint</button></div>
      ${ui.whOpen ? `<section class="panel"><div class="panel-head"><h2>New webhook endpoint</h2></div><div class="panel-body stack"><label class="field"><span>URL (HTTPS)</span><input class="input" id="wh-url" placeholder="https://your-app.example/webhooks/voltfleet"></label>
        <div class="row">${Object.entries(EVENTS).map(([k, l]) => `<label class="check"><input type="checkbox" id="wh-ev-${k.replace('.', '-')}" data-ev="${k}" checked>${esc(k)}</label>`).join('')}</div>
        <div class="row"><button class="btn primary" data-act="dev-wh-save">Save endpoint</button><button class="btn ghost" data-act="dev-wh-cancel">Cancel</button></div></div></section>` : ''}
      ${hooks.map((w) => `<section class="panel"><div class="panel-head"><div><h2 class="mono" style="font-size:14px">${esc(w.url)}</h2><div class="sub">${w.events.map(esc).join(' · ')}</div></div><div class="row">${w.active ? pill('ok', 'Active') : pill('', 'Paused')}<button class="btn small" data-act="dev-wh-test" data-id="${w.id}">Send test event</button><button class="btn small ghost" data-act="dev-wh-toggle" data-id="${w.id}">${w.active ? 'Pause' : 'Resume'}</button></div></div>
        <div class="panel-body"><div class="cred"><span class="faint small">Signing secret</span><code>${esc(w.secret.slice(0, 10))}••••••••••••</code></div><p class="faint small">Every delivery carries a <code>VF-Signature</code> header (HMAC-SHA256 of the body with this secret). Failed deliveries retry with backoff for 24 hours.</p></div></section>`).join('') || `<section class="panel"><div class="empty">No webhook endpoints for ${esc(a.name)} yet.</div></section>`}
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><div><h2>Deliveries</h2><div class="sub">Events sent to your endpoints</div></div></div><div class="table-wrap"><table class="t"><thead><tr><th>Time</th><th>Event</th><th>Vehicle</th><th>Status</th></tr></thead><tbody data-live="dv-dl">${deliveryRows(dl)}</tbody></table></div></section>
        <section class="panel"><div class="panel-head"><h2>Payload</h2></div><div class="panel-body">${sel ? `<pre class="code">${esc(JSON.stringify(sel.payload, null, 2))}</pre><p class="faint small" style="margin-top:6px">Location fields appear only when the driver granted <code>read_location</code>.</p>` : '<div class="empty">Select a delivery to see its payload.</div>'}</div></section>
      </div>`;
  }
  const deliveryRows = (dl) => (dl.length ? dl.map((d) => `<tr class="clickable-row${ui.delivery === d.id ? ' sel' : ''}" data-act="dev-dl" data-id="${d.id}"><td class="num small">${VF.fmtTime(d.t)}</td><td class="mono small">${esc(d.event)}</td><td class="mono small">${esc(d.payload.vehicle_id)}</td><td>${pill(d.status === 200 ? 'ok plain' : 'warn plain', d.status === 200 ? '200' : `${d.status} · retrying`)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No deliveries yet. Events appear as drivers charge.</td></tr>');

  function pageDocs() {
    const p = C().pricing;
    const code1 = `// 1. Send the driver to VoltFleet Connect\nconst url = "https://connect.voltfleetos.com/oauth/authorize"\n  + "?client_id=YOUR_CLIENT_ID"\n  + "&redirect_uri=https://your-app.example/callback"\n  + "&scope=read_vehicle_info read_battery read_charge"\n  + "&mode=test";`;
    const code2 = `// 2. Exchange the code for tokens (server side)\nPOST https://auth.voltfleetos.com/oauth/token\n{ "grant_type": "authorization_code", "code": "...",\n  "client_id": "...", "client_secret": "...",\n  "redirect_uri": "https://your-app.example/callback" }\n// → { "access_token": "...", "refresh_token": "...", "expires_in": 7200 }`;
    const code3 = `// 3. Call the API for any make\nGET https://api.voltfleetos.com/v1/vehicles/{id}/battery\nAuthorization: Bearer ACCESS_TOKEN\n// → { "percentRemaining": 0.41, "range": 152, "capacity_kwh": 60.5 }`;
    return `<div class="grid g-main">
      <div class="stack">
        <section class="panel"><div class="panel-head"><h2>Quick start</h2></div><div class="panel-body stack"><pre class="code">${esc(code1)}</pre><pre class="code">${esc(code2)}</pre><pre class="code">${esc(code3)}</pre></div></section>
        <section class="panel"><div class="panel-head"><h2>Endpoints</h2></div><div class="table-wrap"><table class="t"><thead><tr><th>Method</th><th>Path</th><th>Scope</th><th>What it does</th></tr></thead><tbody>${ENDPOINTS.map((e) => `<tr><td class="mono small strong">${e.method}</td><td class="mono small">${esc(e.path)}</td><td class="mono small">${e.scope || '—'}</td><td class="small">${esc(e.label)}</td></tr>`).join('')}<tr><td class="mono small strong">GET</td><td class="mono small">/v1/compatibility?vin=</td><td class="mono small">—</td><td class="small">What a vehicle supports</td></tr></tbody></table></div></section>
      </div>
      <div class="stack">
        <section class="panel"><div class="panel-head"><h2>Pricing</h2></div><div class="panel-body"><ul class="plain-list">
          <li><div><strong>Sandbox</strong><div class="faint small">${PLANS.free.note}</div></div><strong class="num">Free</strong></li>
          <li><div><strong>Build</strong><div class="faint small">${PLANS.build.note}</div></div><strong class="num">$${p.build.toFixed(2)}</strong></li>
          <li><div><strong>Scale</strong><div class="faint small">${PLANS.scale.note}</div></div><strong class="num">$${p.scale.toFixed(2)}</strong></li>
        </ul><p class="faint small">Billed per live vehicle per month, not per request. Test vehicles are always free.</p></div></section>
        <section class="panel"><div class="panel-head"><h2>Your obligations</h2></div><div class="panel-body"><ul class="check-list small">
          <li>${icon('check')}<span>Use vehicle data only for the purpose you showed the driver.</span></li>
          <li>${icon('check')}<span>Never sell or share it with third parties.</span></li>
          <li>${icon('check')}<span>Delete a vehicle's data within 30 days of receiving <code>vehicle.disconnected</code>.</span></li>
          <li>${icon('check')}<span>Don't try to re-identify drivers from vehicle IDs.</span></li>
          <li>${icon('check')}<span>Keep your client secret on your server, never in an app.</span></li>
        </ul></div></section>
      </div></div>`;
  }

  // ---------------------------------------------------------------- admin page
  function pageAdmin() {
    const c = C();
    const mrr = sum(c.apps, monthlyBill);
    return `<section class="kpis">${[
      VF.kpi('Developer orgs', c.orgs.length, '', `${c.apps.length} apps`),
      VF.kpi('Live connections', c.grants.filter((g) => !g.revoked).length, '', `${c.grants.filter((g) => g.revoked).length} revoked`),
      VF.kpi('API calls today', fmt.n(sum(c.apps, (a) => c.usage[a.id][29])), '', 'all apps'),
      VF.kpi('Platform MRR', '$' + fmt.n(mrr, 2), '', 'per-vehicle billing'),
    ].join('')}</section>
      <section class="panel"><div class="panel-head"><div><h2>Developer apps</h2><div class="sub">Suspending an app blocks its API access immediately</div></div></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>App</th><th>Organisation</th><th>Mode</th><th>Plan</th><th class="r">Vehicles</th><th>Scopes requested</th><th class="r">Calls (30 d)</th><th class="r">Monthly</th><th>Status</th><th></th></tr></thead><tbody>
        ${c.apps.map((a) => `<tr><td class="strong">${esc(a.name)}</td><td>${esc(org(a.orgId).name)} <span class="faint small">${esc(org(a.orgId).kind)}</span></td><td>${modePill(a)}</td><td>${PLANS[a.plan].name}</td><td class="r num">${vehicleCount(a)}</td><td class="small">${a.scopes.map((x) => shortScope(x.scope) + (x.required ? '' : '?')).join(', ')}</td><td class="r num">${fmt.n(sum(c.usage[a.id]))}</td><td class="r num">$${fmt.n(monthlyBill(a), 2)}</td><td>${a.status === 'active' ? pill('ok', 'Active') : pill('bad', 'Suspended')}</td><td><button class="btn small ghost ${a.status === 'active' ? 'danger' : ''}" data-act="ad-app-status" data-id="${a.id}">${a.status === 'active' ? 'Suspend' : 'Reinstate'}</button></td></tr>`).join('')}
        </tbody></table></div></section>
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><div><h2>Pricing</h2><div class="sub">USD per live vehicle per month</div></div></div><div class="panel-body form-grid">
          <label class="field"><span>Build plan</span><input class="input" id="pr-build" type="number" min="0" step="0.05" value="${c.pricing.build}" data-chg="ad-cx-price" data-k="build"></label>
          <label class="field"><span>Scale plan</span><input class="input" id="pr-scale" type="number" min="0" step="0.05" value="${c.pricing.scale}" data-chg="ad-cx-price" data-k="scale"></label></div></section>
        <section class="panel"><div class="panel-head"><div><h2>Connections by source</h2><div class="sub">How connected vehicles reach the platform</div></div></div><div class="panel-body stack">${Object.keys(SOURCE_LABEL).map((k) => { const n = c.grants.filter((g) => !g.revoked && g.source === k).length; const tot = Math.max(1, c.grants.filter((g) => !g.revoked).length); return `<div class="hbar"><span>${SOURCE_LABEL[k]}</span><div class="meter"><i style="width:${n / tot * 100}%"></i></div><span class="num">${n}</span></div>`; }).join('')}</div></section>
      </div>`;
  }

  // ---------------------------------------------------------------- registration
  VF.apps.developer = {
    home: 'dev-overview',
    roleLabel: () => org(me().orgId).name,
    nav: [
      { id: 'dev-overview', label: 'Overview', icon: 'grid', title: 'Developer overview', eyebrow: 'VoltFleet Connect' },
      { id: 'dev-apps', label: 'Apps & keys', icon: 'lock', title: 'Apps & credentials', eyebrow: 'VoltFleet Connect' },
      { id: 'dev-vehicles', label: 'Vehicles', icon: 'car', title: 'Vehicles', eyebrow: 'VoltFleet Connect' },
      { id: 'dev-explorer', label: 'API explorer', icon: 'play', title: 'API explorer', eyebrow: 'VoltFleet Connect' },
      { id: 'dev-compat', label: 'Compatibility', icon: 'check', title: 'Vehicle compatibility', eyebrow: 'VoltFleet Connect' },
      { id: 'dev-webhooks', label: 'Webhooks', icon: 'bell', title: 'Webhooks', eyebrow: 'VoltFleet Connect' },
      { id: 'dev-docs', label: 'Docs & pricing', icon: 'ticket', title: 'Docs & pricing', eyebrow: 'VoltFleet Connect' },
    ],
    pages: { 'dev-overview': pageOverview, 'dev-apps': pageApps, 'dev-vehicles': pageVehicles, 'dev-explorer': pageExplorer, 'dev-compat': pageCompat, 'dev-webhooks': pageWebhooks, 'dev-docs': pageDocs },
    charts: { 'dev-usage': drawUsage },
    structKey: (page) => page + (page === 'dev-vehicles' || page === 'dev-overview' ? C().grants.filter((g) => !g.revoked).length : ''),
    live(page) {
      const ids = myApps().map((a) => a.id);
      if (page === 'dev-overview') {
        const apps = myApps(); const reqs = C().requests.filter((r) => ids.includes(r.appId));
        return { 'dv-reqs': { html: requestRows(reqs.slice(0, 12)) }, 'dv-kpis': { html: devKpis(apps, sum(apps, (a) => C().usage[a.id][29]), reqs, reqs.filter((r) => r.status >= 400).length, C().deliveries.filter((d) => ids.includes(d.appId)), sum(apps.filter((a) => a.mode === 'live'), (a) => liveGrants(a.id).length)) } };
      }
      if (page === 'dev-webhooks') return { 'dv-dl': { html: deliveryRows(C().deliveries.filter((d) => d.appId === ui.app).slice(0, 25)) } };
      return null;
    },
    leave() { ui.reveal = {}; },
  };
  const adm = VF.apps.admin;
  adm.nav.splice(adm.nav.findIndex((n) => n.id === 'ad-vehicles') + 1, 0, { id: 'ad-connect', label: 'Developer platform', icon: 'cpu', title: 'VoltFleet Connect', eyebrow: 'Super admin' });
  adm.pages['ad-connect'] = pageAdmin;

  // ---------------------------------------------------------------- actions
  const devAudit = (action, target) => VF.audit(VF.session.userId, action, target);
  Object.assign(VF.ACT, {
    'dev-app': (el) => { ui.app = el.dataset.id; ui.last = null; ui.delivery = null; VF.rerender(); },
    'dev-copy': (el) => VF.copyText(el.dataset.v, 'Copied text'),
    'dev-secret': (el) => { const id = el.dataset.id; ui.reveal[id] = !ui.reveal[id]; if (ui.reveal[id]) devAudit('reveal-secret', app(id).name); VF.save(); VF.rerender(); },
    'dev-rotate': (el) => { const a = app(el.dataset.id); a.secret = 'vfs_' + hash(String(Math.random())).toLowerCase() + hash(String(Math.random())).toLowerCase() + hash(String(Math.random())).toLowerCase(); ui.reveal[a.id] = true; devAudit('rotate-secret', a.name); VF.save(); VF.rerender(); VF.toast('New secret created. The old one stops working in 24 hours.'); },
    'dev-mode': (el) => { const a = app(el.dataset.id); a.mode = el.dataset.m; if (a.mode === 'live' && a.plan === 'free') a.plan = 'build'; ui.last = null; VF.save(); VF.rerender(); },
    'dev-preview': (el) => VF.openConnect(el.dataset.id, 'test'),
    'dev-send': () => {
      const a = selApp(); const ep = ENDPOINTS.find((e) => e.id === ui.ex.ep);
      ui.last = callApi(a.id, ep.id, ui.ex.vid, ui.ex.action, 'explorer');
      VF.save(); VF.rerender();
    },
    'dev-tv-add': () => {
      const a = selApp(); const id = 'tv' + (++VF.state.seq);
      C().testVehicles.push({ id, appId: a.id, model: ui.addTest, vid: appVid(a.id, id), soc: 30 + Math.round(Math.random() * 60), odo: Math.round(1000 + Math.random() * 40000), node: VF.pick(Object.keys(VF.PLACES)), plugged: false, charging: false, locked: true, tyres: [36, 36, 35, 36], createdAt: VF.now() });
      VF.save(); VF.rerender(); VF.toast(`Test ${ui.addTest} added`);
    },
    'dev-tv-del': (el) => { C().testVehicles = C().testVehicles.filter((t) => t.id !== el.dataset.id); VF.save(); VF.rerender(); },
    'dev-vin': () => { const el = document.getElementById('vin'); ui.vin = el ? el.value : ui.vin; ui.compat = decodeVin(ui.vin); VF.rerender(); },
    'dev-vin-ex': (el) => { ui.vin = el.dataset.v; ui.compat = decodeVin(ui.vin); VF.rerender(); },
    'dev-wh-new': () => { ui.whOpen = true; VF.rerender(); },
    'dev-wh-cancel': () => { ui.whOpen = null; VF.rerender(); },
    'dev-wh-save': () => {
      const url = (document.getElementById('wh-url').value || '').trim();
      if (!/^https:\/\/[^\s]+\.[^\s]+/.test(url)) { VF.toast('Enter an HTTPS URL, for example https://your-app.example/webhooks'); return; }
      const events = Array.from(document.querySelectorAll('[data-ev]')).filter((x) => x.checked).map((x) => x.dataset.ev);
      if (!events.length) { VF.toast('Pick at least one event'); return; }
      C().webhooks.push({ id: 'wh' + (++VF.state.seq), appId: ui.app, url, events, secret: 'whsec_' + hash(url).toLowerCase() + hash(url + 'x').toLowerCase(), active: true });
      ui.whOpen = null; devAudit('webhook-create', url); VF.save(); VF.rerender(); VF.toast('Webhook endpoint added');
    },
    'dev-wh-test': (el) => { const w = C().webhooks.find((x) => x.id === el.dataset.id); deliver(w.appId, w.events[0], 'veh_test0000', { test: true }); VF.save(); VF.rerender(); VF.toast(`Test ${w.events[0]} event sent`); },
    'dev-wh-toggle': (el) => { const w = C().webhooks.find((x) => x.id === el.dataset.id); w.active = !w.active; VF.save(); VF.rerender(); },
    'dev-dl': (el) => { ui.delivery = el.dataset.id; VF.rerender(); },
    // Connect flow
    'cx-close': () => { ui.flow = null; VF.renderConnect(); },
    'cx-step': (el) => { ui.flow.step = el.dataset.step; VF.renderConnect(); },
    'cx-brand': (el) => { ui.flow.brand = el.dataset.b; ui.flow.error = null; ui.flow.step = 'login'; VF.renderConnect(); },
    'cx-login': () => {
      const f = ui.flow;
      if (f.mode === 'driver') {
        const mk = VF.model(VF.driverVehicle(f.driverId)).oem;
        const ok = f.brand === mk || (f.brand === 'OBD' && sourceOf(mk) === 'obd_dongle');
        if (!ok) { f.error = `No vehicles found on this ${f.brand === 'OBD' ? 'device' : f.brand + ' account'}. Your car is a ${mk}.`; VF.renderConnect(); return; }
      }
      f.step = 'consent'; VF.renderConnect();
    },
    'cx-allow': () => {
      const f = ui.flow; const a = app(f.appId);
      const scopes = a.scopes.filter((x) => x.required || f.optional[x.scope]).map((x) => x.scope);
      if (f.mode === 'driver') {
        const d = VF.driver(f.driverId); const v = VF.driverVehicle(d.id);
        const g = { id: 'g' + (++VF.state.seq), appId: a.id, vehicleId: v.id, driverId: d.id, vid: appVid(a.id, v.id), scopes, source: sourceOf(VF.model(v).oem), at: VF.now(), revoked: false };
        C().grants.push(g);
        d.consentLog.push({ t: VF.now(), key: 'all', value: `Connected ${a.name}: ${scopes.join(', ')}` });
        VF.audit(VF.session.userId, 'connect-grant', `${a.name} (${scopes.length} scopes)`);
        deliver(a.id, 'vehicle.connected', g.vid, { scopes });
      } else {
        const id = 'tv' + (++VF.state.seq); const model = testModelFor(f.brand);
        C().testVehicles.push({ id, appId: a.id, model, vid: appVid(a.id, id), soc: 55, odo: 12000, node: 'airport', plugged: false, charging: false, locked: true, tyres: [36, 36, 35, 36], createdAt: VF.now() });
      }
      f.step = 'done'; VF.save(); VF.renderConnect(); VF.rerender();
    },
    'cx-open-driver': (el) => { const u = VF.user(VF.session.userId); VF.openConnect(el.dataset.app, 'driver', u.driverId); },
    'cx-revoke': (el) => {
      const g = C().grants.find((x) => x.id === el.dataset.id); if (!g) return;
      g.revoked = true; g.revokedAt = VF.now();
      const a = app(g.appId); const d = VF.driver(g.driverId);
      d.consentLog.push({ t: VF.now(), key: 'all', value: `Revoked ${a.name}` });
      VF.audit(VF.session.userId, 'connect-revoke', a.name);
      deliver(a.id, 'vehicle.disconnected', g.vid, { reason: 'revoked_by_owner', delete_data_within_days: 30 });
      VF.save(); VF.rerender(); VF.toast(`${a.name} can no longer access your vehicle`);
    },
    'ad-app-status': (el) => { const a = app(el.dataset.id); a.status = a.status === 'active' ? 'suspended' : 'active'; VF.audit(VF.session.userId, 'app-status', `${a.name} → ${a.status}`); VF.save(); VF.rerender(); },
  });
  Object.assign(VF.CHG, {
    'dev-redirect': (el) => { const a = app(el.dataset.id); if (/^https?:\/\//.test(el.value)) { a.redirect = el.value.trim(); VF.save(); VF.toast('Redirect URI saved'); } else VF.toast('Use a full URL starting with https://'); },
    'dev-scope': (el) => {
      const a = app(el.dataset.id); const k = el.dataset.s; let v = el.value;
      if (k === 'read_location' && v === 'req') { VF.toast('Location can only be optional'); v = 'opt'; }
      if (k === 'read_vehicle_info' && v === 'off') { VF.toast('Vehicle info is always required'); v = 'req'; }
      a.scopes = a.scopes.filter((x) => x.scope !== k); if (v !== 'off') a.scopes.push({ scope: k, required: v === 'req' });
      VF.save(); VF.rerender();
    },
    'dev-ex': (el) => { ui.ex[el.dataset.k] = el.value; if (el.dataset.k === 'ep') { const ep = ENDPOINTS.find((e) => e.id === el.value); if (ep.body) ui.ex.action = ep.body[0]; } VF.rerender(); },
    'dev-tv-model': (el) => { ui.addTest = el.value; },
    'cx-opt': (el) => { ui.flow.optional[el.dataset.s] = el.checked; },
    'ad-cx-price': (el) => { const v = Number(el.value); if (v >= 0) { C().pricing[el.dataset.k] = v; VF.audit(VF.session.userId, 'pricing-change', `Connect ${el.dataset.k} = $${v}`); VF.save(); VF.toast('Saved'); } },
  });
  Object.assign(VF.INP, { 'dev-vin': (el) => { ui.vin = el.value; } });
})();
