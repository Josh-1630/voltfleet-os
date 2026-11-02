/* VoltFleet OS — EV Manager (part 2): Trips & Routes, Fleet Management, Energy Analytics, Reports,
   Notifications and Settings. Registers its pages on VF.apps.manager, which manager.js created. */
'use strict';
(function () {
  const { esc, sum, fmt, icon } = VF;
  const C = VF.c;
  const MIN = VF.MIN, HOUR = VF.HOUR, DAY = VF.DAY;
  const app = VF.apps.manager;
  const ui = Object.assign(VF.mgr.ui, { tVeh: null, tFrom: null, tStops: [], tRet: true, tReserve: 15, enDays: 30, repDays: 30, nFilter: 'all', setTab: 'profile', drvQ: '' });
  const F = () => VF.state.fleet;
  const M = (v) => VF.MODELS[v.model];
  const me = () => VF.user(VF.session.userId);
  const { dname, money } = VF.mgr;
  const place = (n) => (VF.PLACES[n] ? VF.PLACES[n].name : n);
  const placeOpts = () => Object.entries(VF.PLACES).map(([id, p]) => [id, p.name]).sort((a, b) => a[1].localeCompare(b[1]));
  const label = (ms) => VF.fmtDate(ms);
  const canDrive = (v) => v && !v.real && !['maintenance', 'offline'].includes(v.status); // live vehicles can't be dispatched by the simulation

  // ================================================================ Trips & Routes
  function vehicleNode(v) { const p = VF.fleetPos(v); return VF.nearestNode(p.lat, p.lon); }
  function tripDefaults() {
    let v = VF.fleetVehicle(ui.tVeh);
    if (!canDrive(v)) { v = F().vehicles.filter(canDrive).sort((a, b) => (b.status === 'available') - (a.status === 'available') || b.soc - a.soc)[0]; ui.tVeh = v ? v.id : null; ui.tFrom = null; }
    if (v && !ui.tFrom) ui.tFrom = vehicleNode(v);
    if (v && !ui.tStops.length) ui.tStops = [ui.tFrom === 'tema' ? 'kasoa' : 'tema'];
    return v;
  }
  function currentPlan() {
    const v = tripDefaults(); if (!v) return null;
    const stops = ui.tStops.filter((s) => s && s !== ui.tFrom);
    if (!stops.length) return null;
    return VF.planJourney(v.id, ui.tFrom, stops, ui.tRet, ui.tReserve);
  }
  function planRoute(plan) {
    const out = [];
    for (const l of plan.legs) for (const n of l.path) { const p = VF.PLACES[n]; const last = out[out.length - 1]; if (!last || last[0] !== p.lat || last[1] !== p.lon) out.push([p.lat, p.lon]); }
    return out;
  }
  function tripMap(plan) {
    const route = plan ? planRoute(plan) : [];
    const v = plan ? plan.v : null; const p = v ? VF.fleetPos(v) : null;
    const vb = route.length ? VF.fitBox(route.concat(p ? [[p.lat, p.lon]] : []), 70, VF.MAP.W / VF.MAP.H) : undefined;
    const stopId = plan && plan.stop ? plan.stop.st.id : null;
    const ports = v ? M(v).ports : [];
    return VF.mapSVG({
      id: 'm-trip-map', vb, route, label: 'Planned route',
      stations: VF.state.stations.map((st) => ({ st, cls: st.id === stopId ? 'avail sel' : st.connectors.some((c) => ports.includes(c.type)) ? 'dim' : 'off', label: st.id === stopId ? 'Charge here' : st.name.split(' ').slice(0, 2).join(' '), title: st.name })),
      vehicles: v ? [{ id: v.id, lat: p.lat, lon: p.lon, cls: v.status, label: v.name, title: `${v.name} · ${Math.round(v.soc)}%` }] : [],
    });
  }
  function planSummary(plan) {
    if (!plan) return C.empty({ icon: 'route', title: 'Add a destination', text: 'Pick at least one stop that is different from the start.' });
    const m = plan.m; const total = plan.minutes + (plan.stop ? plan.stop.minutes : 0);
    const arrive = plan.stop ? Math.max(ui.tReserve, plan.arriveSoc + plan.stop.target - plan.v.soc) : plan.arriveSoc;
    return `<div class="plan-stats">
        <div><span class="stat-label">Distance</span><strong class="num">${fmt.km(plan.km)}</strong></div>
        <div><span class="stat-label">Driving time</span><strong class="num">${fmt.dur(plan.minutes)}</strong></div>
        <div><span class="stat-label">Energy needed</span><strong class="num">${fmt.kwh(plan.kwh)}</strong></div>
        <div><span class="stat-label">Battery on return</span><strong class="num ${arrive < ui.tReserve ? 'text-bad' : arrive < 30 ? 'text-warn' : 'text-ok'}">${Math.max(0, Math.round(arrive))}%</strong></div>
      </div>
      ${plan.ok ? C.banner('ok', 'circle-check', `<strong>No charging stop needed.</strong> ${esc(plan.v.name)} leaves with ${Math.round(plan.v.soc)}% and keeps at least ${ui.tReserve}% the whole way.`)
        : plan.stop ? C.banner('warn', 'battery-charging', `<strong>One charging stop needed.</strong> Charge at <strong>${esc(plan.stop.st.name)}</strong> to ${plan.stop.target}% first (about ${fmt.dur(plan.stop.minutes)} at up to ${fmt.kw(plan.stop.kw)}, ${fmt.km(plan.stop.detour)} detour). Total time about ${fmt.dur(total)}.`)
          : C.banner('bad', 'triangle-alert', `<strong>Not enough charge.</strong> No compatible station was found on the way. Charge ${esc(plan.v.name)} first or choose a shorter route.`)}
      <ol class="legs">${plan.legs.map((l, i) => `<li class="${plan.failAt === i ? 'fail' : ''}"><span class="leg-dot"></span><div><strong>${esc(place(l.from))} → ${esc(place(l.to))}</strong><span class="small muted">${fmt.km(l.km)} · ${fmt.kwh(l.kwh)} · battery ${Math.max(0, Math.round(l.soc))}% after</span></div></li>`).join('')}</ol>
      <p class="small muted">Estimates use ${esc(plan.v.model)} consumption of ${fmt.n(m.eff * 108, 1)} kWh/100 km in city traffic at ${'28'} km/h average, plus 10 minutes per stop.</p>`;
  }
  function activeJourneys() {
    return F().vehicles.filter((v) => v.status === 'in_use' && v.trip && !v.trip.done);
  }
  function journeyLive(vals) {
    for (const v of activeJourneys()) {
      const pct = v.trip.totalKm ? v.trip.doneKm / v.trip.totalKm * 100 : 0;
      vals[`tr-${v.id}-w`] = { w: pct }; vals[`tr-${v.id}-txt`] = `${fmt.km(v.trip.doneKm)} of ${fmt.km(v.trip.totalKm)} · ${fmt.dur((v.trip.totalKm - v.trip.doneKm) / 28 * 60)} left`;
    }
  }
  const PURPOSE = { delivery: ['teal', 'Delivery'], dispatch: ['mint', 'Planned journey'], charge: ['warn', 'To charger'], return: ['muted', 'Return to depot'] };
  const purposeBadge = (p) => { const [t, l] = PURPOSE[p] || ['muted', p]; return `<span class="badge ${t}">${l}</span>`; };
  function pageTrips() {
    const v = tripDefaults();
    if (!v) return C.card({}, C.empty({ icon: 'route', title: 'No vehicle can take a journey', text: 'Every vehicle is offline or in maintenance.', action: '<a class="btn" href="#m-vehicles">Go to My Vehicles</a>' }));
    const plan = currentPlan(); const act = activeJourneys(); const plans = F().plans.slice(0, 5);
    const stops = ui.tStops.map((s, i) => `<div class="stop-row"><span class="stop-n">${i + 1}</span>${C.select('stop' + i, placeOpts(), s, `data-chg="m-tr-stop" data-i="${i}" aria-label="Stop ${i + 1}"`)}${ui.tStops.length > 1 ? `<button type="button" class="icon-btn" data-act="m-tr-del" data-i="${i}" aria-label="Remove stop ${i + 1}" data-tip="Remove stop">${icon('x')}</button>` : ''}</div>`).join('');
    return `<div class="dash">
      ${C.card({ cls: 'span-5', title: 'Plan a journey', sub: 'Route, energy and charging stops for a fleet vehicle' }, `<div class="planner">
        ${C.field('Vehicle', C.select('tveh', F().vehicles.filter(canDrive).map((x) => [x.id, `${x.name} · ${x.model} · ${Math.round(x.soc)}%`]), v.id, 'data-chg="m-tr-veh"'))}
        ${C.field('Start', C.select('tfrom', placeOpts(), ui.tFrom, 'data-chg="m-tr-from"'), `${v.name} is near ${place(vehicleNode(v))}`)}
        <div class="field"><span>Stops</span>${stops}${ui.tStops.length < 5 ? `<button type="button" class="btn small ghost" data-act="m-tr-add">${icon('plus')}Add stop</button>` : ''}</div>
        <div class="form-grid-2">
          <label class="check"><input type="checkbox" data-chg="m-tr-ret" ${ui.tRet ? 'checked' : ''}>Return to start</label>
          ${C.field('Keep at least', C.select('tres', [[10, '10% battery'], [15, '15% battery'], [20, '20% battery'], [25, '25% battery']], ui.tReserve, 'data-chg="m-tr-res"'))}
        </div>
      </div>`)}
      ${C.card({ cls: 'span-7', title: 'Route', sub: plan ? `${esc(place(ui.tFrom))} → ${plan.pts.slice(1).map((p) => esc(place(p))).join(' → ')}` : 'Choose stops to see the route' }, `<div class="map-wrap">${tripMap(plan)}</div>${VF.mgr.mapNote()}`)}
      ${C.card({ cls: 'span-12', title: 'Journey estimate', action: plan && (plan.ok || plan.stop) ? `<button class="btn primary" data-act="m-tr-dispatch">${icon('send')}Dispatch to ${esc(v.name)}</button>` : '' }, planSummary(plan))}
      ${C.card({ cls: 'span-6', title: 'On the road now', sub: `${act.length} vehicle${act.length === 1 ? '' : 's'} driving` }, act.length ? `<ul class="journeys">${act.slice(0, 6).map((x) => `<li data-act="m-open-vehicle" data-id="${x.id}" role="button" tabindex="0"><div class="row between"><strong>${esc(x.name)}</strong>${purposeBadge(x.trip.purpose)}</div><span class="small muted">${esc(place(x.trip.origin))} → ${esc(place(x.trip.dest))} · ${esc(dname(x.driverId))}</span><div class="progress"><i data-live="tr-${x.id}-w" style="width:${(x.trip.doneKm / Math.max(0.01, x.trip.totalKm) * 100).toFixed(1)}%"></i></div><span class="small muted" data-live="tr-${x.id}-txt"></span></li>`).join('')}</ul>${act.length > 6 ? `<a class="btn small ghost" href="#m-vehicles" data-act="m-vfilter-go" data-k="in_use">See all ${act.length} on the road ${icon('arrow-right')}</a>` : ''}` : C.empty({ icon: 'car-front', title: 'No vehicle is driving', text: 'Dispatched journeys show here with live progress.' }))}
      ${C.card({ cls: 'span-6 flush', title: 'Dispatched journeys' }, C.table([
        { label: 'Vehicle', render: (p) => { const x = VF.fleetVehicle(p.vehicleId); return `<strong>${esc(x ? x.name : 'Removed')}</strong><div class="small muted">${esc(dname(p.driverId))}</div>`; } },
        { label: 'Route', render: (p) => esc(p.pts.map(place).join(' → ')) },
        { label: 'Distance', align: 'r', render: (p) => fmt.km(p.km) },
        { label: 'Status', render: (p) => C.badge(p.status === 'completed' ? 'completed' : 'active', p.status === 'completed' ? 'Completed' : p.stop ? 'Charging first' : 'In progress') },
      ], plans, { empty: { icon: 'send', title: 'Nothing dispatched yet', text: 'Plan a journey above and dispatch it to a vehicle.' } }))}
      ${C.card({ cls: 'span-12 flush', title: 'Journey history', sub: 'Completed trips from the last 10 days', action: `<button class="btn small" data-act="m-rep-dl" data-k="trips">${icon('download')}Export CSV</button>` }, C.table([
        { label: 'Date', render: (t) => `<span class="num">${VF.fmtDayTime(t.start)}</span>` },
        { label: 'Vehicle', render: (t) => { const x = VF.fleetVehicle(t.vehicleId); return esc(x ? x.name : '—'); } },
        { label: 'Driver', render: (t) => esc(dname(t.driverId)) },
        { label: 'Route', render: (t) => `${esc(place(t.from))} → ${esc(place(t.to))}` },
        { label: 'Distance', align: 'r', render: (t) => fmt.km(t.km) },
        { label: 'Duration', align: 'r', render: (t) => fmt.dur((t.end - t.start) / MIN) },
        { label: 'Energy', align: 'r', render: (t) => fmt.kwh(t.kwh) },
        { label: 'Type', render: (t) => purposeBadge(t.purpose) },
      ], F().trips.slice(0, 25), { empty: { icon: 'route', title: 'No journeys yet' } }))}
    </div>`;
  }

  // ================================================================ Fleet Management
  function vehicleStats(v, days) {
    const rows = VF.fleetHistory().filter((x) => x.vid === v.id && x.d >= 30 - days);
    const km = sum(rows, (x) => x.km), kwh = sum(rows, (x) => x.kwh), cost = sum(rows, (x) => x.cost), hours = sum(rows, (x) => x.hours);
    return { km, kwh, cost, hours, util: Math.min(100, hours / (days * 12) * 100), per100: km ? kwh / km * 100 : 0, perKm: km ? cost / km : 0, sessions: sum(rows, (x) => x.sessions), down: rows.filter((x) => x.down).length };
  }
  function pageFleet() {
    const f = F(); const vs = f.vehicles; const ds = f.drivers;
    const assigned = vs.filter((v) => v.driverId).length; const m = VF.fleetMetrics(30);
    const q = ui.drvQ.trim().toLowerCase();
    const drivers = ds.filter((d) => !q || (d.name + d.license).toLowerCase().includes(q));
    const tenDays = VF.now() - 10 * DAY;
    const dTrips = (d) => f.trips.filter((t) => t.driverId === d.id && t.start >= tenDays);
    const util = VF.mgr.utilisation();
    const perf = vs.filter((v) => !v.real).map((v) => ({ id: v.id, v, s: vehicleStats(v, 30) })).sort((a, b) => b.s.km - a.s.km);
    return `<section class="stat-grid">
        ${C.stat({ icon: 'car-front', label: 'Vehicles', value: vs.length, hint: `${vs.filter((v) => v.status === 'available').length} ready now` })}
        ${C.stat({ icon: 'users', label: 'Drivers', value: ds.length, hint: `${ds.filter((d) => !d.vehicleId).length} without a vehicle` })}
        ${C.stat({ icon: 'link', label: 'Vehicles assigned', value: assigned, unit: `/ ${vs.length}`, hint: vs.length - assigned ? `${vs.length - assigned} unassigned` : 'All assigned', tone: vs.length - assigned > 2 ? 'warn' : '' })}
        ${C.stat({ icon: 'clock', label: 'Fleet utilisation', value: Math.round(m.utilisation), unit: '%', hint: 'of 12-hour working days, 30 days', tip: 'Hours on the road divided by available working hours' })}
      </section>
      <div class="dash">
        ${C.card({ cls: 'span-12', title: 'Depots' }, `<div class="depot-grid">${f.depots.map((d) => { const dv = vs.filter((v) => v.depot === d.id); const c = (s) => dv.filter((v) => v.status === s).length; return `<div class="depot"><div class="row">${icon('warehouse')}<strong>${esc(d.name)}</strong></div><span class="small muted">${esc(place(d.node))} · ${dv.length} vehicles</span><div class="depot-counts"><span>${C.badge('in_use')}<b class="num">${c('in_use')}</b></span><span>${C.badge('charging')}<b class="num">${c('charging') + c('waiting')}</b></span><span>${C.badge('available')}<b class="num">${c('available')}</b></span><span>${C.badge('maintenance')}<b class="num">${c('maintenance') + c('offline')}</b></span></div></div>`; }).join('')}</div>`)}
        ${C.card({ cls: 'span-7 flush', title: 'Vehicle allocation', sub: 'Assign a driver to each vehicle' }, C.table([
          { label: 'Vehicle', render: (v) => `<button class="link-btn" data-act="m-open-vehicle" data-id="${v.id}"><strong>${esc(v.name)}</strong></button><div class="small muted">${esc(v.model)}</div>` },
          { label: 'Status', render: (v) => C.badge(v.status) },
          { label: 'Battery', render: (v) => C.battery(v.soc, { charging: v.status === 'charging', live: `v-${v.id}-w`, liveText: `v-${v.id}-soc`, size: 'sm' }) },
          { label: 'Driver', render: (v) => C.select('as-' + v.id, [['', 'Unassigned']].concat(ds.map((d) => [d.id, d.name + (d.vehicleId && d.vehicleId !== v.id ? ' · has a vehicle' : '')])), v.driverId || '', `data-chg="m-assign" data-id="${v.id}" aria-label="Driver for ${esc(v.name)}"`) },
        ], vs.filter((v) => !v.real), { empty: { icon: 'car-front', title: 'No vehicles yet', action: '<button class="btn primary" data-act="m-add-vehicle">Add vehicle</button>' } }))}
        ${C.card({ cls: 'span-5', title: 'Utilisation by vehicle', sub: 'Share of working hours in use, 30 days' }, C.hbars(util.slice(0, 10), { tone: 'mint' }) + (util.length > 10 ? `<p class="small muted">Lowest: ${util.slice(-3).map((u) => `${esc(u.label)} ${u.text}`).join(', ')}. Consider moving under-used vehicles to the busier depot.</p>` : ''))}
        ${C.card({ cls: 'span-12 flush', title: 'Drivers', sub: 'Employee drivers. Contact details are masked; they are kept only for dispatch.', action: `<div class="row"><div class="search-field sm">${icon('search')}<input class="input" type="search" data-inp="m-drvq" id="m-drvq" placeholder="Search drivers" value="${esc(ui.drvQ)}" aria-label="Search drivers"></div><button class="btn small primary" data-act="m-add-driver">${icon('user-plus')}Add driver</button></div>` }, C.table([
          { label: 'Driver', render: (d) => `<div class="cell-person"><span class="avatar sm">${esc(d.name.split(' ').map((p) => p[0]).join('').slice(0, 2))}</span><div><strong>${esc(d.name)}</strong><div class="small muted mono">${esc(d.license)}</div></div></div>` },
          { label: 'Phone', render: (d) => `<span class="num">${esc(VF.mask.phone(d.phone))}</span>` },
          { label: 'Vehicle', render: (d) => { const v = d.vehicleId && VF.fleetVehicle(d.vehicleId); return v ? `${esc(v.name)} ${C.badge(v.status)}` : '<span class="muted">None</span>'; } },
          { label: 'Trips (10 days)', align: 'r', render: (d) => dTrips(d).length },
          { label: 'Distance', align: 'r', render: (d) => fmt.km(sum(dTrips(d), (t) => t.km)) },
          { label: 'Driving score', render: (d) => `<div class="score"><div class="progress sm"><i class="${d.score >= 85 ? 'ok' : d.score >= 75 ? '' : 'warn'}" style="width:${d.score}%"></i></div><span class="num">${d.score}</span></div>` },
          { label: '', align: 'r', render: (d) => `<button class="icon-btn" data-act="m-del-driver" data-id="${d.id}" aria-label="Remove ${esc(d.name)}" data-tip="Remove driver">${icon('trash-2')}</button>` },
        ], drivers, { empty: { icon: 'users', title: q ? 'No drivers match' : 'No drivers yet', text: q ? 'Try another name or licence number.' : 'Add your drivers to assign them to vehicles.' } }))}
        ${C.card({ cls: 'span-12 flush', title: 'Vehicle performance', sub: 'Last 30 days', action: `<button class="btn small" data-act="m-rep-dl" data-k="fleet">${icon('download')}Export CSV</button>` }, C.table([
          { label: 'Vehicle', render: (r) => `<strong>${esc(r.v.name)}</strong><div class="small muted">${esc(r.v.model)}</div>` },
          { label: 'Distance', align: 'r', render: (r) => fmt.km(r.s.km) },
          { label: 'Utilisation', align: 'r', render: (r) => Math.round(r.s.util) + '%' },
          { label: 'kWh/100 km', align: 'r', render: (r) => `<span class="${r.s.per100 > M(r.v).eff * 115 ? 'text-warn' : ''}">${fmt.n(r.s.per100, 1)}</span>` },
          { label: 'Cost per km', align: 'r', render: (r) => money(r.s.perKm) },
          { label: 'Charging sessions', align: 'r', render: (r) => r.s.sessions },
          { label: 'Days off road', align: 'r', render: (r) => r.s.down },
          { label: 'Battery health', align: 'r', render: (r) => `<span class="${r.v.soh < 90 ? 'text-warn' : ''}">${r.v.soh}%</span>` },
        ], perf, { rowAct: 'm-open-vehicle' }))}
      </div>`;
  }

  // ================================================================ Energy Analytics
  function bandOf(h) { const bands = VF.operator('op1').pricing.bands; for (let i = 0; i < bands.length; i++) { const a = +bands[i].from, b = +bands[i].to; if (a <= b ? h >= a && h < b : h >= a || h < b) return i; } return 1; }
  function chargePatterns(days) {
    const rows = VF.fleetHistory().filter((x) => x.d >= 30 - days && x.chargeHour != null && x.sessions);
    const hours = Array.from({ length: 24 }, () => 0); const kwhBand = [0, 0, 0]; const nBand = [0, 0, 0];
    for (const r of rows) { hours[r.chargeHour] += r.sessions; const b = bandOf(r.chargeHour); kwhBand[b] += r.charged; nBand[b] += r.sessions; }
    return { hours, kwhBand, nBand };
  }
  function pageEnergy() {
    const d = ui.enDays; const m = VF.fleetMetrics(d); const pat = chargePatterns(d);
    const bands = VF.operator('op1').pricing.bands;
    const peakKwh = pat.kwhBand[2]; const save = peakKwh * (+bands[2].price - +bands[0].price);
    const eff = VF.simVehicles().map((v) => { const s = vehicleStats(v, d); return { label: v.name, value: s.per100, text: fmt.n(s.per100, 1), tone: s.per100 > M(v).eff * 115 ? 'warn' : 'teal' }; }).filter((x) => x.value > 0).sort((a, b) => a.value - b.value);
    const byModel = {}; for (const v of VF.simVehicles()) { const k = v.model; byModel[k] = byModel[k] || { n: 0, soh: 0 }; byModel[k].n++; byModel[k].soh += v.soh; }
    const litres = m.km * 0.11;
    return `<div class="toolbar">${C.seg([[7, 'Last 7 days'], [30, 'Last 30 days']], d, 'm-en-days')}<span class="small muted">${icon('info')} Sample history until vehicles are connected through VoltFleet Connect.</span></div>
      <section class="stat-grid">
        ${C.stat({ icon: 'zap', label: 'Energy consumed', value: fmt.n(m.kwh), unit: 'kWh', hint: `${fmt.n(m.km)} km driven` })}
        ${C.stat({ icon: 'battery-charging', label: 'Energy charged', value: fmt.n(m.charged), unit: 'kWh', hint: `${Math.round(m.kwh / Math.max(1, m.charged) * 100)}% charging efficiency`, tip: 'Energy that reached the battery compared with energy bought' })}
        ${C.stat({ icon: 'coins', label: 'Electricity cost', value: money(m.cost, 0), hint: `${money(m.costPerKwh)} per kWh · ${money(m.km ? m.cost / m.km : 0)} per km` })}
        ${C.stat({ icon: 'gauge', label: 'Fleet efficiency', value: fmt.n(m.per100, 1), unit: 'kWh/100 km', hint: 'Lower is better', tone: 'lime' })}
      </section>
      <div class="dash">
        ${C.card({ cls: 'span-8', title: 'Energy consumption', sub: 'Consumed by driving vs. bought at chargers, completed days' }, '<div class="chart-slot" data-chart="m-en-cons"></div>' + C.legend([['Consumed', 'teal'], ['Charged', 'mint']]))}
        ${C.card({ cls: 'span-4', title: 'Electricity cost by tariff', sub: 'Where the fleet charges in the day' }, C.donut([{ label: `Off-peak (${bands[0].from}:00–${bands[0].to}:00)`, value: pat.nBand[0], tone: 'mint' }, { label: `Standard (${bands[1].from}:00–${bands[1].to}:00)`, value: pat.nBand[1], tone: 'teal' }, { label: `Peak (${bands[2].from}:00–${bands[2].to}:00)`, value: pat.nBand[2], tone: 'warn' }], { caption: 'sessions', label: 'Sessions by tariff band' }) + (save > 1 ? C.banner('lime', 'lightbulb', `Moving peak-time charging to off-peak could save about <strong>${money(save, 0)}</strong> in ${d} days.`) : ''))}
        ${C.card({ cls: 'span-8', title: 'Charging patterns', sub: 'Sessions started per hour of day' }, '<div class="chart-slot" data-chart="m-en-hours"></div>' + C.legend([['Off-peak', 'mint'], ['Standard', 'teal'], ['Peak', 'warn']]))}
        ${C.card({ cls: 'span-4', title: 'Efficiency by vehicle', sub: 'kWh per 100 km, best first' }, eff.length ? C.hbars(eff.slice(0, 8)) + '<p class="small muted">Amber bars use 15% more than the model’s rating: check tyre pressure, loads and driving style.</p>' : C.empty({ icon: 'gauge', title: 'No driving recorded' }))}
        ${C.card({ cls: 'span-6', title: 'Charging costs', sub: `${esc(VF.state.settings.currency)} per day` }, '<div class="chart-slot" data-chart="m-en-cost"></div>')}
        ${C.card({ cls: 'span-6', title: 'Battery performance', sub: 'Average state of health by model' }, C.hbars(Object.entries(byModel).map(([k, x]) => ({ label: k, value: x.soh / x.n, text: fmt.n(x.soh / x.n, 1) + '%', tone: x.soh / x.n < 90 ? 'warn' : 'teal' })).sort((a, b) => a.value - b.value)) + '<div class="chart-slot" data-chart="m-en-soh"></div>')}
        ${C.card({ cls: 'span-12 lime-card', title: 'Sustainability', sub: 'Compared with diesel vehicles doing the same work' }, `<div class="sustain">
          <div class="sustain-figs">
            <div><span class="stat-label">CO₂ avoided</span><strong class="lime-text num">${fmt.n(m.co2, 2)} t</strong></div>
            <div><span class="stat-label">Diesel not burned</span><strong class="num">${fmt.n(litres)} L</strong></div>
            <div><span class="stat-label">Trees, one year</span><strong class="num">${fmt.n(m.co2 * 1000 / 21)}</strong></div>
            <div><span class="stat-label">Fuel cost avoided</span><strong class="num">${money(litres * 15.5 - m.cost, 0)}</strong></div>
          </div><div class="chart-slot" data-chart="m-en-co2"></div></div>
          <p class="small muted">Assumes ${VF.CO2.DIESEL_KG_PER_KM} kg CO₂/km for an equivalent diesel vehicle, ${VF.CO2.GRID_KG_PER_KWH} kg CO₂/kWh for Ghana’s grid, 11 L/100 km and ${money(15.5)} per litre of diesel. Replace these with audited factors before publishing figures.</p>`)}
      </div>`;
  }
  function drawEnergy(slot, key) {
    const w = Math.max(260, slot.clientWidth || 600); const m0 = VF.fleetMetrics(ui.enDays);
    const m = { daily: m0.daily.filter((x) => x.d < 29) }; // completed days only; today is still in progress
    if (key === 'm-en-cons') slot.innerHTML = C.lineChart(m.daily.map((x) => ({ label: label(x.date), values: { kwh: x.kwh, charged: x.charged } })), [{ key: 'kwh', label: 'Consumed', tone: 'teal', area: true }, { key: 'charged', label: 'Charged', tone: 'mint', dash: true }], w, { label: 'Energy consumption', vFmt: (v) => fmt.kwh(v) });
    if (key === 'm-en-cost') slot.innerHTML = C.barChart(m.daily.map((x) => ({ label: label(x.date), values: { cost: x.cost } })), [{ key: 'cost', label: 'Cost', tone: 'teal' }], w, { h: 200, label: 'Charging costs', vFmt: (v) => money(v, 0) });
    if (key === 'm-en-soh') slot.innerHTML = C.lineChart(m.daily.map((x) => ({ label: label(x.date), values: { soh: x.soh } })), [{ key: 'soh', label: 'Average health', tone: 'teal' }], w, { h: 140, min: Math.floor(Math.min(...m.daily.map((x) => x.soh)) - 1), label: 'Average state of health', vFmt: (v) => fmt.n(v, 2) + '%', yFmt: (v) => fmt.n(v) + '%' });
    if (key === 'm-en-hours') { const p = chargePatterns(ui.enDays); slot.innerHTML = C.barChart(p.hours.map((n, h) => { const b = bandOf(h); return { label: String(h).padStart(2, '0'), values: { off: b === 0 ? n : 0, std: b === 1 ? n : 0, peak: b === 2 ? n : 0 } }; }), [{ key: 'off', label: 'Off-peak', tone: 'mint' }, { key: 'std', label: 'Standard', tone: 'teal' }, { key: 'peak', label: 'Peak', tone: 'warn' }], w, { label: 'Charging sessions by hour', vFmt: (v) => fmt.n(v) + ' sessions' }); }
    if (key === 'm-en-co2') { let acc = 0; slot.innerHTML = C.lineChart(m.daily.map((x) => { acc += (x.km * VF.CO2.DIESEL_KG_PER_KM - x.kwh * VF.CO2.GRID_KG_PER_KWH) / 1000; return { label: label(x.date), values: { co2: acc } }; }), [{ key: 'co2', label: 'CO₂ avoided (t)', tone: 'lime', area: true }], w, { h: 170, label: 'Cumulative CO₂ avoided', vFmt: (v) => fmt.n(v, 2) + ' t', yFmt: (v) => fmt.n(v, 1) }); }
  }

  // ================================================================ Reports
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const cur = () => VF.state.settings.currency.toLowerCase();
  const REPORTS = {
    fleet: { title: 'Fleet performance', icon: 'truck', desc: 'Distance, utilisation, efficiency, cost per km and downtime for each vehicle.',
      build(days) {
        const rows = VF.simVehicles().map((v) => { const s = vehicleStats(v, days); return [v.name, v.model, v.plate, Math.round(s.km), Math.round(s.util), s.per100.toFixed(1), s.perKm.toFixed(2), s.sessions, s.down, v.soh]; });
        return { head: ['vehicle', 'model', 'plate', 'km', 'utilisation_pct', 'kwh_per_100km', 'cost_per_km_' + cur(), 'charging_sessions', 'days_off_road', 'battery_health_pct'], rows,
          summary: [['Vehicles', F().vehicles.length], ['Distance', fmt.km(sum(rows, (r) => r[3]))], ['Average utilisation', Math.round(sum(rows, (r) => r[4]) / Math.max(1, rows.length)) + '%']] };
      } },
    energy: { title: 'Energy consumption', icon: 'zap', desc: 'Daily distance, energy consumed and charged, and fleet efficiency.',
      build(days) {
        const m = VF.fleetMetrics(days);
        return { head: ['date', 'km', 'kwh_consumed', 'kwh_charged', 'kwh_per_100km', 'vehicles_active'], rows: m.daily.map((x) => [iso(x.date), Math.round(x.km), x.kwh.toFixed(1), x.charged.toFixed(1), x.km ? (x.kwh / x.km * 100).toFixed(1) : '0', x.active]),
          summary: [['Consumed', fmt.kwh(m.kwh)], ['Charged', fmt.kwh(m.charged)], ['Efficiency', fmt.n(m.per100, 1) + ' kWh/100 km']] };
      } },
    charging: { title: 'Charging expenditure', icon: 'coins', desc: 'Charging sessions, energy bought and cost per vehicle per day.',
      build(days) {
        const rows = VF.fleetHistory().filter((x) => x.d >= 30 - days && x.sessions).map((x) => { const v = VF.fleetVehicle(x.vid); return [iso(x.date), v ? v.name : x.vid, x.sessions, x.charged.toFixed(1), x.cost.toFixed(2), x.charged ? (x.cost / x.charged).toFixed(2) : '0']; });
        const total = sum(rows, (r) => +r[4]);
        return { head: ['date', 'vehicle', 'sessions', 'kwh_charged', 'cost_' + cur(), 'cost_per_kwh'], rows, summary: [['Sessions', sum(rows, (r) => r[2])], ['Total cost', money(total, 0)], ['Per kWh', money(total / Math.max(1, sum(rows, (r) => +r[3])))]] };
      } },
    sustainability: { title: 'Sustainability', icon: 'leaf', tone: 'lime', desc: 'CO₂ avoided compared with diesel vehicles, with the factors used.',
      build(days) {
        const m = VF.fleetMetrics(days);
        const rows = m.daily.map((x) => { const base = x.km * VF.CO2.DIESEL_KG_PER_KM, grid = x.kwh * VF.CO2.GRID_KG_PER_KWH; return [iso(x.date), Math.round(x.km), (x.km * 0.11).toFixed(1), base.toFixed(1), grid.toFixed(1), (base - grid).toFixed(1)]; });
        return { head: ['date', 'km', 'diesel_litres_avoided', 'diesel_baseline_kg_co2', 'grid_kg_co2', 'net_kg_co2_avoided'], rows, summary: [['CO₂ avoided', fmt.n(m.co2, 2) + ' t'], ['Diesel avoided', fmt.n(m.km * 0.11) + ' L'], ['Factors', `${VF.CO2.DIESEL_KG_PER_KM} kg/km · ${VF.CO2.GRID_KG_PER_KWH} kg/kWh`]] };
      } },
    maintenance: { title: 'Maintenance', icon: 'wrench', desc: 'Every maintenance record with cost, odometer and status.',
      build(days) {
        const since = VF.now() - Math.max(days, 365) * DAY;
        const rows = F().vehicles.flatMap((v) => v.maintenance.filter((x) => x.date >= since).map((x) => [iso(x.date), v.name, x.type, x.odo || '', x.cost == null ? '' : (+x.cost).toFixed(2), x.open ? 'open' : 'done'])).sort((a, b) => (a[0] < b[0] ? 1 : -1));
        return { head: ['date', 'vehicle', 'work', 'odometer_km', 'cost_' + cur(), 'status'], rows, summary: [['Records (12 months)', rows.length], ['Spend', money(sum(rows, (r) => +r[4] || 0), 0)], ['Open', rows.filter((r) => r[5] === 'open').length]] };
      } },
    trips: { title: 'Journeys', icon: 'route', desc: 'Every recorded journey with driver, distance and energy.', hidden: true,
      build() {
        const rows = F().trips.map((t) => { const v = VF.fleetVehicle(t.vehicleId); return [new Date(t.start).toISOString(), v ? v.name : t.vehicleId, dname(t.driverId), place(t.from), place(t.to), t.km.toFixed(1), t.kwh.toFixed(1), Math.round((t.end - t.start) / MIN), t.purpose]; });
        return { head: ['start', 'vehicle', 'driver', 'from', 'to', 'km', 'kwh', 'minutes', 'type'], rows, summary: [] };
      } },
  };
  function download(key) {
    const r = REPORTS[key]; const days = ui.repDays; const out = r.build(days);
    VF.downloadText(`greenline-${key}-${key === 'trips' ? 'history' : days + 'd'}-${iso(VF.now())}.csv`, VF.csv([out.head].concat(out.rows)));
  }
  function pageReports() {
    const d = ui.repDays;
    return `<div class="toolbar">${C.seg([[7, 'Last 7 days'], [30, 'Last 30 days']], d, 'm-rep-days')}<span class="small muted">Reports download as CSV and open in Excel, Google Sheets or Numbers.</span></div>
      <div class="report-grid">${Object.entries(REPORTS).filter(([, r]) => !r.hidden).map(([k, r]) => { const out = r.build(d); return `<article class="card report ${r.tone || ''}">
        <div class="report-head"><span class="report-ic ${r.tone || ''}">${icon(r.icon)}</span><div><h3>${esc(r.title)}</h3><p class="small muted">${esc(r.desc)}</p></div></div>
        <dl class="report-sum">${out.summary.map(([l, v]) => `<div><dt>${esc(l)}</dt><dd class="num">${esc(String(v))}</dd></div>`).join('')}</dl>
        <div class="report-foot"><span class="small muted">${out.rows.length} rows · ${k === 'maintenance' ? 'last 12 months' : `last ${d} days`}</span><div class="row"><button class="btn small ghost" data-act="m-rep-view" data-k="${k}">${icon('eye')}Preview</button><button class="btn small primary" data-act="m-rep-dl" data-k="${k}">${icon('download')}Download CSV</button></div></div>
      </article>`; }).join('')}</div>
      ${C.banner('teal', 'shield-check', 'Reports contain fleet and vehicle data only. Driver names appear in the journey export; share it only with people who manage those drivers.')}`;
  }
  function previewReport(key) {
    const r = REPORTS[key]; const out = r.build(ui.repDays);
    C.modal({ title: r.title, sub: `${out.rows.length} rows. Showing the first 10.`, submitLabel: 'Download CSV',
      body: out.rows.length ? `<div class="table-wrap preview"><table class="t"><thead><tr>${out.head.map((h) => `<th>${esc(h.replace(/_/g, ' '))}</th>`).join('')}</tr></thead><tbody>${out.rows.slice(0, 10).map((row) => `<tr>${row.map((c) => `<td class="num">${esc(String(c))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : C.empty({ icon: 'file-text', title: 'No data in this period' }),
      onSubmit() { download(key); return null; } });
  }

  // ================================================================ Notifications
  const SEV = { critical: ['bad', 'battery-warning'], warning: ['warn', 'triangle-alert'], info: ['teal', 'info'] };
  function pageNotifications() {
    const all = F().notices; const unread = all.filter((n) => !n.read).length;
    const list = all.filter((n) => ui.nFilter === 'all' || (ui.nFilter === 'unread' ? !n.read : n.sev === ui.nFilter));
    const cnt = (k) => (k === 'all' ? all.length : k === 'unread' ? unread : all.filter((n) => n.sev === k).length);
    const prefs = F().prefs;
    const toggle = (k, l, sub) => `<label class="switch-row"><div><strong>${l}</strong><span class="small muted">${sub}</span></div><input type="checkbox" class="switch" data-chg="m-pref" data-k="${k}" ${prefs[k] ? 'checked' : ''}></label>`;
    return `<div class="dash">
      <div class="span-8 stack">
        <div class="toolbar"><div class="seg" role="group" aria-label="Filter">${[['all', 'All'], ['unread', 'Unread'], ['critical', 'Critical'], ['warning', 'Warnings'], ['info', 'Info']].map(([k, l]) => `<button type="button" data-act="m-n-filter" data-k="${k}" aria-pressed="${ui.nFilter === k}">${l}<span class="n">${cnt(k)}</span></button>`).join('')}</div>
          <div class="toolbar-end row"><button class="btn small" data-act="m-n-readall" ${unread ? '' : 'disabled'}>${icon('check-check')}Mark all read</button><button class="btn small ghost" data-act="m-n-clear" ${all.some((n) => n.read) ? '' : 'disabled'}>${icon('trash-2')}Clear read</button></div></div>
        ${C.card({ cls: 'flush' }, list.length ? `<ul class="notice-list">${list.map((n) => { const [tone, ic] = SEV[n.sev] || SEV.info; return `<li class="${n.read ? '' : 'unread'}">
            <span class="att-ic ${tone}">${icon(ic)}</span>
            <div class="notice-body"><div class="row between"><strong>${esc(n.title)}</strong><span class="small faint num">${VF.relTime(n.t)}</span></div><p class="small muted">${esc(n.body)}</p>
              <div class="row">${n.vehicleId && VF.fleetVehicle(n.vehicleId) ? `<button class="btn small ghost" data-act="m-open-vehicle" data-id="${n.vehicleId}">${icon('car-front')}Open ${esc(VF.fleetVehicle(n.vehicleId).name)}</button>` : ''}${n.read ? '' : `<button class="btn small ghost" data-act="m-n-read" data-id="${n.id}">${icon('check')}Mark read</button>`}<button class="btn small ghost" data-act="m-n-del" data-id="${n.id}" aria-label="Delete notification">${icon('trash-2')}Delete</button></div></div></li>`; }).join('')}</ul>`
          : C.empty({ icon: 'bell-off', title: ui.nFilter === 'all' ? 'No notifications' : 'Nothing in this filter', text: 'Low battery, charging and maintenance alerts appear here.' }))}
      </div>
      <div class="span-4 stack">
        ${C.card({ title: 'Alert preferences', sub: 'Choose what creates a notification' }, `<div class="switch-list">
          ${toggle('lowBattery', 'Low battery', 'A vehicle drops below 15% while driving')}
          ${toggle('chargeDone', 'Charging complete', 'A session finishes or is stopped')}
          ${toggle('maintenance', 'Maintenance', 'Service due and workshop updates')}
          ${toggle('offline', 'Vehicle offline', 'Telematics stop reporting')}
          ${toggle('email', 'Email digest', 'A daily summary to ' + esc(me().email))}</div>
          ${prefs.email ? C.banner('warn', 'mail', 'Email delivery needs an email provider. Add one in Settings → Integrations.') : ''}`)}
      </div></div>`;
  }

  // ================================================================ Settings
  const STABS = [['profile', 'Profile', 'user'], ['appearance', 'Appearance', 'palette'], ['organisation', 'Organisation', 'building-2'], ['integrations', 'Integrations', 'plug'], ['privacy', 'Data & privacy', 'shield-check']];
  function pageSettings() {
    const t = ui.setTab; const u = me(); const f = F();
    let body = '';
    if (t === 'profile') body = C.card({ title: 'Your profile', sub: 'How you appear to your team' }, `<form id="m-profile-form" class="form-grid-2" novalidate>
        ${C.field('Full name', C.input('name', u.name, 'required maxlength="60" autocomplete="name"'))}
        ${C.field('Work email', C.input('email', u.email, 'type="email" required maxlength="80" autocomplete="email"'))}
        ${C.field('Phone', C.input('phone', u.phone || '', 'maxlength="20" autocomplete="tel"'))}
        ${C.field('Role', '<input class="input" value="Fleet manager" disabled>', 'Set by your organisation')}
        <div class="form-error" id="m-profile-error" hidden></div>
        <div class="card-actions span-all"><button class="btn primary" type="submit">Save profile</button></div></form>`);
    else if (t === 'appearance') {
      const th = VF.theme.get();
      body = C.card({ title: 'Theme', sub: 'Light is the default. Your choice is kept on this device.' }, `<div class="theme-pick">${[['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']].map(([k, l, ic]) => `<button type="button" class="theme-opt ${k}" data-act="m-theme" data-k="${k}" aria-pressed="${th === k}"><span class="theme-preview"><i></i><i></i><i></i></span><span class="row">${icon(ic)}${l}</span></button>`).join('')}</div>`)
        + C.card({ title: 'Units and currency' }, `<dl class="dl"><dt>Distance</dt><dd>Kilometres</dd><dt>Energy</dt><dd>Kilowatt-hours (kWh)</dd><dt>Currency</dt><dd>${esc(VF.state.settings.currency)} · set by the platform for Ghana</dd><dt>Time zone</dt><dd>Africa/Accra (GMT)</dd></dl>`);
    } else if (t === 'organisation') body = C.card({ title: 'Organisation' }, `<form id="m-org-form" class="form-grid-2" novalidate>${C.field('Company name', C.input('org', f.org.name, 'required maxlength="60"'))}<div class="form-error" id="m-org-error" hidden></div><div class="card-actions span-all"><button class="btn primary" type="submit">Save</button></div></form>`)
      + C.card({ cls: 'flush', title: 'Depots', sub: 'Where vehicles return to at night', action: `<button class="btn small primary" data-act="m-add-depot">${icon('plus')}Add depot</button>` }, C.table([
        { label: 'Depot', render: (d) => `<strong>${esc(d.name)}</strong>` }, { label: 'Area', render: (d) => esc(place(d.node)) },
        { label: 'Vehicles', align: 'r', render: (d) => f.vehicles.filter((v) => v.depot === d.id).length },
        { label: '', align: 'r', render: (d) => `<button class="icon-btn" data-act="m-del-depot" data-id="${d.id}" aria-label="Remove ${esc(d.name)}" data-tip="Remove depot">${icon('trash-2')}</button>` },
      ], f.depots));
    else if (t === 'integrations') {
      const mp = VF.maps; const mapsOn = mp && mp.enabled();
      const row = (ic, title, status, tone, text, extra) => `<div class="integration"><span class="int-ic">${icon(ic)}</span><div class="int-main"><div class="row between"><strong>${title}</strong><span class="badge ${tone}">${status}</span></div><p class="small muted">${text}</p>${extra || ''}</div></div>`;
      body = C.card({ title: 'Integrations', sub: 'Connections that replace sample data with live data' }, `<div class="int-list">
        ${row('map', 'Map provider', mapsOn ? `Connected · ${esc(mp.providerName())}` : mp && mp.failed ? 'Tiles unavailable' : 'Not configured', mapsOn ? 'ok' : mp && mp.failed ? 'warn' : 'muted', mapsOn ? `Street maps from ${esc(mp.providerName())} (OpenStreetMap data), drawn with Leaflet. ${mp.routing() ? 'Journey lines follow real roads through OSRM; the public demo server is for testing, so run your own for production.' : 'Journey lines are straight segments between places.'} Change the provider in <code>js/config.js</code> (<code>window.VOLTFLEET_MAPS</code>): CARTO and OpenStreetMap need no key; MapTiler and Mapbox need a public key restricted to your domain.` : mp && mp.failed ? 'Map tiles could not be reached from this device, so the schematic map is shown. Check the connection or the provider settings in <code>js/config.js</code>.' : 'Maps show a schematic of Greater Accra. Set <code>window.VOLTFLEET_MAPS.provider</code> in <code>js/config.js</code> to <code>carto</code>, <code>osm</code>, <code>maptiler</code> or <code>mapbox</code>. Use only browser keys restricted to your domain.')}
        ${(() => { const R = VF.real; const live = R.vehicles.length; const st = R.connected() ? [`${live} live`, 'ok'] : R.ready() ? (R.server === false ? ['Server needs secrets', 'warn'] : ['Ready to connect', 'teal']) : ['Not configured', 'muted'];
          return row('radio-tower', 'Vehicle telematics · Smartcar', st[0], st[1], `${R.connected() ? `${live} vehicle${live === 1 ? '' : 's'} stream battery, range, charging, odometer and location through Smartcar API v3 (${esc(R.modeLabel())}), shown on this device only.` : 'Connect real vehicles from 40+ brands through the owner’s carmaker account. The Smartcar secret stays in a Supabase Edge Function; this app only holds a public client ID.'} The other ${VF.simVehicles().length} vehicles are sample data.`,
            `<div class="card-actions">${R.connectButton(R.connected() ? '' : 'primary')}<button class="btn ghost" data-act="sc-setup">${icon('list')}Setup steps</button>${R.connected() ? `<button class="btn ghost" data-act="sc-disconnect">${icon('unplug')}Disconnect</button>` : ''}</div>`); })()}
        ${row('plug-zap', 'Charging network', 'Connected', 'ok', `${VF.state.stations.length} stations from ${VF.state.operators.length} operators over OCPP. Sessions started here appear in the operators’ consoles.`)}
        ${row('cloud', 'Cross-device sync', esc(VF.cloud ? VF.cloud.label() : 'This device only'), VF.cloud && /live/.test(VF.cloud.status) ? 'ok' : 'muted', 'The demo world is shared through Supabase so changes show on every device. Settings live in <code>js/config.js</code> (publishable key only).')}
        ${row('mail', 'Email notifications', 'Not configured', 'muted', 'Add an email provider (for example a transactional email service) on the server side. API keys must stay on the server, never in this web app.')}
      </div>`);
    } else body = C.card({ title: 'What EV Manager stores' }, `<ul class="tips">
        <li>${icon('check')}<span>Vehicle data (battery, odometer, location) for company vehicles only, used to dispatch and charge them.</span></li>
        <li>${icon('check')}<span>Driver names, licence numbers and work phones for dispatch. Phones are masked on screen.</span></li>
        <li>${icon('check')}<span>Charging sessions are shared with the station’s operator under the company name, never a driver’s name.</span></li>
        <li>${icon('check')}<span>Tell drivers how vehicle location is used and keep it to working hours, in line with Ghana’s Data Protection Act 2012 (Act 843).</span></li></ul>`)
      + C.card({ title: 'Export' }, `<p class="small muted">Download all fleet data held for ${esc(f.org.name)} as JSON.</p><button class="btn" data-act="m-export">${icon('download')}Export fleet data</button>`)
      + C.card({ cls: 'danger-zone', title: 'Reset sample data' }, `<p class="small muted">Replaces the fleet with fresh sample vehicles, drivers and history. This changes the shared demo for everyone.</p><button class="btn danger" data-act="m-reset-fleet">${icon('rotate-ccw')}Reset fleet data</button>`);
    return `<div class="settings">
      <nav class="side-tabs" aria-label="Settings sections">${STABS.map(([k, l, ic]) => `<button data-act="m-settab" data-k="${k}" aria-current="${t === k ? 'page' : 'false'}">${icon(ic)}<span>${l}</span></button>`).join('')}</nav>
      <div class="stack">${body}</div></div>`;
  }

  // ================================================================ registration
  Object.assign(app.pages, { 'm-trips': pageTrips, 'm-fleet': pageFleet, 'm-energy': pageEnergy, 'm-reports': pageReports, 'm-notifications': pageNotifications, 'm-settings': pageSettings });
  Object.assign(app.charts, { 'm-en-cons': drawEnergy, 'm-en-cost': drawEnergy, 'm-en-soh': drawEnergy, 'm-en-hours': drawEnergy, 'm-en-co2': drawEnergy });
  const baseActions = app.actions;
  app.actions = (page) => {
    if (page === 'm-fleet') return `<button class="btn primary" data-act="m-add-driver">${icon('user-plus')}<span class="hide-sm">Add driver</span></button>`;
    if (page === 'm-notifications') return '';
    return baseActions(page);
  };
  VF.mgr.extraKey = (page) => {
    const f = F();
    if (page === 'm-trips') return f.plans.map((p) => p.status).join() + f.trips.length;
    if (page === 'm-fleet') return f.drivers.map((d) => d.id + (d.vehicleId || '')).join() + f.depots.length;
    if (page === 'm-notifications') return f.notices.map((n) => n.read ? 1 : 0).join('');
    if (page === 'm-settings') return (VF.cloud ? VF.cloud.status : '') + f.depots.length + f.org.name;
    if (page === 'm-reports' || page === 'm-energy') return Math.floor(VF.now() / DAY);
    return '';
  };
  VF.mgr.extraLive = (page, vals) => {
    if (page === 'm-trips') { journeyLive(vals); VF.mgr.liveMap('m-trip-map'); }
  };

  const reroute = (fn) => (el) => { fn(el); VF.rerender(); };
  Object.assign(VF.ACT, {
    'm-vfilter-go': (el) => { ui.vfilter = el.dataset.k; ui.vq = ''; location.hash = 'm-vehicles'; },
    'm-plan-for': (el) => { ui.tVeh = el.dataset.id; ui.tFrom = null; ui.tStops = []; if (VF.route() === 'm-trips') VF.rerender(); else location.hash = 'm-trips'; },
    'm-tr-add': reroute(() => { const used = new Set([ui.tFrom].concat(ui.tStops)); ui.tStops.push(Object.keys(VF.PLACES).find((n) => !used.has(n)) || 'tema'); }),
    'm-tr-del': reroute((el) => { ui.tStops.splice(+el.dataset.i, 1); }),
    'm-tr-dispatch': async () => {
      const plan = currentPlan(); if (!plan) return;
      const v = plan.v; const busy = v.status === 'in_use' && v.trip && v.trip.purpose === 'delivery';
      const ok = await C.confirm({ title: `Dispatch ${v.name}?`, icon: 'send', confirmLabel: 'Dispatch',
        body: `${plan.pts.map(place).join(' → ')} · ${fmt.km(plan.km)}.${plan.stop ? ` It charges at ${plan.stop.st.name} first.` : ''}${busy ? ' Its current delivery is cancelled.' : ''}${v.status === 'charging' ? ' Its charging session stops now.' : ''}${v.driverId ? ` ${dname(v.driverId)} is notified.` : ' No driver is assigned.'}` });
      if (!ok) return;
      VF.fleet.dispatch({ vehicleId: v.id, pts: plan.pts, km: plan.km, kwh: plan.kwh, minutes: plan.minutes, stop: plan.stop });
      VF.fleetNotice('info', `${v.name} dispatched`, `${plan.pts.map(place).join(' → ')} · ${fmt.km(plan.km)}${plan.stop ? `, charging at ${plan.stop.st.name} first` : ''}.`, v.id);
      VF.save(); VF.toast(`${v.name} dispatched`); VF.rerender();
    },
    'm-add-driver': () => C.modal({ title: 'Add driver', sub: 'Drivers are employees who can be assigned a vehicle.', submitLabel: 'Add driver', body: `<div class="form-grid-2">
        ${C.field('Full name', C.input('name', '', 'required maxlength="60" autocomplete="off"'))}
        ${C.field('Work phone', C.input('phone', '+233 ', 'required maxlength="18"'), 'Ghana number, e.g. +233 24 123 4567')}
        ${C.field('Driving licence', C.input('license', '', 'required maxlength="14" placeholder="DVLA-123456"'))}
        ${C.field('Assign vehicle', C.select('vehicle', [['', 'Not now']].concat(F().vehicles.filter((v) => !v.driverId).map((v) => [v.id, v.name])), ''))}</div>`,
      onSubmit(d) {
        if (d.name.trim().length < 3) return 'Enter the driver’s full name.';
        if (!/^\+233\s?\d{2}\s?\d{3}\s?\d{4}$/.test(d.phone.trim())) return 'Enter a Ghana number like +233 24 123 4567.';
        if (!/^DVLA-\d{6}$/i.test(d.license.trim())) return 'Enter the licence number like DVLA-123456.';
        const dr = VF.fleet.addDriver({ name: d.name.trim(), phone: d.phone.trim(), license: d.license.trim() });
        if (d.vehicle) VF.fleet.assign(d.vehicle, dr.id);
        VF.save(); VF.toast(`${dr.name} added`); VF.rerender(); return null;
      } }),
    'm-del-driver': async (el) => {
      const d = VF.fleetDriver(el.dataset.id); if (!d) return;
      const v = d.vehicleId && VF.fleetVehicle(d.vehicleId);
      if (!await C.confirm({ title: `Remove ${d.name}?`, body: `${v ? `${v.name} becomes unassigned. ` : ''}Their journeys stay in reports under their name until you delete those records.`, confirmLabel: 'Remove driver', danger: true })) return;
      VF.fleet.removeDriver(d.id); VF.save(); VF.toast(`${d.name} removed`); VF.rerender();
    },
    'm-en-days': reroute((el) => { ui.enDays = +el.dataset.k; }),
    'm-rep-days': reroute((el) => { ui.repDays = +el.dataset.k; }),
    'm-rep-dl': (el) => download(el.dataset.k),
    'm-rep-view': (el) => previewReport(el.dataset.k),
    'm-n-filter': reroute((el) => { ui.nFilter = el.dataset.k; }),
    'm-n-read': (el) => { app.markRead(el.dataset.id); VF.rerender(); },
    'm-n-readall': () => { app.markRead(null); VF.toast('All notifications marked as read'); VF.rerender(); },
    'm-n-del': async (el) => {
      if (!await C.confirm({ title: 'Delete this notification?', confirmLabel: 'Delete', danger: true, icon: 'trash-2' })) return;
      F().notices = F().notices.filter((n) => n.id !== el.dataset.id); VF.save(); VF.rerender();
    },
    'm-n-clear': async () => {
      const n = F().notices.filter((x) => x.read).length;
      if (!await C.confirm({ title: `Delete ${n} read notification${n === 1 ? '' : 's'}?`, body: 'Unread notifications are kept.', confirmLabel: 'Delete', danger: true, icon: 'trash-2' })) return;
      F().notices = F().notices.filter((x) => !x.read); VF.save(); VF.toast('Read notifications cleared'); VF.rerender();
    },
    'm-settab': reroute((el) => { ui.setTab = el.dataset.k; if (el.dataset.k === 'integrations' && VF.real.server == null) VF.real.checkServer().then(() => VF.rerender()); }),
    'm-theme': reroute((el) => { VF.theme.set(el.dataset.k); }),
    'm-add-depot': () => C.modal({ title: 'Add depot', submitLabel: 'Add depot', body: `<div class="form-grid-2">${C.field('Depot name', C.input('name', '', 'required maxlength="40"'))}${C.field('Area', C.select('node', placeOpts(), 'tema'))}</div>`,
      onSubmit(d) { if (d.name.trim().length < 3) return 'Give the depot a name.'; F().depots.push({ id: 'dp' + (F().seq++) + Math.floor(Math.random() * 90 + 10), name: d.name.trim(), node: d.node }); VF.save(); VF.toast('Depot added'); VF.rerender(); return null; } }),
    'm-del-depot': async (el) => {
      const d = F().depots.find((x) => x.id === el.dataset.id); if (!d) return;
      const n = F().vehicles.filter((v) => v.depot === d.id).length;
      if (n) { await C.confirm({ title: `${d.name} still has ${n} vehicle${n === 1 ? '' : 's'}`, body: 'Move them to another depot from each vehicle’s Registration tab first.', confirmLabel: 'OK', cancelLabel: 'Close', icon: 'info' }); return; }
      if (F().depots.length < 2) { VF.toast('Keep at least one depot'); return; }
      if (!await C.confirm({ title: `Remove ${d.name}?`, confirmLabel: 'Remove depot', danger: true })) return;
      F().depots = F().depots.filter((x) => x.id !== d.id); VF.save(); VF.toast('Depot removed'); VF.rerender();
    },
    'm-export': () => { VF.downloadText(`greenline-fleet-${iso(VF.now())}.json`, JSON.stringify({ exported: new Date().toISOString(), org: F().org, depots: F().depots, vehicles: F().vehicles.map(({ trip, ...v }) => v), drivers: F().drivers, trips: F().trips, notices: F().notices }, null, 2), 'application/json'); },
    'm-reset-fleet': async () => {
      if (!await C.confirm({ title: 'Reset fleet data?', body: 'All vehicles, drivers, journeys and notifications are replaced with fresh sample data for everyone using the demo. Charging sessions in progress are stopped.', confirmLabel: 'Reset fleet data', danger: true })) return;
      for (const x of VF.fleetLiveSessions()) VF.fleet.stopCharging(x.v.id);
      VF.state.fleet = null; VF.seedFleet(); Object.assign(ui, { tVeh: null, tFrom: null, tStops: [], vehicle: null }); VF.save(); VF.toast('Fleet data reset'); VF.rerender();
    },
  });
  Object.assign(VF.CHG, {
    'm-tr-veh': reroute((el) => { ui.tVeh = el.value; ui.tFrom = null; }),
    'm-tr-from': reroute((el) => { ui.tFrom = el.value; }),
    'm-tr-stop': reroute((el) => { ui.tStops[+el.dataset.i] = el.value; }),
    'm-tr-ret': reroute((el) => { ui.tRet = el.checked; }),
    'm-tr-res': reroute((el) => { ui.tReserve = +el.value; }),
    'm-pref': (el) => { F().prefs[el.dataset.k] = el.checked; VF.save(); VF.toast(`${el.checked ? 'On' : 'Off'}: ${el.closest('.switch-row').querySelector('strong').textContent}`); if (el.dataset.k === 'email') VF.rerender(); },
  });
  Object.assign(VF.INP, { 'm-drvq': (el) => { ui.drvQ = el.value; VF.rerender(); } });
  document.addEventListener('submit', (e) => {
    const id = e.target.id; if (id !== 'm-profile-form' && id !== 'm-org-form') return;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target).entries());
    const box = document.getElementById(id === 'm-profile-form' ? 'm-profile-error' : 'm-org-error');
    let err = '';
    if (id === 'm-profile-form') err = d.name.trim().length < 3 ? 'Enter your full name.' : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim()) ? 'Enter a valid email address.' : d.phone && !/^\+?[\d\s]{7,20}$/.test(d.phone.trim()) ? 'Enter a valid phone number.' : '';
    else err = d.org.trim().length < 2 ? 'Enter the company name.' : '';
    if (err) { box.hidden = false; box.innerHTML = `${icon('triangle-alert')}<span>${esc(err)}</span>`; return; }
    if (id === 'm-profile-form') Object.assign(me(), { name: d.name.trim(), email: d.email.trim(), phone: d.phone.trim() });
    else F().org.name = d.org.trim();
    VF.save(); VF.toast('Saved'); VF.rerender();
  });
})();