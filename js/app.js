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
  const ROLES = [
    ['manager', 'Fleet', 'truck'], ['driver', 'Driver', 'car-front'], ['operator', 'Operator', 'plug-zap'], ['admin', 'Admin', 'shield-check'], ['developer', 'Developer', 'code'],
  ];
  const loginUi = VF.ui.login = { role: 'manager', error: '' };
  function demoAccounts(role) {
    const s = VF.state;
    return s.users.filter((u) => u.role === role && (u.demo || role !== 'driver')).map((u) => {
      let line = '', meta = '';
      if (role === 'manager') { const f = s.fleet; line = f ? f.org.name : 'EV Manager'; meta = f ? `${f.vehicles.length} vehicles · ${f.drivers.length} drivers` : ''; }
      if (role === 'driver') { const v = VF.driverVehicle(u.driverId); line = v.model; meta = u.deleted ? 'Deleted' : v.trip && !v.trip.done ? `${Math.round(v.soc)}% · driving to ${VF.PLACES[v.trip.dest].name}` : `${Math.round(v.soc)}% · parked`; }
      if (role === 'operator') { line = VF.operator(u.operatorId).name; meta = s.stations.filter((x) => x.operatorId === u.operatorId).map((x) => x.name.split(' ')[0]).join(', '); }
      if (role === 'admin') { line = 'VoltFleet platform'; meta = 'Every operator, station and driver'; }
      if (role === 'developer') { const o = s.connect.orgs.find((x) => x.id === u.orgId); line = o.name; meta = 'VoltFleet Connect API'; }
      return { u, line, meta };
    });
  }
  function renderSignin() {
    current = null;
    document.title = 'Sign in · VoltFleet EV Manager';
    const s = VF.state; const role = loginUi.role;
    const accts = demoAccounts(role);
    const first = accts.find((a) => !a.u.deleted);
    const conns = s.stations.reduce((n, st) => n + st.connectors.length, 0);
    const makes = new Set(Object.values(VF.MODELS).map((m) => m.oem)).size;
    $('#root').innerHTML = `<div class="auth">
      <section class="auth-art" aria-hidden="false">
        <canvas id="auth-canvas" aria-hidden="true"></canvas>
        <div class="auth-art-inner">
          <span class="brand on-dark">${brandMark()}<span class="brand-name">VoltFleet<small>EV Manager</small></span></span>
          <div class="auth-copy">
            <h1>Every EV. Every charger.<br>One platform.</h1>
            <p>Manage an electric fleet, book chargers with no queue and run charging networks, with live data from any make and privacy built in from the start.</p>
          </div>
          <dl class="auth-stats">
            <div><dt>${s.stations.length}</dt><dd>stations live in Accra</dd></div>
            <div><dt>${conns}</dt><dd>connectors, OCPP-ready</dd></div>
            <div><dt>${makes}</dt><dd>vehicle makes supported</dd></div>
          </dl>
        </div>
      </section>
      <section class="auth-panel">
        <div class="auth-card">
          <div class="auth-head"><h2>Sign in</h2><p class="muted">Choose how you use VoltFleet.</p></div>
          <div class="role-tabs" role="tablist" aria-label="Account type">${ROLES.map(([k, l, ic]) => `<button type="button" role="tab" aria-selected="${role === k}" data-act="login-role" data-role="${k}">${icon(ic)}<span>${l}</span></button>`).join('')}</div>
          <form id="login-form" class="auth-form" novalidate>
            <label class="field"><span>Email</span><input class="input lg" id="login-email" type="email" autocomplete="username" value="${esc(first ? first.u.email : '')}" required></label>
            <label class="field"><span class="row between"><span>Password</span><span class="faint small">Any password works in the demo</span></span><input class="input lg" id="login-pass" type="password" autocomplete="current-password" value="demo-password" required></label>
            <div class="form-error" id="login-error" ${loginUi.error ? '' : 'hidden'}>${icon('warn')}<span>${esc(loginUi.error)}</span></div>
            <button class="btn primary big" type="submit">Sign in</button>
          </form>
          <div class="divider"><span>or pick a demo account</span></div>
          <div class="demo-list">${accts.map((a) => `<button type="button" class="demo-acct" data-act="signin" data-id="${a.u.id}" ${a.u.deleted ? 'disabled' : ''}>
            <span class="avatar sm">${esc(a.u.deleted ? '—' : a.u.name.split(' ').map((p) => p[0]).join(''))}</span>
            <span class="grow"><strong>${esc(a.u.deleted ? 'Deleted account' : a.u.name)}</strong><span class="small muted">${esc(a.line)}${a.meta ? ' · ' + esc(a.meta) : ''}</span></span>
            <span class="go">${icon('arrow-right')}</span></button>`).join('')}</div>
          <p class="auth-foot faint small">${icon('lock')}<span>Demo sign-in. In production drivers verify by phone or email, and operators and admins use single sign-on with a second factor. All data here is simulated and stays in this browser.</span></p>
        </div>
      </section>
    </div>`;
    startAuthArt();
  }
  function signInByEmail() {
    const email = ($('#login-email').value || '').trim().toLowerCase();
    const pass = $('#login-pass').value || '';
    const u = VF.state.users.find((x) => (x.email || '').toLowerCase() === email && !x.deleted);
    loginUi.error = !email || !pass ? 'Enter your email and password.' : !u ? 'No account uses that email. Pick a demo account below.' : '';
    if (loginUi.error) { const el = $('#login-error'); el.hidden = false; el.lastElementChild.textContent = loginUi.error; return; }
    signIn(u.id);
  }
  // Animated network behind the sign-in copy: Accra's roads, live stations and cars moving between them.
  let artRaf = null;
  function startAuthArt() {
    cancelAnimationFrame(artRaf);
    const cv = $('#auth-canvas'); if (!cv) return;
    const ctx = cv.getContext('2d');
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const edges = VF.ROADS.map(([a, b, major]) => ({ a: VF.proj(VF.PLACES[a].lat, VF.PLACES[a].lon), b: VF.proj(VF.PLACES[b].lat, VF.PLACES[b].lon), major }));
    const cars = Array.from({ length: 26 }, () => ({ e: Math.floor(Math.random() * edges.length), t: Math.random(), v: 0.0015 + Math.random() * 0.003, dir: Math.random() < 0.5 ? 1 : -1 }));
    function frame() {
      if (!cv.isConnected) return;
      const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      const k = Math.max(w / VF.MAP.W, h / VF.MAP.H) * 1.08, ox = (w - VF.MAP.W * k) / 2, oy = (h - VF.MAP.H * k) / 2 + h * 0.04;
      const P = (p) => [ox + p[0] * k, oy + p[1] * k];
      ctx.lineCap = 'round';
      for (const e of edges) { const [x1, y1] = P(e.a), [x2, y2] = P(e.b); ctx.strokeStyle = e.major ? 'rgba(153,246,228,.24)' : 'rgba(153,246,228,.11)'; ctx.lineWidth = e.major ? 2.2 : 1.3; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
      const time = performance.now() / 1000;
      for (const st of VF.state.stations) {
        const [x, y] = P(VF.proj(VF.PLACES[st.node].lat, VF.PLACES[st.node].lon));
        const free = st.connectors.some((c) => c.status === 'Available');
        const pulse = reduce ? 0.5 : (Math.sin(time * 2 + x) + 1) / 2;
        ctx.fillStyle = free ? `rgba(132,204,22,${0.14 + pulse * 0.12})` : `rgba(245,158,11,${0.12 + pulse * 0.12})`;
        ctx.beginPath(); ctx.arc(x, y, 10 + pulse * 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = free ? '#A3E635' : '#FBBF24'; ctx.beginPath(); ctx.arc(x, y, 3.6, 0, Math.PI * 2); ctx.fill();
      }
      for (const c of cars) {
        if (!reduce) { c.t += c.v * c.dir; if (c.t > 1 || c.t < 0) { c.e = Math.floor(Math.random() * edges.length); c.t = c.dir > 0 ? 0 : 1; } }
        const e = edges[c.e]; const [x1, y1] = P(e.a), [x2, y2] = P(e.b);
        const x = x1 + (x2 - x1) * c.t, y = y1 + (y2 - y1) * c.t;
        const tx = x - (x2 - x1) * 0.06 * c.dir, ty = y - (y2 - y1) * 0.06 * c.dir;
        const g = ctx.createLinearGradient(tx, ty, x, y); g.addColorStop(0, 'rgba(45,212,191,0)'); g.addColorStop(1, 'rgba(94,234,212,.95)');
        ctx.strokeStyle = g; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = '#CCFBF1'; ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
      }
      if (!reduce) artRaf = requestAnimationFrame(frame);
    }
    frame();
  }
  const brandMark = () => '<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="9" fill="currentColor"/><path d="M18.5 5 9 18h6.2l-1.7 9L23 14h-6.3z"/></svg>';
  const clockText = () => `${VF.fmtDayTime(VF.now())} ${VF.tzLabel()}`;
  const speedText = () => (VF.state.clock.paused ? 'Paused' : `Demo feed · ${VF.state.clock.speed}×`);
  const syncText = () => (VF.cloud && VF.cloud.label ? VF.cloud.label() : 'This device only');
  const syncOn = () => !!(VF.cloud && VF.cloud.online && VF.cloud.online());

  // ---------------------------------------------------------------- shell
  // Sidebar (collapsible on desktop, a drawer on tablets and phones), a top bar with breadcrumb, search,
  // notifications and the account menu, and the page itself.
  const ROLE_NAME = { manager: 'Fleet manager', driver: 'Driver', operator: 'Operator manager', admin: 'Super admin', developer: 'Developer' };
  const PRODUCT = { manager: 'EV Manager', driver: 'Driver', operator: 'Charge Network', admin: 'Platform Admin', developer: 'Connect' };
  const SIDEBAR_KEY = 'voltfleet-os:sidebar';
  const shellUi = { search: '', results: [], pop: null, drawer: false };
  const collapsed = () => { try { return localStorage.getItem(SIDEBAR_KEY) === 'collapsed'; } catch (e) { return false; } };
  const initialsOf = (n) => esc(String(n || '?').split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase());
  function renderShell() {
    const r = current.role; const app = appFor(r); const u = VF.user(VF.session.userId);
    shellUi.pop = null; shellUi.drawer = false; shellUi.search = '';
    $('#root').innerHTML = `<div class="console role-${r}${collapsed() ? ' collapsed' : ''}" id="console">
      <aside class="sidebar" id="sidebar" aria-label="Main">
        <div class="sb-head">
          <a class="brand" href="#${app.home}" aria-label="VoltFleet ${esc(PRODUCT[r])} home">${brandMark()}<span class="brand-name">VoltFleet<small>${esc(PRODUCT[r])}</small></span></a>
          <button class="icon-btn sb-toggle" data-act="sb-toggle" aria-label="Collapse sidebar" data-tip="Collapse" data-tip-pos="r">${icon('panel-left-close')}</button>
          <button class="icon-btn sb-close" data-act="sb-close" aria-label="Close menu">${icon('x')}</button>
        </div>
        <div class="workspace" title="${esc(r === 'driver' ? VF.driverVehicle(u.driverId).model : app.roleLabel())}"><span class="ws-ic">${icon(r === 'manager' ? 'building-2' : r === 'driver' ? 'car-front' : r === 'operator' ? 'plug-zap' : r === 'admin' ? 'shield-check' : 'code')}</span><span class="ws-text"><span class="ws-label">${r === 'driver' ? 'My vehicle' : 'Workspace'}</span><strong>${esc(r === 'driver' ? VF.driverVehicle(u.driverId).model : app.roleLabel())}</strong></span></div>
        <nav class="nav-links" id="nav-links"></nav>
        <div class="sb-foot">
          <button class="user-chip" data-act="acct-menu" aria-haspopup="menu" aria-label="Account menu"><span class="avatar sm">${initialsOf(u.name)}</span><span class="uc-text"><strong>${esc(u.name)}</strong><span class="small muted">${ROLE_NAME[r]}</span></span>${icon('chevrons-up-down', 'uc-chev')}</button>
          <button class="icon-btn sb-expand" data-act="sb-toggle" aria-label="Expand sidebar" data-tip="Expand" data-tip-pos="r">${icon('panel-left-open')}</button>
        </div>
      </aside>
      <div class="scrim" data-act="sb-close"></div>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn menu-btn" data-act="sb-open" aria-label="Open menu">${icon('menu')}</button>
          <div class="topbar-title"><nav class="crumbs" id="crumbs" aria-label="Breadcrumb"></nav><h1 id="view-title"></h1></div>
          <div class="topbar-search" id="g-search-box">
            <label class="search-field">${icon('search')}<span class="sr-only">Search</span><input class="input" type="search" id="g-search" data-inp="g-search" placeholder="${r === 'manager' ? 'Search vehicles, stations, drivers' : 'Search pages'}" autocomplete="off" aria-controls="g-results"><kbd class="kbd">/</kbd></label>
            <div class="pop search-pop" id="g-results" role="listbox" hidden></div>
          </div>
          <div class="topbar-tools">
            <span class="sim-chip" title="Demo clock and where this demo's data lives"><span class="num" data-live="clock">${clockText()}</span><span class="sep"></span><span data-live="speed">${speedText()}</span><span class="sep"></span><span class="sync-state${syncOn() ? ' on' : ''}" data-live="sync-state"><i class="live-dot"></i><span data-live="sync">${syncText()}</span></span></span>
            <span id="tools" class="tools"></span>
            <span id="actions" class="page-actions"></span>
            ${noticeSource() ? `<div class="pop-anchor"><button class="icon-btn bell" data-act="bell" aria-label="Notifications" aria-haspopup="dialog" data-tip="Notifications">${icon('bell')}<span class="dot-count" id="bell-count" hidden></span></button><div class="pop notif-pop" id="notif-pop" hidden></div></div>` : ''}
            <div class="pop-anchor"><button class="avatar-btn" data-act="acct-menu" aria-label="Account menu" aria-haspopup="menu"><span class="avatar sm">${initialsOf(u.name)}</span></button><div class="pop acct-pop" id="acct-pop" hidden></div></div>
          </div>
        </header>
        <main id="view" class="view" tabindex="-1"></main>
      </div>
      ${r === 'driver' ? '<nav class="tabbar" id="tabbar" aria-label="Driver app"></nav><div class="sheet-wrap" id="d-sheetwrap" hidden><div class="sheet-backdrop" data-act="d-sheet-close"></div><div class="sheet" id="d-sheet" role="dialog" aria-modal="true"></div></div>' : ''}
    </div>`;
    renderPage(false);
  }
  function navMeta(page) { return appFor(current.role).nav.find((n) => n.id === page); }
  function renderNav() {
    const r = current.role; const app = appFor(r); const active = navMeta(current.page); const on = active && active.parent ? active.parent : current.page;
    let group = null; let html = '';
    for (const n of app.nav) {
      if (n.hidden) continue;
      if (n.group && n.group !== group) { group = n.group; html += `<div class="nav-group">${esc(group)}</div>`; }
      const b = app.badge ? app.badge(n.id) : 0;
      html += `<a class="nav-link" href="#${n.id}" ${on === n.id ? 'aria-current="page"' : ''} data-tip="${esc(n.label)}" data-tip-pos="r">${icon(n.icon)}<span class="nl-text">${esc(n.label)}</span>${b ? `<span class="count">${b}</span>` : ''}</a>`;
    }
    VF.setHTML($('#nav-links'), html);
    const tb = $('#tabbar');
    if (tb) VF.setHTML(tb, app.nav.filter((n) => !n.hidden).map((n) => `<a class="tab" href="#${n.id}" ${on === n.id ? 'aria-current="page"' : ''}>${icon(n.icon)}<span>${esc(n.label)}</span></a>`).join(''));
    const bc = $('#bell-count'); if (bc) { const n = unreadCount(); bc.hidden = !n; bc.textContent = n > 99 ? '99+' : n; }
  }
  function renderCrumbs(meta, title) {
    const r = current.role; const app = appFor(r);
    const home = navMeta(app.home);
    const parts = [`<a href="#${app.home}">${esc(r === 'driver' ? 'Driver' : app.roleLabel())}</a>`];
    if (meta.parent) { const p = navMeta(meta.parent); parts.push(`<a href="#${p.id}">${esc(p.label)}</a>`); }
    else if (current.page !== app.home && meta.group && meta.group !== (home && home.group)) parts.push(`<span>${esc(meta.group)}</span>`);
    if (current.page !== app.home || meta.parent) parts.push(`<span aria-current="page">${esc(title)}</span>`);
    VF.setHTML($('#crumbs'), parts.join(icon('chevron-right', 'crumb-sep')));
  }
  function renderPage(keep) {
    const app = appFor(current.role); const page = current.page; const meta = navMeta(page);
    const view = $('#view'); if (!view) return;
    const y = window.scrollY;
    const ae = document.activeElement; const fid = ae && ae.id && view.contains(ae) ? ae.id : null;
    let caret = null; try { caret = fid ? ae.selectionStart : null; } catch (e) { caret = null; }
    try { view.innerHTML = app.pages[page](); }
    catch (err) { console.error(err); view.innerHTML = VF.c.card({}, VF.c.empty({ icon: 'triangle-alert', title: 'This page could not load', text: 'Something went wrong while preparing it. Try again, or go back to the start page.', action: `<a class="btn primary" href="#${app.home}">Go to ${esc(navMeta(app.home).label)}</a>` })); }
    view._html = null;
    if (VF.maps) VF.maps.mountAll();
    const title = (app.title && app.title(page)) || meta.title;
    document.title = `${meta.title} · VoltFleet ${PRODUCT[current.role]}`;
    $('#view-title').textContent = title;
    renderCrumbs(meta, title);
    VF.setHTML($('#tools'), app.tools ? app.tools() : '');
    VF.setHTML($('#actions'), app.actions ? app.actions(page) : '');
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

  // ---------------------------------------------------------------- notifications (bell)
  // Each role reads its own feed: the EV Manager's notices, an operator's alerts, all alerts for admins,
  // drivers use their own updates sheet. Developers have none.
  function noticeSource() {
    const r = current && current.role; const app = r && appFor(r); const u = VF.session && VF.user(VF.session.userId);
    if (!app || !u) return null;
    if (app.notices) return { list: () => app.notices(), markRead: (id) => app.markRead(id), href: app.allNoticesHref, canMark: true };
    if (r === 'operator') return { list: () => VF.state.alerts.filter((a) => a.scope === u.operatorId && !a.resolved).map((a) => ({ id: a.id, title: a.title, body: a.body, t: a.t, sev: a.sev, read: !!a.acked })), href: '#op-alerts', canMark: false };
    if (r === 'admin') return { list: () => VF.state.alerts.filter((a) => !a.resolved).map((a) => ({ id: a.id, title: a.title, body: a.body, t: a.t, sev: a.sev, read: !!a.acked })), href: '#ad-overview', canMark: false };
    // Drivers keep their own updates sheet (driver.js tools), so the shell adds no second bell.
    return null;
  }
  const unreadCount = () => { const src = noticeSource(); return src ? src.list().filter((n) => !n.read).length : 0; };
  const SEV_ICON = { critical: ['bad', 'triangle-alert'], warning: ['warn', 'triangle-alert'], info: ['teal', 'info'] };
  function renderNotifPop() {
    const src = noticeSource(); const el = $('#notif-pop'); if (!src || !el) return;
    const list = src.list().slice(0, 8); const unread = src.list().filter((n) => !n.read).length;
    VF.setHTML(el, `<div class="pop-head"><strong>Notifications</strong>${src.canMark && unread ? '<button class="link-btn" data-act="bell-readall">Mark all as read</button>' : `<span class="small muted">${unread} unread</span>`}</div>
      ${list.length ? `<ul class="pop-list">${list.map((n) => { const [tone, ic] = SEV_ICON[n.sev] || SEV_ICON.info; return `<li><button class="pop-item${n.read ? '' : ' unread'}" data-act="bell-open" data-id="${esc(n.id)}"><span class="att-ic ${tone}">${icon(ic)}</span><span class="pi-text"><strong>${esc(n.title)}</strong><span class="small muted">${esc(n.body)}</span><span class="small faint">${VF.relTime(n.t)}</span></span></button></li>`; }).join('')}</ul>` : VF.c.empty({ icon: 'bell-off', title: 'You’re all caught up' })}
      ${src.href ? `<a class="pop-foot" href="${src.href}" data-act="pop-close-nav">View all ${icon('arrow-right')}</a>` : ''}`);
  }
  function openPop(name) {
    for (const id of ['notif-pop', 'acct-pop', 'g-results']) { const el = $('#' + id); if (el) el.hidden = true; }
    shellUi.pop = shellUi.pop === name ? null : name;
    if (shellUi.pop === 'notif') { renderNotifPop(); $('#notif-pop').hidden = false; }
    if (shellUi.pop === 'acct') { renderAcctPop(); $('#acct-pop').hidden = false; }
  }
  function closePops() { shellUi.pop = null; for (const id of ['notif-pop', 'acct-pop', 'g-results']) { const el = $('#' + id); if (el) el.hidden = true; } }
  function renderAcctPop() {
    const u = VF.user(VF.session.userId); const r = current.role; const app = appFor(r); const dark = VF.theme.get() === 'dark';
    VF.setHTML($('#acct-pop'), `<div class="pop-user"><span class="avatar">${initialsOf(u.name)}</span><span><strong>${esc(u.name)}</strong><span class="small muted">${esc(u.email || '')}</span><span class="small muted">${ROLE_NAME[r]}</span></span></div>
      <div class="pop-menu" role="menu">
        ${app.settingsHref ? `<a role="menuitem" href="${app.settingsHref}" data-act="pop-close-nav">${icon('settings')}Settings</a>` : ''}
        <button role="menuitemcheckbox" aria-checked="${dark}" data-act="theme-toggle">${icon(dark ? 'sun' : 'moon')}${dark ? 'Light mode' : 'Dark mode'}</button>
        <button role="menuitem" data-act="signout">${icon('arrow-left-right')}Switch account</button>
        <button role="menuitem" data-act="signout">${icon('log-out')}Sign out</button>
      </div>`);
  }

  // ---------------------------------------------------------------- global search
  function runSearch(q) {
    const app = appFor(current.role); q = q.trim(); const out = [];
    if (!q) return out;
    const ql = q.toLowerCase();
    for (const n of app.nav) if (!n.hidden && (n.label + ' ' + n.title).toLowerCase().includes(ql)) out.push({ icon: n.icon, label: n.label, sub: 'Page', href: '#' + n.id });
    if (app.search) out.push(...app.search(q));
    return out.slice(0, 10);
  }
  function renderResults() {
    const el = $('#g-results'); if (!el) return;
    const q = shellUi.search.trim();
    if (!q) { el.hidden = true; return; }
    shellUi.results = runSearch(q);
    VF.setHTML(el, shellUi.results.length ? `<ul class="pop-list">${shellUi.results.map((x, i) => `<li><button class="pop-item" role="option" data-act="g-go" data-i="${i}"><span class="att-ic teal">${icon(x.icon || 'search')}</span><span class="pi-text"><strong>${esc(x.label)}</strong><span class="small muted">${esc(x.sub || '')}</span></span></button></li>`).join('')}</ul>` : `<div class="pop-empty">${icon('search')}<span>No results for “${esc(q)}”</span></div>`);
    el.hidden = false; shellUi.pop = 'search';
  }
  function goResult(i) {
    const x = shellUi.results[i]; if (!x) return;
    closePops(); const inp = $('#g-search'); if (inp) { inp.value = ''; inp.blur(); } shellUi.search = '';
    if (x.act && VF.ACT[x.act]) VF.ACT[x.act]({ dataset: { id: x.id, k: x.k } });
    else if (x.href) location.hash = x.href.slice(1);
  }
  function setDrawer(open) { shellUi.drawer = open; const c = $('#console'); if (c) c.classList.toggle('drawer-open', open); }
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
    'login-role': (el) => { loginUi.role = el.dataset.role; loginUi.error = ''; renderSignin(); },
    signout: () => { closePops(); VF.signOut(); },
    'sb-toggle': () => { const on = !collapsed(); try { localStorage.setItem(SIDEBAR_KEY, on ? 'collapsed' : 'open'); } catch (e) { /* not kept */ } const c = $('#console'); if (c) c.classList.toggle('collapsed', on); setTimeout(drawCharts, 220); },
    'sb-open': () => setDrawer(true),
    'sb-close': () => setDrawer(false),
    bell: () => openPop('notif'),
    'bell-open': (el) => { const src = noticeSource(); if (src && src.markRead) src.markRead(el.dataset.id); closePops(); if (src && src.href && VF.route() !== src.href.slice(1)) location.hash = src.href.slice(1); else { VF.rerender(); } },
    'bell-readall': () => { const src = noticeSource(); if (src && src.markRead) src.markRead(null); renderNotifPop(); renderNav(); if (current) VF.rerender(); },
    'acct-menu': () => openPop('acct'),
    'theme-toggle': () => { VF.theme.set(VF.theme.get() === 'dark' ? 'light' : 'dark'); renderAcctPop(); drawCharts(); if (current && current.page === 'm-settings') VF.rerender(); },
    'pop-close-nav': (el) => { closePops(); setDrawer(false); location.hash = el.getAttribute('href').slice(1); },
    'g-go': (el) => goResult(+el.dataset.i),
  });
  VF.INP['g-search'] = (el) => { shellUi.search = el.value; renderResults(); };

  // ---------------------------------------------------------------- live loop
  // Several tabs can be open at once (say, a driver and an operator side by side). One visible tab leads:
  // it runs the simulation and saves every second; the others adopt each save as it lands.
  const TAB_ID = Math.random().toString(36).slice(2);
  const LEADER_KEY = 'voltfleet-os:leader';
  function leads() {
    const c = VF.cloud && VF.cloud.leads ? VF.cloud.leads() : null;
    if (c !== null) return c;
    try {
      const l = JSON.parse(localStorage.getItem(LEADER_KEY) || 'null'); const now = Date.now();
      if (!l || l.id === TAB_ID || now - l.t > 3500) { localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, t: now })); return true; }
      return false;
    } catch (e) { return true; }
  }
  function onStorage(e) {
    if (e.key !== VF.STORE_KEY || !e.newValue) return;
    if (VF.cloud && VF.cloud.online && VF.cloud.online()) return; // each tab gets updates from the server instead
    if (!VF.adopt(e.newValue)) return;
    VF.ensureConnect(); VF.ensureFleet();
    if (!role()) { if (!current && $('.auth')) return; }
    refreshUi();
  }
  function refreshUi() {
    if (!current) return;
    if (!role()) { VF.signOut('Your account is no longer available.'); return; }
    const app = appFor(current.role);
    const ae = document.activeElement;
    const editing = ae && $('#view') && $('#view').contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName);
    const key = app.structKey ? app.structKey(current.page) : current.page;
    if (key !== lastKey && !editing) renderPage(true);
    else if (app.live) { const vals = app.live(current.page); if (vals) applyLive(vals); }
  }
  function tick() {
    if (document.hidden) return;
    if (leads()) {
      if (VF.tick(1000)) (VF.tickHooks || []).forEach((f) => f());
      if (VF.cloud && VF.cloud.online && VF.cloud.online()) VF.cloud.saveTick(); else VF.save();
    }
    tickN++;
    if (!current) return;
    const app = appFor(current.role);
    if (app.poll) app.poll();
    applyLive({ clock: clockText(), speed: speedText(), sync: syncText(), 'sync-state': { cls: 'sync-state' + (syncOn() ? ' on' : '') } });
    renderNav();
    if (shellUi.pop === 'notif') renderNotifPop();
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
    VF.ensureConnect(); VF.ensureFleet();
    document.addEventListener('click', (e) => {
      if (shellUi.pop && !e.target.closest('.pop, [data-act="bell"], [data-act="acct-menu"], #g-search-box')) closePops();
      const el = e.target.closest('[data-act]');
      if (!el || el.disabled) return;
      const fn = VF.ACT[el.dataset.act];
      if (fn) { if (el.tagName === 'A') e.preventDefault(); fn(el, e); }
    });
    document.addEventListener('change', (e) => { const el = e.target.closest('[data-chg]'); if (el && VF.CHG[el.dataset.chg]) VF.CHG[el.dataset.chg](el, e); });
    document.addEventListener('input', (e) => { const el = e.target.closest('[data-inp]'); if (el && VF.INP[el.dataset.inp]) VF.INP[el.dataset.inp](el, e); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (shellUi.pop || shellUi.drawer)) { closePops(); setDrawer(false); }
      if (e.key === '/' && current && !/^(INPUT|SELECT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '') && $('#g-search') && document.getElementById('dialog')?.hidden !== false) { e.preventDefault(); $('#g-search').focus(); }
      if (e.key === 'Enter' && e.target.id === 'g-search') { e.preventDefault(); if (shellUi.results.length) goResult(0); }
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[role="button"][data-act]:not(button):not(g)')) { e.preventDefault(); e.target.click(); }
      if (e.key === 'Escape' && VF.ui.connect.flow) { VF.ui.connect.flow = null; VF.renderConnect(); }
      if (e.key === 'Escape' && VF.ui.driver.sheet) { VF.ui.driver.sheet = null; VF.renderSheet(); }
      const g = e.target.closest && e.target.closest('g[data-act]');
      if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); VF.ACT[g.dataset.act](g, e); }
    });
    window.addEventListener('hashchange', () => { closePops(); setDrawer(false); routeChange(); });
    window.addEventListener('storage', onStorage);
    VF.onRemoteState = () => { VF.ensureConnect(); VF.ensureFleet(); if (current) refreshUi(); else if (!role() && $('.auth')) { /* sign-in page: nothing live to refresh */ } };
    if (VF.cloud && VF.cloud.start) VF.cloud.start();
    window.addEventListener('pagehide', () => { try { const l = JSON.parse(localStorage.getItem(LEADER_KEY) || 'null'); if (l && l.id === TAB_ID) localStorage.removeItem(LEADER_KEY); } catch (e) { /* ignore */ } });
    document.addEventListener('submit', (e) => { if (e.target.id === 'login-form') { e.preventDefault(); signInByEmail(); } });
    window.addEventListener('resize', VF.debounce(drawCharts, 150));
    routeChange();
    if (VF.real) VF.real.handleRedirect().then((back) => { if (!back && VF.real.connected()) VF.real.poll(); });
    setInterval(tick, 1000);
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && window.self === window.top) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
    }
  }
  boot();
})();
