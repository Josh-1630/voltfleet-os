// VoltFleet EV Manager — Smartcar bridge (Smartcar API v3).
// Runs on Supabase Edge Functions. The Smartcar client secret stays here; browsers only get the readings of
// vehicles they connected themselves, identified by an access key that the browser holds and we store hashed.
//
// Actions (POST JSON { action, ... }):
//   status                       -> { configured }
//   start                        -> { state }                 one-time value for the Connect URL
//   link { userId, state }       -> { key, vehicles }         after Connect redirects back with user_id
//   vehicles { key, force? }     -> { vehicles }              cached for 60 s (15 s when forced)
//   command { key, vehicleId, command: 'start' | 'stop' }  -> { ok, status, message }
//   disconnect { key }           -> { ok }

export const SC_IAM = 'https://iam.smartcar.com/oauth2/token';
export const SC_API = 'https://vehicle.api.smartcar.com/v3';
const CACHE_MS = 60_000, FORCE_MS = 15_000, STATE_MS = 30 * 60_000;

export interface Store {
  addState(hash: string): Promise<void>;
  pendingStates(sinceMs: number): Promise<number>;
  takeState(hash: string, maxAgeMs: number): Promise<{ createdAt: number } | null>;
  addLink(keyHash: string, userId: string): Promise<void>;
  findLink(keyHash: string): Promise<{ userId: string } | null>;
  removeLink(keyHash: string): Promise<{ userId: string; remaining: number } | null>;
  getCache(vehicleId: string): Promise<{ userId: string; info: any; payload: any; fetchedAt: number } | null>;
  putCache(vehicleId: string, userId: string, info: any, payload: any, fetchedAt: number): Promise<void>;
  dropCache(userId: string): Promise<void>;
  getToken(): Promise<{ token: string; expiresAt: number } | null>;
  putToken(token: string, expiresAt: number): Promise<void>;
}
export interface Deps { fetch: typeof fetch; env: (k: string) => string | undefined; store: Store; now: () => number }

class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

// ---------------------------------------------------------------- helpers
const enc = new TextEncoder();
export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function randomToken(bytes = 32): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const isToken = (s: unknown) => typeof s === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(s);
const isId = (s: unknown) => typeof s === 'string' && /^[A-Za-z0-9_.:-]{4,128}$/.test(s);

function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const h: Record<string, string> = { 'Vary': 'Origin', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'content-type, authorization, apikey, x-client-info';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}

// ---------------------------------------------------------------- Smartcar API
async function appToken(d: Deps, force = false): Promise<string> {
  const id = d.env('SMARTCAR_CLIENT_ID'), secret = d.env('SMARTCAR_CLIENT_SECRET');
  if (!id || !secret) throw new HttpError(503, 'Smartcar is not configured on the server yet.');
  if (!force) { const t = await d.store.getToken(); if (t && t.expiresAt - d.now() > 60_000) return t.token; }
  const tries: RequestInit[] = [
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(`${id}:${secret}`) }, body: 'grant_type=client_credentials' },
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString() },
  ];
  let last = '';
  for (const init of tries) {
    const r = await d.fetch(SC_IAM, init);
    const text = await r.text();
    if (r.ok) {
      const j = JSON.parse(text);
      if (!j.access_token) throw new HttpError(502, 'Smartcar returned no access token.');
      const exp = d.now() + (Number(j.expires_in) || 3600) * 1000;
      await d.store.putToken(j.access_token, exp);
      return j.access_token;
    }
    last = `${r.status} ${text.slice(0, 200)}`;
    if (r.status !== 400 && r.status !== 401) break;
  }
  throw new HttpError(502, `Smartcar rejected the client credentials (${last}). Check SMARTCAR_CLIENT_ID and SMARTCAR_CLIENT_SECRET.`);
}
async function sc(d: Deps, path: string, userId: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  let token = await appToken(d);
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await d.fetch(SC_API + path, { ...init, headers: { Authorization: `Bearer ${token}`, 'sc-user-id': userId, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (r.status === 401 && attempt === 0) { token = await appToken(d, true); continue; }
    const text = await r.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
    return { status: r.status, json };
  }
  return { status: 401, json: null };
}
const scError = (j: any) => (j && (j.description || j.message || (j.errors && j.errors[0] && (j.errors[0].detail || j.errors[0].title)) || j.type)) || 'Unknown error';

// Vehicle ids connected for a Smartcar user (v3 /connections, paginated by page number).
async function connectionsOf(d: Deps, userId: string): Promise<{ vehicleId: string; createdAt: number | null }[]> {
  const out: { vehicleId: string; createdAt: number | null }[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await sc(d, `/connections?filter[userId]=${encodeURIComponent(userId)}&page[number]=${page}&page[size]=50`, userId);
    if (r.status >= 400) throw new HttpError(502, `Smartcar connections failed (${r.status}): ${scError(r.json)}`);
    const rows: any[] = (r.json && (r.json.data || r.json.connections)) || [];
    for (const c of rows) {
      const vid = c?.relationships?.vehicle?.data?.id || c?.attributes?.vehicleId || c?.vehicleId || c?.vehicle?.id;
      const created = c?.attributes?.createdAt || c?.attributes?.connectedAt || c?.createdAt || c?.meta?.createdAt;
      if (vid && !out.some((x) => x.vehicleId === vid)) out.push({ vehicleId: String(vid), createdAt: created ? Date.parse(created) || null : null });
    }
    if (rows.length < 50) break;
  }
  return out;
}

// ---------------------------------------------------------------- signal parsing (defensive: v3 schemas evolve)
const MI = 1.609344;
const num = (x: any) => (typeof x === 'number' && isFinite(x) ? x : typeof x === 'string' && x.trim() !== '' && isFinite(+x) ? +x : null);
const toKm = (v: number | null, unit: any) => (v == null ? null : /mi/i.test(String(unit || '')) ? v * MI : /^m$|meter/i.test(String(unit || '')) ? v / 1000 : v);
export function parseSignals(json: any) {
  const rows: any[] = Array.isArray(json) ? json : (json && (json.data || json.signals)) || [];
  const signals = rows.map((s) => {
    const a = s && s.attributes ? s.attributes : s || {};
    const body = a.body !== undefined ? a.body : a.value !== undefined ? { value: a.value, unit: a.unit } : null;
    const code = String(a.code || s.id || '').toLowerCase();
    const st = a.status;
    const failed = st && (st.value === 'ERROR' || st.value === 'error' || st.error);
    return { code, name: a.name || code, group: a.group || code.split('-')[0] || '', body: failed ? null : body, error: failed ? (st.error && (st.error.description || st.error.code)) || 'Unavailable' : null, at: (a.meta && (a.meta.retrievedAt || a.meta.oemUpdatedAt || a.meta.fetchedAt)) || null };
  }).filter((s) => s.code);
  const sum: any = { soc: null, rangeKm: null, capacityKwh: null, charging: null, pluggedIn: null, chargeState: null, odometerKm: null, lat: null, lon: null, soh: null, chargeLimit: null };
  for (const s of signals) {
    const b = s.body; if (b == null) continue;
    const v = typeof b === 'object' ? (b.value !== undefined ? b.value : null) : b;
    const unit = typeof b === 'object' ? b.unit : undefined;
    const c = s.code;
    if (typeof b === 'object' && num(b.latitude) != null && num(b.longitude) != null) { sum.lat = num(b.latitude); sum.lon = num(b.longitude); continue; }
    if (c.includes('stateofcharge') && num(v) != null) { const n = num(v)!; sum.soc = n <= 1 && /fraction|ratio/i.test(String(unit || '')) ? n * 100 : n; continue; }
    if (c.startsWith('tractionbattery') && c.includes('range') && num(v) != null) { sum.rangeKm = toKm(num(v), unit); continue; }
    if (c.includes('stateofhealth') && num(v) != null) { sum.soh = num(v); continue; }
    if (c.includes('capacity') && (num(v) != null || num(b.usableKwh) != null || num(b.nominal) != null)) { sum.capacityKwh = num(b.usableKwh) ?? num(v) ?? num(b.nominal); continue; }
    if (c.startsWith('odometer') && num(v) != null) { sum.odometerKm = toKm(num(v), unit); continue; }
    if (c.startsWith('charge')) {
      if ((c.includes('plugged') || c.includes('cable') || c.includes('connected')) && typeof v === 'boolean') sum.pluggedIn = v;
      else if (c.includes('ischarging') && typeof v === 'boolean') sum.charging = v;
      else if ((c.includes('limit') || c.includes('target')) && num(v) != null) sum.chargeLimit = num(v);
      else if (typeof v === 'string' && /status|state/.test(c)) { sum.chargeState = v; if (sum.charging == null) sum.charging = /^charging$|^charging_|in.?progress/i.test(v); if (sum.pluggedIn == null && /plug|connected|charging|full/i.test(v)) sum.pluggedIn = !/not.?plug|unplug|disconnected/i.test(v); }
    }
  }
  return { signals: signals.slice(0, 120), summary: sum };
}
export function parseInfo(json: any) {
  const a = (json && (json.data?.attributes || json.attributes || json)) || {};
  return { make: a.make || a.brand || null, model: a.model || null, year: num(a.year), vin: a.vin || null, nickname: a.nickname || null };
}

async function readVehicles(d: Deps, userId: string, force: boolean) {
  const conns = await connectionsOf(d, userId);
  const out = [];
  for (const { vehicleId } of conns.slice(0, 20)) {
    const cached = await d.store.getCache(vehicleId);
    const age = cached ? d.now() - cached.fetchedAt : Infinity;
    if (cached && cached.payload && age < (force ? FORCE_MS : CACHE_MS)) { out.push({ id: vehicleId, info: cached.info, ...cached.payload, fetchedAt: cached.fetchedAt, cached: true }); continue; }
    let info = cached && cached.info;
    if (!info) { const r = await sc(d, `/vehicles/${encodeURIComponent(vehicleId)}`, userId); info = r.status < 400 ? parseInfo(r.json) : { make: null, model: null, year: null, vin: null }; }
    const r = await sc(d, `/vehicles/${encodeURIComponent(vehicleId)}/signals`, userId);
    let payload: any;
    if (r.status < 400) payload = { ...parseSignals(r.json), error: null };
    else payload = { signals: cached?.payload?.signals || [], summary: cached?.payload?.summary || {}, error: `${r.status}: ${scError(r.json)}` };
    const at = d.now();
    await d.store.putCache(vehicleId, userId, info, payload, at);
    out.push({ id: vehicleId, info, ...payload, fetchedAt: at, cached: false });
  }
  return out;
}

// ---------------------------------------------------------------- request handler
export async function handle(req: Request, d: Deps): Promise<Response> {
  const allowed = (d.env('ALLOWED_ORIGINS') || 'https://josh-1630.github.io,https://voltfleetos.com,https://www.voltfleetos.com,http://localhost:8080').split(',').map((s) => s.trim());
  const headers = corsHeaders(req.headers.get('origin'), allowed);
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });
  let body: any;
  try { body = await req.json(); } catch { return reply(400, { error: 'Send a JSON body.' }); }
  try {
    const configured = !!(d.env('SMARTCAR_CLIENT_ID') && d.env('SMARTCAR_CLIENT_SECRET'));
    switch (body && body.action) {
      case 'status':
        return reply(200, { configured });
      case 'start': {
        if (!configured) throw new HttpError(503, 'Smartcar is not configured on the server yet.');
        if (await d.store.pendingStates(d.now() - 60 * 60_000) > 500) throw new HttpError(429, 'Too many connection attempts. Try again later.');
        const state = randomToken(24);
        await d.store.addState(await sha256(state));
        return reply(200, { state });
      }
      case 'link': {
        if (!isId(body.userId) || !isToken(body.state)) throw new HttpError(400, 'Missing or invalid user_id or state.');
        const st = await d.store.takeState(await sha256(body.state), STATE_MS);
        if (!st) throw new HttpError(403, 'This connection link has expired or was already used. Connect the vehicle again.');
        const conns = await connectionsOf(d, body.userId);
        if (!conns.length) throw new HttpError(404, 'Smartcar has no vehicle connected for this user.');
        // When Smartcar reports when a connection was made, it must be after this Connect flow started.
        if (conns.every((c) => c.createdAt != null) && !conns.some((c) => (c.createdAt as number) >= st.createdAt - 5 * 60_000)) throw new HttpError(403, 'These vehicles were not connected in this session.');
        const key = randomToken(32);
        await d.store.addLink(await sha256(key), body.userId);
        return reply(200, { key, vehicles: await readVehicles(d, body.userId, true) });
      }
      case 'vehicles': case 'command': case 'disconnect': {
        if (!isToken(body.key)) throw new HttpError(401, 'Missing access key.');
        const keyHash = await sha256(body.key);
        if (body.action === 'disconnect') {
          const res = await d.store.removeLink(keyHash);
          if (res && res.remaining === 0) await d.store.dropCache(res.userId);
          return reply(200, { ok: true });
        }
        const link = await d.store.findLink(keyHash);
        if (!link) throw new HttpError(401, 'This device is no longer connected to Smartcar. Connect again.');
        if (body.action === 'vehicles') return reply(200, { vehicles: await readVehicles(d, link.userId, !!body.force) });
        if (!isId(body.vehicleId) || !['start', 'stop'].includes(body.command)) throw new HttpError(400, 'Invalid command.');
        const owned = (await connectionsOf(d, link.userId)).some((c) => c.vehicleId === body.vehicleId);
        if (!owned) throw new HttpError(403, 'That vehicle is not connected for this account.');
        const r = await sc(d, `/vehicles/${encodeURIComponent(body.vehicleId)}/commands/charge/${body.command}`, link.userId, { method: 'POST', body: '{}' });
        const ok = r.status === 200 || r.status === 202;
        return reply(ok ? 200 : 502, { ok, status: r.status, message: ok ? (r.status === 202 ? 'Command sent to the vehicle.' : 'Done.') : scError(r.json) });
      }
      default:
        return reply(400, { error: 'Unknown action.' });
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    return reply(status, { error: e instanceof HttpError ? e.message : 'Server error.' });
  }
}
