/* VoltFleet OS — EV Manager data layer.
   A company fleet (vehicles, employee drivers, depots) living in the shared world. Fleet vehicles run delivery
   jobs, drain their batteries and charge at the public stations, so operators see them in their consoles too.
   SAMPLE DATA: everything below is simulated until telematics (VoltFleet Connect) and OCPP are connected. */
'use strict';
(function () {
  const { clamp, sum, pick, hash, mulberry32 } = VF;
  const MIN = VF.MIN, HOUR = VF.HOUR, DAY = VF.DAY;
  const DIESEL_KG_PER_KM = 0.29, GRID_KG_PER_KWH = 0.42; // diesel van baseline vs Ghana grid (approx.)
  VF.CO2 = { DIESEL_KG_PER_KM, GRID_KG_PER_KWH };

  const F = () => VF.state.fleet;
  VF.fleetVehicle = (id) => F() && F().vehicles.find((v) => v.id === id);
  VF.fleetDriver = (id) => F() && F().drivers.find((d) => d.id === id);
  VF.vehicleKind = (model) => (/Transit/.test(model) ? 'van' : /R1S|Model Y|Atto|Ioniq|EV6|ID\.4/.test(model) ? 'suv' : 'car');

  // ---------------------------------------------------------------- seed
  VF.seedFleet = function () {
    const s = VF.state; const now = VF.now(); const r = mulberry32(31);
    if (!s.users.some((u) => u.id === 'u-fm1')) s.users.unshift({ id: 'u-fm1', role: 'manager', name: 'Akosua Frimpong', email: 'akosua@greenline.example', phone: '+233 24 600 1180', demo: true, joined: now - 400 * DAY });
    const depots = [{ id: 'dp1', name: 'GreenLine HQ, Spintex', node: 'spintex' }, { id: 'dp2', name: 'Kaneshie Hub', node: 'kaneshie' }];
    const names = ['Kwabena Osei', 'Adjoa Mensah', 'Yaw Darko', 'Esi Ampofo', 'Kojo Badu', 'Abena Sarfo', 'Kofi Agyeman', 'Afua Boakye', 'Nii Armah', 'Ama Serwaa', 'Selasi Kumah', 'Kwame Ofori', 'Efua Amoako', 'Fiifi Quansah'];
    const drivers = names.map((n, i) => ({ id: 'fd' + (i + 1), name: n, phone: '+233 ' + pick(['24', '20', '54', '55'], r) + ' ' + (100 + Math.floor(r() * 900)) + ' ' + (1000 + Math.floor(r() * 9000)), license: 'DVLA-' + (100000 + Math.floor(r() * 899999)), hired: now - Math.floor(200 + r() * 1500) * DAY, score: Math.round(72 + r() * 26), vehicleId: null }));
    const spec = [
      ['Ford E-Transit', 'Van 01', 'dp1'], ['Ford E-Transit', 'Van 02', 'dp1'], ['Ford E-Transit', 'Van 03', 'dp2'], ['Ford E-Transit', 'Van 04', 'dp2'], ['Ford E-Transit', 'Van 05', 'dp1'],
      ['BYD Dolphin', 'Car 06', 'dp1'], ['BYD Dolphin', 'Car 07', 'dp2'], ['BYD Dolphin', 'Car 08', 'dp1'], ['BYD Dolphin', 'Car 09', 'dp2'],
      ['BYD Atto 3', 'SUV 10', 'dp1'], ['BYD Atto 3', 'SUV 11', 'dp2'], ['BYD Atto 3', 'SUV 12', 'dp1'],
      ['MG4', 'Car 13', 'dp2'], ['MG4', 'Car 14', 'dp1'], ['Hyundai Ioniq 5', 'Exec 15', 'dp1'], ['Kia EV6', 'Exec 16', 'dp2'],
    ];
    const statuses = ['in_use', 'in_use', 'in_use', 'charging', 'in_use', 'in_use', 'available', 'in_use', 'in_use', 'in_use', 'charging', 'available', 'in_use', 'offline', 'available', 'maintenance'];
    const vehicles = spec.map(([model, name, depot], i) => {
      const id = 'fv' + (i + 1);
      const v = {
        id, name, model, depot, plate: `G${pick(['R', 'R', 'E', 'T'], r)} ${2000 + Math.floor(r() * 7999)}-${pick(['23', '24', '25'], r)}`,
        vin: (VF.MODELS[model].oem.slice(0, 3).toUpperCase() + hash(id).slice(0, 8) + String(10000 + Math.floor(r() * 89999))).slice(0, 17),
        year: pick([2022, 2023, 2024, 2025], r), status: statuses[i], soc: 35 + r() * 55, odo: Math.round(6000 + r() * 60000),
        node: VF.depotNode(depot), trip: null, driverId: null, lastSeen: now, added: now - Math.floor(60 + r() * 600) * DAY,
        soh: Math.round(88 + r() * 11), tempC: +(28 + r() * 6).toFixed(1), tyres: [35, 35, 34, 35].map((p) => p + Math.round(r() * 2)), aux12v: +(12.3 + r() * 0.5).toFixed(1),
        nextServiceKm: 0, maintenance: [],
      };
      v.nextServiceKm = Math.ceil((v.odo + 2000 + r() * 8000) / 1000) * 1000;
      const kinds = [['Tyre rotation', 180], ['Brake inspection', 420], ['Cabin filter', 150], ['Software update', 0], ['Battery health check', 250], ['Wiper blades', 90]];
      for (let k = 0; k < 2 + Math.floor(r() * 3); k++) { const [type, cost] = pick(kinds, r); v.maintenance.push({ id: 'mr' + id + k, date: now - Math.floor(10 + r() * 300) * DAY, type, cost, odo: Math.max(1000, v.odo - Math.floor(r() * 9000)), notes: 'Completed at depot workshop' }); }
      v.maintenance.sort((a, b) => b.date - a.date);
      return v;
    });
    vehicles.forEach((v, i) => { if (i < drivers.length && v.status !== 'maintenance') { v.driverId = drivers[i].id; drivers[i].vehicleId = v.id; } });
    vehicles.find((v) => v.status === 'maintenance').maintenance.unshift({ id: 'mr-open', date: now - 2 * HOUR, type: 'Suspension noise check', cost: null, odo: 0, notes: 'In workshop. Expected back tomorrow.', open: true });
    const off = vehicles.find((v) => v.status === 'offline'); off.lastSeen = now - 3 * HOUR - 20 * MIN; off.node = 'osu';
    s.fleet = {
      org: { name: 'GreenLine Logistics', currency: s.settings.currency }, depots, vehicles, drivers, trips: [], plans: [],
      notices: [], prefs: { lowBattery: true, chargeDone: true, maintenance: true, offline: true, email: false }, lastT: now, seq: 1,
    };
    // Start the day: vehicles on jobs, two charging at the network.
    for (const v of vehicles) {
      if (v.status === 'in_use') { startJob(v, r); v.trip.doneKm = v.trip.totalKm * r() * 0.6; }
      if (v.status === 'charging') { v.soc = 18 + r() * 15; if (!plugIn(v, true)) v.status = 'available'; }
    }
    // Journey history for the last 10 days
    const nodes = Object.keys(VF.PLACES);
    for (let i = 0; i < 70; i++) {
      const v = pick(vehicles.filter((x) => x.driverId), r); const from = pick(nodes, r); let to = pick(nodes, r); if (to === from) to = 'tema';
      const km = VF.shortestPath(from, to).km; const start = now - Math.floor(r() * 10 * 24) * HOUR - Math.floor(r() * 50) * MIN;
      F().trips.push({ id: 'tr' + i, vehicleId: v.id, driverId: v.driverId, from, to, start, end: start + km / 28 * HOUR, km, kwh: km * VF.MODELS[v.model].eff * 1.08, purpose: 'delivery' });
    }
    F().trips.sort((a, b) => b.start - a.start);
    notice('info', 'Welcome to EV Manager', 'Your fleet data is simulated until vehicles are connected through VoltFleet Connect.', null, now - 26 * HOUR);
    notice('warning', `${off.name} stopped reporting`, `Last signal near Osu ${VF.relTime(off.lastSeen)}. The telematics unit may be unplugged.`, off.id, off.lastSeen + 15 * MIN);
    notice('warning', `${vehicles.find((v) => v.status === 'maintenance').name} is in the workshop`, 'Suspension noise check. Its driver has no vehicle today.', vehicles.find((v) => v.status === 'maintenance').id, now - 2 * HOUR);
  };
  VF.ensureFleet = () => { if (!VF.state.fleet) VF.seedFleet(); };
  VF.depotNode = (id) => ({ dp1: 'spintex', dp2: 'kaneshie' }[id] || (F() && (F().depots.find((d) => d.id === id) || {}).node) || 'spintex');

  function notice(sev, title, body, vehicleId, t) {
    const f = F(); f.notices.unshift({ id: 'fn' + (f.seq++), sev, title, body, vehicleId: vehicleId || null, t: t || VF.now(), read: false });
    if (f.notices.length > 150) f.notices.length = 150;
  }
  VF.fleetNotice = notice;

  // ---------------------------------------------------------------- simulation
  const SPEED = 28; // km/h average in Accra traffic
  function startJob(v, r) {
    r = r || Math.random;
    const home = VF.PLACES[VF.depotNode(v.depot)];
    const opts = Object.keys(VF.PLACES).filter((n) => n !== v.node && VF.hav(home, VF.PLACES[n]) < 16);
    const dest = pick(opts, r);
    v.trip = Object.assign(VF.makeTrip(VF.shortestPath(v.node, dest).path), { origin: v.node, dest, purpose: 'delivery', start: VF.now() });
    v.status = 'in_use';
  }
  function compatibleFree(v, station, durMin) {
    const m = VF.MODELS[v.model]; const now = VF.now();
    return station.status === 'online' ? station.connectors.filter((c) => VF.compatible(m, c.type) && c.status === 'Available' && VF.slotFree(c, now, now + durMin * MIN)).sort((a, b) => b.kw - a.kw)[0] || null : null;
  }
  function chargeMinutes(v, c) { const m = VF.MODELS[v.model]; return (85 - v.soc) / 100 * m.kwh / Math.max(3, VF.sessionMaxKw(c, m)) * 60 * 1.1; }
  // Best station to charge from where the vehicle is: closest with a compatible connector free now.
  VF.fleetChargeOptions = (v) => {
    const pos = v.trip && !v.trip.done ? VF.posAt(v.trip, v.trip.doneKm) : VF.PLACES[v.node];
    const here = VF.nearestNode(pos.lat, pos.lon); const m = VF.MODELS[v.model];
    return VF.state.stations.map((st) => {
      const comp = st.connectors.filter((c) => VF.compatible(m, c.type));
      const free = comp.find((c) => c.status === 'Available') || null;
      return { st, km: VF.shortestPath(here, st.node).km, comp, free, maxKw: Math.max(0, ...comp.map((c) => VF.sessionMaxKw(c, m))) };
    }).filter((o) => o.comp.length && o.st.status === 'online').sort((a, b) => (!!b.free - !!a.free) || a.km - b.km);
  };
  function goCharge(v, stationId) {
    const opts = VF.fleetChargeOptions(v);
    const o = stationId ? opts.find((x) => x.st.id === stationId) : opts.find((x) => x.free) || opts[0];
    if (!o) return false;
    const pos = v.trip && !v.trip.done ? VF.posAt(v.trip, v.trip.doneKm) : null;
    const from = pos ? VF.nearestNode(pos.lat, pos.lon) : v.node;
    v.trip = Object.assign(VF.makeTrip(VF.shortestPath(from, o.st.node).path, pos ? [pos.lat, pos.lon] : null), { origin: from, dest: o.st.node, purpose: 'charge', stationId: o.st.id, start: VF.now() });
    v.status = 'in_use';
    return o.st;
  }
  function plugIn(v, quiet) {
    const st = VF.state.stations.find((x) => x.node === v.node && (!v.trip || !v.trip.stationId || x.id === v.trip.stationId)) || VF.state.stations.find((x) => x.node === v.node);
    if (!st) return false;
    const probe = st.connectors.find((c) => VF.compatible(VF.MODELS[v.model], c.type));
    if (!probe) return false;
    const c = compatibleFree(v, st, chargeMinutes(v, probe));
    if (!c) { v.status = 'waiting'; return false; }
    VF.startSession(st, c, { model: v.model, soc: v.soc, target: 85, vehicleId: v.id, fleet: F().org.name }, null, quiet);
    v.status = 'charging'; v.trip = null; v.chargingAt = { stationId: st.id, connectorId: c.id };
    return true;
  }
  function finishTrip(v) {
    const t = v.trip; const m = VF.MODELS[v.model];
    v.node = t.dest; v.trip = null;
    if (t.purpose === 'charge') { if (!plugIn(v)) { v.status = 'waiting'; } return; }
    if (t.purpose !== 'return') F().trips.unshift({ id: 'tr' + (F().seq++), vehicleId: v.id, driverId: v.driverId, from: t.origin, to: t.dest, start: t.start || VF.now() - t.totalKm / SPEED * HOUR, end: VF.now(), km: t.totalKm, kwh: t.totalKm * m.eff * 1.08, purpose: t.purpose, planId: t.planId || null });
    if (F().trips.length > 400) F().trips.length = 400;
    if (t.planId) { const p = F().plans.find((x) => x.id === t.planId); if (p) { p.status = 'completed'; p.done = VF.now(); } }
    v.status = 'available';
  }
  function fleetTick() {
    const f = F(); if (!f) return;
    const now = VF.now(); const dt = Math.min(6, Math.max(0, (now - (f.lastT || now)) / MIN)); f.lastT = now;
    if (!dt) return;
    const h = VF.hourOf(now); const work = h >= 6 && h < 20;
    for (const v of f.vehicles) {
      if (v.status === 'maintenance' || v.status === 'offline') continue;
      v.lastSeen = now;
      const m = VF.MODELS[v.model];
      if (v.status === 'in_use' && v.trip) {
        const km = Math.min(SPEED * dt / 60, v.trip.totalKm - v.trip.doneKm);
        v.trip.doneKm += km; v.odo += km;
        v.soc = Math.max(1, v.soc - km * m.eff * 1.08 / m.kwh * 100);
        v.tempC = clamp(v.tempC + (Math.random() - 0.48) * 0.06, 26, 41);
        if (v.soc < 15 && !v.lowWarned) { v.lowWarned = true; if (f.prefs.lowBattery) notice('critical', `${v.name} battery at ${Math.round(v.soc)}%`, `${v.trip.purpose === 'charge' ? 'Already heading to a charger.' : 'Send it to a charger from My Vehicles.'}`, v.id); }
        if (v.trip.purpose !== 'charge' && (v.trip.purpose !== 'dispatch' ? v.soc < 18 : v.soc < 8)) goCharge(v);
        if (v.trip && v.trip.doneKm >= v.trip.totalKm - 1e-6) finishTrip(v);
      } else if (v.status === 'waiting') {
        plugIn(v);
      } else if (v.status === 'available') {
        if (v.soc < 30) goCharge(v);
        else if (work && Math.random() < 0.015 * dt) startJob(v);
        else if (!work && v.node !== VF.depotNode(v.depot)) { v.trip = Object.assign(VF.makeTrip(VF.shortestPath(v.node, VF.depotNode(v.depot)).path), { origin: v.node, dest: VF.depotNode(v.depot), purpose: 'return', start: now }); v.status = 'in_use'; }
      }
      if (v.soc > 25) v.lowWarned = false;
    }
  }
  VF.tickHooks = (VF.tickHooks || []).concat(fleetTick);
  function routeNodes(pts) { const nodes = []; for (let i = 0; i < pts.length - 1; i++) VF.shortestPath(pts[i], pts[i + 1]).path.forEach((n) => { if (nodes[nodes.length - 1] !== n) nodes.push(n); }); return nodes.length ? nodes : [pts[0]]; }
  function startRoute(v, pts, planId) {
    const pos = v.trip && !v.trip.done ? VF.posAt(v.trip, v.trip.doneKm) : null;
    const nodes = routeNodes(pts);
    v.trip = Object.assign(VF.makeTrip(nodes, pos ? [pos.lat, pos.lon] : null), { origin: pts[0], dest: nodes[nodes.length - 1], purpose: 'dispatch', planId, start: VF.now() });
    v.status = 'in_use';
  }
  const prevEnd = VF.onSessionEnd;
  VF.onSessionEnd = (se, station, c, reason) => {
    if (prevEnd) prevEnd(se, station, c, reason);
    const v = se.vehicleId && VF.fleetVehicle(se.vehicleId); if (!v) return;
    v.soc = se.soc; v.chargingAt = null; v.node = station.node;
    if (v.status === 'charging') v.status = 'available';
    if (v.pendingPlan) { const p = v.pendingPlan; v.pendingPlan = null; startRoute(v, p.pts, p.planId); }
    if (F().prefs.chargeDone) notice('info', `${v.name} finished charging`, `${VF.fmt.kwh(se.kwh)} at ${station.name} for ${VF.fmt.money(se.cost)}. Battery ${Math.round(se.soc)}%.`, v.id);
  };

  // ---------------------------------------------------------------- derived data
  VF.fleetPos = (v) => (v.trip && !v.trip.done ? VF.posAt(v.trip, v.trip.doneKm) : VF.PLACES[v.node] || VF.PLACES.spintex);
  VF.fleetPlace = (v) => { const p = VF.fleetPos(v); const st = v.chargingAt && VF.station(v.chargingAt.stationId); return st ? st.name : VF.PLACES[VF.nearestNode(p.lat, p.lon)].name; };
  VF.fleetRange = (v) => { const m = VF.MODELS[v.model]; return v.soc / 100 * m.kwh / (m.eff * 1.08); };
  VF.fleetSessions = () => VF.state.sessions.filter((x) => x.vehicleId && VF.fleetVehicle(x.vehicleId));
  VF.fleetLiveSessions = () => { const out = []; for (const st of VF.state.stations) for (const c of st.connectors) if (c.session && c.session.vehicleId && VF.fleetVehicle(c.session.vehicleId)) out.push({ st, c, se: c.session, v: VF.fleetVehicle(c.session.vehicleId) }); return out; };

  // 30 days of daily history per vehicle (SAMPLE DATA, deterministic), with today from the live simulation.
  let histCache = null;
  VF.fleetHistory = function () {
    const f = F(); const key = f.vehicles.map((v) => v.id + v.model).join() + JSON.stringify(VF.operator('op1').pricing.bands);
    const day0 = VF.startOfDay(VF.now()) - 29 * DAY;
    if (!histCache || histCache.key !== key || histCache.day0 !== day0) {
      const r = mulberry32(4242); const rows = [];
      for (let d = 0; d < 29; d++) for (const v of f.vehicles) {
        const m = VF.MODELS[v.model]; const dow = VF.startOfDay(day0 + d * DAY);
        const weekday = new Date(dow + 12 * HOUR).getUTCDay();
        const down = r() < 0.04;
        const km = down ? 0 : (VF.vehicleKind(v.model) === 'van' ? 110 : 75) * (0.6 + r() * 0.6) * (weekday === 0 ? 0.4 : weekday === 6 ? 0.75 : 1);
        const kwh = km * m.eff * (1.03 + r() * 0.1);
        const charged = kwh / 0.92;
        const peak = 0.12 + r() * 0.12, off = 0.35 + r() * 0.2;
        const bands = VF.operator('op1').pricing.bands.map((b) => +b.price);
        const price = off * bands[0] + (1 - off - peak) * bands[1] + peak * bands[2] + 0.25;
        rows.push({ d, date: day0 + d * DAY, vid: v.id, km, kwh, charged, cost: charged * price, hours: km / SPEED + (km ? 1.5 + r() : 0), sessions: km ? (r() < 0.6 ? 1 : 2) : 0, soh: v.soh + (29 - d) * 0.006, down, chargeHour: Math.floor(r() < 0.5 ? 18 + r() * 5 : 7 + r() * 9) });
      }
      histCache = { key, day0, rows };
    }
    // Today, from what the simulation actually did
    const today = VF.startOfDay(VF.now()); const rows = histCache.rows.slice();
    const tTrips = f.trips.filter((t) => t.end >= today); const tSess = VF.fleetSessions().filter((x) => x.end >= today);
    for (const v of f.vehicles) {
      const km = sum(tTrips.filter((t) => t.vehicleId === v.id), (t) => t.km); const se = tSess.filter((x) => x.vehicleId === v.id);
      rows.push({ d: 29, date: today, vid: v.id, km, kwh: km * VF.MODELS[v.model].eff * 1.08, charged: sum(se, (x) => x.kwh), cost: sum(se, (x) => x.cost), hours: km / SPEED, sessions: se.length, soh: v.soh, down: v.status === 'maintenance', chargeHour: se.length ? VF.hourOf(se[0].start) : null });
    }
    return rows;
  };
  // Totals and daily series for the last `days` days.
  VF.fleetMetrics = function (days) {
    const rows = VF.fleetHistory(); const from = 30 - days; const f = F();
    const sel = rows.filter((x) => x.d >= from);
    const daily = []; for (let d = from; d < 30; d++) { const dr = sel.filter((x) => x.d === d); daily.push({ d, date: dr[0] ? dr[0].date : 0, km: sum(dr, (x) => x.km), kwh: sum(dr, (x) => x.kwh), charged: sum(dr, (x) => x.charged), cost: sum(dr, (x) => x.cost), hours: sum(dr, (x) => x.hours), active: dr.filter((x) => x.km > 0).length, soh: sum(dr, (x) => x.soh) / Math.max(1, dr.length) }); }
    const tot = (k) => sum(daily, (x) => x[k]);
    const km = tot('km'), kwh = tot('kwh'), charged = tot('charged'), cost = tot('cost');
    return { days, daily, sel, km, kwh, charged, cost, co2: (km * DIESEL_KG_PER_KM - kwh * GRID_KG_PER_KWH) / 1000, per100: km ? kwh / km * 100 : 0, costPerKwh: charged ? cost / charged : 0, utilisation: tot('hours') / (f.vehicles.length * days * 12) * 100 };
  };
  // Compare the last 7 days with the 7 before.
  VF.fleetTrend = function (key) {
    const m = VF.fleetMetrics(14).daily; const a = sum(m.slice(7), (x) => x[key]), b = sum(m.slice(0, 7), (x) => x[key]);
    return b ? (a - b) / b * 100 : 0;
  };

  // ---------------------------------------------------------------- journey planning
  VF.planJourney = function (vehicleId, from, stops, ret, reserve) {
    const v = VF.fleetVehicle(vehicleId); const m = VF.MODELS[v.model];
    const pts = [from].concat(stops).concat(ret ? [from] : []);
    const legs = []; let soc = v.soc, km = 0, minutes = 0, failAt = -1;
    for (let i = 0; i < pts.length - 1; i++) {
      const sp = VF.shortestPath(pts[i], pts[i + 1]); const kwh = sp.km * m.eff * 1.08;
      soc -= kwh / m.kwh * 100; km += sp.km; minutes += sp.km / SPEED * 60 + (i < pts.length - 2 ? 10 : 0);
      if (soc < reserve && failAt < 0) failAt = i;
      legs.push({ from: pts[i], to: pts[i + 1], km: sp.km, kwh, soc, path: sp.path });
    }
    let stop = null;
    if (failAt >= 0) {
      // Suggest a station near the route before the leg that fails, with a compatible connector.
      const nodes = new Set(legs.slice(0, failAt + 1).flatMap((l) => l.path));
      const opts = VF.state.stations.filter((st) => st.status === 'online' && st.connectors.some((c) => VF.compatible(m, c.type)))
        .map((st) => ({ st, detour: Math.min(...[...nodes].map((n) => VF.shortestPath(n, st.node).km)) * 2 }))
        .sort((a, b) => a.detour - b.detour);
      if (opts[0]) {
        const o = opts[0]; const need = Math.min(90, Math.max(50, reserve + (km * m.eff * 1.08) / m.kwh * 100 - v.soc + reserve + 10));
        const kw = Math.max(...o.st.connectors.filter((c) => VF.compatible(m, c.type)).map((c) => VF.sessionMaxKw(c, m)));
        stop = { st: o.st, detour: o.detour, minutes: Math.round(need / 100 * m.kwh / kw * 60 * 1.1), kw, target: Math.round(need) };
      }
    }
    return { v, m, pts, legs, km, kwh: sum(legs, (l) => l.kwh), minutes, arriveSoc: soc, failAt, ok: failAt < 0, stop };
  };

  // ---------------------------------------------------------------- actions used by the pages
  VF.fleet = {
    addVehicle(d) {
      const f = F(); const id = 'fv' + (f.seq++) + Math.floor(Math.random() * 90 + 10);
      const v = { id, name: d.name, model: d.model, depot: d.depot, plate: d.plate.toUpperCase(), vin: d.vin.toUpperCase(), year: +d.year, status: 'available', soc: 80, odo: 0, node: VF.depotNode(d.depot), trip: null, driverId: null, lastSeen: VF.now(), added: VF.now(), soh: 100, tempC: 29, tyres: [36, 36, 36, 36], aux12v: 12.7, nextServiceKm: 15000, maintenance: [] };
      f.vehicles.push(v); notice('info', `${v.name} added to the fleet`, `${v.model} · ${v.plate}. Connect its telematics in Settings → Integrations for live data.`, v.id);
      return v;
    },
    updateVehicle(id, d) { const v = VF.fleetVehicle(id); Object.assign(v, { name: d.name, plate: d.plate.toUpperCase(), vin: d.vin.toUpperCase(), year: +d.year, depot: d.depot }); },
    removeVehicle(id) {
      const f = F(); const v = VF.fleetVehicle(id); if (!v) return;
      const live = VF.fleetLiveSessions().find((x) => x.v.id === id); if (live) { VF.endSession(live.st, live.c, 'stopped'); live.c.status = 'Finishing'; live.c.until = VF.now() + 2 * MIN; }
      const d = v.driverId && VF.fleetDriver(v.driverId); if (d) d.vehicleId = null;
      f.vehicles = f.vehicles.filter((x) => x.id !== id);
    },
    assign(vehicleId, driverId) {
      const v = VF.fleetVehicle(vehicleId); if (!v) return;
      if (v.driverId) { const old = VF.fleetDriver(v.driverId); if (old) old.vehicleId = null; }
      if (driverId) { const d = VF.fleetDriver(driverId); if (d.vehicleId) { const ov = VF.fleetVehicle(d.vehicleId); if (ov) ov.driverId = null; } d.vehicleId = v.id; v.driverId = d.id; } else v.driverId = null;
    },
    addDriver(d) { const f = F(); const dr = { id: 'fd' + (f.seq++) + Math.floor(Math.random() * 90 + 10), name: d.name, phone: d.phone, license: d.license.toUpperCase(), hired: VF.now(), score: 80, vehicleId: null }; f.drivers.push(dr); return dr; },
    removeDriver(id) { const f = F(); const d = VF.fleetDriver(id); if (d && d.vehicleId) { const v = VF.fleetVehicle(d.vehicleId); if (v) v.driverId = null; } f.drivers = f.drivers.filter((x) => x.id !== id); },
    sendToCharge(id, stationId) { const v = VF.fleetVehicle(id); if (!v || ['charging', 'maintenance', 'offline'].includes(v.status)) return null; return goCharge(v, stationId); },
    stopCharging(id) { const live = VF.fleetLiveSessions().find((x) => x.v.id === id); if (!live) return false; VF.ocpp(live.st.id, live.c.id, '→', 'RemoteStopTransaction', 'requested by EV Manager'); VF.endSession(live.st, live.c); live.c.status = 'Finishing'; live.c.until = VF.now() + 3 * MIN; return true; },
    setMaintenance(id, on, note) {
      const v = VF.fleetVehicle(id);
      if (on) { const live = VF.fleetLiveSessions().find((x) => x.v.id === id); if (live) VF.fleet.stopCharging(id); v.trip = null; v.status = 'maintenance'; v.maintenance.unshift({ id: 'mr' + (F().seq++), date: VF.now(), type: note || 'Workshop visit', cost: null, odo: Math.round(v.odo), notes: 'Opened from EV Manager', open: true }); }
      else { v.status = 'available'; v.maintenance.filter((x) => x.open).forEach((x) => { x.open = false; x.notes = 'Closed from EV Manager'; }); }
    },
    addMaintenance(id, d) { const v = VF.fleetVehicle(id); v.maintenance.unshift({ id: 'mr' + (F().seq++), date: VF.now(), type: d.type, cost: +d.cost || 0, odo: Math.round(v.odo), notes: d.notes || '' }); },
    dispatch(plan) {
      const v = VF.fleetVehicle(plan.vehicleId);
      const id = 'pl' + (F().seq++);
      if (v.status === 'charging') VF.fleet.stopCharging(v.id);
      if (plan.stop) {
        // Charge first, then run the journey from the station.
        goCharge(v, plan.stop.st.id);
        v.pendingPlan = { pts: [plan.stop.st.node].concat(plan.pts.slice(1)), planId: id };
      } else startRoute(v, plan.pts, id);
      F().plans.unshift({ id, vehicleId: v.id, driverId: v.driverId, pts: plan.pts, km: plan.km, kwh: plan.kwh, minutes: plan.minutes, created: VF.now(), status: 'in_progress', stop: plan.stop ? plan.stop.st.name : null });
      return id;
    },
  };
})();
