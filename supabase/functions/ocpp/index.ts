// Supabase Edge Function entry point for the OCPP 1.6J central system.
// Chargers: wss://<project>.supabase.co/functions/v1/ocpp/<chargePointId>  (deploy with verify_jwt off;
// chargers authenticate with their own password). The same code runs on any long-lived Deno host:
//   SUPABASE_DB_URL=postgres://... deno run -A supabase/functions/ocpp/index.ts
import postgres from 'npm:postgres@3.4.5';
import { handleRequest, type ApiStore } from './server.ts';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 4, idle_timeout: 20 });
const t = (x: Date | string | null | undefined) => (x ? new Date(x).getTime() : null);
const d = (ms: number | null | undefined) => (ms == null ? null : new Date(ms));
const cpRow = (r: any) => ({ id: r.id, networkId: r.network_id, label: r.label, passwordHash: r.password_hash, authMode: r.auth_mode, vendor: r.vendor, model: r.model, serial: r.serial, firmware: r.firmware, status: r.status, bootAt: t(r.boot_at), lastSeen: t(r.last_seen), connected: r.connected, instance: r.instance, createdAt: t(r.created_at) });
const connRow = (r: any) => ({ cpId: r.cp_id, connectorId: r.connector_id, status: r.status, errorCode: r.error_code, info: r.info, powerW: r.power_w, energyWh: r.energy_wh, soc: r.soc, updatedAt: t(r.updated_at)! });
const txRow = (r: any) => ({ id: Number(r.id), cpId: r.cp_id, connectorId: r.connector_id, idTag: r.id_tag, idTagStatus: r.id_tag_status, meterStart: Number(r.meter_start), meterStop: r.meter_stop == null ? null : Number(r.meter_stop), startAt: t(r.start_at)!, stopAt: t(r.stop_at), reason: r.reason, lastMeterWh: r.last_meter_wh, lastPowerW: r.last_power_w });
const cmdRow = (r: any) => ({ id: Number(r.id), cpId: r.cp_id, action: r.action, payload: r.payload, status: r.status, uniqueId: r.unique_id, result: r.result, createdAt: t(r.created_at)!, sentAt: t(r.sent_at), doneAt: t(r.done_at) });
const CP_COLS: Record<string, string> = { label: 'label', passwordHash: 'password_hash', authMode: 'auth_mode', vendor: 'vendor', model: 'model', serial: 'serial', firmware: 'firmware', status: 'status', connected: 'connected', instance: 'instance', bootAt: 'boot_at', lastSeen: 'last_seen' };
const TX_COLS: Record<string, string> = { meterStop: 'meter_stop', stopAt: 'stop_at', reason: 'reason', lastMeterWh: 'last_meter_wh', lastPowerW: 'last_power_w' };
const CMD_COLS: Record<string, string> = { status: 'status', uniqueId: 'unique_id', result: 'result', sentAt: 'sent_at', doneAt: 'done_at' };
const TIME = new Set(['boot_at', 'last_seen', 'stop_at', 'sent_at', 'done_at']);
function patchOf(p: Record<string, unknown>, cols: Record<string, string>) {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) { const c = cols[k]; if (!c || v === undefined) continue; o[c] = TIME.has(c) ? d(v as number) : c === 'result' ? sql.json(v as any) : v; }
  return o;
}
let logCount = 0;

const store: ApiStore = {
  async getChargePoint(id) { const [r] = await sql`select * from private.ocpp_charge_points where id = ${id}`; return r ? cpRow(r) : null; },
  async updateChargePoint(id, p) { const o = patchOf(p as any, CP_COLS); if (Object.keys(o).length) await sql`update private.ocpp_charge_points set ${sql(o)} where id = ${id}`; },
  async upsertConnector(c) {
    await sql`insert into private.ocpp_connectors (cp_id, connector_id, status, error_code, info, power_w, energy_wh, soc, updated_at)
      values (${c.cpId}, ${c.connectorId}, ${c.status}, ${c.errorCode ?? null}, ${c.info ?? null}, ${c.powerW ?? null}, ${c.energyWh ?? null}, ${c.soc ?? null}, ${d(c.updatedAt)})
      on conflict (cp_id, connector_id) do update set status = excluded.status, error_code = excluded.error_code, info = excluded.info, power_w = excluded.power_w, energy_wh = excluded.energy_wh, soc = excluded.soc, updated_at = excluded.updated_at`;
  },
  async getConnector(cpId, n) { const [r] = await sql`select * from private.ocpp_connectors where cp_id = ${cpId} and connector_id = ${n}`; return r ? connRow(r) : null; },
  async startTx(x) {
    const [r] = await sql`insert into private.ocpp_transactions (cp_id, connector_id, id_tag, id_tag_status, meter_start, start_at, last_meter_wh, last_power_w)
      values (${x.cpId}, ${x.connectorId}, ${x.idTag}, ${x.idTagStatus ?? null}, ${x.meterStart}, ${d(x.startAt)}, ${x.lastMeterWh ?? null}, ${x.lastPowerW ?? null}) returning id`;
    return Number(r.id);
  },
  async getTx(id) { const [r] = await sql`select * from private.ocpp_transactions where id = ${id}`; return r ? txRow(r) : null; },
  async updateTx(id, p) { const o = patchOf(p as any, TX_COLS); if (Object.keys(o).length) await sql`update private.ocpp_transactions set ${sql(o)} where id = ${id}`; },
  async activeTx(cpId, n) { const [r] = await sql`select * from private.ocpp_transactions where cp_id = ${cpId} and connector_id = ${n} and stop_at is null order by id desc limit 1`; return r ? txRow(r) : null; },
  async idTagStatus(net, tag) { const [r] = await sql`select status from private.ocpp_id_tags where network_id = ${net} and id_tag = ${tag}`; return r ? r.status : null; },
  async pendingCommands(cpId, since) { return (await sql`select * from private.ocpp_commands where cp_id = ${cpId} and status in ('queued', 'sent') and created_at >= ${d(since)} order by id`).map(cmdRow); },
  async updateCommand(id, p) { const o = patchOf(p as any, CMD_COLS); if (Object.keys(o).length) await sql`update private.ocpp_commands set ${sql(o)} where id = ${id}`; },
  async sentCommand(cpId, uid) { const [r] = await sql`select * from private.ocpp_commands where cp_id = ${cpId} and unique_id = ${uid}`; return r ? cmdRow(r) : null; },
  async log(cpId, dir, kind, action, payload) {
    const p = JSON.stringify(payload ?? null); const body = p.length > 4000 ? { truncated: true, size: p.length } : payload ?? null;
    await sql`insert into private.ocpp_log (cp_id, dir, kind, action, payload) values (${cpId}, ${dir}, ${kind}, ${action}, ${sql.json(body as any)})`;
    if (++logCount % 200 === 0) await sql`delete from private.ocpp_log where at < now() - interval '7 days'`; // keep a week
  },
  async createNetwork(keyHash, name) { const [r] = await sql`insert into private.ocpp_networks (key_hash, name) values (${keyHash}, ${name}) returning id`; return r.id; },
  async countNetworksSince(ms) { const [r] = await sql`select count(*)::int as n from private.ocpp_networks where created_at >= ${d(ms)}`; return r.n; },
  async networkByKey(h) { const [r] = await sql`select id, name from private.ocpp_networks where key_hash = ${h}`; return r ? { id: r.id, name: r.name } : null; },
  async addChargePoint(cp) { await sql`insert into private.ocpp_charge_points (id, network_id, label, password_hash, auth_mode) values (${cp.id}, ${cp.networkId}, ${cp.label}, ${cp.passwordHash}, ${cp.authMode})`; },
  async countChargePoints(net) { const [r] = await sql`select count(*)::int as n from private.ocpp_charge_points where network_id = ${net}`; return r.n; },
  async listChargePoints(net) { return (await sql`select * from private.ocpp_charge_points where network_id = ${net} order by created_at`).map(cpRow); },
  async removeChargePoint(id) { await sql`delete from private.ocpp_charge_points where id = ${id}`; },
  async listConnectors(ids) { return (await sql`select * from private.ocpp_connectors where cp_id in ${sql(ids)}`).map(connRow); },
  async listTx(ids, n) { return (await sql`select * from private.ocpp_transactions where cp_id in ${sql(ids)} order by id desc limit ${n}`).map(txRow); },
  async listCommands(ids, n) { return (await sql`select * from private.ocpp_commands where cp_id in ${sql(ids)} order by id desc limit ${n}`).map(cmdRow); },
  async listLog(ids, n) { return (await sql`select * from private.ocpp_log where cp_id in ${sql(ids)} order by id desc limit ${n}`).map((r: any) => ({ id: Number(r.id), cpId: r.cp_id, dir: r.dir, kind: r.kind, action: r.action, payload: r.payload, at: t(r.at)! })); },
  async queueCommand(cpId, action, payload) { const [r] = await sql`insert into private.ocpp_commands (cp_id, action, payload) values (${cpId}, ${action}, ${sql.json(payload as any)}) returning id`; return Number(r.id); },
  async setIdTag(net, tag, status, label) {
    if (!status) { await sql`delete from private.ocpp_id_tags where network_id = ${net} and id_tag = ${tag}`; return; }
    await sql`insert into private.ocpp_id_tags (network_id, id_tag, status, label) values (${net}, ${tag}, ${status}, ${label ?? null}) on conflict (network_id, id_tag) do update set status = excluded.status, label = coalesce(excluded.label, private.ocpp_id_tags.label)`;
  },
  async listIdTags(net) { return (await sql`select id_tag, status, label from private.ocpp_id_tags where network_id = ${net} order by id_tag`).map((r: any) => ({ idTag: r.id_tag, status: r.status, label: r.label })); },
};

// Hosted edge workers stop after ~400 s; close at 370 s so chargers reconnect straight away.
const MAX_MS = Number(Deno.env.get('OCPP_MAX_CONNECTION_MS') || 370_000);
// deno-lint-ignore no-explicit-any
const ER = (globalThis as any).EdgeRuntime;
Deno.serve((req) => handleRequest(req, {
  store, now: Date.now, uid: () => crypto.randomUUID(), env: (k) => Deno.env.get(k),
  upgrade: (r, protocol) => Deno.upgradeWebSocket(r, protocol ? { protocol } : {}) as any,
  keepAlive: ER && ER.waitUntil ? (p) => ER.waitUntil(p) : undefined,
  maxConnectionMs: ER ? MAX_MS : 0,
}));
