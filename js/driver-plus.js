/* VoltFleet OS — driver app upgrades: Mobile Money wallet and receipts, range for today's weather, eco-driving score,
   cabin pre-cooling, roadside rescue, charger power reliability and fault reports, SMS / WhatsApp alerts in the
   driver's language, and low-data mode. Payments, rescue and messages are SIMULATED until providers are connected
   on the server; the app never asks for a Mobile Money PIN. */
'use strict';
(function () {
  const { esc, clamp, sum, fmt, icon, mulberry32, hash } = VF;
  const C = VF.c; const MIN = VF.MIN, HOUR = VF.HOUR, DAY = VF.DAY;
  const app = VF.apps.driver; const ui = VF.ui.driver;
  const seed = (s) => parseInt(hash(s), 16);
  const ctx = () => { const u = VF.user(VF.session.userId); const d = VF.driver(u.driverId); const v = VF.driverVehicle(d.id); return { u, d, v, m: VF.model(v) }; };
  const money = (x, dd) => fmt.money(x, dd);
  const WALLETS = ['MTN MoMo', 'Telecel Cash', 'AT Money'];
  const walletFor = (phone) => { const p = String(phone || '').replace(/\D/g, '').slice(3, 5); return ['24', '54', '55', '59', '53'].includes(p) ? 'MTN MoMo' : ['20', '50'].includes(p) ? 'Telecel Cash' : 'AT Money'; };
  const mask = (phone) => { const x = String(phone || '').replace(/\D/g, ''); return x.length > 6 ? `0${x.slice(3, 5)} *** ${x.slice(-4)}` : '—'; };

  // ================================================================ wallet
  function wallet(d, u) {
    if (!d.wallet) d.wallet = { since: VF.now() - 20 * DAY, method: { provider: walletFor(u.phone), to: mask(u.phone) }, tx: [{ id: 'wt0', t: VF.now() - 20 * DAY, kind: 'topup', amount: 300, provider: walletFor(u.phone), ref: 'MM' + String(seed(d.id) % 900000 + 100000), note: 'Sample opening balance' }] };
    return d.wallet;
  }
  function ledger(d, u) {
    const w = wallet(d, u);
    const sessions = VF.state.sessions.filter((x) => x.driverId === d.id && x.end >= w.since).map((x) => ({ t: x.end, kind: 'charge', amount: -x.cost, label: (VF.station(x.stationId) || {}).name || 'Charging', kwh: x.kwh, ref: x.id, se: x }));
    const tx = w.tx.map((x) => ({ t: x.t, kind: x.kind, amount: x.kind === 'topup' ? x.amount : -x.amount, label: x.kind === 'topup' ? `Top-up from ${x.provider}` : x.note || 'Roadside rescue', ref: x.ref }));
    const rows = sessions.concat(tx) // session cost already includes the booking fee
     .sort((a, b) => b.t - a.t);
    return { w, rows, balance: sum(rows, (r) => r.amount) };
  }
  VF.driverWallet = (d, u) => ledger(d, u);
  function pageWallet() {
    const { u, d, v, m } = ctx(); const L = ledger(d, u); const now = VF.now();
    const month = L.rows.filter((r) => r.kind === 'charge' && r.t >= VF.startOfDay(now) - 30 * DAY); const spent = -sum(month, (r) => r.amount); const kwh = sum(month, (r) => r.kwh);
    const km = kwh * 0.92 / (m.eff * 1.05); const petrol = km * 8 / 100 * 14.8; const saved = petrol - spent;
    const low = L.balance < 60;
    return `<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div><div class="dash">
      <section class="card span-12 wallet-hero beam"><div class="wh-top"><div><span class="eyebrow">VoltFleet wallet</span><div class="wh-bal num" data-tween>${money(L.balance)}</div><span class="small">Pays bookings and charging automatically · ${esc(L.w.method.provider)} ${esc(L.w.method.to)}</span></div><span class="wh-ic">${icon('wallet')}</span></div>
        <div class="row gap"><button class="btn light" data-act="d-topup">${icon('plus')}Top up</button><button class="btn ghost-light" data-act="d-wallet-method">${icon('smartphone')}Change wallet</button></div></section>
      ${low ? `<div class="span-12">${C.banner('warn', 'wallet', `<strong>Low balance.</strong> Top up before your next booking; a charge usually costs ${money(40, 0)}–${money(120, 0)}.`)}</div>` : ''}
      ${C.stat({ icon: 'zap', label: 'Charging, 30 days', value: money(spent, 0), hint: `${fmt.kwh(kwh)} · ${month.length} session${month.length === 1 ? '' : 's'}` }).replace('class="stat-card', 'class="stat-card span-4')}
      ${C.stat({ icon: 'fuel', label: 'Saved vs petrol', value: money(Math.max(0, saved), 0), hint: `same ${fmt.km(km)} in a petrol car at ${money(14.8)}/L`, tone: 'lime' }).replace('class="stat-card', 'class="stat-card span-4')}
      ${C.stat({ icon: 'leaf', label: 'CO₂ avoided', value: fmt.n(km * 0.19 - kwh * VF.CO2.GRID_KG_PER_KWH, 0), unit: 'kg', hint: 'vs a petrol car' }).replace('class="stat-card', 'class="stat-card span-4')}
      ${C.card({ cls: 'span-12 flush', title: 'Activity', sub: 'Top-ups, bookings and charging receipts' }, L.rows.length ? `<ul class="tx-list">${L.rows.slice(0, 25).map((r) => `<li><span class="att-ic ${r.amount > 0 ? 'ok' : r.kind === 'charge' ? 'teal' : 'warn'}">${icon(r.amount > 0 ? 'plus' : r.kind === 'charge' ? 'plug-zap' : r.kind === 'fee' ? 'ticket' : 'truck')}</span><div><strong>${esc(r.label)}</strong><span class="small muted">${VF.fmtStamp(r.t)}${r.kwh ? ` · ${fmt.kwh(r.kwh)}` : ''}</span></div><span class="num ${r.amount > 0 ? 'text-ok' : ''}">${r.amount > 0 ? '+' : '−'}${money(Math.abs(r.amount))}</span>${r.kind === 'charge' ? `<button class="icon-btn" data-act="d-receipt" data-id="${esc(r.ref)}" aria-label="Download receipt" data-tip="Receipt">${icon('download')}</button>` : '<span></span>'}</li>`).join('')}</ul>` : C.empty({ icon: 'wallet', title: 'No activity yet' }))}
      <p class="span-12 small muted">${icon('lock')} Payments are simulated in this demo. When live, you approve each top-up on your own phone with your Mobile Money PIN; VoltFleet never asks for your PIN.</p>
    </div>`;
  }

  // ================================================================ range today, eco score, pre-cool, rescue
  function rangeToday(v, m) {
    const wx = VF.intel ? VF.intel.weatherAt(VF.now()) : { temp: 30, rainP: 10 };
    const base = VF.rangeKm(v); const heat = wx.temp > 30 ? 0.06 + (wx.temp - 30) * 0.01 : 0.03; const rain = wx.rainP > 50 ? 0.06 : 0; const traffic = VF.intel ? (VF.intel.traffic(VF.hourOf(VF.now())) - 1) * 0.08 : 0.03;
    const adj = base * (1 - heat - rain - traffic);
    return { base, adj, wx, parts: [['A/C in ' + fmt.n(wx.temp, 0) + '°C heat', heat], ['Rain', rain], ['Traffic now', traffic]].filter((x) => x[1] > 0.005) };
  }
  function ecoScore(d) {
    const wk = Math.floor(VF.now() / (7 * DAY)); const r = mulberry32(seed(d.id + 'eco' + wk)); const r0 = mulberry32(seed(d.id + 'eco' + (wk - 1)));
    const s = Math.round(58 + r() * 38), prev = Math.round(58 + r0() * 38);
    const k = ['eff', 'harsh', 'speed', 'regen', 'idle', 'charge'][seed(d.id + wk) % 6];
    return { s, change: s - prev, tip: VF.ops ? VF.ops.TIPS[k] : 'Brake gently and early to recover energy.' };
  }
  function homeExtras() {
    const { d, v, m } = ctx(); if (!d.consents.telematics) return '';
    const r = rangeToday(v, m); const e = ecoScore(d); const pc = d.precool && d.precool.at > VF.now() ? d.precool : null;
    return `<div class="dash d-extras">
      ${C.card({ cls: 'span-4', title: 'Range today', sub: `${esc(VF.intel ? VF.intel.weatherSource() : 'Modelled weather')}` }, `<div class="big-metric"><span>${fmt.km(r.adj)}</span><small>realistic now · ${fmt.km(r.base)} on paper</small></div>${C.hbars(r.parts.map(([l, x]) => ({ label: l, value: x * 100, text: '−' + fmt.n(x * 100) + '%', tone: 'warn' })))}<p class="small muted">Pre-cool while plugged in and keep tyres at ${v.tyres ? Math.max(...v.tyres) : 36} psi to get more of it back.</p>`)}
      ${C.card({ cls: 'span-4', title: 'My driving', sub: 'This week’s eco-score' }, `<div class="eco-ring">${C.ring(e.s, e.s >= 80 ? 'mint' : e.s >= 65 ? 'teal' : 'warn', null, 'Eco-score ' + e.s)}<div><strong class="num">${e.s}</strong><span class="small ${e.change >= 0 ? 'text-ok' : 'text-warn'}">${e.change >= 0 ? '+' : ''}${e.change} vs last week</span></div></div>${C.banner('teal', 'lightbulb', esc(e.tip))}<p class="small muted">Worked out on your phone from trip summaries; no location history.</p>`)}
      ${C.card({ cls: 'span-4', title: 'Cool cabin, full range', sub: 'Pre-cool on grid power while plugged in' }, pc ? `<p>${icon('circle-check')} Cabin set to 22°C for <strong>${VF.fmtTime(pc.at)}</strong>.</p><button class="btn small" data-act="d-precool-off">Cancel</button>` : `<p class="small muted">Cooling a hot car from the battery can cost 5–10% of your range. Do it while charging instead.</p><button class="btn" data-act="d-precool" ${['charging', 'parked'].includes(v.status) ? '' : 'disabled'}>${icon('timer')}Schedule pre-cool</button>${['charging', 'parked'].includes(v.status) ? '' : '<p class="small muted">Available when the car is parked or charging.</p>'}`)}
    </div>`;
  }
  function rescueBanner() {
    const { d, v } = ctx(); const r = d.rescue && d.rescue.status !== 'done' ? d.rescue : null;
    if (r) return `<section class="card span-12 rescue on"><div class="row between"><div><strong>${icon('truck')} Rescue van on its way</strong><p class="small muted">Arrives about ${VF.fmtTime(r.eta)} with a mobile charger. Reference <span class="mono">${esc(r.ref)}</span>. Your location is shared with the rescue team until they arrive.</p></div><button class="btn small" data-act="d-rescue-cancel">Cancel</button></div></section>`;
    if (v.status === 'stranded' || v.soc < 10) return `<section class="card span-12 rescue"><div class="row between"><div><strong>${icon('battery-warning')} ${v.status === 'stranded' ? 'Your battery is empty' : 'Battery very low'}</strong><p class="small muted">Request a rescue van with a mobile charger. About ${money(150, 0)} from your wallet; it adds enough charge to reach a station.</p></div><button class="btn primary" data-act="d-rescue">${icon('truck')}Get roadside help</button></div></section>`;
    return '';
  }
  function rescueTick() {
    for (const d of VF.state.drivers || []) {
      const r = d.rescue; if (!r || r.status === 'done' || VF.now() < r.eta) continue;
      const v = VF.driverVehicle(d.id); if (v) { v.soc = Math.max(v.soc, 18); if (v.status === 'stranded') v.status = v.trip && !v.trip.done ? 'driving' : 'parked'; }
      r.status = 'done'; r.loc = null; // stop sharing location as soon as the job is done
      VF.notify(d.id, 'Rescue complete', `Your car has 18% now: enough to reach a charger. ${money(r.fee, 0)} was paid from your wallet.`);
    }
  }
  VF.tickHooks = (VF.tickHooks || []).concat(rescueTick);

  // ================================================================ me: alerts, language, low data, vehicle link
  const LANG = [['en', 'English'], ['tw', 'Twi (Akan)'], ['ha', 'Hausa'], ['fr', 'Français']];
  function meExtras() {
    const { u, d, v } = ctx(); const a = d.alertPrefs = Object.assign({ ch: 'wa', lang: 'en', low: true, done: true, booking: true }, d.alertPrefs);
    return `<div class="dash">
      ${C.card({ cls: 'span-12 me-head' }, `<div class="row between"><div class="row">${C.vehicleImg ? C.vehicleImg(v.model, 'thumb') : ''}<div><strong>${esc(u.name)}</strong><div class="small muted">${esc(v.model)}${v.plate ? ' · ' + esc(v.plate) : ''}</div></div></div><a class="btn" href="#driver-vehicle">${icon('car')}My vehicle</a></div>`)}
      ${C.card({ cls: 'span-6', title: 'Alerts on my phone', sub: 'Also works with mobile data off' }, `${C.seg([['sms', 'SMS'], ['wa', 'WhatsApp'], ['both', 'Both'], ['app', 'App only']], a.ch, 'd-alert-ch')}
        <div class="toggles">${[['low', 'Low battery and range warnings'], ['booking', 'Booking reminders and changes'], ['done', 'Charging finished']].map(([k, l]) => `<label class="toggle"><span><strong>${l}</strong></span><input type="checkbox" role="switch" data-chg="d-alert-pref" data-k="${k}" ${a[k] ? 'checked' : ''}></label>`).join('')}</div>
        <label class="field"><span>Language for messages</span>${C.select('d-lang', LANG, a.lang, 'data-chg="d-alert-lang"')}</label>
        ${VF.ops ? `<p class="small muted">Preview: “${esc(VF.ops.render('low_battery', a.lang, { vehicle: v.model, soc: 14, station: 'Spintex Charge Hub' }))}”</p>` : ''}<p class="small muted">Sent to ${esc(mask(u.phone))}. Simulated until an SMS/WhatsApp provider is connected.</p>`)}
      <div class="span-6">${VF.lite ? VF.lite.settingsCard() : ''}</div>
    </div>`;
  }

  // ================================================================ charger reliability and fault reports
  function stationExtras(id) {
    const st = VF.station(id); if (!st || !VF.ops) return '';
    const now = VF.now(); const ps = Array.from({ length: 8 }, (_, i) => VF.ops.outageP(st.id, now + i * HOUR)); const worst = Math.max(...ps); const at = now + ps.indexOf(worst) * HOUR;
    return `<div class="sheet-extra"><div class="row between"><strong class="small">Grid power here</strong><span class="small ${worst > 0.08 ? 'text-warn' : 'text-ok'}">${worst > 0.08 ? `Outage risk peaks ${VF.fmtTime(at)}` : 'Usually reliable next 8 h'}</span></div>
      <div class="risk-bar">${ps.map((p, i) => `<i style="--p:${clamp(p * 6, 0.06, 1).toFixed(2)}" title="${VF.fmtTime(now + i * HOUR)}"></i>`).join('')}</div>
      <button class="btn small ghost" data-act="d-report" data-id="${esc(st.id)}">${icon('triangle-alert')}Report a problem</button></div>`;
  }
  const ISSUES = ['Charger not working', 'Cable or plug damaged', 'Bay blocked by a non-EV car', 'Payment failed', 'Other'];

  // ================================================================ wire into the driver app
  const NAV = app.nav;
  NAV.find((n) => n.id === 'driver-vehicle').hidden = true;
  Object.assign(NAV.find((n) => n.id === 'driver-privacy'), { label: 'Me', icon: 'circle-user', title: 'Me & privacy' });
  NAV.splice(NAV.findIndex((n) => n.id === 'driver-charge') + 1, 0, { id: 'driver-wallet', label: 'Wallet', icon: 'wallet', title: 'Wallet' });
  const P = app.pages;
  const home0 = P['driver-home'], charge0 = P['driver-charge'], me0 = P['driver-privacy'];
  P['driver-wallet'] = pageWallet;
  P['driver-home'] = () => { const rb = rescueBanner(); return (rb ? `<div class="dash">${rb}</div>` : '') + home0() + homeExtras(); };
  P['driver-charge'] = () => { const { u, d } = ctx(); const bal = ledger(d, u).balance; return (bal < 60 ? `<div class="dash"><div class="span-12">${C.banner('warn', 'wallet', `Wallet balance ${money(bal)}. <a href="#driver-wallet">Top up</a> so your booking and charge are paid automatically.`)}</div></div>` : '') + charge0(); };
  P['driver-privacy'] = () => meExtras() + me0();
  const key0 = app.structKey;
  app.structKey = (page) => { const { d, v } = ctx(); return key0(page) + '|' + [JSON.stringify(d.alertPrefs || {}), d.wallet ? d.wallet.tx.length + d.wallet.method.provider : '', d.rescue ? d.rescue.status : '', d.precool ? d.precool.at : '', v.soc < 10 ? 'lo' : '', VF.lite ? VF.lite.get() : '', page === 'driver-wallet' ? VF.state.sessions.filter((x) => x.driverId === d.id).length : '', Math.floor(VF.now() / (15 * MIN))].join('|'); };
  const sheet0 = app.sheet;
  app.sheet = () => { const h = sheet0(); return ui.sheet && ui.sheet.type === 'station' ? h + stationExtras(ui.sheet.id) : h; };

  Object.assign(VF.ACT, {
    'd-topup': () => {
      const { u, d } = ctx(); const w = wallet(d, u);
      C.modal({ title: 'Top up with Mobile Money', sub: 'You approve the payment on your phone with your PIN. VoltFleet never asks for it.', submitLabel: 'Send payment request', body: `<div class="form-grid-2">${C.field('Amount', C.select('amount', [[50, money(50, 0)], [100, money(100, 0)], [200, money(200, 0)], [500, money(500, 0)]], 100))}${C.field('Wallet', C.select('provider', WALLETS, w.method.provider))}</div><p class="small muted">${icon('smartphone')} A request goes to ${esc(w.method.to)}. Approve it within 2 minutes.</p>`,
        onSubmit(f) { const amt = +f.amount; if (![50, 100, 200, 500].includes(amt) || !WALLETS.includes(f.provider)) return 'Choose an amount and a wallet.'; w.tx.unshift({ id: 'wt' + (++VF.state.seq), t: VF.now(), kind: 'topup', amount: amt, provider: f.provider, ref: 'MM' + String(Math.floor(100000 + Math.random() * 900000)) }); VF.save(); VF.toast(`${money(amt, 0)} added from ${f.provider} (simulated)`); VF.rerender(); return null; } });
    },
    'd-wallet-method': () => {
      const { u, d } = ctx(); const w = wallet(d, u);
      C.modal({ title: 'Payment wallet', submitLabel: 'Save', body: `${C.field('Mobile Money wallet', C.select('provider', WALLETS, w.method.provider))}<p class="small muted">Uses the number on your account, ${esc(mask(u.phone))}. Change your number in your account settings.</p>`,
        onSubmit(f) { if (!WALLETS.includes(f.provider)) return 'Choose a wallet.'; w.method.provider = f.provider; VF.save(); VF.toast('Wallet updated'); VF.rerender(); return null; } });
    },
    'd-receipt': (el) => {
      const { d } = ctx(); const se = VF.state.sessions.find((x) => x.id === el.dataset.id && x.driverId === d.id); if (!se) return;
      const st = VF.station(se.stationId) || {}; const op = st.operatorId ? VF.operator(st.operatorId) : {};
      const txt = [`VoltFleet charging receipt`, `Receipt: ${se.id}`, `Station: ${st.name || ''}`, `Operator: ${op.name || ''}`, `Connector: ${se.type || ''}`, `Start: ${new Date(se.start).toISOString()}`, `End: ${new Date(se.end).toISOString()}`, `Energy: ${se.kwh.toFixed(2)} kWh`, `Amount: ${money(se.cost)}`, `Paid from: VoltFleet wallet`, '', 'Simulated receipt for the demo.'].join('\n');
      VF.downloadText(`voltfleet-receipt-${se.id}.txt`, txt);
    },
    'd-precool': () => {
      const { d } = ctx(); const dep = VF.startOfDay(VF.now()) + DAY + 7 * HOUR;
      C.modal({ title: 'Pre-cool the cabin', submitLabel: 'Schedule', body: C.field('Ready by', C.select('at', [6, 6.5, 7, 7.5, 8, 9].map((h) => [dep - 7 * HOUR + h * HOUR, `${String(Math.floor(h)).padStart(2, '0')}:${h % 1 ? '30' : '00'} tomorrow`]), dep)) + '<p class="small muted">Runs on grid power for 15 minutes before you leave, if the car is plugged in.</p>',
        onSubmit(f) { d.precool = { at: +f.at }; VF.save(); VF.toast('Pre-cool scheduled'); VF.rerender(); return null; } });
    },
    'd-precool-off': () => { const { d } = ctx(); d.precool = null; VF.save(); VF.rerender(); },
    'd-rescue': async () => {
      const { u, d } = ctx();
      if (!await C.confirm({ title: 'Request roadside help?', icon: 'truck', confirmLabel: 'Share location and request', body: `A rescue van with a mobile charger comes to you. Your live location is shared with the rescue team only, and only until they arrive. About ${money(150, 0)} from your wallet.` })) return;
      const ref = 'RS-' + String(Math.floor(1000 + Math.random() * 9000)); const fee = 150;
      d.rescue = { t: VF.now(), eta: VF.now() + (25 + Math.floor(Math.random() * 20)) * MIN, status: 'en route', ref, fee, loc: 'shared' };
      wallet(d, u).tx.unshift({ id: 'wt' + (++VF.state.seq), t: VF.now(), kind: 'rescue', amount: fee, ref, note: 'Roadside rescue ' + ref });
      VF.notify(d.id, 'Rescue van on its way', `Reference ${ref}. Stay with your car if it's safe.`); VF.save(); VF.rerender();
    },
    'd-rescue-cancel': () => { const { u, d } = ctx(); if (!d.rescue) return; const w = wallet(d, u); w.tx = w.tx.filter((x) => x.ref !== d.rescue.ref); d.rescue = null; VF.save(); VF.toast('Rescue cancelled · refunded'); VF.rerender(); },
    'd-report': (el) => {
      const st = VF.station(el.dataset.id); if (!st) return;
      C.modal({ title: `Report a problem at ${st.name}`, sub: 'The operator sees the issue and your booking code, never your name or number.', submitLabel: 'Send report', body: `${C.field('What’s wrong?', C.select('issue', ISSUES, ISSUES[0]))}${C.field('Details (optional)', '<textarea class="input" name="note" rows="3" maxlength="200"></textarea>')}`,
        onSubmit(f) {
          if (!ISSUES.includes(f.issue)) return 'Choose an issue.';
          const note = String(f.note || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 200);
          VF.raiseAlert({ scope: st.operatorId, stationId: st.id, sev: f.issue === 'Charger not working' ? 'critical' : 'warning', kind: 'Driver report', title: `${f.issue} at ${st.name}`, body: note || 'Reported from the driver app.' });
          VF.save(); VF.toast('Thanks — the operator has been told'); return null;
        } });
    },
  });
  Object.assign(VF.CHG, {
    'd-alert-pref': (el) => { const { d } = ctx(); d.alertPrefs[el.dataset.k] = el.checked; VF.save(); VF.rerender(); },
    'd-alert-lang': (el) => { const { d } = ctx(); if (LANG.some(([k]) => k === el.value)) d.alertPrefs.lang = el.value; VF.save(); VF.toast('Language saved'); VF.rerender(); },
  });
  VF.ACT['d-alert-ch'] = (el) => { const { d } = ctx(); if (['sms', 'wa', 'both', 'app'].includes(el.dataset.k)) d.alertPrefs.ch = el.dataset.k; VF.save(); VF.rerender(); };
})();
