/* VoltFleet OS — operations engine (v3: built for Africa, Nordic-grade).
   Grid reliability and backup power, alerts by SMS / WhatsApp in the driver's language, a low-data mode,
   driver scorecards, mixed EV + ICE fleets with an electrification planner, energy cost attribution,
   battery lifecycle and depreciation, home-charging reimbursement by Mobile Money, and job import from a TMS/ERP.
   SAMPLE DATA: outage history, driving events, ICE vehicles, home sessions and client splits are simulated until
   meters, telematics and business systems are connected. Messages are written to an outbox, not sent, until an
   SMS / WhatsApp provider is configured on the server (keys never live in this app). */
'use strict';
(function () {
  const { clamp, sum, hash, mulberry32, esc } = VF;
  const MIN = VF.MIN, HOUR = VF.HOUR, DAY = VF.DAY;
  const F = () => VF.state.fleet;
  const seed = (s) => parseInt(hash(s), 16);
  const O = VF.ops = {};

  O.cfg = () => {
    const f = F(); if (!f) return null;
    const c = f.ops = f.ops || {};
    c.grid = c.grid || {};
    for (const d of f.depots) c.grid[d.id] = Object.assign({ up: true, v: 229, since: VF.now(), until: 0, log: [] }, c.grid[d.id]);
    c.rules = Object.assign({}, RULE_DEFAULTS, c.rules);
    c.quiet = Object.assign({ on: true, from: 21, to: 6 }, c.quiet);
    c.outbox = c.outbox || []; c.lang = c.lang || {};
    c.ice = c.ice || seedIce(); c.plan = c.plan || [];
    c.assume = Object.assign({ diesel: 15.5, petrol: 14.8, homeRate: 1.9, premium: { van: 250000, car: 120000, pickup: 300000, moto: 6000 }, duty: 0 }, c.assume);
    c.payouts = c.payouts || {}; c.jobs = c.jobs || {};
    return c;
  };

  // ================================================================ grid reliability
  // Typical outage likelihood per hour in Accra (load management peaks in the evening), by feeder.
  const PROFILE = [.02, .02, .015, .015, .015, .02, .03, .04, .04, .035, .035, .04, .05, .055, .055, .05, .05, .07, .09, .1, .095, .08, .05, .03];
  const FEEDER = { dp1: 0.7, dp2: 1.3 };
  O.outageP = (depotId, ms) => {
    if (O.isDown(depotId, ms)) return 1;
    const day = Math.floor(VF.startOfDay(ms) / DAY); const dayF = 0.6 + mulberry32(seed('grid' + depotId + day))() * 1.0;
    return clamp(PROFILE[VF.hourOf(ms)] * (FEEDER[depotId] || 1) * dayF, 0, 0.4);
  };
  O.isDown = (depotId, ms) => { const f = F(); const g = f && f.ops && f.ops.grid && f.ops.grid[depotId]; return !!(g && !g.up && ms <= g.until); };
  O.reliability = (depotId) => { const now = VF.now(); let up = 1; for (let i = 0; i < 24 * 30; i++) up -= O.outageP(depotId, now - i * HOUR) * 1.6 / (24 * 30); return clamp(up * 100, 80, 100); };
  O.nextRisk = (depotId, hours) => { const now = VF.now(); let worst = { p: 0, ms: now }; for (let i = 0; i < hours; i++) { const ms = now + i * HOUR; const p = O.outageP(depotId, ms); if (p > worst.p) worst = { p, ms }; } return worst; };
  const depotName = (id) => (F().depots.find((d) => d.id === id) || { name: id }).name;
  function gridTick() {
    const f = F(); if (!f || !VF.intel) return; const c = O.cfg(); const now = VF.now();
    const dt = clamp((now - (c.gridT || now)) / MIN, 0, 10); c.gridT = now; if (!dt) return;
    for (const d of f.depots) {
      const g = c.grid[d.id];
      if (g.up) {
        g.v = clamp(g.v + (228 - g.v) * 0.05 * dt + (Math.random() - 0.5) * 2.2 * Math.sqrt(dt), 196, 247);
        if (Math.random() < O.outageP(d.id, now) / 60 * dt) {
          const dur = (30 + Math.floor(Math.random() * 150)) * MIN; Object.assign(g, { up: false, since: now, until: now + dur, v: 0 });
          g.log.unshift({ start: now, end: now + dur }); g.log.length = Math.min(g.log.length, 20);
          const dep = VF.intel.cfg().depots[d.id];
          VF.fleetNotice('warning', `Grid outage at ${d.name}`, `Depot charging moved to backup power${dep.bessKwh ? `: battery ${dep.bessKwh} kWh` : ''}${dep.gensetKw ? `${dep.bessKwh ? ' and' : ':'} ${dep.gensetKw} kW generator` : ''}${!dep.bessKwh && !dep.gensetKw ? ': none, charging paused' : ''}. Vehicles leaving first charge first.`);
          O.send('outage', { depot: d.name, time: VF.fmtTime(now + dur) }, 'manager'); VF.intel.invalidate();
        }
      } else if (now > g.until) {
        Object.assign(g, { up: true, since: now, v: 226 }); if (g.log[0]) g.log[0].end = now;
        VF.fleetNotice('info', `Power restored at ${d.name}`, 'Smart charging resumed on the grid. The plan was re-optimised for the time left before departures.');
        O.send('restored', { depot: d.name }, 'manager'); VF.intel.invalidate();
      }
    }
  }
  VF.tickHooks = (VF.tickHooks || []).concat(gridTick);
  O.forceOutage = (depotId, minutes) => { const c = O.cfg(); const g = c.grid[depotId]; const now = VF.now(); c.gridT = now; Object.assign(g, { up: false, since: now, until: now + minutes * MIN, v: 0 }); g.log.unshift({ start: now, end: now + minutes * MIN }); const dep = VF.intel.cfg().depots[depotId]; VF.fleetNotice('warning', `Grid outage at ${depotName(depotId)}`, `Depot charging moved to backup power. ${dep.bessKwh ? `Battery ${dep.bessKwh} kWh. ` : ''}${dep.gensetKw ? `Generator ${dep.gensetKw} kW. ` : ''}Vehicles leaving first charge first.`); O.send('outage', { depot: depotName(depotId), time: VF.fmtTime(now + minutes * MIN) }, 'manager'); VF.intel.invalidate(); };
  O.restore = (depotId) => { const g = O.cfg().grid[depotId]; g.until = VF.now() - 1; gridTick(); };

  // ================================================================ alerts: SMS and WhatsApp, in the driver's language
  const LANGS = { en: 'English', tw: 'Twi (Akan)', ha: 'Hausa', fr: 'Français', ee: 'Ewe', ga: 'Ga' };
  O.LANGS = LANGS;
  O.READY_LANGS = ['en', 'tw', 'ha', 'fr']; // Ewe and Ga need a native translator before launch
  const T = {
    low_battery: { en: 'VoltFleet: {vehicle} battery is at {soc}%. Please charge at {station} now.', tw: 'VoltFleet: {vehicle} batiri no aka {soc}% pɛ. Yɛsrɛ wo, kɔ {station} kɔ charge seesei.', ha: 'VoltFleet: Batirin {vehicle} ya rage zuwa {soc}%. Don Allah ka je {station} ka yi caji yanzu.', fr: 'VoltFleet : la batterie de {vehicle} est à {soc} %. Rechargez maintenant à {station}.' },
    charge_done: { en: 'VoltFleet: {vehicle} is charged to {soc}%. You can unplug.', tw: 'VoltFleet: {vehicle} charge awie, ɛwɔ {soc}%. Wobɛtumi atu ahama no.', ha: 'VoltFleet: An gama cajin {vehicle} zuwa {soc}%. Za ka iya cire waya.', fr: 'VoltFleet : {vehicle} est chargé à {soc} %. Vous pouvez débrancher.' },
    route_dispatched: { en: 'VoltFleet: New route for {vehicle}: {stops} stops, leave at {time}. Open the app for the stop order.', tw: 'VoltFleet: Kwan foforɔ ma {vehicle}: baabi {stops}, fi hɔ {time}. Bue app no hwɛ nhyehyɛeɛ no.', ha: 'VoltFleet: Sabuwar hanya don {vehicle}: tasha {stops}, tashi da {time}. Bude manhaja don jerin tashoshi.', fr: 'VoltFleet : nouvel itinéraire pour {vehicle} : {stops} arrêts, départ à {time}. Ouvrez l’app pour l’ordre des arrêts.' },
    service_booked: { en: 'VoltFleet: {vehicle} is booked for service on {time}. Bring it to the depot workshop.', tw: 'VoltFleet: Yɛahyɛ da sɛ yɛbɛyɛ {vehicle} adwuma {time}. Fa no bra depot workshop.', ha: 'VoltFleet: An tsara gyaran {vehicle} a ranar {time}. Kawo shi taron bita na depot.', fr: 'VoltFleet : {vehicle} est réservé à l’atelier le {time}. Amenez-le au dépôt.' },
    reimbursement_paid: { en: 'VoltFleet: {amount} for home charging was sent to your {wallet} wallet. Thank you.', tw: 'VoltFleet: Yɛde {amount} a ɛyɛ fie charge ka akɔ wo {wallet} mu. Yɛda wo ase.', ha: 'VoltFleet: An tura {amount} na cajin gida zuwa walat ɗin {wallet} ɗinka. Mun gode.', fr: 'VoltFleet : {amount} de recharge à domicile ont été versés sur votre portefeuille {wallet}. Merci.' },
    scorecard: { en: 'VoltFleet: Your eco-score this week is {score}/100 ({change}). Tip: {tip}', tw: 'VoltFleet: Wo eco-score nnawɔtwe yi yɛ {score}/100 ({change}). Afotuo: {tip}', ha: 'VoltFleet: Makin eco ɗinka na wannan mako {score}/100 ({change}). Shawara: {tip}', fr: 'VoltFleet : votre éco-score cette semaine est {score}/100 ({change}). Conseil : {tip}' },
    outage: { en: 'VoltFleet: Grid outage at {depot}. Charging is on backup power until about {time}.' },
    restored: { en: 'VoltFleet: Power is back at {depot}. Smart charging resumed.' },
    sla_risk: { en: 'VoltFleet: {vehicle} may miss {n} delivery window(s). Review in Control Tower.' },
  };
  O.TEMPLATES = T;
  const RULE_DEFAULTS = {
    low_battery: { to: 'driver', inapp: true, sms: true, wa: true, crit: true }, charge_done: { to: 'driver', inapp: true, sms: false, wa: true },
    route_dispatched: { to: 'driver', inapp: true, sms: true, wa: true }, service_booked: { to: 'driver', inapp: true, sms: false, wa: true },
    reimbursement_paid: { to: 'driver', inapp: true, sms: true, wa: false }, scorecard: { to: 'driver', inapp: true, sms: false, wa: true },
    outage: { to: 'manager', inapp: true, sms: true, wa: true, crit: true }, restored: { to: 'manager', inapp: true, sms: false, wa: true }, sla_risk: { to: 'manager', inapp: true, sms: false, wa: true },
  };
  O.RULE_LABEL = { low_battery: 'Low battery', charge_done: 'Charging finished', route_dispatched: 'Route dispatched', service_booked: 'Service booked', reimbursement_paid: 'Home charging paid', scorecard: 'Weekly scorecard', outage: 'Grid outage', restored: 'Power restored', sla_risk: 'Delivery at risk' };
  // GSM-7 fits 160 characters per SMS; anything else (Twi's ɛ and ɔ, French accents outside GSM) uses UCS-2 at 70.
  const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  O.segments = (text) => { const ucs = [...text].some((ch) => !GSM.includes(ch)); const n = [...text].length; const per = ucs ? (n > 70 ? 67 : 70) : (n > 160 ? 153 : 160); return { ucs, n, segs: Math.max(1, Math.ceil(n / per)) }; };
  O.langOf = (driverId) => O.cfg().lang[driverId] || ['en', 'en', 'tw', 'tw', 'en', 'ha', 'en', 'tw', 'fr', 'en'][seed(driverId || 'x') % 10];
  O.render = (type, lang, vars) => { const t = T[type] || {}; const txt = t[lang] || t.en || ''; return txt.replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? vars[k] : '')); };
  const mask = (phone) => { const d = String(phone || '').replace(/\D/g, ''); return d.length > 6 ? `+${d.slice(0, 3)} ${d.slice(3, 5)} *** ${d.slice(-4)}` : '—'; };
  const SMS_COST = 0.035, WA_COST = 0.18; // GHS per SMS segment / per WhatsApp utility message (estimates)
  O.send = (type, vars, audience, driverId) => {
    const c = O.cfg(); const rule = c.rules[type]; if (!rule) return;
    const now = VF.now(); const h = VF.hourOf(now); const quiet = c.quiet.on && !rule.crit && (c.quiet.from > c.quiet.to ? h >= c.quiet.from || h < c.quiet.to : h >= c.quiet.from && h < c.quiet.to);
    const recipients = [];
    if ((rule.to === 'driver' || audience === 'driver') && driverId) { const d = VF.fleetDriver(driverId); if (d) recipients.push({ who: d.name, role: 'Driver', phone: d.phone, lang: O.langOf(d.id) }); }
    if (rule.to === 'manager' || audience === 'manager') { const u = VF.user('u-fm1') || {}; recipients.push({ who: u.name || 'Fleet manager', role: 'Manager', phone: u.phone, lang: 'en' }); }
    for (const r of recipients) for (const ch of ['sms', 'wa']) {
      if (!rule[ch]) continue;
      const lang = O.READY_LANGS.includes(r.lang) && T[type][r.lang] ? r.lang : 'en';
      const text = O.render(type, lang, vars); const sg = O.segments(text);
      c.outbox.unshift({ id: 'ob' + (F().seq++), t: now, type, ch, who: r.who, role: r.role, to: mask(r.phone), lang, text, segs: ch === 'sms' ? sg.segs : 1, ucs: sg.ucs, cost: ch === 'sms' ? sg.segs * SMS_COST : WA_COST, status: quiet ? 'queued' : 'simulated' });
    }
    if (c.outbox.length > 200) c.outbox.length = 200;
  };
  // Turn new fleet notices into messages for the vehicle's driver.
  function noticeTick() {
    const f = F(); if (!f || !f.ops) return; const c = f.ops; const top = f.notices[0]; if (!top) return;
    if (!c.lastNotice) { c.lastNotice = top.id; return; }
    const fresh = []; for (const n of f.notices) { if (n.id === c.lastNotice) break; fresh.push(n); if (fresh.length > 20) break; }
    c.lastNotice = top.id;
    for (const n of fresh.reverse()) {
      try {
        const v = n.vehicleId && VF.fleetVehicle(n.vehicleId); if (!v || !v.driverId) continue;
        const vars = { vehicle: v.name, soc: Math.round(v.soc) };
        if (/battery at/i.test(n.title)) { const o = VF.fleetChargeOptions(v)[0]; O.send('low_battery', Object.assign(vars, { station: o ? o.st.name : 'the nearest charger' }), 'driver', v.driverId); }
        else if (/finished charging/i.test(n.title)) O.send('charge_done', vars, 'driver', v.driverId);
        else if (/^Service booked/i.test(n.title)) O.send('service_booked', Object.assign(vars, { time: (n.body.match(/on ([^.]+)\./) || [])[1] || 'the booked day' }), 'driver', v.driverId);
      } catch (e) { /* messaging never blocks the app */ }
    }
  }
  VF.tickHooks.push(noticeTick);
  // Releases queued messages after quiet hours
  VF.tickHooks.push(() => { const f = F(); if (!f || !f.ops) return; const c = f.ops; const h = VF.hourOf(VF.now()); if (h >= c.quiet.to && h < c.quiet.from) for (const m of c.outbox) if (m.status === 'queued') m.status = 'simulated'; });

  // ================================================================ low-data mode
  const LKEY = 'voltfleet-os:lite';
  const L = VF.lite = {
    get() { try { const v = localStorage.getItem(LKEY); if (v) return v === 'on'; } catch (e) { /* none */ } return !!(navigator.connection && navigator.connection.saveData); },
    set(on) { try { localStorage.setItem(LKEY, on ? 'on' : 'off'); } catch (e) { /* not kept */ } document.documentElement.toggleAttribute('data-lite', on); },
    settingsCard() {
      const on = L.get(); const net = navigator.connection; const kind = net && net.effectiveType ? net.effectiveType.toUpperCase() : null;
      return VF.c.card({ title: 'Low-data mode', sub: 'For 2G/3G, bundles and patchy coverage. The app keeps working offline and syncs when the network returns.' }, VF.c.seg([['off', 'Standard'], ['on', 'Low data', 'wifi-off']], on ? 'on' : 'off', 'lite-set') + `<ul class="why small"><li>${VF.icon('check')}<span>Turns off vehicle photos, street-map tiles and animations; maps switch to the light schematic.</span></li><li>${VF.icon('check')}<span>Everything you do is saved on this device first and synced later.</span></li><li>${VF.icon('check')}<span>Alerts still reach drivers by SMS when mobile data is off.</span></li></ul>${kind ? `<p class="small muted">Your connection: ${esc(kind)}${net.saveData ? ' · data saver on' : ''}.</p>` : ''}`);
    },
  };
  L.set(L.get());
  if (VF.motion) { const r0 = VF.motion.reduced; VF.motion.reduced = () => L.get() || r0(); }
  if (VF.maps) { const e0 = VF.maps.enabled; VF.maps.enabled = () => !L.get() && e0(); }
  if (VF.c.vehicleImg) { const v0 = VF.c.vehicleImg; VF.c.vehicleImg = (model, cls) => (L.get() ? `<span class="vphoto art ${cls || ''}">${VF.c.vehicleArt(VF.vehicleKind(model))}</span>` : v0(model, cls)); }
  Object.assign(VF.ACT, { 'lite-set': (el) => { L.set(el.dataset.k === 'on'); VF.toast(el.dataset.k === 'on' ? 'Low-data mode on' : 'Standard mode'); VF.rerender(); } });

  // ================================================================ driver scorecards
  const TIPS = {
    eff: 'Ease off early before stops and keep to 60–80 km/h on the motorway; it saves the most energy.',
    harsh: 'Brake gently and early: regenerative braking puts energy back in the battery.',
    speed: 'Keep to the speed limit; above 90 km/h consumption climbs steeply.',
    regen: 'Use the strongest regeneration setting (one-pedal mode) in city traffic.',
    idle: 'Don’t idle with the A/C on while parked; pre-cool the cabin while plugged in instead.',
    charge: 'Charge to 80% for daily work; save fast charging and 100% for long days.',
  };
  O.TIPS = TIPS;
  O.scorecards = () => {
    const f = F(); const wk = Math.floor(VF.now() / (7 * DAY));
    return f.drivers.map((d) => {
      const v = d.vehicleId && VF.fleetVehicle(d.vehicleId); const base = (d.score - 72) / 26; // 0..1 from the driving score
      const weeks = Array.from({ length: 8 }, (_, i) => {
        const r = mulberry32(seed(d.id + 'wk' + (wk - 7 + i))); const q = clamp(base + (r() - 0.5) * 0.25 + i * 0.012, 0, 1);
        const m = { eff: 1.24 - q * 0.32 + (r() - 0.5) * 0.04, harsh: 5.5 - q * 4.8 + r() * 0.6, speed: 11 - q * 10 + r(), regen: 9 + q * 13 + r() * 2, idle: 55 - q * 48 + r() * 6, dc: 45 - q * 35 + r() * 8, full: 40 - q * 32 + r() * 6 };
        const sub = { eff: clamp(100 - (m.eff - 0.92) / 0.32 * 100, 0, 100), harsh: clamp(100 - (m.harsh - 0.5) / 5.5 * 100, 0, 100), speed: clamp(100 - m.speed / 12 * 100, 0, 100), regen: clamp((m.regen - 8) / 16 * 100, 0, 100), idle: clamp(100 - (m.idle - 5) / 55 * 100, 0, 100), charge: clamp(100 - ((m.dc - 8) / 45 * 50 + (m.full - 6) / 36 * 50), 0, 100) };
        const eco = Math.round(sub.eff * 0.35 + sub.harsh * 0.15 + sub.speed * 0.15 + sub.regen * 0.15 + sub.idle * 0.1 + sub.charge * 0.1);
        return { m, sub, eco };
      });
      const cur = weeks[7]; const prev = weeks[6];
      const weakest = Object.entries(cur.sub).sort((a, b) => a[1] - b[1])[0][0];
      const km = v ? (VF.vehicleKind(v.model) === 'van' ? 115 : 75) * 22 : 0; const rated = v ? VF.MODELS[v.model].eff : 0.17;
      const wastedKwh = km * rated * Math.max(0, cur.m.eff - 0.95);
      return { d, v, weeks, cur, eco: cur.eco, change: cur.eco - prev.eco, weakest, tip: TIPS[weakest], wastedKwh, wastedCost: wastedKwh * (VF.intel ? VF.intel.cfg().tariff.std : 2) };
    }).sort((a, b) => b.eco - a.eco);
  };

  // ================================================================ mixed fleet: ICE vehicles and electrification planner
  function seedIce() {
    const r = mulberry32(77); const now = VF.now();
    const spec = [['Hiace 21', 'Toyota Hiace (diesel)', 'van', 'diesel', 11.8, 'dp1'], ['Hiace 22', 'Toyota Hiace (diesel)', 'van', 'diesel', 12.4, 'dp2'], ['Hiace 23', 'Toyota Hiace (diesel)', 'van', 'diesel', 11.5, 'dp1'], ['Urvan 24', 'Nissan Urvan (diesel)', 'van', 'diesel', 12.9, 'dp2'],
      ['Hilux 25', 'Toyota Hilux (diesel)', 'pickup', 'diesel', 10.2, 'dp1'], ['Hilux 26', 'Toyota Hilux (diesel)', 'pickup', 'diesel', 10.8, 'dp2'], ['Corolla 27', 'Toyota Corolla (petrol)', 'car', 'petrol', 7.4, 'dp1'], ['Elantra 28', 'Hyundai Elantra (petrol)', 'car', 'petrol', 7.9, 'dp2'],
      ['Moto 29', 'Courier motorbike (petrol)', 'moto', 'petrol', 2.9, 'dp1'], ['Moto 30', 'Courier motorbike (petrol)', 'moto', 'petrol', 3.1, 'dp2']];
    return spec.map(([name, model, cls, fuel, l100, depot], i) => ({ id: 'ic' + (i + 1), name, model, cls, fuel, l100, depot, kmDay: Math.round(cls === 'moto' ? 70 + r() * 50 : cls === 'van' ? 110 + r() * 60 : cls === 'pickup' ? 90 + r() * 80 : 50 + r() * 50), maint: Math.round(cls === 'moto' ? 1800 : cls === 'car' ? 6500 : 9000 + r() * 3000), age: 2 + Math.floor(r() * 8), added: now - 400 * DAY }));
  }
  // Electric replacement for each class (kWh usable, kWh/km, maintenance factor vs ICE).
  const EV_FOR = { van: { model: 'Ford E-Transit', kwh: 68, eff: 0.27, maint: 0.55 }, car: { model: 'BYD Dolphin', kwh: 60.4, eff: 0.15, maint: 0.5 }, pickup: { model: 'Electric pickup (import)', kwh: 88, eff: 0.25, maint: 0.6 }, moto: { model: 'Electric motorbike, swappable battery', kwh: 4, eff: 0.045, maint: 0.4, swap: true } };
  O.EV_FOR = EV_FOR;
  // What charging vehicles actually costs per kWh under the smart plan (grid energy at its hourly price, solar/battery at feed-in value).
  O.evPrice = () => { const p = VF.intel.plan(); const fi = VF.intel.cfg().tariff.feedIn; let c = 0, e = 0; for (const dp of p.depots) for (const s of dp.slots) { c += Math.max(0, s.ev - s.evGreen) * s.price + s.evGreen * fi; e += s.ev; } return e > 1 ? c / e : VF.intel.cfg().tariff.off; };
  O.electrify = () => {
    const c = O.cfg(); const a = c.assume; const t = VF.intel.cfg().tariff; const plan = VF.intel.plan();
    const smartPrice = O.evPrice(); // effective price per kWh with smart charging
    const head = {}; for (const dp of plan.depots) head[dp.depotId] = Math.max(0, dp.dep.gridKw * 9 * 0.8 - dp.evKwh - sum(dp.slots.filter((s) => s.h >= 22 || s.h < 6), (s) => s.base));
    const rows = c.ice.map((x) => {
      const ev = EV_FOR[x.cls]; const yearKm = x.kmDay * 300; const fuelPrice = x.fuel === 'diesel' ? a.diesel : a.petrol;
      const iceYear = yearKm * x.l100 / 100 * fuelPrice + x.maint; const kwhYear = yearKm * ev.eff * 1.08 / 0.92;
      const evYear = kwhYear * (ev.swap ? smartPrice * 1.6 : smartPrice) + x.maint * ev.maint; const save = iceYear - evYear;
      const premium = a.premium[x.cls] * (1 + a.duty / 100); const payback = save > 0 ? premium / save : Infinity;
      const range = ev.kwh * 0.9 / (ev.eff * 1.08); const fits = x.kmDay * 1.25 <= range || ev.swap;
      const nightKwh = x.kmDay * ev.eff * 1.08 / 0.92; const co2 = yearKm * x.l100 / 100 * (x.fuel === 'diesel' ? 2.68 : 2.31) / 1000 - kwhYear * VF.CO2.GRID_KG_PER_KWH / 1000;
      const inPlan = c.plan.find((p) => p.iceId === x.id);
      const score = (fits ? 0 : 50) + (isFinite(payback) ? payback : 99) - (x.age > 6 ? 1 : 0);
      return { x, ev, yearKm, iceYear, evYear, save, tco5: { ice: iceYear * 5, ev: evYear * 5 + premium }, premium, payback, range, fits, nightKwh, co2, inPlan, score };
    }).sort((p, q) => p.score - q.score);
    return { rows, smartPrice, head, total: { save: sum(rows, (r) => r.save), co2: sum(rows, (r) => r.co2) } };
  };

  // ================================================================ finance: cost attribution, battery lifecycle, home charging
  const CLIENTS = ['Retail drop', 'Pharmacy restock', 'Office supplies', 'Pallet delivery', 'Parcel round', 'Spare parts', 'Grocery wholesale', 'Clinic supplies', 'E-commerce returns', 'Hotel linen'];
  O.attribution = () => {
    const today = Math.floor(VF.startOfDay(VF.now()) / DAY); const nodes = Object.keys(VF.PLACES); const out = {};
    const price = O.evPrice();
    for (let d = 1; d <= 30; d++) {
      const r = mulberry32(seed('attr' + (today - d))); const n = 16 + Math.floor(r() * 8);
      for (let i = 0; i < n; i++) {
        const cl = CLIENTS[Math.floor(r() * CLIENTS.length)]; const node = nodes[Math.floor(r() * nodes.length)]; const heavy = r() < 0.4; const kg = heavy ? 250 + r() * 600 : 15 + r() * 90;
        const km = VF.shortestPath(r() < 0.55 ? 'spintex' : 'kaneshie', node).km * 0.9 + 4; const kwh = km * (heavy ? 0.27 : 0.16) * 1.08 * (1 + 0.07 * kg / 1000);
        const o = out[cl] = out[cl] || { client: cl, jobs: 0, kg: 0, km: 0, kwh: 0 }; o.jobs++; o.kg += kg; o.km += km; o.kwh += kwh;
      }
    }
    const rows = Object.values(out).map((o) => Object.assign(o, { cost: o.kwh / 0.92 * price, perJob: o.kwh / 0.92 * price / o.jobs, perTonne: o.kwh / 0.92 * price / Math.max(0.001, o.kg / 1000) })).sort((a, b) => b.cost - a.cost);
    return { rows, price, total: sum(rows, (r) => r.cost) };
  };
  const PRICE = { 'Ford E-Transit': 780000, 'BYD Dolphin': 420000, 'BYD Atto 3': 520000, 'MG4': 450000, 'Hyundai Ioniq 5': 690000, 'Kia EV6': 700000 };
  O.lifecycle = () => VF.simVehicles().map((v) => {
    const m = VF.MODELS[v.model]; const ageY = Math.max(0.5, (new Date(VF.now()).getUTCFullYear() - v.year) + 0.5);
    const rate = Math.max(0.6, (100 - v.soh) / ageY); const yrs80 = Math.max(0, (v.soh - 80) / rate);
    const cycles = v.odo * m.eff / m.kwh; const warrY = 8, warrKm = 160000; const warrLeft = Math.min(warrY - ageY, (warrKm - v.odo) / Math.max(1, v.odo / ageY));
    const price = PRICE[v.model] || 500000; const life = 8; const residual = 0.25; const book = price * Math.max(residual, 1 - (1 - residual) * ageY / life);
    const battVal = m.kwh * 1650 * v.soh / 100; // GHS per kWh, replacement-pack estimate
    return { v, m, ageY, rate, yrs80, cycles, warrLeft, price, book, battVal, deprYear: price * (1 - residual) / life };
  });
  O.home = () => {
    const c = O.cfg(); const month = new Date(VF.now()).toISOString().slice(0, 7); const r0 = c.assume.homeRate;
    return F().drivers.filter((d) => d.vehicleId && VF.fleetVehicle(d.vehicleId) && VF.vehicleKind(VF.fleetVehicle(d.vehicleId).model) !== 'van').map((d) => {
      const v = VF.fleetVehicle(d.vehicleId); const r = mulberry32(seed(d.id + month)); const sessions = 4 + Math.floor(r() * 10); const kwh = sessions * (12 + r() * 14);
      const p = String(d.phone).replace(/\D/g, '').slice(3, 5); const wallet = ['24', '54', '55', '59', '53'].includes(p) ? 'MTN MoMo' : ['20', '50'].includes(p) ? 'Telecel Cash' : 'AT Money';
      const paid = c.payouts[month + ':' + d.id];
      return { d, v, sessions, kwh, amount: kwh * r0, wallet, to: mask(d.phone), paid, month };
    });
  };
  O.payHome = () => {
    const c = O.cfg(); const rows = O.home().filter((x) => !x.paid); const ref = 'VF' + String(F().seq++).padStart(6, '0');
    for (const x of rows) { c.payouts[x.month + ':' + x.d.id] = { at: VF.now(), ref, amount: x.amount, wallet: x.wallet }; O.send('reimbursement_paid', { amount: VF.fmt.money(x.amount), wallet: x.wallet }, 'driver', x.d.id); }
    return { n: rows.length, total: sum(rows, (x) => x.amount), ref };
  };

  // ================================================================ job import (TMS / WMS / ERP export as CSV)
  // Columns: ref, client, place, kg, from, to  (place = an area name such as "Osu"; hours 0–23)
  O.parseJobs = (text) => {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean); if (!lines.length) return { error: 'The file is empty.' };
    const head = lines[0].toLowerCase().split(',').map((x) => x.trim()); const ix = (k) => head.indexOf(k);
    if (['ref', 'place', 'kg', 'from', 'to'].some((k) => ix(k) < 0)) return { error: 'Use the columns ref, client, place, kg, from, to.' };
    const byName = {}; for (const [id, p] of Object.entries(VF.PLACES)) { byName[p.name.toLowerCase()] = id; byName[id] = id; }
    const jobs = [], bad = [];
    lines.slice(1, 201).forEach((l, i) => {
      const c = l.split(',').map((x) => x.trim()); const node = byName[(c[ix('place')] || '').toLowerCase()]; const kg = +c[ix('kg')], from = +c[ix('from')], to = +c[ix('to')];
      if (!node || !(kg > 0 && kg < 5000) || !(from >= 0 && to <= 23 && to > from)) { bad.push(i + 2); return; }
      jobs.push({ id: 'im' + (i + 1), ref: String(c[ix('ref')] || 'JOB-' + (i + 1)).slice(0, 20), name: String(ix('client') >= 0 ? c[ix('client')] : 'Imported job').slice(0, 40), node, kg: Math.round(kg), from, to, service: kg > 200 ? 20 : 8 });
    });
    return { jobs, bad };
  };
  if (VF.intel) {
    const j0 = VF.intel.jobs;
    VF.intel.jobs = () => { const c = F() && F().ops; const imp = c && c.jobs && c.jobs[VF.intel.routeDay()]; return imp && imp.length ? imp : j0(); };
  }
  O.sampleCSV = () => 'ref,client,place,kg,from,to\nPO-1001,Makola wholesale,Accra Central,640,8,11\nPO-1002,Clinic supplies,Madina,45,9,12\nPO-1003,Retail drop,Osu,80,10,13\nPO-1004,Pallet delivery,Tema,900,8,12\nPO-1005,Pharmacy restock,East Legon,35,13,16\nPO-1006,Spare parts,Kasoa,220,11,15\n';

  // ================================================================ control tower: everything that needs a decision now
  O.exceptions = () => {
    const f = F(); const out = []; const now = VF.now(); const c = O.cfg();
    for (const d of f.depots) { const g = c.grid[d.id]; if (!g.up) out.push({ sev: 3, icon: 'zap', tone: 'bad', title: `Grid outage at ${d.name}`, sub: `On backup power until about ${VF.fmtTime(g.until)}. Vehicles leaving first are charged first.`, href: '#m-smart', label: 'See plan' }); else if (g.v < 207) out.push({ sev: 2, icon: 'activity', tone: 'warn', title: `Low voltage at ${d.name}`, sub: `${Math.round(g.v)} V (−10% or more). Chargers derate to protect vehicles.`, href: '#m-smart', label: 'Plan' }); }
    for (const v of f.vehicles) {
      if (v.real) continue;
      if (v.soc < 20 && v.status !== 'charging' && !(v.trip && v.trip.purpose === 'charge') && !['maintenance', 'offline'].includes(v.status)) out.push({ sev: 3, icon: 'battery-warning', tone: 'bad', title: `${v.name} at ${Math.round(v.soc)}%`, sub: 'Not heading to a charger.', act: 'm-charge-vehicle', id: v.id, label: 'Send to charge' });
      if (v.status === 'offline') out.push({ sev: 2, icon: 'wifi-off', tone: 'warn', title: `${v.name} stopped reporting`, sub: `Last signal ${VF.relTime(v.lastSeen)}.`, act: 'm-open-vehicle', id: v.id, label: 'Open' });
      if (v.status === 'waiting') out.push({ sev: 1, icon: 'clock', tone: 'warn', title: `${v.name} waiting for a charger`, sub: 'Every compatible connector nearby is busy.', act: 'm-open-vehicle', id: v.id, label: 'Open' });
    }
    if (VF.intel) {
      const h = VF.intel.health(); for (const p of h.flagged.filter((x) => x.risk === 'critical').slice(0, 3)) out.push({ sev: 2, icon: 'wrench', tone: 'warn', title: `${p.v.name}: ${p.c.label.toLowerCase()} predicted to fail`, sub: `${p.p30 >= 0.995 ? 'Over 99%' : Math.round(p.p30 * 100) + '%'} chance within 30 days.`, href: '#m-health', label: 'Review' });
      const ro = VF.intel.optimizeRoutes(); for (const r of ro.routes.filter((x) => x.late)) out.push({ sev: 2, icon: 'clock', tone: 'warn', title: `${r.v.name} may miss ${r.late} window${r.late > 1 ? 's' : ''}`, sub: 'Re-optimise or move a stop to another vehicle.', href: '#m-routes', label: 'Routes' });
      const p = VF.intel.plan(); for (const it of p.items.filter((x) => !x.ready).slice(0, 3)) out.push({ sev: 2, icon: 'battery-charging', tone: 'warn', title: `${it.v.name} short of its mission charge`, sub: `${Math.round(it.endSoc)}% of ${it.target}% by ${VF.fmtTime(it.dep)}.`, href: '#m-smart', label: 'Plan' });
      const ev = VF.intel.eventLive(); if (ev) out.push({ sev: 1, icon: 'radio-tower', tone: 'teal', title: 'Grid support event running', sub: `${Math.round(ev.kw)} kW from ${ev.parked.length} vehicles.`, href: '#m-v2g', label: 'Open' });
    }
    return out.sort((a, b) => b.sev - a.sev);
  };
  O.depotNow = (depotId) => {
    const p = VF.intel.plan(); const dp = p.depots.find((x) => x.depotId === depotId); const s = dp && dp.slots[0]; const g = O.cfg().grid[depotId];
    const queue = dp ? dp.items.filter((it) => it.arr <= VF.now() + 5 * MIN && it.endSoc > it.arrSoc + 0.5).length : 0;
    return { dp, s, g, queue, bessPct: dp && dp.dep.bessKwh ? clamp(60 + (g.up ? 15 : -25) + (VF.hourOf(VF.now()) >= 17 ? -20 : 10), 5, 98) : null };
  };
})();
