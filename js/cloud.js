/* VoltFleet OS — cross-device sync through Supabase.
   Every device shares one world: the public demo, or (signed in) the organisation's private workspace.
   One visible device leads: it runs the simulation and writes a compressed snapshot every 2 seconds through
   *_tick (a lease, so only one device leads at a time). User actions on any device are written at once through
   *_push. All devices subscribe to changes with Supabase Realtime (plus a light poll as a safety net).

   Consistency rules (QA round 2):
   - VF.state.rev only ever holds a revision the server gave us for the current target. Nothing is counted up
     locally, so a device can never run ahead of the server and stop syncing.
   - Every write names the revision it was based on (compare-and-swap). When someone else wrote first, the
     device fetches the newer world and re-applies its own pending actions on top (each action is recorded as a
     small patch of what it changed), then tries again. Nobody's change is overwritten by a stale snapshot.
   - Each start() is a new "generation": the previous channel and poll are torn down, and anything still in
     flight for the previous target (the demo, say) is dropped instead of landing in the new one.
   - Reads, adoptions and writes run one at a time in a queue, so an update never interleaves with a write.
   If Supabase can't be reached, the app keeps working on this device alone and catches up when it's back. */
'use strict';
(function () {
  const cfg = window.VOLTFLEET_CLOUD || {};
  const WORLD = 'demo';
  const CLIENT = 'c' + Math.random().toString(36).slice(2, 12);
  const TICK_MS = 2000, TAKEOVER_MS = 7000, POLL_MS = 5000, LITE_POLL_MS = 45000, LOCAL_SAVE_MS = 5000;
  const cloud = VF.cloud = { status: 'off', leader: false, clientId: CLIENT, lastRemote: 0, region: cfg.region || '', error: '', cas: null, pending: 0 };

  // ---------------------------------------------------------------- patches (pure; also used by the tests)
  // A patch is the list of changes one user action made, so it can be re-applied on top of a newer world.
  // Arrays of records with an `id` are diffed record by record; other arrays as prepend/append or whole values.
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  function same(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false; return true; }
    const ka = Object.keys(a), kb = Object.keys(b); if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !same(a[k], b[k])) return false;
    return true;
  }
  const idOf = (x) => (isObj(x) && (typeof x.id === 'string' || typeof x.id === 'number') ? String(x.id) : null);
  function idArray(arr) { const seen = new Set(); for (const x of arr) { const id = idOf(x); if (id === null || seen.has(id)) return false; seen.add(id); } return true; }
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function diff(a, b, path, out) {
    path = path || []; out = out || [];
    if (same(a, b)) return out;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (idArray(a) && idArray(b)) {
        const ia = new Map(a.map((x) => [idOf(x), x])), ib = new Set(b.map(idOf));
        for (const [id] of ia) if (!ib.has(id)) out.push({ o: 'rm', p: path, id });
        b.forEach((x, i) => { const id = idOf(x); if (ia.has(id)) diff(ia.get(id), x, path.concat([{ id }]), out); else out.push({ o: 'ins', p: path, v: clone(x), after: i ? idOf(b[i - 1]) : null }); });
        return out;
      }
      const ea = a.map((x) => JSON.stringify(x)), eb = b.map((x) => JSON.stringify(x));
      if (ea.length) { // new items at the front (newest-first logs), possibly trimmed at the end
        const k = eb.indexOf(ea[0]);
        if (k > 0 && eb.slice(k).every((s, i) => s === ea[i])) { out.push({ o: 'pre', p: path, v: clone(b.slice(0, k)), cap: b.length < a.length + k ? b.length : null }); return out; }
        if (eb.length > ea.length && ea.every((s, i) => s === eb[i])) { out.push({ o: 'app', p: path, v: clone(b.slice(a.length)) }); return out; }
      }
      out.push({ o: 'set', p: path, v: clone(b) }); return out;
    }
    if (isObj(a) && isObj(b)) {
      for (const k of Object.keys(a)) if (!Object.prototype.hasOwnProperty.call(b, k)) out.push({ o: 'del', p: path.concat([k]) });
      for (const k of Object.keys(b)) { if (!path.length && k === 'rev') continue; if (Object.prototype.hasOwnProperty.call(a, k)) diff(a[k], b[k], path.concat([k]), out); else out.push({ o: 'set', p: path.concat([k]), v: clone(b[k]) }); }
      return out;
    }
    out.push({ o: 'set', p: path, v: clone(b) }); return out;
  }
  // Apply a patch to a (newer) world in place. Changes to records that are gone there are skipped. A record this
  // device created whose id was meanwhile taken by someone else's new record gets a new id (ids come from counters).
  function apply(root, patch, ren) {
    ren = ren || new Map();
    const rename = (v) => { if (!ren.size) return v; if (typeof v === 'string') return ren.has(v) ? ren.get(v) : v; if (Array.isArray(v)) return v.map(rename); if (isObj(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = rename(v[k]); return o; } return v; };
    const step = (cur, seg) => { if (cur == null || typeof cur !== 'object') return undefined; if (isObj(seg)) { const want = ren.get(seg.id) || seg.id; return Array.isArray(cur) ? cur.find((x) => idOf(x) === want) : undefined; } return Object.prototype.hasOwnProperty.call(cur, seg) ? cur[seg] : undefined; };
    const walk = (p) => { let cur = root; for (const seg of p) { cur = step(cur, seg); if (cur === undefined) return undefined; } return cur; };
    for (const op of patch) {
      if (op.o === 'ins' || op.o === 'rm' || op.o === 'pre' || op.o === 'app') {
        const arr = walk(op.p); if (!Array.isArray(arr)) continue;
        if (op.o === 'rm') { const want = ren.get(op.id) || op.id; const i = arr.findIndex((x) => idOf(x) === want); if (i >= 0) arr.splice(i, 1); continue; }
        if (op.o === 'pre' || op.o === 'app') {
          const items = rename(clone(op.v)); const k = items.length;
          const at = op.o === 'pre' ? arr.slice(0, k) : arr.slice(arr.length - k);
          if (k && at.length === k && same(at, items)) continue; // already there (applied twice)
          if (op.o === 'pre') { arr.unshift(...items); if (op.cap != null && arr.length > op.cap) arr.length = op.cap; } else arr.push(...items);
          continue;
        }
        let item = rename(clone(op.v)); const id = idOf(item);
        const there = arr.find((x) => idOf(x) === id);
        if (there) { if (same(there, item)) continue; const nid = id + '-' + CLIENT.slice(1, 5); ren.set(id, nid); item = rename(item); item.id = nid; }
        const after = op.after == null ? null : (ren.get(op.after) || op.after);
        const at = after == null ? 0 : arr.findIndex((x) => idOf(x) === after) + 1;
        arr.splice(after != null && at === 0 ? arr.length : at, 0, item);
        continue;
      }
      const parent = walk(op.p.slice(0, -1)); const last = op.p[op.p.length - 1];
      if (!op.p.length || parent == null || typeof parent !== 'object' || isObj(last)) {
        if (isObj(last) && Array.isArray(parent) && op.o === 'set') { const i = parent.findIndex((x) => idOf(x) === (ren.get(last.id) || last.id)); if (i >= 0) parent[i] = rename(clone(op.v)); }
        continue;
      }
      if (op.o === 'del') { delete parent[last]; continue; }
      let v = rename(clone(op.v));
      if (last === 'seq' && typeof v === 'number' && typeof parent[last] === 'number') v = Math.max(v, parent[last]); // id counters only move forward
      parent[last] = v;
    }
    return ren;
  }
  VF.syncPatch = { diff, apply, same };

  if (!cfg.url || !cfg.key || !window.supabase || typeof window.supabase.createClient !== 'function') return;

  // ---------------------------------------------------------------- per-target state
  let sb = null, gen = 0, target = null, channel = null, pollTimer = null;
  // QA R1-09: subscribe to the small head row (revision, lease holder) instead of the full snapshot, and download the
  // snapshot only when the revision is new to this device. null: not checked yet; false: the server doesn't have the
  // head tables (migration 20261117_world_heads.sql not applied), so the full row is streamed as before.
  let heads = null;
  let base = null;      // { rev, json }: the last world confirmed by the server (rev null: not confirmed yet)
  let pending = [];     // patches of this device's actions the server hasn't confirmed yet
  let lastJSON = null;  // the world as of the last sync point, to isolate what one action changed
  let lastTick = 0, lastLocal = 0, pushScheduled = false, tickBusy = false;
  let chain = Promise.resolve();
  const queue = (fn) => { const g = gen; chain = chain.then(() => (g === gen ? fn(g) : null)).catch((e) => { if (g === gen) fail(e); }); return chain; };
  const T = () => {
    const org = target && target.org;
    return org
      ? { key: 'org:' + org, table: 'org_worlds', heads: 'org_world_heads', col: 'org_id', id: org,
        tick: (c, e, s) => sb.rpc('org_world_tick', { p_client: c, p_expected: e, p_state: s }),
        push: (s, e) => sb.rpc('org_world_push', e === undefined ? { p_state: s } : { p_state: s, p_expected: e }) }
      : { key: 'world:' + WORLD, table: 'worlds', heads: 'world_heads', col: 'id', id: WORLD,
        tick: (c, e, s) => sb.rpc('world_tick', { p_id: WORLD, p_client: c, p_expected: e, p_state: s }),
        push: (s, e) => sb.rpc('world_push', e === undefined ? { p_id: WORLD, p_state: s } : { p_id: WORLD, p_state: s, p_expected: e }) };
  };
  const online = () => cloud.status === 'live' || cloud.status === 'live-poll';
  const lite = () => !!(VF.lite && VF.lite.get && VF.lite.get());
  const setStatus = (s, err) => { if (cloud.status === s && !err) return; cloud.status = s; cloud.error = err || ''; if (VF.onCloudStatus) VF.onCloudStatus(); };
  const writeLocal = (json) => { try { localStorage.setItem(VF.STORE_KEY, '{"state":' + json + '}'); VF.storageOk = true; } catch (e) { VF.storageOk = false; } lastLocal = Date.now(); try { sessionStorage.setItem('voltfleet-os:session', JSON.stringify(VF.session || null)); } catch (e) { /* per-tab sign-in not kept */ } };

  // ---- compact snapshots: gzip + base64 (about 6x smaller than raw JSON)
  const hasGzip = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  function toB64(buf) {
    const bytes = new Uint8Array(buf); let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function pack(json) {
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

  // ---------------------------------------------------------------- reading
  async function fetchRow(t, cols) {
    const { data, error } = await sb.from(t.table).select(cols).eq(t.col, t.id).maybeSingle();
    if (error) throw error;
    return data;
  }
  // Take the server's world. Runs inside the queue. `force`: adopt even if not newer (the server is the truth).
  async function adopt(g, t, row, force) {
    if (g !== gen || !row || row.rev == null) return;
    cloud.lastRemote = Date.now();
    if (row.leader_id && row.leader_id !== CLIENT) cloud.leader = false;
    const known = base && base.rev != null;
    if (!force && known && row.rev <= base.rev) return;
    let text = row.state_gz;
    if (!text) { const full = await fetchRow(t, 'rev,state_gz,leader_id'); if (g !== gen || !full || !full.state_gz) return; row = full; text = full.state_gz; }
    const st = await unpack(text);
    if (g !== gen || !st || typeof st !== 'object' || st.version !== 2) return;
    if (!force && base && base.rev != null && row.rev <= base.rev) return;
    VF.sanitizeState(st); st.rev = row.rev;
    if (VF.repairState && !VF.repairState(st)) {
      // Unusable world (core lists missing). Keep ours and take its revision, so our next write replaces it.
      console.warn('VoltFleet sync: ignored a malformed world, rev ' + row.rev);
      base = { rev: row.rev, json: VF.stateJSON(VF.state) }; VF.state.rev = row.rev; return;
    }
    const json = VF.stateJSON(st);
    base = { rev: row.rev, json };
    let next = st;
    if (pending.length) { // re-apply this device's unconfirmed actions on top of the newer world
      next = JSON.parse(json); const ren = new Map();
      for (const p of pending) apply(next, p, ren);
      next.rev = row.rev;
    }
    VF.state = next;
    let changed = false;
    if (target.onAdopt) try { changed = !!target.onAdopt(); } catch (e) { /* keep going */ }
    lastJSON = VF.stateJSON(VF.state);
    if (changed && !pending.length) { pending.push(diff(JSON.parse(json), JSON.parse(lastJSON))); } // e.g. this account's name in a team workspace
    cloud.pending = pending.length;
    // The server holds this world, so the local copy is only refreshed every few seconds (QA R1-09), except when
    // it carries changes the server doesn't have yet.
    if (pending.length || Date.now() - lastLocal >= LOCAL_SAVE_MS) writeLocal(lastJSON);
    if (VF.onRemoteState) VF.onRemoteState();
    if (pending.length && online()) schedulePush();
  }

  // ---------------------------------------------------------------- writing
  const missingFn = (e) => /PGRST202|could not find the function|schema cache|does not exist/i.test((e && (e.code + ' ' + e.message + ' ' + (e.details || ''))) || '');
  async function rpcRetry(call) { // the server throttles floods
    let res = await call();
    for (let i = 0; i < 5 && res.error && /slow down/i.test(res.error.message || ''); i++) { await new Promise((r) => setTimeout(r, 150 + i * 100)); res = await call(); }
    return res;
  }
  async function pushRpc(t, text, expected) {
    if (cloud.cas !== false) {
      const res = await rpcRetry(() => t.push(text, expected));
      if (!(res.error && missingFn(res.error))) { if (!res.error) cloud.cas = true; return res; }
      cloud.cas = false; // the server doesn't take an expected revision yet (migration 20261116_sync_cas.sql not applied)
    }
    // Older server: check the revision first, so a stale world isn't written over someone else's change.
    const head = await fetchRow(t, 'rev');
    if (head && head.rev !== expected) return { data: { ok: false, reason: 'stale', rev: head.rev }, error: null };
    return rpcRetry(() => t.push(text));
  }
  // One write (a user action, or the leader's simulation step), based on the last confirmed revision.
  async function write(g, kind) {
    const t = T();
    for (let attempt = 0; attempt < 6; attempt++) {
      if (g !== gen || !online()) return;
      if (kind === 'push' && !pending.length) return;
      if (!base || base.rev == null) { await adopt(g, t, await fetchRow(t, 'rev,state_gz,leader_id'), true); if (!base || base.rev == null) return; continue; }
      const n = pending.length, expected = base.rev;
      const json = VF.stateJSON(VF.state);
      lastJSON = json; // every earlier action is already recorded in `pending`
      const text = await pack(json);
      if (g !== gen) return;
      const res = kind === 'tick' ? await t.tick(CLIENT, expected, text) : await pushRpc(t, text, expected);
      if (g !== gen) return;
      if (res.error) throw res.error;
      const d = res.data || {};
      if (kind === 'tick') cloud.leader = !!d.leader;
      if (d.ok) {
        base = { rev: d.rev, json }; VF.state.rev = d.rev; pending.splice(0, n); cloud.pending = pending.length;
        cloud.lastRemote = Date.now();
        if (kind === 'tick' || !pending.length) return;
        continue;
      }
      if (d.reason === 'stale') { await adopt(g, t, await fetchRow(t, 'rev,state_gz,leader_id'), true); if (kind === 'tick') return; continue; }
      return; // not_leader / too_fast: someone else is running the simulation
    }
  }
  function schedulePush() { if (pushScheduled) return; pushScheduled = true; queue((g) => { pushScheduled = false; return write(g, 'push'); }); }

  // Leader: advance the shared world (called by the app loop every second while this device leads).
  cloud.saveTick = function () {
    if (!target) return;
    const now = Date.now();
    if (!online()) { if (now - lastLocal >= LOCAL_SAVE_MS) { lastJSON = VF.stateJSON(VF.state); writeLocal(lastJSON); } return; } // offline simulation isn't an action
    if (tickBusy || now - lastTick < (lite() ? LITE_POLL_MS : TICK_MS)) return;
    lastTick = now; tickBusy = true;
    queue((g) => write(g, 'tick')).then(() => { tickBusy = false; if (Date.now() - lastLocal >= LOCAL_SAVE_MS) writeLocal(VF.stateJSON(VF.state)); });
  };
  // Any device: record a user action (booking, cancellation, consent change...) and publish it right away.
  cloud.push = function () {
    if (!target) return;
    const json = VF.stateJSON(VF.state);
    try { const p = diff(JSON.parse(lastJSON || json), JSON.parse(json)); if (p.length) pending.push(p); } catch (e) { /* nothing to record */ }
    lastJSON = json; cloud.pending = pending.length;
    writeLocal(json);
    if (online()) schedulePush();
  };
  cloud.active = () => !!target;
  // Should this device run the simulation? null means "not connected, decide locally".
  cloud.leads = function () {
    if (!target || !online()) return null;
    if (lite()) return false; // low-data mode: follow, don't upload the world every 2 seconds
    if (cloud.leader) return true;
    return Date.now() - cloud.lastRemote > TAKEOVER_MS;
  };

  function fail(e) {
    console.warn('VoltFleet sync:', e && e.message ? e.message : e);
    setStatus('error', 'Sync paused: ' + (e && e.message ? e.message : 'network error') + '. Working on this device only.');
  }

  // ---------------------------------------------------------------- live updates
  function subscribe(g) {
    unsubscribe();
    if (g !== gen || lite() || document.hidden) return; // hidden tabs and low-data mode poll instead of streaming
    const t = T(); const small = heads === true;
    channel = sb.channel('world-' + t.id + '-' + g)
      .on('postgres_changes', { event: '*', schema: 'public', table: small ? t.heads : t.table, filter: `${t.col}=eq.${t.id}` }, (p) => {
        if (g !== gen || !p || !p.new) return;
        // Head events carry no snapshot: adopt() fetches it, and only if the revision is newer than ours.
        queue((g2) => adopt(g2, t, small ? Object.assign({}, p.new, { state_gz: null }) : p.new, false));
      })
      .subscribe((s) => { if (g !== gen) return; if (s === 'SUBSCRIBED') { if (cloud.status !== 'error') setStatus('live'); } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') setStatus('live-poll'); });
  }
  function unsubscribe() { if (channel) { const ch = channel; channel = null; try { if (sb && sb.removeChannel) sb.removeChannel(ch); else if (ch.unsubscribe) ch.unsubscribe(); } catch (e) { /* gone */ } } }
  let lastPoll = 0;
  async function poll(g) {
    if (g !== gen || !sb || document.hidden) return;
    if (lite() && Date.now() - lastPoll < LITE_POLL_MS) return;
    lastPoll = Date.now();
    const t = T();
    try {
      const r = await fetchRow(t, 'rev,leader_id');
      if (g !== gen) return;
      // A workspace that is no longer readable (this person was removed from the team): let the app react.
      if (!r && target.org && base && base.rev != null && target.onGone) { if (!(Date.now() - (target.goneAt || 0) < 60000)) { target.goneAt = Date.now(); target.onGone(); } return; }
      if (cloud.status === 'error' || cloud.status === 'connecting') { setStatus(channel && !lite() ? 'live' : 'live-poll'); if (!channel) subscribe(g); }
      const known = base && base.rev != null;
      if (r && (!known || r.rev !== base.rev)) queue((g2) => adopt(g2, t, Object.assign(r, { state_gz: null }), !known || r.rev < base.rev));
      if (pending.length) schedulePush();
    } catch (e) { if (cloud.status !== 'error') fail(e); }
  }
  document.addEventListener('visibilitychange', () => { if (!target || !sb) return; if (document.hidden) unsubscribe(); else { subscribe(gen); lastPoll = 0; poll(gen); } });
  cloud.liteChanged = () => { if (!target || !sb) return; subscribe(gen); lastPoll = 0; poll(gen); };

  // ---------------------------------------------------------------- start (or switch target)
  cloud.start = async function (opts) {
    const g = ++gen;
    unsubscribe(); if (pollTimer) clearInterval(pollTimer); pollTimer = null;
    chain = Promise.resolve(); pushScheduled = false; tickBusy = false; lastTick = 0;
    target = { org: opts && opts.org ? opts.org : null, onAdopt: opts && opts.onAdopt, onGone: opts && opts.onGone };
    const json = VF.stateJSON(VF.state);
    base = { rev: null, json }; pending = []; lastJSON = json; cloud.pending = 0;
    cloud.leader = false; cloud.lastRemote = 0;
    setStatus('connecting');
    const t = T();
    try {
      sb = VF.sb || sb || window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      if (heads === null) { try { const h = await sb.from(t.heads).select('rev').eq(t.col, t.id).maybeSingle(); heads = !(h && h.error) ? true : /42P01|PGRST205|does not exist|schema cache/i.test((h.error.code || '') + ' ' + (h.error.message || '')) ? false : null; } catch (e) { heads = null; } }
      if (g !== gen) return;
      const row = await fetchRow(t, 'rev,state_gz,leader_id');
      if (g !== gen) return;
      if (row && row.state_gz) await queue((g2) => adopt(g2, t, row, true));
      else {
        // First device ever: publish this device's world as the shared one.
        const expected = row && row.rev != null ? row.rev : 0;
        const { data, error } = await t.tick(CLIENT, expected, await pack(VF.stateJSON(VF.state)));
        if (g !== gen) return;
        if (error) throw error;
        if (data.ok) { base = { rev: data.rev, json: VF.stateJSON(VF.state) }; VF.state.rev = data.rev; cloud.leader = !!data.leader; }
        else await queue(async (g2) => adopt(g2, t, await fetchRow(t, 'rev,state_gz,leader_id'), true));
      }
      if (g !== gen) return;
      cloud.lastRemote = 0; // try to lead straight away; the lease decides
      setStatus(lite() ? 'live-poll' : 'live');
      subscribe(g);
      if (pending.length) schedulePush();
    } catch (e) { if (g === gen) fail(e); }
    // Safety net: catch anything Realtime missed, and recover after a network drop.
    if (g === gen) pollTimer = setInterval(() => poll(g), POLL_MS);
  };
  cloud.online = online;
  cloud.label = () => {
    if (online() && pending.length) return 'Saving…';
    if (cloud.status === 'error' && pending.length) return 'Offline · changes kept on this device';
    return ({ live: 'Synced across devices', 'live-poll': lite() ? 'Synced (low-data)' : 'Synced across devices', connecting: 'Connecting…', error: 'This device only', off: 'This device only' }[cloud.status]);
  };
})();
