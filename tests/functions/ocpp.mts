// QA round 3: OCPP Edge Function (management API + charger session) against an in-memory store.
import { handleRequest, LIMITS, sha256 } from '../../supabase/functions/ocpp/server.ts';
import { ChargerSession, MAX_CONNECTOR } from '../../supabase/functions/ocpp/csms.ts';
const ok = (c: any, m: string) => console.log((c ? 'PASS ' : 'FAIL ') + m);
let now = Date.parse('2026-11-17T12:00:00Z');
const mem: any = { nets: [] as any[], cps: new Map(), conns: new Map(), txs: [] as any[], cmds: [] as any[], log: [] as any[], tags: [] as any[], legacy: false, writes: 0 };
const store: any = {
  async getChargePoint(id: string) { return mem.cps.get(id) || null; },
  async updateChargePoint(id: string, p: any) { mem.writes++; const c = mem.cps.get(id); if (c) Object.assign(c, p); },
  async upsertConnector(c: any) { mem.writes++; mem.conns.set(c.cpId + '/' + c.connectorId, c); },
  async getConnector(cp: string, n: number) { return mem.conns.get(cp + '/' + n) || null; },
  async startTx(t: any) { const id = mem.txs.length + 1; mem.txs.push({ ...t, id }); return id; },
  async getTx(id: number) { return mem.txs.find((t: any) => t.id === id) || null; },
  async updateTx(id: number, p: any) { Object.assign(mem.txs.find((t: any) => t.id === id), p); },
  async activeTx(cp: string, n: number) { return mem.txs.find((t: any) => t.cpId === cp && t.connectorId === n && !t.stopAt) || null; },
  async idTagStatus(net: string, tag: string) { const t = mem.tags.find((x: any) => x.net === net && x.idTag === tag); return t ? t.status : null; },
  async pendingCommands() { return []; }, async updateCommand() {}, async sentCommand() { return null; },
  async log(cpId: string, dir: string, kind: string, action: string, payload: any) { mem.writes++; mem.log.push({ id: mem.log.length + 1, cpId, dir, kind, action, payload, at: now }); },
  async createNetwork(h: string, name: string, by?: string | null) { const id = 'net' + (mem.nets.length + 1); mem.nets.push({ id, h, name, by: by || null, at: now }); return id; },
  async countNetworksSince(ms: number, who?: string) { if (who && mem.legacy) return null; return mem.nets.filter((n: any) => n.at >= ms && (!who || (who === 'anon' ? !n.by : n.by === who))).length; },
  async networkByKey(h: string) { const n = mem.nets.find((x: any) => x.h === h); return n ? { id: n.id, name: n.name } : null; },
  async addChargePoint(cp: any) { mem.cps.set(cp.id, cp); },
  async countChargePoints(net: string) { return [...mem.cps.values()].filter((c: any) => c.networkId === net).length; },
  async listChargePoints(net: string) { return [...mem.cps.values()].filter((c: any) => c.networkId === net); },
  async removeChargePoint(id: string) { mem.cps.delete(id); },
  async listConnectors() { return []; }, async listTx() { return []; }, async listCommands() { return []; },
  async listLog(_ids: string[], n: number) { mem.lastLimit = n; if (!Number.isInteger(n) || n < 1) throw new Error('bad limit ' + n); return []; },
  async queueCommand() { return 1; }, async setIdTag() {}, async listIdTags() { return []; },
};
const b64 = (o: any) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const GOOD = 'h.' + b64({ sub: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', role: 'authenticated' }) + '.s';
const user = async (req: Request) => ((req.headers.get('authorization') || '') === 'Bearer ' + GOOD ? 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' : null);
const d: any = { store, now: () => now, uid: () => crypto.randomUUID(), env: () => undefined, upgrade: () => { throw new Error('no ws'); }, user };
const api = async (body: any, bearer?: string) => { const r = await handleRequest(new Request('https://x/functions/v1/ocpp', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8080', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, body: JSON.stringify(body) }), d); return { status: r.status, json: await r.json() }; };

// ---- R1-08: network creation limits
let made = 0; for (let i = 0; i < LIMITS.anonPerHour; i++) if ((await api({ action: 'createNetwork', name: 'Anon ' + i })).status === 200) made++;
let r = await api({ action: 'createNetwork' }); ok(made === LIMITS.anonPerHour && r.status === 429 && /Sign in/.test(r.json.error), `anonymous pool: ${LIMITS.anonPerHour} an hour, then refused`);
r = await api({ action: 'createNetwork', name: 'Signed in' }, GOOD); ok(r.status === 200 && mem.nets.at(-1).by === 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'signed-in operator unaffected by the anonymous flood, network recorded with its owner');
const KEY = r.json.networkKey;
let m = 1; for (let i = 0; i < 6; i++) if ((await api({ action: 'createNetwork' }, GOOD)).status === 200) m++;
ok(m === LIMITS.perUserPerDay, `per-user allowance: ${LIMITS.perUserPerDay} a day (got ${m})`);
now += 61 * 60_000; r = await api({ action: 'createNetwork' }); ok(r.status === 200, 'anonymous pool frees up after an hour');
r = await api({ action: 'createNetwork' }, GOOD); ok(r.status === 429, 'per-user allowance is per day, not per hour');
mem.legacy = true; for (let i = 0; i < 30; i++) mem.nets.push({ id: 'x' + i, h: 'x' + i, name: 'x', by: null, at: now });
r = await api({ action: 'createNetwork' }, GOOD); ok(r.status === 429, 'before migration 20261117_edge_limits: old global limit (30/h) applies'); mem.legacy = false;
mem.nets = mem.nets.filter((n: any) => n.by); now += 25 * 3600_000;
r = await api({ action: 'createNetwork', name: 'Bad\u0000<b>name</b>' });
ok(r.status === 200 && r.json.name === 'Bad  b name /b' && !/[<>\u0000]/.test(mem.nets.at(-1).name), 'network names lose control characters and angle brackets: ' + JSON.stringify(r.json.name));

// ---- management API hardening
r = await api({ action: 'addChargePoint', key: KEY, id: 'CP-TEST-1', label: 'Test' }); const PW = r.json.password; ok(r.status === 200 && PW, 'charger added');
for (const lim of [-5, 0.5, 'abc', 1e9]) { const x = await api({ action: 'network', key: KEY, logLimit: lim }); ok(x.status === 200 && mem.lastLimit >= 1 && mem.lastLimit <= 200 && Number.isInteger(mem.lastLimit), `logLimit ${lim} clamped to ${mem.lastLimit}`); }

// ---- charger WebSocket: unknown IDs look like wrong passwords
const ws = async (path: string, auth?: string) => (await handleRequest(new Request('https://x/functions/v1/ocpp/' + path, { headers: { upgrade: 'websocket', ...(auth ? { authorization: auth } : {}) } }), d)).status;
ok(await ws('NOPE-123', 'Basic ' + btoa('NOPE-123:whatever')) === 401 && await ws('CP-TEST-1', 'Basic ' + btoa('CP-TEST-1:wrong')) === 401, 'unknown charger and wrong password give the same 401');
ok(await ws('%E0%A4%A') === 401, 'malformed %-escape in the charger ID: 401, not a crash');
{ let upgraded = 0; const d2 = { ...d, upgrade: () => { upgraded++; return { socket: { send() {}, close() {} }, response: new Response(null, { status: 200 }) }; } };
  const viaQuery = async (env: any) => (await handleRequest(new Request('https://x/functions/v1/ocpp/CP-TEST-1?key=' + encodeURIComponent(PW), { headers: { upgrade: 'websocket' } }), { ...d2, env: (k: string) => env[k] })).status;
  ok(await viaQuery({}) === 200 && upgraded === 1, 'charger password in ?key= still works by default (browser simulator)');
  ok(await viaQuery({ OCPP_ALLOW_QUERY_KEY: 'false' }) === 401 && upgraded === 1, 'OCPP_ALLOW_QUERY_KEY=false: ?key= refused (security review D)'); }

// ---- charger session: connector bounds, flood limit, message size
const sent: string[] = []; let closed: any = null;
const sock = { send: (x: string) => sent.push(x), close: (c: number, why: string) => { closed = [c, why]; } };
const cp = mem.cps.get('CP-TEST-1');
const s = new ChargerSession(cp, sock as any, { store, now: () => now, uid: () => crypto.randomUUID() }, 'inst1');
const call = async (id: string, action: string, p: any) => { sent.length = 0; await s.onMessage(JSON.stringify([2, id, action, p])); return sent.length ? JSON.parse(sent[sent.length - 1]) : null; };
let res = await call('a1', 'StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available' }); ok(res[0] === 3 && mem.conns.has('CP-TEST-1/1'), 'normal StatusNotification accepted');
res = await call('a2', 'StatusNotification', { connectorId: 99999, errorCode: 'NoError', status: 'Available' }); ok(res[0] === 4 && res[2] === 'PropertyConstraintViolation' && !mem.conns.has('CP-TEST-1/99999'), `connectorId above ${MAX_CONNECTOR} refused, no row created`);
res = await call('a3', 'StatusNotification', { connectorId: -1, errorCode: 'NoError', status: 'Available' }); ok(res[0] === 4, 'negative connectorId refused');
res = await call('a4', 'MeterValues', { connectorId: 500, meterValue: [] }); ok(res[0] === 4, 'MeterValues for an impossible connector refused');
res = await call('a5', 'StartTransaction', { connectorId: 0, idTag: 'TAG1', meterStart: 0, timestamp: new Date(now).toISOString() }); ok(res[0] === 4 && !mem.txs.length, 'StartTransaction on connector 0 refused');
const w0 = mem.writes; await s.onMessage('[2,"big","DataTransfer",{"vendorId":"' + 'x'.repeat(70_000) + '"}]'); ok(mem.writes === w0, 'oversized message ignored without database writes');
await s.onMessage(JSON.stringify([2, 'y'.repeat(80), 'Heartbeat', {}])); ok(mem.writes === w0, 'over-long message id ignored');
// flood: 200 heartbeats in the same millisecond
const before = mem.writes; let errs = 0; sent.length = 0;
for (let i = 0; i < 200; i++) await s.onMessage(JSON.stringify([2, 'f' + i, 'Heartbeat', {}]));
for (const x of sent) { const j = JSON.parse(x); if (j[0] === 4 && /slow down/.test(j[3])) errs++; }
ok(errs >= 130 && mem.writes - before <= 2 * 70, `flood: ${200 - errs} processed, ${errs} answered "slow down" without writes (db writes ${mem.writes - before})`);
for (let i = 0; i < 200 && !closed; i++) await s.onMessage(JSON.stringify([2, 'g' + i, 'Heartbeat', {}]));
ok(closed && closed[0] === 1008, 'a client that keeps flooding is disconnected');
now += 10_000; const s2 = new ChargerSession(cp, sock as any, { store, now: () => now, uid: () => crypto.randomUUID() }, 'inst2'); sent.length = 0;
await s2.onMessage(JSON.stringify([2, 'h1', 'Heartbeat', {}])); ok(JSON.parse(sent[0])[0] === 3, 'a well-behaved connection works normally');
const seen0 = mem.writes; for (let i = 0; i < 5; i++) { now += 500; await s2.onMessage(JSON.stringify([2, 'h' + (i + 2), 'Heartbeat', {}])); }
ok(mem.writes - seen0 === 10, 'last-seen is written at most every 5 s (only the 10 log rows were written)');
now += 5_000; const seen1 = mem.writes; await s2.onMessage(JSON.stringify([2, 'h9', 'Heartbeat', {}])); ok(mem.writes - seen1 === 3, 'and again once 5 s have passed');

// ---- Hardening pass: reissue a network's key to its creator (sign-out wipes the key on a shared device)
{
  const OTHER = 'h.' + b64({ sub: '99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee', role: 'authenticated' }) + '.s';
  const baseUser = d.user; d.user = async (req: Request) => ((req.headers.get('authorization') || '') === 'Bearer ' + OTHER ? '99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee' : baseUser(req));
  store.networksByCreator = async (who: string) => mem.nets.filter((n: any) => n.by === who).map((n: any) => ({ id: n.id, name: n.name, createdAt: n.at }));
  store.setNetworkKey = async (id: string, who: string, h: string) => { const n = mem.nets.find((x: any) => x.id === id && x.by === who); if (!n) return null; n.h = h; return { id: n.id, name: n.name }; };
  now += 2 * 86400_000;
  const made = await api({ action: 'createNetwork', name: 'Reissue me' }, GOOD); const oldKey = made.json.networkKey; const nid = made.json.networkId;
  let r = await api({ action: 'myNetworks' }); ok(r.status === 401, 'listing my networks needs a sign-in');
  r = await api({ action: 'myNetworks' }, GOOD); ok(r.status === 200 && r.json.networks.some((n: any) => n.id === nid) && !JSON.stringify(r.json).includes(oldKey), 'my networks listed, without keys');
  r = await api({ action: 'reissueKey', networkId: nid }, OTHER);
  ok(r.status === 404, 'another signed-in user can’t reissue it (' + r.status + ')');
  r = await api({ action: 'reissueKey', networkId: nid }, GOOD); const newKey = r.json.networkKey;
  ok(r.status === 200 && typeof newKey === 'string' && newKey !== oldKey && r.json.networkId === nid, 'creator gets a new key');
  r = await api({ action: 'network', key: oldKey }); ok(r.status === 401, 'the old key stops working');
  r = await api({ action: 'network', key: newKey }); ok(r.status === 200 && r.json.network.id === nid, 'the new key works');
  r = await api({ action: 'reissueKey', networkId: '../../x' }, GOOD); ok(r.status === 400, 'malformed network id refused');
  delete store.networksByCreator; delete store.setNetworkKey; d.user = baseUser;
  r = await api({ action: 'reissueKey', networkId: nid }, GOOD); ok(r.status === 501, 'older store: a clear "not available" answer');
}
