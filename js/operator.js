/* VoltFleet OS — charge point operator console (CSMS).
   Operators see only their own stations. Drivers appear as per-operator pseudonyms;
   battery % before arrival and live ETA appear only when the driver has agreed to share them. */
'use strict';
(function () {
  const { esc, clamp, sum, fmt, icon, pill } = VF;
  const MIN = VF.MIN, HOUR = VF.HOUR, DAY = VF.DAY;
  const ui = VF.ui.operator = { station: null, bookTab: 'upcoming', logStation: 'all', repDays: 30, seen: null, seenOp: null };

  const me = () => VF.user(VF.session.userId);
  const opId = () => me().operatorId;
  const op = () => VF.operator(opId());
  const myStations = () => VF.state.stations.filter((s) => s.operatorId === opId());
  const mine = (stationId) => VF.station(stationId) && VF.station(stationId).operatorId === opId();
  const who = (driverId) => VF.pseudo(driverId, opId());

  function sessionSoc(c) {
    const se = c.session; if (!se) return '—';
    if (!VF.isDC(c.type)) return 'n/a (AC)';
    return Math.round(se.soc) + '%';
  }
  const elapsed = (se) => fmt.dur((VF.now() - se.start) / MIN);
  function bookingEta(b) { return VF.consent(b.driverId, 'shareEta') ? VF.fmtTime(b.eta) : 'Slot only'; }
  function bookingSoc(b) { return VF.consent(b.driverId, 'shareSoc') ? Math.round(Math.max(0, b.arrivalSoc)) + '%' : 'Not shared'; }
  function stationLoad(st) { return sum(st.connectors, (c) => (c.session && c.status === 'Charging' ? c.session.kw : 0)); }
  function upcoming(hours) {
    const now = VF.now();
    return VF.state.bookings.filter((b) => mine(b.stationId) && b.status === 'confirmed' && b.start < now + hours * HOUR).sort((a, b) => a.start - b.start);
  }

  // ---------------------------------------------------------------- connector rows with remote commands
  function actions(c) {
    const b = (act, label, cls) => `<button class="btn small ${cls || ''}" data-act="op-cmd" data-c="${c.id}" data-cmd="${act}">${label}</button>`;
    if (c.status === 'Charging') return b('stop', 'Stop') + b('unlock', 'Unlock', 'ghost');
    if (c.status === 'Faulted') return b('reset', 'Reset', 'primary');
    if (c.status === 'Unavailable' && !c.until) return b('enable', 'Enable');
    if (c.status === 'Available' || c.status === 'Reserved') return b('disable', 'Disable', 'ghost');
    return '';
  }
  function connRow(c) {
    const se = c.session; const nb = VF.nextBooking(c); const res = c.reservedFor && VF.booking(c.reservedFor);
    let detail = '';
    if (se) {
      const bk = se.bookingId && VF.booking(se.bookingId);
      detail = `<div class="small"><strong>${esc(se.model)}</strong> · ${esc(se.driverId ? who(se.driverId) : 'Walk-in guest')}${bk ? ` · <span class="mono">${esc(bk.code)}</span>` : ''}</div>
        <div class="small num muted"><span data-live="${c.id}-soc">${sessionSoc(c)}</span> · <span data-live="${c.id}-kw">${fmt.kw(se.kw)}</span>${se.limited ? ' <span class="pill warn plain">limited</span>' : ''} · <span data-live="${c.id}-kwh">${fmt.kwh(se.kwh)}</span> · <span data-live="${c.id}-el">${elapsed(se)}</span></div>`;
    } else if (c.status === 'Faulted') detail = `<div class="small bad-text">${esc(c.error || 'Fault')}</div>`;
    else if (res) detail = `<div class="small">Held for <span class="mono">${esc(res.code)}</span> · ${esc(res.model)} · arrives ${bookingEta(res)}</div>`;
    else if (nb && nb.start - VF.now() < 60 * MIN) detail = `<div class="small"><span class="pill accent plain">Booked</span> <span class="mono">${esc(nb.code)}</span> · ${esc(nb.model)} · slot ${VF.fmtTime(nb.start)}, held from ${VF.fmtTime(nb.start - 15 * MIN)}</div>`;
    else if (nb) detail = `<div class="small muted">Next booking ${VF.fmtTime(nb.start)} · ${esc(nb.model)}</div>`;
    else detail = `<div class="small faint">${c.status === 'Finishing' ? 'Vehicle unplugging' : 'No booking in the next hours'}</div>`;
    return `<div class="conn-row"><div class="conn-id"><strong>${esc(c.label)}</strong><span class="faint small">${esc(c.type)} · ${c.kw} kW</span></div><div class="conn-status">${VF.connPill(c)}</div><div class="conn-detail">${detail}</div><div class="conn-act">${actions(c)}</div></div>`;
  }
  function stationCard(st) {
    const load = stationLoad(st);
    const samples = (VF.loadSamples[st.id] || []).map((x) => x.kw);
    return `<section class="panel st-card">
      <div class="st-head"><div><button class="link-btn" data-act="op-open" data-id="${st.id}"><h3>${esc(st.name)}</h3></button><div class="faint small">${esc(VF.PLACES[st.node].name)} · ${st.lb === 'priority' ? 'Bookings first' : 'Equal share'} load balancing</div></div>
        <div class="st-load"><span class="num"><strong data-live="${st.id}-load">${fmt.n(load)}</strong> / ${st.capKw} kW</span><span data-live="${st.id}-spark" class="spark-wrap">${VF.sparkline(samples, 120, 30, st.capKw)}</span></div></div>
      <div class="conn-list">${st.connectors.map(connRow).join('')}</div>
    </section>`;
  }
  function kpis() {
    const sts = myStations(); const conns = sts.flatMap((s) => s.connectors);
    const t = VF.todayStats(mine);
    const n = (s) => conns.filter((c) => c.status === s).length;
    return [
      VF.kpi('Available', n('Available'), `/ ${conns.length}`, 'connectors'),
      VF.kpi('Charging now', n('Charging'), '', `${fmt.n(sum(sts, stationLoad))} kW total`),
      VF.kpi('Upcoming bookings', VF.state.bookings.filter((b) => mine(b.stationId) && b.status === 'confirmed').length, '', `${n('Reserved')} connector${n('Reserved') === 1 ? '' : 's'} held now`),
      VF.kpi('Faulted', n('Faulted') + n('Unavailable'), '', n('Faulted') ? 'needs attention' : 'all healthy', n('Faulted') ? 'bad' : 'good'),
      VF.kpi('Energy today', fmt.n(t.kwh), 'kWh', `${t.sessions} sessions`),
      VF.kpi('Revenue today', fmt.money(t.revenue, 0), '', 'incl. live sessions'),
    ].join('');
  }
  function ocppList(filter, n) {
    const rows = VF.state.ocpp.filter((x) => mine(x.stationId) && (!filter || filter === 'all' || x.stationId === filter)).slice(0, n || 14);
    if (!rows.length) return '<div class="empty">No messages yet.</div>';
    return rows.map((x) => `<div class="log-row"><span class="t">${VF.fmtTime(x.t)}</span><span class="dir ${x.dir === '→' ? 'out' : 'in'}">${x.dir === '→' ? 'CSMS →' : '→ CSMS'}</span><span class="msg"><strong>${esc(x.action)}</strong> <span class="mono small">${esc((x.connId || '').replace(/^st-/, ''))}</span> <span class="muted">${esc(x.payload || '')}</span></span></div>`).join('');
  }
  function bookingItem(b) {
    const st = VF.station(b.stationId); const c = VF.connector(b.connectorId);
    return `<li><div><div><span class="mono strong">${esc(b.code)}</span> · ${esc(b.model)}</div><div class="small muted">${esc(st.name)} ${esc(c.label)} · ${esc(who(b.driverId))}</div></div>
      <div class="right"><div class="num strong">${VF.fmtTime(b.start)}</div><div class="small muted">ETA <span data-live="bk-${b.id}">${bookingEta(b)}</span> · ${bookingSoc(b)}</div></div></li>`;
  }

  // ---------------------------------------------------------------- pages
  function pageLive() {
    const up = upcoming(4);
    return `<section class="kpis" data-live="op-kpis">${kpis()}</section>
      <div class="grid g-main">
        <div class="st-grid">${myStations().map(stationCard).join('')}</div>
        <div class="stack">
          <section class="panel"><div class="panel-head"><div><h2>Arriving in the next 4 hours</h2><div class="sub">Slots are held for these drivers; walk-ins can't take them</div></div></div>
            <div class="panel-body">${up.length ? `<ul class="plain-list">${up.slice(0, 10).map(bookingItem).join('')}</ul>` : '<div class="empty">No bookings in the next 4 hours.</div>'}</div></section>
          <section class="panel"><div class="panel-head"><div><h2>OCPP messages</h2><div class="sub">Live traffic between your chargers and VoltFleet</div></div></div>
            <div class="panel-body log" data-live="op-log">${ocppList('all')}</div></section>
          <p class="faint small">${icon('lock')} Drivers appear as IDs unique to ${esc(op().name)}. Battery % before arrival and live ETA show only when the driver shares them. Battery % while charging comes from your DC chargers.</p>
        </div>
      </div>`;
  }

  function pageStations() {
    const sts = myStations();
    if (!ui.station || !mine(ui.station)) ui.station = sts[0].id;
    const st = VF.station(ui.station); const now = VF.now();
    const t0 = now - 3 * HOUR, t1 = now + 5 * HOUR;
    const rows = st.connectors.map((c) => ({ label: `${c.label} ${c.type} ${c.kw}` }));
    const past = VF.state.sessions.filter((x) => x.stationId === st.id && x.end > t0);
    const today = VF.state.sessions.filter((x) => x.stationId === st.id).slice(0, 25);
    return `<div class="row between"><div class="seg" role="group" aria-label="Station">${sts.map((s) => `<button type="button" data-act="op-open" data-id="${s.id}" aria-pressed="${s.id === st.id}">${esc(s.name)}</button>`).join('')}</div></div>
      <div class="grid g-main">
        <section class="panel"><div class="panel-head"><div><h2>Connector timeline</h2><div class="sub">Past 3 hours and next 5 hours: sessions, live charging and held booking slots</div></div>
          <div class="legend"><span><i style="background:var(--line-strong)"></i>Completed</span><span><i style="background:var(--charge)"></i>Charging (est. end)</span><span><i style="background:var(--accent)"></i>Booked slot</span></div></div>
          <div class="panel-body"><div class="chart-slot" data-chart="op-timeline"></div></div></section>
        <section class="panel"><div class="panel-head"><h2>Site</h2>${pill(st.status === 'online' ? 'ok' : 'warn', st.status === 'online' ? 'Online' : 'Offline')}</div>
          <div class="panel-body"><dl class="dl"><dt>Location</dt><dd>${esc(VF.PLACES[st.node].name)}</dd><dt>Grid connection limit</dt><dd class="num">${st.capKw} kW</dd><dt>Load now</dt><dd class="num" data-live="${st.id}-load">${fmt.n(stationLoad(st))}</dd><dt>Load balancing</dt><dd>${st.lb === 'priority' ? 'Bookings first' : 'Equal share'}</dd><dt>Connectors</dt><dd>${st.connectors.length}</dd><dt>Bookings next 8 h</dt><dd>${VF.state.bookings.filter((b) => b.stationId === st.id && b.status === 'confirmed' && b.start < now + 8 * HOUR).length}</dd></dl>
          <div class="spark-lg" data-live="${st.id}-spark">${VF.sparkline((VF.loadSamples[st.id] || []).map((x) => x.kw), 320, 60, st.capKw)}</div><div class="faint small">Site load, recent minutes. Dashed line: grid limit.</div></div></section>
      </div>
      <section class="panel"><div class="panel-head"><h2>Connectors</h2><span class="faint small">Commands are sent over OCPP and logged</span></div><div class="panel-body conn-list">${st.connectors.map(connRow).join('')}</div></section>
      <section class="panel"><div class="panel-head"><h2>Recent sessions</h2><button class="btn small" data-act="op-csv" data-scope="station">${icon('download')}CSV</button></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Ended</th><th>Connector</th><th>Vehicle</th><th>Driver</th><th>Booking</th><th class="r">Energy</th><th class="r">Revenue</th></tr></thead><tbody>
        ${today.map((x) => `<tr><td class="num">${VF.fmtTime(x.end)}</td><td>${esc(VF.connector(x.connectorId).label)} · ${esc(x.type)}</td><td>${esc(x.model)}</td><td class="mono small">${esc(x.driverId ? who(x.driverId) : 'Walk-in guest')}</td><td>${x.bookingId ? pill('accent plain', 'Booked') : '<span class="faint">Walk-in</span>'}</td><td class="r num">${fmt.kwh(x.kwh)}</td><td class="r num">${fmt.money(x.cost)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No sessions yet today.</td></tr>'}
        </tbody></table></div></section>`;
  }
  function drawTimeline(slot) {
    const st = VF.station(ui.station); if (!st) return;
    const now = VF.now(); const t0 = now - 3 * HOUR, t1 = now + 5 * HOUR;
    const rows = st.connectors.map((c) => ({ label: `${c.label} ${c.type}` }));
    const items = [];
    st.connectors.forEach((c, i) => {
      for (const x of VF.state.sessions) if (x.connectorId === c.id && x.end > t0) items.push({ row: i, start: x.start, end: x.end, cls: 'done', label: x.model, title: `${x.model} · ${fmt.kwh(x.kwh)} · ${VF.fmtTime(x.start)}–${VF.fmtTime(x.end)}` });
      if (c.session) { const end = VF.freeAt(c); items.push({ row: i, start: c.session.start, end, cls: 'live', label: c.session.model, title: `${c.session.model} · charging, est. done ${VF.fmtTime(end)}` }); }
      if (c.status === 'Faulted') items.push({ row: i, start: now - 20 * MIN, end: t1, cls: 'fault', label: 'Faulted', title: c.error });
      for (const b of VF.state.bookings) if (b.connectorId === c.id && b.status === 'confirmed') items.push({ row: i, start: b.start, end: b.end, cls: 'booked', label: b.code, title: `${b.code} · ${b.model} · ${VF.fmtTime(b.start)}–${VF.fmtTime(b.end)}` });
    });
    slot.innerHTML = VF.timeline(rows, items, t0, t1, Math.max(320, slot.clientWidth || 640), now);
  }

  function pageBookings() {
    const now = VF.now();
    const all = VF.state.bookings.filter((b) => mine(b.stationId));
    const tabs = { upcoming: (b) => b.status === 'confirmed', active: (b) => b.status === 'charging', past: (b) => !['confirmed', 'charging'].includes(b.status), all: () => true };
    const list = all.filter(tabs[ui.bookTab]).sort((a, b) => (ui.bookTab === 'past' ? b.start - a.start : a.start - b.start)).slice(0, 60);
    const p = op().pricing;
    const day0 = VF.startOfDay(now);
    const todays = all.filter((b) => b.start >= day0);
    const noShow = todays.filter((b) => b.status === 'no-show').length;
    return `<section class="kpis">${[
      VF.kpi('Upcoming', all.filter(tabs.upcoming).length, '', 'held slots'),
      VF.kpi('Charging now', all.filter(tabs.active).length, '', 'booked sessions'),
      VF.kpi('Booked today', todays.length, '', `${todays.filter((b) => b.source === 'auto').length} via one-tap`),
      VF.kpi('No-shows today', noShow, '', `${fmt.money(noShow * p.noShowFee, 0)} in fees`, noShow ? 'bad' : ''),
    ].join('')}</section>
    <section class="panel"><div class="panel-head"><div class="seg" role="group">${[['upcoming', 'Upcoming'], ['active', 'Charging'], ['past', 'Past'], ['all', 'All']].map(([k, l]) => `<button type="button" data-act="op-btab" data-k="${k}" aria-pressed="${ui.bookTab === k}">${l}</button>`).join('')}</div><span class="faint small">Driver IDs are unique to ${esc(op().name)}</span></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>Code</th><th>Driver</th><th>Vehicle</th><th>Station</th><th>Slot</th><th>ETA</th><th class="r">Battery on arrival</th><th class="r">Est. energy</th><th class="r">Est. revenue</th><th>Source</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((b) => { const st = VF.station(b.stationId); const c = VF.connector(b.connectorId); return `<tr><td class="mono strong">${esc(b.code)}</td><td class="mono small">${esc(who(b.driverId))}</td><td>${esc(b.model)}</td><td>${esc(st.name)} <span class="faint">${esc(c.label)}</span></td><td class="num">${VF.fmtDayTime(b.start)}–${VF.fmtTime(b.end)}</td><td class="num">${b.status === 'confirmed' ? bookingEta(b) : '—'}</td><td class="r num">${b.status === 'confirmed' ? bookingSoc(b) : '—'}</td><td class="r num">${fmt.kwh(b.actualKwh != null ? b.actualKwh : b.estKwh)}</td><td class="r num">${fmt.money(b.actualCost != null ? b.actualCost : b.estCost)}</td><td>${b.source === 'auto' ? 'One-tap' : 'Manual'}</td><td>${VF.bookingPill(b)}</td><td>${b.status === 'confirmed' ? `<button class="btn small ghost danger" data-act="op-bcancel" data-id="${b.id}">Cancel</button>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="12" class="empty">No bookings here.</td></tr>'}
      </tbody></table></div></section>
    <section class="panel"><div class="panel-head"><div><h2>Booking rules</h2><div class="sub">Apply to all ${esc(op().name)} stations</div></div></div>
      <div class="panel-body form-grid">
        ${[['graceMin', 'Hold after slot start (min)'], ['maxBookingMin', 'Longest slot (min)'], ['bookableShare', 'Bookable connectors (%)'], ['bookingFee', `Booking fee (${VF.state.settings.currency})`], ['noShowFee', `No-show fee (${VF.state.settings.currency})`]].map(([k, l]) => `<label class="field"><span>${l}</span><input class="input" id="p-${k}" type="number" min="0" step="${k.includes('Fee') ? '0.5' : '1'}" value="${p[k]}" data-chg="op-price" data-k="${k}"></label>`).join('')}
      </div></section>`;
  }

  function pagePricing() {
    const p = op().pricing; const now = VF.now();
    return `<section class="panel"><div class="panel-head"><div><h2>Energy prices</h2><div class="sub">Per kWh, by time of day, in ${esc(VF.state.settings.currency)}. Drivers see the price before they book.</div></div><div class="price-now">Now: <strong>${fmt.money(VF.priceAt(opId(), now, 'Type 2'))}</strong> AC · <strong>${fmt.money(VF.priceAt(opId(), now, 'CCS2'))}</strong> DC</div></div>
      <div class="panel-body stack">${p.bands.map((b, i) => `<div class="tariff-row"><label class="field"><span>Band</span><input class="input" id="b-name-${i}" value="${esc(b.name)}" data-chg="op-band" data-i="${i}" data-k="name"></label><label class="field"><span>From (hour)</span><input class="input" id="b-from-${i}" type="number" min="0" max="23" value="${b.from}" data-chg="op-band" data-i="${i}" data-k="from"></label><label class="field"><span>To (hour)</span><input class="input" id="b-to-${i}" type="number" min="0" max="24" value="${b.to}" data-chg="op-band" data-i="${i}" data-k="to"></label><label class="field"><span>Price per kWh</span><input class="input" id="b-price-${i}" type="number" min="0" step="0.05" value="${b.price}" data-chg="op-band" data-i="${i}" data-k="price"></label></div>`).join('')}
        <div class="form-grid">${[['dcPremium', 'DC fast-charging premium per kWh'], ['idleFeePerMin', 'Idle fee per minute after charging'], ['idleGraceMin', 'Idle grace (min)']].map(([k, l]) => `<label class="field"><span>${l}</span><input class="input" id="p-${k}" type="number" min="0" step="0.05" value="${p[k]}" data-chg="op-price" data-k="${k}"></label>`).join('')}</div></div></section>
      <section class="panel"><div class="panel-head"><div><h2>Smart charging</h2><div class="sub">Keeps each site under its grid connection limit by adjusting power per session (OCPP SetChargingProfile)</div></div></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Station</th><th>Connectors</th><th class="r">Max possible</th><th>Grid limit (kW)</th><th>When over the limit</th><th class="r">Load now</th></tr></thead><tbody>
        ${myStations().map((st) => `<tr><td class="strong">${esc(st.name)}</td><td class="small">${st.connectors.map((c) => `${c.type} ${c.kw}`).join(' · ')}</td><td class="r num">${fmt.n(sum(st.connectors, (c) => c.kw))} kW</td><td><input class="input" style="width:96px" id="cap-${st.id}" type="number" min="10" step="10" value="${st.capKw}" data-chg="op-cap" data-id="${st.id}"></td>
          <td><select class="select" id="lb-${st.id}" data-chg="op-lb" data-id="${st.id}"><option value="priority" ${st.lb === 'priority' ? 'selected' : ''}>Booked sessions first</option><option value="equal" ${st.lb === 'equal' ? 'selected' : ''}>Share equally</option></select></td><td class="r num" data-live="${st.id}-load">${fmt.n(stationLoad(st))}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="panel-body faint small">"Booked sessions first" protects the no-queue promise: drivers who booked keep full power and walk-ins share what's left.</div></section>`;
  }

  function pageReports() {
    const h = VF.history(); const days = ui.repDays;
    const rows = h.rows.filter((r) => r.operatorId === opId() && r.d >= h.days - days);
    const sts = myStations();
    const daily = []; for (let d = h.days - days; d < h.days; d++) { const dr = rows.filter((r) => r.d === d); const v = {}; sts.forEach((st, i) => { v['s' + i] = sum(dr.filter((r) => r.stationId === st.id), (r) => r.kwh); }); daily.push({ label: VF.fmtDate(h.day0 + d * DAY), values: v, booked: sum(dr, (r) => r.booked), walk: sum(dr, (r) => r.sessions - r.booked) }); }
    const tot = (f) => sum(rows, f);
    const bySt = sts.map((st) => { const r = rows.filter((x) => x.stationId === st.id); return { st, kwh: sum(r, (x) => x.kwh), rev: sum(r, (x) => x.revenue), ses: sum(r, (x) => x.sessions), booked: sum(r, (x) => x.booked), ns: sum(r, (x) => x.noShows), util: r.length ? sum(r, (x) => x.util) / r.length : 0 }; });
    const oem = {}; for (const x of VF.state.sessions) if (mine(x.stationId)) oem[x.oem] = (oem[x.oem] || 0) + 1;
    const oemMax = Math.max(1, ...Object.values(oem));
    return `<div class="row between"><div class="row"><div class="seg" role="group">${[7, 30].map((d) => `<button type="button" data-act="op-days" data-d="${d}" aria-pressed="${days === d}">Last ${d} days</button>`).join('')}</div><span class="demo-badge">Demo history</span></div><button class="btn" data-act="op-csv" data-scope="all">${icon('download')}Sessions CSV</button></div>
      <section class="kpis">${[
        VF.kpi('Energy delivered', fmt.n(tot((r) => r.kwh)), 'kWh', `${fmt.n(tot((r) => r.sessions))} sessions`),
        VF.kpi('Revenue', fmt.money(tot((r) => r.revenue), 0), '', 'energy + booking fees'),
        VF.kpi('Utilization', Math.round(sum(bySt, (x) => x.util) / Math.max(1, bySt.length)), '%', 'average across stations'),
        VF.kpi('Booked sessions', Math.round(tot((r) => r.booked) / Math.max(1, tot((r) => r.sessions)) * 100), '%', 'of all sessions'),
        VF.kpi('No-show rate', (tot((r) => r.noShows) / Math.max(1, tot((r) => r.booked)) * 100).toFixed(1), '%', 'of bookings'),
      ].join('')}</section>
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><div><h2>Energy by station</h2><div class="sub">kWh per day</div></div><div class="legend">${sts.map((st, i) => `<span><i class="s${i}"></i>${esc(st.name.split(' ')[0])}</span>`).join('')}</div></div><div class="panel-body"><div class="chart-slot" data-chart="op-energy"></div></div></section>
        <section class="panel"><div class="panel-head"><div><h2>Booked vs walk-in sessions</h2><div class="sub">Sessions per day</div></div><div class="legend"><span><i class="s1"></i>Booked</span><span><i style="background:var(--line-strong)"></i>Walk-in</span></div></div><div class="panel-body"><div class="chart-slot" data-chart="op-booked"></div></div></section>
      </div>
      <div class="grid g-main">
        <section class="panel"><div class="panel-head"><h2>Stations</h2></div><div class="table-wrap"><table class="t"><thead><tr><th>Station</th><th class="r">Sessions</th><th class="r">Energy</th><th class="r">Revenue</th><th class="r">Utilization</th><th class="r">Booked</th><th class="r">No-shows</th></tr></thead><tbody>
          ${bySt.map((x) => `<tr><td class="strong">${esc(x.st.name)}</td><td class="r num">${fmt.n(x.ses)}</td><td class="r num">${fmt.n(x.kwh)} kWh</td><td class="r num">${fmt.money(x.rev, 0)}</td><td class="r num">${Math.round(x.util)}%</td><td class="r num">${Math.round(x.booked / Math.max(1, x.ses) * 100)}%</td><td class="r num">${x.ns}</td></tr>`).join('')}</tbody></table></div></section>
        <section class="panel"><div class="panel-head"><div><h2>Vehicles by make</h2><div class="sub">Sessions today, from vehicle data shared at plug-in</div></div></div><div class="panel-body stack">${Object.entries(oem).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<div class="hbar"><span>${esc(k)}</span><div class="meter"><i style="width:${n / oemMax * 100}%"></i></div><span class="num">${n}</span></div>`).join('') || '<div class="empty">No sessions yet today.</div>'}</div></section>
      </div>`;
  }
  function drawReports(slot, kind) {
    const h = VF.history(); const days = ui.repDays; const sts = myStations();
    const rows = h.rows.filter((r) => r.operatorId === opId() && r.d >= h.days - days);
    const data = [];
    for (let d = h.days - days; d < h.days; d++) {
      const dr = rows.filter((r) => r.d === d); const label = VF.fmtDate(h.day0 + d * DAY);
      if (kind === 'op-energy') { const v = {}; sts.forEach((st, i) => { v['s' + i] = sum(dr.filter((r) => r.stationId === st.id), (r) => r.kwh); }); data.push({ label, values: v }); }
      else data.push({ label, values: { b: sum(dr, (r) => r.booked), w: sum(dr, (r) => r.sessions - r.booked) } });
    }
    const w = Math.max(300, slot.clientWidth || 600);
    slot.innerHTML = kind === 'op-energy'
      ? VF.barChart(data, sts.map((st, i) => ({ key: 's' + i, label: st.name, cls: 'bar s' + i })), w, { label: 'Energy by station', vFmt: (v) => fmt.kwh(v) })
      : VF.barChart(data, [{ key: 'b', label: 'Booked', cls: 'bar s1' }, { key: 'w', label: 'Walk-in', cls: 'bar muted-bar' }], w, { label: 'Booked vs walk-in sessions' });
  }

  function pageAlerts() {
    const list = VF.state.alerts.filter((a) => a.scope === opId());
    return `<div class="grid g-main">
      <section class="panel"><div class="panel-head"><h2>Alerts</h2><span class="faint small">${list.filter((a) => !a.resolved).length} open</span></div>
        <div>${list.length ? list.map((a) => VF.alertItem(a, 'op')).join('') : '<div class="empty">No alerts.</div>'}</div></section>
      <section class="panel"><div class="panel-head"><h2>OCPP message log</h2><select class="select" id="log-st" data-chg="op-logst"><option value="all">All stations</option>${myStations().map((s) => `<option value="${s.id}" ${ui.logStation === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
        <div class="panel-body log" data-live="op-log2" style="max-height:640px;overflow:auto">${ocppList(ui.logStation, 80)}</div></section>
    </div>`;
  }
  VF.alertItem = (a, ns) => `<div class="alert-item ${a.sev}${a.resolved ? ' done' : ''}"><span class="sev"></span><div class="stack" style="gap:3px"><div class="row" style="gap:8px"><strong>${esc(a.title)}</strong>${pill(a.sev === 'critical' ? 'bad plain' : a.sev === 'warning' ? 'warn plain' : 'accent plain', a.kind)}</div><div class="small">${esc(a.body)}</div><div class="faint small">${VF.relTime(a.t)}${a.resolved ? ' · resolved' : a.acked ? ' · acknowledged' : ''}</div></div>
    <div class="row" style="gap:6px;justify-content:flex-end">${!a.acked && !a.resolved ? `<button class="btn small" data-act="al-ack" data-id="${a.id}">Acknowledge</button>` : ''}${!a.resolved ? `<button class="btn small ghost" data-act="al-resolve" data-id="${a.id}">Resolve</button>` : ''}</div></div>`;

  // ---------------------------------------------------------------- live
  function structKey(page) {
    const sts = page === 'op-stations' ? [VF.station(ui.station)].filter(Boolean) : myStations();
    let k = page + '|' + sts.map((st) => st.connectors.map((c) => c.status[0] + (c.session ? c.session.id + (c.session.limited ? 'L' : '') : '') + (c.reservedFor || '')).join(',')).join(';');
    if (page === 'op-live' || page === 'op-bookings') k += '|' + VF.state.bookings.filter((b) => mine(b.stationId) && ['confirmed', 'charging'].includes(b.status)).map((b) => b.id + b.status[0]).join();
    if (page === 'op-alerts') k += '|' + VF.state.alerts.filter((a) => a.scope === opId()).map((a) => a.id + a.acked + a.resolved).join();
    if (page === 'op-stations') k += '|' + Math.floor(VF.now() / (5 * MIN));
    return k;
  }
  function live(page) {
    const v = {};
    const sts = page === 'op-stations' ? [VF.station(ui.station)].filter(Boolean) : myStations();
    for (const st of sts) {
      v[st.id + '-load'] = fmt.n(stationLoad(st));
      const samples = (VF.loadSamples[st.id] || []).map((x) => x.kw);
      v[st.id + '-spark'] = { html: page === 'op-stations' ? VF.sparkline(samples, 320, 60, st.capKw) : VF.sparkline(samples, 120, 30, st.capKw) };
      for (const c of st.connectors) if (c.session) Object.assign(v, { [c.id + '-soc']: sessionSoc(c), [c.id + '-kw']: fmt.kw(c.session.kw), [c.id + '-kwh']: fmt.kwh(c.session.kwh), [c.id + '-el']: elapsed(c.session) });
    }
    if (page === 'op-live') { v['op-kpis'] = { html: kpis() }; v['op-log'] = { html: ocppList('all') }; }
    if (page === 'op-alerts') v['op-log2'] = { html: ocppList(ui.logStation, 80) };
    for (const b of upcoming(4)) v['bk-' + b.id] = bookingEta(b);
    return v;
  }

  VF.apps.operator = {
    home: 'op-live',
    roleLabel: () => op().name,
    nav: [
      { id: 'op-live', label: 'Live', icon: 'grid', title: 'Live network', eyebrow: 'Charge point operator' },
      { id: 'op-stations', label: 'Stations', icon: 'plug', title: 'Stations & connectors', eyebrow: 'Charge point operator' },
      { id: 'op-bookings', label: 'Bookings', icon: 'calendar', title: 'Bookings', eyebrow: 'Charge point operator' },
      { id: 'op-pricing', label: 'Pricing & load', icon: 'tag', title: 'Pricing & smart charging', eyebrow: 'Charge point operator' },
      { id: 'op-reports', label: 'Reports', icon: 'chart', title: 'Reports', eyebrow: 'Charge point operator' },
      { id: 'op-alerts', label: 'Alerts & OCPP', icon: 'bell', title: 'Alerts & OCPP log', eyebrow: 'Charge point operator' },
    ],
    badge: (id) => (id === 'op-alerts' ? VF.state.alerts.filter((a) => a.scope === opId() && !a.acked && !a.resolved).length : 0),
    pages: { 'op-live': pageLive, 'op-stations': pageStations, 'op-bookings': pageBookings, 'op-pricing': pagePricing, 'op-reports': pageReports, 'op-alerts': pageAlerts },
    charts: { 'op-timeline': drawTimeline, 'op-energy': drawReports, 'op-booked': drawReports },
    structKey, live,
    // Called every second: tell the operator about bookings made in the driver app since they last looked.
    poll() {
      const mineNew = VF.state.alerts.filter((a) => a.scope === opId() && a.kind === 'New booking');
      if (!ui.seen || ui.seenOp !== opId()) { ui.seen = new Set(mineNew.map((a) => a.id)); ui.seenOp = opId(); return; }
      for (const a of mineNew) if (!ui.seen.has(a.id)) { ui.seen.add(a.id); VF.toast(a.title); }
    },
    leave() {},
  };

  // ---------------------------------------------------------------- actions
  function command(c, action) {
    const st = VF.stationOf(c.id); if (!mine(st.id)) return;
    const now = VF.now(); const names = { stop: 'RemoteStopTransaction', unlock: 'UnlockConnector', reset: 'Reset (Soft)', disable: 'ChangeAvailability Inoperative', enable: 'ChangeAvailability Operative' };
    VF.ocpp(st.id, c.id, '→', names[action], `by ${me().name.split(' ')[0]}`);
    let note = '';
    if (action === 'stop' && c.session) { VF.endSession(st, c, 'stopped'); c.status = 'Finishing'; c.until = now + 2 * MIN; }
    if (action === 'reset') { c.status = 'Unavailable'; c.until = now + 2 * MIN; c.error = null; VF.state.alerts.filter((a) => a.key === 'fault-' + c.id || (a.stationId === st.id && a.kind === 'Charger fault' && a.title.includes(c.label))).forEach((a) => { a.resolved = true; a.acked = true; }); }
    if (action === 'disable') { if (c.session) VF.endSession(st, c, 'stopped'); c.status = 'Unavailable'; c.until = null; c.reservedFor = null; const r = VF.moveBookings(st, c); if (r.moved || r.cancelled) note = ` ${r.moved} booking(s) moved, ${r.cancelled} cancelled.`; }
    if (action === 'enable') { c.status = 'Available'; }
    VF.ocpp(st.id, c.id, '←', names[action].split(' ')[0] + '.conf', 'Accepted');
    VF.audit(me().id, 'remote-command', `${st.name} ${c.label}: ${names[action]}`);
    VF.save(); VF.rerender();
    VF.toast(`${c.label} at ${st.name}: ${names[action]} accepted.${note}`);
  }
  Object.assign(VF.ACT, {
    'op-cmd': (el) => command(VF.connector(el.dataset.c), el.dataset.cmd),
    'op-open': (el) => { ui.station = el.dataset.id; if (VF.route() !== 'op-stations') location.hash = 'op-stations'; else VF.rerender(); },
    'op-btab': (el) => { ui.bookTab = el.dataset.k; VF.rerender(); },
    'op-days': (el) => { ui.repDays = +el.dataset.d; VF.rerender(); },
    'op-bcancel': (el) => {
      const b = VF.booking(el.dataset.id); if (!b || !mine(b.stationId)) return;
      VF.cancelBooking(b.id, me().id, 'Cancelled by operator');
      if (!b.sim) VF.notify(b.driverId, 'Booking cancelled by the station', `${VF.station(b.stationId).name} cancelled ${b.code}. No fee. Tap "Book on my route" for another slot.`);
      VF.audit(me().id, 'booking-cancel', b.code); VF.save(); VF.rerender(); VF.toast(`${b.code} cancelled. The driver was notified.`);
    },
    'op-csv': (el) => {
      const rows = VF.state.sessions.filter((x) => (el.dataset.scope === 'station' ? x.stationId === ui.station : mine(x.stationId)));
      const csv = VF.csv([['session_id', 'station', 'connector', 'type', 'vehicle_make', 'vehicle_model', 'driver_pseudonym', 'booked', 'start', 'end', 'kwh', 'revenue_' + VF.state.settings.currency.toLowerCase()]]
        .concat(rows.map((x) => [x.id, VF.station(x.stationId).name, VF.connector(x.connectorId).label, x.type, x.oem, x.model, x.driverId ? who(x.driverId) : 'walk-in', x.bookingId ? 'yes' : 'no', new Date(x.start).toISOString(), new Date(x.end).toISOString(), x.kwh.toFixed(2), x.cost.toFixed(2)])));
      VF.audit(me().id, 'export', `Sessions CSV, ${rows.length} rows (pseudonymous)`);
      VF.downloadText('voltfleet-sessions.csv', csv);
    },
    'al-ack': (el) => { const a = VF.state.alerts.find((x) => x.id === el.dataset.id); if (a) { a.acked = true; VF.save(); VF.rerender(); } },
    'al-resolve': (el) => { const a = VF.state.alerts.find((x) => x.id === el.dataset.id); if (a) { a.resolved = true; a.acked = true; VF.save(); VF.rerender(); } },
  });
  Object.assign(VF.CHG, {
    'op-price': (el) => { const v = Number(el.value); if (!isNaN(v) && v >= 0) { op().pricing[el.dataset.k] = v; VF.audit(me().id, 'pricing-change', `${el.dataset.k} = ${v}`); VF.save(); VF.toast('Saved'); } },
    'op-band': (el) => {
      const b = op().pricing.bands[+el.dataset.i]; const k = el.dataset.k;
      if (k === 'name') b.name = el.value.trim() || b.name; else { const v = Number(el.value); if (!isNaN(v)) b[k] = k === 'price' ? Math.max(0, v) : clamp(Math.round(v), 0, 24); }
      VF.audit(me().id, 'pricing-change', `band ${+el.dataset.i + 1} ${k}`); VF.save(); VF.rerender();
    },
    'op-cap': (el) => { const st = VF.station(el.dataset.id); const v = Number(el.value); if (mine(st.id) && v >= 10) { st.capKw = v; VF.save(); VF.toast(`${st.name} limit set to ${v} kW`); } },
    'op-lb': (el) => { const st = VF.station(el.dataset.id); if (mine(st.id)) { st.lb = el.value; VF.save(); VF.toast('Saved'); } },
    'op-logst': (el) => { ui.logStation = el.value; VF.rerender(); },
  });
})();
