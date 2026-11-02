/* VoltFleet OS — simulated OCPP 1.6J charger.
   Connects to a central system exactly like a real charger (WebSocket, subprotocol ocpp1.6), boots, reports
   connector status and heartbeats, answers remote commands and streams meter values while charging.
   Used by the operator console ("Test with a simulated charger") and by tools/ocpp-charger-sim.mjs. */
(function (root) {
  'use strict';
  const iso = () => new Date().toISOString();
  class SimCharger {
    constructor(o) {
      this.url = o.url.replace(/\/$/, ''); this.id = o.id; this.password = o.password;
      this.connectors = Array.from({ length: o.connectors || 2 }, (_, i) => ({ id: i + 1, status: 'Available', tx: null, energyWh: 0, kw: o.kw || 60, soc: 0, limitW: null, reserved: null }));
      this.onEvent = o.onEvent || (() => {}); this.WS = o.WebSocket || root.WebSocket;
      this.pending = new Map(); this.seq = 0; this.ws = null; this.stopped = true; this.heartbeat = 60; this.timers = [];
      this.meterEvery = o.meterEvery || 5000; this.state = 'offline'; this.config = { HeartbeatInterval: '60', MeterValueSampleInterval: String((o.meterEvery || 5000) / 1000), AuthorizeRemoteTxRequests: 'false', NumberOfConnectors: String(this.connectors.length) };
    }
    emit(type, data) { try { this.onEvent({ type, data, at: Date.now() }); } catch (e) { /* listener error */ } }
    start() { this.stopped = false; this.open(); }
    stop() { this.stopped = true; this.clearTimers(); if (this.ws) try { this.ws.close(1000, 'Stopped'); } catch (e) { /* closed */ } this.setState('offline'); }
    setState(s) { this.state = s; this.emit('state', s); }
    clearTimers() { this.timers.forEach(clearInterval); this.timers = []; this.connectors.forEach((c) => { if (c.meter) clearInterval(c.meter); c.meter = null; }); }
    open() {
      this.setState('connecting');
      const ws = this.ws = new this.WS(`${this.url}/${encodeURIComponent(this.id)}?key=${encodeURIComponent(this.password)}`, ['ocpp1.6']);
      ws.onopen = async () => {
        this.setState('booting');
        try {
          const r = await this.call('BootNotification', { chargePointVendor: 'VoltFleet', chargePointModel: 'SimCharger DC', chargePointSerialNumber: 'SIM-' + this.id.slice(-8), firmwareVersion: '1.6.0-sim' });
          this.heartbeat = r.interval || 60; this.setState('online');
          await this.status(0, 'Available');
          for (const c of this.connectors) await this.status(c.id, c.tx ? 'Charging' : c.status);
          for (const c of this.connectors) if (c.tx) this.meter(c);
          this.timers.push(setInterval(() => this.call('Heartbeat', {}).catch(() => {}), this.heartbeat * 1000));
        } catch (e) { this.emit('error', e.message); }
      };
      ws.onmessage = (e) => this.onMessage(String(e.data));
      ws.onclose = (e) => {
        this.clearTimers(); this.pending.forEach((p) => p.reject(new Error('Disconnected'))); this.pending.clear();
        this.emit('closed', { code: e.code, reason: e.reason }); this.setState(this.stopped ? 'offline' : 'reconnecting');
        if (!this.stopped) setTimeout(() => { if (!this.stopped) this.open(); }, 3000); // real chargers reconnect too
      };
      ws.onerror = () => this.emit('error', 'Connection failed. Check the URL, charge point ID and password.');
    }
    send(frame) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(frame)); this.emit('out', frame); } }
    call(action, payload) {
      const id = 's' + (++this.seq) + '-' + Math.random().toString(36).slice(2, 8);
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, action });
        this.send([2, id, action, payload]);
        setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(action + ' timed out')); } }, 30000);
      });
    }
    status(connectorId, status) { const c = this.connectors.find((x) => x.id === connectorId); if (c) c.status = status; return this.call('StatusNotification', { connectorId, errorCode: 'NoError', status, timestamp: iso() }).catch(() => {}); }
    onMessage(text) {
      let m; try { m = JSON.parse(text); } catch (e) { return; }
      this.emit('in', m);
      if (m[0] === 3 || m[0] === 4) { const p = this.pending.get(m[1]); if (!p) return; this.pending.delete(m[1]); if (m[0] === 3) p.resolve(m[2] || {}); else p.reject(new Error(`${m[2]}: ${m[3]}`)); return; }
      if (m[0] !== 2) return;
      const [, id, action, p] = m;
      const reply = (payload) => this.send([3, id, payload]);
      const conn = (n) => this.connectors.find((c) => c.id === n);
      switch (action) {
        case 'RemoteStartTransaction': {
          const c = p.connectorId ? conn(p.connectorId) : this.connectors.find((x) => !x.tx && (x.status === 'Available' || x.status === 'Preparing'));
          if (!c || c.tx || ['Unavailable', 'Faulted'].includes(c.status) || (c.reserved && c.reserved.idTag !== p.idTag)) return reply({ status: 'Rejected' });
          reply({ status: 'Accepted' }); this.startTx(c, p.idTag); return;
        }
        case 'RemoteStopTransaction': {
          const c = this.connectors.find((x) => x.tx && x.tx.id === p.transactionId);
          if (!c) return reply({ status: 'Rejected' });
          reply({ status: 'Accepted' }); this.stopTx(c, 'Remote'); return;
        }
        case 'UnlockConnector': { const c = conn(p.connectorId); if (c && c.tx) this.stopTx(c, 'UnlockCommand'); return reply({ status: c ? 'Unlocked' : 'NotSupported' }); }
        case 'Reset':
          reply({ status: 'Accepted' });
          this.connectors.forEach((c) => { if (c.tx) this.stopTx(c, p.type === 'Hard' ? 'HardReset' : 'SoftReset'); });
          setTimeout(() => { if (this.ws) try { this.ws.close(1000, 'Rebooting'); } catch (e) { /* closed */ } }, 1500);
          return;
        case 'ChangeAvailability': {
          const list = p.connectorId === 0 ? this.connectors : [conn(p.connectorId)].filter(Boolean);
          if (!list.length) return reply({ status: 'Rejected' });
          const busy = list.some((c) => c.tx);
          reply({ status: busy ? 'Scheduled' : 'Accepted' });
          if (!busy) list.forEach((c) => this.status(c.id, p.type === 'Inoperative' ? 'Unavailable' : 'Available'));
          return;
        }
        case 'TriggerMessage':
          reply({ status: 'Accepted' });
          if (p.requestedMessage === 'StatusNotification') (p.connectorId ? [conn(p.connectorId)].filter(Boolean) : this.connectors).forEach((c) => this.status(c.id, c.status));
          else if (p.requestedMessage === 'Heartbeat') this.call('Heartbeat', {}).catch(() => {});
          else if (p.requestedMessage === 'MeterValues') this.connectors.filter((c) => c.tx).forEach((c) => this.sendMeter(c));
          else if (p.requestedMessage === 'BootNotification') this.call('BootNotification', { chargePointVendor: 'VoltFleet', chargePointModel: 'SimCharger DC' }).catch(() => {});
          return;
        case 'SetChargingProfile': {
          const sched = p.csChargingProfiles && p.csChargingProfiles.chargingSchedule; const per = sched && sched.chargingSchedulePeriod && sched.chargingSchedulePeriod[0];
          if (!per) return reply({ status: 'Rejected' });
          const w = sched.chargingRateUnit === 'A' ? per.limit * 230 * 3 : per.limit;
          (p.connectorId ? [conn(p.connectorId)].filter(Boolean) : this.connectors).forEach((c) => { c.limitW = w; });
          return reply({ status: 'Accepted' });
        }
        case 'ClearChargingProfile': this.connectors.forEach((c) => { c.limitW = null; }); return reply({ status: 'Accepted' });
        case 'GetConfiguration': return reply({ configurationKey: Object.entries(this.config).filter(([k]) => !p.key || !p.key.length || p.key.includes(k)).map(([key, value]) => ({ key, readonly: false, value })), unknownKey: (p.key || []).filter((k) => !(k in this.config)) });
        case 'ChangeConfiguration': if (!(p.key in this.config)) return reply({ status: 'NotSupported' }); this.config[p.key] = p.value; return reply({ status: 'Accepted' });
        case 'ReserveNow': { const c = conn(p.connectorId); if (!c || c.tx || c.status !== 'Available') return reply({ status: c && c.tx ? 'Occupied' : 'Unavailable' }); c.reserved = { id: p.reservationId, idTag: p.idTag }; reply({ status: 'Accepted' }); this.status(c.id, 'Reserved'); return; }
        case 'CancelReservation': { const c = this.connectors.find((x) => x.reserved && x.reserved.id === p.reservationId); if (!c) return reply({ status: 'Rejected' }); c.reserved = null; reply({ status: 'Accepted' }); this.status(c.id, 'Available'); return; }
        default: this.send([4, id, 'NotImplemented', `${action} not supported by the simulator`, {}]);
      }
    }
    // A driver plugs in and taps their card (local start).
    async plugIn(connectorId, idTag) {
      const c = this.connectors.find((x) => x.id === connectorId); if (!c || c.tx) return;
      const a = await this.call('Authorize', { idTag });
      if (!a.idTagInfo || a.idTagInfo.status !== 'Accepted') { this.emit('info', `Card ${idTag} was not accepted (${a.idTagInfo && a.idTagInfo.status})`); return; }
      this.startTx(c, idTag);
    }
    async startTx(c, idTag) {
      c.reserved = null; c.soc = 20 + Math.round(Math.random() * 30);
      await this.status(c.id, 'Preparing');
      const r = await this.call('StartTransaction', { connectorId: c.id, idTag, meterStart: Math.round(c.energyWh), timestamp: iso() });
      if (!r.idTagInfo || r.idTagInfo.status !== 'Accepted') { this.emit('info', 'Transaction refused by the central system'); await this.status(c.id, 'Finishing'); await this.status(c.id, 'Available'); return; }
      c.tx = { id: r.transactionId, idTag, start: Math.round(c.energyWh) };
      await this.status(c.id, 'Charging'); this.meter(c);
    }
    meter(c) { if (c.meter) clearInterval(c.meter); c.meter = setInterval(() => this.sendMeter(c), this.meterEvery); }
    powerW(c) { const taper = c.soc > 80 ? Math.max(0.15, (100 - c.soc) / 20) : 1; return Math.round(Math.min(c.kw * 1000 * taper, c.limitW || Infinity)); }
    sendMeter(c) {
      if (!c.tx) return;
      const w = this.powerW(c); c.energyWh += w * this.meterEvery / 3600000 * 20; c.soc = Math.min(100, c.soc + w / 1000 * this.meterEvery / 3600000 * 20 / 0.6); // 20x demo speed, 60 kWh pack
      this.call('MeterValues', { connectorId: c.id, transactionId: c.tx.id, meterValue: [{ timestamp: iso(), sampledValue: [{ value: String(Math.round(c.energyWh)), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }, { value: String(w), measurand: 'Power.Active.Import', unit: 'W' }, { value: String(Math.round(c.soc)), measurand: 'SoC', unit: 'Percent', location: 'EV' }] }] }).catch(() => {});
      if (c.soc >= 100) this.stopTx(c, 'EVDisconnected');
    }
    async stopTx(c, reason) {
      if (!c.tx) return; const tx = c.tx; c.tx = null; if (c.meter) clearInterval(c.meter); c.meter = null;
      await this.call('StopTransaction', { transactionId: tx.id, meterStop: Math.round(c.energyWh), timestamp: iso(), reason, idTag: tx.idTag }).catch(() => {});
      await this.status(c.id, 'Finishing'); await this.status(c.id, 'Available');
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { SimCharger };
  if (root.VF) root.VF.SimCharger = SimCharger;
})(typeof window !== 'undefined' ? window : globalThis);
