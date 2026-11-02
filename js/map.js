/* VoltFleet OS — street maps.
   Replaces the schematic map with Leaflet street maps when a tile provider is configured in js/config.js
   (window.VOLTFLEET_MAPS). Every page keeps calling VF.mapSVG(spec): with maps on it returns a placeholder,
   VF.maps.mountAll() turns placeholders into maps after each render, and a map keeps its zoom and pan across
   re-renders. Live positions move markers through VF.maps.moveVehicle / moveMe. Journey lines can follow real
   roads through an OSRM server. If tiles can't load (offline, blocked), it falls back to the schematic map. */
'use strict';
(function () {
  const { esc } = VF;
  const cfg = Object.assign({ provider: 'carto', key: '', routing: 'none', osrmUrl: 'https://router.project-osrm.org' }, window.VOLTFLEET_MAPS || {});
  const schematic = VF.mapSVG;
  VF.mapSchematic = schematic;

  const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  const PROVIDERS = {
    carto: (dark) => ({ name: 'CARTO', url: `https://{s}.basemaps.cartocdn.com/${dark ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`, attribution: `${OSM} &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>`, subdomains: 'abcd', maxZoom: 20 }),
    osm: () => ({ name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: OSM, maxZoom: 19 }),
    maptiler: (dark) => ({ name: 'MapTiler', needsKey: true, url: `https://api.maptiler.com/maps/${dark ? 'streets-v2-dark' : 'streets-v2'}/256/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(cfg.key)}`, attribution: `<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener">&copy; MapTiler</a> ${OSM}`, maxZoom: 20 }),
    mapbox: (dark) => ({ name: 'Mapbox', needsKey: true, url: `https://api.mapbox.com/styles/v1/mapbox/${dark ? 'dark-v11' : 'light-v11'}/tiles/256/{z}/{x}/{y}{r}?access_token=${encodeURIComponent(cfg.key)}`, attribution: `&copy; <a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener">Mapbox</a> ${OSM}`, maxZoom: 20 }),
    custom: () => ({ name: 'Custom tiles', url: cfg.url, attribution: cfg.attribution || '', maxZoom: cfg.maxZoom || 19 }),
  };
  const provider = (dark) => (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider](dark) : null);

  const M = VF.maps = { cfg, instances: {}, specs: {}, failed: false };
  M.configured = () => { const p = provider(false); return !!(p && cfg.provider !== 'none' && (!p.needsKey || cfg.key) && (cfg.provider !== 'custom' || cfg.url)); };
  M.enabled = () => !!(window.L && M.configured() && !M.failed);
  M.providerName = () => (M.configured() ? provider(false).name : 'Schematic');
  M.routing = () => cfg.routing === 'osrm' && !!cfg.osrmUrl;

  // Same signature as the schematic map, so no page needs to know which one it gets.
  let auto = 0;
  VF.mapSVG = function (o) {
    if (!M.enabled()) return schematic(o);
    const id = o.id || 'lmap-' + (++auto);
    M.specs[id] = o;
    return `<div class="lmap" id="${esc(id)}" data-lmap role="region" aria-label="${esc(o.label || 'Map')}"></div>`;
  };

  // ---------------------------------------------------------------- geometry helpers
  const unproj = (x, y) => [VF.MAP.lat1 - y / VF.MAP.k, x / VF.MAP.k + VF.MAP.lon0];
  function boundsOf(o) { const vb = o.vb || [0, 0, VF.MAP.W, VF.MAP.H]; return L.latLngBounds([unproj(vb[0], vb[1] + vb[3]), unproj(vb[0] + vb[2], vb[1])]); }
  const km = (a, b) => VF.hav({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
  // The part of a polyline covered after fraction f of its length, and the point reached.
  function along(pts, f) {
    if (!pts || pts.length < 2) return { done: pts || [], at: pts && pts[0] };
    let total = 0; const seg = [];
    for (let i = 1; i < pts.length; i++) { const d = km(pts[i - 1], pts[i]); seg.push(d); total += d; }
    let left = Math.max(0, Math.min(1, f)) * total; const done = [pts[0]];
    for (let i = 0; i < seg.length; i++) {
      if (left >= seg[i]) { done.push(pts[i + 1]); left -= seg[i]; continue; }
      const t = seg[i] ? left / seg[i] : 0; const a = pts[i], b = pts[i + 1];
      const at = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; done.push(at); return { done, at };
    }
    return { done, at: pts[pts.length - 1] };
  }

  // ---------------------------------------------------------------- road routing (OSRM), cached
  const ROUTE_KEY = 'voltfleet-os:roads';
  const roads = new Map();
  try { for (const [k, v] of JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]')) roads.set(k, v); } catch (e) { /* no cache */ }
  const queue = []; let busy = false;
  const routeKey = (pts) => pts.map((p) => p[0].toFixed(4) + ',' + p[1].toFixed(4)).join(';');
  function roadFor(pts) {
    if (!M.routing() || !pts || pts.length < 2) return null;
    const key = routeKey(pts);
    if (roads.has(key)) return roads.get(key) || null;
    if (!queue.some((q) => q.key === key)) { queue.push({ key, pts }); pump(); }
    return null;
  }
  function pump() {
    if (busy || !queue.length) return;
    busy = true; const { key, pts } = queue.shift();
    const coords = pts.map((p) => `${p[1].toFixed(5)},${p[0].toFixed(5)}`).join(';');
    fetch(`${cfg.osrmUrl.replace(/\/$/, '')}/route/v1/driving/${coords}?overview=full&geometries=geojson`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((j) => {
        const g = j.routes && j.routes[0] && j.routes[0].geometry && j.routes[0].geometry.coordinates;
        roads.set(key, g && g.length > 1 ? g.map(([lo, la]) => [+la.toFixed(5), +lo.toFixed(5)]) : false);
        try { localStorage.setItem(ROUTE_KEY, JSON.stringify([...roads].filter(([, v]) => v).slice(-40))); } catch (e) { /* cache is optional */ }
        for (const inst of Object.values(M.instances)) if (inst.spec && inst.spec.route && routeKey(inst.spec.route) === key && inst.el.isConnected) draw(inst);
      })
      .catch(() => { roads.set(key, false); }) // straight lines stay; don't retry this session
      .finally(() => { setTimeout(() => { busy = false; pump(); }, 1100); }); // public servers allow about 1 request a second
  }

  // ---------------------------------------------------------------- markers
  const BOLT = '<svg viewBox="-11 -11 22 22" aria-hidden="true"><path d="M1.5 -7 -5 1.5h4.5l-1.2 6 6.6-8.6h-4.5z"/></svg>';
  const stationIcon = (x) => L.divIcon({ className: 'lm-icon', iconSize: [24, 24], iconAnchor: [12, 12], html: `<div class="lm-stn ${esc(x.cls || '')}"><span class="lm-sq">${BOLT}</span>${x.badge != null ? `<b class="lm-badge">${esc(x.badge)}</b>` : ''}<span class="lm-lab">${esc(x.label || x.st.name)}</span></div>` });
  const vehicleIcon = (vh) => L.divIcon({ className: 'lm-icon', iconSize: [18, 18], iconAnchor: [9, 9], html: `<div class="lm-fv ${esc(vh.cls || '')}"><i></i>${vh.label ? `<span>${esc(vh.label)}</span>` : ''}</div>` });
  const meIcon = (cls) => L.divIcon({ className: 'lm-icon', iconSize: [22, 22], iconAnchor: [11, 11], html: `<div class="lm-me ${esc(cls || '')}"><i class="pulse"></i><i class="dot"></i></div>` });
  const act = (name, id) => { const fn = VF.ACT[name]; if (fn) fn({ dataset: { id }, tagName: 'DIV' }); };

  // ---------------------------------------------------------------- map instances
  function setTiles(inst) {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (inst.tiles && inst.dark === dark) return;
    const p = provider(dark);
    if (inst.tiles) inst.map.removeLayer(inst.tiles);
    inst.tiles = L.tileLayer(p.url, { attribution: p.attribution, subdomains: p.subdomains || 'abc', maxZoom: p.maxZoom });
    inst.tiles.on('tileload', () => { inst.loaded++; });
    inst.tiles.on('tileerror', () => { inst.errors++; if (inst.errors >= 6 && !inst.loaded) fail(); });
    inst.tiles.addTo(inst.map); inst.dark = dark;
  }
  function create(el) {
    const map = L.map(el, { scrollWheelZoom: false, dragging: !L.Browser.mobile, tap: false, zoomSnap: 0.25, minZoom: 9, maxZoom: 18, maxBounds: L.latLngBounds([4.9, -1.2], [6.3, 0.8]), zoomControl: true });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    // Scroll-zoom only after the map is clicked, so scrolling the page never gets trapped.
    map.on('click focus', () => map.scrollWheelZoom.enable());
    el.addEventListener('mouseleave', () => map.scrollWheelZoom.disable());
    const inst = { el, map, layer: L.layerGroup().addTo(map), vehicles: {}, me: null, fitKey: null, tiles: null, loaded: 0, errors: 0 };
    setTiles(inst);
    if (window.ResizeObserver) { inst.ro = new ResizeObserver(() => map.invalidateSize(false)); inst.ro.observe(el); }
    return inst;
  }
  function destroy(id) { const inst = M.instances[id]; if (!inst) return; try { if (inst.ro) inst.ro.disconnect(); inst.map.remove(); } catch (e) { /* already gone */ } delete M.instances[id]; }
  function draw(inst) {
    const o = inst.spec, map = inst.map;
    inst.layer.clearLayers(); inst.vehicles = {}; inst.me = null; inst.road = null; inst.done = null;
    const fitKey = (o.vb || []).join(',');
    if (fitKey !== inst.fitKey) { inst.fitKey = fitKey; map.fitBounds(boundsOf(o), { padding: [6, 6], maxZoom: 15, animate: false }); }
    if (o.route && o.route.length > 1) {
      inst.road = roadFor(o.route);
      L.polyline(inst.road || o.route, { className: 'lm-route', interactive: false }).addTo(inst.layer);
      inst.done = L.polyline([], { className: 'lm-route-done', interactive: false }).addTo(inst.layer);
      setDone(inst, o.progress, o.routeDone);
    }
    for (const d of o.demand || []) {
      const p = VF.PLACES[d.node]; const r = Math.round(10 + Math.sqrt(d.n) * 7);
      L.marker([p.lat, p.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: 'lm-icon', iconSize: [r * 2, r * 2], iconAnchor: [r, r], html: `<div class="lm-demand">${d.n}</div>` }) }).addTo(inst.layer);
    }
    for (const x of o.stations || []) {
      const p = VF.PLACES[x.st.node];
      const mk = L.marker([p.lat, p.lon], { icon: stationIcon(x), title: x.title || x.st.name, alt: x.title || x.st.name, keyboard: !!o.stationAct, interactive: !!o.stationAct, riseOnHover: true });
      if (o.stationAct) mk.on('click', () => act(o.stationAct, x.st.id));
      mk.addTo(inst.layer);
    }
    for (const vh of o.vehicles || []) {
      const onRoute = vh.progress != null && !!inst.road;
      const ll = onRoute ? along(inst.road, vh.progress).at : [vh.lat, vh.lon];
      const mk = L.marker(ll, { icon: vehicleIcon(vh), title: vh.title || vh.label || '', alt: vh.title || vh.label || 'Vehicle', keyboard: !!vh.act, interactive: !!vh.act, zIndexOffset: 500 });
      if (vh.act) mk.on('click', () => act(vh.act, vh.id));
      mk.addTo(inst.layer); inst.vehicles[vh.id] = { mk, cls: vh.cls, onRoute: vh.progress != null };
    }
    if (o.vehicle) {
      const ll = o.progress != null && inst.road ? along(inst.road, o.progress).at : [o.vehicle.lat, o.vehicle.lon];
      inst.me = { mk: L.marker(ll, { icon: meIcon(o.vehicle.cls), keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(inst.layer), cls: o.vehicle.cls };
    }
  }
  function setDone(inst, progress, routeDone) {
    if (!inst.done) return;
    if (progress != null && inst.road) inst.done.setLatLngs(along(inst.road, progress).done);
    else if (routeDone) inst.done.setLatLngs(routeDone);
  }
  function fail() {
    if (M.failed) return;
    M.failed = true;
    for (const id of Object.keys(M.instances)) destroy(id);
    VF.toast('Street map tiles could not load, so the schematic map is shown.');
    if (VF.rerender) VF.rerender();
  }

  // Turn placeholders from the last render into maps, reusing an existing map (and its zoom) when it has one.
  M.mountAll = function () {
    if (!M.enabled()) return;
    for (const el of document.querySelectorAll('.lmap[data-lmap]')) {
      el.removeAttribute('data-lmap');
      const id = el.id; const spec = M.specs[id]; if (!spec) continue;
      let inst = M.instances[id];
      if (inst && !inst.el.isConnected) { el.replaceWith(inst.el); inst.map.invalidateSize(false); setTiles(inst); }
      else { destroy(id); inst = M.instances[id] = create(el); }
      inst.spec = spec; draw(inst);
    }
    for (const id of Object.keys(M.instances)) if (id.startsWith('lmap-') && !M.instances[id].el.isConnected) destroy(id);
  };
  const live = (id) => { const inst = M.instances[id]; return inst && inst.el.isConnected ? inst : null; };
  M.has = (id) => !!live(id);
  M.moveVehicle = (id, vid, lat, lon, cls, progress) => {
    const inst = live(id); const v = inst && inst.vehicles[vid]; if (!v) return;
    v.mk.setLatLng(v.onRoute && progress != null && inst.road ? along(inst.road, progress).at : [lat, lon]);
    if (cls !== v.cls) { v.cls = cls; const e = v.mk.getElement(); if (e && e.firstChild) e.firstChild.className = 'lm-fv ' + cls; }
  };
  // Redraw a map with a new spec (markers only; zoom and pan stay) when what it shows has changed.
  M.update = (id, spec) => {
    const inst = live(id); if (!inst) return;
    const sig = (o) => JSON.stringify([(o.stations || []).map((x) => [x.st.id, x.cls, x.badge]), (o.demand || []).map((d) => [d.node, d.n]), (o.vehicles || []).map((v) => [v.id, v.cls]), o.route && o.route.length]);
    spec.vb = inst.spec.vb; M.specs[id] = spec;
    if (sig(spec) !== sig(inst.spec)) { inst.spec = spec; draw(inst); } else inst.spec = spec;
  };
  M.moveMe = (id, lat, lon, cls, progress, routeDone) => {
    const inst = live(id); if (!inst || !inst.me) return;
    inst.me.mk.setLatLng(progress != null && inst.road ? along(inst.road, progress).at : [lat, lon]);
    if (cls !== inst.me.cls) { inst.me.cls = cls; const e = inst.me.mk.getElement(); if (e && e.firstChild) e.firstChild.className = 'lm-me ' + cls; }
    setDone(inst, progress, routeDone);
  };
  // Dark tiles follow the theme.
  new MutationObserver(() => { for (const inst of Object.values(M.instances)) if (inst.el.isConnected) setTiles(inst); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();
