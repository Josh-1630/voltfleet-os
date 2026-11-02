// VoltFleet OS — OCPP endpoint and management API (transport-agnostic).
//   Chargers:  wss://<host>/functions/v1/ocpp/<chargePointId>   subprotocol ocpp1.6
//              auth: HTTP Basic <chargePointId>:<password> (OCPP security profile 1/2), or ?key=<password>
//              for simulators and browsers that can't send headers.
//   Console:   POST /functions/v1/ocpp  { action, ... }  authorised by a network access key.
import { ChargerSession, validateCommand, powerLimitProfile, HEARTBEAT_S, type Store, type ChargePoint, type Connector, type Tx, type Command, type Socket } from './csms.ts';

export interface ApiStore extends Store {
  createNetwork(keyHash: string, name: string): Promise<string>;
  countNetworksSince(ms: number): Promise<number>;
  networkByKey(keyHash: string): Promise<{ id: string; name: string } | null>;
  addChargePoint(cp: ChargePoint): Promise<void>;
  countChargePoints(networkId: string): Promise<number>;
  listChargePoints(networkId: string): Promise<ChargePoint[]>;
  removeChargePoint(id: string): Promise<void>;
  listConnectors(cpIds: string[]): Promise<Connector[]>;
  listTx(cpIds: string[], limit: number): Promise<Tx[]>;
  listCommands(cpIds: string[], limit: number): Promise<Command[]>;
  listLog(cpIds: string[], limit: number): Promise<{ id: number; cpId: string; dir: string; kind: string; action: string | null; payload: unknown; at: number }[]>;
  queueCommand(cpId: string, action: string, payload: unknown): Promise<number>;
  setIdTag(networkId: string, idTag: string, status: string | null, label?: string): Promise<void>;
  listIdTags(networkId: string): Promise<{ idTag: string; status: string; label: string | null }[]>;
}
export interface ServerDeps {
  store: ApiStore; now: () => number; uid: () => string; env: (k: string) => string | undefined;
  // Upgrade an HTTP request to a WebSocket. Returns the socket and the response to send back.
  upgrade: (req: Request, protocol: string | null) => { socket: Socket & { onmessage: ((e: { data: unknown }) => void) | null; onclose: (() => void) | null; onopen: (() => void) | null; onerror: ((e: unknown) => void) | null }; response: Response };
  // Keep the worker alive until the promise settles (Supabase EdgeRuntime.waitUntil); optional.
  keepAlive?: (p: Promise<unknown>) => void;
  maxConnectionMs?: number;
}

const enc = new TextEncoder();
export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function randomToken(bytes = 24): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function sameHash(a: string, b: string) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
const CP_ID = /^[A-Za-z0-9._-]{3,48}$/;
const isKey = (s: unknown) => typeof s === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(s);
const MAX_CP = 25, MAX_NETWORKS_PER_HOUR = 30;
class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

function cors(origin: string | null, allowed: string[]) {
  const h: Record<string, string> = { 'Vary': 'Origin', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (origin && allowed.includes(origin)) Object.assign(h, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info', 'Access-Control-Max-Age': '600' });
  return h;
}

export async function handleRequest(req: Request, d: ServerDeps): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const at = parts.lastIndexOf('ocpp');
  const cpId = at >= 0 && parts[at + 1] ? decodeURIComponent(parts[at + 1]) : null;
  if ((req.headers.get('upgrade') || '').toLowerCase() === 'websocket') return chargerSocket(req, url, cpId, d);
  return api(req, d);
}

// ---------------------------------------------------------------- charger connections
async function chargerSocket(req: Request, url: URL, cpId: string | null, d: ServerDeps): Promise<Response> {
  if (!cpId || !CP_ID.test(cpId)) return new Response('Unknown charge point', { status: 404 });
  const cp = await d.store.getChargePoint(cpId);
  if (!cp) return new Response('Unknown charge point', { status: 404 });
  let password = url.searchParams.get('key');
  const auth = req.headers.get('authorization') || '';
  if (/^basic /i.test(auth)) {
    try { const [user, ...rest] = atob(auth.slice(6).trim()).split(':'); if (user === cpId) password = rest.join(':'); } catch { /* bad header */ }
  }
  if (!password || !sameHash(await sha256(password), cp.passwordHash)) return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="OCPP"' } });
  const requested = (req.headers.get('sec-websocket-protocol') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (requested.length && !requested.includes('ocpp1.6')) return new Response('This central system speaks OCPP 1.6J (subprotocol ocpp1.6)', { status: 400 });
  const { socket, response } = d.upgrade(req, requested.length ? 'ocpp1.6' : null);
  const session = new ChargerSession(cp, socket, { store: d.store, now: d.now, uid: d.uid }, d.uid());
  let done!: () => void; const finished = new Promise<void>((r) => { done = r; });
  let queue = Promise.resolve();
  const maxMs = d.maxConnectionMs || 0; let limit: ReturnType<typeof setTimeout> | null = null;
  socket.onopen = () => {
    queue = queue.then(() => session.open()).catch(() => {});
    // Hosted edge workers have a hard time limit: close cleanly first so the charger reconnects at once.
    if (maxMs) { session.deadline = d.now() + maxMs; session.quietMs = Math.min(8000, maxMs / 4); limit = setTimeout(() => { try { socket.close(1012, 'Service restart, please reconnect'); } catch { /* closed */ } }, maxMs); }
  };
  socket.onmessage = (e) => { const text = typeof e.data === 'string' ? e.data : ''; queue = queue.then(() => session.onMessage(text)).catch(() => {}); };
  const end = () => { if (limit) clearTimeout(limit); queue = queue.then(() => session.close()).catch(() => {}).finally(done); };
  socket.onclose = end; socket.onerror = () => {};
  if (d.keepAlive) d.keepAlive(finished);
  return response;
}

// ---------------------------------------------------------------- management API
async function api(req: Request, d: ServerDeps): Promise<Response> {
  const allowed = (d.env('ALLOWED_ORIGINS') || 'https://josh-1630.github.io,https://voltfleetos.com,https://www.voltfleetos.com,http://localhost:8080').split(',').map((s) => s.trim());
  const headers = cors(req.headers.get('origin'), allowed);
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return reply(405, { error: 'Chargers connect with a WebSocket; the console uses POST.' });
  let b: any; try { b = await req.json(); } catch { return reply(400, { error: 'Send a JSON body.' }); }
  const S = d.store;
  try {
    if (b.action === 'status') return reply(200, { ok: true, ocpp: ['1.6J'], heartbeat: HEARTBEAT_S });
    if (b.action === 'createNetwork') {
      const name = String(b.name || 'My charging network').slice(0, 60);
      if (await S.countNetworksSince(d.now() - 3600_000) >= MAX_NETWORKS_PER_HOUR) throw new HttpError(429, 'Too many networks created recently. Try again later.');
      const key = randomToken(32);
      const id = await S.createNetwork(await sha256(key), name);
      return reply(200, { networkId: id, networkKey: key, name });
    }
    if (!isKey(b.key)) throw new HttpError(401, 'Missing network access key.');
    const net = await S.networkByKey(await sha256(b.key));
    if (!net) throw new HttpError(401, 'This access key is not valid. It may have been removed.');
    const own = async (id: unknown) => {
      if (typeof id !== 'string' || !CP_ID.test(id)) throw new HttpError(400, 'Charge point IDs use 3–48 letters, numbers, dots, dashes or underscores.');
      const cp = await S.getChargePoint(id);
      if (!cp || cp.networkId !== net.id) throw new HttpError(404, 'No such charge point in this network.');
      return cp;
    };
    switch (b.action) {
      case 'network': {
        const cps = await S.listChargePoints(net.id); const ids = cps.map((c) => c.id); const now = d.now();
        const [conns, txs, cmds, log, tags] = ids.length ? await Promise.all([S.listConnectors(ids), S.listTx(ids, 40), S.listCommands(ids, 40), S.listLog(ids, Math.min(200, Number(b.logLimit) || 80)), S.listIdTags(net.id)]) : [[], [], [], [], await S.listIdTags(net.id)];
        return reply(200, {
          network: net, serverTime: now, heartbeat: HEARTBEAT_S,
          chargePoints: cps.map(({ passwordHash, instance, ...cp }) => ({ ...cp, online: !!cp.connected && !!cp.lastSeen && now - cp.lastSeen < HEARTBEAT_S * 2500, connectors: conns.filter((c) => c.cpId === cp.id).sort((a, z) => a.connectorId - z.connectorId) })),
          transactions: txs, commands: cmds, log, idTags: tags,
        });
      }
      case 'addChargePoint': {
        const id = String(b.id || '').trim();
        if (!CP_ID.test(id)) throw new HttpError(400, 'Charge point IDs use 3–48 letters, numbers, dots, dashes or underscores.');
        if (await S.getChargePoint(id)) throw new HttpError(409, 'That charge point ID is already registered. Choose another.');
        if (await S.countChargePoints(net.id) >= MAX_CP) throw new HttpError(400, `A network can have up to ${MAX_CP} charge points in this pilot.`);
        const password = randomToken(18);
        await S.addChargePoint({ id, networkId: net.id, label: String(b.label || id).slice(0, 60), passwordHash: await sha256(password), authMode: b.authMode === 'list' ? 'list' : 'open', connected: false, createdAt: d.now() });
        return reply(200, { id, password });
      }
      case 'updateChargePoint': {
        const cp = await own(b.id);
        await S.updateChargePoint(cp.id, { label: b.label ? String(b.label).slice(0, 60) : cp.label, authMode: b.authMode === 'list' ? 'list' : b.authMode === 'open' ? 'open' : cp.authMode });
        return reply(200, { ok: true });
      }
      case 'rotatePassword': {
        const cp = await own(b.id); const password = randomToken(18);
        await S.updateChargePoint(cp.id, { passwordHash: await sha256(password) });
        return reply(200, { id: cp.id, password });
      }
      case 'removeChargePoint': { const cp = await own(b.id); await S.removeChargePoint(cp.id); return reply(200, { ok: true }); }
      case 'command': {
        const cp = await own(b.id);
        let action = String(b.command || ''); let payload = b.payload || {};
        if (action === 'SetPowerLimit') {
          const limit = Number(payload.limit); const unit = payload.unit === 'A' ? 'A' : 'W';
          if (!(limit > 0 && limit < 1e6)) throw new HttpError(400, 'Enter a power limit above zero.');
          action = 'SetChargingProfile'; payload = powerLimitProfile(Number(payload.connectorId) || 0, limit, unit);
        }
        const err = validateCommand(action, payload);
        if (err) throw new HttpError(400, err);
        const id = await S.queueCommand(cp.id, action, payload);
        return reply(200, { commandId: id, queued: true, online: !!cp.connected });
      }
      case 'idTag': {
        const tag = String(b.idTag || '').trim();
        if (!tag || tag.length > 20) throw new HttpError(400, 'ID tags are 1–20 characters.');
        await S.setIdTag(net.id, tag, b.remove ? null : ['Accepted', 'Blocked'].includes(b.status) ? b.status : 'Accepted', b.label ? String(b.label).slice(0, 40) : undefined);
        return reply(200, { ok: true });
      }
      default: throw new HttpError(400, 'Unknown action.');
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    return reply(status, { error: e instanceof HttpError ? e.message : 'Server error.' });
  }
}
