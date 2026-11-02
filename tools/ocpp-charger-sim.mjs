#!/usr/bin/env node
// Simulated OCPP 1.6J charger for testing the VoltFleet central system from a terminal (Node 22+, no packages).
//   node tools/ocpp-charger-sim.mjs <central-system-url> <charge-point-id> <password> [connectors=2] [kW=60]
// Example:
//   node tools/ocpp-charger-sim.mjs wss://kwxadepnkyxgspvvqbzo.supabase.co/functions/v1/ocpp ACC-AIRPORT-01 'xxxx'
// Then use the operator console (Real chargers) to start, stop, limit or reset it. Type "plug 1 CARD-ID" and
// press Enter to simulate a driver tapping a card on connector 1; "quit" to stop.
import { createRequire } from 'node:module';
import readline from 'node:readline';
const require = createRequire(import.meta.url);
const { SimCharger } = require('../js/ocpp-sim.js');
const [url, id, password, connectors = '2', kw = '60'] = process.argv.slice(2);
if (!url || !id || !password) { console.error('Usage: node tools/ocpp-charger-sim.mjs <url> <charge-point-id> <password> [connectors] [kW]'); process.exit(1); }
if (typeof WebSocket === 'undefined') { console.error('Needs Node 22 or newer (built-in WebSocket).'); process.exit(1); }
const sim = new SimCharger({ url, id, password, connectors: +connectors, kw: +kw, WebSocket, onEvent: (e) => {
  const t = new Date(e.at).toISOString().slice(11, 19);
  if (e.type === 'out' && e.data[0] === 2) console.log(t, '→', e.data[2], JSON.stringify(e.data[3]).slice(0, 120));
  else if (e.type === 'in' && e.data[0] === 2) console.log(t, '←', e.data[2], JSON.stringify(e.data[3]).slice(0, 120));
  else if (e.type === 'in' && e.data[0] === 4) console.log(t, '← error', e.data[2], e.data[3]);
  else if (e.type === 'state' || e.type === 'closed' || e.type === 'error' || e.type === 'info') console.log(t, `[${e.type}]`, typeof e.data === 'string' ? e.data : JSON.stringify(e.data));
} });
sim.start();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [cmd, n, card] = line.trim().split(/\s+/);
  if (cmd === 'plug') sim.plugIn(+n || 1, card || 'TEST-CARD').catch((e) => console.log('plug failed:', e.message));
  else if (cmd === 'quit' || cmd === 'exit') { sim.stop(); process.exit(0); }
});
process.on('SIGINT', () => { sim.stop(); process.exit(0); });
