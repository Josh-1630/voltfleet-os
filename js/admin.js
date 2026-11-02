/* VoltFleet OS — super admin console.
   Sees the whole platform. Personal data is masked by default; revealing it needs a stated reason
   and writes to the audit log. Live driver locations are never shown, only zone counts of k or more. */
'use strict';
(function () {
  const { esc, clamp, sum, fmt, icon, pill } = VF;
  const MIN = VF.MIN, HOUR = VF.HOUR, DAY = VF.DAY;
  const ui = VF.ui.admin = { roleFilter: 'all', q: '', revealed: {}, revealing: null, auditFilter: 'all', confirmReset: false };
  const me = () => VF.user(VF.session.userId);

  function stationCls(st) {
    if (st.status !== 'online') return 'off';
    const free = st.connectors.filter((c) => c.status === 'Available').length;
    if (st.connectors.every((c) => c.status === 'Faulted' || c.status === 'Unavailable')) return 'off';
    if (st.connectors.some((c) => c.status === 'Faulted')) return free ? 'fault' : 'off';
    return free ? 'avail' : 'busy';
  }
  // Drivers heading to charge in the next hour, by zone; zones under k are hidden.
  function demandZones() {
    const now = VF.now(); const k = VF.state.settings.kAnon; const zones = {};
    for (const b of VF.state.bookings) if (b.status === 'confirmed' && b.start < now + HOUR) { const n = VF.station(b.stationId).node; zones[n] = (zones[n] || 0) + 1; }
    return Object.entries(zones).filter(([, n]) => n >= k).map(([node, n]) => ({ node, n }));
  }
  const allConns = () => VF.state.stations.flatMap((s) => s.connectors);
  const count = (s) => allConns().filter((c) => c.status === s).length;

  function kpis() {
    const s = VF.state; const t = VF.todayStats(() => true); const day0 = VF.startOfDay(VF.now());
    const drivers = s.drivers.filter((d) => !d.deleted);
    const linked = s.vehicles.filter((v) => v.linked && v.linked.status === 'connected');
    return [
      VF.kpi('Stations online', s.stations.filter((x) => x.status === 'online').length, `/ ${s.stations.length}`, `${s.operators.length} operators`),
      VF.kpi('Connectors free', count('Available'), `/ ${allConns().length}`, `${count('Faulted')} faulted`, count('Faulted') ? 'bad' : ''),
      VF.kpi('Charging now', count('Charging'), '', `${fmt.n(sum(s.stations, (st) => sum(st.connectors, (c) => (c.session ? c.session.kw : 0))))} kW network load`),
      VF.kpi('Bookings today', s.bookings.filter((b) => b.createdAt >= day0 || b.start >= day0).length, '', `${s.bookings.filter((b) => b.status === 'confirmed').length} upcoming`),
      VF.kpi('Energy today', fmt.n(t.kwh), 'kWh', `${t.sessions} sessions`),
      VF.kpi('Network revenue', fmt.money(t.revenue, 0), '', 'today, all operators'),
      VF.kpi('Drivers', drivers.length, '', `${linked.length} vehicles connected`),
    ].join('');
  }

  // ---------------------------------------------------------------- overview
  function pageOverview() {
    const s = VF.state;
    const oem = {}; for (const x of s.sessions) oem[x.oem] = (oem[x.oem] || 0) + 1;
    for (const st of s.stations) for (const c of st.connectors) if (c.session) oem[c.session.oem] = (oem[c.session.oem] || 0) + 1;
    const oemMax = Math.max(1, ...Object.values(oem));
    const open = s.alerts.filter((a) => !a.resolved).slice(0, 6);
    return `<section class="kpis kpis-7" data-live="ad-kpis">${kpis()}</section>
      <div class="grid g-main">
        <section class="panel"><div class="panel-head"><div><h2>Network map</h2><div class="sub">Stations by live status. Circles count drivers booked to arrive within the hour, shown only where ${s.settings.kAnon} or more.</div></div>
          <div class="legend"><span><i class="lg avail"></i>Free connectors</span><span><i class="lg busy"></i>All busy</span><span><i class="lg fault"></i>Has a fault</span><span><i class="lg off"></i>Offline</span></div></div>
          <div class="panel-body"><div class="map-wrap" data-live="ad-map">${mapHTML()}</div></div></section>
        <div class="stack">
          <section class="panel"><div class="panel-head"><h2>Operators</h2></div><div class="table-wrap"><table class="t"><thead><tr><th>Operator</th><th class="r">Stations</th><th class="r">In use</th><th class="r">Today</th></tr></thead><tbody data-live="ad-ops">${opsRows()}</tbody></table></div></section>
          <section class="panel"><div class="panel-head"><h2>System health</h2></div><div class="panel-body"><ul class="plain-list">
            <li><span>OCPP central system</span>${pill('ok', `${s.stations.filter((x) => x.status === 'online').length}/${s.stations.length} connected`)}</li>
            <li><span>Booking engine</span>${pill('ok', 'Running')}</li>
            <li><span>Vehicle data adapters</span>${pill('warn', `${VF.OEMS.filter((o) => o.status === 'pilot').length} pilot · ${VF.OEMS.filter((o) => o.status === 'planned').length} planned`)}</li>
            <li><span>SMS & push gateway</span>${pill('warn', 'Demo: in-app only')}</li>
            <li><span>Data residency</span>${pill('accent', 'Single region')}</li>
          </ul></div></section>
        </div>
      </div>
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><div><h2>Sessions by vehicle make</h2><div class="sub">Today, across all operators</div></div></div><div class="panel-body stack">${Object.entries(oem).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<div class="hbar"><span>${esc(k)}</span><div class="meter"><i style="width:${n / oemMax * 100}%"></i></div><span class="num">${n}</span></div>`).join('')}</div></section>
        <section class="panel"><div class="panel-head"><h2>Open alerts</h2><span class="faint small">all operators and platform</span></div><div>${open.length ? open.map((a) => VF.alertItem(a)).join('') : '<div class="empty">Nothing open.</div>'}</div></section>
      </div>`;
  }
  function mapHTML() {
    return VF.mapSVG({ stations: VF.state.stations.map((st) => ({ st, cls: stationCls(st), badge: st.connectors.filter((c) => c.status === 'Available').length, label: st.name.split(' ').slice(0, 2).join(' ') })), demand: demandZones(), label: 'Charging network' });
  }
  function opsRows() {
    return VF.state.operators.map((o) => {
      const sts = VF.state.stations.filter((s) => s.operatorId === o.id); const conns = sts.flatMap((s) => s.connectors);
      const t = VF.todayStats((id) => VF.station(id).operatorId === o.id);
      return `<tr><td class="strong">${esc(o.name)}</td><td class="r num">${sts.length}</td><td class="r num">${conns.filter((c) => c.status === 'Charging').length}/${conns.length}</td><td class="r num">${fmt.money(t.revenue, 0)}</td></tr>`;
    }).join('');
  }

  // ---------------------------------------------------------------- network
  function pageNetwork() {
    const s = VF.state; const h = VF.history();
    const util = {}; for (const r of h.rows) util[r.stationId] = (util[r.stationId] || 0) + r.util / h.days;
    const recent = s.bookings.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
    return `<section class="panel"><div class="panel-head"><div><h2>Stations</h2><div class="sub">All operators. Taking a station offline moves or cancels its bookings and tells affected drivers.</div></div><button class="btn small" data-act="ad-csv">${icon('download')}Sessions CSV (pseudonymous)</button></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>Station</th><th>Operator</th><th>Connectors</th><th>Live</th><th class="r">Load</th><th class="r">30-day util.</th><th>Status</th><th></th></tr></thead><tbody>
      ${s.stations.map((st) => { const n = (x) => st.connectors.filter((c) => c.status === x).length; return `<tr><td class="strong">${esc(st.name)}</td><td>${esc(VF.operator(st.operatorId).name)}</td><td class="small">${st.connectors.map((c) => esc(c.type)).join(' · ')}</td>
        <td class="small"><span class="ok-text">${n('Available')} free</span> · ${n('Charging')} charging · ${n('Reserved')} held${n('Faulted') ? ` · <span class="bad-text">${n('Faulted')} faulted</span>` : ''}</td>
        <td class="r num">${fmt.n(sum(st.connectors, (c) => (c.session ? c.session.kw : 0)))}/${st.capKw} kW</td><td class="r num">${Math.round(util[st.id] || 0)}%</td><td>${pill(st.status === 'online' ? 'ok' : 'warn', st.status === 'online' ? 'Online' : 'Offline')}</td>
        <td><button class="btn small ghost" data-act="ad-station" data-id="${st.id}">${st.status === 'online' ? 'Take offline' : 'Bring online'}</button></td></tr>`; }).join('')}
      </tbody></table></div></section>
      <section class="panel"><div class="panel-head"><div><h2>Latest bookings</h2><div class="sub">Network-wide. Drivers shown as platform pseudonyms.</div></div></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Code</th><th>Driver</th><th>Vehicle</th><th>Station</th><th>Slot</th><th>Source</th><th class="r">Est. revenue</th><th>Status</th></tr></thead><tbody>
        ${recent.map((b) => `<tr><td class="mono strong">${esc(b.code)}</td><td class="mono small">${esc(VF.pseudo(b.driverId))}</td><td>${esc(b.model)}</td><td>${esc(VF.station(b.stationId).name)}</td><td class="num">${VF.fmtDayTime(b.start)}</td><td>${b.source === 'auto' ? 'One-tap' : 'Manual'}</td><td class="r num">${fmt.money(b.actualCost != null ? b.actualCost : b.estCost)}</td><td>${VF.bookingPill(b)}</td></tr>`).join('')}
        </tbody></table></div></section>`;
  }

  // ---------------------------------------------------------------- vehicles & OEM integrations
  const COV = ['—', '◐', '●'];
  function pageVehicles() {
    const s = VF.state;
    const linkedBy = {}; for (const v of s.vehicles) if (v.linked && v.linked.status === 'connected') { const o = VF.model(v).oem; linkedBy[o] = (linkedBy[o] || 0) + 1; }
    const schema = { vehicle_id: 'veh_2f9c…', make: 'BYD', model: 'Atto 3', ports: ['CCS2', 'Type 2'], battery_kwh: 60.5, soc_pct: 41.2, range_km: 152, charging_state: 'not_charging', odometer_km: 18240, battery_temp_c: 31.4, location: '(on driver device only)', source: 'oem_api | aggregator | obd_dongle', observed_at: '2026-10-29T10:41:07Z' };
    return `<section class="panel"><div class="panel-head"><div><h2>Vehicle data connectors</h2><div class="sub">Every make lands in one vehicle record, so the rest of the platform doesn't care which brand it is</div></div></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>Make</th><th>How we connect</th><th>Driver sign-in</th><th class="r">Vehicles</th><th>Status</th></tr></thead><tbody>
      ${VF.OEMS.map((o) => `<tr><td class="strong">${esc(o.id)}</td><td>${esc(o.method)}</td><td class="small">${esc(o.auth)}</td><td class="r num">${linkedBy[o.id] || 0}</td><td>${pill(o.status === 'pilot' ? 'accent' : o.status === 'available' ? 'ok' : '', o.status === 'pilot' ? 'Pilot' : o.status === 'available' ? 'Available' : 'Planned')}</td></tr>`).join('')}
      </tbody></table></div></section>
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><div><h2>Data available by make</h2><div class="sub">● available · ◐ some models · — not available. Expected coverage; confirm during each integration.</div></div></div>
          <div class="table-wrap"><table class="t matrix"><thead><tr><th>Make</th>${VF.TELEMETRY_FIELDS.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${VF.OEMS.map((o) => `<tr><td class="strong">${esc(o.id)}</td>${o.cov.map((c) => `<td class="cov c${c}">${COV[c]}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>
        <section class="panel"><div class="panel-head"><div><h2>Plug compatibility</h2><div class="sub">Used by the booking engine to match cars to connectors</div></div></div>
          <div class="table-wrap"><table class="t matrix"><thead><tr><th>Model</th>${Object.keys(VF.CONNECTOR_TYPES).map((t) => `<th>${t}</th>`).join('')}</tr></thead><tbody>${Object.entries(VF.MODELS).map(([n, m]) => `<tr><td><strong>${esc(n)}</strong><div class="faint small">${esc(m.spec)}</div></td>${Object.keys(VF.CONNECTOR_TYPES).map((t) => `<td class="cov ${m.ports.includes(t) ? 'c2' : 'c0'}">${m.ports.includes(t) ? '●' : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>
      </div>
      <div class="grid g-main">
        <section class="panel"><div class="panel-head"><div><h2>Connected vehicles</h2><div class="sub">Owners shown as pseudonyms; plates masked</div></div></div>
          <div class="table-wrap" style="max-height:480px;overflow:auto"><table class="t"><thead><tr><th>Owner</th><th>Vehicle</th><th>Plugs</th><th>Plate</th><th>Data link</th></tr></thead><tbody>
          ${s.vehicles.map((v) => `<tr><td class="mono small">${esc(VF.pseudo(v.driverId))}</td><td>${esc(v.model)}</td><td class="small">${esc(VF.model(v).ports.join(', '))}</td><td class="mono small">${esc(VF.mask.plate(v.plate))}</td><td>${pill(v.linked.status === 'connected' ? 'ok' : 'warn', v.linked.status === 'connected' ? 'Connected' : 'Revoked')}</td></tr>`).join('')}
          </tbody></table></div></section>
        <section class="panel"><div class="panel-head"><div><h2>Unified vehicle record</h2><div class="sub">What every adapter produces</div></div><button class="btn small" data-act="ad-copy-schema">${icon('copy')}Copy</button></div><div class="panel-body"><pre class="code">${esc(JSON.stringify(schema, null, 2))}</pre></div></section>
      </div>`;
  }

  // ---------------------------------------------------------------- users
  const REASONS = ['Support ticket', 'Billing dispute', 'Legal or regulator request', 'Safety incident'];
  function pageUsers() {
    const s = VF.state; const q = ui.q.trim().toLowerCase();
    const list = s.users.filter((u) => (ui.roleFilter === 'all' || u.role === ui.roleFilter) && (!q || (u.role + (u.driverId ? VF.pseudo(u.driverId) : '') + (u.operatorId ? VF.operator(u.operatorId).name : '')).toLowerCase().includes(q)));
    const roleLabel = { manager: 'Fleet manager', driver: 'Driver', operator: 'Operator', admin: 'Super admin', developer: 'Developer' };
    return `<section class="panel"><div class="panel-head"><div class="row"><div class="seg" role="group">${[['all', 'All'], ['manager', 'Fleet'], ['driver', 'Drivers'], ['operator', 'Operators'], ['developer', 'Developers'], ['admin', 'Admins']].map(([k, l]) => `<button type="button" data-act="ad-role" data-k="${k}" aria-pressed="${ui.roleFilter === k}">${l}</button>`).join('')}</div>
        <input class="input" type="search" id="ad-q" data-inp="ad-q" placeholder="Search by ID, role or operator" value="${esc(ui.q)}"></div>
        <span class="faint small">${icon('lock')} Masked by default. Revealing is logged.</span></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>ID</th><th>Name</th><th>Role</th><th>Email</th><th>Phone</th><th>Joined</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((u) => {
        const open = ui.revealed[u.id]; const id = u.driverId ? VF.pseudo(u.driverId) : u.id;
        const action = u.deleted ? '' : open ? `<button class="btn small ghost" data-act="ad-hide" data-id="${u.id}">Hide</button>` : ui.revealing === u.id
          ? `<div class="reveal-box"><select class="select" id="rr-${u.id}">${REASONS.map((r) => `<option>${r}</option>`).join('')}</select><button class="btn small primary" data-act="ad-reveal-yes" data-id="${u.id}">Reveal</button><button class="btn small ghost" data-act="ad-reveal-no">Cancel</button></div>`
          : `<button class="btn small ghost" data-act="ad-reveal" data-id="${u.id}">${icon('eye')}Reveal</button>`;
        return `<tr><td class="mono small">${esc(id)}</td><td>${esc(u.deleted ? 'Deleted user' : open ? u.name : VF.mask.name(u.name))}</td><td>${roleLabel[u.role]}${u.operatorId ? ` <span class="faint small">${esc(VF.operator(u.operatorId).name)}</span>` : ''}${u.orgId ? ` <span class="faint small">${esc(s.connect.orgs.find((o) => o.id === u.orgId).name)}</span>` : ''}</td><td class="small">${esc(open ? u.email : VF.mask.email(u.email))}</td><td class="small num">${esc(open ? u.phone : VF.mask.phone(u.phone))}</td><td class="num small">${VF.fmtDate(u.joined)}</td><td>${u.deleted ? pill('', 'Deleted') : pill('ok', 'Active')}</td><td>${action}</td></tr>`;
      }).join('')}
      </tbody></table></div></section>`;
  }

  // ---------------------------------------------------------------- privacy & compliance
  function pagePrivacy() {
    const s = VF.state; const ds = s.drivers.filter((d) => !d.deleted);
    const rate = (k) => ds.filter((d) => d.consents[k]).length / Math.max(1, ds.length) * 100;
    const consentRows = [['telematics', 'Vehicle data connected'], ['shareSoc', 'Shares battery % with booked station'], ['shareEta', 'Shares live arrival time'], ['analytics', 'Anonymous analytics'], ['marketing', 'Marketing']];
    const actions = ['all', ...new Set(s.audit.map((a) => a.action))];
    const audit = s.audit.slice().sort((a, b) => b.t - a.t).filter((a) => ui.auditFilter === 'all' || a.action === ui.auditFilter).slice(0, 60);
    const ret = s.settings.retention;
    return `<section class="panel"><div class="panel-head"><div><h2>Who can see what</h2><div class="sub">Enforced in the app for each role</div></div></div>
      <div class="table-wrap"><table class="t access"><thead><tr><th>Data</th><th>Driver</th><th>Charge point operator</th><th>Super admin</th></tr></thead><tbody>${VF.ACCESS.map((r) => `<tr><td class="strong">${esc(r[0])}</td>${r.slice(1).map((x) => `<td class="${/^Never/.test(x) ? 'deny' : /^Own$|^Yes/.test(x) ? 'allow' : 'cond'}">${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><div><h2>Consent</h2><div class="sub">${ds.length} active drivers. Every change is logged with a timestamp.</div></div></div><div class="panel-body stack">${consentRows.map(([k, l]) => `<div class="hbar"><span>${l}</span><div class="meter"><i style="width:${rate(k)}%"></i></div><span class="num">${Math.round(rate(k))}%</span></div>`).join('')}</div></section>
        <section class="panel"><div class="panel-head"><div><h2>Data requests</h2><div class="sub">Access and erasure requests; answer within 30 days</div></div></div>
          <div class="table-wrap"><table class="t"><thead><tr><th>Type</th><th>Driver</th><th>Received</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>
          ${s.requests.slice(0, 12).map((r) => `<tr><td>${r.type === 'export' ? 'Copy of data' : 'Erasure'}</td><td class="mono small">${esc(VF.pseudo(r.driverId))}</td><td class="num small">${VF.fmtDate(r.t)}</td><td class="num small">${r.status === 'done' ? '—' : VF.fmtDate(r.t + 30 * DAY)}</td><td>${r.status === 'done' ? pill('ok', r.self ? 'Self-service' : 'Done') : pill('warn', 'Open')}</td><td>${r.status === 'open' ? `<button class="btn small" data-act="ad-req" data-id="${r.id}">${r.type === 'export' ? 'Send copy' : 'Erase'}</button>` : ''}</td></tr>`).join('')}
          </tbody></table></div></section>
      </div>
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><div><h2>Retention</h2><div class="sub">How long each kind of data is kept</div></div></div>
          <div class="panel-body form-grid">
            <label class="field"><span>Charging and billing records (days)</span><input class="input" id="ret-s" type="number" min="30" value="${ret.sessions}" data-chg="ad-ret" data-k="sessions"></label>
            <label class="field"><span>Live arrival times after a booking (days)</span><input class="input" id="ret-e" type="number" min="0" value="${ret.eta}" data-chg="ad-ret" data-k="eta"></label>
            <label class="field"><span>Audit log (days)</span><input class="input" id="ret-a" type="number" min="365" value="${ret.audit}" data-chg="ad-ret" data-k="audit"></label>
            <label class="field"><span>Grace before erasing a deleted account (days)</span><input class="input" id="ret-d" type="number" min="0" value="${ret.deletedAccount}" data-chg="ad-ret" data-k="deletedAccount"></label>
            <label class="field"><span>Smallest group shown on maps (k)</span><input class="input" id="ret-k" type="number" min="2" max="20" value="${s.settings.kAnon}" data-chg="ad-k"></label>
          </div>
          <div class="panel-body"><p class="faint small">GPS traces are not stored on the server at all. Location stays on the driver's phone; stations receive only an arrival time.</p></div></section>
        <section class="panel"><div class="panel-head"><div><h2>Built-in safeguards</h2></div></div><div class="panel-body"><ul class="check-list">
          <li>${icon('check')}<span><strong>Data minimisation.</strong> Stations get a booking code, vehicle model and, if the driver agrees, arrival time and battery %. Nothing else.</span></li>
          <li>${icon('check')}<span><strong>Unlinkable IDs.</strong> Each operator sees a different pseudonym for the same driver.</span></li>
          <li>${icon('check')}<span><strong>Masked by default.</strong> Staff see masked names, phones and plates. Revealing needs a reason and is logged.</span></li>
          <li>${icon('check')}<span><strong>Consent first.</strong> Vehicle data links use the driver's own sign-in with the carmaker and can be revoked in one tap.</span></li>
          <li>${icon('check')}<span><strong>Self-service rights.</strong> Drivers download or delete their data in the app; requests are tracked here.</span></li>
          <li>${icon('check')}<span><strong>Laws to map before launch.</strong> Ghana Data Protection Act 2012 (Act 843) and Data Protection Commission registration, plus GDPR, Kenya DPA 2019 and Nigeria NDPA 2023 for expansion.</span></li>
        </ul></div></section>
      </div>
      <section class="panel"><div class="panel-head"><div><h2>Audit log</h2><div class="sub">Personal-data access, exports, consent changes, remote commands and sign-ins</div></div><select class="select" id="ad-af" data-chg="ad-af">${actions.map((a) => `<option value="${a}" ${ui.auditFilter === a ? 'selected' : ''}>${a === 'all' ? 'All actions' : a}</option>`).join('')}</select></div>
        <div class="table-wrap" style="max-height:480px;overflow:auto"><table class="t"><thead><tr><th>Time</th><th>Who</th><th>Role</th><th>Action</th><th>Target</th><th>Reason</th></tr></thead><tbody>
        ${audit.map((a) => { const u = VF.user(a.actor); return `<tr><td class="num small">${VF.fmtStamp(a.t)}</td><td class="small">${u ? esc(u.role === 'driver' ? VF.pseudo(u.driverId) : u.name) : esc(a.actor)}</td><td class="small">${esc(a.role)}</td><td><span class="tag">${esc(a.action)}</span></td><td class="small">${esc(a.target)}</td><td class="small">${esc(a.reason || '—')}</td></tr>`; }).join('')}
        </tbody></table></div></section>`;
  }

  // ---------------------------------------------------------------- system
  function pageSystem() {
    const s = VF.state;
    return `<section class="panel"><div class="panel-head"><div><h2>Demo clock</h2><div class="sub">The live feed is simulated. Speed it up to watch trips, bookings and sessions play out.</div></div><span class="num strong" data-live="ad-clock">${VF.fmtDayTime(VF.now())}</span></div>
      <div class="panel-body row"><div class="seg" role="group">${[1, 5, 20, 60].map((x) => `<button type="button" data-act="ad-speed" data-x="${x}" aria-pressed="${s.clock.speed === x}">${x}×</button>`).join('')}</div>
        <button class="btn" data-act="ad-pause">${icon(s.clock.paused ? 'play' : 'pause')}${s.clock.paused ? 'Resume' : 'Pause'}</button></div></section>
    <section class="panel"><div class="panel-head"><div><h2>Shared demo world</h2><div class="sub">Every device that opens the demo sees the same stations, bookings and drivers</div></div>${VF.cloud && VF.cloud.online && VF.cloud.online() ? pill('ok', 'Synced across devices') : pill('warn', 'This device only')}</div>
      <div class="panel-body"><dl class="dl" data-live="ad-sync">${syncRows()}</dl></div></section>
    <section class="panel"><div class="panel-head"><h2>Platform settings</h2></div><div class="panel-body form-grid">
      <label class="field"><span>Currency code</span><input class="input" id="s-cur" maxlength="4" value="${esc(s.settings.currency)}" data-chg="ad-set" data-k="currency"></label>
      <label class="field"><span>Time zone (hours from GMT)</span><input class="input" id="s-tz" type="number" min="-12" max="14" value="${s.settings.tz}" data-chg="ad-set" data-k="tz"></label>
      <label class="field"><span>Driver battery reserve (%)</span><input class="input" id="s-res" type="number" min="5" max="30" value="${s.settings.reserve}" data-chg="ad-set" data-k="reserve"></label>
    </div></section>
    <section class="panel"><div class="panel-head"><div><h2>Demo data</h2><div class="sub">Everything is stored in this browser</div></div></div><div class="panel-body row">
      ${ui.confirmReset ? `<span class="confirm-inline"><strong>Reset all data to the demo${VF.cloud && VF.cloud.online && VF.cloud.online() ? ' for every device' : ''}?</strong><button class="btn small danger" data-act="ad-reset-yes">Yes, reset</button><button class="btn small" data-act="ad-reset-no">Cancel</button></span>` : `<button class="btn danger" data-act="ad-reset">Reset demo data</button>`}
    </div></section>`;
  }

  function syncRows() {
    const c = VF.cloud || {};
    const on = c.online && c.online();
    return `<dt>Backend</dt><dd>${on ? `Supabase · ${esc(c.region || '')}` : 'None (stored in this browser)'}</dd>
      <dt>Status</dt><dd>${esc(c.label ? c.label() : 'This device only')}${c.error ? ` <span class="faint small">${esc(c.error)}</span>` : ''}</dd>
      <dt>World revision</dt><dd class="num">${fmt.n(VF.state.rev || 0)}</dd>
      <dt>This device</dt><dd>${on ? (c.leader ? 'Running the simulation for everyone' : 'Following the live world') : 'Running its own simulation'}</dd>`;
  }

  // ---------------------------------------------------------------- live
  function structKey(page) {
    if (page === 'ad-overview') return page + VF.state.alerts.filter((a) => !a.resolved).map((a) => a.id).join() + VF.state.stations.map((s) => s.status).join();
    if (page === 'ad-network') return page + Math.floor(VF.now() / (2 * MIN)) + VF.state.bookings.length;
    if (page === 'ad-system') return page + VF.state.clock.speed + VF.state.clock.paused;
    return page;
  }
  function live(page) {
    if (page === 'ad-overview') return { 'ad-kpis': { html: kpis() }, 'ad-map': { html: mapHTML() }, 'ad-ops': { html: opsRows() } };
    if (page === 'ad-system') return { 'ad-clock': VF.fmtDayTime(VF.now()), 'ad-sync': { html: syncRows() } };
    return null;
  }

  VF.apps.admin = {
    home: 'ad-overview',
    roleLabel: () => 'VoltFleet platform',
    nav: [
      { id: 'ad-overview', label: 'Overview', icon: 'grid', title: 'Platform overview', eyebrow: 'Super admin' },
      { id: 'ad-network', label: 'Network', icon: 'network', title: 'Stations & bookings', eyebrow: 'Super admin' },
      { id: 'ad-vehicles', label: 'Vehicles & OEMs', icon: 'car', title: 'Vehicles & OEM integrations', eyebrow: 'Super admin' },
      { id: 'ad-users', label: 'Users', icon: 'users', title: 'Users & roles', eyebrow: 'Super admin' },
      { id: 'ad-privacy', label: 'Privacy', icon: 'shield', title: 'Privacy & compliance', eyebrow: 'Super admin' },
      { id: 'ad-system', label: 'System', icon: 'sliders', title: 'System', eyebrow: 'Super admin' },
    ],
    badge: (id) => (id === 'ad-privacy' ? VF.state.requests.filter((r) => r.status === 'open').length : 0),
    pages: { 'ad-overview': pageOverview, 'ad-network': pageNetwork, 'ad-vehicles': pageVehicles, 'ad-users': pageUsers, 'ad-privacy': pagePrivacy, 'ad-system': pageSystem },
    structKey, live,
    leave() { ui.revealed = {}; ui.revealing = null; },
  };

  Object.assign(VF.ACT, {
    'ad-role': (el) => { ui.roleFilter = el.dataset.k; VF.rerender(); },
    'ad-reveal': (el) => { ui.revealing = el.dataset.id; VF.rerender(); },
    'ad-reveal-no': () => { ui.revealing = null; VF.rerender(); },
    'ad-reveal-yes': (el) => {
      const u = VF.user(el.dataset.id); const reason = (document.getElementById('rr-' + u.id) || {}).value || REASONS[0];
      ui.revealed[u.id] = true; ui.revealing = null;
      VF.audit(me().id, 'reveal-pii', `${u.driverId ? VF.pseudo(u.driverId) : u.id} (name, email, phone)`, reason);
      VF.save(); VF.rerender(); VF.toast('Revealed until you leave this page. Logged in the audit trail.');
    },
    'ad-hide': (el) => { delete ui.revealed[el.dataset.id]; VF.rerender(); },
    'ad-req': (el) => {
      const r = VF.state.requests.find((x) => x.id === el.dataset.id); if (!r) return;
      if (r.type === 'erasure') { const b = VF.activeBooking(r.driverId); if (b) VF.cancelBooking(b.id, me().id, 'Account erased'); VF.eraseDriver(r.driverId); }
      r.status = 'done'; r.doneAt = VF.now();
      VF.audit(me().id, r.type === 'erasure' ? 'erasure' : 'data-export', VF.pseudo(r.driverId), 'Data subject request ' + r.id);
      VF.save(); VF.rerender(); VF.toast(r.type === 'erasure' ? 'Personal data erased; billing records kept under a pseudonym' : 'Copy of data sent to the driver');
    },
    'ad-station': (el) => {
      const st = VF.station(el.dataset.id);
      if (st.status === 'online') {
        st.status = 'offline'; let moved = 0, cancelled = 0;
        for (const c of st.connectors) { if (c.session) { VF.endSession(st, c, 'stopped'); } c.status = 'Unavailable'; c.until = null; c.reservedFor = null; }
        for (const b of VF.state.bookings.filter((x) => x.stationId === st.id && x.status === 'confirmed')) { VF.cancelBooking(b.id, me().id, 'Station offline'); cancelled++; if (!b.sim) VF.notify(b.driverId, 'Station offline: booking cancelled', `${st.name} went offline. No fee. Tap "Book on my route" for another slot.`); }
        VF.raiseAlert({ scope: st.operatorId, stationId: st.id, sev: 'warning', kind: 'Station offline', title: `${st.name} taken offline by platform admin`, body: `${cancelled} booking(s) cancelled and drivers notified.` });
        VF.toast(`${st.name} is offline. ${cancelled} booking(s) cancelled.${moved ? '' : ''}`);
      } else { st.status = 'online'; for (const c of st.connectors) { c.status = 'Available'; c.error = null; } VF.toast(`${st.name} is back online`); }
      VF.audit(me().id, 'station-status', `${st.name} → ${st.status}`); VF.save(); VF.rerender();
    },
    'ad-csv': () => {
      const csv = VF.csv([['session_id', 'operator', 'station', 'connector_type', 'vehicle_make', 'vehicle_model', 'driver_pseudonym', 'booked', 'start', 'end', 'kwh', 'revenue']]
        .concat(VF.state.sessions.map((x) => [x.id, VF.operator(x.operatorId).name, VF.station(x.stationId).name, x.type, x.oem, x.model, x.driverId ? VF.pseudo(x.driverId) : 'walk-in', x.bookingId ? 'yes' : 'no', new Date(x.start).toISOString(), new Date(x.end).toISOString(), x.kwh.toFixed(2), x.cost.toFixed(2)])));
      VF.audit(me().id, 'export', `Network sessions CSV, ${VF.state.sessions.length} rows (pseudonymous)`); VF.save();
      VF.downloadText('voltfleet-network-sessions.csv', csv);
    },
    'ad-copy-schema': () => VF.copyText(document.querySelector('pre.code').textContent, 'Schema'),
    'ad-speed': (el) => { VF.state.clock.speed = +el.dataset.x; VF.save(); VF.rerender(); },
    'ad-pause': () => { VF.state.clock.paused = !VF.state.clock.paused; VF.save(); VF.rerender(); },
    'ad-reset': () => { ui.confirmReset = true; VF.rerender(); },
    'ad-reset-no': () => { ui.confirmReset = false; VF.rerender(); },
    'ad-reset-yes': () => { ui.confirmReset = false; VF.reset(); VF.session = { userId: 'u-admin' }; VF.save(); VF.rerender(); VF.toast('Demo data restored'); },
  });
  Object.assign(VF.CHG, {
    'ad-ret': (el) => { const v = Number(el.value); if (v >= 0) { VF.state.settings.retention[el.dataset.k] = v; VF.audit(me().id, 'retention-change', `${el.dataset.k} = ${v} days`); VF.save(); VF.toast('Saved'); } },
    'ad-k': (el) => { const v = clamp(Math.round(Number(el.value) || 3), 2, 20); VF.state.settings.kAnon = v; VF.save(); VF.toast('Saved'); },
    'ad-af': (el) => { ui.auditFilter = el.value; VF.rerender(); },
    'ad-set': (el) => { const k = el.dataset.k; const v = k === 'currency' ? el.value.trim().toUpperCase() : Number(el.value); if (k === 'currency' ? v : !isNaN(v)) { VF.state.settings[k] = v; VF.save(); VF.toast('Saved'); } },
  });
  Object.assign(VF.INP, { 'ad-q': (el) => { ui.q = el.value; VF.rerender(true); } });
})();
