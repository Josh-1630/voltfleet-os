/* VoltFleet OS — EV Manager "Intelligence" (v2): Smart Charging 2.0, Predictive Maintenance, Route Optimizer,
   Vehicle-to-Grid and Impact & ROI. Pages read the optimisers in intel.js and register on VF.apps.manager. */
'use strict';
(function () {
  const { esc, sum, fmt, icon, clamp } = VF;
  const C = VF.c;
  const MIN = VF.MIN, HOUR = VF.HOUR, DAY = VF.DAY;
  const I = VF.intel;
  const app = VF.apps.manager;
  const ui = Object.assign(VF.mgr.ui, { iDepot: 'all', hSel: null, rSel: null, iScale: 250 });
  const F = () => VF.state.fleet;
  const money = (x, d) => fmt.money(x, d);
  const place = (n) => (VF.PLACES[n] ? VF.PLACES[n].name : n);
  const t = (ms) => VF.fmtTime(ms);
  const pct = (x, d) => fmt.n(x, d || 0) + '%';
  const prob = (p) => (p >= 0.995 ? '>99%' : p < 0.01 ? '<1%' : fmt.n(p * 100) + '%');
  const delta = (now, base, lowerIsBetter) => { if (!base) return null; const d = (now - base) / Math.abs(base) * 100; const good = lowerIsBetter ? d <= 0 : d >= 0; return { dir: d >= 0 ? 'up' : 'down', good, text: `${fmt.n(Math.abs(d), 0)}% vs unplanned` }; };
  const SIM_NOTE = 'Sample data: depot assets, telemetry histories and jobs are simulated until meters, chargers and vehicles are connected.';
  const BAND = ['Off-peak', 'Standard', 'Peak'];
  const save = () => { I.invalidate(); VF.save(); };

  // ================================================================ Smart Charging 2.0
  function depotsShown(p) { return ui.iDepot === 'all' ? p.depots : p.depots.filter((d) => d.depotId === ui.iDepot); }
  function aggSlots(ds) {
    if (!ds.length) return [];
    return ds[0].slots.map((s, i) => { const g = (k) => sum(ds, (d) => d.slots[i][k] || 0); return { i, ms: s.ms, h: s.h, band: s.band, price: s.price, base: g('base'), ev: g('ev'), evGreen: g('evGreen'), solar: g('solar'), bess: g('bess'), v2g: g('v2g'), import: g('import'), importBase: g('importBase'), evBase: g('evBase') }; });
  }
  function smartSummary(p) {
    const ds = depotsShown(p); const sl = aggSlots(ds); const items = ds.flatMap((d) => d.items);
    const cost = sum(ds, (d) => d.cost), base = sum(ds, (d) => d.costBase);
    return { ds, sl, items, cost, base, savings: base - cost, savingsPct: base > 0 ? (1 - cost / base) * 100 : 0, peak: Math.max(0, ...sl.map((s) => s.import)), peakBase: Math.max(0, ...sl.map((s) => s.importBase)), limit: sum(ds, (d) => d.dep.gridKw), ev: sum(sl, (s) => s.ev), green: sum(sl, (s) => s.evGreen), exp: sum(items, (x) => x.exported || 0), ready: items.filter((x) => x.ready).length, co2: sum(ds, (d) => d.co2), co2Base: sum(ds, (d) => d.co2Base) };
  }
  function whyList(p, s) {
    const out = []; const sl = s.sl;
    const peakPlan = sum(sl.filter((x) => x.band === 2), (x) => Math.max(0, x.ev - x.evGreen)), peakBase = sum(sl.filter((x) => x.band === 2), (x) => x.evBase);
    if (peakBase - peakPlan > 1) out.push(['clock', `Moves <strong>${fmt.kwh(peakBase - peakPlan)}</strong> of charging out of the 17:00–22:00 peak tariff.`]);
    out.push(s.peakBase > s.limit ? ['shield-alert', `Plug-and-charge would draw <strong>${fmt.kw(s.peakBase)}</strong>, over the ${fmt.kw(s.limit)} supply: the depot breaker would trip. The plan peaks at <strong>${fmt.kw(s.peak)}</strong>.`]
      : ['gauge', `Peak demand falls from ${fmt.kw(s.peakBase)} to <strong>${fmt.kw(s.peak)}</strong>, which cuts the monthly demand charge (peak shaving).`]);
    if (s.green > 1) out.push(['solar-panel', `<strong>${fmt.kwh(s.green)}</strong> comes from rooftop solar and the depot battery, at near-zero cost.`]);
    const first = s.items.slice().sort((a, b) => a.slack - b.slack || a.dep - b.dep)[0];
    if (first) out.push(['target', `<strong>${esc(first.v.name)}</strong> is first in the queue: it leaves at ${t(first.dep)} for a ${fmt.km(first.mission.km)} route with ${fmt.n(first.mission.kg)} kg on board and needs ${first.target}%.`]);
    if (s.exp > 0.5) out.push(['arrow-left-right', `${s.items.filter((x) => x.exported > 0).length} parked vehicles sell <strong>${fmt.kwh(s.exp)}</strong> back to the grid at the peak and still leave on target.`]);
    for (const x of s.items.filter((y) => !y.ready).slice(0, 2)) out.push(['triangle-alert', `<strong>${esc(x.v.name)}</strong> reaches ${Math.round(x.endSoc)}% of the ${x.target}% it needs by ${t(x.dep)}. Charge it at a public fast charger on the way or start its route later.`]);
    return `<ul class="why">${out.map(([ic, h]) => `<li>${icon(ic)}<span>${h}</span></li>`).join('')}</ul>`;
  }
  function queueRows(s, p) {
    const t0 = p.slots0[0] || VF.now(); const span = 25 * HOUR; const L = (ms) => clamp((ms - t0) / span * 100, 0, 100);
    const ticks = Array.from({ length: 4 }, (_, i) => t0 + (i * 6 + 3) * HOUR);
    const head = `<div class="sq-row sq-head"><span>#</span><span>Vehicle</span><span>Battery</span><div class="sq-axis">${ticks.map((ms) => `<i style="left:${L(ms).toFixed(2)}%">${t(ms)}</i>`).join('')}</div><span class="r">Energy</span></div>`;
    const rows = s.items.slice().sort((a, b) => a.slack - b.slack || a.dep - b.dep).map((it, k) => {
      const segs = it.kw.map((kw, i) => (kw > 0.05 ? `<b class="b${s.sl[i] ? s.sl[i].band : 1}" style="left:${(i / 25 * 100).toFixed(2)}%;width:${(100 / 25).toFixed(2)}%;opacity:${(0.45 + 0.55 * Math.min(1, kw / Math.max(it.acP, 1))).toFixed(2)}" title="${t((p.slots0[i] || 0))} · ${fmt.kwh(kw)}"></b>` : '')).join('')
        + it.exp.map((e, i) => (e > 0.05 ? `<b class="exp" style="left:${(i / 25 * 100).toFixed(2)}%;width:${(100 / 25).toFixed(2)}%" title="Selling ${fmt.kwh(e)} to the grid"></b>` : '')).join('');
      return `<div class="sq-row" data-act="m-open-vehicle" data-id="${it.v.id}" role="button" tabindex="0">
        <span class="sq-rank">${k + 1}</span>
        <span class="sq-name"><strong>${esc(it.v.name)}</strong><small class="muted">${t(it.arr)} → leaves ${t(it.dep)} · ${it.mode}</small></span>
        <span class="sq-batt num">${Math.round(it.arrSoc)}% → <strong class="${it.ready ? 'text-ok' : 'text-warn'}">${Math.round(it.endSoc)}%</strong><small class="muted">needs ${it.target}%</small></span>
        <div class="sq-bar"><span class="sq-present" style="left:${L(it.arr).toFixed(2)}%;width:${(L(it.dep) - L(it.arr)).toFixed(2)}%"></span>${segs}<span class="sq-dep" style="left:${L(it.dep).toFixed(2)}%" title="Leaves ${t(it.dep)}"></span></div>
        <span class="r num">${fmt.kwh(sum(it.kw, (x) => x))}${it.ready ? '' : '<br><span class="badge warn">Short</span>'}</span></div>`;
    }).join('');
    return `<div class="sq">${head}${rows || C.empty({ icon: 'battery-charging', title: 'No vehicle at this depot' })}</div>`;
  }
  function pageSmart() {
    const cfg = I.cfg(); const p = I.plan(); const s = smartSummary(p); const ap = cfg.applied;
    const depSeg = [['all', 'All depots']].concat(F().depots.map((d) => [d.id, d.name.split(',')[0]]));
    const applied = ap && VF.now() - ap.at < 14 * HOUR;
    return `<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="toolbar">${C.seg([['cost', 'Lowest cost', 'coins'], ['green', 'Greenest', 'leaf'], ['ready', 'Fastest ready', 'timer']], cfg.strategy, 'i-strategy')}${C.seg(depSeg, ui.iDepot, 'i-depot')}
        ${C.seg([['tou', 'ECG time-of-use'], ['hourly', 'Hourly day-ahead']], cfg.tariff.mode, 'i-tmode')}<span class="chip">${icon(I.wx.src === 'open-meteo' ? 'cloud-sun' : 'cloud')}${esc(I.weatherSource())}</span></div>
      ${VF.ops ? F().depots.filter((d) => !VF.ops.cfg().grid[d.id].up).map((d) => C.banner('bad', 'zap', `<strong>Grid outage at ${esc(d.name)}</strong> until about ${t(VF.ops.cfg().grid[d.id].until)}. The plan runs on the depot battery${I.cfg().depots[d.id].gensetKw ? ' and generator' : ''} for vehicles leaving first.`)).join('') : ''}
      ${applied ? C.banner('ok', 'circle-check', `<strong>Plan running since ${t(ap.at)}.</strong> ${ap.ready}/${ap.total} vehicles on track for departure. Charging power is set per vehicle through OCPP charging profiles (simulated until depot chargers are connected in Real chargers).`) : ''}
      <section class="stat-grid kpi-grid">
        ${C.stat({ icon: 'coins', label: 'Charging cost, next 24 h', value: money(s.cost, 0), hint: `${money(s.base, 0)} with plug-and-charge`, trend: delta(s.cost, s.base, true) })}
        ${C.stat({ icon: 'trending-down', label: 'Saved by the plan', value: pct(Math.max(0, s.savingsPct)), hint: `${money(Math.max(0, s.savings), 0)} tonight · about ${money(Math.max(0, s.savings) * 30, 0)} a month`, tone: 'lime' })}
        ${C.stat({ icon: 'gauge', label: 'Peak grid demand', value: fmt.n(s.peak), unit: 'kW', hint: `limit ${fmt.kw(s.limit)} · unplanned ${fmt.kw(s.peakBase)}`, trend: delta(s.peak, s.peakBase, true) })}
        ${C.stat({ icon: 'target', label: 'Mission readiness', value: `${s.ready}/${s.items.length}`, hint: `${s.items.filter((x) => x.outageProof).length}/${s.items.length} still ready if the grid fails at its usual times`, tone: s.ready === s.items.length ? '' : 'warn' })}
      </section>
      <div class="dash">
        ${C.card({ cls: 'span-12', title: 'Depot load plan', sub: 'Next 24 hours, hourly. Bars: what the depot draws; dashed line: plug-and-charge without a plan', action: C.legend([['EV from grid', 'teal'], ['EV from solar & battery', 'lime'], ['Building load', 'muted'], ['Sold to grid (V2G)', 'warn']]) }, '<div class="chart-slot" data-chart="i-load"></div><div class="band-key"><span class="b0">Off-peak ' + money(cfg.tariff.off) + '/kWh</span><span class="b1">Standard ' + money(cfg.tariff.std) + '</span><span class="b2">Peak ' + money(cfg.tariff.peak) + '</span><span class="risk">Outage risk (darker = likelier)</span>' + (cfg.tariff.mode === 'hourly' ? '<span class="muted">Hourly prices shown in each bar’s tooltip</span>' : '') + '</div>')}
        ${C.card({ cls: 'span-8 flush', title: 'Smart Queue', sub: 'Priority order: tightest charging window and earliest departure first. Shading shows when each vehicle charges and at which tariff.' }, queueRows(s, p))}
        <div class="span-4 stack">
          ${C.card({ title: 'Why this plan', sub: { cost: 'Optimised for lowest cost', green: 'Optimised for lowest carbon', ready: 'Optimised to be ready soonest' }[cfg.strategy] }, whyList(p, s))}
          ${C.card({ title: 'Depot energy assets', action: `<button class="btn small" data-act="i-assets">${icon('sliders')}Edit</button>` }, `<dl class="kv">${s.ds.map((d) => `<dt>${esc((F().depots.find((x) => x.id === d.depotId) || {}).name || d.depotId)}</dt><dd>${fmt.kw(d.dep.gridKw)} supply · ${d.dep.ac}×${d.dep.acKw} kW AC + ${d.dep.dc}×${d.dep.dcKw} kW DC${d.dep.solarKwp ? ` · ${fmt.n(d.dep.solarKwp)} kWp solar` : ''}${d.dep.bessKwh ? ` · ${fmt.n(d.dep.bessKwh)} kWh battery` : ''}</dd>`).join('')}</dl><p class="small muted">Tariff: demand charge ${money(cfg.tariff.demand)} per kW a month. Grid carbon: ${fmt.n(I.carbon(19) * 1000)} g/kWh at peak, ${fmt.n(I.carbon(2) * 1000)} g/kWh off-peak (assumed).</p>`)}
        </div>
        ${C.card({ cls: 'span-6', title: 'Renewables forecast', sub: `Rooftop solar output and cloud cover · ${esc(I.weatherSource())}` }, '<div class="chart-slot" data-chart="i-solar"></div>' + C.legend([['Solar kW', 'lime'], ['Cloud %', 'muted']]))}
        ${C.card({ cls: 'span-6', title: 'Carbon', sub: 'Grid emissions from charging in the next 24 hours' }, `<div class="cmp-figs"><div><span class="stat-label">With the plan</span><strong class="num">${fmt.n(s.co2)} kg</strong></div><div><span class="stat-label">Plug-and-charge</span><strong class="num muted">${fmt.n(s.co2Base)} kg</strong></div><div><span class="stat-label">Renewable share</span><strong class="num lime-text">${pct(s.ev ? s.green / s.ev * 100 : 0)}</strong></div></div><p class="small muted">${SIM_NOTE}</p>`)}
      </div>`;
  }
  function drawLoad(slot) {
    const w = Math.max(300, slot.clientWidth || 800); const h = 250; const p = I.plan(); const s = smartSummary(p); const sl = s.sl; const n = sl.length; if (!n) { slot.innerHTML = ''; return; }
    const L = 44, R = 10, T = 20, B = 34, iw = w - L - R, ih = h - T - B;
    const load = Math.max(10, ...sl.map((x) => Math.max(x.base + x.ev, x.importBase))); const showLimit = s.limit <= load * 2.2; const posMax = showLimit ? Math.max(load * 1.15, s.limit * 1.08) : load * 1.2; const negMax = Math.max(0, ...sl.map((x) => x.v2g));
    const top = VF.niceStep(posMax, 4) * Math.ceil(posMax / VF.niceStep(posMax, 4)); const bot = negMax ? Math.max(top * 0.15, negMax * 1.1) : 0;
    const y = (v) => T + (top - v) / (top + bot) * ih; const bw = iw / n;
    let g = '';
    for (const x of sl) { g += `<rect class="tb b${x.band}" x="${(L + x.i * bw).toFixed(1)}" y="${h - B + 6}" width="${bw.toFixed(1)}" height="5"/>`; const op = Math.max(...s.ds.map((d) => d.slots[x.i].outP)); if (op > 0.005) g += `<rect class="risk-cell" x="${(L + x.i * bw + 1).toFixed(1)}" y="${T - 10}" width="${(bw - 2).toFixed(1)}" height="5" rx="2" style="opacity:${clamp(op * 7, 0.08, 1).toFixed(2)}"><title>${t(x.ms)} · outage risk ${fmt.n(op * 100)}%</title></rect>`; }
    const step = VF.niceStep(top, 4); for (let v = 0; v <= top + 1e-9; v += step) g += `<line class="grid-line" x1="${L}" x2="${w - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmt.n(v)}</text>`;
    sl.forEach((x, i) => {
      const bx = L + i * bw + bw * 0.14, ww = Math.max(2, bw * 0.72); let base = 0;
      for (const [k, v] of [['muted', x.base], ['teal', Math.max(0, x.ev - x.evGreen)], ['lime', x.evGreen]]) { if (v <= 0.01) continue; g += `<rect class="c-bar ${k}" style="--i:${i}" x="${bx.toFixed(1)}" y="${y(base + v).toFixed(1)}" width="${ww.toFixed(1)}" height="${(y(base) - y(base + v)).toFixed(1)}" rx="2"/>`; base += v; }
      if (x.v2g > 0.01) g += `<rect class="c-bar warn" style="--i:${i}" x="${bx.toFixed(1)}" y="${y(0).toFixed(1)}" width="${ww.toFixed(1)}" height="${(y(-x.v2g) - y(0)).toFixed(1)}" rx="2"/>`;
      g += `<rect class="c-hit" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${ih}"><title>${t(x.ms)} · ${BAND[x.band]} ${money(x.price)}/kWh&#10;EV charging ${fmt.kw(x.ev)} (${fmt.kw(x.evGreen)} solar/battery)&#10;Building ${fmt.kw(x.base)} · solar ${fmt.kw(x.solar)}${x.bess ? ` · battery ${fmt.kw(x.bess)}` : ''}${x.v2g ? `&#10;V2G export ${fmt.kw(x.v2g)}` : ''}&#10;Grid import ${fmt.kw(x.import)} (unplanned ${fmt.kw(x.importBase)})</title></rect>`;
      if (i % Math.max(1, Math.ceil(n / Math.floor(iw / 48))) === 0) g += `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle">${t(x.ms)}</text>`;
    });
    const line = sl.map((x, i) => `${(L + i * bw + bw / 2).toFixed(1)},${y(x.importBase).toFixed(1)}`).join('L');
    g += `<path class="c-line warn dash" d="M${line}"/>`;
    g += showLimit ? `<line class="limit-line" x1="${L}" x2="${w - R}" y1="${y(s.limit).toFixed(1)}" y2="${y(s.limit).toFixed(1)}"/><text class="limit-txt" x="${w - R - 4}" y="${(y(s.limit) - 5).toFixed(1)}" text-anchor="end">Supply limit ${fmt.kw(s.limit)}</text>` : `<text class="limit-txt" x="${w - R - 4}" y="${T + 10}" text-anchor="end">Supply limit ${fmt.kw(s.limit)} ↑ (well above this load)</text>`;
    if (bot) g += `<line class="zero-line" x1="${L}" x2="${w - R}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>`;
    slot.innerHTML = `<svg class="chart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Depot load plan, kW per hour">${g}</svg>`;
  }
  function drawSolar(slot) {
    const w = Math.max(260, slot.clientWidth || 500); const p = I.plan(); const s = smartSummary(p);
    slot.innerHTML = C.lineChart(s.sl.map((x) => ({ label: t(x.ms), values: { solar: x.solar, cloud: I.weatherAt(x.ms + 30 * MIN).cloud * Math.max(1, Math.max(...s.sl.map((y) => y.solar))) / 100 } })), [{ key: 'solar', label: 'Solar', tone: 'lime', area: true }, { key: 'cloud', label: 'Cloud (scaled)', tone: 'muted', dash: true }], w, { h: 180, label: 'Solar forecast', vFmt: (v) => fmt.kw(v) });
  }

  // ================================================================ Predictive maintenance
  const RISK = { critical: ['bad', 'Act now'], warning: ['warn', 'Watch'], ok: ['ok', 'Healthy'] };
  function woFor(vid, k) { return I.cfg().workOrders.find((w) => w.vehicleId === vid && w.comp === k && w.status === 'scheduled'); }
  function selPred(h) {
    if (ui.hSel) { const r = h.rows.find((x) => x.v.id === ui.hSel.vid); const pr = r && r.preds.find((x) => x.c.k === ui.hSel.k); if (pr) return pr; }
    return h.flagged[0] || (h.rows[0] && h.rows[0].preds[0]);
  }
  const daysTxt = (p) => (p.days <= 0 ? 'past its limit' : isFinite(p.days) ? (p.days > 365 ? 'over a year' : `about ${fmt.n(p.days)} days`) : 'no decline detected');
  function pageHealth() {
    const h = I.health(); const cfg = I.cfg(); const sel = selPred(h); const open = cfg.workOrders.filter((w) => w.status === 'scheduled');
    const crit = h.flagged.filter((p) => p.risk === 'critical').length;
    const matrix = `<div class="table-wrap"><table class="t risk-t"><thead><tr><th>Vehicle</th><th class="r">Health</th>${I.COMP.map((c) => `<th class="c" title="${esc(c.signal)}">${icon(c.icon)}<span>${esc(c.label)}</span></th>`).join('')}</tr></thead><tbody>${h.rows.map((r) => `<tr><td><strong>${esc(r.v.name)}</strong><div class="small muted">${esc(r.v.model)}</div></td><td class="r num"><strong class="${r.score < 60 ? 'text-bad' : r.score < 75 ? 'text-warn' : ''}">${r.score}</strong></td>${r.preds.map((p) => `<td class="c"><button type="button" class="rk ${p.risk}${sel && sel.v.id === r.v.id && sel.c.k === p.c.k ? ' on' : ''}" data-act="i-hsel" data-id="${r.v.id}" data-k="${p.c.k}" aria-label="${esc(r.v.name)} ${esc(p.c.label)}: ${RISK[p.risk][1]}, health ${Math.round(p.health)}">${Math.round(p.health)}${woFor(r.v.id, p.c.k) ? icon('calendar-check') : ''}</button></td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    const wo = sel && woFor(sel.v.id, sel.c.k);
    const detail = sel ? `<div class="pred-head"><span class="att-ic ${RISK[sel.risk][0]}">${icon(sel.c.icon)}</span><div><strong>${esc(sel.v.name)} · ${esc(sel.c.label)}</strong><span class="small muted">${esc(sel.c.signal)}: <b class="num">${fmt.n(sel.cur, sel.c.dec)} ${esc(sel.c.unit)}</b> · limit ${fmt.n(sel.c.limit, sel.c.dec)} ${esc(sel.c.unit)}</span></div>${C.badge(sel.risk === 'ok' ? 'completed' : sel.risk, RISK[sel.risk][1])}</div>
      <div class="chart-slot" data-chart="i-trend"></div>${C.legend([['Measured', 'teal'], ['Trend & forecast', 'warn'], ['Limit', 'bad']])}
      <div class="plan-stats">
        <div><span class="stat-label">Reaches its limit in</span><strong class="num">${daysTxt(sel)}</strong></div>
        <div><span class="stat-label">Chance within 30 days</span><strong class="num ${sel.p30 > 0.6 ? 'text-bad' : sel.p30 > 0.2 ? 'text-warn' : 'text-ok'}">${prob(sel.p30)}</strong></div>
        <div><span class="stat-label">Trend per week</span><strong class="num">${sel.fit.slope >= 0 ? '+' : '−'}${fmt.n(Math.abs(sel.fit.slope * 7), sel.c.dec)} ${esc(sel.c.unit)}</strong></div>
        <div><span class="stat-label">Model confidence</span><strong class="num">${sel.conf} <small class="muted">R² ${fmt.n(Math.max(0, sel.fit.r2), 2)}</small></strong></div>
      </div>
      ${sel.risk !== 'ok' ? C.banner(sel.risk === 'critical' ? 'bad' : 'warn', 'wrench', `<strong>Recommended:</strong> ${esc(sel.c.fix)} Planned now about <strong>${money(sel.c.cost, 0)}</strong>; a breakdown typically costs ${money(sel.c.unplanned, 0)} and ${sel.c.days} day${sel.c.days > 1 ? 's' : ''} off the road.`) : C.banner('ok', 'circle-check', `${esc(sel.c.label)} is healthy. Next check at the routine service.`)}
      <div class="row gap">${wo ? `<span class="badge teal">${icon('calendar-check')} Booked for ${VF.fmtDayTime(wo.date)}</span><button class="btn small" data-act="i-wo-done" data-id="${wo.id}">${icon('check')}Mark done</button>` : sel.risk !== 'ok' ? `<button class="btn primary" data-act="i-book" data-id="${sel.v.id}" data-k="${sel.c.k}">${icon('calendar')}Schedule service</button><span class="small muted">Suggested ${VF.fmtDayTime(I.serviceSlot(sel))}, a low-demand day</span>` : ''}</div>` : C.empty({ icon: 'heart-pulse', title: 'No vehicles to monitor' });
    return `<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
      <section class="stat-grid kpi-grid">
        ${C.stat({ icon: 'heart-pulse', label: 'Fleet health score', value: h.score, unit: '/100', hint: `${h.rows.length} vehicles · ${I.COMP.length} components each` })}
        ${C.stat({ icon: 'shield-alert', label: 'Predicted issues', value: h.flagged.length, hint: `${crit} need action now · ${h.flagged.length - crit} to watch`, tone: crit ? 'warn' : '' })}
        ${C.stat({ icon: 'coins', label: 'Breakdown cost avoided', value: money(h.avoidCost, 0), hint: `about ${fmt.n(h.avoidDays, 0)} vehicle-days off the road prevented`, tone: 'lime' })}
        ${C.stat({ icon: 'calendar-check', label: 'Service booked', value: open.length, hint: open.length ? `next ${VF.fmtDayTime(open.slice().sort((a, b) => a.date - b.date)[0].date)}` : 'nothing booked yet' })}
      </section>
      <div class="dash">
        ${C.card({ cls: 'span-12 flush', title: 'Component risk matrix', sub: 'Health 0–100 per component, from 60 days of telemetry. Pick a cell to see its forecast.', action: C.legend([['Healthy', 'ok'], ['Watch', 'warn'], ['Act now', 'bad']]) }, matrix)}
        ${C.card({ cls: 'span-7', title: 'Forecast', sub: 'Trend fitted to the last 21 days, projected 30 days ahead with its uncertainty' }, detail)}
        <div class="span-5 stack">
          ${C.card({ title: 'Highest risk first', sub: 'Probability of reaching the limit within 30 days' }, h.flagged.length ? `<ul class="att-list">${h.flagged.slice(0, 7).map((p) => `<li data-act="i-hsel" data-id="${p.v.id}" data-k="${p.c.k}" role="button" tabindex="0"><span class="att-ic ${RISK[p.risk][0]}">${icon(p.c.icon)}</span><div><strong>${esc(p.v.name)} · ${esc(p.c.label)}</strong><span class="small muted">${prob(p.p30)} in 30 days · limit in ${daysTxt(p)}${woFor(p.v.id, p.c.k) ? ' · booked' : ''}</span></div>${icon('chevron-right', 'chev')}</li>`).join('')}</ul>` : C.empty({ icon: 'circle-check', title: 'No issues predicted', text: 'Every component is trending well inside its limits.' }))}
          ${C.card({ title: 'How predictions work' }, `<ul class="why"><li>${icon('activity')}<span>Each component has a monitored signal: battery health, pack temperature on fast charge, 12 V resting voltage, tread and pad depth, motor vibration and charging interruptions.</span></li><li>${icon('brain-circuit')}<span>A trend model is fitted per vehicle and component; its uncertainty gives the chance of crossing the limit in the next 30 days.</span></li><li>${icon('calendar-check')}<span>Service is suggested on low-demand days, before the limit, so vehicles aren’t pulled off routes.</span></li></ul><p class="small muted">${SIM_NOTE} Live signals come from connected telematics (Smartcar, OBD-II).</p>`)}
        </div>
        ${C.card({ cls: 'span-12 flush', title: 'Work orders', sub: 'Service booked from predictions' }, C.table([
          { label: 'Vehicle', render: (w) => { const v = VF.fleetVehicle(w.vehicleId); return `<strong>${esc(v ? v.name : 'Removed')}</strong>`; } },
          { label: 'Work', render: (w) => `${esc(w.title)}<div class="small muted">${esc(w.reason || '')}</div>` },
          { label: 'Booked for', render: (w) => `<span class="num">${VF.fmtDayTime(w.date)}</span>` },
          { label: 'Estimate', align: 'r', render: (w) => money(w.cost, 0) },
          { label: 'Status', render: (w) => C.badge(w.status === 'done' ? 'completed' : w.status === 'cancelled' ? 'cancelled' : 'scheduled', w.status === 'done' ? 'Done' : w.status === 'cancelled' ? 'Cancelled' : 'Booked') },
          { label: '', align: 'r', render: (w) => (w.status === 'scheduled' ? `<button class="btn small" data-act="i-wo-done" data-id="${w.id}">${icon('check')}Done</button> <button class="btn small ghost" data-act="i-wo-cancel" data-id="${w.id}">Cancel</button>` : '') },
        ], cfg.workOrders.slice(0, 20), { empty: { icon: 'wrench', title: 'No work orders yet', text: 'Schedule service from a prediction above.' } }))}
      </div>`;
  }
  function drawTrend(slot) {
    const h = I.health(); const p = selPred(h); if (!p) { slot.innerHTML = ''; return; }
    const w = Math.max(280, slot.clientWidth || 600), H = 210, L = 46, R = 12, T = 12, B = 26, iw = w - L - R, ih = H - T - B;
    const n = p.ys.length, ahead = 30, N = n + ahead; const f = p.fit; const w0 = n - f.n;
    const proj = Array.from({ length: ahead + f.n }, (_, i) => f.icpt + f.slope * i);
    const sd = (i) => Math.sqrt(f.sigma ** 2 + (f.seSlope * Math.max(0, i - f.n + 1)) ** 2);
    const vals = p.ys.concat(proj, [p.c.limit]); let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.12 || 1; lo -= pad; hi += pad;
    const x = (i) => L + i / (N - 1) * iw, y = (v) => T + (hi - v) / (hi - lo) * ih;
    let g = ''; const step = VF.niceStep(hi - lo, 4); for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) g += `<line class="grid-line" x1="${L}" x2="${w - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmt.n(v, step < 1 ? (step < 0.1 ? 2 : 1) : 0)}</text>`;
    const band = proj.map((v, i) => [x(w0 + i), y(v + sd(i))]).concat(proj.map((v, i) => [x(w0 + i), y(v - sd(i))]).reverse());
    g += `<path class="fc-band" d="M${band.map((q) => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join('L')}Z"/>`;
    g += `<line class="limit-line" x1="${L}" x2="${w - R}" y1="${y(p.c.limit).toFixed(1)}" y2="${y(p.c.limit).toFixed(1)}"/><text class="limit-txt" x="${L + 6}" y="${(y(p.c.limit) - 5).toFixed(1)}">Limit ${fmt.n(p.c.limit, p.c.dec)} ${esc(p.c.unit)}</text>`;
    g += `<line class="today-line" x1="${x(n - 1).toFixed(1)}" x2="${x(n - 1).toFixed(1)}" y1="${T}" y2="${T + ih}"/><text x="${x(n - 1).toFixed(1)}" y="${H - 8}" text-anchor="middle">Today</text><text x="${L}" y="${H - 8}">60 days ago</text><text x="${w - R}" y="${H - 8}" text-anchor="end">+30 days</text>`;
    g += `<path class="c-line teal" pathLength="1" d="M${p.ys.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('L')}"/>`;
    g += `<path class="c-line warn dash" d="M${proj.map((v, i) => `${x(w0 + i).toFixed(1)},${y(v).toFixed(1)}`).join('L')}"/>`;
    g += `<circle class="c-end teal" cx="${x(n - 1).toFixed(1)}" cy="${y(p.ys[n - 1]).toFixed(1)}" r="4"/>`;
    slot.innerHTML = `<svg class="chart" viewBox="0 0 ${w} ${H}" width="${w}" height="${H}" role="img" aria-label="${esc(p.c.signal)} trend and forecast">${g}</svg>`;
  }

  // ================================================================ Route optimizer
  const FACTORS = [['traffic', 'Traffic', 'clock'], ['weather', 'Weather', 'cloud-rain'], ['terrain', 'Hills', 'mountain'], ['cargo', 'Cargo load', 'package'], ['ageing', 'Battery ageing', 'battery-low']];
  function routeCoords(r) {
    const pts = [r.start].concat(r.stops.map((j) => j.node), [r.home]); const out = [];
    for (let i = 0; i < pts.length - 1; i++) for (const n of VF.shortestPath(pts[i], pts[i + 1]).path) { const q = VF.PLACES[n]; const last = out[out.length - 1]; if (!last || last[0] !== q.lat || last[1] !== q.lon) out.push([q.lat, q.lon]); }
    return out;
  }
  function pageRoutes() {
    const cfg = I.cfg(); const ro = I.optimizeRoutes(); const fx = cfg.factors;
    const sel = ro.routes.find((r) => r.v.id === ui.rSel) || ro.routes[0]; if (sel) ui.rSel = sel.v.id;
    const wx = I.weatherAt(ro.today ? VF.now() : ro.day + 9 * HOUR); const hr = VF.hourOf(ro.today ? VF.now() : ro.day + 8 * HOUR);
    const done = cfg.routesDispatched === ro.day;
    const assigned = {}; for (const r of ro.routes) for (const l of r.legs) assigned[l.j.id] = { r, l };
    const parts = sel ? sel.parts : null;
    const breakdown = parts ? C.hbars([['Driving', parts.base], ['Cargo load', parts.cargo], ['Hills', parts.terrain], ['Weather & A/C', parts.weather], ['Battery ageing', parts.ageing]].map(([l, v]) => ({ label: l, value: Math.abs(v), text: (v < 0 ? '−' : '') + fmt.n(Math.abs(v), 1), tone: v < 0 ? 'mint' : l === 'Driving' ? 'teal' : 'warn' }))) + '<p class="small muted">kWh for this route. Mint bars are energy won back, such as regenerative braking downhill.</p>' : '';
    return `<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="toolbar"><span class="small muted">${icon('brain-circuit')} Optimising for:</span>${FACTORS.map(([k, l, ic]) => `<label class="chip toggle${fx[k] ? ' on' : ''}"><input type="checkbox" data-chg="i-factor" data-k="${k}" ${fx[k] ? 'checked' : ''}>${icon(ic)}${l}</label>`).join('')}
        <span class="chip">${icon(wx.rainP > 50 ? 'cloud-rain' : 'cloud-sun')}${fmt.n(wx.temp, 0)}°C · rain ${fmt.n(wx.rainP)}%</span><span class="chip">${icon('car-front')}Traffic ×${fmt.n(I.traffic(hr), 2)} at ${String(hr).padStart(2, '0')}:00</span></div>
      ${done ? C.banner('ok', 'circle-check', `<strong>Routes ${ro.today ? 'dispatched' : 'approved for tomorrow'}.</strong> Drivers see their stop order in the driver app.`) : ''}
      ${ro.unassigned.length ? C.banner('warn', 'triangle-alert', `<strong>${ro.unassigned.length} job${ro.unassigned.length > 1 ? 's' : ''} couldn’t be assigned</strong> within payload and battery limits: ${ro.unassigned.map((j) => esc(j.ref)).join(', ')}. Charge another vehicle or split the load.`) : ''}
      <section class="stat-grid kpi-grid">
        ${C.stat({ icon: 'route', label: `Distance, ${ro.today ? 'today' : 'tomorrow'}`, value: fmt.n(ro.km), unit: 'km', hint: `${fmt.n(ro.base.km)} km in list order`, trend: delta(ro.km, ro.base.km, true) })}
        ${C.stat({ icon: 'zap', label: 'Energy needed', value: fmt.n(ro.kwh), unit: 'kWh', hint: `${fmt.n(ro.base.kwh)} kWh unoptimised`, trend: delta(ro.kwh, ro.base.kwh, true) })}
        ${C.stat({ icon: 'clock', label: 'On-time deliveries', value: pct(ro.onTime), hint: `${pct(ro.base.onTime)} without optimisation`, tone: ro.onTime >= 99 ? 'lime' : '' })}
        ${C.stat({ icon: 'users', label: 'Vehicles used', value: `${ro.routes.length}/${ro.fleetN}`, hint: `${ro.jobs.length} jobs · ${fmt.dur(ro.minutes)} driving and stops` })}
      </section>
      <div class="dash">
        ${C.card({ cls: 'span-7', title: sel ? `${esc(sel.v.name)} · ${sel.stops.length} stop${sel.stops.length === 1 ? "" : "s"}` : 'Route', sub: sel ? `Leaves ${place(sel.start)} at ${t(sel.depart)} · back at ${place(sel.home)} ${t(sel.back)}` : 'No route', action: sel ? `<span class="badge ${sel.endSoc < 25 ? 'warn' : 'ok'}">${Math.round(sel.endSoc)}% on return</span>` : '' }, sel ? `<div class="map-wrap">${VF.mapSVG({ id: 'i-route-map', stations: [], vehicles: [{ id: sel.v.id, ...VF.fleetPos(sel.v), cls: sel.v.status, label: sel.v.name.replace(/^(\w)\w*\s/, '$1'), title: sel.v.name }], route: routeCoords(sel), demand: sel.stops.map((j, i) => ({ node: j.node, n: i + 1 })), label: 'Optimised route' })}</div>${VF.mgr.mapNote()}` : C.empty({ icon: 'route', title: 'Nothing to route' }))}
        <div class="span-5 stack">
          ${C.card({ cls: 'flush', title: 'Optimised routes', sub: 'Pick one to see it on the map' }, `<ul class="rt-list">${ro.routes.map((r) => `<li class="${sel && r.v.id === sel.v.id ? 'on' : ''}" data-act="i-rsel" data-id="${r.v.id}" role="button" tabindex="0"><div class="row between"><strong>${esc(r.v.name)}</strong><span class="small muted num">${t(r.depart)}–${t(r.back)}</span></div><span class="small muted">${r.stops.length} stop${r.stops.length === 1 ? "" : "s"} · ${fmt.km(r.km)} · ${fmt.kwh(r.kwh)} · ${fmt.n(sum(r.stops, (j) => j.kg))} kg${r.late ? ` · <b class="text-warn">${r.late} late</b>` : ''}</span><div class="progress"><i style="width:${clamp(r.endSoc, 0, 100).toFixed(0)}%"></i></div></li>`).join('')}</ul>`)}
          ${C.card({ title: 'Energy model', sub: sel ? `Where ${esc(sel.v.name)}’s energy goes` : '' }, breakdown || C.empty({ icon: 'zap', title: 'No route selected' }))}
        </div>
        ${C.card({ cls: 'span-12 flush', title: `Jobs, ${ro.today ? 'today' : 'tomorrow'}`, sub: 'Time windows, cargo and the vehicle each job was given', action: `${VF.ops && VF.ops.cfg().jobs[ro.day] ? `<button class="btn small ghost" data-act="o-jobs-reset">Use sample jobs</button>` : ''}<button class="btn small" data-act="o-jobs-import">${icon('download')}Import jobs (CSV)</button>${!done && ro.routes.length ? `<button class="btn primary" data-act="i-dispatch">${icon('send')}${ro.today ? 'Dispatch all routes' : 'Approve for tomorrow'}</button>` : ''}` }, C.table([
          { label: 'Job', render: (j) => `<strong class="mono">${esc(j.ref)}</strong><div class="small muted">${esc(j.name)}</div>` },
          { label: 'Where', render: (j) => esc(place(j.node)) },
          { label: 'Window', render: (j) => `<span class="num">${String(j.from).padStart(2, '0')}:00–${String(j.to).padStart(2, '0')}:00</span>` },
          { label: 'Cargo', align: 'r', render: (j) => fmt.n(j.kg) + ' kg' },
          { label: 'Vehicle', render: (j) => (assigned[j.id] ? `${esc(assigned[j.id].r.v.name)} <span class="muted small">#${assigned[j.id].r.stops.indexOf(j) + 1}</span>` : '<span class="badge warn">Unassigned</span>') },
          { label: 'ETA', align: 'r', render: (j) => (assigned[j.id] ? `<span class="${assigned[j.id].l.late ? 'text-warn' : ''}">${t(assigned[j.id].l.eta)}</span>` : '—') },
          { label: '', render: (j) => (assigned[j.id] ? (assigned[j.id].l.late ? C.badge('warning', 'Late') : C.badge('completed', 'On time')) : '') },
        ], ro.jobs.slice().sort((a, b) => a.from - b.from)))}
        <p class="span-12 small muted">Heuristic: cheapest insertion under payload and battery limits, then 2-opt stop ordering and the best departure time in a 2-hour window. Baseline: jobs dealt out in list order, everyone leaving at 07:30. ${SIM_NOTE}</p>
      </div>`;
  }

  // ================================================================ Vehicle-to-grid
  const CAPB = { v2g: 'ok', pilot: 'teal', v2l: 'muted', none: 'muted' };
  function pageV2G() {
    const cfg = I.cfg(); const c = cfg.v2g; const x = I.v2g(); const live = I.eventLive(); const h = VF.hourOf(VF.now()); const band = I.band(h);
    const month = x.net * 22;
    return `<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="toolbar">${C.seg([['on', 'Programme on', 'radio-tower'], ['off', 'Off', 'pause']], c.on ? 'on' : 'off', 'i-v2g-on')}${C.seg([['today', 'Capable vehicles today'], ['fleet', 'What-if: whole fleet bidirectional']], c.scenario, 'i-v2g-scn')}
        <label class="field inline"><span class="small muted">Never below</span>${C.select('floor', [[30, '30%'], [40, '40%'], [50, '50%'], [60, '60%']], c.floor, 'data-chg="i-v2g-floor"')}</label></div>
      ${c.scenario === 'fleet' ? C.banner('teal', 'info', '<strong>What-if scenario.</strong> Most vehicles in this fleet support vehicle-to-load only today. This shows the value if every vehicle and depot charger were bidirectional (ISO 15118-20).') : ''}
      ${!c.on ? C.banner('warn', 'pause', 'The V2G programme is off: vehicles only charge.') : ''}
      <section class="stat-grid kpi-grid">
        ${C.stat({ icon: 'radio-tower', label: 'Virtual power plant', value: fmt.n(x.capKw), unit: 'kW', hint: `${x.enrolled} vehicles enrolled · ${fmt.kwh(x.availKwh)} above the floor` })}
        ${C.stat({ icon: 'arrow-left-right', label: 'Sold to grid tonight', value: fmt.n(x.out), unit: 'kWh', hint: `at ${money(c.exportPrice)}/kWh in the evening peak` })}
        ${C.stat({ icon: 'wallet', label: 'Net value tonight', value: money(x.net, 0), hint: `${money(x.revenue, 0)} credit − ${money(x.recharge, 0)} recharge − ${money(x.wear, 0)} battery wear`, tone: x.net > 0 ? 'lime' : '' })}
        ${C.stat({ icon: 'trending-up', label: 'A month (22 weekdays)', value: money(month, 0), hint: `${money(x.enrolled ? month / x.enrolled : 0, 0)} per enrolled vehicle` })}
      </section>
      <div class="dash">
        ${C.card({ cls: 'span-8', title: 'Tonight’s dispatch', sub: 'Energy sold back at the peak (up) and recharged off-peak before departure (down), with the tariff', action: C.legend([['Sold to grid', 'warn'], ['Charging (all vehicles)', 'teal'], ['Tariff', 'muted']]) }, '<div class="chart-slot" data-chart="i-v2g"></div>')}
        ${C.card({ cls: 'span-4 v2g-live' + (live ? ' on' : ''), title: live ? 'Grid event: exporting' : 'Grid now', sub: live ? `Ends ${t(live.e.end)}` : `${BAND[band]} tariff · ${money(I.price(h))}/kWh` }, live ? `<div class="big-metric"><span data-live="i-ev-kw" data-tween>${fmt.n(live.kw)}</span><small>kW from ${live.parked.length} parked vehicles</small></div><div class="kv-inline small"><span><b data-live="i-ev-kwh">${fmt.kwh(live.e.kwh || 0)}</b> exported</span><span><b data-live="i-ev-val">${money((live.e.kwh || 0) * c.exportPrice)}</b> credit</span></div><button class="btn" data-act="i-event-stop">${icon('square')}End event</button>`
          : `<p class="small muted">When the grid is stressed, the utility or an aggregator can call a demand-response event. Parked, enrolled vehicles export power, never going below ${c.floor}% or their next mission’s needs.</p><button class="btn primary" data-act="i-event" ${c.on && x.enrolled ? '' : 'disabled'}>${icon('zap')}Simulate a grid event</button>`)}
        ${C.card({ cls: 'span-12 flush', title: 'Participants', sub: 'Untick a vehicle to keep it out of the programme' }, C.table([
          { label: 'In', render: (r) => `<input type="checkbox" data-chg="i-v2g-opt" data-id="${r.v.id}" ${c.optOut.includes(r.v.id) ? '' : 'checked'} aria-label="Enrol ${esc(r.v.name)}">` },
          { label: 'Vehicle', render: (r) => `<strong>${esc(r.v.name)}</strong><div class="small muted">${esc(r.v.model)}</div>` },
          { label: 'Bidirectional', render: (r) => `<span class="badge ${CAPB[r.cap[0]]}">${esc(r.cap[1])}</span>` },
          { label: 'Plugged in', render: (r) => `<span class="num">${r.it.arr <= VF.now() + 5 * MIN ? 'Now' : t(r.it.arr)}</span> <span class="small muted">→ ${t(r.it.dep)}</span>` },
          { label: 'Above floor', align: 'r', render: (r) => fmt.kwh(r.availKwh) },
          { label: 'Sells tonight', align: 'r', render: (r) => (r.out ? fmt.kwh(r.out) : '<span class="muted">—</span>') },
          { label: 'Net value', align: 'r', render: (r) => (r.out ? `<strong class="${r.net > 0 ? 'text-ok' : 'text-warn'}">${money(r.net)}</strong>` : '') },
          { label: 'Leaves with', align: 'r', render: (r) => `${Math.round(r.it.endSoc)}% <span class="small muted">/ ${r.it.target}%</span>` },
        ], x.rows.slice().sort((a, b) => b.out - a.out || b.availKwh - a.availKwh)))}
        ${C.card({ cls: 'span-12', title: 'Economics', action: `<button class="btn small" data-act="i-v2g-edit">${icon('sliders')}Edit</button>` }, `<div class="cmp-figs"><div><span class="stat-label">Export price (peak)</span><strong class="num">${money(c.exportPrice)}/kWh</strong></div><div><span class="stat-label">Off-peak recharge</span><strong class="num">${money(cfg.tariff.off)}/kWh</strong></div><div><span class="stat-label">Battery wear</span><strong class="num">${money(c.wear)}/kWh</strong></div><div><span class="stat-label">Round trip</span><strong class="num">85%</strong></div><div><span class="stat-label">Power per vehicle</span><strong class="num">${fmt.kw(c.maxKw)}</strong></div></div><p class="small muted">Battery wear = pack replacement cost ÷ (cycle life × capacity). Export prices depend on a utility or aggregator agreement; ECG and Ghana’s market rules for vehicle exports are still being defined. ${SIM_NOTE}</p>`)}
      </div>`;
  }
  function drawV2G(slot) {
    const w = Math.max(280, slot.clientWidth || 700), H = 220, L = 44, R = 40, T = 12, B = 28, iw = w - L - R, ih = H - T - B; const x = I.v2g(); const hs = x.hours; const n = hs.length; if (!n) { slot.innerHTML = ''; return; }
    const up = Math.max(5, ...hs.map((q) => q.out)), dn = Math.max(5, ...hs.map((q) => q.inn)); const mid = T + ih * up / (up + dn);
    const yU = (v) => mid - v / up * (mid - T), yD = (v) => mid + v / dn * (T + ih - mid); const bw = iw / n;
    const pmax = Math.max(...hs.map((q) => q.price)) * 1.1; const yP = (v) => T + ih - v / pmax * ih;
    let g = `<line class="zero-line" x1="${L}" x2="${w - R}" y1="${mid.toFixed(1)}" y2="${mid.toFixed(1)}"/><text x="${L - 6}" y="${(T + 10).toFixed(1)}" text-anchor="end">${fmt.n(up)}</text><text x="${L - 6}" y="${(T + ih).toFixed(1)}" text-anchor="end">${fmt.n(dn)}</text><text x="${L - 6}" y="${(mid + 4).toFixed(1)}" text-anchor="end">0</text>`;
    hs.forEach((q, i) => {
      const bx = L + i * bw + bw * 0.15, ww = Math.max(2, bw * 0.7);
      g += `<rect class="tb b${q.band}" x="${(L + i * bw).toFixed(1)}" y="${H - B + 6}" width="${bw.toFixed(1)}" height="5"/>`;
      if (q.out > 0.05) g += `<rect class="c-bar warn" style="--i:${i}" x="${bx.toFixed(1)}" y="${yU(q.out).toFixed(1)}" width="${ww.toFixed(1)}" height="${(mid - yU(q.out)).toFixed(1)}" rx="2"/>`;
      if (q.inn > 0.05) g += `<rect class="c-bar teal" style="--i:${i}" x="${bx.toFixed(1)}" y="${mid.toFixed(1)}" width="${ww.toFixed(1)}" height="${(yD(q.inn) - mid).toFixed(1)}" rx="2"/>`;
      g += `<rect class="c-hit" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${ih}"><title>${t(q.ms)} · ${BAND[q.band]} ${money(q.price)}/kWh&#10;Sold ${fmt.kwh(q.out)} · charging ${fmt.kwh(q.inn)}</title></rect>`;
      if (i % Math.max(1, Math.ceil(n / Math.floor(iw / 48))) === 0) g += `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${t(q.ms)}</text>`;
    });
    g += `<path class="c-line muted" d="M${hs.map((q, i) => `${(L + i * bw).toFixed(1)},${yP(q.price).toFixed(1)}H${(L + (i + 1) * bw).toFixed(1)}`).join('L')}"/><text x="${w - R + 4}" y="${(yP(hs[n - 1].price) + 4).toFixed(1)}">${fmt.n(hs[n - 1].price, 2)}</text>`;
    slot.innerHTML = `<svg class="chart" viewBox="0 0 ${w} ${H}" width="${w}" height="${H}" role="img" aria-label="V2G dispatch, kWh per hour">${g}</svg>`;
  }

  // ================================================================ Impact & ROI
  const SCALES = [[10, '10'], [50, '50'], [250, '250'], [1000, '1,000'], [10000, '10,000']];
  function cmpRow(label, a, b, f) { const max = Math.max(a, b, 1e-9); return `<div class="cmp-row"><span class="cmp-l">${esc(label)}</span><div class="cmp-bars"><div><i class="muted" style="width:${(a / max * 100).toFixed(1)}%"></i><span class="num">${f(a)}</span></div><div><i class="teal" style="width:${(b / max * 100).toFixed(1)}%"></i><span class="num"><strong>${f(b)}</strong></span></div></div><span class="cmp-d ${b <= a ? 'text-ok' : 'text-warn'}">${b <= a ? '−' : '+'}${fmt.n(Math.abs(1 - b / Math.max(a, 1e-9)) * 100)}%</span></div>`; }
  function pageImpact() {
    const r = I.roi(); const m = r.m; const N = ui.iScale; const n0 = Math.max(1, VF.simVehicles().length);
    const perKm = (x) => money(x, 2);
    const totNow = r.energyNow + r.maintNow + r.opsNow, totNext = r.energyNext + r.maintNext + r.opsNext;
    const co2Year = m.co2 * 12; const scope2 = m.kwh * VF.CO2.GRID_KG_PER_KWH / 1000 * 12; const gpk = m.km ? m.kwh * VF.CO2.GRID_KG_PER_KWH / m.km * 1000 : 0;
    const MOD = [
      ['battery-charging', 'Smart Charging 2.0', 'Simulated', 'teal', 'Live once depot chargers accept OCPP charging profiles (Real chargers) and a site meter reports load.'],
      ['heart-pulse', 'Predictive maintenance', 'Simulated', 'teal', 'Live once telematics stream battery, 12 V and tyre signals (Smartcar or OBD-II).'],
      ['route', 'AI route optimisation', 'Live weather', 'ok', 'Uses the Open-Meteo forecast; traffic and jobs are modelled until a TMS or order feed is connected.'],
      ['arrow-left-right', 'Vehicle-to-grid', 'Pilot-ready', 'warn', 'Needs ISO 15118-20 bidirectional chargers, V2G-capable vehicles and an export agreement.'],
    ];
    return `<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
      <section class="stat-grid kpi-grid">
        ${C.stat({ icon: 'coins', label: 'Energy cost per km', value: perKm(r.energyNext), hint: `${perKm(r.energyNow)} today · target −30%`, trend: { dir: 'down', good: true, text: `${fmt.n((1 - r.energyNext / Math.max(1e-9, r.energyNow)) * 100)}% lower` } })}
        ${C.stat({ icon: 'activity', label: 'Fleet uptime', value: pct(r.uptimeNext, 1), hint: `${pct(r.uptimeNow, 1)} today · fewer breakdowns`, trend: { dir: 'up', good: true, text: `+${fmt.n(r.uptimeNext - r.uptimeNow, 1)} pts` } })}
        ${C.stat({ icon: 'clock', label: 'On-time deliveries', value: pct(r.slaNext, 1), hint: `${pct(r.slaNow, 1)} unoptimised · target 99.9%`, tone: r.slaNext >= 99 ? 'lime' : '' })}
        ${C.stat({ icon: 'leaf', label: 'CO₂ avoided a year', value: fmt.n(co2Year, 1), unit: 't', hint: 'vs diesel vehicles doing the same work', tone: 'lime' })}
      </section>
      <div class="dash">
        ${C.card({ cls: 'span-7', title: 'Cost per km', sub: 'Today (grey) and with the intelligence modules running (teal)' }, `<div class="cmp">${cmpRow('Energy', r.energyNow, r.energyNext, perKm)}${cmpRow('Maintenance', r.maintNow, r.maintNext, perKm)}${cmpRow('Operations', r.opsNow, r.opsNext, perKm)}${cmpRow('Total', totNow, totNext, perKm)}</div><p class="small muted">Energy from the last 30 days’ charging and tonight’s smart-charging plan; maintenance from service records plus predicted breakdowns; operations from driver time on today’s routes. Estimates, not audited figures.</p>`)}
        ${C.card({ cls: 'span-5', title: 'At scale', sub: 'Annual value as the fleet grows', action: '' }, `${C.seg(SCALES, N, 'i-scale')}<div class="scale-figs"><div><span class="stat-label">Savings a year</span><strong class="num lime-text">${money(r.perVehicleYear * N, 0)}</strong></div><div><span class="stat-label">CO₂ avoided</span><strong class="num">${fmt.n(co2Year / n0 * N)} t</strong></div><div><span class="stat-label">V2G capacity</span><strong class="num">${N * 11 * 0.6 >= 1000 ? fmt.n(N * 11 * 0.6 / 1000, 1) + ' MW' : fmt.n(N * 11 * 0.6) + ' kW'}</strong></div></div><p class="small muted">${money(r.perVehicleYear, 0)} per vehicle a year from this fleet’s data, scaled linearly; V2G assumes 60% of vehicles parked at the peak.</p>`)}
        ${C.card({ cls: 'span-6', title: 'ESG summary', sub: 'Last 30 days, annualised', action: `<button class="btn small" data-act="i-esg-csv">${icon('download')}Export ESG report</button>` }, `<dl class="kv"><dt>Scope 2 emissions (charging)</dt><dd>${fmt.n(scope2, 1)} t CO₂e a year</dd><dt>Carbon intensity</dt><dd>${fmt.n(gpk)} g CO₂/km vs ${fmt.n(VF.CO2.DIESEL_KG_PER_KM * 1000)} g/km diesel</dd><dt>Renewable share of depot charging</dt><dd>${pct(r.pv.greenPct)} (solar, depot battery and V2G)</dd><dt>Diesel avoided</dt><dd>${fmt.n(m.km * 0.11 * 12)} L a year</dd><dt>Electric share of fleet</dt><dd>100%</dd></dl><p class="small muted">Grid factor ${VF.CO2.GRID_KG_PER_KWH} kg/kWh for Ghana (approximate). Replace with audited factors before external reporting.</p>`)}
        ${C.card({ cls: 'span-6', title: 'Intelligence modules', sub: 'What runs today and what each needs to go live' }, `<ul class="mod-list">${MOD.map(([ic, n, st, tone, need]) => `<li><span class="att-ic ${tone}">${icon(ic)}</span><div><div class="row between"><strong>${n}</strong><span class="badge ${tone}">${st}</span></div><span class="small muted">${need}</span></div></li>`).join('')}</ul>`)}
      </div>`;
  }

  // ================================================================ dashboard strip
  VF.mgr.intelStrip = () => {
    try {
      const p = I.plan(); const h = I.health(); const v = I.v2g(); const ro = I.optimizeRoutes();
      const tiles = [
        ['#m-smart', 'battery-charging', 'Smart charging tonight', `${fmt.n(Math.max(0, p.savingsPct))}% cheaper`, `${money(Math.max(0, p.savings), 0)} saved · ${p.ready}/${p.total} ready`],
        ['#m-health', 'heart-pulse', 'Predictive maintenance', `${h.flagged.length} predicted`, h.flagged[0] ? `${h.flagged[0].v.name}: ${h.flagged[0].c.label.toLowerCase()}` : 'All components healthy'],
        ['#m-routes', 'route', 'Route optimizer', `−${fmt.n(Math.max(0, (1 - ro.km / Math.max(1, ro.base.km)) * 100))}% km`, `${ro.jobs.length} jobs · ${fmt.n(ro.onTime)}% on time`],
        ['#m-v2g', 'arrow-left-right', 'Vehicle-to-grid', money(Math.max(0, v.net), 0), `tonight from ${fmt.kwh(v.out)} sold`],
      ];
      return `<section class="intel-strip" aria-label="Intelligence">${tiles.map(([href, ic, l, big, sub]) => `<a class="intel-tile" href="${href}"><span class="it-ic">${icon(ic)}</span><span class="it-l">${l}</span><strong class="num">${esc(big)}</strong><span class="small muted">${esc(sub)}</span>${icon('arrow-right', 'it-go')}</a>`).join('')}</section>`;
    } catch (e) { console.warn('intel strip', e); return ''; }
  };

  // ================================================================ registration
  const NAV = app.nav; const at = NAV.findIndex((n) => n.id === 'm-energy');
  NAV.splice(at, 0,
    { id: 'm-smart', label: 'Smart Charging', icon: 'battery-charging', title: 'Smart Charging 2.0', group: 'Intelligence' },
    { id: 'm-health', label: 'Predictive Maintenance', icon: 'heart-pulse', title: 'Predictive Maintenance', group: 'Intelligence' },
    { id: 'm-routes', label: 'Route Optimizer', icon: 'brain-circuit', title: 'AI Route Optimizer', group: 'Intelligence' },
    { id: 'm-v2g', label: 'Vehicle-to-Grid', icon: 'arrow-left-right', title: 'Vehicle-to-Grid', group: 'Intelligence' },
    { id: 'm-impact', label: 'Impact & ROI', icon: 'trending-up', title: 'Impact & ROI', group: 'Insights' });
  Object.assign(app.pages, { 'm-smart': pageSmart, 'm-health': pageHealth, 'm-routes': pageRoutes, 'm-v2g': pageV2G, 'm-impact': pageImpact });
  Object.assign(app.charts, { 'i-load': drawLoad, 'i-solar': drawSolar, 'i-trend': drawTrend, 'i-v2g': drawV2G });
  const baseActions = app.actions;
  app.actions = (page) => {
    if (page === 'm-smart') return `<button class="btn primary" data-act="i-apply">${icon('check')}<span class="hide-sm">Apply plan</span></button>`;
    if (page === 'm-routes') { const ro = I.optimizeRoutes(); return I.cfg().routesDispatched !== ro.day && ro.routes.length ? `<button class="btn primary" data-act="i-dispatch">${icon('send')}<span class="hide-sm">${ro.today ? 'Dispatch all' : 'Approve'}</span></button>` : ''; }
    if (['m-health', 'm-v2g', 'm-impact'].includes(page)) return '';
    return baseActions(page);
  };
  const INTEL = ['m-smart', 'm-health', 'm-routes', 'm-v2g', 'm-impact'];
  const prevKey = VF.mgr.extraKey;
  VF.mgr.extraKey = (page) => {
    if (!INTEL.includes(page) && page !== 'm-dashboard') return prevKey(page);
    const c = I.cfg();
    if (page === 'm-dashboard') return prevKey(page) + '|' + Math.floor(VF.now() / HOUR);
    const ev = c.event && !c.event.done ? 'E' : '';
    return [Math.floor(VF.now() / (15 * MIN)), c.strategy, ui.iDepot, JSON.stringify(c.v2g), JSON.stringify(c.factors), c.workOrders.map((w) => w.status[0]).join(''), JSON.stringify(ui.hSel), ui.rSel, ui.iScale, c.routesDispatched, c.applied && c.applied.at, ev, I.wx.src, JSON.stringify(c.depots), JSON.stringify(c.tariff), VF.ops ? F().depots.map((d) => (VF.ops.cfg().grid[d.id].up ? 1 : 0)).join('') + JSON.stringify(Object.values(VF.ops.cfg().jobs).map((j) => j.length)) : ''].join('|');
  };
  const prevLive = VF.mgr.extraLive;
  VF.mgr.extraLive = (page, vals) => {
    if (prevLive) prevLive(page, vals);
    if (page === 'm-v2g') { const l = I.eventLive(); if (l) { vals['i-ev-kw'] = fmt.n(l.kw); vals['i-ev-kwh'] = fmt.kwh(l.e.kwh || 0); vals['i-ev-val'] = money((l.e.kwh || 0) * I.cfg().v2g.exportPrice); } }
  };
  const prevSearch = app.search;
  app.search = (q) => { const out = prevSearch(q); const ql = q.toLowerCase(); for (const n of NAV.filter((x) => INTEL.includes(x.id))) if ((n.title + ' smart queue v2g vpp maintenance predictive route esg roi solar').toLowerCase().includes(ql)) out.push({ icon: n.icon, label: n.title, sub: 'Intelligence', href: '#' + n.id }); return out; };

  // ================================================================ actions
  const re = (fn) => (el) => { fn(el); save(); VF.rerender(); };
  const num = (v, a, b) => { const x = +v; return isFinite(x) && x >= a && x <= b ? x : null; };
  Object.assign(VF.ACT, {
    'i-strategy': re((el) => { I.cfg().strategy = el.dataset.k; }),
    'i-tmode': re((el) => { I.cfg().tariff.mode = el.dataset.k; }),
    'i-depot': (el) => { ui.iDepot = el.dataset.k; VF.rerender(); },
    'i-apply': async () => {
      const p = I.plan(); const ok = await C.confirm({ title: 'Apply tonight’s charging plan?', icon: 'battery-charging', confirmLabel: 'Apply plan',
        body: `${p.total} vehicles charge in Smart Queue order for about ${money(p.cost, 0)} (${fmt.n(Math.max(0, p.savingsPct))}% less than plug-and-charge). ${p.ready}/${p.total} reach their mission target before departure. Drivers just plug in; power is set per charger.` });
      if (!ok) return;
      I.cfg().applied = { at: VF.now(), strategy: p.strategy, cost: p.cost, savings: p.savings, ready: p.ready, total: p.total };
      VF.fleetNotice('info', 'Smart charging plan applied', `${p.total} vehicles scheduled for ${money(p.cost, 0)}, saving about ${money(Math.max(0, p.savings), 0)} tonight.`);
      save(); VF.toast('Charging plan applied'); VF.rerender();
    },
    'i-assets': () => {
      const c = I.cfg(); const d0 = F().depots[0];
      C.modal({ title: 'Depot energy assets', sub: 'Used by the charging optimiser. Values from your electricity bill and site survey.', submitLabel: 'Save', body: `
        ${C.field('Depot', C.select('depot', F().depots.map((d) => [d.id, d.name]), ui.iDepot !== 'all' ? ui.iDepot : d0.id, 'data-chg="i-asset-depot"'))}
        <div class="form-grid-2" id="i-asset-fields">${assetFields(c.depots[ui.iDepot !== 'all' ? ui.iDepot : d0.id])}</div>
        <div class="form-grid-2">${C.field(`Off-peak (${VF.state.settings.currency}/kWh)`, C.input('off', c.tariff.off, 'type="number" step="0.01" min="0" max="20"'))}${C.field('Standard', C.input('std', c.tariff.std, 'type="number" step="0.01" min="0" max="20"'))}${C.field('Peak', C.input('peak', c.tariff.peak, 'type="number" step="0.01" min="0" max="20"'))}${C.field('Demand charge (per kW a month)', C.input('demand', c.tariff.demand, 'type="number" step="1" min="0" max="2000"'))}</div>`,
        onSubmit(d) {
          const f = { gensetKw: num(d.gensetKw, 0, 5000), gridKw: num(d.gridKw, 10, 5000), solarKwp: num(d.solarKwp, 0, 5000), bessKwh: num(d.bessKwh, 0, 10000), bessKw: num(d.bessKw, 0, 5000), ac: num(d.ac, 0, 200), dc: num(d.dc, 0, 50) };
          const tf = { off: num(d.off, 0, 20), std: num(d.std, 0, 20), peak: num(d.peak, 0, 20), demand: num(d.demand, 0, 2000) };
          if (Object.values(f).some((x) => x === null) || Object.values(tf).some((x) => x === null)) return 'Check the numbers: one is missing or out of range.';
          if (f.ac + f.dc < 1) return 'A depot needs at least one charger.';
          Object.assign(c.depots[d.depot], f, { ac: Math.round(f.ac), dc: Math.round(f.dc) }); Object.assign(c.tariff, tf);
          save(); VF.toast('Depot settings saved'); VF.rerender(); return null;
        } });
    },
    'i-hsel': (el) => { ui.hSel = { vid: el.dataset.id, k: el.dataset.k }; VF.rerender(); },
    'i-book': (el) => {
      const v = VF.fleetVehicle(el.dataset.id); const comp = I.COMP.find((x) => x.k === el.dataset.k); const p = I.predict(v, comp); const best = I.serviceSlot(p);
      const days = Array.from({ length: 14 }, (_, i) => VF.startOfDay(VF.now()) + (i + 1) * DAY + 7 * HOUR);
      C.modal({ title: `Schedule service: ${v.name}`, sub: `${comp.label} · ${comp.fix}`, submitLabel: 'Book service', body: `<div class="form-grid-2">${C.field('Day', C.select('day', days.map((ms) => [ms, VF.fmtDayTime(ms) + (VF.startOfDay(ms) === VF.startOfDay(best) ? ' · suggested' : '')]), String(VF.startOfDay(best) + 7 * HOUR)))}${C.field(`Estimate (${VF.state.settings.currency})`, C.input('cost', comp.cost, 'type="number" min="0" step="10"'))}</div>${C.field('Notes for the workshop', `<textarea class="input" name="notes" rows="2" maxlength="200">${esc(`${comp.signal} at ${fmt.n(p.cur, comp.dec)} ${comp.unit}, limit ${fmt.n(comp.limit, comp.dec)} ${comp.unit}. Predicted: ${daysTxt(p)}.`)}</textarea>`)}`,
        onSubmit(d) {
          const c = I.cfg(); const id = 'wo' + (F().seq++);
          c.workOrders.unshift({ id, vehicleId: v.id, comp: comp.k, title: comp.label + ' service', reason: d.notes || '', date: +d.day, cost: +d.cost || comp.cost, status: 'scheduled', created: VF.now() });
          v.maintenance.unshift({ id: 'mr' + id, date: +d.day, type: `${comp.label} service (predicted)`, cost: null, odo: Math.round(v.odo), notes: 'Booked from Predictive Maintenance. ' + (d.notes || ''), planned: true });
          VF.fleetNotice('info', `Service booked: ${v.name}`, `${comp.label} on ${VF.fmtDayTime(+d.day)}. ${comp.fix}`, v.id);
          save(); VF.toast('Service booked'); VF.rerender(); return null;
        } });
    },
    'i-wo-done': re((el) => {
      const c = I.cfg(); const w = c.workOrders.find((x) => x.id === el.dataset.id); if (!w) return; w.status = 'done'; w.doneAt = VF.now();
      c.fixed[w.vehicleId + ':' + w.comp] = VF.now();
      const v = VF.fleetVehicle(w.vehicleId); if (v) { const rec = v.maintenance.find((x) => x.id === 'mr' + w.id); if (rec) { rec.date = VF.now(); rec.cost = w.cost; rec.planned = false; rec.notes = 'Completed. ' + rec.notes; } if (w.comp === 'aux') v.aux12v = 12.7; if (w.comp === 'tyres') v.tyres = [36, 36, 36, 36]; }
      VF.toast('Work order completed');
    }),
    'i-wo-cancel': re((el) => { const c = I.cfg(); const w = c.workOrders.find((x) => x.id === el.dataset.id); if (!w) return; w.status = 'cancelled'; const v = VF.fleetVehicle(w.vehicleId); if (v) v.maintenance = v.maintenance.filter((x) => x.id !== 'mr' + w.id); VF.toast('Work order cancelled'); }),
    'i-rsel': (el) => { ui.rSel = el.dataset.id; VF.rerender(); },
    'i-dispatch': async () => {
      const ro = I.optimizeRoutes(); if (!ro.routes.length) return;
      const ok = await C.confirm({ title: ro.today ? `Dispatch ${ro.routes.length} routes now?` : `Approve ${ro.routes.length} routes for tomorrow?`, icon: 'send', confirmLabel: ro.today ? 'Dispatch all' : 'Approve',
        body: `${ro.jobs.length - ro.unassigned.length} jobs across ${ro.routes.length} vehicles, ${fmt.km(ro.km)} in total. ${ro.today ? 'Current deliveries on these vehicles are replaced and drivers are notified.' : 'Drivers get their stop order in the morning.'}` });
      if (!ok) return;
      if (ro.today) for (const r of ro.routes) { const v = VF.fleetVehicle(r.v.id); if (!v || ['maintenance', 'offline'].includes(v.status)) continue; const p = VF.fleetPos(v); const here = VF.nearestNode(p.lat, p.lon); VF.fleet.dispatch({ vehicleId: v.id, pts: [here].concat(r.stops.map((j) => j.node), [r.home]), km: r.km, kwh: r.kwh, minutes: r.minutes, stop: null }); }
      I.cfg().routesDispatched = ro.day;
      if (VF.ops) for (const r of ro.routes) if (r.v.driverId) VF.ops.send('route_dispatched', { vehicle: r.v.name, stops: r.stops.length, time: t(r.depart) }, 'driver', r.v.driverId);
      VF.fleetNotice('info', ro.today ? 'Optimised routes dispatched' : 'Tomorrow’s routes approved', `${ro.routes.length} vehicles, ${ro.jobs.length - ro.unassigned.length} jobs, ${fmt.km(ro.km)} (${fmt.n(Math.max(0, (1 - ro.km / Math.max(1, ro.base.km)) * 100))}% less than list order).`);
      save(); VF.toast(ro.today ? 'Routes dispatched' : 'Routes approved'); VF.rerender();
    },
    'i-v2g-on': re((el) => { I.cfg().v2g.on = el.dataset.k === 'on'; }),
    'i-v2g-scn': re((el) => { I.cfg().v2g.scenario = el.dataset.k; }),
    'i-v2g-edit': () => {
      const c = I.cfg().v2g;
      C.modal({ title: 'V2G economics', submitLabel: 'Save', body: `<div class="form-grid-2">${C.field(`Export price (${VF.state.settings.currency}/kWh)`, C.input('price', c.exportPrice, 'type="number" step="0.05" min="0" max="20"'))}${C.field('Battery wear (per kWh)', C.input('wear', c.wear, 'type="number" step="0.01" min="0" max="5"'), 'Pack cost ÷ (cycle life × kWh)')}${C.field('Power per vehicle (kW)', C.input('kw', c.maxKw, 'type="number" step="1" min="1" max="150"'))}</div>`,
        onSubmit(d) { const a = num(d.price, 0, 20), b = num(d.wear, 0, 5), k = num(d.kw, 1, 150); if ([a, b, k].includes(null)) return 'Check the numbers.'; Object.assign(c, { exportPrice: a, wear: b, maxKw: k }); save(); VF.toast('Saved'); VF.rerender(); return null; } });
    },
    'i-event': async () => {
      const x = I.v2g(); if (!await C.confirm({ title: 'Simulate a grid event?', icon: 'zap', confirmLabel: 'Start event', body: `For the next 2 hours, up to ${x.enrolled} enrolled vehicles parked at depots export up to ${fmt.kw(x.capKw)} to support the grid. Each stops at ${I.cfg().v2g.floor}%.` })) return;
      I.cfg().event = { start: VF.now(), end: VF.now() + 2 * HOUR, kwh: 0, lastT: VF.now() };
      VF.fleetNotice('warning', 'Grid event started', 'The grid operator asked for support. Parked enrolled vehicles are exporting power for 2 hours.'); save(); VF.toast('Grid event started'); VF.rerender();
    },
    'i-event-stop': re(() => { const e = I.cfg().event; if (e) e.end = VF.now() - 1; }),
    'i-scale': (el) => { ui.iScale = +el.dataset.k; VF.rerender(); },
    'i-esg-csv': () => {
      const r = I.roi(); const m = r.m; const cur = VF.state.settings.currency;
      const rows = [['metric', 'value', 'unit', 'basis'],
        ['distance_30d', m.km.toFixed(0), 'km', 'fleet history'], ['energy_consumed_30d', m.kwh.toFixed(0), 'kWh', 'fleet history'], ['energy_charged_30d', m.charged.toFixed(0), 'kWh', 'charging sessions'],
        ['scope2_emissions_30d', (m.kwh * VF.CO2.GRID_KG_PER_KWH).toFixed(0), 'kg CO2e', `grid factor ${VF.CO2.GRID_KG_PER_KWH} kg/kWh`], ['co2_avoided_30d', (m.co2 * 1000).toFixed(0), 'kg CO2e', `vs diesel ${VF.CO2.DIESEL_KG_PER_KM} kg/km`],
        ['carbon_intensity', m.km ? (m.kwh * VF.CO2.GRID_KG_PER_KWH / m.km * 1000).toFixed(0) : '0', 'g CO2/km', 'charging only'], ['renewable_share_depot_plan', r.pv.greenPct.toFixed(1), '%', 'smart charging plan, next 24 h'],
        ['energy_cost_per_km', r.energyNow.toFixed(3), cur + '/km', 'last 30 days'], ['energy_cost_per_km_optimised', r.energyNext.toFixed(3), cur + '/km', 'estimate'], ['uptime', r.uptimeNow.toFixed(1), '%', 'last 29 days'], ['on_time_deliveries_optimised', r.slaNext.toFixed(1), '%', 'route optimiser'],
        ['fleet_size', VF.simVehicles().length, 'vehicles', 'electric']];
      VF.downloadText(`voltfleet-esg-report-${new Date(VF.now()).toISOString().slice(0, 10)}.csv`, VF.csv(rows)); VF.toast('ESG report downloaded');
    },
  });
  function assetFields(dp) {
    return `${C.field('Grid supply limit (kW)', C.input('gridKw', dp.gridKw, 'type="number" min="10" max="5000" step="5"'))}${C.field('Rooftop solar (kWp)', C.input('solarKwp', dp.solarKwp, 'type="number" min="0" max="5000" step="5"'))}${C.field('Depot battery (kWh)', C.input('bessKwh', dp.bessKwh, 'type="number" min="0" max="10000" step="10"'))}${C.field('Battery power (kW)', C.input('bessKw', dp.bessKw, 'type="number" min="0" max="5000" step="5"'))}${C.field('Backup generator (kW)', C.input('gensetKw', dp.gensetKw || 0, 'type="number" min="0" max="5000" step="5"'))}${C.field(`AC chargers (${dp.acKw} kW)`, C.input('ac', dp.ac, 'type="number" min="0" max="200"'))}${C.field(`DC chargers (${dp.dcKw} kW)`, C.input('dc', dp.dc, 'type="number" min="0" max="50"'))}`;
  }
  Object.assign(VF.CHG, {
    'i-asset-depot': (el) => { const box = document.getElementById('i-asset-fields'); if (box) box.innerHTML = assetFields(I.cfg().depots[el.value]); },
    'i-factor': (el) => { I.cfg().factors[el.dataset.k] = el.checked; save(); VF.rerender(); },
    'i-v2g-floor': (el) => { I.cfg().v2g.floor = +el.value; save(); VF.rerender(); },
    'i-v2g-opt': (el) => { const c = I.cfg().v2g; c.optOut = c.optOut.filter((x) => x !== el.dataset.id); if (!el.checked) c.optOut.push(el.dataset.id); save(); VF.rerender(); },
  });
})();
