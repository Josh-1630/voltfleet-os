/* VoltFleet OS — live vehicle telematics through Smartcar (API v3).
   Flow: "Connect a vehicle" asks our Supabase Edge Function (supabase/functions/smartcar) for a one-time state,
   opens Smartcar Connect, and on return links the Smartcar user to an access key held only by this browser.
   Readings are then polled every minute through the function, which holds the Smartcar secret.

   Privacy: connected (real) vehicles live on this device only. They are injected into the fleet for display but
   stripped from every save (VF.stateJSON), so they never reach the shared demo world, other devices or other users. */
'use strict';
(function () {
  const { esc, fmt, icon } = VF;
  const C = VF.c;
  const cloud = window.VOLTFLEET_CLOUD || {};
  const cfg = Object.assign({ clientId: '', mode: 'simulated', functionUrl: '', scope: ['read_vehicle_info', 'read_vin', 'read_battery', 'read_charge', 'read_location', 'read_odometer', 'control_charge'] }, window.VOLTFLEET_SMARTCAR || {});
  const FN = cfg.functionUrl || (cloud.url ? cloud.url.replace(/\/$/, '') + '/functions/v1/smartcar' : '');
  const STORE = 'voltfleet-os:smartcar', STATE = 'voltfleet-os:smartcar-state';
  const POLL_MS = 60_000;

  const R = VF.real = { cfg, fn: FN, key: null, vehicles: [], names: {}, server: null, busy: false, error: '', lastPoll: 0 };
  R.ready = () => !!(FN && cfg.clientId);
  R.connected = () => !!R.key;
  R.modeLabel = () => ({ simulated: 'Smartcar simulator', test: 'Smartcar test mode', live: 'Live vehicles' }[cfg.mode] || cfg.mode);

  // ---------------------------------------------------------------- local persistence (this device only)
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE) || 'null'); if (!d) return;
      R.key = d.key || null; R.names = d.names || {};
      R.vehicles = (d.vehicles || []).map((v) => { ensureModel(v.make, v.modelName, v.summary && v.summary.capacityKwh, v.model); return v; });
    } catch (e) { /* nothing stored */ }
  }
  function persist() {
    try { localStorage.setItem(STORE, JSON.stringify({ key: R.key, names: R.names, vehicles: R.vehicles })); } catch (e) { /* storage blocked */ }
  }

  // ---------------------------------------------------------------- function calls
  async function call(action, body) {
    if (!FN) throw new Error('Cloud functions are not configured (js/config.js).');
    const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cloud.key ? { apikey: cloud.key } : {}) }, body: JSON.stringify({ action, ...(body || {}) }) });
    let j = null; try { j = await r.json(); } catch (e) { /* not JSON */ }
    if (!r.ok) { const err = new Error((j && j.error) || `Request failed (${r.status})`); err.status = r.status; throw err; }
    return j;
  }
  R.checkServer = async () => {
    if (!FN) { R.server = false; return false; }
    try { R.server = !!(await call('status')).configured; } catch (e) { R.server = null; R.error = 'Could not reach the Smartcar service.'; }
    return R.server;
  };

  // ---------------------------------------------------------------- vehicle mapping
  const title = (s) => String(s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bBmw\b/, 'BMW').replace(/\bByd\b/, 'BYD').replace(/\bMg\b/, 'MG').replace(/\bVw\b/, 'VW');
  // Real vehicles need a catalog entry for range and charging maths. Reuse a known model when the names match.
  function ensureModel(make, model, kwh, prefer) {
    if (prefer && VF.MODELS[prefer]) return prefer;
    const full = `${title(make)} ${model || ''}`.trim();
    const known = Object.keys(VF.MODELS).find((k) => k.toLowerCase() === full.toLowerCase() || (model && k.toLowerCase().startsWith(`${title(make)} ${model}`.toLowerCase())));
    if (known) return known;
    if (!VF.MODELS[full]) VF.MODELS[full] = { oem: title(make) || 'Other', kwh: kwh || 60, eff: 0.17, dc: 100, ac: 7, ports: ['CCS2', 'Type 2'], spec: 'Connected via Smartcar', connected: true };
    return full;
  }
  function nearestPlace(lat, lon) {
    const n = VF.nearestNode(lat, lon); const p = VF.PLACES[n];
    return VF.hav(p, { lat, lon }) < 4 ? n : null;
  }
  function toVehicle(x, prev) {
    const s = x.summary || {}; const info = x.info || {};
    const make = title(info.make) || 'Connected'; const modelName = info.model || 'vehicle';
    const model = ensureModel(make, modelName, s.capacityKwh, prev && prev.model);
    const loc = s.lat != null ? { lat: s.lat, lon: s.lon } : (prev && prev.loc) || null;
    const ageMs = Date.now() - (x.fetchedAt || Date.now());
    const noData = x.error && !(x.signals || []).length;
    return {
      id: 'sc-' + x.id, scId: x.id, real: true, source: 'Smartcar',
      name: R.names[x.id] || info.nickname || `${make} ${modelName}`, model, make, modelName,
      plate: '—', vin: info.vin || '', year: info.year || '', depot: (prev && prev.depot) || 'dp1',
      status: noData ? 'offline' : s.charging ? 'charging' : 'available',
      soc: s.soc != null ? s.soc : prev ? prev.soc : 0, socKnown: s.soc != null,
      rangeKm: s.rangeKm, odo: s.odometerKm != null ? s.odometerKm : (prev && prev.odo) || 0,
      loc, node: loc ? nearestPlace(loc.lat, loc.lon) || VF.depotNode('dp1') : VF.depotNode('dp1'),
      trip: null, driverId: null, lastSeen: VF.now() - ageMs, fetchedAt: x.fetchedAt, added: (prev && prev.added) || Date.now(),
      soh: s.soh, tempC: null, tyres: [], aux12v: null, nextServiceKm: null, maintenance: (prev && prev.maintenance) || [],
      summary: s, signals: x.signals || [], error: x.error || null,
    };
  }
  function ingest(list) {
    const prev = Object.fromEntries(R.vehicles.map((v) => [v.scId, v]));
    R.vehicles = list.map((x) => toVehicle(x, prev[x.id]));
    persist(); R.inject();
  }
  // Put this device's real vehicles into the fleet shown on screen (never saved: see VF.stateJSON).
  R.inject = () => {
    const f = VF.state && VF.state.fleet; if (!f) return;
    f.vehicles = f.vehicles.filter((v) => !v.real).concat(R.vehicles);
  };

  // ---------------------------------------------------------------- connect, poll, command, disconnect
  R.connect = async () => {
    if (!R.ready()) { openSetup(); return; }
    R.busy = true; VF.rerender();
    try {
      const { state } = await call('start');
      try { sessionStorage.setItem(STATE, state); } catch (e) { /* kept in URL only */ }
      const redirect = location.origin + location.pathname;
      const q = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: redirect, scope: cfg.scope.join(' '), mode: cfg.mode, state, approval_prompt: 'force' });
      location.assign('https://connect.smartcar.com/oauth/authorize?' + q.toString());
    } catch (e) {
      R.busy = false; R.error = e.message; VF.toast(e.status === 503 ? 'Smartcar is not set up on the server yet.' : e.message); VF.rerender();
    }
  };
  // Back from Smartcar Connect: ?user_id=…&state=… (or ?error=…)
  R.handleRedirect = async () => {
    const q = new URLSearchParams(location.search);
    if (!q.has('user_id') && !q.has('error')) return false;
    const state = q.get('state'); let expected = null; try { expected = sessionStorage.getItem(STATE); sessionStorage.removeItem(STATE); } catch (e) { /* none */ }
    history.replaceState(null, '', location.pathname + '#m-vehicles');
    if (q.has('error')) { VF.toast(q.get('error') === 'access_denied' ? 'Vehicle connection cancelled.' : `Smartcar: ${q.get('error_description') || q.get('error')}`); return true; }
    if (!state || (expected && state !== expected)) { VF.toast('That connection link did not come from this device. Try again.'); return true; }
    try {
      const res = await call('link', { userId: q.get('user_id'), state });
      R.key = res.key; R.lastPoll = Date.now(); ingest(res.vehicles || []);
      VF.toast(`${res.vehicles.length} vehicle${res.vehicles.length === 1 ? '' : 's'} connected through Smartcar`);
      VF.rerender();
    } catch (e) { VF.toast(e.message); }
    return true;
  };
  R.poll = async (force) => {
    if (!R.key || R.polling) return;
    R.polling = true;
    try { const res = await call('vehicles', { key: R.key, force: !!force }); R.error = ''; R.lastPoll = Date.now(); ingest(res.vehicles || []); if (VF.rerender) VF.rerender(); }
    catch (e) {
      R.error = e.message; R.lastPoll = Date.now();
      if (e.status === 401) { R.key = null; R.vehicles = []; persist(); R.inject(); VF.toast('Smartcar access ended on this device. Connect the vehicle again.'); VF.rerender(); }
    } finally { R.polling = false; }
  };
  R.command = async (vehicleId, command) => {
    const res = await call('command', { key: R.key, vehicleId, command });
    VF.toast(res.message || 'Command sent'); setTimeout(() => R.poll(true), 20_000);
  };
  R.disconnect = async () => {
    try { if (R.key) await call('disconnect', { key: R.key }); } catch (e) { /* removed locally either way */ }
    R.key = null; R.vehicles = []; R.names = {}; persist(); R.inject();
  };
  // Poll while an EV Manager is signed in and the tab is visible.
  setInterval(() => {
    const u = VF.session && VF.user && VF.user(VF.session.userId);
    if (R.key && !document.hidden && u && u.role === 'manager' && Date.now() - R.lastPoll > POLL_MS) R.poll();
  }, 5000);

  // ---------------------------------------------------------------- UI pieces
  const ago = (ms) => { if (!ms) return 'never'; const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
  R.ago = ago;
  function openSetup() {
    C.modal({ title: 'Connect vehicles through Smartcar', sub: 'Smartcar links 40+ car brands through the owner’s carmaker account. No hardware needed.', submitLabel: 'Got it', body: setupSteps(), onSubmit: () => null });
  }
  const setupSteps = () => `<ol class="steps">
      <li><strong>Create a Smartcar application</strong><span class="small muted">At dashboard.smartcar.com. Add <code>${esc(location.origin + location.pathname)}</code> as a redirect URI, and choose permissions: vehicle info, VIN, battery, charge, location, odometer and charge control.</span></li>
      <li><strong>Store the secret on the server</strong><span class="small muted">In Supabase → Edge Functions → Secrets add <code>SMARTCAR_CLIENT_ID</code> and <code>SMARTCAR_CLIENT_SECRET</code> (API credentials). The secret never goes in this web app.</span></li>
      <li><strong>Add the public client ID here</strong><span class="small muted">In <code>js/config.js</code> set <code>window.VOLTFLEET_SMARTCAR.clientId</code>. Keep <code>mode: 'simulated'</code> to try Smartcar’s simulated cars first, then switch to <code>'live'</code>.</span></li>
    </ol>
    <p class="small muted">Status: web app ${cfg.clientId ? 'has a client ID' : 'needs a client ID'} · server ${R.server === true ? 'is configured' : R.server === false ? 'needs its secrets' : 'not checked yet'}.</p>`;
  R.setupHTML = setupSteps;

  // Banner on My Vehicles
  R.banner = () => {
    if (R.connected()) return C.banner('teal', 'radio-tower', `<strong>${R.vehicles.length} vehicle${R.vehicles.length === 1 ? '' : 's'} live through Smartcar</strong> (${esc(R.modeLabel())}). Updated ${ago(R.lastPoll)}${R.error ? ` · <span class="text-bad">${esc(R.error)}</span>` : ''}. Live vehicles appear only on this device.`);
    return '';
  };
  R.connectButton = (cls) => `<button class="btn ${cls || ''}" data-act="sc-connect" ${R.busy ? 'disabled' : ''}>${icon('radio-tower')}<span class="hide-sm">${R.connected() ? 'Connect another vehicle' : 'Connect a vehicle'}</span></button>`;

  // Vehicle page for a real vehicle
  function fmtValue(s) {
    if (s.error) return `<span class="faint">${esc(s.error)}</span>`;
    const b = s.body; if (b == null) return '<span class="faint">—</span>';
    if (typeof b !== 'object') return esc(String(b));
    if (b.latitude != null) return `<span class="num">${(+b.latitude).toFixed(5)}, ${(+b.longitude).toFixed(5)}</span>`;
    if (b.value !== undefined) { const v = b.value; return `<span class="num">${typeof v === 'number' ? fmt.n(v, Math.abs(v) < 10 && v % 1 ? 2 : v % 1 ? 1 : 0) : esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span>${b.unit ? ` <span class="small muted">${esc(b.unit)}</span>` : ''}`; }
    return `<span class="small mono">${esc(JSON.stringify(b).slice(0, 120))}</span>`;
  }
  R.page = (v) => {
    const s = v.summary || {};
    const charging = s.charging ? 'Charging' : s.pluggedIn ? 'Plugged in, not charging' : s.pluggedIn === false ? 'Not plugged in' : 'Unknown';
    const p = v.loc; const vb = p ? VF.fitBox([[p.lat, p.lon]], 240, 1.6) : null;
    const sb = (l, val) => `<div class="sb"><span class="stat-label">${l}</span><span class="stat-value">${val}</span></div>`;
    return `<div class="detail-head card">
        <div class="dh-art">${C.vehicleArt(VF.vehicleKind(v.model))}</div>
        <div class="dh-main"><div class="row">${C.badge(v.status)}<span class="badge teal live-badge">${icon('radio-tower')}Live · Smartcar</span></div><h2>${esc(v.name)}</h2><p class="muted">${esc(v.make)} ${esc(v.modelName)}${v.year ? ' · ' + v.year : ''}${v.vin ? ` · VIN <span class="mono">${esc(VF.mask.vin(v.vin))}</span>` : ''}</p></div>
        <div class="dh-stats">${sb('Battery', v.socKnown ? Math.round(v.soc) + '%' : '—')}${sb('Range', v.rangeKm != null ? fmt.km(v.rangeKm) : '—')}${sb('Charging', esc(charging))}${sb('Odometer', s.odometerKm != null ? fmt.n(s.odometerKm) + ' km' : '—')}</div>
      </div>
      ${v.error ? C.banner('warn', 'triangle-alert', `Latest reading failed: ${esc(v.error)}. Showing the last values received.`) : ''}
      <div class="dash">
        ${C.card({ cls: 'span-7', title: 'Live telematics', sub: `${esc(R.modeLabel())} · updated ${ago(v.fetchedAt)}` }, `
          ${v.socKnown ? C.battery(v.soc, { charging: !!s.charging }) : ''}
          <div class="kv-grid">
            <div><span class="stat-label">Charge state</span><strong>${esc(s.chargeState ? s.chargeState.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : charging)}</strong></div>
            <div><span class="stat-label">Charge limit</span><strong>${s.chargeLimit != null ? Math.round(s.chargeLimit) + '%' : '—'}</strong></div>
            <div><span class="stat-label">Battery capacity</span><strong>${s.capacityKwh != null ? fmt.n(s.capacityKwh, 1) + ' kWh' : '—'}</strong></div>
            <div><span class="stat-label">Battery health</span><strong>${s.soh != null ? Math.round(s.soh) + '%' : 'Not reported'}</strong></div>
            <div><span class="stat-label">Location</span><strong>${p ? esc(VF.fleetPlace(v)) : 'Not shared'}</strong></div>
            <div><span class="stat-label">Data source</span><strong>Smartcar API v3</strong></div>
          </div>
          <div class="card-actions">
            <button class="btn" data-act="sc-refresh">${icon('refresh-cw')}Refresh now</button>
            ${s.charging ? `<button class="btn" data-act="sc-cmd" data-id="${esc(v.scId)}" data-k="stop">${icon('pause')}Stop charging</button>` : `<button class="btn primary" data-act="sc-cmd" data-id="${esc(v.scId)}" data-k="start" ${s.pluggedIn === false ? 'disabled title="Plug the vehicle in first"' : ''}>${icon('plug-zap')}Start charging</button>`}
            ${p ? `<a class="btn ghost" href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}" target="_blank" rel="noopener">${icon('navigation')}Open in Maps</a>` : ''}
          </div>`)}
        ${C.card({ cls: 'span-5', title: 'Name and privacy' }, `<form id="sc-name-form" class="stack" data-id="${esc(v.scId)}" style="gap:10px">${C.field('Display name', C.input('name', v.name, 'required maxlength="30"'))}<div class="card-actions"><button class="btn small" type="submit">Save name</button></div></form>
          <ul class="tips"><li>${icon('shield-check')}<span>Live data from this vehicle stays on this device. It is not shared with other users of this demo or with charging operators.</span></li><li>${icon('clock')}<span>The server keeps the latest reading for one minute to limit requests, and deletes it when you disconnect.</span></li></ul>
          <button class="btn danger" data-act="sc-disconnect">${icon('unplug')}Disconnect Smartcar</button>`)}
        ${p ? C.card({ cls: 'span-12', title: 'Location', action: VF.mgr.mapNote() }, `<div class="map-wrap">${VF.mgr.fleetMap('m-veh-map', { only: v.id, vb, labels: false })}</div>`) : ''}
        ${C.card({ cls: 'span-12 flush', title: 'All signals', sub: `${v.signals.length} signals reported by the vehicle` }, C.table([
          { label: 'Signal', render: (x) => `<strong>${esc(x.name)}</strong><div class="small muted mono">${esc(x.code)}</div>` },
          { label: 'Group', render: (x) => esc(x.group) },
          { label: 'Value', render: fmtValue },
          { label: 'Reported', render: (x) => (x.at ? `<span class="small muted">${ago(Date.parse(x.at))}</span>` : '<span class="faint">—</span>') },
        ], v.signals.map((x, i) => Object.assign({ id: String(i) }, x)), { empty: { icon: 'radio-tower', title: 'No signals yet', text: 'Readings appear after the first refresh.' } }))}
      </div>`;
  };

  Object.assign(VF.ACT, {
    'sc-connect': () => R.connect(),
    'sc-setup': () => { R.checkServer().then(() => openSetup()); },
    'sc-refresh': async () => { VF.toast('Refreshing from Smartcar…'); await R.poll(true); },
    'sc-cmd': async (el) => {
      const start = el.dataset.k === 'start'; const v = R.vehicles.find((x) => x.scId === el.dataset.id);
      if (!await C.confirm({ title: `${start ? 'Start' : 'Stop'} charging ${v ? v.name : 'this vehicle'}?`, body: start ? 'The command goes to the real vehicle through its carmaker. It must be plugged in.' : 'Charging stops on the real vehicle.', confirmLabel: start ? 'Start charging' : 'Stop charging', danger: !start, icon: 'plug-zap' })) return;
      try { await R.command(el.dataset.id, el.dataset.k); } catch (e) { VF.toast(e.message); }
    },
    'sc-disconnect': async () => {
      if (!await C.confirm({ title: 'Disconnect Smartcar on this device?', body: 'Live vehicles disappear from EV Manager here and the server deletes their cached readings. To revoke VoltFleet completely, the owner also removes it in their Smartcar account or carmaker app.', confirmLabel: 'Disconnect', danger: true })) return;
      await R.disconnect(); VF.toast('Smartcar disconnected'); location.hash = 'm-vehicles'; VF.rerender();
    },
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'sc-name-form') return;
    e.preventDefault();
    const name = (new FormData(e.target).get('name') || '').toString().trim();
    if (!name) { VF.toast('Enter a name'); return; }
    R.names[e.target.dataset.id] = name; R.vehicles.forEach((v) => { if (v.scId === e.target.dataset.id) v.name = name; }); persist(); R.inject(); VF.toast('Name saved'); VF.rerender();
  });

  load();
})();
