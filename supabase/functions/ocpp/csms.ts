// VoltFleet OS — OCPP 1.6J central system (CSMS) core.
// Transport-agnostic: index.ts runs it on Supabase Edge Functions (Deno); the same code runs on any
// long-lived Deno/Node host. All state lives in the Store (Postgres in production), so a charger can
// reconnect to any instance without losing anything.
//
// Charger -> CSMS: BootNotification, Heartbeat, StatusNotification, Authorize, StartTransaction,
//   StopTransaction, MeterValues, DataTransfer, DiagnosticsStatusNotification, FirmwareStatusNotification.
// CSMS -> charger (queued commands): RemoteStartTransaction, RemoteStopTransaction, UnlockConnector, Reset,
//   ChangeAvailability, TriggerMessage, SetChargingProfile, ClearChargingProfile, GetConfiguration,
//   ChangeConfiguration, ReserveNow, CancelReservation.

export const HEARTBEAT_S = 60;
const CALL = 2, RESULT = 3, ERROR = 4;
const CMD_TIMEOUT_MS = 30_000, CMD_MAX_AGE_MS = 10 * 60_000;

// ---------------------------------------------------------------- types
export interface ChargePoint {
  id: string; networkId: string; label: string; passwordHash: string; authMode: 'open' | 'list';
  vendor?: string | null; model?: string | null; serial?: string | null; firmware?: string | null;
  bootAt?: number | null; lastSeen?: number | null; connected?: boolean; instance?: string | null; status?: string | null; createdAt?: number;
}
export interface Connector { cpId: string; connectorId: number; status: string; errorCode?: string | null; info?: string | null; updatedAt: number; powerW?: number | null; energyWh?: number | null; soc?: number | null }
export interface Tx { id: number; cpId: string; connectorId: number; idTag: string; meterStart: number; meterStop?: number | null; startAt: number; stopAt?: number | null; reason?: string | null; lastMeterWh?: number | null; lastPowerW?: number | null; idTagStatus?: string }
export interface Command { id: number; cpId: string; action: string; payload: unknown; status: string; result?: unknown; uniqueId?: string | null; createdAt: number; sentAt?: number | null; doneAt?: number | null }
export interface Store {
  getChargePoint(id: string): Promise<ChargePoint | null>;
  updateChargePoint(id: string, patch: Partial<ChargePoint>): Promise<void>;
  upsertConnector(c: Connector): Promise<void>;
  getConnector(cpId: string, connectorId: number): Promise<Connector | null>;
  startTx(t: Omit<Tx, 'id'>): Promise<number>;
  getTx(id: number): Promise<Tx | null>;
  updateTx(id: number, patch: Partial<Tx>): Promise<void>;
  activeTx(cpId: string, connectorId: number): Promise<Tx | null>;
  idTagStatus(networkId: string, idTag: string): Promise<string | null>;
  pendingCommands(cpId: string, sinceMs: number): Promise<Command[]>;
  updateCommand(id: number, patch: Partial<Command>): Promise<void>;
  sentCommand(cpId: string, uniqueId: string): Promise<Command | null>;
  log(cpId: string, dir: 'in' | 'out', kind: string, action: string | null, payload: unknown): Promise<void>;
}
export interface Socket { send(data: string): void; close(code?: number, reason?: string): void }
export interface Deps { store: Store; now: () => number; uid: () => string }

class OcppError extends Error { code: string; constructor(code: string, msg: string) { super(msg); this.code = code; } }

// ---------------------------------------------------------------- validation
type Spec = Record<string, 'string' | 'int' | 'number' | 'array' | 'object' | 'string?' | 'int?' | 'number?' | 'array?' | 'object?'>;
function check(p: any, spec: Spec, max: Record<string, number> = {}) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new OcppError('FormationViolation', 'Payload must be an object');
  for (const [k, t] of Object.entries(spec)) {
    const opt = t.endsWith('?'); const type = t.replace('?', ''); const v = p[k];
    if (v === undefined || v === null) { if (opt) continue; throw new OcppError('OccurenceConstraintViolation', `Missing ${k}`); }
    const ok = type === 'string' ? typeof v === 'string' : type === 'int' ? Number.isInteger(v) : type === 'number' ? typeof v === 'number' && isFinite(v) : type === 'array' ? Array.isArray(v) : typeof v === 'object' && !Array.isArray(v);
    if (!ok) throw new OcppError('TypeConstraintViolation', `${k} must be ${type}`);
    if (type === 'string' && max[k] && v.length > max[k]) throw new OcppError('PropertyConstraintViolation', `${k} longer than ${max[k]}`);
  }
}
const STATUSES = ['Available', 'Preparing', 'Charging', 'SuspendedEVSE', 'SuspendedEV', 'Finishing', 'Reserved', 'Unavailable', 'Faulted'];
const ts = (s: unknown, now: number) => { const t = typeof s === 'string' ? Date.parse(s) : NaN; return isFinite(t) ? t : now; };
const iso = (ms: number) => new Date(ms).toISOString();

// Meter values: energy in Wh, power in W, SoC in %.
export function readSamples(meterValue: any[]): { energyWh: number | null; powerW: number | null; soc: number | null } {
  const out = { energyWh: null as number | null, powerW: null as number | null, soc: null as number | null };
  for (const mv of Array.isArray(meterValue) ? meterValue : []) for (const s of Array.isArray(mv?.sampledValue) ? mv.sampledValue : []) {
    const v = parseFloat(s?.value); if (!isFinite(v)) continue;
    const m = s.measurand || 'Energy.Active.Import.Register'; const unit = String(s.unit || '');
    if (s.phase && m !== 'SoC') continue; // keep totals, skip per-phase readings
    if (m === 'Energy.Active.Import.Register') out.energyWh = unit === 'kWh' ? v * 1000 : v;
    else if (m === 'Power.Active.Import') out.powerW = unit === 'kW' ? v * 1000 : v;
    else if (m === 'SoC') out.soc = v;
  }
  return out;
}

// ---------------------------------------------------------------- one charger connection
export class ChargerSession {
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private busy = false;
  deadline = 0; quietMs = 8000; // when the host will close this connection; no new commands in the last seconds before it
  private cp: ChargePoint; private socket: Socket; private d: Deps; readonly instance: string;
  constructor(cp: ChargePoint, socket: Socket, d: Deps, instance: string) { this.cp = cp; this.socket = socket; this.d = d; this.instance = instance; }

  async open() {
    await this.d.store.updateChargePoint(this.cp.id, { connected: true, instance: this.instance, lastSeen: this.d.now() });
    await this.d.store.log(this.cp.id, 'in', 'CONNECT', null, { instance: this.instance });
    this.timer = setInterval(() => { this.pump().catch(() => { /* retried next tick */ }); }, 2000);
  }
  async close(reason = 'closed') {
    if (this.closed) return; this.closed = true;
    if (this.timer) clearInterval(this.timer);
    // Commands in flight when the connection dropped may or may not have reached the charger.
    for (const c of await this.d.store.pendingCommands(this.cp.id, this.d.now() - CMD_MAX_AGE_MS)) if (c.status === 'sent') await this.d.store.updateCommand(c.id, { status: 'lost', doneAt: this.d.now() });
    const cur = await this.d.store.getChargePoint(this.cp.id);
    if (cur && cur.instance === this.instance) await this.d.store.updateChargePoint(this.cp.id, { connected: false });
    await this.d.store.log(this.cp.id, 'in', 'DISCONNECT', null, { reason });
  }
  private async send(frame: unknown[], action: string | null) {
    const kind = frame[0] === CALL ? 'CALL' : frame[0] === RESULT ? 'RESULT' : 'ERROR';
    this.socket.send(JSON.stringify(frame));
    await this.d.store.log(this.cp.id, 'out', kind, action, frame[0] === CALL ? frame[3] : frame[2]);
  }

  async onMessage(text: string) {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; } // not OCPP-J: ignore
    if (!Array.isArray(msg) || typeof msg[1] !== 'string') return;
    const [type, id] = msg;
    await this.d.store.updateChargePoint(this.cp.id, { lastSeen: this.d.now() });
    if (type === CALL) {
      const action = String(msg[2]); const payload = msg[3];
      await this.d.store.log(this.cp.id, 'in', 'CALL', action, payload);
      try {
        const res = await this.handle(action, payload);
        await this.send([RESULT, id, res], action);
      } catch (e) {
        const code = e instanceof OcppError ? e.code : 'InternalError';
        await this.send([ERROR, id, code, e instanceof Error ? e.message.slice(0, 200) : 'Error', {}], action);
      }
    } else if (type === RESULT || type === ERROR) {
      const cmd = await this.d.store.sentCommand(this.cp.id, id);
      await this.d.store.log(this.cp.id, 'in', type === RESULT ? 'RESULT' : 'ERROR', cmd ? cmd.action : null, type === RESULT ? msg[2] : { code: msg[2], description: msg[3] });
      if (!cmd) return;
      if (type === ERROR) { await this.d.store.updateCommand(cmd.id, { status: 'error', result: { code: msg[2], description: msg[3] }, doneAt: this.d.now() }); return; }
      const r = msg[2] || {};
      const st = typeof r.status === 'string' ? r.status : 'Accepted';
      await this.d.store.updateCommand(cmd.id, { status: /^(Accepted|Unlocked|Scheduled)$/.test(st) ? 'accepted' : 'rejected', result: r, doneAt: this.d.now() });
    }
  }

  // Send queued commands, expire unanswered ones, and step aside if the charger reconnected elsewhere.
  async pump() {
    if (this.closed || this.busy) return;
    this.busy = true;
    try {
      const cur = await this.d.store.getChargePoint(this.cp.id);
      if (!cur) { this.socket.close(1008, 'Charge point removed'); return this.close('removed'); }
      if (cur.instance !== this.instance) { this.socket.close(1000, 'Replaced by a newer connection'); return this.close('replaced'); }
      const now = this.d.now();
      const closingSoon = this.deadline && this.deadline - now < this.quietMs;
      for (const c of await this.d.store.pendingCommands(this.cp.id, now - CMD_MAX_AGE_MS)) {
        if (c.status === 'queued' && !closingSoon) {
          const uniqueId = this.d.uid();
          await this.d.store.updateCommand(c.id, { status: 'sent', uniqueId, sentAt: now });
          await this.send([CALL, uniqueId, c.action, c.payload], c.action);
        } else if (c.status === 'sent' && c.sentAt && now - c.sentAt > CMD_TIMEOUT_MS) {
          await this.d.store.updateCommand(c.id, { status: 'timeout', doneAt: now });
        }
      }
    } finally { this.busy = false; }
  }

  private async authorize(idTag: string) {
    const cp = await this.d.store.getChargePoint(this.cp.id); // settings may change while connected
    if (cp) this.cp = cp;
    if (this.cp.authMode === 'open') return { status: 'Accepted' };
    const s = await this.d.store.idTagStatus(this.cp.networkId, idTag);
    return { status: s || 'Invalid' };
  }

  async handle(action: string, p: any): Promise<Record<string, unknown>> {
    const now = this.d.now(); const S = this.d.store; const cpId = this.cp.id;
    switch (action) {
      case 'BootNotification': {
        check(p, { chargePointVendor: 'string', chargePointModel: 'string', chargePointSerialNumber: 'string?', firmwareVersion: 'string?' }, { chargePointVendor: 20, chargePointModel: 20, chargePointSerialNumber: 25, firmwareVersion: 50 });
        await S.updateChargePoint(cpId, { vendor: p.chargePointVendor, model: p.chargePointModel, serial: p.chargePointSerialNumber || null, firmware: p.firmwareVersion || null, bootAt: now });
        return { status: 'Accepted', currentTime: iso(now), interval: HEARTBEAT_S };
      }
      case 'Heartbeat':
        return { currentTime: iso(now) };
      case 'StatusNotification': {
        check(p, { connectorId: 'int', errorCode: 'string', status: 'string', info: 'string?', timestamp: 'string?' }, { info: 50 });
        if (!STATUSES.includes(p.status)) throw new OcppError('PropertyConstraintViolation', 'Unknown status');
        if (p.connectorId === 0) await S.updateChargePoint(cpId, { status: p.status });
        else {
          const prev = await S.getConnector(cpId, p.connectorId);
          const idle = !['Charging', 'SuspendedEV', 'SuspendedEVSE'].includes(p.status);
          await S.upsertConnector({ cpId, connectorId: p.connectorId, status: p.status, errorCode: p.errorCode, info: p.info || null, updatedAt: ts(p.timestamp, now), powerW: idle ? 0 : prev?.powerW ?? null, energyWh: prev?.energyWh ?? null, soc: idle && p.status === 'Available' ? null : prev?.soc ?? null });
        }
        return {};
      }
      case 'Authorize':
        check(p, { idTag: 'string' }, { idTag: 20 });
        return { idTagInfo: await this.authorize(p.idTag) };
      case 'StartTransaction': {
        check(p, { connectorId: 'int', idTag: 'string', meterStart: 'int', timestamp: 'string', reservationId: 'int?' }, { idTag: 20 });
        const info = await this.authorize(p.idTag);
        const id = await S.startTx({ cpId, connectorId: p.connectorId, idTag: p.idTag, meterStart: p.meterStart, startAt: ts(p.timestamp, now), lastMeterWh: p.meterStart, lastPowerW: null, idTagStatus: info.status });
        return { transactionId: id, idTagInfo: info };
      }
      case 'StopTransaction': {
        check(p, { transactionId: 'int', meterStop: 'int', timestamp: 'string', idTag: 'string?', reason: 'string?', transactionData: 'array?' });
        const tx = await S.getTx(p.transactionId);
        if (tx && tx.cpId === cpId) {
          await S.updateTx(tx.id, { meterStop: p.meterStop, stopAt: ts(p.timestamp, now), reason: p.reason || 'Local', lastMeterWh: p.meterStop, lastPowerW: 0 });
          const c = await S.getConnector(cpId, tx.connectorId);
          if (c) await S.upsertConnector({ ...c, powerW: 0, updatedAt: now });
        }
        return p.idTag ? { idTagInfo: await this.authorize(p.idTag) } : {};
      }
      case 'MeterValues': {
        check(p, { connectorId: 'int', transactionId: 'int?', meterValue: 'array' });
        const r = readSamples(p.meterValue);
        const c = await S.getConnector(cpId, p.connectorId);
        await S.upsertConnector({ cpId, connectorId: p.connectorId, status: c?.status || 'Charging', errorCode: c?.errorCode || 'NoError', info: c?.info || null, updatedAt: now, powerW: r.powerW ?? c?.powerW ?? null, energyWh: r.energyWh ?? c?.energyWh ?? null, soc: r.soc ?? c?.soc ?? null });
        const tx = p.transactionId ? await S.getTx(p.transactionId) : await S.activeTx(cpId, p.connectorId);
        if (tx && tx.cpId === cpId && !tx.stopAt) await S.updateTx(tx.id, { lastMeterWh: r.energyWh ?? tx.lastMeterWh, lastPowerW: r.powerW ?? tx.lastPowerW });
        return {};
      }
      case 'DataTransfer':
        check(p, { vendorId: 'string' });
        return { status: 'UnknownVendorId' };
      case 'DiagnosticsStatusNotification':
      case 'FirmwareStatusNotification':
        check(p, { status: 'string' });
        return {};
      default:
        throw new OcppError('NotImplemented', `${action} is not supported`);
    }
  }
}

// ---------------------------------------------------------------- commands the console may queue
const int = (x: unknown) => Number.isInteger(x) && (x as number) >= 0;
export function validateCommand(action: string, p: any): string | null {
  p = p || {};
  switch (action) {
    case 'RemoteStartTransaction': return typeof p.idTag === 'string' && p.idTag.length > 0 && p.idTag.length <= 20 && (p.connectorId === undefined || int(p.connectorId)) ? null : 'Needs idTag (≤20 characters) and an optional connectorId';
    case 'RemoteStopTransaction': return int(p.transactionId) ? null : 'Needs transactionId';
    case 'UnlockConnector': return int(p.connectorId) && p.connectorId > 0 ? null : 'Needs connectorId';
    case 'Reset': return ['Soft', 'Hard'].includes(p.type) ? null : 'type must be Soft or Hard';
    case 'ChangeAvailability': return int(p.connectorId) && ['Operative', 'Inoperative'].includes(p.type) ? null : 'Needs connectorId and type Operative/Inoperative';
    case 'TriggerMessage': return ['BootNotification', 'DiagnosticsStatusNotification', 'FirmwareStatusNotification', 'Heartbeat', 'MeterValues', 'StatusNotification'].includes(p.requestedMessage) ? null : 'Unknown requestedMessage';
    case 'SetChargingProfile': return int(p.connectorId) && p.csChargingProfiles && typeof p.csChargingProfiles === 'object' ? null : 'Needs connectorId and csChargingProfiles';
    case 'ClearChargingProfile': return null;
    case 'GetConfiguration': return p.key === undefined || Array.isArray(p.key) ? null : 'key must be a list';
    case 'ChangeConfiguration': return typeof p.key === 'string' && typeof p.value === 'string' && p.key.length <= 50 && p.value.length <= 500 ? null : 'Needs key and value';
    case 'ReserveNow': return int(p.connectorId) && typeof p.idTag === 'string' && typeof p.expiryDate === 'string' && int(p.reservationId) ? null : 'Needs connectorId, idTag, expiryDate, reservationId';
    case 'CancelReservation': return int(p.reservationId) ? null : 'Needs reservationId';
    default: return 'Unsupported command';
  }
}
// Smart charging: a default power limit for every new session on a connector (0 = whole charger).
export function powerLimitProfile(connectorId: number, limit: number, unit: 'W' | 'A') {
  return { connectorId, csChargingProfiles: { chargingProfileId: 1, stackLevel: 0, chargingProfilePurpose: 'TxDefaultProfile', chargingProfileKind: 'Relative', chargingSchedule: { chargingRateUnit: unit, chargingSchedulePeriod: [{ startPeriod: 0, limit }] } } };
}
