import { handle, parseSignals } from '../../supabase/functions/smartcar/handler.ts';
const ok = (c: any, m: string) => console.log((c ? 'PASS ' : 'FAIL ') + m);
let now = Date.parse('2026-11-02T12:00:00Z');
const mem: any = { states: new Map(), links: new Map(), cache: new Map(), token: null };
const store = {
  async addState(h: string) { mem.states.set(h, { created: now, used: false }); },
  async pendingStates(since: number) { return [...mem.states.values()].filter((s: any) => !s.used && s.created > since).length; },
  async takeState(h: string, max: number) { const s = mem.states.get(h); if (!s || s.used || now - s.created > max) return null; s.used = true; return { createdAt: s.created }; },
  async addLink(k: string, u: string) { mem.links.set(k, u); },
  async findLink(k: string) { return mem.links.has(k) ? { userId: mem.links.get(k) } : null; },
  async removeLink(k: string) { const u = mem.links.get(k); if (!u) return null; mem.links.delete(k); return { userId: u, remaining: [...mem.links.values()].filter((x) => x === u).length }; },
  async getCache(v: string) { return mem.cache.get(v) || null; },
  async putCache(v: string, u: string, info: any, payload: any, at: number) { mem.cache.set(v, { userId: u, info, payload, fetchedAt: at }); },
  async dropCache(u: string) { for (const [k, v] of mem.cache) if ((v as any).userId === u) mem.cache.delete(k); },
  async getToken() { return mem.token; }, async putToken(t: string, e: number) { mem.token = { token: t, expiresAt: e }; },
};
const calls: string[] = [];
const sig = [
  { type: 'signal', id: 'tractionbattery-stateofcharge', attributes: { code: 'tractionbattery-stateofcharge', name: 'State Of Charge', group: 'TractionBattery', body: { value: 62.5, unit: 'percent' }, status: { value: 'SUCCESS' } } },
  { type: 'signal', attributes: { code: 'tractionbattery-range', name: 'Range', body: { value: 200, unit: 'miles' } } },
  { type: 'signal', attributes: { code: 'charge-ischarging', name: 'Is Charging', body: { value: true } } },
  { type: 'signal', attributes: { code: 'charge-ischargingcableconnected', name: 'Cable', body: { value: true } } },
  { type: 'signal', attributes: { code: 'odometer-traveleddistance', name: 'Odometer', body: { value: 12345, unit: 'km' } } },
  { type: 'signal', attributes: { code: 'location-preciselocation', name: 'Location', body: { latitude: 5.6, longitude: -0.19, heading: 0 } } },
  { type: 'signal', attributes: { code: 'tractionbattery-nominalcapacity', name: 'Capacity', body: { value: 75, unit: 'kWh' } } },
  { type: 'signal', attributes: { code: 'closure-islocked', name: 'Locked', status: { value: 'ERROR', error: { code: 'NOT_SUPPORTED' } } } },
];
const fakeFetch: any = async (url: string, init: any = {}) => {
  calls.push((init.method || 'GET') + ' ' + url);
  const J = (s: number, b: any) => new Response(JSON.stringify(b), { status: s });
  if (url.startsWith('https://iam.smartcar.com')) return init.headers.Authorization === 'Basic ' + btoa('cid:sec') ? J(200, { access_token: 'APP', expires_in: 3600 }) : J(401, { error: 'bad' });
  if (init.headers?.Authorization !== 'Bearer APP') return J(401, {});
  const uid = init.headers['sc-user-id'];
  if (url.includes('/connections') && uid === 'user-nots') return J(200, { data: [{ type: 'connection', attributes: {}, relationships: { vehicle: { data: { id: 'veh-n', type: 'vehicle' } } } }] });
  if (url.includes('/connections') && uid === 'user-old') return J(200, { data: [{ type: 'connection', attributes: { createdAt: new Date(now - 3 * 864e5).toISOString() }, relationships: { vehicle: { data: { id: 'veh-o', type: 'vehicle' } } } }] });
  if (url.includes('/connections')) return J(200, { data: uid === 'user-1234' ? [{ type: 'connection', attributes: { createdAt: new Date(now).toISOString() }, relationships: { vehicle: { data: { id: 'veh-abc', type: 'vehicle' } } } }] : [] });
  if (url.endsWith('/vehicles/veh-abc')) return J(200, { data: { id: 'veh-abc', attributes: { make: 'TESLA', model: 'Model 3', year: 2023 } } });
  if (url.endsWith('/vehicles/veh-abc/signals')) return J(200, { data: sig });
  if (url.includes('/commands/charge/')) return J(202, { data: { status: 'PENDING' } });
  return J(404, { description: 'nope' });
};
const env = (k: string) => ({ SMARTCAR_CLIENT_ID: 'cid', SMARTCAR_CLIENT_SECRET: 'sec' } as any)[k];
const d = { fetch: fakeFetch, env, store, now: () => now };
const call = async (body: any, origin = 'https://josh-1630.github.io') => { const r = await handle(new Request('https://x/smartcar', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), d as any); return { status: r.status, cors: r.headers.get('access-control-allow-origin'), json: await r.json() }; };

let r = await call({ action: 'status' }); ok(r.json.configured === true && r.cors === 'https://josh-1630.github.io', 'status + CORS');
r = await call({ action: 'status' }, 'https://evil.example'); ok(r.cors === null, 'no CORS for unknown origin');
const pre = await handle(new Request('https://x', { method: 'OPTIONS', headers: { origin: 'http://localhost:8080' } }), d as any); ok(pre.status === 204 && pre.headers.get('access-control-allow-methods')?.includes('POST'), 'preflight');
r = await call({ action: 'start' }); const state = r.json.state; ok(r.status === 200 && state.length > 20, 'start gives state');
r = await call({ action: 'link', userId: 'user-1234', state: 'x'.repeat(30) }); ok(r.status === 403, 'unknown state rejected');
r = await call({ action: 'link', userId: 'user-9999', state }); ok(r.status === 404, 'user without vehicles rejected (state consumed)');
r = await call({ action: 'start' }); const state2 = r.json.state;
r = await call({ action: 'link', userId: 'user-1234', state: state2 }); const key = r.json.key;
ok(r.status === 200 && key && r.json.vehicles.length === 1, 'link returns key and vehicle');
const v = r.json.vehicles[0]; ok(v.info.make === 'TESLA' && v.summary.soc === 62.5 && Math.round(v.summary.rangeKm) === 322 && v.summary.charging === true && v.summary.pluggedIn === true && v.summary.odometerKm === 12345 && v.summary.lat === 5.6 && v.summary.capacityKwh === 75, 'signals parsed: ' + JSON.stringify(v.summary));
ok(v.signals.find((s: any) => s.code === 'closure-islocked').error === 'NOT_SUPPORTED', 'failed signal kept with error');
r = await call({ action: 'link', userId: 'user-1234', state: state2 }); ok(r.status === 403, 'state cannot be reused');
const before = calls.length; r = await call({ action: 'vehicles', key }); ok(r.json.vehicles[0].cached === true && calls.filter((c, i) => i >= before && c.includes('/signals')).length === 0, 'second read served from cache');
now += 61_000; r = await call({ action: 'vehicles', key }); ok(r.json.vehicles[0].cached === false, 'refetch after 60 s');
r = await call({ action: 'vehicles', key: 'y'.repeat(40) }); ok(r.status === 401, 'wrong key rejected');
r = await call({ action: 'command', key, vehicleId: 'veh-abc', command: 'start' }); ok(r.status === 200 && r.json.ok && calls.some((c) => c.startsWith('POST https://vehicle.api.smartcar.com/v3/vehicles/veh-abc/commands/charge/start')), 'start charge command');
r = await call({ action: 'command', key, vehicleId: 'veh-other', command: 'stop' }); ok(r.status === 403, 'command on foreign vehicle rejected');
// token expiry -> refresh
now += 3_700_000; const t0 = calls.filter((c) => c.includes('iam.')).length; await call({ action: 'vehicles', key }); ok(calls.filter((c) => c.includes('iam.')).length === t0 + 1, 'app token refreshed after expiry');
r = await call({ action: 'disconnect', key }); ok(r.json.ok && mem.cache.size === 0, 'disconnect removes link and cached data');
r = await call({ action: 'vehicles', key }); ok(r.status === 401, 'key unusable after disconnect');
const d2 = { ...d, env: () => undefined }; const r2 = await handle(new Request('https://x', { method: 'POST', body: JSON.stringify({ action: 'start' }) }), d2 as any); ok(r2.status === 503, 'unconfigured server says so');
ok(parseSignals({ data: [{ attributes: { code: 'tractionbattery-stateofcharge', body: { value: 0.5, unit: 'fraction' } } }] }).summary.soc === 50, 'fraction SOC normalised');

// QA round 2 (R1-10): a browser-supplied user id only links when Smartcar confirms a connection made in this flow
{ const s1 = (await call({ action: 'start' })).json.state; const r3 = await call({ action: 'link', userId: 'user-nots', state: s1 }); ok(r3.status === 403 && /didn’t say when/.test(r3.json.error), 'link refused when Smartcar gives no connection time (fail closed)'); }
{ const s1 = (await call({ action: 'start' })).json.state; const r3 = await call({ action: 'link', userId: 'user-old', state: s1 }); ok(r3.status === 403, 'link refused for a connection made days before this flow (leaked user id)'); }
