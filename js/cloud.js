/* VoltFleet OS — cross-device sync through Supabase.
   Every device shares one simulated world. One visible device leads: it runs the simulation and writes a
   compressed snapshot every 2 seconds through world_tick (a lease, so only one device leads at a time).
   User actions on any device are written at once through world_push. All devices subscribe to changes
   with Supabase Realtime (plus a light poll as a safety net) and adopt any newer revision.
   If Supabase can't be reached, the app keeps working on this device alone. */
'use strict';
(function () {
  const cfg = window.VOLTFLEET_CLOUD || {};
  const WORLD = 'demo';
  const CLIENT = 'c' + Math.random().toString(36).slice(2, 12);
  const TICK_MS = 2000, TAKEOVER_MS = 7000, POLL_MS = 5000;
  const cloud = VF.cloud = { status: 'off', leader: false, clientId: CLIENT, lastRemote: 0, region: cfg.region || '', error: '' };
  if (!cfg.url || !cfg.key || !window.supabase || typeof window.supabase.createClient !== 'function') return;

  let sb = null, inflightTick = false, lastTick = 0, pushing = false, pushQueued = false, adopting = Promise.resolve();
  const online = () => cloud.status === 'live' || cloud.status === 'live-poll';
  const setStatus = (s, err) => { if (cloud.status === s && !err) return; cloud.status = s; cloud.error = err || ''; if (VF.onCloudStatus) VF.onCloudStatus(); };

  // ---- compact snapshots: gzip + base64 (about 6x smaller than raw JSON)
  const hasGzip = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  function toB64(buf) {
    const bytes = new Uint8Array(buf); let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function pack(state) {
    const json = VF.stateJSON ? VF.stateJSON(state) : JSON.stringify(state);
    if (!hasGzip) return 'j:' + json;
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
    return 'gz:' + toB64(await new Response(stream).arrayBuffer());
  }
  async function unpack(text) {
    if (text.startsWith('j:')) return JSON.parse(text.slice(2));
    if (!hasGzip) throw new Error('This browser cannot read compressed snapshots');
    const bin = atob(text.slice(3)); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  // ---- reading
  async function fetchRow(cols) {
    const { data, error } = await sb.from('worlds').select(cols).eq('id', WORLD).maybeSingle();
    if (error) throw error;
    return data;
  }
  // Take a newer world from the server. Serialized so two updates never apply out of order.
  function adoptRow(row, force) {
    adopting = adopting.then(async () => {
      if (!row || row.rev == null) return;
      cloud.lastRemote = Date.now();
      if (row.leader_id && row.leader_id !== CLIENT) cloud.leader = false;
      if (!force && row.rev <= (VF.state.rev || 0)) return;
      let text = row.state_gz;
      if (!text) { const full = await fetchRow('rev,state_gz'); if (!full) return; row = full; text = full.state_gz; }
      const st = await unpack(text);
      if (!st || typeof st !== 'object' || st.version !== 2) return;
      VF.sanitizeState(st);
      if (!force && row.rev <= (VF.state.rev || 0)) return;
      st.rev = row.rev;
      VF.state = st;
      VF.saveLocal();
      if (VF.onRemoteState) VF.onRemoteState();
    }).catch((e) => console.warn('VoltFleet sync: could not apply update', e));
    return adopting;
  }

  // ---- writing
  // Leader: advance the shared world. Only succeeds from the latest revision, so a user action is never overwritten.
  cloud.saveTick = async function () {
    VF.saveLocal();
    if (!online() || inflightTick || Date.now() - lastTick < TICK_MS) return;
    lastTick = Date.now(); inflightTick = true;
    try {
      const expected = VF.state.rev || 0;
      const text = await pack(VF.state);
      const { data, error } = await sb.rpc('world_tick', { p_id: WORLD, p_client: CLIENT, p_expected: expected, p_state: text });
      if (error) throw error;
      cloud.leader = !!data.leader;
      if (data.ok) { if ((VF.state.rev || 0) === expected) VF.state.rev = data.rev; cloud.lastRemote = Date.now(); }
      else if (data.reason === 'stale') await adoptRow(await fetchRow('rev,state_gz,leader_id'));
    } catch (e) { fail(e); } finally { inflightTick = false; }
  };
  // Any device: publish a user action (booking, cancellation, consent change...) right away.
  cloud.push = async function () {
    VF.saveLocal();
    if (!online()) return;
    pushQueued = true;
    if (pushing) return;
    pushing = true;
    try {
      while (pushQueued) {
        pushQueued = false;
        const text = await pack(VF.state);
        let res = await sb.rpc('world_push', { p_id: WORLD, p_state: text });
        for (let i = 0; i < 5 && res.error && /slow down/i.test(res.error.message || ''); i++) { await new Promise((r) => setTimeout(r, 150 + i * 100)); res = await sb.rpc('world_push', { p_id: WORLD, p_state: text }); } // server throttles floods
        const { data, error } = res;
        if (error) throw error;
        VF.state.rev = Math.max(VF.state.rev || 0, data.rev);
      }
    } catch (e) { fail(e); } finally { pushing = false; }
  };
  // Should this device run the simulation? null means "not connected, decide locally".
  cloud.leads = function () {
    if (!online()) return null;
    if (cloud.leader) return true;
    return Date.now() - cloud.lastRemote > TAKEOVER_MS;
  };

  function fail(e) {
    console.warn('VoltFleet sync:', e && e.message ? e.message : e);
    setStatus('error', 'Sync paused: ' + (e && e.message ? e.message : 'network error') + '. Working on this device only.');
  }

  cloud.start = async function () {
    setStatus('connecting');
    try {
      sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      const row = await fetchRow('rev,state_gz,leader_id');
      if (row && row.state_gz) await adoptRow(row, true);
      else {
        // First device ever: publish this device's world as the shared one.
        VF.state.rev = 0;
        const { data, error } = await sb.rpc('world_tick', { p_id: WORLD, p_client: CLIENT, p_expected: 0, p_state: await pack(VF.state) });
        if (error) throw error;
        VF.state.rev = data.rev; cloud.leader = !!data.leader;
      }
      cloud.lastRemote = 0; // try to lead straight away; the lease decides
      sb.channel('world-' + WORLD)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'worlds', filter: 'id=eq.' + WORLD }, (p) => adoptRow(p.new))
        .subscribe((s) => { if (s === 'SUBSCRIBED') setStatus('live'); else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') setStatus('live-poll'); });
      setStatus('live');
    } catch (e) { fail(e); }
    // Safety net: catch anything Realtime missed, and recover after a network drop.
    setInterval(async () => {
      if (!sb || document.hidden) return;
      try {
        const r = await fetchRow('rev,leader_id');
        if (cloud.status === 'error') setStatus('live');
        if (r && r.rev > (VF.state.rev || 0)) adoptRow(Object.assign(r, { state_gz: null }));
      } catch (e) { if (cloud.status !== 'error') fail(e); }
    }, POLL_MS);
  };
  cloud.online = online;
  cloud.label = () => ({ live: 'Synced across devices', 'live-poll': 'Synced across devices', connecting: 'Connecting…', error: 'This device only', off: 'This device only' }[cloud.status]);
})();
