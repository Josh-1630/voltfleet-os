/* VoltFleet OS — Intelligence engine (v2 / long-term vision).
   Four optimisers that turn fleet data into decisions:
     1. Smart Charging 2.0 — a depot charging plan that meets every vehicle's next mission at the lowest cost (or carbon),
        using time-of-use tariffs, the depot's grid supply limit, rooftop solar, a depot battery and peak shaving.
     2. Predictive maintenance — per-component trend models on telemetry that estimate when a part crosses its limit.
     3. Route optimisation — assigns the day's jobs to vehicles and orders the stops, with an energy model for cargo,
        hills, weather, traffic and battery ageing.
     4. Vehicle-to-grid — parked vehicles sell stored energy back at the evening peak, then recharge off-peak in time.
   Weather comes from Open-Meteo (free, no key; only the fixed Accra coordinates are sent). Telemetry histories,
   jobs and depot assets are SAMPLE DATA until real vehicles, meters and chargers are connected. */
'use strict';
(function () {
  const { clamp, sum, hash, mulberry32 } = VF;
  const MIN = VF.MIN, HOUR = VF.HOUR, DAY = VF.DAY;
  const F = () => VF.state.fleet;
  const seed = (s) => parseInt(hash(s), 16);
  const I = VF.intel = {};

  // ================================================================ settings (kept with the fleet, synced)
  const DEPOT_DEFAULTS = {
    dp1: { gridKw: 160, solarKwp: 120, bessKwh: 200, bessKw: 90, ac: 10, acKw: 22, dc: 2, dcKw: 60, baseDay: 42, baseNight: 16 },
    dp2: { gridKw: 110, solarKwp: 60, bessKwh: 0, bessKw: 0, ac: 8, acKw: 22, dc: 1, dcKw: 60, baseDay: 26, baseNight: 9 },
  };
  const OTHER_DEPOT = { gridKw: 100, solarKwp: 0, bessKwh: 0, bessKw: 0, ac: 6, acKw: 22, dc: 1, dcKw: 60, baseDay: 20, baseNight: 8 };
  I.cfg = () => {
    const f = F(); if (!f) return null;
    const c = f.intel = f.intel || {};
    c.strategy = c.strategy || 'cost';
    c.tariff = Object.assign({ off: 1.55, std: 2.05, peak: 2.85, demand: 95, feedIn: 0.6 }, c.tariff);
    c.depots = c.depots || {};
    for (const d of f.depots) c.depots[d.id] = Object.assign({}, DEPOT_DEFAULTS[d.id] || OTHER_DEPOT, c.depots[d.id]);
    c.v2g = Object.assign({ on: true, scenario: 'fleet', floor: 40, exportPrice: 3.4, wear: 0.32, maxKw: 11, optOut: [] }, c.v2g);
    c.workOrders = c.workOrders || []; c.fixed = c.fixed || {};
    c.factors = Object.assign({ traffic: true, weather: true, terrain: true, cargo: true, ageing: true }, c.factors);
    return c;
  };
  // Time-of-use bands follow the network's tariff hours (off-peak 22–06, standard 06–17, peak 17–22).
  I.band = (h) => { const b = VF.operator('op1').pricing.bands; for (let i = 0; i < b.length; i++) { const a = +b[i].from, z = +b[i].to; if (a <= z ? h >= a && h < z : h >= a || h < z) return i; } return 1; };
  I.price = (h) => { const t = I.cfg().tariff; return [t.off, t.std, t.peak][I.band(h)]; };
  // Grid carbon intensity by hour, kg CO2/kWh (assumed profile: gas peaking plants run in the evening peak).
  I.carbon = (h) => (I.band(h) === 2 ? 0.47 : I.band(h) === 0 ? 0.37 : 0.41);
  const RESERVE = 15;

  // ================================================================ weather (Open-Meteo, cached 1 h)
  const WKEY = 'voltfleet-os:weather';
  const W = I.wx = { src: 'model', hours: null, at: 0, loading: false };
  try { const c = JSON.parse(localStorage.getItem(WKEY) || 'null'); if (c && Date.now() - c.at < HOUR && c.hours && c.hours.length >= 48) Object.assign(W, { src: 'open-meteo', hours: c.hours, at: c.at }); } catch (e) { /* none */ }
  I.loadWeather = async () => {
    if (W.loading || (W.src === 'open-meteo' && Date.now() - W.at < HOUR) || navigator.onLine === false) return;
    W.loading = true;
    try {
      const q = new URLSearchParams({ latitude: '5.60', longitude: '-0.19', hourly: 'temperature_2m,cloud_cover,precipitation_probability,precipitation,shortwave_radiation,wind_speed_10m', timezone: 'GMT', forecast_days: '2' });
      const r = await fetch('https://api.open-meteo.com/v1/forecast?' + q); if (!r.ok) throw new Error('weather ' + r.status);
      const j = await r.json(); const h = j.hourly;
      const hours = h.time.map((_, i) => ({ temp: h.temperature_2m[i], cloud: h.cloud_cover[i], rainP: h.precipitation_probability[i] || 0, rain: h.precipitation[i] || 0, rad: h.shortwave_radiation[i] || 0, wind: h.wind_speed_10m[i] || 0 }));
      if (hours.length < 48) throw new Error('short forecast');
      Object.assign(W, { src: 'open-meteo', hours, at: Date.now() });
      try { localStorage.setItem(WKEY, JSON.stringify({ at: W.at, hours })); } catch (e) { /* not kept */ }
      cache.clear(); if (VF.rerender) VF.rerender();
    } catch (e) { W.failed = true; } finally { W.loading = false; }
  };
  // Modelled weather when offline: Accra's daily cycle with a seeded cloud and shower pattern.
  function modelWx(day, h) {
    const r = mulberry32(seed('wx' + day)); const cloudBase = 30 + r() * 45, showers = r() < 0.35, showerAt = 13 + Math.floor(r() * 5);
    const cloud = clamp(cloudBase + Math.sin(h / 24 * Math.PI * 2) * 12 + (showers && Math.abs(h - showerAt) < 2 ? 35 : 0), 5, 100);
    const sunUp = h > 6 && h < 18; const clear = sunUp ? 960 * Math.sin(Math.PI * (h - 6) / 12) : 0;
    const rainP = showers && Math.abs(h - showerAt) < 3 ? 70 - Math.abs(h - showerAt) * 15 : 8;
    return { temp: 25 + 6 * Math.max(0, Math.sin(Math.PI * (h - 8) / 12)), cloud, rainP, rain: rainP > 50 ? 2.4 : 0, rad: clear * (1 - 0.72 * Math.pow(cloud / 100, 2.2)), wind: 9 + r() * 8 };
  }
  // Weather at a simulated time: the live forecast's today/tomorrow are mapped onto the simulation's today/tomorrow.
  I.weatherAt = (ms) => {
    const day0 = VF.startOfDay(VF.now()); const idx = Math.floor((ms - day0) / HOUR); const h = VF.hourOf(ms);
    if (W.hours && idx >= 0 && idx < W.hours.length) return W.hours[idx];
    return modelWx(Math.floor(VF.startOfDay(ms) / DAY), h);
  };
  I.weatherSource = () => (W.src === 'open-meteo' ? 'Open-Meteo forecast for Accra' : 'Modelled weather (offline)');
  const solarKw = (dep, ms) => dep.solarKwp * I.weatherAt(ms).rad / 1000 * 0.82;
  const baseKw = (dep, h) => (h >= 7 && h < 19 ? dep.baseDay : dep.baseNight) * (h >= 12 && h < 15 ? 1.1 : 1);

  // ================================================================ cache
  const cache = new Map();
  const memo = (key, fn) => { if (cache.has(key)) return cache.get(key); if (cache.size > 40) cache.clear(); const v = fn(); cache.set(key, v); return v; };
  const bucket = () => Math.floor(VF.now() / (15 * MIN));
  const cfgKey = () => JSON.stringify(I.cfg()) + (W.src) ;
  I.invalidate = () => cache.clear();

  // ================================================================ missions: when each vehicle leaves and how far it goes
  const kindOf = (v) => VF.vehicleKind(v.model);
  const isExec = (v) => /Ioniq|EV6|Model|Seal/.test(v.model);
  I.departure = (v) => {
    const now = VF.now(); const base = kindOf(v) === 'van' ? 6 : isExec(v) ? 8 : 7;
    const jitter = (seed(v.id + 'dep') % 4) * 15;
    let t = VF.startOfDay(now) + base * HOUR + jitter * MIN;
    if (t <= now + 30 * MIN) t += DAY;
    return t;
  };
  I.mission = (v, dep) => {
    const day = Math.floor(VF.startOfDay(dep) / DAY); const r = mulberry32(seed(v.id + 'm' + day)); const k = kindOf(v);
    const km = k === 'van' ? 85 + r() * 60 : isExec(v) ? 40 + r() * 40 : 55 + r() * 50;
    const kg = k === 'van' ? 400 + r() * 700 : 40 + r() * 110;
    return { km, kg };
  };
  // Energy per km on a typical mission, with cargo, heat and battery-ageing effects.
  function missionKwhPerKm(v, kg, wx) {
    const m = VF.MODELS[v.model]; const k = kindOf(v);
    const cargo = 1 + 0.07 * kg / 1000 * (k === 'van' ? 1 : 1.4);
    const heat = wx && wx.temp > 30 ? 1.05 : 1; const rain = wx && wx.rainP > 50 ? 1.06 : 1;
    const age = 1 + Math.max(0, 100 - v.soh) * 0.002;
    return m.eff * 1.08 * cargo * heat * rain * age;
  }
  function vehiclePlanInputs(v, dep) {
    const now = VF.now(); const m = VF.MODELS[v.model]; const h = VF.hourOf(now); const day = h >= 6 && h < 17;
    const home = VF.depotNode(v.depot); const p = VF.fleetPos(v); const here = VF.nearestNode(p.lat, p.lon);
    const atHome = here === home && !v.trip;
    let arr, soc = v.soc;
    const back = VF.shortestPath(here, home).km + (v.trip ? Math.max(0, v.trip.totalKm - v.trip.doneKm) : 0);
    if (day && !(atHome && v.status === 'available' && dep - now < 14 * HOUR)) {
      arr = VF.startOfDay(now) + 18 * HOUR + (seed(v.id + 'arr') % 9) * 15 * MIN;
      const drive = Math.max(0, (arr - now) / HOUR) * 0.5 * 28 + back;
      soc = soc - drive * m.eff * 1.08 / m.kwh * 100;
    } else {
      arr = now + (atHome ? 0 : Math.min(3 * HOUR, back / 28 * HOUR));
      soc = soc - back * m.eff * 1.08 / m.kwh * 100;
    }
    arr = Math.max(now, Math.min(arr, dep - HOUR));
    const mi = I.mission(v, dep); const wx = I.weatherAt(dep + 4 * HOUR);
    const usable = m.kwh * v.soh / 100; const perKm = missionKwhPerKm(v, mi.kg, wx);
    const target = clamp(Math.ceil((mi.km * perKm) / usable * 100 + RESERVE + 5), 45, 95);
    return { arr, arrSoc: clamp(soc, 8, 100), target, mission: mi, usable, perKm };
  }

  // ================================================================ 1. Smart Charging 2.0
  // V2G capability by model (bidirectional support varies by market and firmware: confirm with the OEM before enrolling).
  const V2G_CAP = {
    'Nissan Leaf': ['v2g', 'V2G (CHAdeMO)'], 'Hyundai Ioniq 5': ['pilot', 'V2L · V2G in pilots'], 'Kia EV6': ['pilot', 'V2L · V2G in pilots'],
    'BYD Atto 3': ['v2l', 'V2L only'], 'BYD Dolphin': ['v2l', 'V2L only'], 'BYD Seal': ['v2l', 'V2L only'], 'MG4': ['v2l', 'V2L only'],
    'Ford E-Transit': ['none', 'Not yet'], 'Tesla Model Y': ['none', 'Not yet'], 'Tesla Model 3': ['none', 'Not yet'], 'Rivian R1S': ['pilot', 'Bidirectional (US)'], 'Rivian R1T': ['pilot', 'Bidirectional (US)'],
  };
  I.v2gCap = (v) => V2G_CAP[v.model] || ['none', 'Unknown'];
  I.v2gEligible = (v) => { const c = I.cfg().v2g; if (!c.on || c.optOut.includes(v.id)) return false; const cap = I.v2gCap(v)[0]; return c.scenario === 'fleet' ? true : cap === 'v2g' || cap === 'pilot'; };

  function planDepot(depotId, strategy, opts) {
    const cfg = I.cfg(); const dep = cfg.depots[depotId]; const t = cfg.tariff; const now = VF.now();
    const t0 = Math.floor(now / HOUR) * HOUR; const N = 25;
    const slots = Array.from({ length: N }, (_, i) => { const ms = t0 + i * HOUR; const h = VF.hourOf(ms); return { i, ms, h, band: I.band(h), price: I.price(h), carbon: I.carbon(h), solar: solarKw(dep, ms + 30 * MIN), base: baseKw(dep, h), bess: 0, ev: 0, v2g: 0, evBase: 0, acUsed: 0, dcUsed: 0, acBase: 0, dcBase: 0 }; });
    const vs = VF.simVehicles().filter((v) => v.depot === depotId && !['maintenance', 'offline'].includes(v.status));
    const items = vs.map((v) => {
      const d = I.departure(v); const inp = vehiclePlanInputs(v, d); const m = VF.MODELS[v.model];
      const acP = Math.min(dep.acKw, m.ac); const dcP = Math.min(dep.dcKw, m.dc);
      const pres = slots.map((s) => clamp((Math.min(d, s.ms + HOUR) - Math.max(inp.arr, s.ms)) / HOUR, 0, 1));
      const needBatt = Math.max(0, (inp.target - inp.arrSoc) / 100 * inp.usable);
      const hours = sum(pres, (x) => x);
      const slack = hours - needBatt / 0.92 / acP;
      return { v, m, dep: d, arr: inp.arr, arrSoc: inp.arrSoc, target: inp.target, mission: inp.mission, perKm: inp.perKm, usable: inp.usable, pres, needBatt, acP, dcP, slack, kw: slots.map(() => 0), exp: slots.map(() => 0), mode: 'AC' };
    });
    // Depot battery: charged from midday solar, discharged into the evening peak.
    if (dep.bessKwh > 0) {
      let e = dep.bessKwh * 0.35;
      for (const s of slots) { if (s.band !== 2 && s.h >= 9 && s.h < 17) { const sur = Math.max(0, s.solar - s.base); const c = Math.min(sur, dep.bessKw, dep.bessKwh * 0.95 - e); if (c > 0) { s.bessIn = c; e += c * 0.92; } } }
      if (VF.hourOf(now) >= 17 || VF.hourOf(now) < 9) e = dep.bessKwh * 0.75; // already charged earlier today
      for (const s of slots.slice().filter((x) => x.band === 2).sort((a, b) => a.i - b.i)) { const d = Math.min(dep.bessKw, e); s.bess = d; e -= d; }
    }
    const net = (s) => s.base + s.ev + (s.bessIn || 0) - s.solar - s.bess - s.v2g;
    // Smart Queue: tightest windows first, then earliest departure.
    const queue = items.slice().sort((a, b) => a.slack - b.slack || a.dep - b.dep);
    queue.forEach((it, k) => { it.rank = k + 1; });
    // Vehicle-to-grid: export in the priciest hours while parked, if it can still refill in time.
    if (opts.v2g) {
      const c = cfg.v2g;
      for (const it of queue) {
        if (!I.v2gEligible(it.v)) continue;
        const floor = Math.max(c.floor, RESERVE + 10); let avail = (it.arrSoc - floor) / 100 * it.usable; if (avail < 3) continue;
        const offHours = sum(slots.filter((s) => s.band === 0), (s) => it.pres[s.i]);
        const refill = offHours * it.acP * 0.92 * 0.9 - it.needBatt; if (refill <= 2) continue;
        avail = Math.min(avail, refill);
        const peaks = slots.filter((s) => s.band === 2 && it.pres[s.i] > 0).sort((a, b) => b.price - a.price || a.i - b.i);
        for (const s of peaks) { if (avail <= 0.5) break; const e = Math.min(avail, c.maxKw * it.pres[s.i]); it.exp[s.i] = e; s.v2g += e; avail -= e; }
        const out = sum(it.exp, (x) => x); it.exported = out; it.needBatt += out / 0.92; // round trip back to the target
      }
    }
    // Charge allocation: fill each vehicle's energy in its cheapest available hours, never above the supply limit.
    const peakSoFar = () => Math.max(0, ...slots.map(net));
    for (const it of queue) {
      let need = it.needBatt / 0.92; let guard = 0;
      const tryMode = (P, mode) => {
        while (need > 0.05 && guard++ < 4000) {
          let best = null, bestCost = Infinity; const pk = peakSoFar();
          for (const s of slots) {
            const room = P * it.pres[s.i] - it.kw[s.i]; if (room <= 0.05 || it.exp[s.i] > 0) continue;
            const busy = it.kw[s.i] > 0; if (!busy && (mode === 'AC' ? s.acUsed >= dep.ac : s.dcUsed >= dep.dc)) continue;
            const chunk = Math.min(2, room, need); const n0 = net(s); const n1 = n0 + chunk;
            if (n1 > dep.gridKw + 1e-6) continue;
            const green = Math.max(0, Math.min(chunk, -n0)); const grid = chunk - green;
            let cost;
            if (strategy === 'ready') cost = s.i * 10 + (n1 > pk ? 0.01 : 0);
            else if (strategy === 'green') cost = (grid * s.carbon * 10 + green * 0.2) / chunk + s.price * 0.05;
            else cost = (green * t.feedIn + grid * s.price + Math.max(0, n1 - pk) * t.demand / 30) / chunk;
            cost += s.i * 1e-4; // ties: earlier
            if (cost < bestCost) { bestCost = cost; best = { s, chunk }; }
          }
          if (!best) return;
          if (!it.kw[best.s.i]) { if (mode === 'AC') best.s.acUsed++; else best.s.dcUsed++; }
          it.kw[best.s.i] += best.chunk; best.s.ev += best.chunk; need -= best.chunk;
        }
      };
      tryMode(it.acP, 'AC');
      if (need > 0.05 && dep.dc > 0 && it.dcP > it.acP) { it.mode = 'AC+DC'; tryMode(it.dcP, 'DC'); }
      it.short = Math.max(0, need) * 0.92;
      it.endSoc = Math.min(100, it.arrSoc + (sum(it.kw, (x) => x) * 0.92 - (it.exported || 0)) / it.usable * 100);
      it.ready = it.endSoc >= it.target - 0.5;
      const on = it.kw.map((x, i) => x > 0.05 ? i : -1).filter((i) => i >= 0);
      it.start = on.length ? slots[on[0]].ms : null; it.end = on.length ? slots[on[on.length - 1]].ms + HOUR : null;
    }
    // Baseline: plug in and charge at full power on arrival (no plan, no battery dispatch, no V2G).
    const fcfs = items.slice().sort((a, b) => a.arr - b.arr);
    for (const it of fcfs) {
      let need = Math.max(0, (it.target - it.arrSoc) / 100 * it.usable) / 0.92; it.kwBase = slots.map(() => 0);
      for (const s of slots) { if (need <= 0) break; const p = it.acP * it.pres[s.i]; if (p <= 0) continue; if (s.acBase >= dep.ac) continue; s.acBase++; const e = Math.min(p, need); it.kwBase[s.i] = e; s.evBase += e; need -= e; }
    }
    // Totals
    let cost = 0, costBase = 0, co2 = 0, co2Base = 0, green = 0, imp = 0, impBase = 0, exportKwh = 0;
    for (const s of slots) {
      const n = net(s); s.import = Math.max(0, n); s.exported = Math.max(0, -n);
      const nb = s.base + s.evBase - s.solar; s.importBase = Math.max(0, nb);
      // Energy that charges vehicles: what share came from solar or the depot battery
      const greenAvail = Math.max(0, s.solar + s.bess + s.v2g - s.base - (s.bessIn || 0)); s.evGreen = Math.min(s.ev, greenAvail); green += s.evGreen;
      cost += s.import * s.price - Math.max(0, -(n + s.v2g)) * t.feedIn; costBase += s.importBase * s.price - Math.max(0, -nb) * t.feedIn;
      co2 += s.import * s.carbon; co2Base += s.importBase * s.carbon; imp += s.import; impBase += s.importBase;
    }
    for (const it of items) exportKwh += it.exported || 0;
    const peak = Math.max(0, ...slots.map((s) => s.import)), peakBase = Math.max(0, ...slots.map((s) => s.importBase));
    // Daily share of the monthly demand charge
    const demand = peak * t.demand / 30, demandBase = peakBase * t.demand / 30;
    const v2gValue = exportKwh * (cfg.v2g.exportPrice - t.peak) ; // export credit above what the site would have paid
    return { depotId, dep, slots, items, queue, cost: cost + demand, costBase: costBase + demandBase, energyCost: cost, demand, demandBase, peak, peakBase, co2, co2Base, green, evKwh: sum(slots, (s) => s.ev), imp, impBase, exportKwh, v2gValue, overBase: peakBase > dep.gridKw };
  }
  // Fleet plan (all depots). opts.v2g defaults to the V2G programme setting.
  I.plan = (strategy, opts) => {
    const cfg = I.cfg(); if (!cfg) return null; strategy = strategy || cfg.strategy; opts = Object.assign({ v2g: cfg.v2g.on }, opts);
    return memo('plan|' + strategy + '|' + opts.v2g + '|' + bucket() + '|' + cfgKey() + VF.simVehicles().map((v) => v.id + v.status[0] + v.depot).join(), () => {
      const depots = F().depots.map((d) => planDepot(d.id, strategy, opts));
      const tot = (k) => sum(depots, (p) => p[k]);
      const items = depots.flatMap((p) => p.items);
      const evKwh = tot('evKwh');
      return { strategy, depots, items, cost: tot('cost'), costBase: tot('costBase'), peak: tot('peak'), peakBase: tot('peakBase'), co2: tot('co2'), co2Base: tot('co2Base'), green: tot('green'), evKwh, exportKwh: tot('exportKwh'),
        savings: tot('costBase') - tot('cost'), savingsPct: tot('costBase') > 0 ? (1 - tot('cost') / tot('costBase')) * 100 : 0, greenPct: evKwh ? tot('green') / evKwh * 100 : 0,
        ready: items.filter((x) => x.ready).length, total: items.length, slots0: depots[0] ? depots[0].slots.map((s) => s.ms) : [] };
    });
  };

  // ================================================================ 4. Vehicle-to-grid economics
  I.v2g = () => {
    const cfg = I.cfg(); const p = I.plan(cfg.strategy, { v2g: true }); const t = cfg.tariff; const c = cfg.v2g;
    const rows = p.items.map((it) => {
      const out = it.exported || 0; const cap = I.v2gCap(it.v);
      const revenue = out * c.exportPrice; const recharge = out / 0.92 / 0.92 * t.off; const wear = out * c.wear;
      return { it, v: it.v, cap, eligible: I.v2gEligible(it.v), out, revenue, recharge, wear, net: revenue - recharge - wear, availKwh: Math.max(0, (it.arrSoc - Math.max(c.floor, RESERVE + 10)) / 100 * it.usable) };
    });
    const by = (k) => sum(rows, (r) => r[k]);
    const hours = p.depots[0] ? p.depots[0].slots.map((s, i) => ({ ms: s.ms, h: s.h, band: s.band, price: s.price, out: sum(p.depots, (d) => d.slots[i].v2g), inn: sum(p.items, (it) => it.kw[i] || 0) })) : [];
    const parked = rows.filter((r) => r.eligible && (r.it.arr <= VF.now() + 5 * MIN));
    return { p, rows, hours, out: by('out'), revenue: by('revenue'), recharge: by('recharge'), wear: by('wear'), net: by('net'), enrolled: rows.filter((r) => r.eligible).length, capKw: rows.filter((r) => r.eligible).length * c.maxKw, availKwh: sum(rows.filter((r) => r.eligible), (r) => r.availKwh), parkedKw: parked.length * c.maxKw };
  };
  // Live grid event (demand response): parked enrolled vehicles export now.
  I.eventLive = () => {
    const e = I.cfg().event; if (!e || VF.now() > e.end) return null;
    const v = I.v2g(); const parked = v.rows.filter((r) => r.eligible && ['available', 'charging', 'waiting'].includes(r.v.status) && r.v.soc > I.cfg().v2g.floor + 2);
    const kw = parked.length * I.cfg().v2g.maxKw * (0.92 + 0.06 * Math.sin(VF.now() / MIN / 3));
    return { e, parked, kw, kwh: e.kwh || 0, left: e.end - VF.now() };
  };
  function eventTick() {
    const f = F(); const e = f && f.intel && f.intel.event; if (!e || e.done) return;
    const now = VF.now(); const dt = Math.max(0, Math.min(6 * MIN, now - (e.lastT || now))); e.lastT = now;
    if (now > e.end) { e.done = true; VF.fleetNotice('info', 'Grid event finished', `Fleet exported ${VF.fmt.kwh(e.kwh || 0)} for ${VF.fmt.money((e.kwh || 0) * I.cfg().v2g.exportPrice)} in credits. Vehicles are recharging off-peak to their mission targets.`); return; }
    const live = I.eventLive(); if (!live) return;
    e.kwh = (e.kwh || 0) + live.kw * dt / HOUR;
    const per = live.parked.length ? live.kw * dt / HOUR / live.parked.length : 0;
    for (const r of live.parked) { const m = VF.MODELS[r.v.model]; r.v.soc = Math.max(I.cfg().v2g.floor, r.v.soc - per / m.kwh * 100); }
  }
  VF.tickHooks = (VF.tickHooks || []).concat(eventTick);

  // ================================================================ 2. Predictive maintenance
  // Each component has a monitored signal, a limit and a direction. Daily histories are SAMPLE DATA.
  const COMP = [
    { k: 'battery', label: 'HV battery', icon: 'battery-full', signal: 'State of health', unit: '%', limit: 80, dir: -1, dec: 1, fix: 'Book a high-voltage battery health check with the dealer; balance-charge to 100% overnight once a week.', cost: 450, unplanned: 2600, days: 2 },
    { k: 'thermal', label: 'Cooling system', icon: 'thermometer', signal: 'Peak pack temperature on DC charge', unit: '°C', limit: 48, dir: 1, dec: 1, fix: 'Check coolant level and pump; cap DC charging at 60 kW until inspected.', cost: 380, unplanned: 3200, days: 3 },
    { k: 'aux', label: '12 V battery', icon: 'battery-low', signal: 'Resting voltage', unit: 'V', limit: 12.0, dir: -1, dec: 2, fix: 'Replace the 12 V battery at the next depot visit (about 20 minutes).', cost: 650, unplanned: 1500, days: 1 },
    { k: 'tyres', label: 'Tyres', icon: 'circle-dot', signal: 'Lowest tread depth', unit: 'mm', limit: 3, dir: -1, dec: 1, fix: 'Rotate or replace tyres; check alignment if wear is uneven.', cost: 2200, unplanned: 3100, days: 1 },
    { k: 'brakes', label: 'Brakes', icon: 'circle-x', signal: 'Front pad thickness', unit: 'mm', limit: 3, dir: -1, dec: 1, fix: 'Replace front brake pads and check discs; EVs brake less thanks to regeneration, so wear is usually slow.', cost: 900, unplanned: 2400, days: 1 },
    { k: 'drive', label: 'Drive unit', icon: 'cpu', signal: 'Motor vibration (RMS)', unit: 'mm/s', limit: 7.1, dir: 1, dec: 2, fix: 'Inspect motor mounts, bearings and half-shafts; read inverter fault codes.', cost: 1200, unplanned: 9800, days: 5 },
    { k: 'charging', label: 'Charge port', icon: 'plug-zap', signal: 'Interrupted charging sessions', unit: '%', limit: 15, dir: 1, dec: 1, fix: 'Clean and inspect charge-port pins and the on-board charger; update charging firmware.', cost: 300, unplanned: 1400, days: 2 },
  ];
  I.COMP = COMP;
  const HIST = 60;
  // Which vehicles carry a developing fault in the sample data (stable per vehicle id).
  function faultOf(v) { const n = seed(v.id + 'fault') % 7; return seed(v.id + 'f2') % 3 === 0 ? COMP[n].k : null; }
  function series(v, c) {
    const r = mulberry32(seed(v.id + c.k)); const k = kindOf(v);
    const fixedAt = I.cfg().fixed[v.id + ':' + c.k]; const fault = faultOf(v) === c.k && !fixedAt; const today = Math.floor(VF.startOfDay(VF.now()) / DAY);
    const fixDay = fixedAt ? Math.floor(VF.startOfDay(fixedAt) / DAY) : -1;
    const pts = []; let x;
    const km = (k === 'van' ? 115 : 75);
    for (let d = HIST - 1; d >= 0; d--) {
      const day = today - d; const fresh = fixDay >= 0 && day >= fixDay; const age = fresh ? day - fixDay : HIST - d;
      let val, noise;
      switch (c.k) {
        case 'battery': val = v.soh + d * 0.006 - (fault ? (HIST - d) * 0.06 - 3.6 : 0); noise = 0.12; break;
        case 'thermal': val = 38 + (v.tempC - 30) * 0.4 + (fault ? (HIST - d) * 0.13 : 0); noise = 0.9; break;
        case 'aux': val = (fresh ? 12.75 - age * 0.002 : v.aux12v + d * 0.0015) - (fault ? 0.42 - d * 0.007 : 0); noise = 0.035; break;
        case 'tyres': { const wear = km * (k === 'van' ? 1.25 : 1) / 1000 * 0.11; const start = 5.6 + (seed(v.id + 'ty') % 20) / 10; val = (fresh ? 8 - age * wear : start - (HIST - d) * wear) - (fault ? (HIST - d) * 0.02 : 0); noise = 0.06; break; }
        case 'brakes': { const wear = km / 1000 * (k === 'van' ? 0.05 : 0.035); const start = 5.2 + (seed(v.id + 'br') % 30) / 10; val = (fresh ? 10 - age * wear : start - (HIST - d) * wear) - (fault ? (HIST - d) * 0.025 : 0); noise = 0.05; break; }
        case 'drive': val = 2.2 + (seed(v.id + 'dr') % 10) / 10 + (fault ? Math.pow((HIST - d) / HIST, 2) * 4.3 : 0); noise = 0.18; break;
        default: val = 3 + (seed(v.id + 'ch') % 4) + (fault ? (HIST - d) * 0.17 : 0); noise = 1.1;
      }
      x = val + (r() - 0.5) * 2 * noise; pts.push(+x.toFixed(c.dec + 1));
    }
    return pts;
  }
  // Least-squares trend over the last 21 days, projected to the limit with an uncertainty band.
  const erf = (x) => { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); };
  const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  function fit(ys) {
    const n = ys.length; const xs = ys.map((_, i) => i); const mx = (n - 1) / 2; const my = sum(ys, (y) => y) / n;
    let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
    const slope = sxy / sxx; const icpt = my - slope * mx;
    let ss = 0, st = 0; for (let i = 0; i < n; i++) { ss += (ys[i] - (icpt + slope * i)) ** 2; st += (ys[i] - my) ** 2; }
    const sigma = Math.sqrt(ss / Math.max(1, n - 2)); return { slope, icpt, sigma, r2: st ? 1 - ss / st : 0, seSlope: sigma / Math.sqrt(sxx), n };
  }
  I.predict = (v, c) => {
    const ys = series(v, c); const fx = I.cfg().fixed[v.id + ':' + c.k]; const since = fx ? Math.floor((VF.startOfDay(VF.now()) - VF.startOfDay(fx)) / DAY) + 1 : 99;
    const w = ys.slice(-(since >= 5 ? Math.min(21, since) : 21)); const f = fit(w); const cur = f.icpt + f.slope * (w.length - 1);
    const toward = c.dir * f.slope; // >0 when moving toward the limit
    const margin = c.dir * (c.limit - cur); // >0 while inside the limit
    const days = margin <= 0 ? 0 : toward > 1e-6 ? margin / toward : Infinity;
    const proj = cur + f.slope * 30; const sd = Math.sqrt(f.sigma ** 2 + (f.seSlope * 30) ** 2) || 1e-6;
    const p30 = clamp(phi(c.dir * (proj - c.limit) / sd), 0, 1);
    const nominal = { battery: 100, thermal: 36, aux: 12.7, tyres: 8, brakes: 10, drive: 2, charging: 2 }[c.k];
    const marginR = clamp((c.dir * (c.limit - cur)) / Math.abs(c.limit - nominal), 0, 1); const timeR = isFinite(days) ? clamp(days / 365, 0, 1) : 1;
    const health = clamp(100 * (0.35 * marginR + 0.65 * timeR) * (1 - p30 * 0.6), 0, 100);
    const conf = f.r2 > 0.75 ? 'High' : f.r2 > 0.4 ? 'Medium' : 'Low';
    const risk = margin <= 0 || p30 >= 0.6 ? 'critical' : p30 >= 0.2 || days < 45 || health < 40 ? 'warning' : 'ok';
    return { v, c, ys, fit: f, cur, days, p30, health, conf, risk };
  };
  I.health = () => memo('health|' + Math.floor(VF.now() / DAY) + JSON.stringify(I.cfg().fixed) + VF.simVehicles().map((v) => v.id + v.soh).join(), () => {
    const rows = VF.simVehicles().map((v) => { const preds = COMP.map((c) => I.predict(v, c)); return { v, preds, score: Math.round(sum(preds, (p) => p.health) / preds.length), worst: preds.slice().sort((a, b) => b.p30 - a.p30)[0] }; });
    const all = rows.flatMap((r) => r.preds); const flagged = all.filter((p) => p.risk !== 'ok').sort((a, b) => b.p30 - a.p30 || a.days - b.days);
    const planned = sum(flagged, (p) => p.c.cost), unplanned = sum(flagged, (p) => p.c.unplanned * p.p30 + p.c.cost * (1 - p.p30));
    return { rows, flagged, score: rows.length ? Math.round(sum(rows, (r) => r.score) / rows.length) : 100, avoidCost: sum(flagged, (p) => (p.c.unplanned - p.c.cost) * Math.max(p.p30, 0.3)), avoidDays: sum(flagged, (p) => p.c.days * Math.max(p.p30, 0.3)), planned, unplanned };
  });
  // Best day for the workshop: low-utilisation days first (Sunday, then Saturday), before the predicted limit.
  I.serviceSlot = (p) => {
    const now = VF.now(); const limit = isFinite(p.days) ? Math.max(1, Math.floor(p.days * 0.7)) : 21;
    let best = null;
    for (let d = 1; d <= Math.min(21, limit); d++) { const ms = VF.startOfDay(now) + d * DAY + 7 * HOUR; const dow = new Date(ms + 12 * HOUR).getUTCDay(); const score = (dow === 0 ? 0 : dow === 6 ? 1 : 3) + d * 0.05; if (!best || score < best.score) best = { ms, score }; }
    return best ? best.ms : VF.startOfDay(now) + DAY + 7 * HOUR;
  };

  // ================================================================ 3. Route optimisation
  // Elevation of each place (metres, approximate) for the hill-climbing energy model.
  const ELEV = { kasoa: 60, weija: 40, mallam: 55, dansoman: 20, kaneshie: 30, lapaz: 60, achimota: 95, dome: 110, amasaman: 75, circle: 40, central: 15, osu: 15, airport: 70, tetteh: 70, legon: 95, madina: 120, adenta: 135, eastlegon: 70, labadi: 10, spintex: 40, teshie: 20, nungua: 20, sakumono: 15, tema: 20, ashaiman: 30 };
  I.ELEV = ELEV;
  const TRAFFIC = [1, 1, 1, 1, 1, 1.05, 1.15, 1.6, 1.75, 1.45, 1.2, 1.15, 1.2, 1.2, 1.2, 1.3, 1.5, 1.8, 1.7, 1.35, 1.15, 1.05, 1, 1];
  I.traffic = (h) => TRAFFIC[((Math.floor(h) % 24) + 24) % 24];
  const CURB = { van: 2600, suv: 1850, car: 1700 }; const PAYLOAD = { van: 1300, suv: 400, car: 320 };
  const CLIENTS = ['Retail drop', 'Pharmacy restock', 'Office supplies', 'Pallet delivery', 'Parcel round', 'Spare parts', 'Grocery wholesale', 'Clinic supplies', 'E-commerce returns', 'Hotel linen'];
  I.routeDay = () => { const now = VF.now(); const h = VF.hourOf(now); return VF.startOfDay(now) + (h >= 15 ? DAY : 0); };
  I.jobs = () => {
    const day = I.routeDay(); const r = mulberry32(seed('jobs' + Math.floor(day / DAY)));
    const nodes = Object.keys(VF.PLACES); const n = 18 + Math.floor(r() * 6); const out = [];
    for (let i = 0; i < n; i++) {
      const node = nodes[Math.floor(r() * nodes.length)]; const heavy = r() < 0.4;
      const from = 8 + Math.floor(r() * 7); const len = 2 + Math.floor(r() * 4);
      out.push({ id: 'jb' + (i + 1), ref: 'JOB-' + String(1000 + Math.floor(day / DAY) % 9000).slice(-3) + String(i + 1).padStart(2, '0'), name: CLIENTS[Math.floor(r() * CLIENTS.length)], node, kg: Math.round(heavy ? 250 + r() * 600 : 15 + r() * 90), from, to: Math.min(19, from + len), service: heavy ? 20 : 8 });
    }
    return out;
  };
  // Energy and time for one leg under the chosen conditions.
  function leg(v, a, b, kg, hour, fx, wx) {
    const m = VF.MODELS[v.model]; const k = kindOf(v); const km = VF.shortestPath(a, b).km;
    let perKm = m.eff * 1.08;
    const parts = { base: km * perKm, cargo: 0, terrain: 0, weather: 0, ageing: 0 };
    if (fx.cargo) parts.cargo = km * perKm * 0.07 * kg / 1000 * (k === 'van' ? 1 : 1.4);
    if (fx.terrain) { const dh = (ELEV[b] || 30) - (ELEV[a] || 30); const mass = CURB[k] + (fx.cargo ? kg : 0); const e = mass * 9.81 * Math.abs(dh) / 3.6e6; parts.terrain = dh > 0 ? e / 0.88 : -e * 0.62; }
    if (fx.weather && wx) parts.weather = km * perKm * ((wx.temp > 30 ? 0.05 : 0) + (wx.rainP > 50 ? 0.06 : 0) + (wx.wind > 20 ? 0.02 : 0));
    if (fx.ageing) parts.ageing = km * perKm * Math.max(0, 100 - v.soh) * 0.002;
    const kwh = Math.max(0, parts.base + parts.cargo + parts.terrain + parts.weather + parts.ageing);
    const tf = fx.traffic ? I.traffic(hour) * (fx.weather && wx && wx.rainP > 50 ? 1.12 : 1) : 1.25;
    return { km, kwh, min: km / (34 / tf) * 60, parts };
  }
  function evalRoute(v, start, stops, depart, fx, home) {
    const usable = VF.MODELS[v.model].kwh * v.soh / 100; let t = depart, node = start, kg = sum(stops, (j) => j.kg), kwh = 0, km = 0, late = 0, lateMin = 0;
    const legs = []; const parts = { base: 0, cargo: 0, terrain: 0, weather: 0, ageing: 0 };
    const visit = stops.concat([{ node: home, kg: 0, service: 0, end: true }]);
    for (const j of visit) {
      const wx = I.weatherAt(t); const l = leg(v, node, j.node, kg, VF.hourOf(t), fx, wx);
      t += l.min * MIN; kwh += l.kwh; km += l.km; for (const p in parts) parts[p] += l.parts[p];
      if (!j.end) { const open = VF.startOfDay(depart) + j.from * HOUR, close = VF.startOfDay(depart) + j.to * HOUR; if (t < open) t = open; const isLate = t > close; if (isLate) { late++; lateMin += (t - close) / MIN; } legs.push({ j, eta: t, late: isLate, kwh: l.kwh, km: l.km }); t += j.service * MIN; kg -= j.kg; }
      node = j.node;
    }
    const endSoc = v.soc - kwh / usable * 100;
    return { v, stops, legs, depart, back: t, km, kwh, minutes: (t - depart) / MIN, late, lateMin, endSoc, parts, ok: endSoc >= RESERVE, cost: kwh * 2.0 + (t - depart) / HOUR * 25 + lateMin * 2 + (endSoc < RESERVE ? 500 : 0) };
  }
  function twoOpt(v, start, stops, depart, fx, home) {
    let best = evalRoute(v, start, stops, depart, fx, home); let improved = true; let guard = 0;
    while (improved && guard++ < 30) {
      improved = false;
      for (let i = 0; i < best.stops.length - 1; i++) for (let k = i + 1; k < best.stops.length; k++) {
        const s = best.stops.slice(0, i).concat(best.stops.slice(i, k + 1).reverse(), best.stops.slice(k + 1));
        const r = evalRoute(v, start, s, depart, fx, home); if (r.cost < best.cost - 0.01) { best = r; improved = true; }
      }
    }
    return best;
  }
  I.optimizeRoutes = () => {
    const cfg = I.cfg(); const fx = cfg.factors; const day = I.routeDay(); const now = VF.now(); const today = day === VF.startOfDay(now);
    return memo('routes|' + JSON.stringify(fx) + bucket() + W.src + VF.simVehicles().map((v) => v.id + v.status[0]).join(), () => {
      const jobs = I.jobs();
      const fleet = VF.simVehicles().filter((v) => !['maintenance', 'offline'].includes(v.status) && v.soc >= 30 && !(v.trip && v.trip.purpose === 'dispatch'));
      const startOf = (v) => { if (!today) return VF.depotNode(v.depot); const p = VF.fleetPos(v); return VF.nearestNode(p.lat, p.lon); };
      const dep0 = today ? Math.max(now + 10 * MIN, day + 6 * HOUR) : day + 6 * HOUR;
      const departs = [0, 30, 60, 90, 120].map((x) => dep0 + x * MIN);
      // Cheapest insertion with capacity and battery checks, heaviest and earliest jobs first.
      const routes = fleet.map((v) => ({ v, start: startOf(v), home: VF.depotNode(v.depot), stops: [], kg: 0 }));
      const order = jobs.slice().sort((a, b) => a.to - b.to || b.kg - a.kg);
      const unassigned = [];
      for (const j of order) {
        let best = null;
        for (const r of routes) {
          if (r.kg + j.kg > PAYLOAD[kindOf(r.v)]) continue;
          const before = evalRoute(r.v, r.start, r.stops, dep0, fx, r.home).cost;
          for (let pos = 0; pos <= r.stops.length; pos++) {
            const s = r.stops.slice(0, pos).concat([j], r.stops.slice(pos));
            const e = evalRoute(r.v, r.start, s, dep0, fx, r.home); if (!e.ok) continue;
            const add = e.cost - before + (r.stops.length ? 0 : 60); // opening another vehicle costs a driver shift
            if (!best || add < best.add) best = { r, s, add };
          }
        }
        if (best) { best.r.stops = best.s; best.r.kg += j.kg; } else unassigned.push(j);
      }
      const out = routes.filter((r) => r.stops.length).map((r) => {
        let best = null; for (const d of departs) { const e = twoOpt(r.v, r.start, r.stops, d, fx, r.home); if (!best || e.cost < best.cost) best = e; }
        best.start = r.start; best.home = r.home; return best;
      });
      // Baseline: jobs dealt out in list order, stops in list order, everyone leaves at 07:30.
      const base = []; const bfleet = fleet.slice(0, Math.max(1, out.length)); const dealt = bfleet.map(() => []);
      jobs.forEach((j, i) => dealt[i % bfleet.length].push(j));
      bfleet.forEach((v, i) => { if (dealt[i].length) base.push(evalRoute(v, startOf(v), dealt[i], (today ? Math.max(now, day + 7.5 * HOUR) : day + 7.5 * HOUR), { traffic: true, weather: true, terrain: true, cargo: true, ageing: true }, VF.depotNode(v.depot))); });
      const tot = (rs, k) => sum(rs, (r) => r[k]);
      const onTime = (rs) => { const n = sum(rs, (r) => r.stops.length); return n ? (1 - tot(rs, 'late') / n) * 100 : 100; };
      return { day, today, jobs, routes: out, unassigned, km: tot(out, 'km'), kwh: tot(out, 'kwh'), minutes: tot(out, 'minutes'), cost: tot(out, 'cost'), onTime: onTime(out), base: { km: tot(base, 'km'), kwh: tot(base, 'kwh'), minutes: tot(base, 'minutes'), onTime: onTime(base), routes: base, cost: tot(base, 'cost') }, fleetN: fleet.length };
    });
  };

  // ================================================================ ROI and ESG
  I.roi = () => {
    const m = VF.fleetMetrics(30); const p = I.plan(null, { v2g: false }); const h = I.health(); const ro = I.optimizeRoutes();
    const km = Math.max(1, m.km);
    const maint = sum(VF.simVehicles(), (v) => sum(v.maintenance.filter((x) => x.date > VF.now() - 365 * DAY), (x) => x.cost || 0)) / 12; // a month
    const hist = VF.fleetHistory().filter((x) => x.d < 29); const downShare = hist.length ? hist.filter((x) => x.down).length / hist.length : 0;
    const energyPct = clamp(p.savingsPct, 0, 60) * 0.85; // ~85% of energy is depot charging once the plan runs
    const routeGain = clamp((ro.base.kwh - ro.kwh) / Math.max(1, ro.base.kwh), 0, 1) * 0.2; // real fleets already plan routes: credit a fifth of the gain vs list order
    const energyNow = m.cost / km, energyNext = energyNow * (1 - energyPct / 100) * (1 - Math.min(0.08, routeGain));
    const maintNow = (maint + h.unplanned / 3) / km, maintNext = Math.max(maintNow * 0.7, (maint * 0.95 + h.planned / 3) / km);
    // Operations overhead: dispatch, planning and idle/waiting time, taken as a quarter of driver time cost per km.
    const drvPerKm = (rs, k) => sum(rs, (r) => r.minutes) / 60 * 25 / Math.max(1, k) * 0.25;
    const opsNow = drvPerKm(ro.base.routes, ro.base.km), opsNext = Math.max(opsNow * 0.55, drvPerKm(ro.routes, ro.km) * 0.85);
    const uptimeNow = (1 - downShare) * 100, uptimeNext = Math.min(99.5, (1 - downShare * 0.35) * 100);
    const v2 = I.v2g();
    return { m, p, pv: I.plan(), h, ro, v2, km, energyNow, energyNext, energyPct, maintNow, maintNext, opsNow, opsNext, uptimeNow, uptimeNext, slaNow: ro.base.onTime, slaNext: ro.onTime,
      perVehicleYear: ((energyNow - energyNext) + (maintNow - maintNext) + (opsNow - opsNext)) * km / Math.max(1, VF.simVehicles().length) * 12 + Math.max(0, v2.net) * 300 / Math.max(1, VF.simVehicles().length) };
  };

  // Ask for live weather once the app is up.
  setTimeout(() => I.loadWeather(), 1500);
})();
