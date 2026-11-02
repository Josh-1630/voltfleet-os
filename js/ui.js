/* VoltFleet OS — reusable UI components (Electric Teal & Fresh White design system).
   Pure functions that return HTML strings, plus a theme switch and a promise-based dialog.
   Every app (EV Manager, driver, operator, admin, developer) builds its pages from these. */
'use strict';
(function () {
  const { esc, clamp, sum, fmt, niceStep } = VF;
  const C = VF.c = {};

  // ---------------------------------------------------------------- theme (light by default)
  const THEME_KEY = 'voltfleet-os:theme';
  VF.theme = {
    get() { try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; } },
    set(t) {
      try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* not kept */ }
      document.documentElement.setAttribute('data-theme', t);
      const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', t === 'dark' ? '#0B1417' : '#F8FAFC');
    },
    apply() { VF.theme.set(VF.theme.get()); },
  };
  VF.theme.apply();

  // ---------------------------------------------------------------- status badges
  // One vocabulary for every status in the product. tone drives colour; label is what people read.
  const STATUS = {
    available: ['ok', 'Available'], in_use: ['teal', 'In use'], charging: ['mint', 'Charging'], offline: ['muted', 'Offline'],
    maintenance: ['warn', 'Maintenance'], waiting: ['warn', 'Waiting for charger'], completed: ['ok', 'Completed'], active: ['mint', 'Active'],
    stopped: ['muted', 'Stopped'], cancelled: ['muted', 'Cancelled'], confirmed: ['teal', 'Confirmed'], 'no-show': ['bad', 'No-show'],
    reserved: ['teal', 'Reserved'], faulted: ['bad', 'Faulted'], scheduled: ['teal', 'Scheduled'], on_shift: ['teal', 'On shift'], off_shift: ['muted', 'Off shift'],
    unread: ['teal', 'New'], critical: ['bad', 'Critical'], warning: ['warn', 'Warning'], info: ['teal', 'Info'], planned: ['muted', 'Planned'],
  };
  C.badge = (key, label) => { const [tone, l] = STATUS[key] || ['muted', key]; return `<span class="badge ${tone}">${esc(label || l)}</span>`; };

  // ---------------------------------------------------------------- cards
  C.card = (opts, body) => {
    const o = typeof opts === 'string' ? { title: opts } : opts;
    return `<section class="card ${o.cls || ''}"${o.id ? ` id="${o.id}"` : ''}>${o.title ? `<header class="card-head"><div class="card-titles"><h3>${o.title}</h3>${o.sub ? `<p class="card-sub">${o.sub}</p>` : ''}</div>${o.action ? `<div class="card-tools">${o.action}</div>` : ''}</header>` : ''}${body}</section>`;
  };
  // Metric card: icon, big number, label, and a comparison when one is meaningful.
  C.stat = (o) => {
    const trend = o.trend ? `<span class="trend ${o.trend.good === true ? 'good' : o.trend.good === false ? 'bad' : 'neutral'}">${VF.icon(o.trend.dir === 'up' ? 'trending-up' : 'trending-down')}${esc(o.trend.text)}</span>` : '';
    return `<div class="stat-card ${o.tone || ''}"${o.tip ? ` data-tip="${esc(o.tip)}"` : ''}>
      <div class="stat-top"><span class="stat-ic">${VF.icon(o.icon)}</span><span class="stat-name">${esc(o.label)}</span></div>
      <div class="stat-num"${o.live ? ` data-live="${o.live}"` : ''}>${o.value}${o.unit ? `<small>${esc(o.unit)}</small>` : ''}</div>
      <div class="stat-foot">${trend}<span class="stat-hint"${o.liveHint ? ` data-live="${o.liveHint}"` : ''}>${o.hint || ''}</span></div>
    </div>`;
  };
  C.empty = (o) => `<div class="empty-block">${VF.icon(o.icon || 'circle-dot')}<strong>${esc(o.title)}</strong>${o.text ? `<p>${esc(o.text)}</p>` : ''}${o.action || ''}</div>`;
  C.skeleton = (rows) => `<div class="skeleton" aria-busy="true" aria-label="Loading">${Array.from({ length: rows || 3 }, (_, i) => `<i style="width:${[92, 78, 64, 85, 70][i % 5]}%"></i>`).join('')}</div>`;
  C.banner = (tone, icon, html) => `<div class="banner-note ${tone}">${VF.icon(icon)}<div>${html}</div></div>`;

  // ---------------------------------------------------------------- tables
  // cols: [{ label, render(row) | key, align: 'r', cls }]
  C.table = (cols, rows, o) => {
    o = o || {};
    if (!rows.length) return C.empty(o.empty || { icon: 'list', title: 'Nothing here yet' });
    return `<div class="table-wrap"><table class="t ${o.cls || ''}"><thead><tr>${cols.map((c) => `<th class="${c.align === 'r' ? 'r' : ''}">${c.label}</th>`).join('')}</tr></thead><tbody>
      ${rows.map((r) => `<tr${o.rowAct ? ` class="clickable-row" data-act="${o.rowAct}" data-id="${esc(r.id)}"` : ''}>${cols.map((c) => `<td class="${c.align === 'r' ? 'r num' : ''} ${c.cls || ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;
  };
  C.seg = (items, active, act, extra) => `<div class="seg" role="group">${items.map(([k, l, ic]) => `<button type="button" data-act="${act}" data-k="${k}" aria-pressed="${active === k}"${extra || ''}>${ic ? VF.icon(ic) : ''}<span>${l}</span></button>`).join('')}</div>`;

  // ---------------------------------------------------------------- battery
  C.battery = (soc, o) => {
    o = o || {};
    const tone = o.charging ? 'mint' : soc < 15 ? 'bad' : soc < 30 ? 'warn' : 'ok';
    return `<div class="batt ${o.size || ''}" title="${Math.round(soc)}% charged"><div class="batt-bar"><i class="${tone}"${o.live ? ` data-live="${o.live}"` : ''} style="width:${clamp(soc, 0, 100).toFixed(1)}%"></i></div><span class="batt-val num"${o.liveText ? ` data-live="${o.liveText}"` : ''}>${Math.round(soc)}%</span></div>`;
  };

  // ---------------------------------------------------------------- vehicle illustrations
  // Simple side-profile artwork, recoloured by the theme. kind: car | van | suv
  C.vehicleArt = (kind, cls) => {
    const wheels = (a, b) => `<circle class="va-wheel" cx="${a}" cy="40" r="8"/><circle class="va-hub" cx="${a}" cy="40" r="3.2"/><circle class="va-wheel" cx="${b}" cy="40" r="8"/><circle class="va-hub" cx="${b}" cy="40" r="3.2"/>`;
    let body;
    if (kind === 'van') body = `<path class="va-body" d="M8 38V15q0-6 6-6h62q7 0 12 6l12 12q8 2 10 6l1 5H8z"/><path class="va-glass" d="M70 13h6q4 0 7 3l9 10H70z"/><path class="va-line" d="M14 26h50"/>${wheels(28, 92)}`;
    else if (kind === 'suv') body = `<path class="va-body" d="M7 38v-8q0-6 7-7l16-3 12-9q4-3 10-3h26q7 0 12 5l9 9 10 2q7 1 7 7v7H7z"/><path class="va-glass" d="M42 20l9-7q2-1 5-1h10v8zM70 12h7q4 0 7 4l5 4H70z"/>${wheels(28, 94)}`;
    else body = `<path class="va-body" d="M6 38v-6q0-6 7-7l20-3q12-10 26-10h14q14 0 25 10l10 2q8 2 8 9v5H6z"/><path class="va-glass" d="M38 22q9-7 20-7h8v7zM70 15h4q11 0 19 7H70z"/>${wheels(28, 92)}`;
    return `<svg class="vehicle-art ${cls || ''}" viewBox="0 0 120 50" aria-hidden="true">${body}<path class="va-ground" d="M2 48h116"/></svg>`;
  };

  // ---------------------------------------------------------------- charts
  // Area/line chart. data: [{label, values:{key:n}}]; series: [{key, label, tone:'teal'|'mint'|'lime'|'muted', area}]
  C.lineChart = (data, series, w, o) => {
    o = o || {};
    const h = o.h || 220, L = 46, R = 14, T = 14, B = 28, iw = w - L - R, ih = h - T - B, n = data.length;
    if (!n) return '';
    const vals = data.flatMap((d) => series.map((s) => d.values[s.key] || 0));
    const lo0 = o.min != null ? o.min : 0; const max = Math.max(lo0 + 1, ...vals);
    const step = niceStep((max - lo0) * 1.08, 4), lo = Math.floor(lo0 / step) * step, top = lo + Math.ceil((max - lo) * 1.08 / step) * step;
    const x = (i) => L + (n === 1 ? iw / 2 : i / (n - 1) * iw), y = (v) => T + ih - (v - lo) / (top - lo) * ih;
    let s = '';
    for (let v = lo; v <= top + 1e-9; v += step) s += `<line class="grid-line" x1="${L}" x2="${w - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${o.yFmt ? o.yFmt(v) : fmt.n(v)}</text>`;
    for (const se of series) {
      const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.values[se.key] || 0).toFixed(1)}`);
      if (se.area) s += `<path class="c-area ${se.tone}" d="M${x(0).toFixed(1)},${y(lo).toFixed(1)}L${pts.join('L')}L${x(n - 1).toFixed(1)},${y(lo).toFixed(1)}Z"/>`;
      s += `<path class="c-line ${se.tone}${se.dash ? ' dash' : ''}"${se.dash ? '' : ' pathLength="1"'} d="M${pts.join('L')}"/>`;
      const last = data[n - 1].values[se.key] || 0;
      s += `<circle class="c-end ${se.tone}" cx="${x(n - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4"/>`;
    }
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));
    data.forEach((d, i) => {
      if ((n - 1 - i) % every === 0) s += `<text x="${x(i).toFixed(1)}" y="${h - 8}" text-anchor="middle">${esc(d.label)}</text>`;
      const bw = iw / Math.max(1, n - 1);
      s += `<rect class="c-hit" x="${(x(i) - bw / 2).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${ih}"><title>${esc(d.label)}: ${series.map((se) => `${se.label} ${o.vFmt ? o.vFmt(d.values[se.key] || 0) : fmt.n(d.values[se.key] || 0, 1)}`).join(' · ')}</title></rect>`;
    });
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(o.label || 'Chart')}">${s}</svg>`;
  };
  // Vertical bars, one series or stacked. series: [{key, label, tone}]
  C.barChart = (data, series, w, o) => {
    o = o || {};
    const h = o.h || 220, L = 46, R = 10, T = 14, B = 28, iw = w - L - R, ih = h - T - B, n = data.length;
    if (!n) return '';
    const max = Math.max(1, ...data.map((d) => sum(series, (s) => d.values[s.key] || 0)));
    const step = niceStep(max, 4), top = Math.ceil(max / step) * step;
    const y = (v) => T + ih - v / top * ih, bw = iw / n;
    let s = '';
    for (let v = 0; v <= top + 1e-9; v += step) s += `<line class="grid-line" x1="${L}" x2="${w - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${o.yFmt ? o.yFmt(v) : fmt.n(v)}</text>`;
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 56))));
    data.forEach((d, i) => {
      const bx = L + i * bw + bw * 0.18, ww = Math.max(2, bw * 0.64); let base = 0;
      for (const se of series) {
        const v = d.values[se.key] || 0; if (v <= 0) continue;
        s += `<rect class="c-bar ${se.tone}" style="--i:${i}" x="${bx.toFixed(1)}" y="${y(base + v).toFixed(1)}" width="${ww.toFixed(1)}" height="${Math.max(0, y(base) - y(base + v)).toFixed(1)}" rx="3"><title>${esc(d.label)} · ${esc(se.label)}: ${o.vFmt ? o.vFmt(v) : fmt.n(v, 1)}</title></rect>`;
        base += v;
      }
      if ((n - 1 - i) % every === 0) s += `<text x="${(bx + ww / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle">${esc(d.label)}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(o.label || 'Chart')}">${s}</svg>`;
  };
  // Horizontal bars for rankings (per vehicle, per station).
  C.hbars = (rows, o) => {
    o = o || {};
    const max = Math.max(1e-9, ...rows.map((r) => r.value));
    return `<div class="hbars">${rows.map((r) => `<div class="hbar-row"><span class="hbar-label">${esc(r.label)}</span><div class="hbar-track"><i class="${r.tone || o.tone || 'teal'}" style="width:${(r.value / max * 100).toFixed(1)}%"></i></div><span class="hbar-val num">${r.text != null ? esc(r.text) : fmt.n(r.value)}</span></div>`).join('')}</div>`;
  };
  // Donut: segments [{label, value, tone}]
  C.donut = (segs, o) => {
    o = o || {};
    const total = sum(segs, (s) => s.value) || 1, r = 52, c = 2 * Math.PI * r;
    let off = 0;
    const arcs = segs.filter((s) => s.value > 0).map((s) => { const len = s.value / total * c; const a = `<circle class="d-seg ${s.tone}" cx="70" cy="70" r="${r}" stroke-dasharray="${Math.max(0, len - 2).toFixed(2)} ${c.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 70 70)"><title>${esc(s.label)}: ${s.value}</title></circle>`; off += len; return a; }).join('');
    return `<div class="donut-wrap"><svg class="donut" viewBox="0 0 140 140" role="img" aria-label="${esc(o.label || 'Breakdown')}"><circle class="d-track" cx="70" cy="70" r="${r}"/>${arcs}<text x="70" y="68" text-anchor="middle" class="d-val">${esc(o.value != null ? o.value : total)}</text><text x="70" y="86" text-anchor="middle" class="d-cap">${esc(o.caption || 'total')}</text></svg>
      <ul class="donut-legend">${segs.map((s) => `<li><i class="${s.tone}"></i><span>${esc(s.label)}</span><strong class="num">${s.value}</strong></li>`).join('')}</ul></div>`;
  };
  // Sparkline for metric tiles: smooth line + soft area, draws itself on page entry.
  let sparkId = 0;
  C.spark = (vals, tone, o) => {
    o = o || {}; const n = vals.length; if (n < 2) return '';
    const W = 120, H = 36, max = Math.max(...vals), min = Math.min(...vals), span = max - min || 1;
    const pts = vals.map((v, i) => [i / (n - 1) * W, H - 4 - (v - min) / span * (H - 10)]);
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < n; i++) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; const cx = (x0 + x1) / 2; d += `C${cx.toFixed(1)},${y0.toFixed(1)} ${cx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`; }
    const id = 'sg' + (++sparkId); const last = pts[n - 1];
    return `<svg class="spark-tile ${tone || 'teal'}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sg-a"/><stop offset="1" class="sg-b"/></linearGradient></defs>
      <path class="sp-area" d="${d}L${W},${H}L0,${H}Z" fill="url(#${id})"/><path class="sp-line" pathLength="1" d="${d}"/><circle class="sp-end" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6"/></svg>`;
  };
  // Radial gauge (0–100) with an optional live hook on the arc.
  C.ring = (pct, tone, live, label) => `<svg class="ring-tile ${tone || 'teal'}" viewBox="0 0 40 40" role="img" aria-label="${esc(label || Math.round(pct) + '%')}"><circle class="rg-track" cx="20" cy="20" r="16"/><circle class="rg-fill" cx="20" cy="20" r="16" pathLength="100" stroke-dasharray="${clamp(pct, 0, 100).toFixed(1)} 100"${live ? ` data-live="${live}"` : ''}/></svg>`;
  C.legend = (items) => `<div class="legend">${items.map(([label, tone]) => `<span><i class="${tone}"></i>${esc(label)}</span>`).join('')}</div>`;

  // ---------------------------------------------------------------- dialogs
  // Confirmation for destructive actions. Resolves true when confirmed.
  let dialogResolve = null;
  function dialogEl() {
    let el = document.getElementById('dialog');
    if (!el) { el = document.createElement('div'); el.id = 'dialog'; el.className = 'dialog-wrap'; el.hidden = true; document.body.appendChild(el); }
    return el;
  }
  C.confirm = (o) => new Promise((resolve) => {
    if (dialogResolve) dialogResolve(false);
    dialogResolve = resolve;
    const el = dialogEl();
    el.innerHTML = `<div class="dialog-backdrop" data-act="dlg-cancel"></div><div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title">
      <div class="dialog-icon ${o.danger ? 'bad' : 'teal'}">${VF.icon(o.icon || (o.danger ? 'triangle-alert' : 'info'))}</div>
      <h2 id="dlg-title">${esc(o.title)}</h2>${o.body ? `<p class="muted">${esc(o.body)}</p>` : ''}
      <div class="dialog-actions"><button class="btn" data-act="dlg-cancel">${esc(o.cancelLabel || 'Cancel')}</button><button class="btn ${o.danger ? 'danger-solid' : 'primary'}" data-act="dlg-ok" id="dlg-ok">${esc(o.confirmLabel || 'Confirm')}</button></div></div>`;
    el.hidden = false;
    setTimeout(() => { const b = document.getElementById('dlg-ok'); if (b) b.focus(); }, 0);
  });
  // Form modal. onSubmit(form) returns an error string to keep it open, or nothing to close.
  let formHandler = null;
  C.modal = (o) => {
    const el = dialogEl(); formHandler = o.onSubmit || null;
    el.innerHTML = `<div class="dialog-backdrop" data-act="dlg-close"></div><div class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
      <div class="dialog-head"><h2 id="dlg-title">${esc(o.title)}</h2><button class="icon-btn" data-act="dlg-close" aria-label="Close">${VF.icon('x')}</button></div>
      ${o.sub ? `<p class="muted">${esc(o.sub)}</p>` : ''}
      <form id="dlg-form" class="dialog-form" novalidate>${o.body}<div class="form-error" id="dlg-error" hidden></div>
      <div class="dialog-actions"><button type="button" class="btn" data-act="dlg-close">Cancel</button><button type="submit" class="btn primary">${esc(o.submitLabel || 'Save')}</button></div></form></div>`;
    el.hidden = false;
    setTimeout(() => { const f = el.querySelector('input, select, textarea'); if (f) f.focus(); }, 0);
  };
  C.closeDialog = () => { const el = dialogEl(); el.hidden = true; el.innerHTML = ''; formHandler = null; };
  function finish(ok) { const r = dialogResolve; dialogResolve = null; C.closeDialog(); if (r) r(ok); }
  Object.assign(VF.ACT, {
    'dlg-ok': () => finish(true),
    'dlg-cancel': () => finish(false),
    'dlg-close': () => { if (dialogResolve) finish(false); else C.closeDialog(); },
  });
  document.addEventListener('submit', (e) => {
    if (e.target.getAttribute('id') !== 'dlg-form' || !formHandler) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    const err = formHandler(data, e.target);
    if (err) { const box = document.getElementById('dlg-error'); box.hidden = false; box.innerHTML = `${VF.icon('triangle-alert')}<span>${esc(err)}</span>`; return; }
    C.closeDialog();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dialogEl().hidden) { if (dialogResolve) finish(false); else C.closeDialog(); } });

  // Field helpers for forms
  C.field = (label, input, hint) => `<label class="field"><span>${esc(label)}</span>${input}${hint ? `<small class="faint">${esc(hint)}</small>` : ''}</label>`;
  C.input = (name, value, attrs) => `<input class="input" name="${name}" id="f-${name}" value="${esc(value == null ? '' : value)}" ${attrs || ''}>`;
  C.select = (name, options, value, attrs) => `<select class="select" name="${name}" id="f-${name}" ${attrs || ''}>${options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
})();
