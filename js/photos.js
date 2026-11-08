/* VoltFleet OS — real vehicle photos.
   Each model's photo is the lead image of its Wikipedia article, limited to freely licensed images
   (pilicense=free), loaded at 640 px through the Wikipedia API (CORS: origin=*). The photographer and licence
   come from the file's metadata and are shown on hover and in Settings → Data & privacy → Photo credits.
   Results are cached on this device for 30 days. Offline, or if a photo fails, the illustration is shown. */
'use strict';
(function () {
  const { esc } = VF;
  const C = VF.c;
  const CACHE = 'voltfleet-os:photos-v1', TTL = 30 * 864e5;
  const API = 'https://en.wikipedia.org/w/api.php';
  // Catalogue model -> Wikipedia article
  const ARTICLE = {
    'BYD Atto 3': 'BYD Atto 3', 'BYD Dolphin': 'BYD Dolphin', 'BYD Seal': 'BYD Seal', 'BYD e6 (China spec)': 'BYD e6',
    'Tesla Model Y': 'Tesla Model Y', 'Tesla Model 3': 'Tesla Model 3', 'Rivian R1S': 'Rivian R1S', 'Rivian R1T': 'Rivian R1T',
    'Hyundai Ioniq 5': 'Hyundai Ioniq 5', 'Kia EV6': 'Kia EV6', 'Nissan Leaf': 'Nissan Leaf', 'VW ID.4 (China spec)': 'Volkswagen ID.4',
    'Ford E-Transit': 'Ford E-Transit', 'MG4': 'MG4 EV',
  };
  const P = VF.photos = { map: {}, loading: false, failed: false };
  try { const c = JSON.parse(localStorage.getItem(CACHE) || 'null'); if (c && Date.now() - c.at < TTL) P.map = c.map || {}; for (const k in P.map) { const p = P.map[k]; if (p && p.src) { p.src = https(p.src); p.licenseUrl = https(p.licenseUrl); p.source = https(p.source); } } } catch (e) { /* none */ }
  const save = () => { try { localStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), map: P.map })); } catch (e) { /* not kept */ } };
  const https = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : ''); // only plain https links from the API
  const strip = (h) => { const d = document.createElement('div'); d.innerHTML = String(h || ''); return (d.textContent || '').replace(/\s+/g, ' ').trim(); };
  const articleFor = (model) => ARTICLE[model] || model.replace(/\s*\(.*\)$/, '');

  async function api(params) {
    const q = new URLSearchParams(Object.assign({ format: 'json', formatversion: '2', origin: '*' }, params));
    const r = await fetch(`${API}?${q}`); if (!r.ok) throw new Error('Wikipedia ' + r.status); return r.json();
  }
  // Fetch photos (and their credits) for every model we don't have yet: two requests for all of them.
  P.load = async (models) => {
    const want = [...new Set((models || Object.keys(VF.MODELS)).filter((m) => !P.map[m]))];
    if (!want.length || P.loading) return;
    P.loading = true;
    try {
      const titles = [...new Set(want.map(articleFor))];
      const j = await api({ action: 'query', prop: 'pageimages', piprop: 'thumbnail|name', pithumbsize: '640', pilicense: 'free', redirects: '1', titles: titles.join('|') });
      const back = {}; // final page title -> requested title
      for (const t of titles) back[t] = t;
      for (const n of (j.query.normalized || [])) back[n.to] = back[n.from] || n.from;
      for (const rd of (j.query.redirects || [])) back[rd.to] = back[rd.from] || rd.from;
      const byArticle = {};
      for (const pg of j.query.pages || []) if (pg.thumbnail && pg.pageimage) byArticle[back[pg.title] || pg.title] = { src: https(pg.thumbnail.source), w: pg.thumbnail.width, h: pg.thumbnail.height, file: pg.pageimage, page: pg.title };
      const files = [...new Set(Object.values(byArticle).map((x) => 'File:' + x.file))];
      const credits = {};
      if (files.length) {
        const k = await api({ action: 'query', prop: 'imageinfo', iiprop: 'extmetadata|url', titles: files.join('|') });
        for (const pg of k.query.pages || []) {
          const ii = pg.imageinfo && pg.imageinfo[0]; if (!ii) continue; const m = ii.extmetadata || {};
          credits[pg.title.replace(/^File:/, '').replace(/ /g, '_')] = { artist: strip(m.Artist && m.Artist.value) || 'Unknown author', license: strip(m.LicenseShortName && m.LicenseShortName.value) || 'Free licence', licenseUrl: https(m.LicenseUrl && m.LicenseUrl.value), source: https(ii.descriptionurl) };
        }
      }
      for (const model of want) {
        const a = byArticle[articleFor(model)]; if (!a) { P.map[model] = { none: true }; continue; }
        const c = credits[a.file.replace(/ /g, '_')] || {};
        P.map[model] = Object.assign({ src: a.src, page: a.page, file: a.file }, c);
      }
      save(); P.failed = false;
      if (VF.rerender) VF.rerender();
    } catch (e) { P.failed = true; } finally { P.loading = false; }
  };
  P.credit = (model) => { const p = P.map[model]; return p && p.src ? `Photo: ${p.artist}, ${p.license}, via Wikimedia Commons` : ''; };

  // Vehicle image: the real photo when we have one, the illustration otherwise (and if the photo fails to load).
  C.vehicleImg = (model, cls) => {
    const p = P.map[model]; const kind = VF.vehicleKind(model);
    if (!p && !P.loading && !P.failed && navigator.onLine !== false) setTimeout(() => P.load(), 0);
    if (!p || !p.src) return `<span class="vphoto art ${cls || ''}">${C.vehicleArt(kind)}</span>`;
    return `<span class="vphoto ${cls || ''}" title="${esc(P.credit(model))}"><img src="${esc(p.src)}" alt="${esc(model)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">${C.vehicleArt(kind, 'fallback')}</span>`;
  };
  // A photo that fails to load falls back to the illustration (no inline handlers, so a strict CSP can apply).
  document.addEventListener('error', (e) => { const t = e.target; if (t && t.tagName === 'IMG' && t.parentNode && t.parentNode.classList && t.parentNode.classList.contains('vphoto')) t.parentNode.classList.add('art', 'failed'); }, true);
  // Credits list (Settings)
  P.creditsHTML = (models) => {
    const rows = [...new Set(models)].map((m) => [m, P.map[m]]).filter(([, p]) => p && p.src);
    if (!rows.length) return '<p class="small muted">Photos load from Wikipedia when you’re online.</p>';
    return `<ul class="credits">${rows.map(([m, p]) => `<li><span class="vphoto mini"><img src="${esc(p.src)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span><div><strong>${esc(m)}</strong><span class="small muted">${esc(p.artist)} · ${p.licenseUrl ? `<a href="${esc(p.licenseUrl)}" target="_blank" rel="noopener">${esc(p.license)}</a>` : esc(p.license)}${p.source ? ` · <a href="${esc(p.source)}" target="_blank" rel="noopener">source</a>` : ''}</span></div></li>`).join('')}</ul><p class="small muted">Photos from Wikimedia Commons under free licences; not endorsed by the photographers or carmakers.</p>`;
  };
})();
