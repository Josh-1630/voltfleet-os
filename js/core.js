/* VoltFleet OS — shared core.
   Data model, simulated clock and live feed, vehicle catalog (multi-OEM), charger network (OCPP-style
   connector states), booking engine, site load balancing, privacy layer (consent, pseudonyms, masking,
   audit) and the shared UI building blocks used by the driver, operator and admin apps. */
'use strict';
window.VF = (function () {
  const VF = {};

  // ------------------------------------------------------------------ utilities
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const pad2 = (n) => String(n).padStart(2, '0');
  const sum = (a, f = (x) => x) => a.reduce((s, x) => s + f(x), 0);
  const pick = (arr, r = Math.random) => arr[Math.floor(r() * arr.length)];
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function setHTML(el, html) { if (el && el._html !== html) { el.innerHTML = html; el._html = html; } }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function niceStep(max, count) {
    const raw = max / Math.max(1, count); const p = 10 ** Math.floor(Math.log10(raw || 1));
    for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
    return 10 * p;
  }
  // FNV-1a: stable, non-reversible short ids for pseudonyms
  function hash(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).toUpperCase().padStart(8, '0'); }
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code4 = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  Object.assign(VF, { $, $$, esc, clamp, pad2, sum, pick, debounce, setHTML, mulberry32, niceStep, hash });
  VF.ACT = {}; VF.CHG = {}; VF.INP = {}; VF.apps = {}; VF.ui = {};

  // ------------------------------------------------------------------ time (simulated clock)
  const MIN = 60e3, HOUR = 3600e3, DAY = 864e5;
  VF.MIN = MIN; VF.HOUR = HOUR; VF.DAY = DAY;
  VF.now = () => (VF.state ? VF.state.clock.t : Date.now());
  const tzMs = () => (Number(VF.state && VF.state.settings.tz) || 0) * HOUR;
  const local = (ms) => new Date(ms + tzMs());
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  VF.hourOf = (ms) => local(ms).getUTCHours();
  VF.fmtTime = (ms) => { const d = local(ms); return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()); };
  VF.fmtDate = (ms) => { const d = local(ms); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; };
  VF.fmtDayTime = (ms) => DOW[local(ms).getUTCDay()] + ' ' + VF.fmtTime(ms);
  VF.fmtStamp = (ms) => VF.fmtDate(ms) + ' ' + VF.fmtTime(ms);
  VF.startOfDay = (ms) => { const d = local(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - tzMs(); };
  VF.tzLabel = () => { const z = Number(VF.state.settings.tz) || 0; return z === 0 ? 'GMT' : 'GMT' + (z > 0 ? '+' : '') + z; };
  VF.relTime = (ms) => {
    const d = VF.now() - ms;
    if (d < -MIN) return 'in ' + VF.fmt.dur(-d / MIN);
    if (d < MIN) return 'just now';
    if (d < HOUR) return Math.round(d / MIN) + ' min ago';
    if (d < DAY) return Math.round(d / HOUR) + ' h ago';
    return VF.fmtStamp(ms);
  };

  VF.fmt = {
    n(x, d = 0) { return Number(x || 0).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }); },
    money(x, d) { if (d === undefined) d = Math.abs(x) >= 1000 ? 0 : 2; return VF.state.settings.currency + ' ' + VF.fmt.n(x, d); },
    kwh(x) { return VF.fmt.n(x, Math.abs(x) < 10 ? 1 : 0) + ' kWh'; },
    kw(x) { return VF.fmt.n(x, Math.abs(x) < 10 ? 1 : 0) + ' kW'; },
    km(x) { return VF.fmt.n(x, Math.abs(x) < 10 ? 1 : 0) + ' km'; },
    dur(min) { min = Math.max(0, Math.round(min)); const h = Math.floor(min / 60), m = min % 60; return h ? `${h} h ${pad2(m)} min` : `${m} min`; },
  };
  const fmt = VF.fmt;

  // ------------------------------------------------------------------ geography (Greater Accra, schematic)
  const PLACES = {
    kasoa: { name: 'Kasoa', lat: 5.534, lon: -0.418 },
    weija: { name: 'Weija', lat: 5.556, lon: -0.336 },
    mallam: { name: 'Mallam', lat: 5.573, lon: -0.287 },
    dansoman: { name: 'Dansoman', lat: 5.548, lon: -0.268, lab: [-8, 4, 'end'] },
    kaneshie: { name: 'Kaneshie', lat: 5.568, lon: -0.237, lab: [-8, 16, 'end'] },
    lapaz: { name: 'Lapaz', lat: 5.607, lon: -0.250 },
    achimota: { name: 'Achimota', lat: 5.619, lon: -0.226, lab: [-8, -7, 'end'] },
    dome: { name: 'Dome', lat: 5.652, lon: -0.236 },
    amasaman: { name: 'Amasaman', lat: 5.702, lon: -0.300 },
    circle: { name: 'Circle', lat: 5.570, lon: -0.214 },
    central: { name: 'Accra Central', lat: 5.549, lon: -0.205, lab: [0, 19, 'middle'] },
    osu: { name: 'Osu', lat: 5.556, lon: -0.180, lab: [7, 15, 'start'] },
    airport: { name: 'Airport City', lat: 5.603, lon: -0.172 },
    tetteh: { name: 'Tetteh Quarshie', lat: 5.614, lon: -0.183, lab: [0, -11, 'middle'] },
    legon: { name: 'Legon', lat: 5.651, lon: -0.187 },
    madina: { name: 'Madina', lat: 5.668, lon: -0.166 },
    adenta: { name: 'Adenta', lat: 5.708, lon: -0.155 },
    eastlegon: { name: 'East Legon', lat: 5.636, lon: -0.157 },
    labadi: { name: 'Labadi', lat: 5.563, lon: -0.150 },
    spintex: { name: 'Spintex', lat: 5.632, lon: -0.115 },
    teshie: { name: 'Teshie', lat: 5.585, lon: -0.102 },
    nungua: { name: 'Nungua', lat: 5.601, lon: -0.077 },
    sakumono: { name: 'Sakumono', lat: 5.618, lon: -0.045 },
    tema: { name: 'Tema', lat: 5.669, lon: -0.017 },
    ashaiman: { name: 'Ashaiman', lat: 5.694, lon: -0.034 },
  };
  const ROADS = [
    ['kasoa', 'weija', 1], ['weija', 'mallam', 1], ['mallam', 'kaneshie', 1], ['mallam', 'lapaz', 1], ['lapaz', 'achimota', 1],
    ['achimota', 'tetteh', 1], ['tetteh', 'tema', 1], ['kaneshie', 'circle', 1], ['circle', 'airport', 1], ['airport', 'tetteh', 1],
    ['tetteh', 'legon', 1], ['legon', 'madina', 1], ['madina', 'adenta', 1], ['tetteh', 'spintex', 1], ['spintex', 'sakumono', 1],
    ['lapaz', 'amasaman', 1], ['achimota', 'circle', 1],
    ['mallam', 'dansoman', 0], ['dansoman', 'central', 0], ['dansoman', 'kaneshie', 0], ['circle', 'central', 0], ['central', 'osu', 0],
    ['circle', 'osu', 0], ['osu', 'labadi', 0], ['labadi', 'teshie', 0], ['teshie', 'nungua', 0], ['nungua', 'sakumono', 0],
    ['sakumono', 'tema', 0], ['osu', 'airport', 0], ['airport', 'eastlegon', 0], ['eastlegon', 'madina', 0], ['eastlegon', 'spintex', 0],
    ['spintex', 'teshie', 0], ['achimota', 'dome', 0], ['dome', 'legon', 0], ['tema', 'ashaiman', 0], ['ashaiman', 'adenta', 0],
    ['labadi', 'airport', 0],
  ];
  const COAST = [[5.508, -0.445], [5.515, -0.40], [5.523, -0.36], [5.535, -0.315], [5.527, -0.275], [5.531, -0.235], [5.536, -0.205],
    [5.545, -0.180], [5.553, -0.152], [5.566, -0.122], [5.574, -0.098], [5.588, -0.075], [5.604, -0.048], [5.622, -0.022], [5.640, 0.005]];
  const MAP = { lon0: -0.44, lon1: 0.0, lat0: 5.505, lat1: 5.725, W: 1000 };
  MAP.k = MAP.W / (MAP.lon1 - MAP.lon0);
  MAP.H = Math.round((MAP.lat1 - MAP.lat0) * MAP.k);
  const proj = (lat, lon) => [(lon - MAP.lon0) * MAP.k, (MAP.lat1 - lat) * MAP.k];
  function hav(a, b) {
    const R = 6371, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  const ROAD_FACTOR = 1.28;
  const GRAPH = {};
  for (const [a, b] of ROADS) {
    const d = hav(PLACES[a], PLACES[b]) * ROAD_FACTOR;
    (GRAPH[a] = GRAPH[a] || []).push([b, d]);
    (GRAPH[b] = GRAPH[b] || []).push([a, d]);
  }
  const pathCache = new Map();
  function shortestPath(from, to) {
    if (from === to) return { path: [from], km: 0 };
    const key = from + '>' + to;
    if (pathCache.has(key)) return pathCache.get(key);
    const dist = {}, prev = {}, done = new Set();
    for (const n in PLACES) dist[n] = Infinity;
    dist[from] = 0;
    for (;;) {
      let u = null, best = Infinity;
      for (const n in dist) if (!done.has(n) && dist[n] < best) { best = dist[n]; u = n; }
      if (u === null || u === to) break;
      done.add(u);
      for (const [w, d] of GRAPH[u] || []) if (dist[u] + d < dist[w]) { dist[w] = dist[u] + d; prev[w] = u; }
    }
    const path = [to];
    while (path[0] !== from) { const p = prev[path[0]]; if (!p) break; path.unshift(p); }
    const res = { path, km: dist[to] };
    pathCache.set(key, res);
    return res;
  }
  function nearestNode(lat, lon) {
    let best = null, bd = Infinity;
    for (const id in PLACES) { const d = hav({ lat, lon }, PLACES[id]); if (d < bd) { bd = d; best = id; } }
    return best;
  }
  function makeTrip(nodes, startPt) {
    const pts = nodes.map((n) => [PLACES[n].lat, PLACES[n].lon]);
    if (startPt) pts.unshift(startPt);
    const segKm = [];
    for (let i = 1; i < pts.length; i++) segKm.push(hav({ lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: pts[i][0], lon: pts[i][1] }) * ROAD_FACTOR);
    return { nodes, pts, segKm, totalKm: sum(segKm), doneKm: 0 };
  }
  function posAt(trip, km) {
    let d = km;
    for (let i = 0; i < trip.segKm.length; i++) {
      if (d <= trip.segKm[i] || i === trip.segKm.length - 1) {
        const f = trip.segKm[i] ? clamp(d / trip.segKm[i], 0, 1) : 1;
        const a = trip.pts[i], b = trip.pts[i + 1];
        return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f };
      }
      d -= trip.segKm[i];
    }
    const p = trip.pts[trip.pts.length - 1];
    return { lat: p[0], lon: p[1] };
  }
  // km along the trip at which the path first reaches `node`
  function kmToNode(trip, node) {
    let acc = 0;
    for (let i = 0; i < trip.pts.length; i++) {
      if (i > 0) acc += trip.segKm[i - 1];
      const p = trip.pts[i];
      if (Math.abs(p[0] - PLACES[node].lat) < 1e-9 && Math.abs(p[1] - PLACES[node].lon) < 1e-9 && acc >= trip.doneKm - 1e-6) return acc;
    }
    return null;
  }
  Object.assign(VF, { PLACES, ROADS, COAST, MAP, proj, hav, shortestPath, nearestNode, makeTrip, posAt, kmToNode });

  // ------------------------------------------------------------------ vehicle catalog (OEM-agnostic)
  // kwh usable, eff kWh/km, dc / ac max acceptance kW, charge ports
  const MODELS = {
    'BYD Atto 3': { oem: 'BYD', kwh: 60.5, eff: 0.16, dc: 88, ac: 7, ports: ['CCS2', 'Type 2'], spec: 'International' },
    'BYD Dolphin': { oem: 'BYD', kwh: 60.4, eff: 0.15, dc: 88, ac: 7, ports: ['CCS2', 'Type 2'], spec: 'International' },
    'BYD Seal': { oem: 'BYD', kwh: 82.5, eff: 0.165, dc: 150, ac: 11, ports: ['CCS2', 'Type 2'], spec: 'International' },
    'BYD e6 (China spec)': { oem: 'BYD', kwh: 71.7, eff: 0.165, dc: 60, ac: 7, ports: ['GB/T DC', 'GB/T AC'], spec: 'China import' },
    'Tesla Model Y': { oem: 'Tesla', kwh: 75, eff: 0.16, dc: 250, ac: 11, ports: ['CCS2', 'Type 2'], spec: 'EU spec' },
    'Tesla Model 3': { oem: 'Tesla', kwh: 60, eff: 0.14, dc: 170, ac: 11, ports: ['CCS2', 'Type 2'], spec: 'EU spec' },
    'Rivian R1S': { oem: 'Rivian', kwh: 135, eff: 0.25, dc: 220, ac: 11.5, ports: ['CCS1', 'Type 1'], spec: 'US import' },
    'Rivian R1T': { oem: 'Rivian', kwh: 135, eff: 0.26, dc: 220, ac: 11.5, ports: ['CCS1', 'Type 1'], spec: 'US import' },
    'Hyundai Ioniq 5': { oem: 'Hyundai', kwh: 77.4, eff: 0.17, dc: 230, ac: 11, ports: ['CCS2', 'Type 2'], spec: 'International' },
    'Kia EV6': { oem: 'Kia', kwh: 77.4, eff: 0.17, dc: 230, ac: 11, ports: ['CCS2', 'Type 2'], spec: 'International' },
    'Nissan Leaf': { oem: 'Nissan', kwh: 40, eff: 0.155, dc: 46, ac: 6.6, ports: ['CHAdeMO', 'Type 1'], spec: 'Used import' },
    'VW ID.4 (China spec)': { oem: 'Volkswagen', kwh: 83.4, eff: 0.17, dc: 100, ac: 7, ports: ['GB/T DC', 'GB/T AC'], spec: 'China import' },
    'Ford E-Transit': { oem: 'Ford', kwh: 68, eff: 0.27, dc: 115, ac: 11, ports: ['CCS2', 'Type 2'], spec: 'International' },
    'MG4': { oem: 'MG', kwh: 64, eff: 0.16, dc: 135, ac: 11, ports: ['CCS2', 'Type 2'], spec: 'International' },
  };
  const CONNECTOR_TYPES = { 'CCS2': true, 'CCS1': true, 'GB/T DC': true, 'CHAdeMO': true, 'Type 2': false, 'Type 1': false, 'GB/T AC': false }; // true = DC
  // Telematics field coverage per OEM: 2 available, 1 model-dependent, 0 not available (expected; confirm during integration)
  const TELEMETRY_FIELDS = [
    ['soc', 'Battery %'], ['range', 'Range'], ['charging', 'Charging state'], ['odo', 'Odometer'], ['batteryTemp', 'Battery temp'],
    ['location', 'Location'], ['tyres', 'Tyre pressure'], ['aux12v', '12 V battery'], ['remote', 'Remote commands'],
  ];
  const OEMS = [
    { id: 'BYD', method: 'OEM partner API, or OBD-II telematics dongle', auth: 'Partner key + driver consent', cov: [2, 2, 2, 2, 1, 2, 1, 1, 0], status: 'pilot' },
    { id: 'Tesla', method: 'Tesla Fleet API', auth: 'OAuth 2.0, driver-approved scopes', cov: [2, 2, 2, 2, 1, 2, 2, 0, 2], status: 'pilot' },
    { id: 'Rivian', method: 'Telematics aggregator, or OBD-II dongle', auth: 'OAuth via aggregator', cov: [2, 2, 2, 2, 0, 2, 1, 0, 0], status: 'planned' },
    { id: 'Hyundai', method: 'Bluelink connected-car API', auth: 'OAuth 2.0', cov: [2, 2, 2, 2, 0, 2, 1, 0, 1], status: 'planned' },
    { id: 'Kia', method: 'Kia Connect API', auth: 'OAuth 2.0', cov: [2, 2, 2, 2, 0, 2, 1, 0, 1], status: 'planned' },
    { id: 'Nissan', method: 'OBD-II dongle (CAN bus)', auth: 'Device pairing', cov: [2, 1, 2, 2, 2, 2, 0, 2, 0], status: 'planned' },
    { id: 'Volkswagen', method: 'Connected-car API, or OBD-II dongle', auth: 'OAuth 2.0', cov: [2, 2, 2, 2, 0, 2, 0, 0, 1], status: 'planned' },
    { id: 'Ford', method: 'Ford Pro telematics API', auth: 'OAuth 2.0 (fleet)', cov: [2, 2, 2, 2, 1, 2, 2, 1, 1], status: 'planned' },
    { id: 'MG', method: 'OBD-II dongle', auth: 'Device pairing', cov: [2, 1, 2, 2, 1, 2, 0, 2, 0], status: 'planned' },
    { id: 'Any other EV', method: 'Universal OBD-II dongle, or manual entry', auth: 'Device pairing', cov: [1, 1, 1, 2, 1, 2, 0, 1, 0], status: 'available' },
  ];
  VF.MODELS = MODELS; VF.CONNECTOR_TYPES = CONNECTOR_TYPES; VF.OEMS = OEMS; VF.TELEMETRY_FIELDS = TELEMETRY_FIELDS;
  VF.model = (v) => MODELS[v.model] || MODELS['BYD Atto 3'];
  VF.isDC = (type) => !!CONNECTOR_TYPES[type];
  VF.compatible = (m, type) => m.ports.includes(type);
  VF.sessionMaxKw = (conn, m) => (VF.isDC(conn.type) ? Math.min(conn.kw, m.dc) : Math.min(conn.kw, m.ac));
  VF.rangeKm = (v) => (v.soc / 100 * VF.model(v).kwh) / (VF.model(v).eff * 1.05);

  // ------------------------------------------------------------------ seed data
  const FIRST = ['Kwame', 'Ama', 'Kofi', 'Akosua', 'Yaw', 'Esi', 'Kojo', 'Abena', 'Kwesi', 'Efua', 'Nana', 'Adwoa', 'Kweku', 'Afia', 'Yaa', 'Ebo', 'Dela', 'Naa', 'Kobby', 'Selorm', 'Mawuli', 'Fiifi', 'Akua', 'Edem', 'Elikem'];
  const LAST = ['Mensah', 'Owusu', 'Boateng', 'Asante', 'Darko', 'Appiah', 'Quaye', 'Ofori', 'Annan', 'Sarpong', 'Adjei', 'Agbeko', 'Baidoo', 'Tetteh', 'Ansah', 'Nkansah', 'Frimpong', 'Hammond', 'Kpodo', 'Acquah', 'Addo', 'Amoah'];
  const SIM_MODELS = Object.keys(MODELS);

  function defaultPricing(base) {
    return {
      bands: [
        { name: 'Off-peak', from: 22, to: 6, price: +(base - 0.5).toFixed(2) },
        { name: 'Standard', from: 6, to: 17, price: +base.toFixed(2) },
        { name: 'Peak', from: 17, to: 22, price: +(base + 0.6).toFixed(2) },
      ],
      dcPremium: 0.45, bookingFee: 2.0, idleFeePerMin: 0.5, idleGraceMin: 10, noShowFee: 10,
      graceMin: 15, maxBookingMin: 90, bookableShare: 60,
    };
  }
  function seed() {
    const r = mulberry32(11);
    const now = Date.now();
    const operators = [
      { id: 'op1', name: 'Accra Charge Co.', pricing: defaultPricing(2.6), support: '+233 30 290 1100' },
      { id: 'op2', name: 'GridPoint EV', pricing: defaultPricing(2.4), support: '+233 30 271 4455' },
    ];
    const st = (id, op, node, name, capKw, conns) => ({
      id, operatorId: op, node, name, capKw, status: 'online', lb: 'priority',
      connectors: conns.map(([type, kw], i) => ({ id: `${id}-${i + 1}`, label: 'C' + (i + 1), type, kw, status: 'Available', session: null })),
    });
    const stations = [
      st('st-air', 'op1', 'airport', 'Airport City Hub', 300, [['CCS2', 120], ['CCS2', 120], ['CCS1', 60], ['Type 2', 22], ['Type 2', 22]]),
      st('st-osu', 'op1', 'osu', 'Osu Oxford Street', 120, [['CCS2', 50], ['CHAdeMO', 50], ['Type 2', 22], ['Type 2', 22]]),
      st('st-ach', 'op1', 'achimota', 'Achimota Park & Charge', 160, [['CCS2', 60], ['GB/T DC', 60], ['Type 2', 22], ['Type 2', 22]]),
      st('st-spx', 'op1', 'spintex', 'Spintex Road Plaza', 150, [['CCS2', 60], ['GB/T DC', 60], ['Type 2', 22]]),
      st('st-elg', 'op1', 'eastlegon', 'East Legon Boundary Road', 200, [['CCS2', 150], ['CCS1', 60], ['Type 2', 22]]),
      st('st-tma', 'op2', 'tema', 'Tema Harbour Gate', 400, [['CCS2', 150], ['CCS2', 150], ['GB/T DC', 60], ['GB/T DC', 60]]),
      st('st-ksa', 'op2', 'kasoa', 'Kasoa Junction', 130, [['CCS2', 60], ['GB/T DC', 60], ['Type 2', 22]]),
      st('st-mad', 'op2', 'madina', 'Madina Market Square', 100, [['CCS2', 50], ['Type 2', 22], ['GB/T AC', 7]]),
      st('st-kan', 'op2', 'kaneshie', 'Kaneshie Market', 120, [['CCS2', 60], ['GB/T DC', 60], ['CHAdeMO', 50]]),
      st('st-mal', 'op2', 'mallam', 'Mallam Junction', 90, [['CCS2', 60], ['Type 2', 22]]),
    ];
    stations.find((s) => s.id === 'st-kan').connectors[1].status = 'Faulted';
    stations.find((s) => s.id === 'st-kan').connectors[1].error = 'GroundFailure';

    const consentsDefault = () => ({ telematics: true, shareSoc: true, shareEta: true, analytics: false, marketing: false });
    const users = [], drivers = [], vehicles = [];
    const addDriver = (id, first, last, modelName, plate, extra) => {
      const m = MODELS[modelName];
      users.push({ id: 'u-' + id, role: 'driver', name: `${first} ${last}`, email: `${first}.${last}`.toLowerCase() + '@example.com', phone: '+233 ' + pick(['24', '54', '20', '55'], r) + ' ' + (100 + Math.floor(r() * 900)) + ' ' + (1000 + Math.floor(r() * 9000)), driverId: id, demo: !!(extra && extra.demo), joined: now - Math.floor(r() * 200) * DAY });
      const consents = consentsDefault();
      if (extra && extra.sim) { consents.shareSoc = r() < 0.8; consents.shareEta = r() < 0.85; consents.analytics = r() < 0.45; consents.marketing = r() < 0.2; }
      drivers.push({ id, userId: 'u-' + id, vehicleId: 'v-' + id, consents, consentLog: [{ t: now - 30 * DAY, key: 'all', value: 'initial consent at sign-up' }], sim: !!(extra && extra.sim), deleted: false });
      vehicles.push({
        id: 'v-' + id, driverId: id, model: modelName, plate, vin: (m.oem.slice(0, 3).toUpperCase() + 'X' + hash(id + plate).slice(0, 6) + String(100000 + Math.floor(r() * 899999))).slice(0, 17),
        soc: 40 + r() * 50, odo: Math.round(4000 + r() * 50000), tempC: 29 + r() * 5, aux12v: +(12.4 + r() * 0.4).toFixed(1), tyres: [35, 35, 34, 35].map((p) => p + Math.round(r() * 2)),
        status: 'parked', node: pick(Object.keys(PLACES), r), trip: null, speedKmh: 32, linked: { method: OEMS.find((o) => o.id === m.oem).method, at: now - 20 * DAY, status: 'connected' },
        sim: !!(extra && extra.sim),
      });
    };
    addDriver('d1', 'Kwame', 'Asante', 'BYD Atto 3', 'GR 2841-24', { demo: true });
    addDriver('d2', 'Ama', 'Mensah', 'Tesla Model Y', 'GE 7710-23', { demo: true });
    addDriver('d3', 'Kofi', 'Boateng', 'Rivian R1S', 'GR 1066-25', { demo: true });
    for (let i = 1; i <= 26; i++) addDriver('ds' + i, pick(FIRST, r), pick(LAST, r), pick(SIM_MODELS, r), `G${pick(['R', 'E', 'T', 'W'], r)} ${1000 + Math.floor(r() * 9000)}-2${Math.floor(r() * 6)}`, { sim: true });
    users.push({ id: 'u-op1', role: 'operator', name: 'Yvonne Asare', email: 'yvonne@accracharge.example', phone: '+233 24 410 2287', operatorId: 'op1', demo: true, joined: now - 120 * DAY });
    users.push({ id: 'u-op2', role: 'operator', name: 'Daniel Owusu', email: 'daniel@gridpoint.example', phone: '+233 20 733 1940', operatorId: 'op2', demo: true, joined: now - 90 * DAY });
    users.push({ id: 'u-admin', role: 'admin', name: 'Joshua Angmortey', email: 'admin@voltfleetos.com', phone: '+233 20 000 0001', demo: true, joined: now - 300 * DAY });

    // Demo drivers start mid-journey
    const setTrip = (id, from, to, soc, done) => {
      const v = vehicles.find((x) => x.id === 'v-' + id);
      v.node = from; v.soc = soc; v.status = 'driving';
      v.trip = Object.assign(makeTrip(shortestPath(from, to).path), { origin: from, dest: to, stopKm: null, bookingId: null });
      v.trip.doneKm = done;
    };
    setTrip('d1', 'kasoa', 'tema', 21, 1.5);
    setTrip('d2', 'eastlegon', 'kasoa', 64, 1);
    setTrip('d3', 'adenta', 'central', 12, 0.5);

    const s = {
      version: 2, seq: 1000,
      clock: { t: now, speed: 20, paused: false },
      settings: { currency: 'GHS', tz: 0, reserve: 10, retention: { sessions: 730, eta: 1, audit: 2555, deletedAccount: 30 }, kAnon: 3 },
      operators, stations, users, drivers, vehicles,
      bookings: [], sessions: [], alerts: [], audit: [], ocpp: [], requests: [], notices: [],
    };
    VF.state = s;
    // Live walk-in sessions to start from a realistic, busy network
    for (const station of stations) for (const c of station.connectors) {
      if (c.status !== 'Available' || r() > 0.42) continue;
      const m = pick(SIM_MODELS.filter((n) => MODELS[n].ports.includes(c.type)), r);
      if (!m) continue;
      startSession(station, c, { model: m, soc: 15 + r() * 40, target: 80, driverId: r() < 0.5 ? pick(drivers.filter((d) => d.sim), r).id : null }, now - Math.floor(r() * 40) * MIN, true);
      c.session.kwh = r() * 20;
      ocpp(station.id, c.id, '←', 'StartTransaction', `walk-in · ${MODELS[m].oem}`, c.session.start);
    }
    // Upcoming bookings from other app users
    for (let i = 0; i < 12; i++) createSimBooking(now + (20 + r() * 260) * MIN, r);
    // Completed sessions earlier today (for today's totals)
    const day0 = VF.startOfDay(now);
    for (let i = 0; i < 70; i++) {
      const station = pick(stations, r); const c = pick(station.connectors, r);
      const m = pick(SIM_MODELS.filter((n) => MODELS[n].ports.includes(c.type)), r); if (!m) continue;
      const start = day0 + r() * Math.max(HOUR, now - day0 - HOUR);
      const kwh = VF.isDC(c.type) ? 15 + r() * 35 : 6 + r() * 14;
      const dur = kwh / Math.min(c.kw, VF.isDC(c.type) ? MODELS[m].dc : MODELS[m].ac) * 60 * 1.15;
      const end = Math.min(now - 5 * MIN, start + dur * MIN);
      const drv = r() < 0.6 ? pick(drivers, r).id : null;
      s.sessions.push({ id: 'x' + (++s.seq), stationId: station.id, operatorId: station.operatorId, connectorId: c.id, type: c.type, model: m, oem: MODELS[m].oem, driverId: drv, bookingId: drv && r() < 0.5 ? 'b-hist' : null, start, end, kwh, cost: kwh * priceAt(station.operatorId, start, c.type), status: 'completed' });
    }
    s.sessions.sort((a, b) => b.end - a.end);
    // Seeded alerts and history
    raiseAlert({ scope: 'op2', stationId: 'st-kan', sev: 'critical', kind: 'Charger fault', title: 'Kaneshie Market C2 faulted', body: 'OCPP StatusNotification: Faulted (GroundFailure). Bookings for GB/T DC at this site are routed to Achimota and Mallam.' }, now - 72 * MIN);
    raiseAlert({ scope: 'platform', sev: 'warning', kind: 'Integration', title: 'Rivian data via aggregator is in pilot', body: 'Rivian vehicles connect through a telematics aggregator. Battery temperature is not available from this source.' }, now - 5 * HOUR);
    raiseAlert({ scope: 'op1', stationId: 'st-air', sev: 'info', kind: 'Load management', title: 'Airport City Hub reached its 300 kW site limit at 12:40', body: 'Booked sessions kept full power; walk-in sessions were reduced for 6 minutes.' }, now - 3 * HOUR);
    s.requests.push({ id: 'rq1', driverId: 'ds4', type: 'export', t: now - 26 * HOUR, status: 'open' });
    s.requests.push({ id: 'rq2', driverId: 'ds9', type: 'erasure', t: now - 50 * HOUR, status: 'open' });
    s.requests.push({ id: 'rq3', driverId: 'ds12', type: 'export', t: now - 9 * DAY, status: 'done', doneAt: now - 8 * DAY });
    audit('u-admin', 'reveal-pii', VF.pseudo('ds7') + ' (phone)', 'Support ticket #4471', now - 2 * DAY);
    audit('u-op1', 'remote-command', 'st-osu-2 Reset', null, now - 7 * HOUR);
    audit('u-admin', 'export', 'Network sessions CSV (pseudonymous)', null, now - 3 * DAY);
    ocpp('st-kan', 'st-kan-2', '←', 'StatusNotification', 'Faulted · GroundFailure', now - 72 * MIN);
    s.ocpp.sort((a, b) => b.t - a.t);
    return s;
  }
  VF.seed = seed;

  // ------------------------------------------------------------------ lookups
  VF.user = (id) => VF.state.users.find((u) => u.id === id);
  VF.driver = (id) => VF.state.drivers.find((d) => d.id === id);
  VF.vehicle = (id) => VF.state.vehicles.find((v) => v.id === id);
  VF.station = (id) => VF.state.stations.find((s) => s.id === id);
  VF.operator = (id) => VF.state.operators.find((o) => o.id === id);
  VF.connector = (id) => { for (const s of VF.state.stations) { const c = s.connectors.find((x) => x.id === id); if (c) return c; } return null; };
  VF.stationOf = (connId) => VF.state.stations.find((s) => s.connectors.some((c) => c.id === connId));
  VF.booking = (id) => VF.state.bookings.find((b) => b.id === id);
  VF.driverVehicle = (driverId) => VF.state.vehicles.find((v) => v.driverId === driverId);
  VF.activeBooking = (driverId) => VF.state.bookings.find((b) => b.driverId === driverId && ['confirmed', 'charging'].includes(b.status));

  // ------------------------------------------------------------------ privacy layer
  // What each role may see. The UI and the redaction helpers below both follow this table.
  VF.ACCESS = [
    ['Name, email, phone', 'Own', 'Never', 'Masked; reveal needs a reason and is audited'],
    ['Plate and VIN', 'Own', 'Never (booking code instead)', 'Masked; reveal needs a reason and is audited'],
    ['Live GPS location', 'Own', 'Never', 'Never; only zone counts of 3 or more vehicles'],
    ['Trip origin and destination', 'Own', 'Never', 'Never'],
    ['Live ETA to a booked station', 'Own', 'Only if the driver shares ETA', 'Aggregated only'],
    ['Battery % at arrival and while charging', 'Own', 'Only if the driver shares battery %', 'Aggregated only'],
    ['Vehicle make and model', 'Own', 'Yes, for connector matching', 'Yes'],
    ['Charging sessions and bookings', 'Own', 'Own stations, pseudonymous driver ID', 'All, pseudonymous driver ID'],
    ['Vehicle telemetry (12 V, tyres, temperatures)', 'Own', 'Never', 'Never; integration health only'],
  ];
  // Pseudonym differs per operator, so operators cannot link one driver across networks.
  VF.pseudo = (driverId, scope) => (driverId ? 'Driver ·' + hash(driverId + '|' + (scope || 'platform')).slice(0, 4) : 'Walk-in guest');
  VF.mask = {
    name(n) { return String(n || '').split(' ').map((p) => (p ? p[0] + '•'.repeat(Math.max(2, Math.min(5, p.length - 1))) : '')).join(' '); },
    email(e) { if (!e) return '—'; const [u, d] = e.split('@'); return u[0] + '•••@' + d; },
    phone(p) { if (!p) return '—'; return p.replace(/\d(?=(?:\D*\d){3})/g, '•').replace(/^\+•••/, '+233'); },
    plate(p) { if (!p) return '—'; return p.replace(/\d{2}(?=\d{2}-)/, '••'); },
    vin(v) { return v ? v.slice(0, 4) + '•••••••••' + v.slice(-4) : '—'; },
  };
  VF.consent = (driverId, key) => { const d = VF.driver(driverId); return !!(d && !d.deleted && d.consents[key]); };
  function audit(actor, action, target, reason, t) {
    const u = VF.user(actor);
    VF.state.audit.unshift({ t: t || VF.now(), actor, role: u ? u.role : 'system', action, target, reason: reason || null });
    if (VF.state.audit.length > 600) VF.state.audit.length = 600;
  }
  VF.audit = audit;

  // ------------------------------------------------------------------ alerts, notices, OCPP log
  function raiseAlert(a, t) {
    const s = VF.state;
    if (a.key && s.alerts.some((x) => x.key === a.key && !x.resolved)) return null;
    const al = Object.assign({ id: 'al' + (++s.seq), t: t || VF.now(), acked: false, resolved: false }, a);
    s.alerts.unshift(al);
    if (s.alerts.length > 300) s.alerts.length = 300;
    return al;
  }
  VF.raiseAlert = raiseAlert;
  function notify(driverId, title, body) {
    const s = VF.state;
    s.notices.unshift({ id: 'n' + (++s.seq), driverId, t: VF.now(), title, body, read: false });
    if (s.notices.length > 200) s.notices.length = 200;
    if (VF.onNotice) VF.onNotice(driverId, title);
  }
  VF.notify = notify;
  function ocpp(stationId, connId, dir, action, payload, t) {
    const s = VF.state;
    s.ocpp.unshift({ t: t || VF.now(), stationId, connId, dir, action, payload });
    if (s.ocpp.length > 400) s.ocpp.length = 400;
  }
  VF.ocpp = ocpp;

  // ------------------------------------------------------------------ pricing
  function bandIndex(op, ms) {
    const h = VF.hourOf(ms); const bands = VF.operator(op).pricing.bands;
    for (let i = 0; i < bands.length; i++) { const f = +bands[i].from, t = +bands[i].to; if (f <= t ? h >= f && h < t : h >= f || h < t) return i; }
    return 1;
  }
  function priceAt(opId, ms, type) { const p = VF.operator(opId).pricing; return +p.bands[bandIndex(opId, ms)].price + (VF.isDC(type) ? +p.dcPremium : 0); }
  VF.bandIndex = bandIndex; VF.priceAt = priceAt;

  // ------------------------------------------------------------------ sessions on connectors
  function startSession(station, c, info, t, quiet) {
    const m = MODELS[info.model];
    c.session = {
      id: 'x' + (++VF.state.seq), start: t || VF.now(), kwh: 0, cost: 0, kw: 0,
      model: info.model, oem: m.oem, battery: m.kwh, soc: info.soc, socStart: info.soc, target: info.target || 80,
      driverId: info.driverId || null, bookingId: info.bookingId || null, vehicleId: info.vehicleId || null, fleet: info.fleet || null,
    };
    c.status = 'Charging'; c.reservedFor = null; c.until = null;
    if (!quiet) ocpp(station.id, c.id, '←', 'StartTransaction', `${info.bookingId ? 'booking ' + VF.booking(info.bookingId).code : 'walk-in'} · ${m.oem}`);
  }
  VF.startSession = startSession;
  function endSession(station, c, reason) {
    const se = c.session; if (!se) return;
    const now = VF.now();
    const b = se.bookingId && VF.booking(se.bookingId);
    const fee = b ? +VF.operator(station.operatorId).pricing.bookingFee : 0;
    VF.state.sessions.unshift({ id: se.id, stationId: station.id, operatorId: station.operatorId, connectorId: c.id, type: c.type, model: se.model, oem: se.oem, driverId: se.driverId, bookingId: se.bookingId, start: se.start, end: now, kwh: se.kwh, cost: se.cost + fee, socStart: se.socStart, socEnd: se.soc, vehicleId: se.vehicleId || null, fleet: se.fleet || null, status: reason || 'completed' });
    if (VF.state.sessions.length > 800) VF.state.sessions.length = 800;
    ocpp(station.id, c.id, '←', 'StopTransaction', `${fmt.kwh(se.kwh)} · ${reason || 'EVDisconnected'}`);
    c.session = null;
    if (b) {
      b.status = reason === 'stopped' ? 'stopped' : 'completed'; b.actualKwh = se.kwh; b.actualCost = se.cost + fee; b.endedAt = now;
      if (b.driverId && !b.sim) notify(b.driverId, 'Charging complete', `${fmt.kwh(se.kwh)} added at ${station.name} for ${fmt.money(se.cost + fee)}. You can continue your trip.`);
    }
    if (se.vehicleId) {
      const v = VF.vehicle(se.vehicleId);
      if (v) { v.soc = se.soc; v.chargingAt = null; if (v.trip && !v.trip.done) { v.status = 'driving'; v.trip.stopKm = null; v.trip.bookingId = null; } else v.status = 'parked'; }
    }
    if (VF.onSessionEnd) VF.onSessionEnd(se, station, c, reason);
  }
  VF.endSession = endSession;
  // When will this connector be free (ms)? null if out of service.
  function freeAt(c) {
    const now = VF.now();
    if (c.status === 'Faulted' || c.status === 'Unavailable') return c.until && c.status === 'Unavailable' ? c.until : null;
    if (c.session) {
      const m = MODELS[c.session.model];
      const left = Math.max(0, (c.session.target - c.session.soc) / 100 * m.kwh);
      const kw = Math.max(3, c.session.kw || VF.sessionMaxKw(c, m) * 0.7);
      return now + (left / kw * 60 * 1.1 + 3) * MIN;
    }
    if (c.status === 'Finishing') return c.until || now;
    return now;
  }
  VF.freeAt = freeAt;
  const LIVE = ['confirmed', 'charging'];
  function slotFree(c, start, end, ignoreId) {
    const f = freeAt(c); if (f === null || f > start) return false;
    return !VF.state.bookings.some((b) => b.connectorId === c.id && b.id !== ignoreId && LIVE.includes(b.status) && start < b.end + 5 * MIN && end > b.start - 5 * MIN);
  }
  VF.slotFree = slotFree;
  VF.nextBooking = (c) => VF.state.bookings.filter((b) => b.connectorId === c.id && b.status === 'confirmed').sort((a, b) => a.start - b.start)[0] || null;

  // ------------------------------------------------------------------ booking engine
  function chargeMinutes(c, m, kwh) { return kwh / Math.max(1, VF.sessionMaxKw(c, m)) * 60 * 1.12 + 2; }
  function newBooking(fields) {
    const s = VF.state;
    const b = Object.assign({ id: 'b' + (++s.seq), code: 'VF-' + code4(), createdAt: VF.now(), status: 'confirmed' }, fields);
    s.bookings.unshift(b);
    if (s.bookings.length > 400) s.bookings.length = 400;
    return b;
  }
  function createSimBooking(start, r) {
    r = r || Math.random;
    const s = VF.state;
    const d = pick(s.drivers.filter((x) => x.sim && !x.deleted), r); if (!d) return null;
    const v = VF.driverVehicle(d.id); const m = VF.model(v);
    const opts = [];
    for (const station of s.stations) for (const c of station.connectors) if (VF.compatible(m, c.type) && VF.isDC(c.type)) opts.push([station, c]);
    if (!opts.length) return null;
    const [station, c] = pick(opts, r);
    const soc = 12 + r() * 35, target = 80;
    const kwh = (target - soc) / 100 * m.kwh;
    const dur = chargeMinutes(c, m, kwh);
    const startR = Math.ceil(start / (5 * MIN)) * 5 * MIN, end = startR + dur * MIN;
    if (!slotFree(c, startR, end)) return null;
    return newBooking({
      driverId: d.id, vehicleId: v.id, model: v.model, stationId: station.id, operatorId: station.operatorId, connectorId: c.id,
      start: startR, end, eta: startR, estKwh: kwh, estCost: kwh * priceAt(station.operatorId, startR, c.type) + VF.operator(station.operatorId).pricing.bookingFee,
      targetSoc: target, arrivalSoc: soc, sim: true, arriveAt: startR + (r() * 13 - 5) * MIN, noShow: r() < 0.07, source: r() < 0.6 ? 'auto' : 'manual',
    });
  }
  VF.createSimBooking = createSimBooking;

  // Evaluate every connector the driver could use on the way to their destination.
  function evaluateRoute(driverId) {
    const s = VF.state; const v = VF.driverVehicle(driverId); const m = VF.model(v);
    const now = VF.now();
    const pos = v.trip ? posAt(v.trip, v.trip.doneKm) : PLACES[v.node];
    const here = nearestNode(pos.lat, pos.lon);
    const dest = v.trip && !v.trip.done ? v.trip.dest : null;
    const directKm = dest ? shortestPath(here, dest).km : 0;
    const usable = v.soc / 100 * m.kwh;
    const perKm = m.eff * 1.05;
    const reserve = s.settings.reserve;
    const stats = { stations: 0, connectors: 0, compatible: 0, incompatible: 0, busy: 0, free: 0, outOfService: 0, unreachable: 0 };
    const options = [];
    for (const st of s.stations) {
      if (st.status !== 'online') continue;
      const toKm = shortestPath(here, st.node).km + hav(pos, PLACES[here]) * ROAD_FACTOR;
      const onKm = dest ? shortestPath(st.node, dest).km : 0;
      const detour = dest ? Math.max(0, toKm + onKm - directKm) : toKm;
      if (dest && detour > 9) continue;
      if (!dest && toKm > 20) continue;
      stats.stations++;
      const arriveSoc = (usable - toKm * perKm) / m.kwh * 100;
      const travelMin = toKm / v.speedKmh * 60;
      const eta = now + travelMin * MIN;
      const needSoc = dest ? (onKm * perKm) / m.kwh * 100 + reserve + 10 : 0;
      const target = clamp(Math.max(needSoc, 70), 60, 90);
      const kwh = Math.max(3, (target - Math.max(0, arriveSoc)) / 100 * m.kwh);
      for (const c of st.connectors) {
        stats.connectors++;
        if (!VF.compatible(m, c.type)) { stats.incompatible++; continue; }
        stats.compatible++;
        if (arriveSoc < 3) { stats.unreachable++; continue; }
        if (c.status === 'Faulted' || c.status === 'Unavailable') { stats.outOfService++; continue; }
        const dur = chargeMinutes(c, m, kwh);
        let start = Math.ceil(eta / MIN) * MIN, waited = 0;
        for (let k = 0; k < 24 && !slotFree(c, start, start + dur * MIN); k++) { start += 10 * MIN; waited += 10; }
        if (!slotFree(c, start, start + dur * MIN)) { stats.busy++; continue; }
        if (waited > 0) stats.busy++; else stats.free++;
        const price = priceAt(st.operatorId, start, c.type);
        const cost = kwh * price + +VF.operator(st.operatorId).pricing.bookingFee;
        const score = detour / v.speedKmh * 60 + waited * 1.6 + dur * 0.35 + price * 3 + (arriveSoc < reserve ? 25 : 0);
        options.push({ station: st, c, eta, start, end: start + dur * MIN, wait: waited, dur, kwh, target, arriveSoc, detour, cost, price, score, toKm });
      }
    }
    options.sort((a, b) => a.score - b.score);
    return { v, m, here, dest, directKm, stats, options, arriveDestSoc: dest ? (usable - directKm * perKm) / m.kwh * 100 : null };
  }
  VF.evaluateRoute = evaluateRoute;

  function book(driverId, opt, source) {
    const s = VF.state; const v = VF.driverVehicle(driverId);
    const existing = VF.activeBooking(driverId);
    if (existing) cancelBooking(existing.id, 'u-' + driverId, 'Replaced by a new booking');
    const b = newBooking({
      driverId, vehicleId: v.id, model: v.model, stationId: opt.station.id, operatorId: opt.station.operatorId, connectorId: opt.c.id,
      start: opt.start, end: opt.end, eta: opt.eta, estKwh: opt.kwh, estCost: opt.cost, targetSoc: Math.round(opt.target),
      arrivalSoc: Math.max(0, opt.arriveSoc), sim: false, source: source || 'auto',
    });
    // Route the trip through the station
    const pos = v.trip ? posAt(v.trip, v.trip.doneKm) : PLACES[v.node];
    const here = nearestNode(pos.lat, pos.lon);
    const dest = v.trip && !v.trip.done ? v.trip.dest : opt.station.node;
    const nodes = shortestPath(here, opt.station.node).path.concat(shortestPath(opt.station.node, dest).path.slice(1));
    const trip = Object.assign(makeTrip(nodes, [pos.lat, pos.lon]), { origin: v.trip ? v.trip.origin : here, dest, bookingId: b.id });
    trip.stopKm = trip.segKm[0] + shortestPath(here, opt.station.node).km;
    v.trip = trip; if (v.status === 'parked') v.status = 'driving';
    raiseAlert({ scope: opt.station.operatorId, stationId: opt.station.id, sev: 'info', kind: 'New booking', bookingId: b.id,
      title: `New booking ${b.code} at ${opt.station.name}`,
      body: `${v.model} · connector ${opt.c.label} (${opt.c.type}) · slot ${VF.fmtTime(b.start)}–${VF.fmtTime(b.end)} · ${VF.pseudo(driverId, opt.station.operatorId)}. Booked ${source === 'auto' ? 'with one tap' : 'manually'} in the driver app.` });
    ocpp(opt.station.id, opt.c.id, '→', 'Slot held', `${b.code} · ${VF.fmtTime(b.start)}–${VF.fmtTime(b.end)} (ReserveNow sent 15 min before arrival)`);
    notify(driverId, `Booked: ${opt.station.name}`, `Connector ${opt.c.label} (${opt.c.type}, ${opt.c.kw} kW) is held for you from ${VF.fmtTime(b.start)}. Code ${b.code}.`);
    return b;
  }
  VF.book = book;
  function cancelBooking(id, actor, reason) {
    const b = VF.booking(id); if (!b || !LIVE.includes(b.status)) return;
    const c = VF.connector(b.connectorId); const st = VF.station(b.stationId);
    if (b.status === 'charging' && c && c.session && c.session.bookingId === id) { endSession(st, c, 'stopped'); c.status = 'Finishing'; c.until = VF.now() + 2 * MIN; }
    b.status = 'cancelled'; b.cancelReason = reason || null; b.endedAt = VF.now();
    if (c && c.reservedFor === id) { c.status = 'Available'; c.reservedFor = null; ocpp(st.id, c.id, '→', 'CancelReservation', b.code); }
    const v = b.vehicleId && VF.vehicle(b.vehicleId);
    if (v && !b.sim && v.trip && v.trip.bookingId === id) {
      if (!v.trip.done) {
        const pos = posAt(v.trip, v.trip.doneKm);
        const here = nearestNode(pos.lat, pos.lon);
        v.trip = Object.assign(makeTrip(shortestPath(here, v.trip.dest).path, [pos.lat, pos.lon]), { origin: v.trip.origin, dest: v.trip.dest, stopKm: null, bookingId: null });
      }
      if (v.status === 'waiting') v.status = 'driving';
    }
  }
  VF.cancelBooking = cancelBooking;
  function moveBookings(st, c) {
    let moved = 0, cancelled = 0;
    for (const b of VF.state.bookings.filter((x) => x.connectorId === c.id && x.status === 'confirmed')) {
      const m = MODELS[b.model];
      const alt = st.connectors.find((x) => x.id !== c.id && VF.compatible(m, x.type) && slotFree(x, b.start, b.end, b.id));
      if (alt) {
        b.connectorId = alt.id; moved++;
        if (!b.sim) notify(b.driverId, 'Your connector changed', `${st.name}: your slot ${b.code} moved to ${alt.label} (${alt.type}). Same time, no queue.`);
      } else {
        cancelBooking(b.id, 'system', 'Connector out of service'); cancelled++;
        if (!b.sim) notify(b.driverId, 'Booking cancelled: charger out of service', `${st.name} can't serve ${b.code}. No fee. Tap "Book on my route" for another slot.`);
      }
    }
    return { moved, cancelled };
  }
  VF.moveBookings = moveBookings;

  function startTrip(driverId, dest) {
    const v = VF.driverVehicle(driverId);
    const pos = v.trip && !v.trip.done ? posAt(v.trip, v.trip.doneKm) : PLACES[v.node];
    const here = nearestNode(pos.lat, pos.lon);
    const b = VF.activeBooking(driverId); if (b && b.status === 'confirmed') cancelBooking(b.id, 'u-' + driverId, 'Trip changed');
    v.trip = Object.assign(makeTrip(shortestPath(here, dest).path, v.trip && !v.trip.done ? [pos.lat, pos.lon] : null), { origin: here, dest, stopKm: null, bookingId: null });
    v.status = 'driving';
  }
  VF.startTrip = startTrip;

  // ------------------------------------------------------------------ live simulation
  // Site load history lives in the shared state so every open tab sees the same sparkline.
  Object.defineProperty(VF, 'loadSamples', { get: () => (VF.state.loadSamples = VF.state.loadSamples || {}) });
  const taper = (soc, dc) => (!dc ? (soc < 95 ? 1 : 0.3) : soc < 55 ? 1 : soc < 80 ? 1 - (soc - 55) / 25 * 0.45 : 0.35);
  function allocate(st) {
    const active = st.connectors.filter((c) => c.status === 'Charging' && c.session);
    const want = active.map((c) => VF.sessionMaxKw(c, MODELS[c.session.model]) * taper(c.session.soc, VF.isDC(c.type)));
    const total = sum(want);
    if (total <= st.capKw) { active.forEach((c, i) => { c.session.kw = want[i]; c.session.limited = false; }); return total; }
    if (st.lb === 'priority') {
      let left = st.capKw;
      active.forEach((c, i) => { if (c.session.bookingId) { c.session.kw = Math.min(want[i], left); left -= c.session.kw; c.session.limited = c.session.kw < want[i] - 0.1; } });
      const rest = active.map((c, i) => [c, i]).filter(([c]) => !c.session.bookingId);
      const restWant = sum(rest, ([, i]) => want[i]);
      rest.forEach(([c, i]) => { c.session.kw = restWant ? want[i] * Math.min(1, Math.max(0, left) / restWant) : 0; c.session.limited = c.session.kw < want[i] - 0.1; });
    } else {
      active.forEach((c, i) => { c.session.kw = want[i] * st.capKw / total; c.session.limited = true; });
    }
    if (!st._capAlert || VF.now() - st._capAlert > 2 * HOUR) {
      st._capAlert = VF.now();
      raiseAlert({ scope: st.operatorId, stationId: st.id, sev: 'info', kind: 'Load management', title: `${st.name} reached its ${st.capKw} kW site limit`, body: st.lb === 'priority' ? 'Booked sessions kept full power; walk-in sessions were reduced.' : 'All sessions were reduced equally.' });
    }
    return st.capKw;
  }
  function stationsStep(dtMin) {
    const s = VF.state; const now = VF.now();
    const hour = VF.hourOf(now);
    const walkRate = (hour >= 7 && hour < 21 ? 0.010 : 0.003); // arrivals per connector per minute
    for (const st of s.stations) {
      for (const c of st.connectors) {
        if (c.until && now >= c.until && (c.status === 'Finishing' || c.status === 'Unavailable')) {
          c.status = 'Available'; c.until = null; ocpp(st.id, c.id, '←', 'StatusNotification', 'Available');
        }
        const nb = VF.nextBooking(c);
        if (c.status === 'Available' && nb && nb.start - now <= 15 * MIN) {
          c.status = 'Reserved'; c.reservedFor = nb.id; ocpp(st.id, c.id, '→', 'ReserveNow', `${nb.code} · expires ${VF.fmtTime(nb.start + VF.operator(st.operatorId).pricing.graceMin * MIN)}`);
        }
        // simulated app users arriving for their booking
        if (nb && nb.sim && nb.status === 'confirmed') {
          const grace = VF.operator(st.operatorId).pricing.graceMin * MIN;
          if (nb.noShow && now > nb.start + grace) {
            nb.status = 'no-show'; nb.endedAt = now;
            if (c.reservedFor === nb.id) { c.status = 'Available'; c.reservedFor = null; ocpp(st.id, c.id, '←', 'StatusNotification', `Available · reservation ${nb.code} expired`); }
          } else if (!nb.noShow && now >= nb.arriveAt && (c.status === 'Reserved' || c.status === 'Available')) {
            nb.status = 'charging';
            startSession(st, c, { model: nb.model, soc: nb.arrivalSoc, target: nb.targetSoc, driverId: nb.driverId, bookingId: nb.id });
          }
        }
        // walk-ins only take a connector if they'll be done before the next booking: booked drivers never queue
        if (c.status === 'Available' && Math.random() < walkRate * dtMin) {
          const models = SIM_MODELS.filter((n) => MODELS[n].ports.includes(c.type));
          if (models.length) {
            const m = pick(models); const soc = 12 + Math.random() * 45;
            const dur = chargeMinutes(c, MODELS[m], (80 - soc) / 100 * MODELS[m].kwh);
            if (!nb || now + (dur + 10) * MIN < nb.start - 15 * MIN) {
              const sim = s.drivers.filter((d) => d.sim && !d.deleted && VF.driverVehicle(d.id).model === m);
              startSession(st, c, { model: m, soc, target: 80, driverId: sim.length && Math.random() < 0.5 ? pick(sim).id : null });
            }
          }
        }
        if ((c.status === 'Available' || c.status === 'Charging') && Math.random() < 0.00004 * dtMin) {
          if (c.session) endSession(st, c, 'stopped');
          c.status = 'Faulted'; c.error = pick(['GroundFailure', 'OverCurrentFailure', 'ConnectorLockFailure', 'PowerMeterFailure', 'HighTemperature']);
          ocpp(st.id, c.id, '←', 'StatusNotification', 'Faulted · ' + c.error);
          moveBookings(st, c);
          raiseAlert({ scope: st.operatorId, stationId: st.id, key: 'fault-' + c.id, sev: 'critical', kind: 'Charger fault', title: `${st.name} ${c.label} faulted`, body: `OCPP StatusNotification: Faulted (${c.error}). Upcoming bookings on this connector need moving.` });
        }
      }
      const load = allocate(st);
      for (const c of st.connectors) {
        const se = c.session; if (!se || c.status !== 'Charging') continue;
        const e = se.kw * dtMin / 60;
        se.kwh += e; se.cost += e * priceAt(st.operatorId, now, c.type);
        se.soc = Math.min(100, se.soc + e * 0.93 / se.battery * 100);
        if (se.vehicleId) { const v = VF.vehicle(se.vehicleId) || (VF.fleetVehicle && VF.fleetVehicle(se.vehicleId)); if (v) v.soc = se.soc; }
        if (se.soc >= se.target) {
          endSession(st, c);
          c.status = 'Finishing'; c.until = now + 3 * MIN;
        }
      }
      const arr = VF.loadSamples[st.id] = VF.loadSamples[st.id] || [];
      arr.push({ t: now, kw: load }); if (arr.length > 120) arr.shift();
    }
  }
  function driversStep(dtMin) {
    const s = VF.state; const now = VF.now();
    for (const v of s.vehicles) {
      if (v.sim) continue;
      const d = VF.driver(v.driverId); if (!d || d.deleted) continue;
      const m = VF.model(v);
      if (v.status === 'driving' && v.trip && !v.trip.done) {
        const goal = v.trip.stopKm != null ? v.trip.stopKm : v.trip.totalKm;
        const step = Math.max(0, Math.min(v.speedKmh * dtMin / 60, goal - v.trip.doneKm));
        v.trip.doneKm += step; v.odo += step;
        v.soc = Math.max(0, v.soc - step * m.eff * 1.05 / m.kwh * 100);
        v.tempC = clamp(v.tempC + (Math.random() - 0.48) * 0.08, 26, 42);
        if (v.soc <= 0.3) {
          v.status = 'stranded';
          notify(d.id, 'Battery empty', 'Your vehicle has stopped. Roadside assistance has your booking code but not your location; share it from the app if you want help.');
          continue;
        }
        const b = v.trip.bookingId && VF.booking(v.trip.bookingId);
        if (b && b.status === 'confirmed' && d.consents.shareEta) b.eta = now + (Math.max(0, v.trip.stopKm - v.trip.doneKm) / v.speedKmh * 60) * MIN;
        if (b && d.consents.shareSoc) b.arrivalSoc = v.soc - Math.max(0, (v.trip.stopKm || 0) - v.trip.doneKm) * m.eff * 1.05 / m.kwh * 100;
        if (v.trip.stopKm != null && v.trip.doneKm >= v.trip.stopKm - 1e-6) arriveAtStation(v, d);
        else if (v.trip.doneKm >= v.trip.totalKm - 1e-6) {
          v.trip.done = true; v.status = 'parked'; v.node = v.trip.dest;
          notify(d.id, `Arrived at ${PLACES[v.trip.dest].name}`, `${Math.round(v.soc)}% battery left (${fmt.km(VF.rangeKm(v))} range).`);
        }
      } else if (v.status === 'waiting') {
        arriveAtStation(v, d);
      }
    }
  }
  function arriveAtStation(v, d) {
    const b = VF.booking(v.trip.bookingId);
    if (!b || b.status !== 'confirmed') { v.trip.stopKm = null; v.status = 'driving'; return; }
    const st = VF.station(b.stationId); let c = VF.connector(b.connectorId);
    const m = VF.model(v);
    if (!(c.status === 'Reserved' && c.reservedFor === b.id) && c.status !== 'Available') {
      const alt = st.connectors.find((x) => VF.compatible(m, x.type) && (x.status === 'Available' || (x.status === 'Reserved' && x.reservedFor === b.id)) && (!VF.nextBooking(x) || VF.nextBooking(x).id === b.id || VF.nextBooking(x).start > VF.now() + b.end - b.start));
      if (!alt) { if (v.status !== 'waiting') notify(d.id, 'Your connector is finishing a session', 'You are first in line; charging starts when it frees up.'); v.status = 'waiting'; return; }
      b.connectorId = alt.id; c = alt;
    }
    v.status = 'charging'; v.chargingAt = { stationId: st.id, connectorId: c.id };
    b.status = 'charging'; b.arrivedAt = VF.now();
    startSession(st, c, { model: v.model, soc: v.soc, target: b.targetSoc, driverId: d.id, bookingId: b.id, vehicleId: v.id });
    notify(d.id, 'Charging started', `${st.name}, connector ${c.label}. No queue: your slot was held for you.`);
  }
  function bookingsStep(dtMin) {
    const s = VF.state; const now = VF.now();
    if (Math.random() < 0.03 * dtMin) createSimBooking(now + (25 + Math.random() * 200) * MIN);
    for (const b of s.bookings) {
      if (b.status !== 'confirmed' || !b.sim) continue;
      if (now > b.start + 90 * MIN) { b.status = 'no-show'; b.endedAt = now; }
    }
  }
  VF.tick = function (realMs) {
    const s = VF.state; if (s.clock.paused) return 0;
    const dtMin = realMs / 60000 * s.clock.speed;
    s.clock.t += dtMin * MIN;
    driversStep(dtMin); stationsStep(dtMin); bookingsStep(dtMin);
    return dtMin;
  };

  // ------------------------------------------------------------------ demo history (30 days per station)
  let histCache = null;
  VF.history = function () {
    const s = VF.state;
    const key = s.stations.map((x) => x.id + x.connectors.length).join() + JSON.stringify(s.operators.map((o) => o.pricing.bands));
    if (histCache && histCache.key === key) return histCache;
    const r = mulberry32(2026); const days = 30; const day0 = VF.startOfDay(VF.now()) - days * DAY;
    const rows = [];
    for (let d = 0; d < days; d++) for (const st of s.stations) {
      const dc = st.connectors.filter((c) => VF.isDC(c.type)).length, ac = st.connectors.length - dc;
      const growth = 0.75 + d / days * 0.4;
      const sessions = Math.round((dc * (5 + r() * 4) + ac * (1.5 + r() * 2)) * growth);
      const kwh = sessions * (14 + r() * 14);
      const avgPrice = sum(VF.operator(st.operatorId).pricing.bands, (b) => +b.price) / 3 + 0.3;
      const bookedShare = 0.12 + d / days * 0.3 + r() * 0.05;
      rows.push({ d, date: day0 + d * DAY, stationId: st.id, operatorId: st.operatorId, sessions, kwh, revenue: kwh * avgPrice + sessions * bookedShare * 2, booked: Math.round(sessions * bookedShare), noShows: Math.round(sessions * bookedShare * (0.04 + r() * 0.05)), util: clamp((kwh / (dc * 60 + ac * 9) / 24) * 100 * 2.4, 5, 95) });
    }
    histCache = { key, rows, days, day0 };
    return histCache;
  };
  VF.todayStats = function (filter) {
    const s = VF.state; const day0 = VF.startOfDay(VF.now());
    const done = s.sessions.filter((x) => x.end >= day0 && filter(x.stationId));
    const live = []; for (const st of s.stations) if (filter(st.id)) for (const c of st.connectors) if (c.session) live.push(c.session);
    return { sessions: done.length + live.length, kwh: sum(done, (x) => x.kwh) + sum(live, (x) => x.kwh), revenue: sum(done, (x) => x.cost) + sum(live, (x) => x.cost), live: live.length };
  };

  // ------------------------------------------------------------------ persistence & cross-tab sync
  // One shared world per browser: every tab reads and writes the same state, tagged with a revision.
  // Who is signed in is per tab (sessionStorage), so a driver tab and an operator tab can sit side by side.
  const STORE_KEY = 'voltfleet-os:v2', REV_KEY = 'voltfleet-os:rev', SESSION_KEY = 'voltfleet-os:session';
  VF.STORE_KEY = STORE_KEY;
  VF.storageOk = true;
  // Keep a copy on this device (fast reloads, offline use) without claiming a new revision.
  // Serialise the world for storage and sync. Vehicles connected live (Smartcar) belong to one device and
  // are never written: they are dropped from the fleet's vehicle list here.
  VF.stateJSON = (st) => JSON.stringify(st, function (k, v) { return k === 'vehicles' && Array.isArray(v) && this && this.depots ? v.filter((x) => !x.real) : v; });
  VF.saveLocal = function () {
    try { localStorage.setItem(STORE_KEY, '{"state":' + VF.stateJSON(VF.state) + '}'); VF.storageOk = true; } catch (e) { VF.storageOk = false; }
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(VF.session || null)); } catch (e) { /* per-tab sign-in not kept */ }
  };
  VF.save = function () {
    if (VF.cloud && VF.cloud.online && VF.cloud.online()) { VF.cloud.push(); return; }
    try {
      const stored = Number(localStorage.getItem(REV_KEY)) || 0;
      VF.state.rev = Math.max(VF.state.rev || 0, stored) + 1;
      localStorage.setItem(STORE_KEY, '{"state":' + VF.stateJSON(VF.state) + '}');
      localStorage.setItem(REV_KEY, String(VF.state.rev));
      VF.storageOk = true;
    } catch (e) { VF.storageOk = false; }
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(VF.session || null)); } catch (e) { /* per-tab sign-in not kept */ }
  };
  // State from storage or another device is untrusted: no markup characters in any text, ids stay plain tokens,
  // and prototype keys are dropped. Pages also escape on output; this is the second layer.
  const SAFE_CH = { '<': '‹', '>': '›', '"': '”', '`': 'ʹ', "'": '’' };
  VF.sanitizeState = function (st) {
    const seen = new Set();
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || seen.has(o) || depth > 40) return; seen.add(o);
      for (const k of Object.keys(o)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') { delete o[k]; continue; }
        const v = o[k];
        if (typeof v === 'string') {
          if (k === 'payload') continue; // OCPP log text: escaped where shown
          let s = /[<>"`']/.test(v) ? v.replace(/[<>"`']/g, (c) => SAFE_CH[c]) : v;
          if ((k === 'id' || /Id$/.test(k)) && !/^[\w.:@-]*$/.test(s)) s = s.replace(/[^\w.:@-]/g, '_');
          if (s !== v) o[k] = s;
        } else if (v && typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(st, 0); return st;
  };
  VF.load = function () {
    try { VF.session = JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { VF.session = null; }
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY));
      if (raw && raw.state && raw.state.version === 2) { VF.state = VF.sanitizeState(raw.state); return true; }
    } catch (e) { /* storage unavailable */ }
    return false;
  };
  // Take a newer state written by another tab. Returns true if anything changed.
  VF.adopt = function (json) {
    try {
      const raw = JSON.parse(json);
      if (raw && raw.state && raw.state.version === 2 && (raw.state.rev || 0) > (VF.state.rev || 0)) { VF.state = VF.sanitizeState(raw.state); histCache = null; return true; }
    } catch (e) { /* ignore a half-written value */ }
    return false;
  };
  VF.reset = function () { histCache = null; seed(); };

  // ------------------------------------------------------------------ UI building blocks
  const I = {
    home: '<path d="M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    route: '<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H16a3.5 3.5 0 0 0 0-7H8a3.5 3.5 0 0 1 0-7h7.5"/>',
    ticket: '<path d="M4 7a2 2 0 0 0 2-2h12a2 2 0 0 0 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 0-2 2H6a2 2 0 0 0-2-2v-3a2 2 0 0 0 0-4z"/><path d="M10 9h4M10 15h4"/>',
    car: '<path d="M5 16V11l2-5h10l2 5v5"/><path d="M3 16h18v3h-3M3 16v3h3"/><circle cx="7.5" cy="13" r=".5"/><circle cx="16.5" cy="13" r=".5"/>',
    shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    grid: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
    chart: '<path d="M3 21h18M6 17v-6M11 17V5M16 17v-4M20 17V8"/>',
    bell: '<path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 21h4"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.5a5 5 0 0 1 6 5"/>',
    network: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5v4M12 11.5 6.5 17M12 11.5l5.5 5.5"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    warn: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17v.5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h11"/>',
    pin: '<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    thermo: '<path d="M10 4a2 2 0 0 1 4 0v10a4 4 0 1 1-4 0z"/>',
    play: '<path d="M7 5v14l11-7z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    code: '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>',
  };
  VF.icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n] || ''}</svg>`;
  VF.pill = (cls, label) => `<span class="pill ${cls}">${esc(label)}</span>`;
  const CONN_CLS = { Available: 'ok', Charging: 'charge', Reserved: 'accent', Finishing: 'charge', Preparing: 'charge', Faulted: 'bad', Unavailable: 'warn', SuspendedEV: 'warn' };
  VF.connPill = (c) => VF.pill(CONN_CLS[c.status] || '', c.status);
  const BOOK_CLS = { confirmed: 'accent', charging: 'charge', completed: 'ok', cancelled: '', 'no-show': 'bad', stopped: 'warn' };
  const BOOK_LABEL = { confirmed: 'Confirmed', charging: 'Charging', completed: 'Completed', cancelled: 'Cancelled', 'no-show': 'No-show', stopped: 'Stopped' };
  VF.bookingPill = (b) => VF.pill(BOOK_CLS[b.status] || '', BOOK_LABEL[b.status] || b.status);
  VF.socBar = (soc, marker) => {
    const cls = soc < 15 ? 'lo' : soc < 35 ? 'mid' : '';
    return `<div class="soc"><div class="soc-bar"><i class="${cls}" style="width:${clamp(soc, 0, 100).toFixed(1)}%"></i>${marker != null ? `<b style="left:${clamp(marker, 0, 100).toFixed(1)}%"></b>` : ''}</div><span class="num">${Math.round(soc)}%</span></div>`;
  };
  VF.kpi = (label, value, small, hint, cls) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}${small ? `<small>${small}</small>` : ''}</div><div class="hint ${cls || ''}">${hint || ''}</div></div>`;
  VF.toast = (msg) => {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4000);
  };
  VF.copyText = async (text, label) => {
    try { await navigator.clipboard.writeText(text); VF.toast(`${label} copied`); return; } catch (e) { /* fall back */ }
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove(); VF.toast(ok ? `${label} copied` : 'Copy is blocked here. Select the text and copy it manually.');
  };
  VF.downloadText = (name, text, type) => {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: type || 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      VF.toast(`Downloading ${name}. If nothing happens, use Copy.`);
    } catch (e) { VF.toast('Download is blocked here. Use Copy.'); }
  };
  // Cells that a spreadsheet would run as a formula (=, +, -, @) get a leading apostrophe; plain numbers are left alone.
  const csvCell = (x) => { let s = x == null ? '' : String(x); if (typeof x === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  VF.csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');

  // ------------------------------------------------------------------ map
  let staticCache = null;
  function mapBase() {
    if (staticCache) return staticCache;
    const P = (lat, lon) => proj(lat, lon).map((n) => n.toFixed(1)).join(',');
    const coast = COAST.map(([la, lo]) => P(la, lo)).join(' ');
    let s = `<rect class="land" x="-200" y="-200" width="${MAP.W + 400}" height="${MAP.H + 400}"/>`;
    s += `<polygon class="sea" points="${coast} ${MAP.W + 200},${MAP.H + 200} -200,${MAP.H + 200}"/><polyline class="coast" points="${coast}"/>`;
    s += `<text class="sea-label" x="640" y="${MAP.H - 26}" text-anchor="middle">GULF OF GUINEA</text>`;
    for (const major of [0, 1]) for (const [a, b, mj] of ROADS) if (mj === major) {
      const [x1, y1] = proj(PLACES[a].lat, PLACES[a].lon), [x2, y2] = proj(PLACES[b].lat, PLACES[b].lon);
      s += `<line class="road${mj ? ' major' : ''}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }
    staticCache = s;
    return s;
  }
  VF.fitBox = (latlons, pad, aspect) => {
    if (!latlons.length) return [0, 0, MAP.W, MAP.H];
    const xs = [], ys = [];
    for (const [la, lo] of latlons) { const [x, y] = proj(la, lo); xs.push(x); ys.push(y); }
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    let w = Math.max(Math.max(...xs) - Math.min(...xs) + pad * 2, 260), h = Math.max(Math.max(...ys) - Math.min(...ys) + pad * 2, 200);
    if (w / h > aspect) h = w / aspect; else w = h * aspect;
    return [cx - w / 2, cy - h / 2, w, h].map((n) => +n.toFixed(1));
  };
  // o: { id, vb, stations: [{st, cls, title}], route: [[lat,lon]], routeFrom: km done, vehicle: {lat, lon, cls}, demand: [{node, n}], placeLabels, stationAct }
  VF.mapSVG = function (o) {
    const vb = o.vb || [0, 0, MAP.W, MAP.H];
    const k = vb[2] / 1000; const fs = Math.max(11, Math.min(14, 13 * Math.sqrt(k))) ;
    let s = `<svg class="map" ${o.id ? `id="${o.id}"` : ''} viewBox="${vb.join(' ')}" role="img" aria-label="${esc(o.label || 'Map of Greater Accra')}" style="--fs:${fs.toFixed(1)}px">` + mapBase();
    if (o.route && o.route.length > 1) {
      const pts = o.route.map(([la, lo]) => proj(la, lo).map((n) => n.toFixed(1)).join(',')).join(' ');
      s += `<polyline class="route-line" points="${pts}"/>`;
      if (o.routeDone && o.routeDone.length > 1) s += `<polyline class="route-done" points="${o.routeDone.map(([la, lo]) => proj(la, lo).map((n) => n.toFixed(1)).join(',')).join(' ')}"/>`;
    }
    const stationNodes = new Set((o.stations || []).map((x) => x.st.node));
    if (o.placeLabels !== false) for (const [id, p] of Object.entries(PLACES)) {
      if (stationNodes.has(id) && o.hidePlaceAtStation !== false) continue;
      const [x, y] = proj(p.lat, p.lon); const [dx, dy, anchor] = p.lab || [8, -7, 'start'];
      s += `<circle class="place-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"/><text class="place-label" x="${(x + dx).toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="${anchor}">${esc(p.name)}</text>`;
    }
    for (const d of o.demand || []) {
      const [x, y] = proj(PLACES[d.node].lat, PLACES[d.node].lon);
      s += `<g class="demand"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(10 + Math.sqrt(d.n) * 7).toFixed(1)}"/><text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle">${d.n}</text></g>`;
    }
    for (const x of o.stations || []) {
      const [cx, cy] = proj(PLACES[x.st.node].lat, PLACES[x.st.node].lon);
      s += `<g class="stn ${x.cls || ''}${o.stationAct ? ' clickable' : ''}" transform="translate(${cx.toFixed(1)},${cy.toFixed(1)})"${o.stationAct ? ` data-act="${o.stationAct}" data-id="${x.st.id}" tabindex="0" role="button"` : ''}><title>${esc(x.title || x.st.name)}</title>` +
        `<rect x="-11" y="-11" width="22" height="22" rx="6"/><path d="M1.5 -7 -5 1.5h4.5l-1.2 6 6.6-8.6h-4.5z"/>` +
        (x.badge != null ? `<g class="badge" transform="translate(11,-11)"><circle r="8"/><text y="3.5" text-anchor="middle">${x.badge}</text></g>` : '') +
        `<text class="stn-label" y="28" text-anchor="middle">${esc(x.label || x.st.name)}</text></g>`;
    }
    for (const vh of o.vehicles || []) {
      const [x, y] = proj(vh.lat, vh.lon);
      s += `<g class="fv ${vh.cls || ''}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})"${vh.act ? ` data-act="${vh.act}" data-id="${esc(vh.id)}" tabindex="0" role="button"` : ''}><title>${esc(vh.title || vh.label || '')}</title><circle class="halo" r="13"/><circle class="dot" r="7"/>${vh.label ? `<text x="11" y="-9">${esc(vh.label)}</text>` : ''}</g>`;
    }
    if (o.vehicle) {
      const [x, y] = proj(o.vehicle.lat, o.vehicle.lon);
      s += `<g class="me ${o.vehicle.cls || ''}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><circle class="pulse" r="16"/><circle class="dot" r="8"/></g>`;
    }
    return s + '</svg>';
  };

  // ------------------------------------------------------------------ charts
  VF.sparkline = (vals, w, h, cap) => {
    if (vals.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"></svg>`;
    const max = Math.max(cap || 0, ...vals, 1) * 1.05;
    const x = (i) => i / (vals.length - 1) * w, y = (v) => h - 2 - v / max * (h - 4);
    const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('L');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-hidden="true">` +
      (cap ? `<line class="cap" x1="0" x2="${w}" y1="${y(cap).toFixed(1)}" y2="${y(cap).toFixed(1)}"/>` : '') +
      `<path class="area" d="M0,${h}L${pts}L${w},${h}Z"/><path class="line" d="M${pts}"/></svg>`;
  };
  // series: [{key, label, cls}], data: [{label, date, values:{key:n}}]
  VF.barChart = (data, series, w, opts) => {
    opts = opts || {};
    const h = opts.h || 230, L = 52, R = 12, T = 14, B = 28, iw = w - L - R, ih = h - T - B;
    const n = data.length; if (!n) return '';
    const max = Math.max(1, ...data.map((d) => sum(series, (s) => d.values[s.key] || 0)));
    const step = niceStep(max, 4), top = Math.ceil(max / step) * step;
    const y = (v) => T + ih - v / top * ih; const bw = iw / n;
    let s = '';
    for (let v = 0; v <= top + 1e-9; v += step) s += `<line class="grid-line" x1="${L}" x2="${w - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${opts.yFmt ? opts.yFmt(v) : fmt.n(v)}</text>`;
    const every = n > 14 ? (w < 520 ? 10 : 5) : (w < 520 ? 2 : 1);
    data.forEach((d, i) => {
      const bx = L + i * bw + bw * 0.15, ww = Math.max(1, bw * 0.7); let base = 0;
      for (const se of series) {
        const v = d.values[se.key] || 0; if (v <= 0) continue;
        s += `<rect class="${se.cls}" x="${bx.toFixed(1)}" y="${y(base + v).toFixed(1)}" width="${ww.toFixed(1)}" height="${(y(base) - y(base + v)).toFixed(1)}"><title>${esc(d.label)} · ${esc(se.label)}: ${opts.vFmt ? opts.vFmt(v) : fmt.n(v)}</title></rect>`;
        base += v;
      }
      if ((n - 1 - i) % every === 0) s += `<text x="${(bx + ww / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle">${esc(d.label)}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(opts.label || 'Chart')}">${s}</svg>`;
  };
  // rows: [{label, sub}], items: [{row, start, end, cls, label, title}]
  VF.timeline = (rows, items, t0, t1, w, nowT) => {
    const rh = 30, L = 110, R = 12, T = 20, B = 24, h = T + rows.length * rh + B, iw = w - L - R;
    const x = (t) => L + clamp((t - t0) / (t1 - t0), 0, 1) * iw;
    let s = '';
    rows.forEach((r, i) => {
      const yy = T + i * rh;
      s += `<rect class="row-bg" x="${L}" y="${yy + 3}" width="${iw}" height="${rh - 6}" rx="4"/><text class="row-label" x="${L - 8}" y="${yy + rh / 2 + 4}" text-anchor="end">${esc(r.label)}</text>`;
    });
    const span = (t1 - t0) / HOUR; const stepH = w < 520 ? (span > 6 ? 3 : 2) : span > 10 ? 2 : 1;
    let t = Math.ceil(t0 / HOUR) * HOUR - tzMs() % HOUR;
    for (; t <= t1; t += HOUR) if (VF.hourOf(t) % stepH === 0) s += `<line class="grid-line" x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${T}" y2="${T + rows.length * rh}"/><text x="${x(t).toFixed(1)}" y="${h - 7}" text-anchor="middle">${VF.fmtTime(t)}</text>`;
    for (const it of items) {
      if (it.end < t0 || it.start > t1) continue;
      const yy = T + it.row * rh; const x1 = x(it.start), x2 = x(it.end);
      s += `<g><rect class="tl ${it.cls || ''}" x="${x1.toFixed(1)}" y="${yy + 6}" width="${Math.max(3, x2 - x1).toFixed(1)}" height="${rh - 12}" rx="3"/><title>${esc(it.title || it.label || '')}</title>` +
        (x2 - x1 > 54 && it.label ? `<text class="tl-label ${it.cls || ''}" x="${(x1 + 5).toFixed(1)}" y="${yy + rh / 2 + 4}">${esc(it.label)}</text>` : '') + '</g>';
    }
    if (nowT >= t0 && nowT <= t1) s += `<line class="now-line" x1="${x(nowT).toFixed(1)}" x2="${x(nowT).toFixed(1)}" y1="${T - 4}" y2="${T + rows.length * rh + 2}"/><text class="now-label" x="${x(nowT).toFixed(1)}" y="${T - 8}" text-anchor="middle">now</text>`;
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Connector timeline">${s}</svg>`;
  };

  return VF;

  // Clickjacking guard: refuse to run inside another site's frame (GitHub Pages can't send frame-ancestors headers).
  if (window.top !== window.self) {
    let sameOrigin = false; try { sameOrigin = !!window.top.location.host; } catch (e) { sameOrigin = false; }
    if (!sameOrigin) document.addEventListener('DOMContentLoaded', () => {
      const d = document.createElement('div'); d.className = 'frame-guard';
      d.innerHTML = '<p>For your security VoltFleet doesn’t run inside other websites.</p><a target="_blank" rel="noopener">Open VoltFleet</a>';
      d.querySelector('a').href = location.href; document.body.appendChild(d);
    });
  }
})();
