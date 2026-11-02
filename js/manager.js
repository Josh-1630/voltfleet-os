/* VoltFleet OS — EV Manager (part 1): dashboard, My Vehicles, Charging Stations, Charging Sessions.
   Pages are built from the shared components in ui.js and read the fleet layer in fleet.js. */
'use strict';
(function () {
  const { esc, sum, fmt, icon } = VF;
  const C = VF.c;
  const MIN = VF.MIN, HOUR = VF.HOUR, DAY = VF.DAY;
  const ui = VF.ui.manager = { vview: 'grid', vfilter: 'all', vq: '', vehicle: null, vtab: 'overview', stView: 'list', stConn: 'all', stSpeed: 'all', stAvail: false, stFrom: 'dp1', stSel: null, sessTab: 'active', sessDays: 30, sessVehicle: 'all', dashDays: 30 };
  const F = () => VF.state.fleet;
  const M = (v) => VF.MODELS[v.model];
  const me = () => VF.user(VF.session.userId);
  const dname = (id) => { const d = id && VF.fleetDriver(id); return d ? d.name : 'Unassigned'; };
  const money = (x, d) => fmt.money(x, d);
  const fleetPorts = () => [...new Set(F().vehicles.flatMap((v) => M(v).ports))];
  VF.mgr = { ui, dname, money };

  // ---------------------------------------------------------------- shared fragments
  function chargeLabel(v) {
    if (v.real) { const s = v.summary || {}; return s.charging ? 'Charging · live' : s.pluggedIn ? 'Plugged in' : v.error ? 'Last reading failed' : `Live · updated ${VF.real.ago(v.fetchedAt)}`; }
    if (v.status === 'charging') { const live = VF.fleetLiveSessions().find((x) => x.v.id === v.id); return live ? `Charging at ${live.st.name.split(' ').slice(0, 2).join(' ')} · ${fmt.kw(live.se.kw)}` : 'Charging'; }
    if (v.status === 'waiting') return 'Waiting for a free connector';
    if (v.trip && v.trip.purpose === 'charge') return `Heading to ${VF.station(v.trip.stationId).name.split(' ').slice(0, 2).join(' ')}`;
    if (v.pendingPlan) return 'Charging before its journey';
    return v.soc < 20 ? 'Needs charging soon' : 'Not charging';
  }
  function vehicleRow(v) {
    return `<div class="vrow" data-act="m-open-vehicle" data-id="${v.id}" role="button" tabindex="0">
      <div class="vrow-art">${C.vehicleArt(VF.vehicleKind(v.model))}</div>
      <div class="vrow-main"><strong>${esc(v.name)}</strong><span class="muted small">${esc(v.model)} · ${v.real ? '<span class="live-chip">Live</span>' : `<span class="mono">${esc(v.plate)}</span>`}</span></div>
      <div class="vrow-batt">${C.battery(v.soc, { charging: v.status === 'charging', live: `v-${v.id}-w`, liveText: `v-${v.id}-soc` })}<span class="small muted"><span data-live="v-${v.id}-range">${fmt.km(VF.fleetRange(v))}</span> range</span></div>
      <div class="vrow-status">${C.badge(v.status)}<span class="small muted" data-live="v-${v.id}-chg">${esc(chargeLabel(v))}</span></div>
      <div class="vrow-loc small muted">${icon('map-pin')}<span data-live="v-${v.id}-loc">${esc(VF.fleetPlace(v))}</span></div>
    </div>`;
  }
  function vehicleLive(vals, v) {
    vals[`v-${v.id}-w`] = { w: v.soc }; vals[`v-${v.id}-soc`] = Math.round(v.soc) + '%';
    vals[`v-${v.id}-range`] = fmt.km(VF.fleetRange(v)); vals[`v-${v.id}-chg`] = chargeLabel(v); vals[`v-${v.id}-loc`] = VF.fleetPlace(v);
  }
  function stationClass(st) {
    const ports = fleetPorts();
    const comp = st.connectors.filter((c) => ports.includes(c.type));
    if (st.status !== 'online' || !comp.length || comp.every((c) => c.status === 'Faulted' || c.status === 'Unavailable')) return 'off';
    return comp.some((c) => c.status === 'Available') ? 'avail' : 'busy';
  }
  VF.mgr.fleetMap = function (id, opts) {
    opts = opts || {};
    const vehicles = F().vehicles.filter((v) => !opts.only || v.id === opts.only).map((v) => { const p = VF.fleetPos(v); return { id: v.id, lat: p.lat, lon: p.lon, progress: opts.route && opts.only && v.trip ? tripProgress(v) : null, cls: v.status, label: opts.labels === false ? '' : v.name.replace(/^(\w)\w*\s/, '$1'), title: `${v.name} · ${v.status.replace('_', ' ')} · ${Math.round(v.soc)}%`, act: 'm-open-vehicle' }; });
    return VF.mapSVG({ id, vb: opts.vb, stations: VF.state.stations.map((st) => ({ st, cls: stationClass(st), label: st.name.split(' ').slice(0, 2).join(' ').replace(/&$/, '') })), vehicles, route: opts.route, stationAct: opts.stationAct, label: 'Fleet and charging stations' });
  };
  const tripProgress = (v) => (v.trip && v.trip.totalKm ? v.trip.doneKm / v.trip.totalKm : null);
  VF.mgr.liveMap = function (id) {
    if (VF.maps && VF.maps.has(id)) { for (const v of F().vehicles) { const p = VF.fleetPos(v); VF.maps.moveVehicle(id, v.id, p.lat, p.lon, v.status, tripProgress(v)); } return; }
    const svg = document.getElementById(id); if (!svg) return;
    for (const g of svg.querySelectorAll('.fv[data-id]')) {
      const v = VF.fleetVehicle(g.dataset.id); if (!v) continue;
      const p = VF.fleetPos(v); const [x, y] = VF.proj(p.lat, p.lon);
      g.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`); g.setAttribute('class', 'fv ' + v.status);
    }
  };
  VF.mgr.mapNote = () => (VF.maps && VF.maps.enabled() ? `<div class="map-note">${icon('info')}<span>Street map by ${esc(VF.maps.providerName())}. Vehicle positions are sample data until telematics are connected${VF.maps.routing() ? '; routes follow real roads' : ''}. Click the map to zoom with the scroll wheel.</span></div>` : `<div class="map-note">${icon('info')}<span>Schematic map of Greater Accra. Connect a map provider in <a href="#m-settings">Settings → Integrations</a> for street-level maps.</span></div>`);
  const mapLegend = () => C.legend([['In use', 'teal'], ['Charging', 'mint'], ['Available', 'ok'], ['Needs attention', 'warn'], ['Station free', 'ok-sq'], ['Station busy', 'warn-sq']]);

  // ---------------------------------------------------------------- dashboard
  function kpis() {
    const f = F(); const vs = f.vehicles; const m30 = VF.fleetMetrics(30);
    const active = vs.filter((v) => v.status === 'in_use' || v.status === 'charging').length;
    const avg = vs.length ? sum(vs, (v) => v.soc) / vs.length : 0;
    const low = vs.filter((v) => v.soc < 20).length;
    const range = sum(vs.filter((v) => v.status !== 'offline'), (v) => VF.fleetRange(v));
    const ports = fleetPorts();
    const online = VF.state.stations.filter((st) => st.status === 'online' && st.connectors.some((c) => ports.includes(c.type)));
    const free = online.filter((st) => st.connectors.some((c) => ports.includes(c.type) && c.status === 'Available'));
    const freeConns = sum(online, (st) => st.connectors.filter((c) => ports.includes(c.type) && c.status === 'Available').length);
    const tr = (k) => { const t = VF.fleetTrend(k); return { dir: t >= 0 ? 'up' : 'down', text: `${Math.abs(t).toFixed(0)}% vs last week` }; };
    const cost = tr('cost'); cost.good = cost.dir === 'down';
    const kwh = tr('kwh');
    const co2 = tr('km'); co2.good = co2.dir === 'up';
    return [
      C.stat({ icon: 'car-front', label: 'Total vehicles', value: vs.length, hint: `${f.drivers.length} drivers · ${f.depots.length} depots`, tip: 'Company vehicles in GreenLine Logistics' }),
      C.stat({ icon: 'activity', label: 'Active vehicles', value: active, unit: `/ ${vs.length}`, hint: `${vs.filter((v) => v.status === 'maintenance').length} in maintenance · ${vs.filter((v) => v.status === 'offline').length} offline`, tip: 'On a job or charging right now' }),
      C.stat({ icon: 'battery-medium', label: 'Average battery', value: Math.round(avg), unit: '%', hint: low ? `${low} vehicle${low > 1 ? 's' : ''} below 20%` : 'All vehicles above 20%', tone: low ? 'warn' : '' }),
      C.stat({ icon: 'zap', label: 'Energy consumed', value: fmt.n(m30.kwh), unit: 'kWh', trend: kwh, hint: `${fmt.n(m30.per100, 1)} kWh/100 km · 30 days` }),
      C.stat({ icon: 'coins', label: 'Charging cost', value: money(m30.cost, 0), trend: cost, hint: `${money(m30.costPerKwh)} per kWh · 30 days` }),
      C.stat({ icon: 'gauge', label: 'Estimated range', value: fmt.n(range), unit: 'km', hint: `${fmt.n(range / Math.max(1, vs.length))} km average per vehicle`, tip: 'Combined range of all reporting vehicles at current charge' }),
      C.stat({ icon: 'leaf', label: 'CO₂ emissions saved', value: fmt.n(m30.co2, 1), unit: 't', trend: co2, hint: 'vs. diesel equivalents · 30 days', tone: 'lime' }),
      C.stat({ icon: 'plug-zap', label: 'Available stations', value: free.length, unit: `/ ${online.length}`, hint: `${freeConns} compatible connectors free now`, tip: 'Stations with a connector that fits at least one fleet vehicle' }),
    ].join('');
  }
  function attention() {
    const vs = F().vehicles; const items = [];
    vs.filter((v) => v.soc < 20 && v.status !== 'charging').forEach((v) => items.push(['battery-low', 'bad', `${v.name} at ${Math.round(v.soc)}%`, chargeLabel(v), v.id]));
    vs.filter((v) => v.status === 'offline').forEach((v) => items.push(['wifi-off', 'warn', `${v.name} offline`, `Last seen ${VF.relTime(v.lastSeen)}`, v.id]));
    vs.filter((v) => v.status === 'maintenance').forEach((v) => items.push(['wrench', 'warn', `${v.name} in maintenance`, (v.maintenance.find((x) => x.open) || {}).type || 'Workshop', v.id]));
    vs.filter((v) => v.real && v.error).forEach((v) => items.push(['radio-tower', 'warn', `${v.name}: no fresh data`, v.error, v.id]));
    vs.filter((v) => !v.real && v.odo > v.nextServiceKm - 500 && v.status !== 'maintenance').forEach((v) => items.push(['calendar-clock', 'teal', `${v.name} service due`, `at ${fmt.n(v.nextServiceKm)} km`, v.id]));
    return items;
  }
  function chargingRows(limit) {
    const live = VF.fleetLiveSessions().map((x) => ({ id: x.se.id, v: x.v, st: x.st, start: x.se.start, end: null, kwh: x.se.kwh, cost: x.se.cost, status: 'active', live: true }));
    const done = VF.fleetSessions().slice(0, limit).map((x) => ({ id: x.id, v: VF.fleetVehicle(x.vehicleId), st: VF.station(x.stationId), start: x.start, end: x.end, kwh: x.kwh, cost: x.cost, status: x.status }));
    return live.concat(done).slice(0, limit);
  }
  const sessionCols = (showVehicle) => [
    ...(showVehicle ? [{ label: 'Vehicle', render: (r) => `<strong>${esc(r.v.name)}</strong><div class="small muted">${esc(r.v.model)}</div>` }] : []),
    { label: 'Station', render: (r) => `${esc(r.st.name)}<div class="small muted">${esc(VF.operator(r.st.operatorId).name)}</div>` },
    { label: 'Started', render: (r) => `<span class="num">${VF.fmtDayTime(r.start)}</span>` },
    { label: 'Duration', align: 'r', render: (r) => r.live ? `<span data-live="s-${r.id}-dur">${fmt.dur((VF.now() - r.start) / MIN)}</span>` : fmt.dur((r.end - r.start) / MIN) },
    { label: 'Energy', align: 'r', render: (r) => r.live ? `<span data-live="s-${r.id}-kwh">${fmt.kwh(r.kwh)}</span>` : fmt.kwh(r.kwh) },
    { label: 'Cost', align: 'r', render: (r) => r.live ? `<span data-live="s-${r.id}-cost">${money(r.cost)}</span>` : money(r.cost) },
    { label: 'Status', render: (r) => C.badge(r.status === 'active' ? 'charging' : r.status, r.status === 'active' ? 'In progress' : null) },
  ];
  function sessionLive(vals) {
    for (const x of VF.fleetLiveSessions()) { vals[`s-${x.se.id}-dur`] = fmt.dur((VF.now() - x.se.start) / MIN); vals[`s-${x.se.id}-kwh`] = fmt.kwh(x.se.kwh); vals[`s-${x.se.id}-cost`] = money(x.se.cost); vals[`s-${x.se.id}-kw`] = fmt.kw(x.se.kw); vals[`s-${x.se.id}-w`] = { w: x.se.soc }; vals[`s-${x.se.id}-soc`] = Math.round(x.se.soc) + '%'; }
  }
  function welcomeArt() {
    return `<div class="welcome-art" aria-hidden="true"><span class="wa-ring"></span>${C.vehicleArt('suv', 'wa-car')}<span class="wa-plug">${icon('zap')}</span></div>`;
  }
  function pageDashboard() {
    const f = F(); const vs = f.vehicles; const h = VF.hourOf(VF.now());
    const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const att = attention();
    const order = { charging: 1, in_use: 0, waiting: 2, available: 3, offline: 4, maintenance: 5 };
    const list = vs.slice().sort((a, b) => (a.soc < 20) - (b.soc < 20) ? -1 : 0 || order[a.status] - order[b.status]).sort((a, b) => (b.soc < 20 && b.status !== 'charging') - (a.soc < 20 && a.status !== 'charging')).slice(0, 6);
    const counts = (s) => vs.filter((v) => v.status === s).length;
    return `<section class="welcome">
        <div class="welcome-text"><h2>${greet}, ${esc(me().name.split(' ')[0])}!</h2><p>Your mobility at a glance.</p>
          <div class="welcome-chips"><span>${icon('route')}<b>${counts('in_use')}</b> on the road</span><span>${icon('battery-charging')}<b>${counts('charging')}</b> charging</span><span>${icon('circle-check')}<b>${counts('available')}</b> ready</span>${att.length ? `<span class="warn">${icon('triangle-alert')}<b>${att.length}</b> need attention</span>` : ''}</div></div>
        ${welcomeArt()}
      </section>
      <section class="stat-grid" data-live="m-kpis">${kpis()}</section>
      <div class="dash">
        ${C.card({ cls: 'span-8 flush', title: 'Vehicle overview', sub: 'Live status of your fleet', action: `<a class="btn small ghost" href="#m-vehicles">View all ${icon('arrow-right')}</a>` }, `<div class="vlist">${list.map(vehicleRow).join('')}</div>`)}
        <div class="span-4 stack">
          ${C.card({ title: 'Quick actions' }, `<div class="quick-grid">
            <button class="qa" data-act="m-add-vehicle">${icon('plus')}<span>Add vehicle</span></button>
            <a class="qa" href="#m-stations">${icon('map-pin')}<span>Find a charging station</span></a>
            <button class="qa" data-act="m-start-session">${icon('plug-zap')}<span>Start charging session</span></button>
            <a class="qa" href="#m-trips">${icon('route')}<span>Plan a journey</span></a>
            <a class="qa" href="#m-reports">${icon('file-text')}<span>View reports</span></a>
          </div>`)}
          ${C.card({ title: 'Needs attention', action: att.length ? `<span class="badge warn">${att.length}</span>` : '' }, att.length ? `<ul class="att-list">${att.slice(0, 5).map(([ic, tone, title, sub, id]) => `<li data-act="m-open-vehicle" data-id="${id}" role="button" tabindex="0"><span class="att-ic ${tone}">${icon(ic)}</span><div><strong>${esc(title)}</strong><span class="small muted">${esc(sub)}</span></div>${icon('chevron-right', 'chev')}</li>`).join('')}</ul>` : C.empty({ icon: 'circle-check', title: 'All clear', text: 'No vehicle needs attention right now.' }))}
        </div>
        ${C.card({ cls: 'span-8', title: 'Vehicle locations', sub: 'Live positions and nearby charging stations', action: mapLegend() }, `<div class="map-wrap">${VF.mgr.fleetMap('m-dash-map')}</div>${VF.mgr.mapNote()}`)}
        ${C.card({ cls: 'span-4 wide-md', title: 'Fleet status' }, `<div data-live="m-donut">${statusDonut()}</div>`)}
        ${C.card({ cls: 'span-12 flush', title: 'Charging activity', sub: 'Recent sessions across the public network', action: `<a class="btn small ghost" href="#m-sessions">All sessions ${icon('arrow-right')}</a>` }, C.table(sessionCols(true), chargingRows(6), { empty: { icon: 'plug-zap', title: 'No charging yet today' } }))}
        ${C.card({ cls: 'span-8', title: 'Energy consumption', sub: 'kWh per day, completed days', action: C.seg([[7, '7 days'], [30, '30 days']], ui.dashDays, 'm-dash-days') }, '<div class="chart-slot" data-chart="m-energy"></div>')}
        ${C.card({ cls: 'span-4 lime-card', title: 'CO₂ emissions saved', sub: 'Compared with diesel equivalents' }, `<div class="big-metric lime"><span>${fmt.n(VF.fleetMetrics(ui.dashDays).co2, 1)}</span><small>tonnes in ${ui.dashDays} days</small></div><div class="chart-slot" data-chart="m-co2"></div>`)}
        ${C.card({ cls: 'span-4', title: 'Charging costs', sub: `${esc(VF.state.settings.currency)} per day` }, '<div class="chart-slot" data-chart="m-cost"></div>')}
        ${C.card({ cls: 'span-4', title: 'Vehicle utilisation', sub: 'Share of working hours in use, 30 days' }, C.hbars(utilisation().slice(0, 6), { tone: 'mint' }))}
        ${C.card({ cls: 'span-4', title: 'Battery performance', sub: 'State of health, lowest first' }, C.hbars(VF.simVehicles().sort((a, b) => a.soh - b.soh).slice(0, 6).map((v) => ({ label: v.name, value: v.soh, text: v.soh + '%', tone: v.soh < 90 ? 'warn' : 'teal' }))) + `<p class="small muted">Fleet average ${fmt.n(sum(VF.simVehicles(), (v) => v.soh) / Math.max(1, VF.simVehicles().length), 1)}% · batteries below 80% need a dealer check.</p>`)}
      </div>`;
  }
  function statusDonut() {
    const vs = F().vehicles; const c = (s) => vs.filter((v) => v.status === s).length;
    return C.donut([{ label: 'In use', value: c('in_use'), tone: 'teal' }, { label: 'Charging', value: c('charging') + c('waiting'), tone: 'mint' }, { label: 'Available', value: c('available'), tone: 'ok' }, { label: 'Maintenance', value: c('maintenance'), tone: 'warn' }, { label: 'Offline', value: c('offline'), tone: 'muted' }], { value: vs.length, caption: 'vehicles', label: 'Fleet status' });
  }
  function utilisation() {
    const rows = VF.fleetHistory();
    return VF.simVehicles().map((v) => { const h = sum(rows.filter((x) => x.vid === v.id), (x) => x.hours); const pct = Math.min(100, h / (30 * 12) * 100); return { label: v.name, value: pct, text: Math.round(pct) + '%' }; }).sort((a, b) => b.value - a.value);
  }
  VF.mgr.utilisation = utilisation;
  const label = (ms) => VF.fmtDate(ms);
  function drawDash(slot, key) {
    const w = Math.max(260, slot.clientWidth || 600); const m0 = VF.fleetMetrics(key === 'm-cost' ? 15 : ui.dashDays);
    const m = { daily: m0.daily.filter((x) => x.d < 29) }; // completed days; today is still in progress
    if (key === 'm-energy') slot.innerHTML = C.lineChart(m.daily.map((d) => ({ label: label(d.date), values: { kwh: d.kwh, charged: d.charged } })), [{ key: 'kwh', label: 'Consumed', tone: 'teal', area: true }, { key: 'charged', label: 'Charged', tone: 'mint', dash: true }], w, { label: 'Energy consumption', vFmt: (v) => fmt.kwh(v) });
    if (key === 'm-cost') slot.innerHTML = C.barChart(m.daily.map((d) => ({ label: label(d.date), values: { cost: d.cost } })), [{ key: 'cost', label: 'Charging cost', tone: 'teal' }], w, { h: 180, label: 'Charging costs', vFmt: (v) => money(v, 0) });
    if (key === 'm-co2') { let acc = 0; slot.innerHTML = C.lineChart(m.daily.map((d) => { acc += (d.km * VF.CO2.DIESEL_KG_PER_KM - d.kwh * VF.CO2.GRID_KG_PER_KWH) / 1000; return { label: label(d.date), values: { co2: acc } }; }), [{ key: 'co2', label: 'CO₂ saved (t)', tone: 'lime', area: true }], w, { h: 140, label: 'Cumulative CO₂ saved', vFmt: (v) => fmt.n(v, 2) + ' t', yFmt: (v) => fmt.n(v, 1) }); }
  }

  // ---------------------------------------------------------------- My Vehicles
  const VFILTERS = [['all', 'All'], ['in_use', 'In use'], ['charging', 'Charging'], ['available', 'Available'], ['offline', 'Offline'], ['maintenance', 'Maintenance']];
  function filteredVehicles() {
    const q = ui.vq.trim().toLowerCase();
    return F().vehicles.filter((v) => (ui.vfilter === 'all' || v.status === ui.vfilter || (ui.vfilter === 'charging' && v.status === 'waiting')) && (!q || (v.name + v.model + v.plate + dname(v.driverId)).toLowerCase().includes(q)));
  }
  function vehicleCard(v) {
    return `<article class="vcard">
      <button class="vcard-hit" data-act="m-open-vehicle" data-id="${v.id}" aria-label="Open ${esc(v.name)}"></button>
      <div class="vcard-top">${C.badge(v.status)}${v.real ? '<span class="live-chip">Live · Smartcar</span>' : `<span class="mono small muted">${esc(v.plate)}</span>`}</div>
      <div class="vcard-art">${C.vehicleArt(VF.vehicleKind(v.model))}</div>
      <h3>${esc(v.name)}</h3><p class="small muted">${esc(v.model)} · ${v.year}</p>
      ${C.battery(v.soc, { charging: v.status === 'charging', live: `v-${v.id}-w`, liveText: `v-${v.id}-soc` })}
      <dl class="vcard-dl"><div><dt>Range</dt><dd data-live="v-${v.id}-range">${fmt.km(VF.fleetRange(v))}</dd></div><div><dt>Driver</dt><dd>${esc(dname(v.driverId))}</dd></div><div class="full"><dt>Location</dt><dd data-live="v-${v.id}-loc">${esc(VF.fleetPlace(v))}</dd></div></dl>
    </article>`;
  }
  function pageVehicles() {
    const list = filteredVehicles(); const all = F().vehicles;
    const cnt = (k) => (k === 'all' ? all.length : all.filter((v) => v.status === k || (k === 'charging' && v.status === 'waiting')).length);
    return `${VF.real.banner()}<div class="toolbar">
        <div class="search-field">${icon('search')}<input class="input" type="search" id="m-vq" data-inp="m-vq" placeholder="Search name, model, plate or driver" value="${esc(ui.vq)}" aria-label="Search vehicles"></div>
        <div class="seg" role="group" aria-label="Status">${VFILTERS.map(([k, l]) => `<button type="button" data-act="m-vfilter" data-k="${k}" aria-pressed="${ui.vfilter === k}">${l}<span class="n">${cnt(k)}</span></button>`).join('')}</div>
        <div class="toolbar-end">${C.seg([['grid', '', 'layout-grid'], ['table', '', 'list']], ui.vview, 'm-vview', ' data-tip-pos="b"')}</div>
      </div>
      ${!list.length ? C.card({}, C.empty({ icon: 'car-front', title: 'No vehicles match', text: 'Try another status or clear the search.', action: `<button class="btn" data-act="m-vclear">Clear filters</button>` }))
        : ui.vview === 'grid' ? `<div class="vgrid">${list.map(vehicleCard).join('')}</div>`
          : C.card({ cls: 'flush' }, C.table([
            { label: 'Vehicle', render: (v) => `<div class="cell-vehicle">${C.vehicleArt(VF.vehicleKind(v.model), 'mini')}<div><strong>${esc(v.name)}</strong><div class="small muted">${esc(v.model)} · ${v.year}</div></div></div>` },
            { label: 'Plate', render: (v) => `<span class="mono">${esc(v.plate)}</span>` },
            { label: 'Status', render: (v) => C.badge(v.status) },
            { label: 'Battery', render: (v) => C.battery(v.soc, { charging: v.status === 'charging', live: `v-${v.id}-w`, liveText: `v-${v.id}-soc`, size: 'sm' }) },
            { label: 'Range', align: 'r', render: (v) => `<span data-live="v-${v.id}-range">${fmt.km(VF.fleetRange(v))}</span>` },
            { label: 'Driver', render: (v) => esc(dname(v.driverId)) },
            { label: 'Location', render: (v) => `<span data-live="v-${v.id}-loc">${esc(VF.fleetPlace(v))}</span>` },
          ], list, { rowAct: 'm-open-vehicle' }))}`;
  }

  // ---------------------------------------------------------------- vehicle detail
  const VTABS = [['overview', 'Overview', 'gauge'], ['battery', 'Battery health', 'battery-charging'], ['performance', 'Performance', 'activity'], ['maintenance', 'Maintenance', 'wrench'], ['registration', 'Registration', 'file-text']];
  function pageVehicle() {
    const v = VF.fleetVehicle(ui.vehicle);
    if (!v) return C.card({}, C.empty({ icon: 'car-front', title: 'Vehicle not found', text: 'It may have been removed from the fleet.', action: `<a class="btn primary" href="#m-vehicles">Back to My Vehicles</a>` }));
    if (v.real) return VF.real.page(v);
    const tab = ui.vtab;
    return `<div class="detail-head card">
        <div class="dh-art">${C.vehicleArt(VF.vehicleKind(v.model))}</div>
        <div class="dh-main"><div class="row">${C.badge(v.status)}<span class="mono small muted">${esc(v.plate)}</span></div><h2>${esc(v.name)}</h2><p class="muted">${esc(v.model)} · ${v.year} · ${esc(F().depots.find((d) => d.id === v.depot).name)}</p></div>
        <div class="dh-stats">${statBlock('Battery', `<span data-live="v-${v.id}-soc">${Math.round(v.soc)}%</span>`)}${statBlock('Range', `<span data-live="v-${v.id}-range">${fmt.km(VF.fleetRange(v))}</span>`)}${statBlock('Battery health', v.soh + '%')}${statBlock('Odometer', `<span data-live="v-${v.id}-odo">${fmt.n(v.odo)} km</span>`)}</div>
      </div>
      <nav class="tabs" role="tablist">${VTABS.map(([k, l, ic]) => `<button role="tab" aria-selected="${tab === k}" data-act="m-vtab" data-k="${k}">${icon(ic)}<span>${l}</span></button>`).join('')}</nav>
      ${tab === 'overview' ? vOverview(v) : tab === 'battery' ? vBattery(v) : tab === 'performance' ? vPerformance(v) : tab === 'maintenance' ? vMaintenance(v) : vRegistration(v)}`;
  }
  const statBlock = (l, v) => `<div class="sb"><span class="stat-label">${l}</span><span class="stat-value">${v}</span></div>`;
  function vOverview(v) {
    const m = M(v); const live = VF.fleetLiveSessions().find((x) => x.v.id === v.id);
    const drivers = F().drivers;
    const p = VF.fleetPos(v);
    const vb = VF.fitBox([[p.lat, p.lon]].concat(v.trip ? v.trip.pts : []), 90, 1.6);
    return `<div class="dash">
      ${C.card({ cls: 'span-7', title: 'Live status' }, `
        <div class="kv-grid">
          <div><span class="stat-label">Charging</span><strong data-live="v-${v.id}-chg">${esc(chargeLabel(v))}</strong></div>
          <div><span class="stat-label">Last reported location</span><strong data-live="v-${v.id}-loc">${esc(VF.fleetPlace(v))}</strong></div>
          <div><span class="stat-label">Current job</span><strong>${v.trip ? `${esc(VF.PLACES[v.trip.origin] ? VF.PLACES[v.trip.origin].name : '')} → ${esc(VF.PLACES[v.trip.dest].name)}` : '—'}</strong></div>
          <div><span class="stat-label">Last signal</span><strong>${v.status === 'offline' ? VF.relTime(v.lastSeen) : 'Live'}</strong></div>
        </div>
        ${live ? `<div class="live-charge"><div class="row between"><strong>${esc(live.st.name)}</strong><span class="small muted">${esc(live.c.label)} · ${esc(live.c.type)}</span></div>${C.battery(live.se.soc, { charging: true, live: `s-${live.se.id}-w`, liveText: `s-${live.se.id}-soc` })}<div class="kv-inline small"><span><span data-live="s-${live.se.id}-kw">${fmt.kw(live.se.kw)}</span> now</span><span><span data-live="s-${live.se.id}-kwh">${fmt.kwh(live.se.kwh)}</span> added</span><span><span data-live="s-${live.se.id}-cost">${money(live.se.cost)}</span> so far</span><span>target ${live.se.target}%</span></div></div>` : ''}
        <div class="card-actions">
          ${v.status === 'charging' ? `<button class="btn" data-act="m-stop-charge" data-id="${v.id}">${icon('pause')}Stop charging</button>` : ['maintenance', 'offline'].includes(v.status) ? '' : `<button class="btn primary" data-act="m-charge-vehicle" data-id="${v.id}">${icon('plug-zap')}Send to charge</button>`}
          ${['maintenance', 'offline'].includes(v.status) ? '' : `<a class="btn" href="#m-trips" data-act="m-plan-for" data-id="${v.id}">${icon('route')}Plan a journey</a>`}
          ${v.status === 'maintenance' ? `<button class="btn" data-act="m-maint-off" data-id="${v.id}">${icon('circle-check')}Return to service</button>` : `<button class="btn ghost" data-act="m-maint-on" data-id="${v.id}">${icon('wrench')}Send to workshop</button>`}
        </div>`)}
      ${C.card({ cls: 'span-5', title: 'Driver' }, `<label class="field"><span>Assigned driver</span>${C.select('assign', [['', 'Unassigned']].concat(F().drivers.map((d) => [d.id, d.name + (d.vehicleId && d.vehicleId !== v.id ? ` (drives ${VF.fleetVehicle(d.vehicleId) ? VF.fleetVehicle(d.vehicleId).name : 'another vehicle'})` : '')])), v.driverId || '', `data-chg="m-assign" data-id="${v.id}"`)}</label>
        ${v.driverId ? (() => { const d = VF.fleetDriver(v.driverId); return `<dl class="dl"><dt>Phone</dt><dd class="num">${esc(d.phone)}</dd><dt>Licence</dt><dd class="mono">${esc(d.license)}</dd><dt>Driving score</dt><dd>${d.score}/100</dd></dl>`; })() : '<p class="small muted">Assign a driver so jobs and journeys are recorded against them.</p>'}`)}
      ${C.card({ cls: 'span-12', title: 'Location', action: VF.mgr.mapNote() }, `<div class="map-wrap">${VF.mgr.fleetMap('m-veh-map', { only: v.id, vb, route: v.trip ? v.trip.pts : null, labels: false })}</div>`)}
    </div>`;
  }
  function vRows(v) { return VF.fleetHistory().filter((x) => x.vid === v.id); }
  function vBattery(v) {
    const m = M(v); const cycles = Math.round(v.odo / (m.kwh / (m.eff * 1.08)) * 0.85);
    const sess = VF.fleetSessions().filter((x) => x.vehicleId === v.id);
    return `<div class="dash">
      <div class="stat-grid span-12">${C.stat({ icon: 'battery-full', label: 'State of health', value: v.soh, unit: '%', hint: v.soh >= 90 ? 'Healthy' : v.soh >= 80 ? 'Normal wear' : 'Book a dealer check', tone: v.soh < 85 ? 'warn' : '' })}${C.stat({ icon: 'refresh-cw', label: 'Equivalent full cycles', value: fmt.n(cycles), hint: `${m.kwh} kWh pack` })}${C.stat({ icon: 'thermometer', label: 'Pack temperature', value: `<span data-live="v-${v.id}-temp">${fmt.n(v.tempC, 1)}</span>`, unit: '°C', hint: 'Normal range 20–40 °C' })}${C.stat({ icon: 'plug-zap', label: 'Fast-charge share', value: sess.length ? Math.round(sess.filter((x) => VF.isDC(x.type)).length / sess.length * 100) : 0, unit: '%', hint: `${sess.length} recent sessions`, tip: 'Frequent DC fast charging can speed up battery wear' })}</div>
      ${C.card({ cls: 'span-8', title: 'State of health', sub: 'Last 30 days' }, '<div class="chart-slot" data-chart="m-v-soh"></div>')}
      ${C.card({ cls: 'span-4', title: 'Recommendations' }, `<ul class="tips">${[v.soc > 90 ? 'Charge to 80–85% for daily use to slow battery wear.' : 'Daily charging target of 85% is good for battery life.', sess.filter((x) => VF.isDC(x.type)).length > sess.length * 0.6 ? 'Mostly DC fast charging: mix in AC charging overnight where possible.' : 'Charging mix between AC and DC is balanced.', v.tempC > 38 ? 'Pack running warm: park in shade and avoid fast charging right after long drives.' : 'Pack temperature is within the normal range.'].map((t) => `<li>${icon('check')}<span>${esc(t)}</span></li>`).join('')}</ul>`)}
    </div>`;
  }
  function vPerformance(v) {
    const rows = vRows(v); const km = sum(rows, (x) => x.km), kwh = sum(rows, (x) => x.kwh), cost = sum(rows, (x) => x.cost), hours = sum(rows, (x) => x.hours);
    return `<div class="dash"><div class="stat-grid span-12">
        ${C.stat({ icon: 'route', label: 'Distance, 30 days', value: fmt.n(km), unit: 'km', hint: `${fmt.n(km / 30)} km per day` })}
        ${C.stat({ icon: 'zap', label: 'Efficiency', value: fmt.n(km ? kwh / km * 100 : 0, 1), unit: 'kWh/100 km', hint: `Rated ${fmt.n(M(v).eff * 100, 1)}`, tone: 'lime' })}
        ${C.stat({ icon: 'coins', label: 'Energy cost per km', value: money(km ? cost / km : 0), hint: `${money(cost, 0)} in 30 days` })}
        ${C.stat({ icon: 'clock', label: 'Utilisation', value: Math.round(hours / (30 * 12) * 100), unit: '%', hint: `${fmt.n(hours)} hours on the road` })}
      </div>
      ${C.card({ cls: 'span-12', title: 'Daily distance and energy', sub: 'Last 30 days' }, '<div class="chart-slot" data-chart="m-v-perf"></div>' + C.legend([['Distance (km)', 'teal'], ['Energy (kWh)', 'mint']]))}
      ${C.card({ cls: 'span-12 flush', title: 'Recent journeys' }, C.table([{ label: 'From', render: (t) => esc(VF.PLACES[t.from].name) }, { label: 'To', render: (t) => esc(VF.PLACES[t.to].name) }, { label: 'Started', render: (t) => VF.fmtDayTime(t.start) }, { label: 'Distance', align: 'r', render: (t) => fmt.km(t.km) }, { label: 'Energy', align: 'r', render: (t) => fmt.kwh(t.kwh) }, { label: 'Driver', render: (t) => esc(dname(t.driverId)) }], F().trips.filter((t) => t.vehicleId === v.id).slice(0, 8), { empty: { icon: 'route', title: 'No journeys recorded yet' } }))}
    </div>`;
  }
  function vMaintenance(v) {
    const left = v.nextServiceKm - v.odo;
    return `<div class="dash">
      ${C.card({ cls: 'span-4', title: 'Next service' }, `<div class="big-metric"><span>${fmt.n(Math.max(0, left))}</span><small>km to go · due at ${fmt.n(v.nextServiceKm)} km</small></div><div class="progress"><i style="width:${Math.min(100, Math.max(0, 100 - left / 150))}%"></i></div><p class="small muted">EVs need less servicing: tyres, brakes, cabin filter and a yearly battery check.</p>`)}
      ${C.card({ cls: 'span-8 flush', title: 'Maintenance history', action: `<button class="btn small primary" data-act="m-add-maint" data-id="${v.id}">${icon('plus')}Add record</button>` }, C.table([{ label: 'Date', render: (r) => VF.fmtDate(r.date) }, { label: 'Work', render: (r) => `<strong>${esc(r.type)}</strong><div class="small muted">${esc(r.notes || '')}</div>` }, { label: 'Odometer', align: 'r', render: (r) => r.odo ? fmt.n(r.odo) + ' km' : '—' }, { label: 'Cost', align: 'r', render: (r) => r.cost == null ? '—' : money(r.cost) }, { label: 'Status', render: (r) => C.badge(r.open ? 'maintenance' : 'completed', r.open ? 'Open' : 'Done') }], v.maintenance, { empty: { icon: 'wrench', title: 'No maintenance recorded' } }))}
    </div>`;
  }
  function vRegistration(v) {
    return `<div class="dash">
      ${C.card({ cls: 'span-8', title: 'Registration details' }, `<form class="form-grid-2" id="m-reg-form" data-id="${v.id}" novalidate>
        ${C.field('Display name', C.input('name', v.name, 'required maxlength="30"'))}
        ${C.field('Number plate', C.input('plate', v.plate, 'required maxlength="14"'))}
        ${C.field('VIN', C.input('vin', v.vin, 'required minlength="11" maxlength="17"'))}
        ${C.field('Model year', C.input('year', v.year, 'type="number" min="2010" max="2030" required'))}
        ${C.field('Home depot', C.select('depot', F().depots.map((d) => [d.id, d.name]), v.depot))}
        ${C.field('Model', `<input class="input" value="${esc(v.model)}" disabled>`, 'Set when the vehicle is added')}
        <div class="form-error" id="m-reg-error" hidden></div>
        <div class="card-actions span-all"><button class="btn primary" type="submit">Save changes</button></div></form>`)}
      ${C.card({ cls: 'span-4 danger-zone', title: 'Remove vehicle' }, `<p class="small muted">Removes ${esc(v.name)} from GreenLine Logistics. Charging stops and its driver is unassigned. Past charging records stay in reports.</p><button class="btn danger" data-act="m-remove-vehicle" data-id="${v.id}">${icon('trash-2')}Remove vehicle</button>`)}
    </div>`;
  }
  function drawVehicle(slot, key) {
    const v = VF.fleetVehicle(ui.vehicle); if (!v) return; const rows = vRows(v); const w = Math.max(260, slot.clientWidth || 600);
    if (key === 'm-v-soh') slot.innerHTML = C.lineChart(rows.map((x) => ({ label: label(x.date), values: { soh: x.soh } })), [{ key: 'soh', label: 'State of health', tone: 'teal', area: true }], w, { min: Math.floor(Math.min(...rows.map((x) => x.soh)) - 1), label: 'Battery state of health', vFmt: (n) => fmt.n(n, 1) + '%', yFmt: (n) => fmt.n(n) + '%' });
    if (key === 'm-v-perf') slot.innerHTML = C.barChart(rows.map((x) => ({ label: label(x.date), values: { km: x.km } })), [{ key: 'km', label: 'Distance', tone: 'teal' }], w, { label: 'Daily distance', vFmt: (n) => fmt.km(n) }) + C.lineChart(rows.map((x) => ({ label: label(x.date), values: { kwh: x.kwh } })), [{ key: 'kwh', label: 'Energy', tone: 'mint', area: true }], w, { h: 150, label: 'Daily energy', vFmt: (n) => fmt.kwh(n) });
  }

  // ---------------------------------------------------------------- Charging Stations
  function stationRows() {
    const ports = fleetPorts(); const from = ui.stFrom;
    const fromNode = from.startsWith('dp') ? VF.depotNode(from) : (() => { const v = VF.fleetVehicle(from); const p = VF.fleetPos(v); return VF.nearestNode(p.lat, p.lon); })();
    return VF.state.stations.map((st) => {
      const comp = st.connectors.filter((c) => ports.includes(c.type));
      const types = ui.stConn === 'all' ? comp : comp.filter((c) => c.type === ui.stConn);
      const speedOk = types.filter((c) => (ui.stSpeed === 'all' ? true : ui.stSpeed === 'ac' ? !VF.isDC(c.type) : ui.stSpeed === 'dc' ? VF.isDC(c.type) && c.kw >= 50 : c.kw >= 100));
      return { st, comp, match: speedOk, free: speedOk.filter((c) => c.status === 'Available'), km: VF.shortestPath(fromNode, st.node).km };
    }).filter((x) => x.match.length && (!ui.stAvail || x.free.length)).sort((a, b) => a.km - b.km);
  }
  function stationCard(x) {
    const st = x.st; const op = VF.operator(st.operatorId); const now = VF.now();
    return `<article class="st-item${ui.stSel === st.id ? ' sel' : ''}">
      <div class="st-item-head"><div><h3>${esc(st.name)}</h3><p class="small muted">${esc(op.name)} · ${esc(VF.PLACES[st.node].name)} · ${fmt.km(x.km)} away</p></div>${x.free.length ? C.badge('available', `${x.free.length} free`) : C.badge('charging', 'All busy')}</div>
      <div class="conn-chips">${st.connectors.map((c) => `<span class="cchip ${c.status === 'Available' ? 'free' : c.status === 'Faulted' || c.status === 'Unavailable' ? 'down' : 'busy'}" title="${esc(c.label)} · ${esc(c.status)}">${esc(c.type)} · ${c.kw} kW</span>`).join('')}</div>
      <div class="st-item-foot"><span class="small muted">${icon('coins')} AC ${money(VF.priceAt(st.operatorId, now, 'Type 2'))} · DC ${money(VF.priceAt(st.operatorId, now, 'CCS2'))} per kWh now</span>
        <div class="row"><a class="btn small" href="https://www.google.com/maps/dir/?api=1&destination=${VF.PLACES[st.node].lat},${VF.PLACES[st.node].lon}" target="_blank" rel="noopener">${icon('navigation')}Directions</a><button class="btn small primary" data-act="m-send-here" data-id="${st.id}">${icon('car-front')}Send a vehicle</button></div></div>
    </article>`;
  }
  function pageStations() {
    const rows = stationRows(); const ports = fleetPorts();
    const fromOpts = F().depots.map((d) => [d.id, d.name]).concat(F().vehicles.filter((v) => v.status !== 'offline').map((v) => [v.id, v.name]));
    return `<div class="toolbar">
        ${C.seg([['list', 'List', 'list'], ['map', 'Map', 'map']], ui.stView, 'm-stview')}
        <label class="inline-field">${icon('plug-zap')}<span class="sr-only">Connector</span>${C.select('stconn', [['all', 'All connectors']].concat(ports.map((p) => [p, p])), ui.stConn, 'data-chg="m-stconn"')}</label>
        ${C.seg([['all', 'Any speed'], ['ac', 'AC'], ['dc', 'DC 50+ kW'], ['ultra', '100+ kW']], ui.stSpeed, 'm-stspeed')}
        <label class="check"><input type="checkbox" id="m-stavail" data-chg="m-stavail" ${ui.stAvail ? 'checked' : ''}>Available now</label>
        <label class="inline-field toolbar-end">${icon('navigation')}<span class="small muted">Distance from</span>${C.select('stfrom', fromOpts, ui.stFrom, 'data-chg="m-stfrom"')}</label>
      </div>
      <p class="small muted">${rows.length} of ${VF.state.stations.length} stations have connectors that fit your fleet (${esc(ports.join(', '))}).</p>
      ${!rows.length ? C.card({}, C.empty({ icon: 'map-pin', title: 'No stations match', text: 'Loosen the filters to see more stations.', action: `<button class="btn" data-act="m-stclear">Reset filters</button>` }))
        : ui.stView === 'list' ? `<div class="st-list">${rows.map(stationCard).join('')}</div>`
          : `<div class="dash">${C.card({ cls: 'span-8', title: 'Map', action: mapLegend() }, `<div class="map-wrap">${VF.mgr.fleetMap('m-st-map', { stationAct: 'm-stsel' })}</div>${VF.mgr.mapNote()}`)}<div class="span-4 stack">${ui.stSel && rows.find((x) => x.st.id === ui.stSel) ? stationCard(rows.find((x) => x.st.id === ui.stSel)) : C.card({}, C.empty({ icon: 'map-pin', title: 'Select a station', text: 'Tap a station on the map to see connectors, prices and availability.' }))}</div></div>`}`;
  }

  // ---------------------------------------------------------------- Charging Sessions
  function pageSessions() {
    const live = VF.fleetLiveSessions(); const since = VF.now() - ui.sessDays * DAY;
    const done = VF.fleetSessions().filter((x) => x.end >= since && (ui.sessVehicle === 'all' || x.vehicleId === ui.sessVehicle));
    const liveSel = live.filter((x) => ui.sessVehicle === 'all' || x.v.id === ui.sessVehicle);
    const hist = VF.fleetMetrics(ui.sessDays);
    const energy = ui.sessVehicle === 'all' ? hist.charged : sum(done, (x) => x.kwh);
    const cost = ui.sessVehicle === 'all' ? hist.cost : sum(done, (x) => x.cost);
    const avgDur = done.length ? sum(done, (x) => x.end - x.start) / done.length / MIN : 0;
    const rows = done.slice(0, 60).map((x) => ({ id: x.id, v: VF.fleetVehicle(x.vehicleId), st: VF.station(x.stationId), start: x.start, end: x.end, kwh: x.kwh, cost: x.cost, status: x.status }));
    return `<div class="toolbar">${C.seg([['active', `Active (${liveSel.length})`], ['completed', 'Completed'], ['all', 'All']], ui.sessTab, 'm-sesstab')}
        <label class="inline-field">${icon('car-front')}<span class="sr-only">Vehicle</span>${C.select('sessv', [['all', 'All vehicles']].concat(F().vehicles.map((v) => [v.id, v.name])), ui.sessVehicle, 'data-chg="m-sessv"')}</label>
        ${C.seg([[7, '7 days'], [30, '30 days']], ui.sessDays, 'm-sessdays')}
        <div class="toolbar-end"><button class="btn primary" data-act="m-start-session">${icon('plug-zap')}Start charging session</button></div></div>
      <section class="stat-grid">${C.stat({ icon: 'battery-charging', label: 'Charging now', value: liveSel.length, hint: `${fmt.kw(sum(liveSel, (x) => x.se.kw))} combined` })}${C.stat({ icon: 'zap', label: 'Energy delivered', value: fmt.n(energy), unit: 'kWh', hint: `${ui.sessDays} days` })}${C.stat({ icon: 'coins', label: 'Charging cost', value: money(cost, 0), hint: `${money(energy ? cost / energy : 0)} per kWh` })}${C.stat({ icon: 'timer', label: 'Average session', value: fmt.dur(avgDur), hint: `${done.length} completed sessions` })}</section>
      ${ui.sessTab !== 'completed' ? (liveSel.length ? `<div class="live-grid">${liveSel.map((x) => `<article class="card live-card">
          <div class="row between"><div><strong>${esc(x.v.name)}</strong><div class="small muted">${esc(x.st.name)} · ${esc(x.c.label)} ${esc(x.c.type)}</div></div>${C.badge('charging', 'In progress')}</div>
          ${C.battery(x.se.soc, { charging: true, live: `s-${x.se.id}-w`, liveText: `s-${x.se.id}-soc` })}
          <div class="kv-inline small"><span><b data-live="s-${x.se.id}-kw">${fmt.kw(x.se.kw)}</b> now</span><span><b data-live="s-${x.se.id}-kwh">${fmt.kwh(x.se.kwh)}</b> added</span><span><b data-live="s-${x.se.id}-dur">${fmt.dur((VF.now() - x.se.start) / MIN)}</b></span><span><b data-live="s-${x.se.id}-cost">${money(x.se.cost)}</b></span></div>
          <div class="row between"><span class="small muted">Target ${x.se.target}%</span><button class="btn small" data-act="m-stop-charge" data-id="${x.v.id}">${icon('pause')}Stop</button></div></article>`).join('')}</div>` : ui.sessTab === 'active' ? C.card({}, C.empty({ icon: 'plug-zap', title: 'No vehicle is charging right now', text: 'Vehicles below 30% charge on their own, or start a session yourself.', action: `<button class="btn primary" data-act="m-start-session">Start charging session</button>` })) : '') : ''}
      ${ui.sessTab !== 'active' ? C.card({ cls: 'flush', title: 'Charging history', sub: `${rows.length} sessions in the last ${ui.sessDays} days`, action: `<button class="btn small" data-act="m-sess-csv">${icon('download')}Export CSV</button>` }, C.table(sessionCols(true), rows, { empty: { icon: 'plug-zap', title: 'No completed sessions in this period' } })) : ''}`;
  }

  // ---------------------------------------------------------------- registration
  const NAV = [
    { id: 'm-dashboard', label: 'Dashboard', icon: 'layout-dashboard', title: 'Dashboard', group: 'Overview' },
    { id: 'm-vehicles', label: 'My Vehicles', icon: 'car-front', title: 'My Vehicles', group: 'Operations' },
    { id: 'm-stations', label: 'Charging Stations', icon: 'map-pin', title: 'Charging Stations', group: 'Operations' },
    { id: 'm-sessions', label: 'Charging Sessions', icon: 'plug-zap', title: 'Charging Sessions', group: 'Operations' },
    { id: 'm-trips', label: 'Trips & Routes', icon: 'route', title: 'Trips & Routes', group: 'Operations' },
    { id: 'm-fleet', label: 'Fleet Management', icon: 'truck', title: 'Fleet Management', group: 'Operations' },
    { id: 'm-energy', label: 'Energy Analytics', icon: 'chart-line', title: 'Energy Analytics', group: 'Insights' },
    { id: 'm-reports', label: 'Reports', icon: 'file-text', title: 'Reports', group: 'Insights' },
    { id: 'm-notifications', label: 'Notifications', icon: 'bell', title: 'Notifications', group: 'Account' },
    { id: 'm-settings', label: 'Settings', icon: 'settings', title: 'Settings', group: 'Account' },
    { id: 'm-vehicle', label: 'Vehicle', icon: 'car-front', title: 'Vehicle', hidden: true, parent: 'm-vehicles' },
  ];
  VF.apps.manager = {
    home: 'm-dashboard',
    product: 'EV Manager',
    roleLabel: () => (VF.state.fleet ? VF.state.fleet.org.name : 'EV Manager'),
    nav: NAV,
    pages: { 'm-dashboard': pageDashboard, 'm-vehicles': pageVehicles, 'm-vehicle': pageVehicle, 'm-stations': pageStations, 'm-sessions': pageSessions },
    charts: { 'm-energy': drawDash, 'm-cost': drawDash, 'm-co2': drawDash, 'm-v-soh': drawVehicle, 'm-v-perf': drawVehicle },
    title(page) { if (page === 'm-vehicle') { const v = VF.fleetVehicle(ui.vehicle); return v ? v.name : 'Vehicle'; } return null; },
    eyebrow(page) { return page === 'm-dashboard' ? (VF.state.fleet ? VF.state.fleet.org.name : '') : null; },
    actions(page) {
      if (page === 'm-vehicles') return `${VF.real.connectButton()}<button class="btn primary" data-act="m-add-vehicle">${icon('plus')}<span class="hide-sm">Add vehicle</span></button>`;
      if (page === 'm-dashboard') return `<button class="btn primary" data-act="m-add-vehicle">${icon('plus')}<span class="hide-sm">Add vehicle</span></button>`;
      if (page === 'm-sessions') return `<button class="btn" data-act="m-sess-csv">${icon('download')}<span class="hide-sm">Export</span></button>`;
      return '';
    },
    badge: (id) => (id === 'm-notifications' ? VF.state.fleet.notices.filter((n) => !n.read).length : 0),
    structKey(page) {
      const f = F(); if (!f) return page;
      let k = page + '|' + f.vehicles.map((v) => v.id + v.status + (v.driverId || '') + (v.trip ? v.trip.purpose : '')).join(',') + '|' + VF.fleetLiveSessions().length + '|' + f.notices.length;
      if (page === 'm-dashboard' || page === 'm-sessions') k += '|' + VF.fleetSessions().length;
      if (page === 'm-stations') k += '|' + VF.state.stations.map((st) => st.connectors.map((c) => c.status[0]).join('')).join('');
      return k + '|' + (VF.mgr.extraKey ? VF.mgr.extraKey(page) : '');
    },
    live(page) {
      const vals = {};
      F().vehicles.forEach((v) => { vehicleLive(vals, v); vals[`v-${v.id}-odo`] = fmt.n(v.odo) + ' km'; vals[`v-${v.id}-temp`] = v.tempC != null ? fmt.n(v.tempC, 1) : '—'; });
      sessionLive(vals);
      if (page === 'm-dashboard') { vals['m-kpis'] = { html: kpis() }; vals['m-donut'] = { html: statusDonut() }; VF.mgr.liveMap('m-dash-map'); }
      if (page === 'm-vehicle') VF.mgr.liveMap('m-veh-map');
      if (page === 'm-stations') VF.mgr.liveMap('m-st-map');
      if (VF.mgr.extraLive) VF.mgr.extraLive(page, vals);
      return vals;
    },
    search(q) {
      q = q.toLowerCase(); const out = [];
      for (const v of F().vehicles) if ((v.name + ' ' + v.model + ' ' + v.plate).toLowerCase().includes(q)) out.push({ icon: 'car-front', label: v.name, sub: `${v.model} · ${v.plate}`, act: 'm-open-vehicle', id: v.id });
      for (const st of VF.state.stations) if (st.name.toLowerCase().includes(q)) out.push({ icon: 'map-pin', label: st.name, sub: VF.operator(st.operatorId).name, act: 'm-stsel-go', id: st.id });
      for (const d of F().drivers) if (d.name.toLowerCase().includes(q)) out.push({ icon: 'user', label: d.name, sub: d.vehicleId ? `Drives ${VF.fleetVehicle(d.vehicleId) ? VF.fleetVehicle(d.vehicleId).name : ''}` : 'No vehicle', href: '#m-fleet' });
      return out;
    },
    notices() { return F().notices.map((n) => ({ id: n.id, title: n.title, body: n.body, t: n.t, sev: n.sev, read: n.read })); },
    markRead(id) { F().notices.forEach((n) => { if (!id || n.id === id) n.read = true; }); VF.save(); },
    allNoticesHref: '#m-notifications',
    settingsHref: '#m-settings',
    leave() {},
  };

  // ---------------------------------------------------------------- actions
  const depots = () => F().depots.map((d) => [d.id, d.name]);
  function openAddVehicle() {
    C.modal({ title: 'Add vehicle', sub: 'Register a company vehicle. Live data starts once its telematics are connected.', submitLabel: 'Add vehicle', body: `<div class="form-grid-2">
      ${C.field('Display name', C.input('name', `Car ${String(F().vehicles.length + 1).padStart(2, '0')}`, 'required maxlength="30"'))}
      ${C.field('Model', C.select('model', Object.keys(VF.MODELS), 'BYD Atto 3'))}
      ${C.field('Number plate', C.input('plate', '', 'required maxlength="14" placeholder="GR 1234-25"'))}
      ${C.field('VIN', C.input('vin', '', 'required maxlength="17" placeholder="17 characters"'), 'Found on the windscreen or registration papers')}
      ${C.field('Model year', C.input('year', 2025, 'type="number" min="2010" max="2030"'))}
      ${C.field('Home depot', C.select('depot', depots(), 'dp1'))}</div>`,
      onSubmit(d) {
        if (!d.name.trim()) return 'Give the vehicle a display name.';
        if (!/^[A-Z]{1,3}\s?\d{1,5}-\d{2}$/i.test(d.plate.trim())) return 'Enter the plate like GR 1234-25.';
        if (!/^[A-HJ-NPR-Z0-9]{11,17}$/i.test(d.vin.trim())) return 'A VIN has 11 to 17 letters and numbers, without I, O or Q.';
        if (F().vehicles.some((v) => v.plate.toUpperCase() === d.plate.trim().toUpperCase())) return 'A vehicle with that plate is already in the fleet.';
        const v = VF.fleet.addVehicle({ name: d.name.trim(), model: d.model, plate: d.plate.trim(), vin: d.vin.trim(), year: d.year, depot: d.depot });
        VF.save(); VF.toast(`${v.name} added to the fleet`); ui.vehicle = v.id; ui.vtab = 'overview'; location.hash = 'm-vehicle'; VF.rerender();
        return null;
      },
    });
  }
  function openStartSession(vehicleId, stationId) {
    const vs = F().vehicles.filter((v) => !v.real && !['maintenance', 'offline', 'charging'].includes(v.status));
    if (!vs.length) { VF.toast('No vehicle can charge right now'); return; }
    const vid = vehicleId || vs.slice().sort((a, b) => a.soc - b.soc)[0].id;
    const opts = VF.fleetChargeOptions(VF.fleetVehicle(vid));
    C.modal({ title: 'Start charging session', sub: 'The vehicle drives to the station and plugs in. A compatible connector is chosen automatically.', submitLabel: 'Send to charge', body: `<div class="form-grid-2">
      ${C.field('Vehicle', C.select('vehicle', vs.map((v) => [v.id, `${v.name} · ${Math.round(v.soc)}%`]), vid, 'data-chg="m-ss-vehicle"'))}
      ${C.field('Station', C.select('station', [['', 'Nearest station with a free connector']].concat(opts.map((o) => [o.st.id, `${o.st.name} · ${fmt.km(o.km)}${o.free ? '' : ' · busy'}`])), stationId || ''))}</div>`,
      onSubmit(d) {
        const st = VF.fleet.sendToCharge(d.vehicle, d.station || null);
        if (!st) return 'This vehicle can’t be sent to charge right now.';
        VF.save(); VF.toast(`${VF.fleetVehicle(d.vehicle).name} is heading to ${st.name}`); VF.rerender(); return null;
      },
    });
  }
  VF.mgr.openStartSession = openStartSession;
  Object.assign(VF.ACT, {
    'm-open-vehicle': (el) => { ui.vehicle = el.dataset.id; ui.vtab = 'overview'; if (VF.route() === 'm-vehicle') VF.rerender(); else location.hash = 'm-vehicle'; },
    'm-add-vehicle': openAddVehicle,
    'm-start-session': () => openStartSession(),
    'm-charge-vehicle': (el) => openStartSession(el.dataset.id),
    'm-send-here': (el) => openStartSession(null, el.dataset.id),
    'm-stop-charge': async (el) => {
      const v = VF.fleetVehicle(el.dataset.id);
      if (!await C.confirm({ title: `Stop charging ${v.name}?`, body: `It stays at ${Math.round(v.soc)}%. You're billed for the energy delivered so far.`, confirmLabel: 'Stop charging', danger: true })) return;
      if (VF.fleet.stopCharging(v.id)) { VF.save(); VF.toast(`Charging stopped for ${v.name}`); VF.rerender(); }
    },
    'm-maint-on': async (el) => {
      const v = VF.fleetVehicle(el.dataset.id);
      if (!await C.confirm({ title: `Send ${v.name} to the workshop?`, body: 'It is taken off jobs and any charging stops until you return it to service.', confirmLabel: 'Send to workshop' })) return;
      VF.fleet.setMaintenance(v.id, true, 'Workshop visit'); VF.save(); VF.toast(`${v.name} is in maintenance`); VF.rerender();
    },
    'm-maint-off': (el) => { VF.fleet.setMaintenance(el.dataset.id, false); VF.save(); VF.toast('Back in service'); VF.rerender(); },
    'm-remove-vehicle': async (el) => {
      const v = VF.fleetVehicle(el.dataset.id);
      if (!await C.confirm({ title: `Remove ${v.name}?`, body: 'This can’t be undone. Charging stops, the driver is unassigned and the vehicle disappears from dashboards. Past records stay in reports.', confirmLabel: 'Remove vehicle', danger: true })) return;
      VF.fleet.removeVehicle(v.id); VF.save(); VF.toast(`${v.name} removed`); location.hash = 'm-vehicles';
    },
    'm-add-maint': (el) => {
      const v = VF.fleetVehicle(el.dataset.id);
      C.modal({ title: 'Add maintenance record', sub: `${v.name} · ${fmt.n(v.odo)} km`, submitLabel: 'Add record', body: `<div class="form-grid-2">${C.field('Work done', C.input('type', '', 'required maxlength="60" placeholder="e.g. Tyre rotation"'))}${C.field(`Cost (${VF.state.settings.currency})`, C.input('cost', '', 'type="number" min="0" step="0.01"'))}</div>${C.field('Notes', '<textarea class="input" name="notes" rows="3" maxlength="200"></textarea>')}`,
        onSubmit(d) { if (!d.type.trim()) return 'Describe the work done.'; VF.fleet.addMaintenance(v.id, d); VF.save(); VF.toast('Record added'); VF.rerender(); return null; } });
    },
    'm-vtab': (el) => { ui.vtab = el.dataset.k; VF.rerender(); },
    'm-vfilter': (el) => { ui.vfilter = el.dataset.k; VF.rerender(); },
    'm-vview': (el) => { ui.vview = el.dataset.k; VF.rerender(); },
    'm-vclear': () => { ui.vfilter = 'all'; ui.vq = ''; VF.rerender(); },
    'm-dash-days': (el) => { ui.dashDays = +el.dataset.k; VF.rerender(); },
    'm-stview': (el) => { ui.stView = el.dataset.k; VF.rerender(); },
    'm-stspeed': (el) => { ui.stSpeed = el.dataset.k; VF.rerender(); },
    'm-stclear': () => { ui.stConn = 'all'; ui.stSpeed = 'all'; ui.stAvail = false; VF.rerender(); },
    'm-stsel': (el) => { ui.stSel = el.dataset.id; VF.rerender(); },
    'm-stsel-go': (el) => { ui.stSel = el.dataset.id; ui.stView = 'map'; ui.stAvail = false; ui.stConn = 'all'; ui.stSpeed = 'all'; if (VF.route() === 'm-stations') VF.rerender(); else location.hash = 'm-stations'; },
    'm-sesstab': (el) => { ui.sessTab = el.dataset.k; VF.rerender(); },
    'm-sessdays': (el) => { ui.sessDays = +el.dataset.k; VF.rerender(); },
    'm-sess-csv': () => {
      const rows = VF.fleetSessions().filter((x) => x.end >= VF.now() - ui.sessDays * DAY);
      const csv = VF.csv([['vehicle', 'model', 'station', 'operator', 'connector', 'start', 'end', 'minutes', 'kwh', 'cost_' + VF.state.settings.currency.toLowerCase(), 'status']].concat(rows.map((x) => { const v = VF.fleetVehicle(x.vehicleId); const st = VF.station(x.stationId); return [v ? v.name : x.vehicleId, x.model, st.name, VF.operator(st.operatorId).name, x.type, new Date(x.start).toISOString(), new Date(x.end).toISOString(), Math.round((x.end - x.start) / MIN), x.kwh.toFixed(2), x.cost.toFixed(2), x.status]; })));
      VF.downloadText(`greenline-charging-sessions-${ui.sessDays}d.csv`, csv);
    },
  });
  Object.assign(VF.CHG, {
    'm-assign': (el) => { VF.fleet.assign(el.dataset.id, el.value || null); VF.save(); VF.toast(el.value ? `${VF.fleetDriver(el.value).name} assigned` : 'Driver unassigned'); VF.rerender(); },
    'm-stconn': (el) => { ui.stConn = el.value; VF.rerender(); },
    'm-stavail': (el) => { ui.stAvail = el.checked; VF.rerender(); },
    'm-stfrom': (el) => { ui.stFrom = el.value; VF.rerender(); },
    'm-sessv': (el) => { ui.sessVehicle = el.value; VF.rerender(); },
    'm-ss-vehicle': (el) => { const form = el.form; const st = form.station; const opts = VF.fleetChargeOptions(VF.fleetVehicle(el.value)); st.innerHTML = [['', 'Nearest station with a free connector']].concat(opts.map((o) => [o.st.id, `${o.st.name} · ${fmt.km(o.km)}${o.free ? '' : ' · busy'}`])).map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join(''); },
  });
  Object.assign(VF.INP, { 'm-vq': (el) => { ui.vq = el.value; VF.rerender(); } });
  document.addEventListener('submit', (e) => {
    if (e.target.getAttribute('id') !== 'm-reg-form') return;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target).entries()); const box = document.getElementById('m-reg-error');
    const err = !d.name.trim() ? 'Give the vehicle a display name.' : !/^[A-Z]{1,3}\s?\d{1,5}-\d{2}$/i.test(d.plate.trim()) ? 'Enter the plate like GR 1234-25.' : !/^[A-HJ-NPR-Z0-9]{11,17}$/i.test(d.vin.trim()) ? 'A VIN has 11 to 17 letters and numbers, without I, O or Q.' : '';
    if (err) { box.hidden = false; box.innerHTML = `${icon('triangle-alert')}<span>${esc(err)}</span>`; return; }
    VF.fleet.updateVehicle(e.target.dataset.id, { name: d.name.trim(), plate: d.plate.trim(), vin: d.vin.trim(), year: d.year, depot: d.depot });
    VF.save(); VF.toast('Vehicle details saved'); VF.rerender();
  });
})();
