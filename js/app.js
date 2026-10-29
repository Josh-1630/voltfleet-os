/* VoltFleet OS — app shell: sign-in, role-based routing (each role reaches only its own app),
   live update loop and event delegation. */
'use strict';
(function () {
  const { $, $$, esc, icon, clamp } = VF;
  let current = null; // { role, page }
  let lastKey = '';
  let tickN = 0;

  const role = () => { const u = VF.session && VF.user(VF.session.userId); return u && !u.deleted ? u.role : null; };
  const appFor = (r) => VF.apps[r];
  VF.route = () => (location.hash || '').slice(1);

  // ---------------------------------------------------------------- sign-in
  function renderSignin() {
    current = null;
    document.title = 'Sign in · VoltFleet OS';
    const s = VF.state;
    const card = (u, line, meta) => `<button type="button" class="acct" data-act="signin" data-id="${u.id}" ${u.deleted ? 'disabled' : ''}>
        <span class="avatar">${esc(u.deleted ? '—' : u.name.split(' ').map((p) => p[0]).join(''))}</span><span class="grow"><strong>${esc(u.deleted ? 'Deleted account' : u.name)}</strong><span class="small muted">${esc(line)}</span>${meta ? `<span class="small faint">${esc(meta)}</span>` : ''}</span>${icon('route')}</button>`;
    const drivers = s.users.filter((u) => u.role === 'driver' && u.demo).map((u) => {
      const v = VF.driverVehicle(u.driverId); const m = VF.model(v);
      return card(u, `${v.model} · ${m.oem}${m.spec !== 'International' ? ' · ' + m.spec : ''}`, v.trip && !v.trip.done ? `${Math.round(v.soc)}% · driving to ${VF.PLACES[v.trip.dest].name}` : `${Math.round(v.soc)}% · parked`);
    }).join('');
    const ops = s.users.filter((u) => u.role === 'operator').map((u) => card(u, VF.operator(u.operatorId).name, `${s.stations.filter((x) => x.operatorId === u.operatorId).length} stations`)).join('');
    const admin = s.users.filter((u) => u.role === 'admin').map((u) => card(u, 'VoltFleet platform', 'Every operator, station and driver')).join('');
    const devs = s.users.filter((u) => u.role === 'developer').map((u) => card(u, s.connect.orgs.find((o) => o.id === u.orgId).name, 'Builds on the VoltFleet Connect API')).join('');
    $('#root').innerHTML = `<div class="signin">
      <div class="signin-head"><span class="brand">${brandMark()}<span class="brand-name">VoltFleet<span>OS</span></span></span><span class="demo-badge">Demo</span></div>
      <div class="signin-hero"><h1>One platform between EV drivers, their cars and the chargers they need.</h1><p class="muted">Pick an account to see that role's app. Each role sees different data: drivers see their own car, operators see their own stations, developers see only the vehicles drivers chose to share through VoltFleet Connect, and the platform admin sees everything with personal data masked.</p></div>
      <div class="signin-grid">
        <section class="role-col"><div class="role-head">${icon('car')}<div><h2>Driver app</h2><p class="small muted">Battery, range, time left, chargers on the route and one-tap booking.</p></div></div>${drivers}</section>
        <section class="role-col"><div class="role-head">${icon('plug')}<div><h2>Charge point operator</h2><p class="small muted">Live stations, bookings, smart charging and OCPP control.</p></div></div>${ops}</section>
        <section class="role-col"><div class="role-head">${icon('shield')}<div><h2>Super admin</h2><p class="small muted">The whole network, vehicle integrations, users and privacy.</p></div></div>${admin}</section>
        <section class="role-col"><div class="role-head">${icon('code')}<div><h2>Developer</h2><p class="small muted">VoltFleet Connect: one API for any EV make, with driver consent built in.</p></div></div>${devs}</section>
      </div>
      <p class="faint small signin-foot">${icon('lock')} Demo sign-in has no passwords. Production uses phone or email verification for drivers and SSO with multi-factor sign-in for operators and admins. All demo data is simulated and stays in this browser.</p>
    </div>`;
  }
  const brandMark = () => '<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="8" fill="currentColor"/><path d="M18.5 5 9 18h6.2l-1.7 9L23 14h-6.3z" fill="var(--bg)"/></svg>';
  const clockText = () => `${VF.fmtDayTime(VF.now())} ${VF.tzLabel()}`;
  const speedText = () => (VF.state.clock.paused ? 'Paused' : `Demo feed · ${VF.state.clock.speed}×`);

  // ---------------------------------------------------------------- shells
  const ROLE_NAME = { driver: 'Driver', operator: 'Operator manager', admin: 'Super admin', developer: 'Developer' };
  function renderShell() {
    const r = current.role; const app = appFor(r); const u = VF.user(VF.session.userId);
    const initials = esc(u.name.split(' ').map((p) => p[0]).join(''));
    $('#root').innerHTML = `<div class="console role-${r}">
      <aside class="nav" aria-label="Main">
        <span class="brand">${brandMark()}<span class="brand-name">VoltFleet<span>OS</span></span></span>
        <div class="workspace"><span class="ws-label">${r === 'driver' ? 'Driver app' : 'Workspace'}</span><strong>${esc(r === 'driver' ? VF.driverVehicle(u.driverId).model : app.roleLabel())}</strong></div>
        <nav class="nav-links" id="nav-links"></nav>
        <div class="nav-foot"><div class="user-chip"><span class="avatar sm">${initials}</span><span><strong>${esc(u.name)}</strong><span class="faint small">${ROLE_NAME[r]}</span></span></div>
          <button class="btn small ghost" data-act="signout">${icon('logout')}Switch account</button></div>
      </aside>
      <div class="main">
        <header class="topbar"><div class="topbar-title"><div class="eyebrow" id="view-eyebrow"></div><h1 id="view-title"></h1></div>
          <div class="topbar-tools"><span class="clock-pill"><i class="live-dot"></i><span class="num" data-live="clock">${clockText()}</span><span class="sep"></span><span data-live="speed">${speedText()}</span></span>
            <span id="tools" class="tools"></span><button class="icon-btn mobile-only" data-act="signout" aria-label="Switch account" title="Switch account">${icon('logout')}</button></div></header>
        <main id="view" class="view" tabindex="-1"></main>
      </div>
      ${r === 'driver' ? '<div class="sheet-wrap" id="d-sheetwrap" hidden><div class="sheet-backdrop" data-act="d-sheet-close"></div><div class="sheet" id="d-sheet" role="dialog" aria-modal="true"></div></div>' : ''}
    </div>`;
    renderPage(false);
  }
  function renderNav() {
    const r = current.role; const app = appFor(r);
    const html = app.nav.map((n) => { const b = app.badge ? app.badge(n.id) : 0; return `<a class="nav-link" href="#${n.id}" ${current.page === n.id ? 'aria-current="page"' : ''}>${icon(n.icon)}<span>${n.label}</span>${b ? `<span class="count">${b}</span>` : ''}</a>`; }).join('');
    VF.setHTML($('#nav-links'), html);
  }
  function renderPage(keep) {
    const app = appFor(current.role); const page = current.page; const meta = app.nav.find((n) => n.id === page);
    const view = $('#view'); if (!view) return;
    const y = window.scrollY;
    const ae = document.activeElement; const fid = ae && ae.id && view.contains(ae) ? ae.id : null;
    let caret = null; try { caret = fid ? ae.selectionStart : null; } catch (e) { caret = null; }
    view.innerHTML = app.pages[page]();
    view._html = null;
    document.title = `${meta.title} · VoltFleet OS`;
    $('#view-title').textContent = (app.title && app.title(page)) || meta.title;
    $('#view-eyebrow').textContent = (app.eyebrow && app.eyebrow(page)) || meta.eyebrow || '';
    VF.setHTML($('#tools'), app.tools ? app.tools() : '');
    if (current.role === 'driver') VF.renderSheet();
    renderNav();
    lastKey = app.structKey ? app.structKey(page) : page;
    drawCharts();
    window.scrollTo(0, keep ? y : 0);
    if (fid) { const el = document.getElementById(fid); if (el) { el.focus(); if (caret != null) try { el.setSelectionRange(caret, caret); } catch (e) { /* not a text field */ } } }
    if (app.live) { const vals = app.live(page); if (vals) applyLive(vals); }
  }
  VF.rerender = () => { if (current) renderPage(true); };
  VF.renderSheet = () => {
    const wrap = $('#d-sheetwrap'); if (!wrap) return;
    const html = VF.apps.driver.sheet();
    wrap.hidden = !html; VF.setHTML($('#d-sheet'), html);
  };
  function drawCharts() {
    if (!current) return;
    const app = appFor(current.role);
    for (const slot of $$('.chart-slot[data-chart]')) { const fn = app.charts && app.charts[slot.dataset.chart]; if (fn) fn(slot, slot.dataset.chart); }
  }
  function applyLive(vals) {
    for (const el of $$('[data-live]')) {
      const k = el.dataset.live; if (!(k in vals)) continue; const v = vals[k];
      if (v && typeof v === 'object') {
        if (v.html != null) VF.setHTML(el, v.html);
        if (v.w != null) el.style.width = clamp(v.w, 0, 100).toFixed(1) + '%';
        if (v.attr) for (const a in v.attr) el.setAttribute(a, v.attr[a]);
        if (v.cls) el.setAttribute('class', v.cls);
      } else if (el.textContent !== String(v)) el.textContent = v;
    }
  }

  // ---------------------------------------------------------------- routing with role-based access
  function routeChange() {
    const r = role(); const h = VF.route();
    if (!r) { if (h !== 'signin' && h) { location.hash = 'signin'; return; } renderSignin(); return; }
    const app = appFor(r);
    if (h === 'signin' || !h) { location.hash = app.home; return; }
    if (!app.pages[h]) {
      const owner = Object.keys(VF.apps).find((k) => VF.apps[k].pages[h]);
      if (owner) { VF.audit(VF.session.userId, 'access-denied', h); VF.toast('That page belongs to another role, so it is not available to you.'); VF.save(); }
      location.hash = app.home; return;
    }
    const roleChanged = !current || current.role !== r;
    if (current && !roleChanged && current.page !== h && app.leave) app.leave(current.page);
    current = { role: r, page: h };
    if (roleChanged || !$('#view')) renderShell(); else renderPage(false);
  }
  function signIn(userId) {
    const u = VF.user(userId); if (!u || u.deleted) return;
    VF.session = { userId };
    VF.audit(userId, 'sign-in', u.role);
    VF.save();
    current = null;
    const home = appFor(u.role).home;
    if (VF.route() === home) routeChange(); else location.hash = home;
  }
  VF.signOut = (msg) => {
    if (VF.session) VF.audit(VF.session.userId, 'sign-out', '');
    VF.session = null; current = null; VF.ui.driver.sheet = null; VF.ui.connect.flow = null; VF.renderConnect(); VF.save();
    if (VF.route() === 'signin') routeChange(); else location.hash = 'signin';
    if (msg) VF.toast(msg);
  };
  VF.onNotice = (driverId, title) => { if (/^Booked:/.test(title)) return; if (current && current.role === 'driver' && VF.user(VF.session.userId).driverId === driverId) VF.toast(title); };

  Object.assign(VF.ACT, {
    signin: (el) => signIn(el.dataset.id),
    signout: () => VF.signOut(),
  });

  // ---------------------------------------------------------------- live loop
  function tick() {
    if (document.hidden) return;
    if (VF.tick(1000)) (VF.tickHooks || []).forEach((f) => f());
    tickN++;
    if (tickN % 5 === 0) VF.save();
    if (!current) return;
    const app = appFor(current.role);
    applyLive({ clock: clockText(), speed: speedText() });
    renderNav();
    if (app.tools) VF.setHTML($('#tools'), app.tools());
    const ae = document.activeElement;
    const editing = ae && $('#view') && $('#view').contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName);
    const key = app.structKey ? app.structKey(current.page) : current.page;
    if (key !== lastKey && !editing) renderPage(true);
    else if (app.live) { const vals = app.live(current.page); if (vals) applyLive(vals); }
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    if (!VF.load()) { VF.seed(); VF.session = null; }
    VF.ensureConnect();
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el || el.disabled) return;
      const fn = VF.ACT[el.dataset.act];
      if (fn) { if (el.tagName === 'A') e.preventDefault(); fn(el, e); }
    });
    document.addEventListener('change', (e) => { const el = e.target.closest('[data-chg]'); if (el && VF.CHG[el.dataset.chg]) VF.CHG[el.dataset.chg](el, e); });
    document.addEventListener('input', (e) => { const el = e.target.closest('[data-inp]'); if (el && VF.INP[el.dataset.inp]) VF.INP[el.dataset.inp](el, e); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && VF.ui.connect.flow) { VF.ui.connect.flow = null; VF.renderConnect(); }
      if (e.key === 'Escape' && VF.ui.driver.sheet) { VF.ui.driver.sheet = null; VF.renderSheet(); }
      const g = e.target.closest && e.target.closest('g[data-act]');
      if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); VF.ACT[g.dataset.act](g, e); }
    });
    window.addEventListener('hashchange', routeChange);
    window.addEventListener('resize', VF.debounce(drawCharts, 150));
    routeChange();
    setInterval(tick, 1000);
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && window.self === window.top) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
    }
  }
  boot();
})();
