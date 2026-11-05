/* VoltFleet OS — EV Manager v3 pages: Control Tower, Driver Scorecards, Electrification Planner, Fleet Finance,
   Alerts & Messaging. They read js/ops.js and js/intel.js and register on VF.apps.manager. */
'use strict';
(function () {
  const { esc, sum, fmt, icon, clamp } = VF;
  const C = VF.c; const O = VF.ops; const I = VF.intel;
  const MIN = VF.MIN, HOUR = VF.HOUR, DAY = VF.DAY;
  const app = VF.apps.manager;
  const ui = Object.assign(VF.mgr.ui, { drSel: null, finTab: 'attribution', tplType: 'low_battery', obCh: 'all' });
  const F = () => VF.state.fleet;
  const money = (x, d) => fmt.money(x, d);
  const t = (ms) => VF.fmtTime(ms);
  const pct = (x, d) => fmt.n(x, d || 0) + '%';
  const save = () => { if (I) I.invalidate(); VF.save(); };
  const AUR = '<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>';
  const SAMPLE = 'Sample data until meters, telematics and business systems are connected.';

  // ================================================================ Control Tower
  function depotPanel(d) {
    const n = O.depotNow(d.id); const dep = n.dp ? n.dp.dep : I.cfg().depots[d.id]; const s = n.s || {}; const g = n.g; const risk = O.nextRisk(d.id, 12);
    const src = [
      ['Grid', g.up ? `${fmt.kw(s.import || 0)}` : 'Down', g.up ? 'ok' : 'bad', 'zap'],
      ['Solar', dep.solarKwp ? fmt.kw(s.solar || 0) : '—', dep.solarKwp ? 'lime' : 'muted', 'solar-panel'],
      ['Battery', dep.bessKwh ? `${n.bessPct}%` : '—', dep.bessKwh ? (g.up ? 'teal' : 'warn') : 'muted', 'battery-full'],
      ['Generator', dep.gensetKw ? (g.up ? 'Standby' : `${fmt.kw(Math.min(dep.gensetKw, s.ev || 0))}`) : '—', dep.gensetKw ? (g.up ? 'muted' : 'warn') : 'muted', 'fuel'],
    ];
    return C.card({ cls: 'span-6 depot-card' + (g.up ? '' : ' down'), title: esc(d.name), sub: g.up ? `Grid up · ${Math.round(g.v)} V · ${fmt.n(O.reliability(d.id), 1)}% available, 30 days` : `Outage since ${t(g.since)} · back about ${t(g.until)}`, action: g.up ? `<button class="btn small" data-act="o-outage" data-id="${d.id}">${icon('zap')}Simulate outage</button>` : `<button class="btn small" data-act="o-restore" data-id="${d.id}">${icon('rotate-ccw')}Restore power</button>` },
      `<div class="pflow">${src.map(([l, v, tone, ic]) => `<div class="pf-src ${tone}"><span class="pf-ic">${icon(ic)}</span><span class="small muted">${l}</span><strong class="num">${v}</strong></div>`).join('')}<div class="pf-arrow" aria-hidden="true"><i></i></div><div class="pf-src sink"><span class="pf-ic">${icon('plug-zap')}</span><span class="small muted">Chargers</span><strong class="num">${fmt.kw(s.ev || 0)}</strong><span class="small muted">${(s.acUsed || 0) + (s.dcUsed || 0)}/${dep.ac + dep.dc} in use · ${n.queue} queued</span></div></div>
      <div class="risk-bar" title="Outage likelihood, next 12 hours">${Array.from({ length: 12 }, (_, i) => { const ms = VF.now() + i * HOUR; const p = O.outageP(d.id, ms); return `<i style="--p:${clamp(p * 6, 0.06, 1).toFixed(2)}" title="${t(ms)} · ${pct(p * 100)}"></i>`; }).join('')}</div>
      <p class="small muted">${g.up ? `Highest outage risk in the next 12 h: <strong>${t(risk.ms)}</strong> (${pct(risk.p * 100)}). Smart charging front-loads energy before risky hours.` : 'Backup supplies vehicles in Smart Queue order; the rest charge when power returns.'}</p>`);
  }
  function pageTower() {
    const f = F(); const ex = O.exceptions(); const p = I.plan(); const vs = f.vehicles;
    const road = vs.filter((v) => v.status === 'in_use').length; const chg = VF.fleetLiveSessions(); const kw = sum(chg, (x) => x.se.kw);
    const ice = O.cfg().ice.length; const ev = vs.length; const ob = O.cfg().outbox.slice(0, 5);
    const online = navigator.onLine !== false; const cloud = VF.cloud ? VF.cloud.status : 'local';
    const ro = I.optimizeRoutes();
    return `${AUR}<div class="tower-strip">
        ${f.depots.map((d) => { const g = O.cfg().grid[d.id]; return `<span class="tw-pill ${g.up ? 'ok' : 'bad'}"><i></i>${esc(d.name.split(',')[0])} · ${g.up ? `grid ${Math.round(g.v)} V` : 'outage'}</span>`; }).join('')}
        <span class="tw-pill ${online ? 'ok' : 'warn'}"><i></i>${online ? (/live/.test(cloud) ? 'Online · synced' : 'Online') : 'Offline · saving on device'}</span>
        ${VF.lite.get() ? '<span class="tw-pill teal"><i></i>Low-data mode</span>' : ''}
        <span class="tw-pill muted">${icon('cloud-sun')}${esc(I.weatherSource())}</span></div>
      <section class="stat-grid kpi-grid tower-kpis">
        ${C.stat({ icon: 'route', label: 'On the road', value: road, unit: `/ ${vs.length}`, hint: `${ro.routes.length} optimised routes · ${pct(ro.onTime)} on time` })}
        ${C.stat({ icon: 'plug-zap', label: 'Charging now', value: fmt.n(kw), unit: 'kW', hint: `${chg.length} vehicle${chg.length === 1 ? '' : 's'} on public chargers` })}
        ${C.stat({ icon: 'triangle-alert', label: 'Needs a decision', value: ex.length, hint: ex.length ? esc(ex[0].title) : 'nothing waiting', tone: ex.some((x) => x.sev >= 3) ? 'warn' : '' })}
        ${C.stat({ icon: 'target', label: 'Ready for tomorrow', value: `${p.proof}/${p.total}`, hint: 'even if the grid fails at its usual times', tone: p.proof === p.total ? 'lime' : '' })}
      </section>
      <div class="dash">
        ${C.card({ cls: 'span-8', title: 'Live fleet', sub: 'Vehicles and public chargers' }, `<div class="map-wrap">${VF.mgr.fleetMap('t-map')}</div>${VF.mgr.mapNote()}`)}
        ${C.card({ cls: 'span-4 flush tower-ex', title: 'Needs a decision', sub: 'Most urgent first', action: ex.length ? `<span class="badge ${ex.some((x) => x.sev >= 3) ? 'bad' : 'warn'}">${ex.length}</span>` : '' }, ex.length ? `<ul class="ex-list">${ex.slice(0, 9).map((x) => `<li class="sev${x.sev}"><span class="att-ic ${x.tone}">${icon(x.icon)}</span><div><strong>${esc(x.title)}</strong><span class="small muted">${esc(x.sub)}</span></div>${x.href ? `<a class="btn small" href="${x.href}">${esc(x.label)}</a>` : `<button class="btn small" data-act="${x.act}" data-id="${x.id}">${esc(x.label)}</button>`}</li>`).join('')}</ul>` : C.empty({ icon: 'circle-check', title: 'All clear', text: 'Nothing needs a decision right now.' }))}
        ${f.depots.map(depotPanel).join('')}
        ${C.card({ cls: 'span-6', title: 'Mixed fleet', sub: 'Electric and fuel vehicles in one view', action: `<a class="btn small ghost" href="#m-electrify">Plan the switch ${icon('arrow-right')}</a>` }, `<div class="mix-bar"><i class="ev" style="width:${(ev / (ev + ice) * 100).toFixed(1)}%"></i><i class="ice" style="width:${(ice / (ev + ice) * 100).toFixed(1)}%"></i></div>${C.legend([[`Electric · ${ev}`, 'teal'], [`Diesel & petrol · ${ice}`, 'muted']])}<p class="small muted">${pct(ev / (ev + ice) * 100)} electric. Switching the next ${Math.min(3, ice)} vehicles on the planner saves about ${money(sum(O.electrify().rows.slice(0, 3), (r) => Math.max(0, r.save)), 0)} a year.</p>`)}
        ${C.card({ cls: 'span-6 flush', title: 'Messages sent', sub: 'SMS and WhatsApp, in each driver’s language', action: `<a class="btn small ghost" href="#m-alerts">All messages ${icon('arrow-right')}</a>` }, ob.length ? `<ul class="ob-mini">${ob.map((m) => `<li><span class="badge ${m.ch === 'wa' ? 'ok' : 'teal'}">${m.ch === 'wa' ? 'WhatsApp' : 'SMS'}</span><div><strong>${esc(m.who)}</strong> <span class="small muted">${t(m.t)} · ${esc(O.LANGS[m.lang])}</span><span class="small">${esc(m.text)}</span></div></li>`).join('')}</ul>` : C.empty({ icon: 'mail', title: 'No messages yet', text: 'Alerts to drivers and managers appear here.' }))}
      </div>`;
  }

  // ================================================================ Driver scorecards
  const SUBL = { eff: 'Efficiency', harsh: 'Smooth braking', speed: 'Speed', regen: 'Regeneration', idle: 'Idling', charge: 'Charging habits' };
  function pageDrivers() {
    const rows = O.scorecards(); const sel = rows.find((r) => r.d.id === ui.drSel) || rows[0]; if (sel) ui.drSel = sel.d.id;
    const avg = rows.length ? sum(rows, (r) => r.eco) / rows.length : 0; const best = rows.slice().sort((a, b) => b.change - a.change)[0];
    const waste = sum(rows, (r) => r.wastedCost);
    return `${AUR}<section class="stat-grid kpi-grid">
        ${C.stat({ icon: 'gauge', label: 'Fleet eco-score', value: fmt.n(avg), unit: '/100', hint: `${rows.length} drivers · this week` })}
        ${C.stat({ icon: 'trending-up', label: 'Most improved', value: best ? esc(best.d.name.split(' ')[0]) : '—', hint: best ? `${best.change >= 0 ? '+' : ''}${best.change} points this week` : '' })}
        ${C.stat({ icon: 'coins', label: 'Energy lost to driving style', value: money(waste, 0), hint: 'a month, vs each model’s rated efficiency', tone: 'warn' })}
        ${C.stat({ icon: 'shield-check', label: 'Privacy', value: 'No GPS trails', hint: 'scores use trip summaries only' })}
      </section>
      <div class="dash">
        ${C.card({ cls: 'span-8 flush', title: 'Leaderboard', sub: 'Eco-score combines efficiency, braking, speed, regeneration, idling and charging habits', action: `<button class="btn small" data-act="o-sc-all">${icon('send')}Send to all drivers</button>` }, C.table([
          { label: '#', render: (r) => `<span class="sq-rank">${rows.indexOf(r) + 1}</span>` },
          { label: 'Driver', render: (r) => `<strong>${esc(r.d.name)}</strong><div class="small muted">${esc(r.v ? r.v.name : 'No vehicle')}</div>` },
          { label: 'Eco-score', render: (r) => `<div class="score"><div class="progress sm"><i class="${r.eco >= 80 ? 'ok' : r.eco >= 60 ? '' : 'warn'}" style="width:${r.eco}%"></i></div><span class="num"><strong>${r.eco}</strong></span></div>` },
          { label: 'Week', align: 'r', render: (r) => `<span class="${r.change >= 0 ? 'text-ok' : 'text-warn'}">${r.change >= 0 ? '+' : ''}${r.change}</span>` },
          { label: 'vs rated', align: 'r', render: (r) => `${r.cur.m.eff >= 1 ? '+' : '−'}${fmt.n(Math.abs(r.cur.m.eff - 1) * 100)}%` },
          { label: 'Harsh /100 km', align: 'r', render: (r) => fmt.n(r.cur.m.harsh, 1) },
          { label: 'Regen', align: 'r', render: (r) => pct(r.cur.m.regen) },
          { label: 'Focus on', render: (r) => `<span class="badge muted">${SUBL[r.weakest]}</span>` },
        ], rows.map((r) => Object.assign(r, { id: r.d.id })), { rowAct: 'o-dr-sel' }))}
        ${sel ? C.card({ cls: 'span-4', title: esc(sel.d.name), sub: `${esc(sel.v ? `${sel.v.name} · ${sel.v.model}` : 'No vehicle')} · writes in ${esc(O.LANGS[O.langOf(sel.d.id)])}` }, `<div class="big-metric"><span>${sel.eco}</span><small>eco-score · ${sel.change >= 0 ? '+' : ''}${sel.change} vs last week</small></div>
          ${C.spark(sel.weeks.map((w) => w.eco), 'teal')}
          ${C.hbars(Object.entries(sel.cur.sub).map(([k, v]) => ({ label: SUBL[k], value: v, text: fmt.n(v), tone: v < 50 ? 'warn' : v < 75 ? 'teal' : 'mint' })))}
          ${C.banner('teal', 'lightbulb', `<strong>Coaching tip:</strong> ${esc(sel.tip)}${sel.wastedCost > 5 ? ` Worth about ${money(sel.wastedCost, 0)} a month.` : ''}`)}
          <button class="btn primary" data-act="o-sc-send" data-id="${sel.d.id}">${icon('send')}Send scorecard on WhatsApp</button>`) : ''}
        ${C.card({ cls: 'span-12', title: 'Fair and private by design' }, `<ul class="why"><li>${icon('shield-check')}<span>Scores come from trip summaries (energy, braking and speed events). Location trails are never stored or shown.</span></li><li>${icon('users')}<span>Drivers get their own scorecard in their language every week. Scores support coaching; they are not used on their own for pay or disciplinary decisions.</span></li><li>${icon('gauge')}<span>Efficiency is compared with each model’s rating, so van drivers aren’t ranked against small-car drivers on raw kWh.</span></li></ul><p class="small muted">${SAMPLE}</p>`)}
      </div>`;
  }

  // ================================================================ Electrification planner (mixed EV + ICE fleet)
  const CLS = { van: 'Van', car: 'Car', pickup: 'Pickup', moto: 'Motorbike' };
  function pageElectrify() {
    const e = O.electrify(); const c = O.cfg(); const plan = c.plan.map((p) => e.rows.find((r) => r.x.id === p.iceId)).filter(Boolean);
    const avgPay = e.rows.filter((r) => isFinite(r.payback)); const yearQ = (i) => { const d = new Date(VF.now()); const q = Math.floor(d.getUTCMonth() / 3) + 1 + Math.floor(i / 2) + 1; return `Q${((q - 1) % 4) + 1} ${d.getUTCFullYear() + Math.floor((q - 1) / 4)}`; };
    return `${AUR}<section class="stat-grid kpi-grid">
        ${C.stat({ icon: 'fuel', label: 'Fuel vehicles', value: c.ice.length, unit: `/ ${c.ice.length + F().vehicles.length}`, hint: `${pct(F().vehicles.length / (c.ice.length + F().vehicles.length) * 100)} of the fleet is already electric` })}
        ${C.stat({ icon: 'coins', label: 'Saved a year if all switch', value: money(Math.max(0, e.total.save), 0), hint: `energy at ${money(e.smartPrice)}/kWh with smart charging`, tone: 'lime' })}
        ${C.stat({ icon: 'leaf', label: 'CO₂ avoided a year', value: fmt.n(e.total.co2, 1), unit: 't', hint: 'tailpipe minus grid emissions' })}
        ${C.stat({ icon: 'timer', label: 'Typical payback', value: avgPay.length ? fmt.n(avgPay.reduce((a, r) => a + r.payback, 0) / avgPay.length, 1) : '—', unit: 'years', hint: 'price premium ÷ yearly savings' })}
      </section>
      <div class="dash">
        ${C.card({ cls: 'span-12 flush', title: 'What to electrify next', sub: 'Ranked by payback (older vehicles first when close), checking the daily distance fits the replacement’s range' }, C.table([
          { label: 'Vehicle', render: (r) => `<strong>${esc(r.x.name)}</strong><div class="small muted">${esc(r.x.model)} · ${r.x.age} yrs</div>` },
          { label: 'Daily km', align: 'r', render: (r) => fmt.n(r.x.kmDay) },
          { label: 'Fuel + upkeep a year', align: 'r', render: (r) => money(r.iceYear, 0) },
          { label: 'Electric replacement', render: (r) => `${esc(r.ev.model)}<div class="small muted">${r.ev.swap ? 'battery swap network' : `${fmt.km(r.range)} range · ${fmt.kwh(r.nightKwh)} a night`}</div>` },
          { label: 'Energy + upkeep', align: 'r', render: (r) => money(r.evYear, 0) },
          { label: 'Saves a year', align: 'r', render: (r) => `<strong class="${r.save > 0 ? 'text-ok' : 'text-warn'}">${money(r.save, 0)}</strong>` },
          { label: 'Payback', align: 'r', render: (r) => (isFinite(r.payback) ? fmt.n(r.payback, 1) + ' yrs' : '—') },
          { label: 'Fits the job', render: (r) => (r.fits ? C.badge('completed', 'Yes') : C.badge('warning', 'Needs a midday charge')) },
          { label: '', align: 'r', render: (r) => (r.inPlan ? `<button class="btn small ghost" data-act="o-plan-del" data-id="${r.x.id}">Remove</button>` : `<button class="btn small" data-act="o-plan-add" data-id="${r.x.id}">${icon('plus')}Add to plan</button>`) },
        ], e.rows))}
        ${C.card({ cls: 'span-7', title: 'Transition plan', sub: 'Two vehicles a quarter keeps depot charging inside today’s grid supply' }, plan.length ? `<ol class="legs">${plan.map((r, i) => `<li><span class="leg-dot"></span><div><strong>${yearQ(i)} · ${esc(r.x.name)} → ${esc(r.ev.model)}</strong><span class="small muted">saves ${money(r.save, 0)} a year · ${fmt.n(r.co2, 1)} t CO₂ · adds ${fmt.kwh(r.nightKwh)} to ${esc((F().depots.find((d) => d.id === r.x.depot) || {}).name || r.x.depot)} each night (headroom ${fmt.kwh(e.head[r.x.depot] || 0)})</span></div></li>`).join('')}</ol><div class="cmp-figs"><div><span class="stat-label">Yearly savings when done</span><strong class="num lime-text">${money(sum(plan, (r) => r.save), 0)}</strong></div><div><span class="stat-label">Up-front premium</span><strong class="num">${money(sum(plan, (r) => r.premium), 0)}</strong></div><div><span class="stat-label">CO₂ avoided</span><strong class="num">${fmt.n(sum(plan, (r) => r.co2), 1)} t/yr</strong></div></div>` : C.empty({ icon: 'calendar', title: 'No vehicles in the plan yet', text: 'Add vehicles from the table above.' }))}
        ${C.card({ cls: 'span-5', title: 'How the numbers work' }, `<ul class="why"><li>${icon('fuel')}<span>Fuel at ${money(c.assume.diesel)}/L diesel and ${money(c.assume.petrol)}/L petrol, 300 working days a year.</span></li><li>${icon('battery-charging')}<span>Electricity at the smart-charging plan’s effective price, ${money(e.smartPrice)}/kWh, including charging losses.</span></li><li>${icon('wrench')}<span>Electric upkeep 40–60% of fuel vehicles (no oil, fewer brakes and parts).</span></li><li>${icon('coins')}<span>Price premium per class with import duty at ${fmt.n(c.assume.duty)}%. Check current GRA duty and VAT rules for EVs before buying.</span></li><li>${icon('cpu')}<span>Courier motorbikes switch to a battery-swap network instead of depot charging.</span></li></ul><p class="small muted">${SAMPLE}</p>`)}
      </div>`;
  }

  // ================================================================ Fleet finance
  function pageFinance() {
    const tab = ui.finTab;
    const seg = C.seg([['attribution', 'Cost by client', 'receipt'], ['battery', 'Battery & depreciation', 'battery-full'], ['home', 'Home charging', 'house']], tab, 'o-fin-tab');
    let body = '';
    if (tab === 'attribution') {
      const a = O.attribution(); const top = a.rows[0];
      body = `<section class="stat-grid kpi-grid">${C.stat({ icon: 'coins', label: 'Energy cost, 30 days', value: money(a.total, 0), hint: `${sum(a.rows, (r) => r.jobs)} jobs` })}${C.stat({ icon: 'receipt', label: 'Average per job', value: money(a.total / Math.max(1, sum(a.rows, (r) => r.jobs))), hint: `at ${money(a.price)}/kWh` })}${C.stat({ icon: 'package', label: 'Per tonne delivered', value: money(a.total / Math.max(0.001, sum(a.rows, (r) => r.kg) / 1000), 0) })}${C.stat({ icon: 'target', label: 'Largest client', value: top ? esc(top.client) : '—', hint: top ? `${pct(top.cost / a.total * 100)} of energy cost` : '' })}</section>
        <div class="dash">${C.card({ cls: 'span-8 flush', title: 'Energy cost by client', sub: 'Each job’s share of route energy, at the price actually paid', action: `<button class="btn small" data-act="o-attr-csv">${icon('download')}Export for invoicing</button>` }, C.table([
          { label: 'Client / job type', render: (r) => `<strong>${esc(r.client)}</strong>` }, { label: 'Jobs', align: 'r', key: 'jobs' },
          { label: 'Delivered', align: 'r', render: (r) => fmt.n(r.kg / 1000, 1) + ' t' }, { label: 'Distance', align: 'r', render: (r) => fmt.km(r.km) },
          { label: 'Energy', align: 'r', render: (r) => fmt.kwh(r.kwh) }, { label: 'Cost', align: 'r', render: (r) => `<strong>${money(r.cost, 0)}</strong>` },
          { label: 'Per job', align: 'r', render: (r) => money(r.perJob) }, { label: 'Per tonne', align: 'r', render: (r) => money(r.perTonne, 0) },
        ], a.rows))}${C.card({ cls: 'span-4', title: 'Share of energy cost' }, C.hbars(a.rows.map((r) => ({ label: r.client, value: r.cost, text: pct(r.cost / a.total * 100) })), { tone: 'teal' }) + `<p class="small muted">Use these to price energy into delivery contracts. ${SAMPLE}</p>`)}</div>`;
    } else if (tab === 'battery') {
      const l = O.lifecycle(); const book = sum(l, (x) => x.book), batt = sum(l, (x) => x.battVal), depr = sum(l, (x) => x.deprYear);
      body = `<section class="stat-grid kpi-grid">${C.stat({ icon: 'wallet', label: 'Fleet book value', value: money(book, 0), hint: 'straight line over 8 years to 25%' })}${C.stat({ icon: 'trending-down', label: 'Depreciation a year', value: money(depr, 0) })}${C.stat({ icon: 'battery-full', label: 'Battery value', value: money(batt, 0), hint: 'replacement cost × health' })}${C.stat({ icon: 'heart-pulse', label: 'Average health', value: pct(sum(l, (x) => x.v.soh) / Math.max(1, l.length), 1), hint: `${fmt.n(sum(l, (x) => x.rate) / Math.max(1, l.length), 1)}% lost a year` })}</section>
        <div class="dash">${C.card({ cls: 'span-12 flush', title: 'Battery lifecycle', sub: 'Degradation, warranty and value per vehicle' }, C.table([
          { label: 'Vehicle', render: (x) => `<strong>${esc(x.v.name)}</strong><div class="small muted">${esc(x.v.model)} · ${x.v.year}</div>` },
          { label: 'Health', align: 'r', render: (x) => `<span class="${x.v.soh < 85 ? 'text-warn' : ''}">${x.v.soh}%</span>` },
          { label: 'Loss a year', align: 'r', render: (x) => pct(x.rate, 1) },
          { label: 'Reaches 80% in', align: 'r', render: (x) => (x.yrs80 > 15 ? '15+ yrs' : fmt.n(x.yrs80, 1) + ' yrs') },
          { label: 'Full cycles', align: 'r', render: (x) => fmt.n(x.cycles) },
          { label: 'Warranty left', align: 'r', render: (x) => (x.warrLeft <= 0 ? C.badge('warning', 'Expired') : fmt.n(x.warrLeft, 1) + ' yrs') },
          { label: 'Book value', align: 'r', render: (x) => money(x.book, 0) },
          { label: 'Battery value', align: 'r', render: (x) => money(x.battVal, 0) },
        ], l.map((x) => Object.assign(x, { id: x.v.id })), { rowAct: 'm-open-vehicle' }))}<p class="span-12 small muted">Typical battery warranty 8 years or 160,000 km to 70% health; check each OEM’s terms. Purchase prices, pack replacement cost (${money(1650)}/kWh) and depreciation are estimates.</p></div>`;
    } else {
      const h = O.home(); const c = O.cfg(); const due = h.filter((x) => !x.paid);
      body = `<section class="stat-grid kpi-grid">${C.stat({ icon: 'house', label: 'Home sessions this month', value: sum(h, (x) => x.sessions), hint: `${h.length} drivers take a vehicle home` })}${C.stat({ icon: 'zap', label: 'Energy at home', value: fmt.n(sum(h, (x) => x.kwh)), unit: 'kWh' })}${C.stat({ icon: 'wallet', label: 'To reimburse', value: money(sum(due, (x) => x.amount), 0), hint: `at ${money(c.assume.homeRate)}/kWh (ECG residential)` })}${C.stat({ icon: 'smartphone', label: 'Paid by', value: 'Mobile Money', hint: 'MTN MoMo · Telecel Cash · AT Money' })}</section>
        <div class="dash">${C.card({ cls: 'span-12 flush', title: 'Home charging reimbursement', sub: 'Measured by the vehicle, paid to the driver’s wallet. Home addresses are never stored.', action: due.length ? `<button class="btn primary" data-act="o-pay">${icon('send')}Pay ${due.length} drivers</button>` : '' }, C.table([
          { label: 'Driver', render: (x) => `<strong>${esc(x.d.name)}</strong><div class="small muted">${esc(x.v.name)}</div>` },
          { label: 'Sessions', align: 'r', key: 'sessions' }, { label: 'Energy', align: 'r', render: (x) => fmt.kwh(x.kwh) },
          { label: 'Amount', align: 'r', render: (x) => `<strong>${money(x.amount)}</strong>` },
          { label: 'Wallet', render: (x) => `${esc(x.wallet)}<div class="small muted mono">${esc(x.to)}</div>` },
          { label: 'Status', render: (x) => (x.paid ? C.badge('completed', `Paid · ${x.paid.ref}`) : C.badge('scheduled', 'Due')) },
        ], h))}<p class="span-12 small muted">Payouts are simulated: connect a licensed payment provider (for example a Mobile Money aggregator) on the server before real payments. ${SAMPLE}</p></div>`;
    }
    return `${AUR}<div class="toolbar">${seg}</div>${body}`;
  }

  // ================================================================ Alerts & messaging
  function pageAlerts() {
    const c = O.cfg(); const day = c.outbox.filter((m) => m.t > VF.now() - DAY); const langs = new Set(F().drivers.map((d) => O.langOf(d.id)));
    const tpl = ui.tplType; const box = c.outbox.filter((m) => ui.obCh === 'all' || m.ch === ui.obCh).slice(0, 40);
    return `${AUR}<section class="stat-grid kpi-grid">
        ${C.stat({ icon: 'mail', label: 'Messages, 24 h', value: day.length, hint: `${day.filter((m) => m.ch === 'sms').length} SMS · ${day.filter((m) => m.ch === 'wa').length} WhatsApp` })}
        ${C.stat({ icon: 'smartphone', label: 'SMS segments', value: sum(day.filter((m) => m.ch === 'sms'), (m) => m.segs), hint: 'Twi uses ɛ and ɔ, so 70 characters per SMS' })}
        ${C.stat({ icon: 'coins', label: 'Estimated cost, 24 h', value: money(sum(day, (m) => m.cost)), hint: `about ${VF.state.settings.currency} ${fmt.n(0.035, 3)} per SMS segment` })}
        ${C.stat({ icon: 'globe', label: 'Driver languages', value: langs.size, hint: [...langs].map((l) => O.LANGS[l]).join(' · ') })}
      </section>
      ${C.banner('teal', 'info', '<strong>Simulated delivery.</strong> Messages are composed and logged here but not sent. To send for real, add an SMS provider (for example Hubtel, mNotify or Arkesel in Ghana, Africa’s Talking across Africa) and the WhatsApp Business Platform on the server; API keys stay in server secrets, never in this app.')}
      <div class="dash">
        ${C.card({ cls: 'span-7 flush', title: 'Who gets what', sub: 'In-app alerts always go to managers. Choose extra channels per alert.', action: `<label class="check"><input type="checkbox" data-chg="o-quiet" ${c.quiet.on ? 'checked' : ''}>Quiet hours ${c.quiet.from}:00–0${c.quiet.to}:00 (urgent alerts still go)</label>` }, C.table([
          { label: 'Alert', render: (r) => `<strong>${O.RULE_LABEL[r.k]}</strong>${r.crit ? ' <span class="badge bad">Urgent</span>' : ''}` },
          { label: 'To', render: (r) => (r.to === 'driver' ? 'Driver' : 'Manager') },
          { label: 'SMS', render: (r) => `<input type="checkbox" data-chg="o-rule" data-k="${r.k}" data-ch="sms" ${r.sms ? 'checked' : ''} aria-label="SMS for ${O.RULE_LABEL[r.k]}">` },
          { label: 'WhatsApp', render: (r) => `<input type="checkbox" data-chg="o-rule" data-k="${r.k}" data-ch="wa" ${r.wa ? 'checked' : ''} aria-label="WhatsApp for ${O.RULE_LABEL[r.k]}">` },
        ], Object.entries(c.rules).map(([k, r]) => Object.assign({ k }, r))))}
        ${C.card({ cls: 'span-5', title: 'Message preview', sub: 'The same alert in each driver language', action: C.select('tpl', Object.keys(O.TEMPLATES).filter((k) => O.TEMPLATES[k].tw).map((k) => [k, O.RULE_LABEL[k]]), tpl, 'data-chg="o-tpl" aria-label="Alert"') }, `<ul class="tpl-list">${O.READY_LANGS.map((l) => { const txt = O.render(tpl, l, { vehicle: 'Van 03', soc: 14, station: 'Spintex Charge Hub', stops: 6, time: '07:30', amount: money(84.2), wallet: 'MTN MoMo', score: 82, change: '+4', tip: 'brake early.' }); const sg = O.segments(txt); return `<li><div class="row between"><strong>${O.LANGS[l]}</strong><span class="small muted">${sg.n} chars · ${sg.segs} SMS${sg.ucs ? ' · Unicode' : ''}</span></div><span>${esc(txt)}</span></li>`; }).join('')}</ul><p class="small muted">Twi and Hausa texts are drafts: have native speakers review them before launch. Ewe and Ga fall back to English until translated.</p>`)}
        ${C.card({ cls: 'span-12 flush', title: 'Driver languages', sub: 'Drivers receive SMS and WhatsApp alerts in the language they choose' }, C.table([
          { label: 'Driver', render: (d) => `<strong>${esc(d.name)}</strong>` },
          { label: 'Phone', render: (d) => `<span class="mono small">${esc(String(d.phone).replace(/(\d{2})\s?\d{3}\s?(\d{4})$/, '$1 *** $2'))}</span>` },
          { label: 'Language', render: (d) => C.select('lang-' + d.id, Object.entries(O.LANGS).map(([k, l]) => [k, l + (O.READY_LANGS.includes(k) ? '' : ' (English until translated)')]), O.langOf(d.id), `data-chg="o-lang" data-id="${d.id}" aria-label="Language for ${esc(d.name)}"`) },
        ], F().drivers.map((d) => Object.assign({}, d))))}
        ${C.card({ cls: 'span-12 flush', title: 'Outbox', sub: 'Every message, newest first. Phone numbers are masked.', action: C.seg([['all', 'All'], ['sms', 'SMS'], ['wa', 'WhatsApp']], ui.obCh, 'o-ob-ch') }, C.table([
          { label: 'Time', render: (m) => `<span class="num">${VF.fmtDayTime(m.t)}</span>` },
          { label: 'Channel', render: (m) => `<span class="badge ${m.ch === 'wa' ? 'ok' : 'teal'}">${m.ch === 'wa' ? 'WhatsApp' : 'SMS'}</span>` },
          { label: 'To', render: (m) => `${esc(m.who)}<div class="small muted">${esc(m.role)} · <span class="mono">${esc(m.to)}</span></div>` },
          { label: 'Message', render: (m) => `<span class="small">${esc(m.text)}</span><div class="small muted">${esc(O.LANGS[m.lang])}${m.ch === 'sms' ? ` · ${m.segs} SMS` : ''}</div>` },
          { label: 'Status', render: (m) => (m.status === 'queued' ? C.badge('scheduled', 'Quiet hours') : C.badge('completed', 'Simulated')) },
        ], box, { empty: { icon: 'mail', title: 'No messages yet', text: 'They appear as alerts happen: low batteries, outages, dispatched routes, payouts.' } }))}
      </div>`;
  }

  // ================================================================ registration
  const NAV = app.nav;
  const ins = (afterId, item) => { const i = NAV.findIndex((n) => n.id === afterId); NAV.splice(i + 1, 0, item); };
  ins('m-dashboard', { id: 'm-tower', label: 'Control Tower', icon: 'radio-tower', title: 'Control Tower', group: 'Overview' });
  ins('m-fleet', { id: 'm-drivers', label: 'Driver Scorecards', icon: 'gauge', title: 'Driver Scorecards', group: 'Operations' });
  ins('m-impact', { id: 'm-electrify', label: 'Electrification Planner', icon: 'fuel', title: 'Electrification Planner', group: 'Insights' });
  ins('m-electrify', { id: 'm-finance', label: 'Fleet Finance', icon: 'wallet', title: 'Fleet Finance', group: 'Insights' });
  ins('m-notifications', { id: 'm-alerts', label: 'Alerts & Messaging', icon: 'mail', title: 'Alerts & Messaging', group: 'Account' });
  Object.assign(app.pages, { 'm-tower': pageTower, 'm-drivers': pageDrivers, 'm-electrify': pageElectrify, 'm-finance': pageFinance, 'm-alerts': pageAlerts });
  const OPS = ['m-tower', 'm-drivers', 'm-electrify', 'm-finance', 'm-alerts'];
  const baseActions = app.actions;
  app.actions = (page) => (OPS.includes(page) ? (page === 'm-electrify' ? `<button class="btn" data-act="o-assume">${icon('sliders')}<span class="hide-sm">Assumptions</span></button>` : '') : baseActions(page));
  const prevKey = VF.mgr.extraKey;
  VF.mgr.extraKey = (page) => {
    if (!OPS.includes(page)) return prevKey(page);
    const c = O.cfg(); const g = F().depots.map((d) => (c.grid[d.id].up ? 1 : 0) + (c.grid[d.id].v < 207 ? 'v' : '')).join('');
    return [Math.floor(VF.now() / (15 * MIN)), g, c.outbox.length, c.plan.length, JSON.stringify(c.rules), JSON.stringify(c.lang), JSON.stringify(c.assume), Object.keys(c.payouts).length, ui.drSel, ui.finTab, ui.tplType, ui.obCh, c.quiet.on, VF.lite.get(), page === 'm-tower' ? O.exceptions().map((x) => x.title).join() : ''].join('|');
  };
  const prevLive = VF.mgr.extraLive;
  VF.mgr.extraLive = (page, vals) => { if (prevLive) prevLive(page, vals); if (page === 'm-tower') VF.mgr.liveMap('t-map'); };

  // ================================================================ actions
  const re = (fn) => (el) => { fn(el); save(); VF.rerender(); };
  const num = (v, a, b) => { const x = +v; return isFinite(x) && x >= a && x <= b ? x : null; };
  Object.assign(VF.ACT, {
    'o-outage': async (el) => { const d = F().depots.find((x) => x.id === el.dataset.id); if (!await C.confirm({ title: `Simulate a grid outage at ${d.name}?`, icon: 'zap', confirmLabel: 'Start outage', body: 'For the next 90 minutes the depot runs on backup power. Smart charging re-plans around it and the manager is alerted by SMS and WhatsApp.' })) return; O.forceOutage(d.id, 90); save(); VF.toast('Outage started'); VF.rerender(); },
    'o-restore': re((el) => { O.restore(el.dataset.id); VF.toast('Power restored'); }),
    'o-dr-sel': (el) => { ui.drSel = el.dataset.id; VF.rerender(); },
    'o-sc-send': re((el) => { const r = O.scorecards().find((x) => x.d.id === el.dataset.id); if (!r) return; O.send('scorecard', { score: r.eco, change: `${r.change >= 0 ? '+' : ''}${r.change}`, tip: r.tip.split(';')[0].split('.')[0] + '.' }, 'driver', r.d.id); VF.toast(`Scorecard sent to ${r.d.name}`); }),
    'o-sc-all': re(() => { const rows = O.scorecards(); for (const r of rows) O.send('scorecard', { score: r.eco, change: `${r.change >= 0 ? '+' : ''}${r.change}`, tip: r.tip.split(';')[0].split('.')[0] + '.' }, 'driver', r.d.id); VF.toast(`Scorecards sent to ${rows.length} drivers`); }),
    'o-plan-add': re((el) => { const c = O.cfg(); if (!c.plan.some((p) => p.iceId === el.dataset.id)) c.plan.push({ iceId: el.dataset.id, at: VF.now() }); VF.toast('Added to the transition plan'); }),
    'o-plan-del': re((el) => { const c = O.cfg(); c.plan = c.plan.filter((p) => p.iceId !== el.dataset.id); }),
    'o-assume': () => {
      const a = O.cfg().assume; const cur = VF.state.settings.currency;
      C.modal({ title: 'Planner and finance assumptions', sub: 'Replace with your own quotes and prices.', submitLabel: 'Save', body: `<div class="form-grid-2">${C.field(`Diesel (${cur}/L)`, C.input('diesel', a.diesel, 'type="number" step="0.1" min="1" max="100"'))}${C.field(`Petrol (${cur}/L)`, C.input('petrol', a.petrol, 'type="number" step="0.1" min="1" max="100"'))}${C.field('EV premium: van', C.input('van', a.premium.van, 'type="number" step="1000" min="0"'))}${C.field('EV premium: car', C.input('car', a.premium.car, 'type="number" step="1000" min="0"'))}${C.field('EV premium: pickup', C.input('pickup', a.premium.pickup, 'type="number" step="1000" min="0"'))}${C.field('EV premium: motorbike', C.input('moto', a.premium.moto, 'type="number" step="100" min="0"'))}${C.field('Import duty on EVs (%)', C.input('duty', a.duty, 'type="number" step="1" min="0" max="100"'))}${C.field(`Home charging rate (${cur}/kWh)`, C.input('home', a.homeRate, 'type="number" step="0.05" min="0" max="20"'))}</div>`,
        onSubmit(d) { const v = { diesel: num(d.diesel, 1, 100), petrol: num(d.petrol, 1, 100), duty: num(d.duty, 0, 100), homeRate: num(d.home, 0, 20) }; const pr = { van: num(d.van, 0, 1e7), car: num(d.car, 0, 1e7), pickup: num(d.pickup, 0, 1e7), moto: num(d.moto, 0, 1e7) }; if ([...Object.values(v), ...Object.values(pr)].includes(null)) return 'Check the numbers.'; Object.assign(a, v); a.premium = pr; save(); VF.toast('Assumptions saved'); VF.rerender(); return null; } });
    },
    'o-fin-tab': (el) => { ui.finTab = el.dataset.k; VF.rerender(); },
    'o-attr-csv': () => { const a = O.attribution(); const cur = VF.state.settings.currency.toLowerCase(); VF.downloadText('voltfleet-energy-cost-by-client-30d.csv', VF.csv([['client', 'jobs', 'tonnes', 'km', 'kwh', 'energy_cost_' + cur, 'per_job_' + cur, 'per_tonne_' + cur]].concat(a.rows.map((r) => [r.client, r.jobs, (r.kg / 1000).toFixed(2), r.km.toFixed(1), r.kwh.toFixed(1), r.cost.toFixed(2), r.perJob.toFixed(2), r.perTonne.toFixed(2)])))); VF.toast('Export downloaded'); },
    'o-pay': async () => {
      const due = O.home().filter((x) => !x.paid); if (!due.length) return;
      if (!await C.confirm({ title: `Pay ${due.length} drivers by Mobile Money?`, icon: 'wallet', confirmLabel: `Pay ${money(sum(due, (x) => x.amount), 0)}`, body: `${due.map((x) => `${x.d.name.split(' ')[0]} ${money(x.amount, 0)}`).join(', ')}. Each driver gets an SMS receipt. (Simulated: no money moves until a payment provider is connected.)` })) return;
      const r = O.payHome(); VF.fleetNotice('info', 'Home charging reimbursed', `${r.n} drivers paid ${money(r.total, 0)} by Mobile Money · ref ${r.ref}.`); save(); VF.toast('Payouts sent'); VF.rerender();
    },
    'o-ob-ch': (el) => { ui.obCh = el.dataset.k; VF.rerender(); },
    'o-jobs-import': () => {
      C.modal({ title: 'Import jobs', sub: 'Paste a CSV exported from your TMS, WMS or ERP. It replaces the sample jobs for the planning day.', submitLabel: 'Import', body: `${C.field('CSV', `<textarea class="input mono" name="csv" rows="8" spellcheck="false">${esc(O.sampleCSV())}</textarea>`, 'Columns: ref, client, place, kg, from, to. Place is an area name such as Osu or Tema; hours 0–23.')}`,
        onSubmit(d) { const r = O.parseJobs(d.csv); if (r.error) return r.error; if (!r.jobs.length) return 'No valid rows. Check place names and hours.'; O.cfg().jobs = { [I.routeDay()]: r.jobs }; I.cfg().routesDispatched = null; save(); VF.toast(`${r.jobs.length} jobs imported${r.bad.length ? `, ${r.bad.length} rows skipped (line ${r.bad.slice(0, 3).join(', ')})` : ''}`); VF.rerender(); return null; } });
    },
    'o-jobs-reset': re(() => { O.cfg().jobs = {}; VF.toast('Back to sample jobs'); }),
  });
  Object.assign(VF.CHG, {
    'o-rule': (el) => { O.cfg().rules[el.dataset.k][el.dataset.ch] = el.checked; save(); VF.rerender(); },
    'o-quiet': (el) => { O.cfg().quiet.on = el.checked; save(); VF.rerender(); },
    'o-lang': (el) => { O.cfg().lang[el.dataset.id] = el.value; save(); VF.toast('Language saved'); VF.rerender(); },
    'o-tpl': (el) => { ui.tplType = el.value; VF.rerender(); },
  });
})();
