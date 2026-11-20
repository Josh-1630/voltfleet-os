// QA round 2: sync correctness against both server versions.
//   node qa2/sync-cas.js cas     -> rules of supabase/migrations/20261116_sync_cas.sql (compare-and-swap push, no lease on stale)
//   node qa2/sync-cas.js legacy  -> rules of the live functions (20261108_world_hardening.sql): push takes no expected revision
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright'); const fs = require('fs');
const FAKE = fs.readFileSync(FIX + '/fake-sync.js', 'utf8');
const MODE = process.argv[2] || 'cas';
const W = { rev: 0, state_gz: null, leader_id: null, leader_at: 0, updated_at: 0, writes: 0, pushes: 0, stale: 0, notLeader: 0, rejected: 0 };
const pages = [];
let results = 0, fails = 0;
const ok = (c, m) => { results++; if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const down = new Set();
const notify = () => { for (const p of pages) if (!p.isClosed() && !down.has(p)) p.evaluate((row) => { for (const cb of window.__rtSubs) cb({ new: row }); }, { rev: W.rev, state_gz: W.state_gz, leader_id: W.leader_id }).catch(() => {}); };
function srv(_src, op, a) {
  const now = Date.now();
  if (op === 'select') return { data: W.rev ? { rev: W.rev, state_gz: /state_gz/.test(a.cols) ? W.state_gz : undefined, leader_id: W.leader_id } : null, error: null };
  if (op === 'world_push') {
    if (MODE === 'legacy' && a.p_expected !== undefined) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.world_push(p_expected, p_id, p_state) in the schema cache' } };
    if (now - W.updated_at < 100) return { data: null, error: { message: 'too many writes, slow down' } };
    if (MODE === 'cas' && a.p_expected != null && a.p_expected !== W.rev) { W.rejected++; return { data: { ok: false, reason: 'stale', rev: W.rev }, error: null }; }
    W.rev++; W.state_gz = a.p_state; W.updated_at = now; W.pushes++; notify(); return { data: { ok: true, rev: W.rev }, error: null };
  }
  if (op === 'world_tick') {
    if (MODE === 'cas' && a.p_expected == null) return { data: null, error: { message: 'expected revision required' } };
    if (!W.rev) { W.rev = 1; W.state_gz = a.p_state; W.leader_id = a.p_client; W.leader_at = now; return { data: { ok: true, rev: 1, leader: true }, error: null }; }
    if (W.leader_id !== a.p_client && now - W.leader_at < 6000) { W.notLeader++; return { data: { ok: false, reason: 'not_leader', rev: W.rev, leader: false }, error: null }; }
    if (W.rev !== a.p_expected) {
      W.stale++;
      if (MODE === 'legacy') { W.leader_id = a.p_client; W.leader_at = now; return { data: { ok: false, reason: 'stale', rev: W.rev, leader: true }, error: null }; }
      return { data: { ok: false, reason: 'stale', rev: W.rev, leader: W.leader_id === a.p_client && now - W.leader_at < 6000 }, error: null };
    }
    if (MODE === 'cas' && W.leader_id === a.p_client && now - W.leader_at < 900) return { data: { ok: false, reason: 'too_fast', rev: W.rev, leader: true }, error: null };
    W.rev++; W.state_gz = a.p_state; W.leader_id = a.p_client; W.leader_at = now; W.updated_at = now; W.writes++; notify(); return { data: { ok: true, rev: W.rev, leader: true }, error: null };
  }
  return { data: null, error: { message: 'unknown ' + op } };
}
async function serverState(p) {
  return p.evaluate(async (t) => { const bin = atob(t.slice(3)); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return JSON.parse(await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'))).text()); }, W.state_gz);
}
(async () => {
  const b = await chromium.launch(); const errs = [];
  const mk = async (name) => {
    const ctx = await b.newContext({ serviceWorkers: 'block' }); await ctx.exposeBinding('__srv', srv);
    const p = await ctx.newPage(); p.name = name;
    p.on('pageerror', (e) => errs.push(name + ': ' + e.message));
    await p.route(/supabase-2\.118\.0\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE }));
    await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
    await p.goto('http://localhost:8080/?demo'); pages.push(p); return p;
  };
  const A = await mk('A'); await A.waitForTimeout(4000);
  const B = await mk('B'); await B.waitForTimeout(4000);
  console.log('mode', MODE, '| server rev', W.rev, '| A', await A.evaluate(() => JSON.stringify({ rev: VF.state.rev, st: VF.cloud.status, leader: VF.cloud.leader, cas: VF.cloud.cas })), '| B', await B.evaluate(() => JSON.stringify({ rev: VF.state.rev, st: VF.cloud.status, leader: VF.cloud.leader })));
  const names = (p, i, j) => p.evaluate(([i, j]) => [VF.state.fleet.vehicles[i].name, VF.state.fleet.vehicles[j].name].join(' / '), [i, j]);

  // 1. Two people act at the same moment on different records (R1-03)
  await Promise.all([
    A.evaluate(() => { VF.state.fleet.vehicles[2].name = 'Edited by A'; VF.save(); }),
    B.evaluate(() => { VF.state.fleet.vehicles[3].name = 'Edited by B'; VF.save(); }),
  ]);
  await A.waitForTimeout(5000);
  const srv1 = await serverState(A);
  const want = 'Edited by A / Edited by B';
  ok([srv1.fleet.vehicles[2].name, srv1.fleet.vehicles[3].name].join(' / ') === want, 'simultaneous edits: server keeps both (' + [srv1.fleet.vehicles[2].name, srv1.fleet.vehicles[3].name].join(' / ') + ')');
  ok(await names(A, 2, 3) === want && await names(B, 2, 3) === want, 'simultaneous edits: both devices show both');

  // 2. Both add a record at the same moment: ids come from the same counter (wallet top-ups are 'wt' + seq)
  await Promise.all([
    A.evaluate(() => { VF.state.fleet.depots.push({ id: 'dp' + (VF.state.fleet.seq++), name: 'Depot from A', node: VF.state.fleet.depots[0].node }); VF.save(); }),
    B.evaluate(() => { VF.state.fleet.depots.push({ id: 'dp' + (VF.state.fleet.seq++), name: 'Depot from B', node: VF.state.fleet.depots[0].node }); VF.save(); }),
  ]);
  await A.waitForTimeout(5000);
  const srv2 = await serverState(A); const dn = srv2.fleet.depots.map((d) => d.name);
  const ids = srv2.fleet.depots.map((d) => d.id);
  ok(dn.includes('Depot from A') && dn.includes('Depot from B') && new Set(ids).size === ids.length, 'simultaneous new records with the same counter id: both kept, ids unique (' + ids.slice(-2).join(', ') + ')');

  // 3. A drops off the network, both act, A comes back (R1-02 + offline edits)
  down.add(A); await A.evaluate(() => { window.__netDown = true; }); await A.waitForTimeout(12000);
  await A.evaluate(() => { VF.state.fleet.vehicles[4].name = 'Offline edit on A'; VF.save(); });
  await B.evaluate(() => { VF.state.fleet.vehicles[5].name = 'Edit on B while A offline'; VF.save(); });
  await A.waitForTimeout(12000);
  const aOff = await A.evaluate(() => ({ rev: VF.state.rev, st: VF.cloud.status, label: VF.cloud.label() }));
  ok(aOff.st === 'error' && aOff.rev <= W.rev, 'offline device does not invent revisions (A rev ' + aOff.rev + ', server ' + W.rev + ', label "' + aOff.label + '")');
  down.delete(A); await A.evaluate(() => { window.__netDown = false; }); await A.waitForTimeout(9000);
  const srv3 = await serverState(A);
  ok(srv3.fleet.vehicles[4].name === 'Offline edit on A' && srv3.fleet.vehicles[5].name === 'Edit on B while A offline', 'after reconnect the server has both the offline edit and the other device\'s edit');
  ok(await names(A, 4, 5) === 'Offline edit on A / Edit on B while A offline' && await names(B, 4, 5) === 'Offline edit on A / Edit on B while A offline', 'after reconnect both devices show both edits');
  const lab = await A.evaluate(() => VF.cloud.label());
  ok(lab === 'Synced across devices', 'A is synced again: "' + lab + '"');

  // 4. B leaves; A alone keeps the world moving (no freeze) (>= 4 in 20 s: a frozen world saves 0-1; CI machines are slow)
  await B.close(); pages.splice(pages.indexOf(B), 1);
  const w0 = W.writes, s0 = W.stale; await A.waitForTimeout(20000);
  const aRev = await A.evaluate(() => VF.state.rev);
  ok(W.writes - w0 >= 4 && aRev === W.rev, 'A alone: ' + (W.writes - w0) + ' simulation ticks saved in 20 s, ' + (W.stale - s0) + ' stale; A rev ' + aRev + ' = server ' + W.rev);

  // 5. A stuck old client (revision far ahead) keeps ticking. With the new rules it can't hold the lease.
  if (MODE === 'cas') {
    const stuck = setInterval(() => srv(null, 'world_tick', { p_client: 'old-client', p_expected: 999999, p_state: 'gz:x' }), 2000);
    const w1 = W.writes; await A.waitForTimeout(16000); clearInterval(stuck);
    ok(W.writes - w1 >= 5 && W.leader_id !== 'old-client', 'a stuck client with a stale revision can\'t freeze the world (' + (W.writes - w1) + ' ticks saved in 16 s)');
  }
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(`${results - fails}/${results} passed`);
  await b.close();
})();
