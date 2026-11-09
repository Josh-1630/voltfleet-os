/* VoltFleet OS — driver app (responsive dashboard; bottom tabs on phones).
   A driver only ever sees their own vehicle, trips, bookings and data. */
'use strict';
(function () {
  const { esc, clamp, sum, fmt, icon, pill } = VF;
  const MIN = VF.MIN;
  const ui = VF.ui.driver = { auto: null, sheet: null, confirmDelete: false, dest: '' };

  function ctx() {
    const u = VF.user(VF.session.userId); const d = VF.driver(u.driverId); const v = VF.driverVehicle(d.id);
    return { u, d, v, m: VF.model(v) };
  }
  const shortName = (n) => n.split(' ').slice(0, 2).join(' ').replace(/&$/, '');
  const perKm = (m) => m.eff * 1.05;
  const oemOf = (m) => VF.OEMS.find((o) => o.id === m.oem) || VF.OEMS[VF.OEMS.length - 1];
  const has = (m, field) => oemOf(m).cov[VF.TELEMETRY_FIELDS.findIndex((f) => f[0] === field)] > 0;

  function tripInfo(v, m) {
    if (!v.trip || v.trip.done) return null;
    const now = VF.now();
    const b = v.trip.bookingId && VF.booking(v.trip.bookingId);
    const live = b && ['confirmed', 'charging'].includes(b.status);
    const left = Math.max(0, v.trip.totalKm - v.trip.doneKm);
    const toStop = v.trip.stopKm != null ? Math.max(0, v.trip.stopKm - v.trip.doneKm) : null;
    let arriveSoc, chargeMin = 0;
    if (live && toStop != null) { arriveSoc = b.targetSoc - (left - toStop) * perKm(m) / m.kwh * 100; chargeMin = (b.end - b.start) / MIN; }
    else if (live && b.status === 'charging') { arriveSoc = b.targetSoc - left * perKm(m) / m.kwh * 100; chargeMin = Math.max(0, (b.targetSoc - v.soc) / 100 * m.kwh / 40 * 60); }
    else arriveSoc = v.soc - left * perKm(m) / m.kwh * 100;
    const drivingMin = left / v.speedKmh * 60;
    return { left, toStop, arriveSoc, eta: now + (drivingMin + chargeMin) * MIN, dest: VF.PLACES[v.trip.dest].name, origin: VF.PLACES[v.trip.origin] ? VF.PLACES[v.trip.origin].name : 'Start', b: live ? b : null, progress: v.trip.totalKm ? v.trip.doneKm / v.trip.totalKm : 0 };
  }
  const driveMinutesLeft = (v) => VF.rangeKm(v) / v.speedKmh * 60;
  function stationState(st, m, bookedId) {
    if (st.id === bookedId) return 'booked';
    const comp = st.connectors.filter((c) => VF.compatible(m, c.type));
    if (!comp.length) return 'incompat';
    const now = VF.now();
    if (comp.some((c) => c.status === 'Available' && (!VF.nextBooking(c) || VF.nextBooking(c).start - now > 45 * MIN))) return 'avail';
    if (comp.some((c) => c.status !== 'Faulted' && c.status !== 'Unavailable')) return 'busy';
    return 'off';
  }
  const STATE_LABEL = { avail: 'Free now', busy: 'Busy now', incompat: 'Not compatible', off: 'Out of service', booked: 'Your booking' };
  function donePts(trip) {
    const out = [trip.pts[0]]; let d = trip.doneKm;
    for (let i = 0; i < trip.segKm.length; i++) {
      if (d >= trip.segKm[i]) { out.push(trip.pts[i + 1]); d -= trip.segKm[i]; continue; }
      const p = VF.posAt(trip, trip.doneKm); out.push([p.lat, p.lon]); break;
    }
    return out;
  }
  function mapInfo(v, m) {
    const b = VF.activeBooking(v.driverId);
    const active = v.trip && !v.trip.done;
    const pos = active ? VF.posAt(v.trip, v.trip.doneKm) : VF.PLACES[v.node];
    const stations = VF.state.stations.map((st) => { const cls = stationState(st, m, b && b.stationId); return { st, cls, label: shortName(st.name), title: `${st.name} · ${STATE_LABEL[cls]}` }; });
    const fit = active ? v.trip.pts.slice() : [[pos.lat, pos.lon]];
    if (!active) VF.state.stations.forEach((st) => { if (VF.hav(pos, VF.PLACES[st.node]) < 9) fit.push([VF.PLACES[st.node].lat, VF.PLACES[st.node].lon]); });
    return { key: stations.map((x) => x.cls[0]).join('') + (active ? v.trip.nodes.join('.') + v.trip.bookingId : v.node), b, pos, stations, fit, active };
  }
  function mapHTML(v, m, id) {
    const mi = mapInfo(v, m);
    return VF.mapSVG({ id, vb: VF.fitBox(mi.fit, 60, 1.55), route: mi.active ? v.trip.pts : null, routeDone: mi.active ? donePts(v.trip) : null, progress: mi.active ? v.trip.doneKm / Math.max(1e-6, v.trip.totalKm) : null, stations: mi.stations, vehicle: { lat: mi.pos.lat, lon: mi.pos.lon, cls: v.status }, stationAct: 'd-station', label: 'Your route and chargers' });
  }
  function mapLegend() {
    return `<div class="legend small"><span><i class="lg avail"></i>Free now</span><span><i class="lg busy"></i>Busy</span><span><i class="lg booked"></i>Your booking</span><span><i class="lg incompat"></i>Not compatible</span></div>`;
  }
  function liveMap(id, v) {
    const svg = document.getElementById(id); if (!svg) return;
    const active = v.trip && !v.trip.done;
    const pos = active ? VF.posAt(v.trip, v.trip.doneKm) : VF.PLACES[v.node];
    if (VF.maps && VF.maps.has(id)) { VF.maps.moveMe(id, pos.lat, pos.lon, v.status, active ? v.trip.doneKm / Math.max(1e-6, v.trip.totalKm) : null, active ? donePts(v.trip) : null); return; }
    const [x, y] = VF.proj(pos.lat, pos.lon);
    const me = svg.querySelector('.me'); if (me) { me.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`); me.setAttribute('class', 'me ' + v.status); }
    const done = svg.querySelector('.route-done');
    if (done && active) done.setAttribute('points', donePts(v.trip).map(([la, lo]) => VF.proj(la, lo).map((n) => n.toFixed(1)).join(',')).join(' '));
  }

  const socCls = (soc) => (soc < 15 ? 'lo' : soc < 35 ? 'mid' : '');
  function statusLine(v) {
    const ch = v.chargingAt && VF.station(v.chargingAt.stationId);
    return { driving: `Driving · ${v.speedKmh} km/h average`, charging: `Charging at ${ch ? ch.name : 'station'}`, waiting: 'At the station · connector finishing', parked: `Parked near ${VF.PLACES[v.node].name}`, stranded: 'Stopped: battery empty' }[v.status] || '';
  }

  // ---------------------------------------------------------------- shared cards
  const card = (cls, title, action, body) => `<section class="card ${cls}">${title ? `<div class="card-head"><h3>${title}</h3>${action || ''}</div>` : ''}${body}</section>`;
  const stat = (label, value, live) => `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value"${live ? ` data-live="${live}" data-tween` : ''}>${value}</span></div>`;
  const mapsLink = (st) => `https://www.google.com/maps/search/?api=1&query=${VF.PLACES[st.node].lat},${VF.PLACES[st.node].lon}`;

  // The charging card changes with the driver's situation: booked, charging, needs a charge, or fine.
  function chargeCard(v, m, t, span) {
    const d = VF.driver(v.driverId); const b = VF.activeBooking(d.id); const reserve = VF.state.settings.reserve;
    if (b && b.status === 'charging') {
      const st = VF.station(b.stationId); const c = VF.connector(b.connectorId);
      return card(`${span} charge-card is-charging`, 'Charging now', VF.pill('charge', 'Live'), `
        <div class="charge-place"><strong>${esc(st.name)}</strong><span class="muted small">Connector ${esc(c.label)} · ${esc(c.type)} ${c.kw} kW</span></div>
        <div class="chg-flow" aria-hidden="true"><span class="cf-node">${icon('plug')}</span><span class="cf-line"><i></i><i></i><i></i><i></i><i></i></span><span class="cf-node car">${icon('car')}</span></div>
        <div class="progress lg"><i class="charge" data-live="chgw" style="width:${clamp(v.soc, 0, 100)}%"></i><b style="left:${b.targetSoc}%" title="Target ${b.targetSoc}%"></b></div>
        <div class="stats-4">${stat('Power', '—', 'chgkw')}${stat('Added', '—', 'chgkwh')}${stat('Cost so far', '—', 'chgcost')}${stat(`To ${b.targetSoc}%`, '—', 'chgleft')}</div>
        <div class="card-actions"><button class="btn" data-act="d-stop">Stop charging</button><span class="faint small">Booking ${esc(b.code)}</span></div>`);
    }
    if (b) {
      const st = VF.station(b.stationId); const c = VF.connector(b.connectorId); const op = VF.operator(b.operatorId);
      const wait = c.status === 'Charging' && c.session && c.session.bookingId !== b.id;
      return card(`${span} charge-card is-booked`, 'Your charging slot', `<span class="code-chip">${esc(b.code)}</span>`, `
        <div class="charge-place"><strong>${esc(st.name)}</strong><span class="muted small">${esc(op.name)} · ${esc(c.label)} · ${esc(c.type)} ${c.kw} kW</span></div>
        <div class="stats-3">${stat('Slot starts', VF.fmtTime(b.start))}${stat('You arrive', VF.fmtTime(b.eta), 'beta')}${stat('Est. cost', fmt.money(b.estCost, 0))}</div>
        <div class="note ${wait ? 'warn' : 'good'}">${icon(wait ? 'clock' : 'check')}<span>${wait ? 'A walk-in is finishing on your connector. You keep first place.' : `Held for you until ${VF.fmtTime(b.start + op.pricing.graceMin * MIN)}. No queue.`}</span></div>
        <div class="card-actions"><a class="btn" href="${mapsLink(st)}" target="_blank" rel="noopener">${icon('pin')}Directions</a><button class="btn ghost danger" data-act="d-cancel" data-id="${b.id}">Cancel</button></div>`);
    }
    if (v.status === 'stranded') return card(`${span} charge-card is-low`, 'Battery empty', '', `<p class="muted">Call roadside assistance. They get your booking history, but not your location unless you share it.</p>`);
    if (t && t.arriveSoc < reserve) {
      return card(`${span} charge-card is-low beam`, 'Charge needed', VF.pill('bad', 'Action'), `
        <p>At this pace you'd reach <strong>${esc(t.dest)}</strong> with <strong data-live="arrsoc2">${Math.round(t.arriveSoc)}%</strong>, below your ${reserve}% reserve.</p>
        <button class="btn primary big glow" data-act="d-auto">${icon('bolt')}Book a charger on my route</button>
        <p class="faint small">Checks live availability of every connector that fits your car and holds a slot for your arrival.</p>`);
    }
    return card(`${span} charge-card is-ok`, 'Charging', VF.pill('ok', 'On track'), `
      <p class="muted">${t ? `You'll reach ${esc(t.dest)} with about <strong data-live="arrsoc2">${Math.round(t.arriveSoc)}%</strong>. No stop needed.` : 'No charge needed right now.'}</p>
      <button class="btn big" data-act="d-auto">${icon('bolt')}Book a charger on my route</button>`);
  }
  function autoResult() {
    const a = ui.auto; if (!a) return '';
    const s = a.stats;
    return `<div class="check-summary">${icon('check')}<span>Checked ${s.connectors} connectors at ${s.stations} stations: <strong>${s.free}</strong> free when you arrive, ${s.busy} busy, ${s.outOfService} out of service, ${s.incompatible} don't fit your ${esc(a.model)}.</span></div>`;
  }
  function optionRow(o, canBook, compact) {
    return `<li class="opt"><div class="opt-main"><strong>${esc(o.station.name)}</strong>
      <span class="muted small">${esc(o.c.type)} ${o.c.kw} kW · ${o.detour < 0.5 ? 'on route' : '+' + fmt.km(o.detour)} · arrive ${VF.fmtTime(o.eta)}</span>
      <span class="opt-tags">${o.wait ? VF.pill('warn plain', `Wait ${o.wait} min`) : VF.pill('ok plain', 'Free on arrival')}${compact ? '' : `<span class="small muted">${fmt.dur(o.dur)} to ${Math.round(o.target)}% · ${fmt.money(o.cost, 0)}</span>`}</span></div>
      <button class="btn small" data-act="d-book" data-st="${o.station.id}" data-c="${o.c.id}" ${canBook ? '' : 'disabled'}>Book</button></li>`;
  }
  function routeOptions(d) {
    const ev = VF.evaluateRoute(d.id); const best = {};
    for (const o of ev.options) if (!best[o.station.id]) best[o.station.id] = o;
    return { ev, list: Object.values(best) };
  }

  // ---------------------------------------------------------------- pages
  function disconnected(d, v, m) {
    return `<div class="dash">${card('span-12', '', '', `<div class="empty-state">${icon('lock')}<h3>Vehicle data is switched off</h3><p class="muted">You turned off the connection to your ${esc(m.oem)}. Range, trip and charging features need battery data.</p><button class="btn primary" data-act="d-consent" data-k="telematics" data-v="1">Reconnect my ${esc(v.model)}</button></div>`)}</div>`;
  }
  // Live battery hero: glowing 270° charge ring, numbers that glide, and a charging pulse.
  const ringTone = (soc, v) => (v.status === 'charging' ? 'chg' : soc < 15 ? 'lo' : soc < 30 ? 'mid' : 'ok');
  function batteryCard(v, m, span) {
    const charging = v.status === 'charging';
    return `<section class="${span} d-battery beam${charging ? ' is-charging' : ''}">
      <div class="hl-grid" aria-hidden="true"></div>
      <div class="db-head"><span class="hl-live"><i></i>Live · ${esc(m.oem)}</span><span class="db-status">${esc(statusLine(v))}</span></div>
      <div class="db-ring">
        <svg viewBox="0 0 200 200" aria-hidden="true"><defs><linearGradient id="db-g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#2DD4BF"/><stop offset="1" stop-color="#A3E635"/></linearGradient></defs>
          <circle class="db-orbit" cx="100" cy="100" r="92"/>
          <circle class="db-track" cx="100" cy="100" r="78" pathLength="100" stroke-dasharray="75 100" transform="rotate(135 100 100)"/>
          <circle class="db-fill ${ringTone(v.soc, v)}" data-live="gauge" cx="100" cy="100" r="78" pathLength="100" stroke-dasharray="${(75 * clamp(v.soc, 0, 100) / 100).toFixed(2)} 100" transform="rotate(135 100 100)"/></svg>
        <div class="db-center"><b data-live="soc" data-tween>${Math.round(v.soc)}%</b><small>${charging ? 'charging' : 'charged'}</small>${charging ? `<span class="db-bolt">${icon('bolt')}</span>` : ''}</div>
      </div>
      <div class="db-stats"><div><span>Range</span><b data-live="range" data-tween>${fmt.km(VF.rangeKm(v))}</b></div><div><span>Driving time left</span><b data-live="tte">${fmt.dur(driveMinutesLeft(v))}</b></div></div>
    </section>`;
  }
  function tripCard(v, m, t, span) {
    if (!t) return whereTo(v, span);
    return card(`${span} trip-card`, 'Current trip', `<button class="link-btn" data-act="d-go" data-tab="driver-charge">Chargers on route</button>`, `
      <div class="route-line-ui"><div class="end"><i class="dot"></i><strong>${esc(t.origin)}</strong></div><div class="progress road"><i data-live="tripw" style="width:${(t.progress * 100).toFixed(1)}%"><span class="car-dot">${icon('car')}</span></i></div><div class="end r"><i class="dot dest"></i><strong>${esc(t.dest)}</strong></div></div>
      <div class="stats-3">${stat('Distance left', fmt.km(t.left), 'left')}${stat('Arrival', VF.fmtTime(t.eta), 'eta')}${stat('Battery on arrival', Math.round(t.arriveSoc) + '%', 'arrsoc')}</div>
      <div class="card-foot">${t.b ? `Includes your charging stop at ${esc(VF.station(t.b.stationId).name)}` : 'No charging stop planned'} · arrival updates live</div>`);
  }
  function whereTo(v, span) {
    const opts = Object.entries(VF.PLACES).filter(([id]) => id !== v.node).sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([id, p]) => `<option value="${id}" ${ui.dest === id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    return card(`${span} trip-card`, 'Where to?', '', `<div class="row nowrap"><select class="select grow" id="d-dest" data-chg="d-dest"><option value="">Choose a destination</option>${opts}</select><button class="btn primary" data-act="d-trip">Start trip</button></div>
      <p class="faint small">Your destination stays on this device and is used only to plan range and charging.</p>`);
  }
  function mapCard(v, m, span, title) {
    return card(`${span} map-card`, title || 'Route and chargers', mapLegend(), `<div class="map-wrap" id="d-mapwrap">${mapHTML(v, m, 'd-map')}</div>`);
  }
  function healthCard(v, m, span) {
    const items = [
      ['thermo', 'Battery temp', has(m, 'batteryTemp') ? `<span data-live="temp">${fmt.n(v.tempC, 1)} °C</span>` : '<span class="faint">n/a</span>'],
      ['bolt', 'Efficiency', `${fmt.n(m.eff * 105, 1)} kWh/100 km`],
      ['car', 'Odometer', `<span data-live="odo">${fmt.n(v.odo)} km</span>`],
      ['warn', 'Lowest tyre', has(m, 'tyres') ? `${Math.min(...v.tyres)} psi` : '<span class="faint">n/a</span>'],
    ];
    return card(`${span}`, 'Vehicle health', `<button class="link-btn" data-act="d-go" data-tab="driver-vehicle">Details</button>`, `${VF.c && VF.c.vehicleImg ? `<div class="d-health-photo">${VF.c.vehicleImg(v.model, 'cover')}</div>` : ''}<div class="metric-grid">${items.map(([ic, l, val]) => `<div class="metric">${icon(ic)}<span class="stat-label">${l}</span><span class="stat-value sm">${val}</span></div>`).join('')}</div>`);
  }
  function updatesCard(d, span) {
    const list = VF.state.notices.filter((n) => n.driverId === d.id).slice(0, 4);
    return card(`${span}`, 'Recent updates', `<button class="link-btn" data-act="d-notices">View all</button>`, list.length ? `<ul class="feed">${list.map((n) => `<li><span class="feed-dot"></span><div><strong>${esc(n.title)}</strong><span class="muted small">${esc(n.body)}</span></div><span class="faint small nowrap">${VF.relTime(n.t)}</span></li>`).join('')}</ul>` : '<p class="muted small">Booking and charging updates appear here.</p>');
  }
  function pageHome() {
    const { d, v, m } = ctx();
    if (!d.consents.telematics) return disconnected(d, v, m);
    const t = tripInfo(v, m);
    const { list } = routeOptions(d);
    const canBook = !['charging', 'waiting', 'stranded'].includes(v.status);
    return `<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div><div class="dash">
      ${batteryCard(v, m, 'span-4')}
      ${tripCard(v, m, t, 'span-4')}
      ${chargeCard(v, m, t, 'span-4')}
      ${mapCard(v, m, 'span-8')}
      ${card('span-4', 'Chargers on your route', `<button class="link-btn" data-act="d-go" data-tab="driver-charge">See all</button>`, list.length ? `<ul class="opt-list">${list.slice(0, 4).map((o) => optionRow(o, canBook, true)).join('')}</ul>` : '<p class="muted small">No compatible charger has a free slot on this route in the next 4 hours.</p>')}
      ${healthCard(v, m, 'span-6')}
      ${updatesCard(d, 'span-6')}
    </div>`;
  }

  function pageCharge() {
    const { d, v, m } = ctx();
    if (!d.consents.telematics) return disconnected(d, v, m);
    const b = VF.activeBooking(d.id);
    const { ev, list } = routeOptions(d);
    const incompat = VF.state.stations.filter((st) => !st.connectors.some((c) => VF.compatible(m, c.type)));
    const canBook = !['charging', 'waiting', 'stranded'].includes(v.status);
    return `<div class="dash">
      <section class="card span-12 one-click"><div class="one-click-row"><div class="oc-icon">${icon('bolt')}</div><div class="grow"><h3>Book the best charger on my route</h3><p class="muted small">Checks every connector that fits your ${esc(v.model)} (${esc(m.ports.join(', '))}) between you and ${ev.dest ? esc(VF.PLACES[ev.dest].name) : 'nearby'}, then holds a slot for your arrival so you skip the queue.</p></div>
        <button class="btn primary lg" data-act="d-auto" ${canBook ? '' : 'disabled'}>${b ? 'Find a better slot' : 'Book now'}</button></div>${autoResult()}</section>
      ${b ? chargeCard(v, m, tripInfo(v, m), 'span-12') : ''}
      ${mapCard(v, m, 'span-7', 'Chargers near your route')}
      ${card('span-5', 'Best options', `<span class="faint small">${ev.stats.compatible} compatible connectors</span>`, list.length ? `<ul class="opt-list">${list.slice(0, 8).map((o) => optionRow(o, canBook)).join('')}</ul>` : '<p class="muted small">No compatible charger has a free slot on this route in the next 4 hours.</p>')}
      ${incompat.length ? card('span-12', 'Not compatible with your car', '', `<p class="muted small">Your ${esc(v.model)} uses ${esc(m.ports.join(' and '))}. These stations only have other plugs.</p><div class="chips">${incompat.map((st) => `<span class="chip">${esc(st.name)} · ${esc([...new Set(st.connectors.map((c) => c.type))].join(', '))}</span>`).join('')}</div>`) : ''}
    </div>`;
  }

  function pageBookings() {
    const { d, v, m } = ctx();
    const mine = VF.state.bookings.filter((b) => b.driverId === d.id && !b.sim).sort((a, b) => b.createdAt - a.createdAt);
    const active = mine.find((b) => ['confirmed', 'charging'].includes(b.status));
    const past = mine.filter((b) => b !== active);
    const sessions = VF.state.sessions.filter((x) => x.driverId === d.id);
    return `<div class="dash">
      ${active ? chargeCard(v, m, tripInfo(v, m), 'span-6') : card('span-6', 'Active booking', '', `<div class="empty-state">${icon('ticket')}<p class="muted">No active booking. Your slot is held when you book, so you never queue.</p><button class="btn primary" data-act="d-go" data-tab="driver-charge">Find a charger</button></div>`)}
      ${card('span-6', 'Charging this month', '', `<div class="stats-3">${stat('Sessions', sessions.length)}${stat('Energy', fmt.kwh(sum(sessions, (x) => x.kwh)))}${stat('Spent', fmt.money(sum(sessions, (x) => x.cost), 0))}</div>`)}
      ${card('span-12 flush', 'History', '', past.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Station</th><th>Date</th><th>Code</th><th>Status</th><th class="r">Energy</th><th class="r">Cost</th></tr></thead><tbody>${past.map((b) => `<tr><td class="strong">${esc(VF.station(b.stationId).name)}</td><td class="num">${VF.fmtStamp(b.start)}</td><td class="mono small">${esc(b.code)}</td><td>${VF.bookingPill(b)}</td><td class="r num">${b.actualKwh != null ? fmt.kwh(b.actualKwh) : '—'}</td><td class="r num">${b.actualCost != null ? fmt.money(b.actualCost) : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small pad">Past bookings will appear here.</p>')}
    </div>`;
  }

  function pageVehicle() {
    const { d, v, m } = ctx();
    const o = oemOf(m);
    const pos = v.trip && !v.trip.done ? VF.posAt(v.trip, v.trip.doneKm) : VF.PLACES[v.node];
    const near = VF.PLACES[VF.nearestNode(pos.lat, pos.lon)].name;
    const tele = {
      soc: `<span data-live="soc">${Math.round(v.soc)}%</span>`, range: `<span data-live="range">${fmt.km(VF.rangeKm(v))}</span>`,
      charging: v.status === 'charging' ? 'Charging' : 'Not charging', odo: `<span data-live="odo">${fmt.n(v.odo)} km</span>`,
      batteryTemp: `<span data-live="temp">${fmt.n(v.tempC, 1)} °C</span>`, location: `Near ${esc(near)} <span class="faint">(only you)</span>`,
      tyres: v.tyres.join(' / ') + ' psi', aux12v: v.aux12v + ' V', remote: 'Supported',
    };
    const compatCount = VF.state.stations.filter((st) => st.connectors.some((c) => VF.compatible(m, c.type))).length;
    const connected = d.consents.telematics;
    return `<div class="dash">
      ${card('span-6', esc(v.model), `<span class="oem-badge">${esc(m.oem)}</span>`, `${VF.c && VF.c.vehicleImg ? `<div class="d-vphoto">${VF.c.vehicleImg(v.model, 'cover')}</div>` : ''}<p class="muted small">${esc(m.spec)} · ${esc(v.plate || '—')} · VIN ${esc(v.vin || '—')}</p><div class="stats-3">${stat('Battery', m.kwh + ' kWh')}${stat('Max DC', m.dc + ' kW')}${stat('Max AC', m.ac + ' kW')}</div>`)}
      ${card('span-6', 'Connection', connected ? pill('ok', 'Connected') : pill('warn', 'Off'), `<dl class="dl"><dt>Method</dt><dd>${esc(o.method)}</dd><dt>Sign-in</dt><dd>${esc(o.auth)}</dd><dt>Linked</dt><dd>${VF.fmtDate(v.linked.at)}</dd></dl>
        <p class="faint small">VoltFleet reads battery, range, charging state, odometer and diagnostics. Location is used on this phone for routing and arrival time, and is never sent to stations or shown to staff.</p>
        <div class="card-actions"><button class="btn ${connected ? 'danger' : 'primary'}" data-act="d-consent" data-k="telematics" data-v="${connected ? 0 : 1}">${connected ? 'Disconnect vehicle' : 'Reconnect vehicle'}</button></div>`)}
      ${connected ? card('span-6', 'Live vehicle data', '', `<dl class="dl">${VF.TELEMETRY_FIELDS.map(([k, label], i) => `<dt>${label}</dt><dd>${o.cov[i] ? tele[k] : `<span class="faint">Not available from ${esc(m.oem)}</span>`}${o.cov[i] === 1 ? ' <span class="faint small">(some models)</span>' : ''}</dd>`).join('')}</dl>`) : ''}
      ${card(connected ? 'span-6' : 'span-12', 'Plugs that fit', '', `<div class="chips">${Object.keys(VF.CONNECTOR_TYPES).map((t) => `<span class="chip ${VF.compatible(m, t) ? 'yes' : 'no'}">${VF.compatible(m, t) ? icon('check') : ''}${esc(t)}</span>`).join('')}</div><p class="muted small">${compatCount} of ${VF.state.stations.length} stations on the network have a plug for your car.</p>`)}
      ${VF.connectedAppsHTML ? VF.connectedAppsHTML(d.id) : ''}
    </div>`;
  }

  const CONSENTS = [
    ['telematics', 'Connect my vehicle data', 'Battery, range, charging state, odometer and diagnostics. Needed for range and charging features.'],
    ['shareSoc', 'Share my battery % with the station I book', 'Helps the operator plan power for your session. If off, they see "not shared".'],
    ['shareEta', 'Share my live arrival time with the station I book', 'Your location never leaves the app. The station only sees an updated arrival time.'],
    ['analytics', 'Anonymous usage analytics', 'Counts and trends with no name, plate or location. Helps us improve the app.'],
    ['marketing', 'Offers from VoltFleet and partners', 'Off by default. We never sell your data.'],
  ];
  function pagePrivacy() {
    const { u, d, v } = ctx();
    const b = VF.activeBooking(d.id);
    const opId = b ? b.operatorId : 'op1';
    return `<div class="dash">
      <section class="card span-12 banner">${icon('shield')}<div><h3>You control what leaves your car</h3><p class="muted small">Stations never see your name, phone, plate or location. Staff only see masked details, and every look is logged.</p></div></section>
      ${card('span-7', 'Sharing', '', `<div class="toggles">${CONSENTS.map(([k, t, desc]) => `<label class="toggle"><span><strong>${t}</strong><span class="muted small">${desc}</span></span><input type="checkbox" role="switch" id="c-${k}" data-chg="d-consent-box" data-k="${k}" ${d.consents[k] ? 'checked' : ''}></label>`).join('')}</div>`)}
      ${card('span-5', 'What a station sees', '', `<p class="muted small">Exactly this, at ${esc(VF.operator(opId).name)}${b ? ' for your current booking' : ''}:</p>
        <dl class="dl boxed"><dt>Driver</dt><dd class="mono">${VF.pseudo(d.id, opId)}</dd><dt>Vehicle</dt><dd>${esc(v.model)}</dd><dt>Booking code</dt><dd class="mono">${b ? esc(b.code) : 'VF-····'}</dd><dt>Arrival time</dt><dd>${d.consents.shareEta ? 'Live updates' : 'Booked slot only'}</dd><dt>Battery on arrival</dt><dd>${d.consents.shareSoc ? 'Shared' : 'Not shared'}</dd><dt>Name, phone, plate, location</dt><dd>Never</dd></dl>
        <p class="faint small">Each operator sees a different driver ID, so networks can't link your visits.</p>`)}
      ${card('span-6', 'Your data', '', `<p class="muted small">Get a copy of everything we hold about you, or delete your account.</p>
        <div class="card-actions"><button class="btn" data-act="d-export" data-mode="copy">${icon('copy')}Copy my data</button><button class="btn" data-act="d-export" data-mode="dl">${icon('download')}Download</button></div>
        ${ui.confirmDelete ? `<div class="confirm-box"><strong>Delete your account?</strong><p class="small muted">Your profile, vehicle link and preferences are erased now. Billing records keep a pseudonymous ID for ${Math.round(VF.state.settings.retention.sessions / 30)} months, as the law requires, then are deleted.</p><div class="row"><button class="btn danger" data-act="d-delete-yes">Delete my account</button><button class="btn" data-act="d-delete-no">Keep it</button></div></div>` : `<button class="btn ghost danger" data-act="d-delete">${icon('trash')}Delete my account</button>`}
        <p class="faint small">Signed in as ${esc(u.name)} · ${esc(u.email)}</p>`)}
      ${card('span-6', 'Consent history', '', `<ul class="plain-list">${d.consentLog.slice().reverse().slice(0, 8).map((l) => `<li><span class="small">${esc(l.key === 'all' ? l.value : `${(CONSENTS.find((c) => c[0] === l.key) || [0, l.key])[1]}: ${l.value ? 'on' : 'off'}`)}</span><span class="faint small nowrap">${VF.fmtStamp(l.t)}</span></li>`).join('')}</ul>`)}
    </div>`;
  }

  // ---------------------------------------------------------------- live values
  function liveValues() {
    const { d, v, m } = ctx();
    const t = tripInfo(v, m); const b = VF.activeBooking(d.id);
    const vals = {
      soc: Math.round(v.soc) + '%', range: fmt.km(VF.rangeKm(v)), tte: fmt.dur(driveMinutesLeft(v)), temp: fmt.n(v.tempC, 1) + ' °C', odo: fmt.n(v.odo) + ' km',
      sync: v.status === 'stranded' ? 'stale' : 'just now',
      gauge: { attr: { 'stroke-dasharray': `${(75 * clamp(v.soc, 0, 100) / 100).toFixed(2)} 100` }, cls: 'db-fill ' + ringTone(v.soc, v) },
    };
    if (t) Object.assign(vals, { tripw: { w: t.progress * 100 }, left: fmt.km(t.left), eta: VF.fmtTime(t.eta), arrsoc: Math.round(t.arriveSoc) + '%', arrsoc2: Math.round(t.arriveSoc) + '%' });
    if (b) {
      vals.beta = VF.fmtTime(b.eta); vals.bsoc = Math.round(Math.max(0, b.arrivalSoc)) + '%';
      const c = VF.connector(b.connectorId);
      if (b.status === 'charging' && c && c.session) {
        const se = c.session;
        Object.assign(vals, { chgw: { w: se.soc }, chgkw: fmt.kw(se.kw), chgkwh: fmt.kwh(se.kwh), chgcost: fmt.money(se.cost), chgleft: fmt.dur(Math.max(0, (se.target - se.soc) / 100 * se.battery / Math.max(1, se.kw) * 60)) });
      }
    }
    return vals;
  }
  function structKey(page) {
    const { d, v, m } = ctx();
    const b = VF.activeBooking(d.id); const t = tripInfo(v, m);
    const c = b && VF.connector(b.connectorId);
    let k = [page, v.status, d.consents.telematics, VF.state.notices.filter((n) => n.driverId === d.id).length, b ? b.id + b.status : '', c ? (c.session && c.session.bookingId !== b.id ? 'w' : '') : '', t ? t.dest + (t.arriveSoc < VF.state.settings.reserve) : 'no', ui.confirmDelete, ui.auto ? ui.auto.t : 0].join('|');
    if (page === 'driver-charge' || page === 'driver-home') {
      const ev = VF.evaluateRoute(d.id); const seen = {};
      k += ev.options.filter((o) => (seen[o.station.id] ? false : (seen[o.station.id] = 1))).slice(0, 8).map((o) => o.c.id + (o.wait > 0 ? 'w' : '') + Math.round(o.arriveSoc / 5)).join();
    }
    return k;
  }

  // ---------------------------------------------------------------- station sheet & notices
  function stationSheet(id) {
    const { d, v, m } = ctx(); const st = VF.station(id); const op = VF.operator(st.operatorId);
    const ev = VF.evaluateRoute(d.id); const opt = ev.options.find((o) => o.station.id === id);
    const now = VF.now();
    return `<div class="sheet-head"><div><div class="eyebrow">${esc(op.name)}</div><h3>${esc(st.name)}</h3><div class="muted small">${esc(VF.PLACES[st.node].name)} · now ${fmt.money(VF.priceAt(st.operatorId, now, 'Type 2'))}/kWh AC, ${fmt.money(VF.priceAt(st.operatorId, now, 'CCS2'))}/kWh DC</div></div><button class="icon-btn" data-act="d-sheet-close" aria-label="Close">${icon('close')}</button></div>
      <ul class="plain-list">${st.connectors.map((c) => `<li><div><strong>${esc(c.label)} · ${esc(c.type)} ${c.kw} kW</strong><div class="small ${VF.compatible(m, c.type) ? 'ok-text' : 'faint'}">${VF.compatible(m, c.type) ? 'Fits your car' : 'Does not fit your car'}</div></div>${VF.connPill(c)}</li>`).join('')}</ul>
      ${opt ? `<p class="small">Best slot: ${esc(opt.c.label)} at ${VF.fmtTime(opt.start)} ${opt.wait ? `(wait ${opt.wait} min)` : '(free on arrival)'}, ${fmt.dur(opt.dur)} to ${Math.round(opt.target)}%, about ${fmt.money(opt.cost, 0)}.</p><button class="btn primary big" data-act="d-book" data-st="${st.id}" data-c="${opt.c.id}" ${['charging', 'waiting'].includes(v.status) ? 'disabled' : ''}>Book this slot</button>` : `<p class="muted small">${st.connectors.some((c) => VF.compatible(m, c.type)) ? 'No free slot fits your trip right now.' : 'No connector here fits your car.'}</p>`}`;
  }
  function noticesSheet() {
    const { d } = ctx();
    const list = VF.state.notices.filter((n) => n.driverId === d.id).slice(0, 20);
    list.forEach((n) => { n.read = true; });
    return `<div class="sheet-head"><h3>Updates</h3><button class="icon-btn" data-act="d-sheet-close" aria-label="Close">${icon('close')}</button></div>
      ${list.length ? `<ul class="plain-list">${list.map((n) => `<li><div><strong>${esc(n.title)}</strong><div class="small muted">${esc(n.body)}</div></div><span class="faint small">${VF.relTime(n.t)}</span></li>`).join('')}</ul>` : '<p class="muted">No updates yet.</p>'}`;
  }

  // ---------------------------------------------------------------- app definition
  VF.apps.driver = {
    home: 'driver-home',
    nav: [
      { id: 'driver-home', label: 'Home', icon: 'home', title: 'Home' },
      { id: 'driver-charge', label: 'Charge', icon: 'bolt', title: 'Charge' },
      { id: 'driver-bookings', label: 'Bookings', icon: 'ticket', title: 'Bookings' },
      { id: 'driver-vehicle', label: 'Vehicle', icon: 'car', title: 'My vehicle' },
      { id: 'driver-privacy', label: 'Privacy', icon: 'shield', title: 'Privacy & data' },
    ],
    pages: { 'driver-home': pageHome, 'driver-charge': pageCharge, 'driver-bookings': pageBookings, 'driver-vehicle': pageVehicle, 'driver-privacy': pagePrivacy },
    roleLabel: () => 'Driver',
    title(page) {
      if (page !== 'driver-home') return null;
      const { u } = ctx(); const h = VF.hourOf(VF.now());
      return `Good ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}, ${u.name.split(' ')[0]}`;
    },
    eyebrow() { const { v } = ctx(); return `${v.model}${v.plate ? ' · ' + v.plate : ''}`; },
    tools() {
      const { u } = ctx();
      const unread = VF.state.notices.filter((n) => n.driverId === u.driverId && !n.read).length;
      return `<button class="icon-btn bell" data-act="d-notices" aria-label="Updates" title="Updates">${icon('bell')}${unread ? `<span class="dot-count">${unread}</span>` : ''}</button>`;
    },
    structKey,
    live(page) {
      const { v } = ctx();
      liveMap('d-map', v);
      return liveValues(page);
    },
    sheet() { if (!ui.sheet) return ''; return ui.sheet.type === 'station' ? stationSheet(ui.sheet.id) : noticesSheet(); },
  };

  // ---------------------------------------------------------------- actions
  function doBook(opt, source) {
    const { d, v } = ctx();
    const b = VF.book(d.id, opt, source);
    VF.save();
    VF.toast(`Slot held at ${opt.station.name} (${VF.operator(opt.station.operatorId).name}) from ${VF.fmtTime(b.start)} · code ${b.code}`);
    return b;
  }
  Object.assign(VF.ACT, {
    'd-auto': () => {
      const { d, v, m } = ctx();
      if (!d.consents.telematics) { VF.toast('Reconnect your vehicle to book on your route'); return; }
      if (['charging', 'waiting', 'stranded'].includes(v.status)) { VF.toast('You are already at a charger'); return; }
      const ev = VF.evaluateRoute(d.id);
      ui.auto = { t: VF.now(), stats: ev.stats, model: v.model };
      const opt = ev.options[0];
      if (!opt) { VF.toast('No connector that fits your car has a free slot on this route in the next 4 hours'); VF.rerender(); return; }
      doBook(opt, 'auto');
      if (VF.route() !== 'driver-charge' && VF.route() !== 'driver-home') location.hash = 'driver-home';
      VF.rerender();
    },
    'd-book': (el) => {
      const { d } = ctx();
      const opt = VF.evaluateRoute(d.id).options.find((o) => o.c.id === el.dataset.c);
      if (!opt) { VF.toast('That slot was just taken. Pick another one.'); VF.rerender(); return; }
      doBook(opt, 'manual'); ui.sheet = null; VF.rerender();
    },
    'd-cancel': (el) => { const { u } = ctx(); VF.cancelBooking(el.dataset.id, u.id, 'Cancelled by driver'); VF.save(); VF.toast('Booking cancelled. The slot is free for others.'); VF.rerender(); },
    'd-stop': () => {
      const { d } = ctx(); const b = VF.activeBooking(d.id); if (!b) return;
      const st = VF.station(b.stationId); const c = VF.connector(b.connectorId);
      if (c && c.session) { VF.ocpp(st.id, c.id, '→', 'RemoteStopTransaction', 'requested by driver app'); VF.endSession(st, c); c.status = 'Finishing'; c.until = VF.now() + 3 * MIN; }
      VF.save(); VF.rerender();
    },
    'd-go': (el) => { location.hash = el.dataset.tab; },
    'd-trip': () => { const { d } = ctx(); if (!ui.dest) { VF.toast('Choose a destination first'); return; } VF.startTrip(d.id, ui.dest); ui.dest = ''; VF.save(); VF.rerender(); },
    'd-station': (el) => { ui.sheet = { type: 'station', id: el.dataset.id }; VF.renderSheet(); },
    'd-notices': () => { ui.sheet = { type: 'notices' }; VF.renderSheet(); VF.save(); },
    'd-sheet-close': () => { ui.sheet = null; VF.renderSheet(); VF.rerender(); },
    'd-consent': (el) => setConsent(el.dataset.k, el.dataset.v === '1'),
    'd-export': (el) => {
      const { u, d, v } = ctx();
      const data = {
        exportedAt: new Date(VF.now()).toISOString(),
        profile: { name: u.name, email: u.email, phone: u.phone, joined: new Date(u.joined).toISOString() },
        vehicle: { model: v.model, plate: v.plate, vin: v.vin, connection: v.linked },
        consents: d.consents, consentHistory: d.consentLog,
        bookings: VF.state.bookings.filter((b) => b.driverId === d.id).map((b) => ({ code: b.code, station: VF.station(b.stationId).name, start: new Date(b.start).toISOString(), status: b.status, estCost: b.estCost, actualKwh: b.actualKwh, actualCost: b.actualCost })),
        sessions: VF.state.sessions.filter((x) => x.driverId === d.id).map((x) => ({ station: VF.station(x.stationId).name, start: new Date(x.start).toISOString(), end: new Date(x.end).toISOString(), kwh: +x.kwh.toFixed(2), cost: +x.cost.toFixed(2) })),
      };
      const json = JSON.stringify(data, null, 2);
      VF.audit(u.id, 'data-export', 'own data (self-service)');
      VF.state.requests.unshift({ id: 'rq' + (++VF.state.seq), driverId: d.id, type: 'export', t: VF.now(), status: 'done', doneAt: VF.now(), self: true });
      VF.save();
      if (el.dataset.mode === 'dl') VF.downloadText('voltfleet-my-data.json', json, 'application/json'); else VF.copyText(json, 'Your data');
    },
    'd-delete': () => { ui.confirmDelete = true; VF.rerender(); },
    'd-delete-no': () => { ui.confirmDelete = false; VF.rerender(); },
    'd-delete-yes': () => {
      const { u, d, v } = ctx();
      const b = VF.activeBooking(d.id); if (b) VF.cancelBooking(b.id, u.id, 'Account deleted');
      VF.audit(u.id, 'erasure', 'own account (self-service)');
      VF.state.requests.unshift({ id: 'rq' + (++VF.state.seq), driverId: d.id, type: 'erasure', t: VF.now(), status: 'done', doneAt: VF.now(), self: true });
      VF.eraseDriver(d.id);
      ui.confirmDelete = false;
      VF.signOut('Your account was deleted.');
    },
  });
  Object.assign(VF.CHG, {
    'd-dest': (el) => { ui.dest = el.value; },
    'd-consent-box': (el) => setConsent(el.dataset.k, el.checked),
  });
  function setConsent(k, val) {
    const { u, d, v } = ctx();
    if (d.consents[k] === val) return;
    d.consents[k] = val;
    d.consentLog.push({ t: VF.now(), key: k, value: val });
    VF.audit(u.id, 'consent-change', `${k} → ${val ? 'on' : 'off'}`);
    if (k === 'telematics') v.linked.status = val ? 'connected' : 'revoked';
    VF.save(); VF.rerender();
    VF.toast(val ? 'Sharing turned on' : 'Sharing turned off');
  }
  // Erasure: remove personal data, keep only pseudonymous billing records.
  VF.eraseDriver = function (driverId) {
    const d = VF.driver(driverId); const u = VF.user(d.userId); const v = VF.driverVehicle(driverId);
    u.name = 'Deleted user'; u.email = null; u.phone = null; u.deleted = true;
    d.deleted = true; d.consents = { telematics: false, shareSoc: false, shareEta: false, analytics: false, marketing: false }; d.consentLog = [];
    if (v) { v.plate = null; v.vin = null; v.trip = null; v.status = 'parked'; v.linked.status = 'revoked'; }
    VF.state.notices = VF.state.notices.filter((n) => n.driverId !== driverId);
  };
})();
