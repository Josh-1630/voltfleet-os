/* VoltFleet OS — real chargers over OCPP 1.6J (operator console page "Real chargers").
   Talks to the `ocpp` Edge Function (supabase/functions/ocpp): a network access key held by this browser
   authorises the console; each charger has its own password. Live charger data never enters the shared
   demo world. Includes a built-in simulated charger (js/ocpp-sim.js) to try everything without hardware. */
'use strict';
(function () {
  const { esc, fmt, icon } = VF;
  const C = VF.c;
  const cloud = window.VOLTFLEET_CLOUD || {};
  const cfg = window.VOLTFLEET_OCPP || {};
  const FN = cfg.url || (cloud.url ? cloud.url.replace(/\/$/, '') + '/functions/v1/ocpp' : '');
  const WS = FN.replace(/^http/, 'ws');
  const STORE = 'voltfleet-os:ocpp', PW = 'voltfleet-os:ocpp-pw';
  const O = VF.ocppNet = { fn: FN, ws: WS, key: null, name: '', data: null, error: '', lastPoll: 0, polling: false, sim: null, simLog: [], simCp: '', simState: 'offline' };
  try { const s = JSON.parse(localStorage.getItem(STORE) || 'null'); if (s) { O.key = s.key; O.name = s.name || ''; } } catch (e) { /* none */ }
  const persist = () => { try { if (O.key) localStorage.setItem(STORE, JSON.stringify({ key: O.key, name: O.name })); else localStorage.removeItem(STORE); } catch (e) { /* blocked */ } };
  // Charger passwords are shown once; this tab remembers them only so the simulator can use them.
  const pwGet = (id) => { try { return JSON.parse(sessionStorage.getItem(PW) || '{}')[id] || ''; } catch (e) { return ''; } };
  const pwSet = (id, pw) => { try { const m = JSON.parse(sessionStorage.getItem(PW) || '{}'); m[id] = pw; sessionStorage.setItem(PW, JSON.stringify(m)); } catch (e) { /* not kept */ } };

  async function call(action, body) {
    if (!FN) throw new Error('Cloud functions are not configured (js/config.js).');
    const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cloud.key ? { apikey: cloud.key } : {}) }, body: JSON.stringify({ action, ...(body || {}) }) });
    let j = null; try { j = await r.json(); } catch (e) { /* not JSON */ }
    if (!r.ok) { const err = new Error((j && j.error) || `Request failed (${r.status})`); err.status = r.status; throw err; }
    return j;
  }
  O.poll = async () => {
    if (!O.key || O.polling) return;
    O.polling = true;
    try { O.data = await call('network', { key: O.key, logLimit: 80 }); O.error = ''; O.name = O.data.network.name; }
    catch (e) { O.error = e.message; if (e.status === 401) { O.key = null; O.data = null; persist(); VF.toast('This network access key is no longer valid on this device.'); VF.rerender(); } }
    finally { O.polling = false; O.lastPoll = Date.now(); }
  };
  const cmd = async (id, command, payload, label) => {
    try { const r = await call('command', { key: O.key, id, command, payload }); VF.toast(`${label || command} sent${r.online ? '' : ' (queued until the charger connects)'}`); O.poll(); }
    catch (e) { VF.toast(e.message); }
  };
  setInterval(() => { if (O.key && VF.route() === 'op-ocpp' && !document.hidden && Date.now() - O.lastPoll > 2500) O.poll(); }, 1000);

  // ---------------------------------------------------------------- formatting
  const TONE = { Available: 'ok', Charging: 'mint', Preparing: 'teal', Finishing: 'teal', SuspendedEV: 'warn', SuspendedEVSE: 'warn', Reserved: 'teal', Unavailable: 'muted', Faulted: 'bad' };
  const statusBadge = (s) => `<span class="badge ${TONE[s] || 'muted'}">${esc(s ? s.replace(/([a-z])([A-Z])/g, '$1 $2') : 'Unknown')}</span>`;
  const CMD_TONE = { queued: 'muted', sent: 'teal', accepted: 'ok', rejected: 'warn', error: 'bad', timeout: 'bad', lost: 'warn' };
  const cmdLabel = { queued: 'Queued', sent: 'Sent', accepted: 'Accepted', rejected: 'Rejected', error: 'Error', timeout: 'No reply', lost: 'Connection dropped' };
  const kw = (w) => (w == null ? '—' : fmt.kw(w / 1000));
  const kwh = (wh) => (wh == null ? '—' : fmt.kwh(wh / 1000));
  const ago = (ms) => { if (!ms) return 'never'; const s = Math.max(0, (Date.now() - ms) / 1000); return s < 10 ? 'just now' : s < 60 ? `${Math.round(s)} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
  const tag = (t) => (t && t.length > 4 ? t.slice(0, 2) + '•••' + t.slice(-2) : t || '—'); // card numbers are personal data: masked
  const time = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const activeTx = (cpId, n) => (O.data ? O.data.transactions.find((t) => t.cpId === cpId && t.connectorId === n && !t.stopAt) : null);

  // ---------------------------------------------------------------- page
  function intro() {
    return `<div class="dash">${C.card({ cls: 'span-8', title: 'Connect your real chargers', sub: 'VoltFleet runs an OCPP 1.6J central system. Any charger that speaks OCPP 1.6J (XCharge, ABB, Kempower, Alfen, Wallbox and most others) can connect to it.' }, `
        <ul class="tips">
          <li>${icon('radio-tower')}<span>Each charger connects over a secure WebSocket with its own ID and password.</span></li>
          <li>${icon('activity')}<span>See live connector status, power, energy and battery level, and every OCPP message.</span></li>
          <li>${icon('sliders-horizontal')}<span>Start and stop sessions remotely, unlock cables, reset, take connectors out of service and cap power (smart charging).</span></li>
          <li>${icon('shield-check')}<span>Real charger data stays in this network. It is not shared with the demo or other operators, and card numbers are masked.</span></li>
        </ul>
        <div class="card-actions"><button class="btn primary" data-act="oc-create">${icon('plus')}Create charging network</button><button class="btn" data-act="oc-import">${icon('key')}Use an access key</button></div>`)}
      ${C.card({ cls: 'span-4', title: 'No charger yet?' }, `<p class="small muted">After creating the network, add a charger and press <strong>Start simulated charger</strong>. It connects to the central system exactly like hardware and responds to every command.</p>`)}</div>`;
  }
  function chargerCard(cp) {
    const conns = cp.connectors.length ? cp.connectors : [];
    return `<article class="card oc-cp${cp.online ? ' online' : ''}">
      <header class="oc-cp-head">
        <div class="oc-cp-title"><span class="oc-dot ${cp.online ? 'on' : ''}"></span><div><h3>${esc(cp.label)}</h3><p class="small muted"><span class="mono">${esc(cp.id)}</span>${cp.vendor ? ` · ${esc(cp.vendor)} ${esc(cp.model || '')}` : ''}${cp.firmware ? ` · fw ${esc(cp.firmware)}` : ''}</p></div></div>
        <div class="row">${cp.online ? '<span class="badge ok">Online</span>' : cp.lastSeen ? `<span class="badge muted">Offline · ${ago(cp.lastSeen)}</span>` : '<span class="badge warn">Waiting for first connection</span>'}${cp.authMode === 'list' ? '<span class="badge teal">Listed cards only</span>' : ''}</div>
      </header>
      ${!conns.length ? `<div class="oc-wait">${icon('plug-zap')}<div><strong>${cp.lastSeen ? 'No connectors reported yet' : 'Not connected yet'}</strong><p class="small muted">Point the charger at the central system URL with ID <span class="mono">${esc(cp.id)}</span>, or start the simulated charger below.</p></div><button class="btn small" data-act="oc-details" data-id="${esc(cp.id)}">${icon('link')}Connection details</button></div>`
        : `<div class="oc-conns">${conns.map((c) => { const tx = activeTx(cp.id, c.connectorId); const live = `oc-${cp.id}-${c.connectorId}`; return `<div class="oc-conn">
          <div class="oc-conn-id"><strong>Connector ${c.connectorId}</strong>${statusBadge(c.status)}${c.errorCode && c.errorCode !== 'NoError' ? `<span class="small text-bad">${esc(c.errorCode)}</span>` : ''}</div>
          <div class="oc-conn-meter"><span><b data-live="${live}-kw">${kw(c.powerW)}</b><small>power</small></span><span><b data-live="${live}-kwh">${tx ? kwh((tx.lastMeterWh || tx.meterStart) - tx.meterStart) : '—'}</b><small>this session</small></span><span><b data-live="${live}-soc">${c.soc != null ? Math.round(c.soc) + '%' : '—'}</b><small>battery</small></span></div>
          <div class="oc-conn-tx small muted">${tx ? `Session #${tx.id} · card <span class="mono">${esc(tag(tx.idTag))}</span> · since ${time(tx.startAt)}` : esc(c.info || '')}</div>
          <div class="oc-conn-act">${tx ? `<button class="btn small" data-act="oc-stop" data-id="${esc(cp.id)}" data-tx="${tx.id}">${icon('pause')}Stop</button>` : `<button class="btn small primary" data-act="oc-start" data-id="${esc(cp.id)}" data-n="${c.connectorId}" ${!cp.online || ['Unavailable', 'Faulted'].includes(c.status) ? 'disabled' : ''}>${icon('play')}Start</button>`}
            <button class="btn small ghost" data-act="oc-unlock" data-id="${esc(cp.id)}" data-n="${c.connectorId}" data-tip="Release the cable">${icon('lock-open')}Unlock</button>
            <button class="btn small ghost" data-act="oc-avail" data-id="${esc(cp.id)}" data-n="${c.connectorId}" data-k="${c.status === 'Unavailable' ? 'Operative' : 'Inoperative'}">${icon(c.status === 'Unavailable' ? 'circle-check' : 'ban')}${c.status === 'Unavailable' ? 'Enable' : 'Disable'}</button></div>
        </div>`; }).join('')}</div>`}
      <footer class="oc-cp-foot">
        <span class="small muted">Last message <span data-live="oc-${esc(cp.id)}-seen">${ago(cp.lastSeen)}</span></span>
        <div class="row">
          <button class="btn small ghost" data-act="oc-limit" data-id="${esc(cp.id)}">${icon('gauge')}Power limit</button>
          <button class="btn small ghost" data-act="oc-trigger" data-id="${esc(cp.id)}">${icon('refresh-cw')}Refresh status</button>
          <button class="btn small ghost" data-act="oc-config" data-id="${esc(cp.id)}">${icon('list')}Configuration</button>
          <button class="btn small ghost" data-act="oc-reset" data-id="${esc(cp.id)}">${icon('rotate-ccw')}Reset</button>
          <button class="btn small ghost" data-act="oc-settings" data-id="${esc(cp.id)}">${icon('settings')}Settings</button>
        </div>
      </footer>
    </article>`;
  }
  function cmdsHTML() {
    const list = (O.data && O.data.commands) || [];
    if (!list.length) return C.empty({ icon: 'send', title: 'No commands yet', text: 'Remote start, stop, unlock and other commands appear here with the charger’s answer.' });
    return `<ul class="oc-cmds">${list.slice(0, 12).map((c) => { const r = c.result || {}; const extra = r.configurationKey ? `${r.configurationKey.length} settings` : r.status ? r.status : r.code ? `${r.code}` : ''; return `<li><span class="mono small">${esc(c.cpId)}</span><strong>${esc(c.action.replace(/([a-z])([A-Z])/g, '$1 $2'))}</strong><span class="badge ${CMD_TONE[c.status] || 'muted'}">${cmdLabel[c.status] || esc(c.status)}</span><span class="small muted">${esc(extra)} · ${time(c.createdAt)}</span>${r.configurationKey ? `<button class="link-btn small" data-act="oc-showcfg" data-id="${c.id}">View</button>` : ''}</li>`; }).join('')}</ul>`;
  }
  function logHTML() {
    const list = (O.data && O.data.log) || [];
    if (!list.length) return C.empty({ icon: 'radio-tower', title: 'No messages yet', text: 'Every OCPP message between your chargers and VoltFleet is listed here.' });
    return `<div class="log oc-log">${list.slice(0, 60).map((l) => `<div class="log-row"><span class="t">${time(l.at)}</span><span class="dir ${l.dir === 'out' ? 'out' : 'in'}">${l.dir === 'out' ? '→ CP' : '← CP'}</span><span class="msg"><strong>${esc(l.action || l.kind)}</strong> <span class="faint small">${esc(l.kind)} · ${esc(l.cpId)}</span><span class="small muted oc-payload">${esc(JSON.stringify(l.payload || {})).slice(0, 180)}</span></span></div>`).join('')}</div>`;
  }
  function simHTML() {
    const cps = (O.data && O.data.chargePoints) || [];
    if (!cps.length) return '<p class="small muted">Add a charger first.</p>';
    const sel = O.simCp || cps[0].id; const running = O.sim && O.simState !== 'offline';
    return `<div class="form-grid-2">
        ${C.field('Charger', `<select class="select" id="oc-sim-cp" ${running ? 'disabled' : ''}>${cps.map((c) => `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${esc(c.label)} (${esc(c.id)})</option>`).join('')}</select>`)}
        ${C.field('Password', `<input class="input mono" id="oc-sim-pw" type="password" autocomplete="off" value="${esc(pwGet(sel))}" ${running ? 'disabled' : ''} placeholder="Shown when the charger was added">`, 'Rotate it in Settings if you no longer have it')}
      </div>
      <div class="card-actions">${running ? `<button class="btn" data-act="oc-sim-stop">${icon('square')}Stop simulated charger</button><span class="badge ${O.simState === 'online' ? 'ok' : 'warn'}" data-live="oc-sim-state">${esc(O.simState)}</span>
        ${O.sim.connectors.map((c) => `<button class="btn small ghost" data-act="oc-sim-plug" data-n="${c.id}">${icon('plug-zap')}Tap card on ${c.id}</button>`).join('')}`
        : `<button class="btn primary" data-act="oc-sim-start">${icon('play')}Start simulated charger</button>`}</div>
      <div class="oc-simlog small" data-live="oc-simlog">${simLogHTML()}</div>`;
  }
  const simLogHTML = () => O.simLog.slice(-6).reverse().map((e) => `<div><span class="faint">${time(e.at)}</span> ${esc(e.text)}</div>`).join('') || '<span class="faint">Simulator events appear here.</span>';
  function pageOcpp() {
    if (!FN) return C.card({}, C.empty({ icon: 'cloud', title: 'Cloud functions are not configured', text: 'Set the Supabase URL in js/config.js to connect real chargers.' }));
    if (!O.key) return intro();
    if (!O.data) { if (!O.polling) O.poll().then(() => VF.rerender()); return C.card({}, O.error ? C.empty({ icon: 'triangle-alert', title: 'Could not load the network', text: O.error, action: '<button class="btn" data-act="oc-retry">Try again</button>' }) : C.skeleton(4)); }
    const d = O.data; const cps = d.chargePoints;
    const conns = cps.flatMap((c) => c.connectors);
    const charging = conns.filter((c) => c.status === 'Charging').length;
    const power = conns.reduce((s, c) => s + (c.powerW || 0), 0);
    const done = d.transactions.filter((t) => t.stopAt);
    const energy = done.reduce((s, t) => s + Math.max(0, (t.meterStop || 0) - t.meterStart), 0);
    return `${O.error ? C.banner('warn', 'triangle-alert', `Last refresh failed: ${esc(O.error)}`) : ''}
      <section class="stat-grid">
        ${C.stat({ icon: 'plug-zap', label: 'Chargers', value: cps.length, hint: `${conns.length} connectors` })}
        ${C.stat({ icon: 'radio-tower', label: 'Online now', value: cps.filter((c) => c.online).length, unit: `/ ${cps.length}`, hint: `Heartbeat every ${d.heartbeat} s` })}
        ${C.stat({ icon: 'battery-charging', label: 'Charging now', value: charging, hint: `<span data-live="oc-power">${kw(power)}</span> total`, tone: '' })}
        ${C.stat({ icon: 'zap', label: 'Energy delivered', value: fmt.n(energy / 1000, 1), unit: 'kWh', hint: `${done.length} completed sessions` })}
      </section>
      <div class="dash">
        <div class="span-8 stack">
          ${cps.length ? cps.map(chargerCard).join('') : C.card({}, C.empty({ icon: 'plug-zap', title: 'No chargers yet', text: 'Add your first charger to get its connection details.', action: '<button class="btn primary" data-act="oc-add">Add charger</button>' }))}
          ${C.card({ cls: 'flush', title: 'Recent sessions' }, C.table([
            { label: 'Session', render: (t) => `<span class="mono">#${t.id}</span>` },
            { label: 'Charger', render: (t) => `${esc(t.cpId)} · ${t.connectorId}` },
            { label: 'Card', render: (t) => `<span class="mono">${esc(tag(t.idTag))}</span>${t.idTagStatus && t.idTagStatus !== 'Accepted' ? ` <span class="badge bad">${esc(t.idTagStatus)}</span>` : ''}` },
            { label: 'Started', render: (t) => time(t.startAt) },
            { label: 'Duration', align: 'r', render: (t) => `<span data-live="oc-tx-${t.id}-dur">${fmt.dur(((t.stopAt || Date.now()) - t.startAt) / 60000)}</span>` },
            { label: 'Energy', align: 'r', render: (t) => `<span data-live="oc-tx-${t.id}-kwh">${kwh(((t.stopAt ? t.meterStop : t.lastMeterWh) || t.meterStart) - t.meterStart)}</span>` },
            { label: 'Status', render: (t) => (t.stopAt ? `<span class="badge muted">${esc(t.reason || 'Ended')}</span>` : '<span class="badge mint">Charging</span>') },
          ], d.transactions.slice(0, 12).map((t) => Object.assign({}, t, { id: t.id })), { empty: { icon: 'zap', title: 'No sessions yet' } }))}
        </div>
        <div class="span-4 stack">
          ${C.card({ title: 'Test with a simulated charger', sub: 'Behaves like real OCPP 1.6J hardware' }, `<div data-live="oc-sim">${simHTML()}</div>`)}
          ${C.card({ cls: 'flush', title: 'Commands' }, `<div data-live="oc-cmds">${cmdsHTML()}</div>`)}
          ${C.card({ title: 'Authorised cards', sub: d.idTags.length ? `${d.idTags.length} cards` : 'Used by chargers set to “listed cards only”', action: `<button class="btn small" data-act="oc-tag-add">${icon('plus')}Add</button>` }, d.idTags.length ? `<ul class="oc-tags">${d.idTags.map((t) => `<li><span class="mono">${esc(tag(t.idTag))}</span><span class="small muted">${esc(t.label || '')}</span><span class="badge ${t.status === 'Accepted' ? 'ok' : 'bad'}">${esc(t.status)}</span><button class="icon-btn" data-act="oc-tag-del" data-tag="${esc(t.idTag)}" aria-label="Remove card">${icon('trash-2')}</button></li>`).join('')}</ul>` : '<p class="small muted">Chargers set to “any card” accept every card.</p>')}
          ${C.card({ cls: 'flush', title: 'OCPP messages', sub: 'Live log, newest first' }, `<div data-live="oc-log">${logHTML()}</div>`)}
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------- live updates
  function signature() {
    const d = O.data; if (!d) return (O.key ? 'k' : 'n') + O.error;
    return [O.error, d.chargePoints.map((c) => [c.id, c.label, c.online, c.authMode, c.vendor, c.connectors.map((k) => k.connectorId + k.status + k.errorCode).join()].join('|')).join(';'), d.transactions.slice(0, 12).map((t) => t.id + (t.stopAt ? 's' : '')).join(), d.idTags.map((t) => t.idTag + t.status).join(), O.sim ? O.simState === 'offline' ? 'so' : 'sr' : ''].join('#');
  }
  function liveValues() {
    const v = {}; const d = O.data; if (!d) return v;
    let power = 0;
    for (const cp of d.chargePoints) {
      v[`oc-${cp.id}-seen`] = ago(cp.lastSeen);
      for (const c of cp.connectors) { const tx = activeTx(cp.id, c.connectorId); const k = `oc-${cp.id}-${c.connectorId}`; power += c.powerW || 0; v[k + '-kw'] = kw(c.powerW); v[k + '-kwh'] = tx ? kwh((tx.lastMeterWh || tx.meterStart) - tx.meterStart) : '—'; v[k + '-soc'] = c.soc != null ? Math.round(c.soc) + '%' : '—'; }
    }
    for (const t of d.transactions.slice(0, 12)) if (!t.stopAt) { v[`oc-tx-${t.id}-dur`] = fmt.dur((Date.now() - t.startAt) / 60000); v[`oc-tx-${t.id}-kwh`] = kwh((t.lastMeterWh || t.meterStart) - t.meterStart); }
    v['oc-power'] = kw(power); v['oc-cmds'] = { html: cmdsHTML() }; v['oc-log'] = { html: logHTML() }; v['oc-simlog'] = { html: simLogHTML() }; v['oc-sim-state'] = O.simState;
    return v;
  }
  const app = VF.apps.operator;
  app.nav.push({ id: 'op-ocpp', label: 'Real chargers', icon: 'radio-tower', title: 'Real chargers (OCPP)', eyebrow: 'Charge point operator' });
  app.pages['op-ocpp'] = pageOcpp;
  const baseKey = app.structKey, baseLive = app.live, baseActions = app.actions;
  app.structKey = (page) => (page === 'op-ocpp' ? 'op-ocpp|' + signature() : baseKey(page));
  app.live = (page) => (page === 'op-ocpp' ? liveValues() : baseLive(page));
  app.actions = (page) => (page === 'op-ocpp' && O.key ? `<button class="btn" data-act="oc-share">${icon('key')}<span class="hide-sm">Access key</span></button><button class="btn primary" data-act="oc-add">${icon('plus')}<span class="hide-sm">Add charger</span></button>` : baseActions ? baseActions(page) : '');

  // ---------------------------------------------------------------- dialogs and actions
  function connectionDetails(id, password) {
    const row = (l, v, copy) => `<div class="oc-detail"><span class="stat-label">${l}</span><div class="row nowrap"><code class="grow">${esc(v)}</code>${copy ? `<button type="button" class="btn small" data-act="oc-copy" data-v="${esc(v)}">${icon('copy')}Copy</button>` : ''}</div></div>`;
    return `${row('Central system URL', WS, true)}${row('Charge point ID (identity)', id, true)}${password ? row('Password (shown once)', password, true) : row('Password', 'Hidden. Rotate it in Settings to get a new one.')}
      ${row('Full WebSocket address', `${WS}/${id}`, true)}
      <dl class="dl boxed"><dt>Protocol</dt><dd>OCPP 1.6J (subprotocol <code>ocpp1.6</code>)</dd><dt>Security</dt><dd>Profile 1: HTTP Basic auth over TLS (wss)</dd><dt>Heartbeat</dt><dd>60 seconds</dd></dl>
      <p class="small muted">In the charger’s settings (its web portal, installer app or the vendor’s cloud, for example XCharge, ABB, Kempower or Alfen), set the central system / OCPP server URL, the charge point identity and the authorisation key or password. Most chargers add the ID to the URL themselves; if yours doesn’t, use the full WebSocket address.</p>`;
  }
  Object.assign(VF.ACT, {
    'oc-retry': () => { O.error = ''; O.poll().then(() => VF.rerender()); },
    'oc-create': async () => {
      try { const op = VF.operator(VF.user(VF.session.userId).operatorId); const r = await call('createNetwork', { name: op ? op.name : 'My charging network' }); O.key = r.networkKey; O.name = r.name; persist(); VF.toast('Charging network created'); await O.poll(); VF.rerender(); }
      catch (e) { VF.toast(e.message); }
    },
    'oc-import': () => C.modal({ title: 'Use an access key', sub: 'Paste the network access key shared from another device.', submitLabel: 'Connect', body: C.field('Access key', '<input class="input mono" name="key" required autocomplete="off">'),
      onSubmit(d) { const k = String(d.key || '').trim(); if (!/^[A-Za-z0-9_-]{20,128}$/.test(k)) return 'That doesn’t look like an access key.'; O.key = k; O.data = null; persist(); O.poll().then(() => VF.rerender()); return null; } }),
    'oc-share': () => C.modal({ title: 'Network access key', sub: 'Anyone with this key can control the chargers in this network. Share it only with people who run them.', submitLabel: 'Done',
      body: `<div class="oc-detail"><div class="row nowrap"><code class="grow">${esc(O.key)}</code><button type="button" class="btn small" data-act="oc-copy" data-v="${esc(O.key)}">${icon('copy')}Copy</button></div></div><div class="card-actions"><button type="button" class="btn danger" data-act="oc-forget">${icon('log-out')}Remove from this device</button></div>`, onSubmit: () => null }),
    'oc-forget': async () => {
      if (!await C.confirm({ title: 'Remove the network from this device?', body: 'Chargers keep running and stay connected. You need the access key to manage them again.', confirmLabel: 'Remove', danger: true })) return;
      if (O.sim) { O.sim.stop(); O.sim = null; } O.key = null; O.data = null; persist(); VF.rerender();
    },
    'oc-copy': (el) => { try { navigator.clipboard.writeText(el.dataset.v).then(() => VF.toast('Copied'), () => VF.toast('Copy blocked: select and copy the text')); } catch (e) { VF.toast('Copy blocked: select and copy the text'); } },
    'oc-add': () => C.modal({ title: 'Add a charger', sub: 'Register the charger, then enter its connection details in the charger’s settings.', submitLabel: 'Add charger', body: `<div class="form-grid-2">
        ${C.field('Charge point ID', C.input('cpid', '', 'required maxlength="48" placeholder="ACC-AIRPORT-01" autocomplete="off"'), 'The identity set in the charger. Letters, numbers, dot, dash, underscore')}
        ${C.field('Name', C.input('label', '', 'maxlength="60" placeholder="Airport City DC 1"'))}
        ${C.field('Who can charge', C.select('authMode', [['open', 'Any card (open)'], ['list', 'Listed cards only']], 'open'))}</div>`,
      onSubmit(d) {
        const id = String(d.cpid || '').trim();
        if (!/^[A-Za-z0-9._-]{3,48}$/.test(id)) return 'Use 3–48 letters, numbers, dots, dashes or underscores.';
        call('addChargePoint', { key: O.key, id, label: d.label || id, authMode: d.authMode }).then((r) => {
          pwSet(r.id, r.password); O.simCp = r.id; O.poll().then(() => VF.rerender());
          C.modal({ title: 'Charger added', sub: 'Enter these details in the charger. The password is shown only once.', submitLabel: 'Done', body: connectionDetails(r.id, r.password), onSubmit: () => null });
        }).catch((e) => VF.toast(e.message));
        return null;
      } }),
    'oc-details': (el) => C.modal({ title: 'Connection details', submitLabel: 'Done', body: connectionDetails(el.dataset.id, pwGet(el.dataset.id) || null), onSubmit: () => null }),
    'oc-start': (el) => C.modal({ title: 'Start a session remotely', sub: `${el.dataset.id} · connector ${el.dataset.n}. The charger starts once a vehicle is plugged in.`, submitLabel: 'Start', body: C.field('Card or account ID (idTag)', C.input('idTag', 'VOLTFLEET-OPS', 'required maxlength="20" autocomplete="off"'), 'Charged to this card or account'),
      onSubmit(d) { const t = String(d.idTag || '').trim(); if (!t || t.length > 20) return 'Enter 1–20 characters.'; cmd(el.dataset.id, 'RemoteStartTransaction', { connectorId: +el.dataset.n, idTag: t }, 'Remote start'); return null; } }),
    'oc-stop': async (el) => { if (await C.confirm({ title: `Stop session #${el.dataset.tx}?`, body: 'Charging stops and the session is billed for the energy delivered so far.', confirmLabel: 'Stop session', danger: true })) cmd(el.dataset.id, 'RemoteStopTransaction', { transactionId: +el.dataset.tx }, 'Remote stop'); },
    'oc-unlock': async (el) => { if (await C.confirm({ title: `Unlock connector ${el.dataset.n}?`, body: 'Releases the cable. A session in progress on this connector ends.', confirmLabel: 'Unlock', icon: 'lock-open' })) cmd(el.dataset.id, 'UnlockConnector', { connectorId: +el.dataset.n }, 'Unlock'); },
    'oc-avail': async (el) => { const off = el.dataset.k === 'Inoperative'; if (!off || await C.confirm({ title: `Take connector ${el.dataset.n} out of service?`, body: 'Drivers can’t start sessions on it until you enable it again. A session in progress finishes first.', confirmLabel: 'Disable', danger: true })) cmd(el.dataset.id, 'ChangeAvailability', { connectorId: +el.dataset.n, type: el.dataset.k }, off ? 'Disable' : 'Enable'); },
    'oc-trigger': (el) => cmd(el.dataset.id, 'TriggerMessage', { requestedMessage: 'StatusNotification' }, 'Status refresh'),
    'oc-config': (el) => cmd(el.dataset.id, 'GetConfiguration', {}, 'Get configuration'),
    'oc-showcfg': (el) => { const c = O.data.commands.find((x) => String(x.id) === el.dataset.id); const keys = (c && c.result && c.result.configurationKey) || []; C.modal({ title: 'Charger configuration', sub: `${c ? c.cpId : ''} · ${keys.length} settings`, submitLabel: 'Done', body: C.table([{ label: 'Key', render: (k) => `<span class="mono small">${esc(k.key)}</span>` }, { label: 'Value', render: (k) => `<span class="mono small">${esc(k.value == null ? '' : String(k.value))}</span>` }, { label: '', render: (k) => (k.readonly ? '<span class="badge muted">read-only</span>' : '') }], keys.map((k, i) => Object.assign({ id: String(i) }, k))), onSubmit: () => null }); },
    'oc-reset': async (el) => { const ok = await C.confirm({ title: `Restart ${el.dataset.id}?`, body: 'A soft reset restarts the software and ends any session cleanly. If it stays stuck, power-cycle it on site.', confirmLabel: 'Soft reset', cancelLabel: 'Cancel', icon: 'rotate-ccw' }); if (ok) cmd(el.dataset.id, 'Reset', { type: 'Soft' }, 'Soft reset'); },
    'oc-limit': (el) => C.modal({ title: 'Power limit (smart charging)', sub: `Applies to new sessions on ${el.dataset.id}. Some chargers only accept amps.`, submitLabel: 'Apply limit', body: `<div class="form-grid-2">
        ${C.field('Limit', C.input('limit', 22, 'type="number" min="1" step="0.1" required'))}${C.field('Unit', C.select('unit', [['kW', 'kW (sent as watts)'], ['A', 'Amps per phase']], 'kW'))}
        ${C.field('Connector', C.select('connectorId', [['0', 'Whole charger']].concat(((O.data.chargePoints.find((c) => c.id === el.dataset.id) || {}).connectors || []).map((c) => [String(c.connectorId), `Connector ${c.connectorId}`])), '0'))}</div>
        <div class="card-actions"><button type="button" class="btn small ghost" data-act="oc-limit-clear" data-id="${esc(el.dataset.id)}">Remove limits</button></div>`,
      onSubmit(d) { const v = +d.limit; if (!(v > 0)) return 'Enter a limit above zero.'; cmd(el.dataset.id, 'SetPowerLimit', { connectorId: +d.connectorId, limit: d.unit === 'A' ? v : Math.round(v * 1000), unit: d.unit === 'A' ? 'A' : 'W' }, 'Power limit'); return null; } }),
    'oc-limit-clear': (el) => { C.closeDialog(); cmd(el.dataset.id, 'ClearChargingProfile', {}, 'Remove limits'); },
    'oc-settings': (el) => {
      const cp = O.data.chargePoints.find((c) => c.id === el.dataset.id);
      C.modal({ title: `Settings · ${cp.id}`, submitLabel: 'Save', body: `<div class="form-grid-2">${C.field('Name', C.input('label', cp.label, 'maxlength="60"'))}${C.field('Who can charge', C.select('authMode', [['open', 'Any card (open)'], ['list', 'Listed cards only']], cp.authMode))}</div>
          <div class="card-actions"><button type="button" class="btn small" data-act="oc-details" data-id="${esc(cp.id)}">${icon('link')}Connection details</button><button type="button" class="btn small" data-act="oc-rotate" data-id="${esc(cp.id)}">${icon('key')}New password</button><button type="button" class="btn small danger" data-act="oc-remove" data-id="${esc(cp.id)}">${icon('trash-2')}Remove charger</button></div>`,
        onSubmit(d) { call('updateChargePoint', { key: O.key, id: cp.id, label: d.label, authMode: d.authMode }).then(() => { VF.toast('Saved'); O.poll(); }).catch((e) => VF.toast(e.message)); return null; } });
    },
    'oc-rotate': async (el) => {
      if (!await C.confirm({ title: 'Create a new password?', body: 'The charger disconnects at its next reconnection until you enter the new password in it.', confirmLabel: 'New password', danger: true })) return;
      try { const r = await call('rotatePassword', { key: O.key, id: el.dataset.id }); pwSet(r.id, r.password); C.modal({ title: 'New charger password', sub: 'Shown only once.', submitLabel: 'Done', body: connectionDetails(r.id, r.password), onSubmit: () => null }); } catch (e) { VF.toast(e.message); }
    },
    'oc-remove': async (el) => {
      if (!await C.confirm({ title: `Remove ${el.dataset.id}?`, body: 'It is disconnected and its sessions, commands and message log are deleted. This can’t be undone.', confirmLabel: 'Remove charger', danger: true })) return;
      try { await call('removeChargePoint', { key: O.key, id: el.dataset.id }); if (O.sim && O.sim.id === el.dataset.id) { O.sim.stop(); O.sim = null; } VF.toast('Charger removed'); await O.poll(); VF.rerender(); } catch (e) { VF.toast(e.message); }
    },
    'oc-tag-add': () => C.modal({ title: 'Authorise a card', submitLabel: 'Add card', body: `<div class="form-grid-2">${C.field('Card or account ID (idTag)', C.input('idTag', '', 'required maxlength="20" autocomplete="off"'))}${C.field('Label', C.input('label', '', 'maxlength="40" placeholder="e.g. GreenLine fleet card 3"'))}</div>`,
      onSubmit(d) { const t = String(d.idTag || '').trim(); if (!t || t.length > 20) return 'Enter 1–20 characters.'; call('idTag', { key: O.key, idTag: t, label: d.label }).then(() => { VF.toast('Card authorised'); O.poll(); }).catch((e) => VF.toast(e.message)); return null; } }),
    'oc-tag-del': async (el) => { if (!await C.confirm({ title: 'Remove this card?', body: 'Chargers set to “listed cards only” will refuse it.', confirmLabel: 'Remove', danger: true })) return; call('idTag', { key: O.key, idTag: el.dataset.tag, remove: true }).then(() => O.poll()).catch((e) => VF.toast(e.message)); },
    'oc-sim-start': () => {
      const id = document.getElementById('oc-sim-cp').value; const pw = document.getElementById('oc-sim-pw').value.trim();
      if (!pw) { VF.toast('Enter the charger’s password, or create a new one in Settings.'); return; }
      pwSet(id, pw); O.simCp = id; O.simLog = [];
      const describe = (e) => (e.type === 'out' ? (e.data[0] === 2 ? `→ ${e.data[2]}` : e.data[0] === 3 ? '→ reply' : `→ error ${e.data[2]}`) : e.type === 'in' ? (e.data[0] === 2 ? `← ${e.data[2]} from VoltFleet` : null) : e.type === 'state' ? `State: ${e.data}` : e.type === 'closed' ? `Disconnected (${e.data.code})` : String(e.data));
      O.sim = new VF.SimCharger({ url: WS, id, password: pw, connectors: 2, kw: 60, meterEvery: 5000, onEvent: (e) => { if (e.type === 'state') O.simState = e.data; const t = describe(e); if (t) { O.simLog.push({ at: e.at, text: t }); if (O.simLog.length > 60) O.simLog.shift(); } } });
      O.sim.start(); VF.rerender();
    },
    'oc-sim-stop': () => { if (O.sim) O.sim.stop(); O.simState = 'offline'; VF.rerender(); },
    'oc-sim-plug': (el) => { if (O.sim) O.sim.plugIn(+el.dataset.n, 'SIM-CARD-01').catch((e) => VF.toast(e.message)); },
  });
  document.addEventListener('change', (e) => { if (e.target.id === 'oc-sim-cp') { O.simCp = e.target.value; const pw = document.getElementById('oc-sim-pw'); if (pw) pw.value = pwGet(O.simCp); } });
})();
