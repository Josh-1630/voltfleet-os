// QA round 3 (R1-09): how many snapshot bytes reach each tab, with and without the world_heads table
// (supabase/migrations/20261117_world_heads.sql). Two demo tabs for 30 s; the fake server keeps per-table Realtime
// subscriptions and counts the state_gz bytes it hands to each tab (Realtime messages plus reads).
//   node qa3/heads.js            -> both modes, prints a comparison and checks that sync still works
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright');
const RUN_MS = 30000;
const FAKE = `(function () {
  window.__subs = [];
  const call = (op, a) => window.__srv(op, a);
  window.supabase = { createClient() { return {
    auth: { async getSession() { return { data: { session: null }, error: null }; }, onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; }, mfa: { async getAuthenticatorAssuranceLevel() { return { data: null }; } } },
    async rpc(fn, a) { return call(fn, a); },
    from(table) { const q = { select(c) { q.c = c; return q; }, eq() { return q; }, order() { return q; }, limit() { return Promise.resolve({ data: [], error: null }); }, async maybeSingle() { return call('select', { table, cols: q.c }); } }; return q; },
    channel(name) { const ch = { on(_t, f, cb) { window.__subs.push({ table: f.table, cb, ch }); return ch; }, subscribe(cb) { setTimeout(() => cb && cb('SUBSCRIBED'), 0); return ch; } }; return ch; },
    removeChannel(ch) { window.__subs = window.__subs.filter((s) => s.ch !== ch); },
  }; } };
})();`;
async function run(mode) {
  const W = { rev: 0, state_gz: null, leader_id: null, leader_at: 0, updated_at: 0 };
  const bytes = new Map(); const pages = [];
  const add = (p, n) => bytes.set(p.name, (bytes.get(p.name) || 0) + n);
  const notify = () => {
    for (const p of pages) if (!p.isClosed()) {
      p.evaluate((row) => { for (const s of window.__subs) if (s.table === 'worlds') s.cb({ new: row.full }); else if (s.table === 'world_heads') s.cb({ new: row.head }); return window.__subs.map((s) => s.table); },
        { full: { id: 'demo', rev: W.rev, state_gz: W.state_gz, leader_id: W.leader_id }, head: { id: 'demo', rev: W.rev, leader_id: W.leader_id } })
        .then((tables) => { if (tables.includes('worlds')) add(p, W.state_gz.length); }).catch(() => {});
    }
  };
  const srv = (src, op, a) => {
    const p = src.page; const now = Date.now();
    if (op === 'select') {
      if (a.table === 'world_heads' && mode === 'noheads') return { data: null, error: { code: '42P01', message: 'relation "public.world_heads" does not exist' } };
      if (!W.rev) return { data: null, error: null };
      const withState = a.table === 'worlds' && /state_gz/.test(a.cols || '');
      if (withState) add(p, W.state_gz.length);
      return { data: { rev: W.rev, state_gz: withState ? W.state_gz : undefined, leader_id: W.leader_id }, error: null };
    }
    if (op === 'world_push') {
      if (now - W.updated_at < 100) return { data: null, error: { message: 'too many writes, slow down' } };
      if (a.p_expected != null && a.p_expected !== W.rev) return { data: { ok: false, reason: 'stale', rev: W.rev }, error: null };
      W.rev++; W.state_gz = a.p_state; W.updated_at = now; notify(); return { data: { ok: true, rev: W.rev }, error: null };
    }
    if (op === 'world_tick') {
      if (!W.rev) { W.rev = 1; W.state_gz = a.p_state; W.leader_id = a.p_client; W.leader_at = now; return { data: { ok: true, rev: 1, leader: true }, error: null }; }
      const holds = W.leader_id === a.p_client && now - W.leader_at < 6000;
      if (!holds && W.leader_id && now - W.leader_at < 6000) return { data: { ok: false, reason: 'not_leader', rev: W.rev, leader: false }, error: null };
      if (W.rev !== a.p_expected) return { data: { ok: false, reason: 'stale', rev: W.rev, leader: holds }, error: null };
      if (holds && now - W.leader_at < 900) return { data: { ok: false, reason: 'too_fast', rev: W.rev, leader: true }, error: null };
      W.rev++; W.state_gz = a.p_state; W.leader_id = a.p_client; W.leader_at = now; W.updated_at = now; notify(); return { data: { ok: true, rev: W.rev, leader: true }, error: null };
    }
    return { data: null, error: { message: 'unknown ' + op } };
  };
  const b = await chromium.launch(); const errs = [];
  const mk = async (name) => {
    const ctx = await b.newContext({ serviceWorkers: 'block' }); await ctx.exposeBinding('__srv', srv);
    const p = await ctx.newPage(); p.name = name; p.on('pageerror', (e) => errs.push(name + ': ' + e.message));
    await p.route(/supabase-2\.118\.0\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE }));
    await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
    pages.push(p); await p.goto('http://localhost:8080/?demo'); return p;
  };
  const A = await mk('A'); await A.waitForTimeout(3000); const B = await mk('B'); await B.waitForTimeout(3000);
  bytes.clear(); const rev0 = W.rev;
  await A.waitForTimeout(RUN_MS / 2);
  await B.evaluate(() => { VF.state.fleet.vehicles[1].name = 'Edited on B'; VF.save(); });
  await A.waitForTimeout(RUN_MS / 2);
  const leader = await A.evaluate(() => VF.cloud.leader) ? 'A' : 'B';
  const seen = await A.evaluate(() => VF.state.fleet.vehicles[1].name);
  const subs = await A.evaluate(() => window.__subs.map((s) => s.table).join(','));
  const r = { mode, writes: W.rev - rev0, leader, subscribedTo: subs, kB: Object.fromEntries([...bytes].map(([k, v]) => [k, Math.round(v / 1024)])), aSeesB: seen === 'Edited on B', errs };
  await b.close(); return r;
}
(async () => {
  const off = await run('noheads'); const on = await run('heads');
  console.log(JSON.stringify(off)); console.log(JSON.stringify(on));
  const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
  const lead = (r) => r.kB[r.leader] || 0; const follow = (r) => r.kB[r.leader === 'A' ? 'B' : 'A'] || 0;
  ok(off.subscribedTo === 'worlds' && on.subscribedTo === 'world_heads', 'subscribes to world_heads when the server has it, else to the full row (deploy order free)');
  ok(off.aSeesB && on.aSeesB && !off.errs.length && !on.errs.length, 'sync still works in both modes, no page errors');
  ok(lead(on) * 4 < Math.max(1, lead(off)), `leader no longer downloads its own writes: ${lead(off)} kB -> ${lead(on)} kB in ${RUN_MS / 1000} s`);
  ok(follow(on) <= follow(off) * 1.2 + 20, `follower downloads about the same (it needs every step to show it): ${follow(off)} kB -> ${follow(on)} kB`);
})();
