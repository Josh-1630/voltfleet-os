// Hardening pass: an operator who signed out on a shared device (which now removes the network key from the browser)
// gets access back by signing in and asking for a new key. Only the network's creator can; the old key stops working.
const { ROOT, FIX, OUT } = require('../lib.cjs');
const { chromium } = require('playwright');
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  const calls = [];
  await p.route(/supabase\.co\/(?!functions)|cartocdn|osrm|wikipedia|wikimedia|open-meteo|fonts\.g/, (r) => r.abort());
  await p.route(/functions\/v1\/ocpp/, async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204 });
    const body = JSON.parse(r.request().postData() || '{}'); const auth = r.request().headers()['authorization'] || '';
    calls.push({ action: body.action, auth, key: body.key || null, networkId: body.networkId || null });
    const json = (o, s = 200) => r.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(o) });
    if (body.action === 'myNetworks') return auth ? json({ networks: [{ id: 'net-1', name: 'Airport chargers', createdAt: Date.now() - 86400e3 }] }) : json({ error: 'Sign in' }, 401);
    if (body.action === 'reissueKey') return auth && body.networkId === 'net-1' ? json({ networkId: 'net-1', networkKey: 'NEWKEY_' + 'x'.repeat(30), name: 'Airport chargers' }) : json({ error: 'no' }, 404);
    if (body.action === 'network') return body.key && body.key.startsWith('NEWKEY_') ? json({ network: { id: 'net-1', name: 'Airport chargers' }, serverTime: Date.now(), heartbeat: 60, chargePoints: [], transactions: [], commands: [], log: [], idTags: [] }) : json({ error: 'This access key is not valid.' }, 401);
    return json({ ok: true });
  });
  await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(500);
  await p.click('[data-role="operator"]'); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1200);
  // Pretend this browser is signed in to an account (the account flows themselves are covered by auth*.js).
  await p.evaluate(() => {
    localStorage.setItem('voltfleet-os:ocpp', JSON.stringify({ byOwner: { demo: { key: 'demo-key-' + 'd'.repeat(20), name: 'Demo' }, 'acct:u1': { key: 'acct-key-' + 'a'.repeat(20), name: 'Mine' }, 'acct:u2': { key: 'other-' + 'b'.repeat(20), name: 'Theirs' } } }));
  });
  await p.reload(); await p.waitForTimeout(1200);
  await p.evaluate(() => { VF.mode = 'account'; VF.auth.account = { id: 'u1' }; VF.auth.session = { access_token: 'tok-u1' }; VF.ocppNet.owner = null; VF.ocppNet.sync(); });
  ok(await p.evaluate(() => VF.ocppNet.key) === 'acct-key-' + 'a'.repeat(20), 'the account’s key loads while signed in');
  // Sign-out step: account keys leave the browser, the demo's stays.
  const after = await p.evaluate(() => { VF.ocppNet.wipeAccounts(); const s = JSON.parse(localStorage.getItem('voltfleet-os:ocpp') || '{}'); return { owners: Object.keys(s.byOwner || {}), key: VF.ocppNet.key }; });
  ok(after.owners.join() === 'demo' && after.key === null, 'sign-out removes every account’s network key from this browser (' + after.owners.join() + ')');
  // Recover: the empty state offers it to a signed-in operator.
  await p.evaluate(() => { VF.ocppNet.owner = null; location.hash = 'op-ocpp'; VF.rerender(); }); await p.waitForTimeout(900);
  ok(!!(await p.$('[data-act="oc-recover"]')), 'signed in without a key: “Recover a network you created” is offered');
  await p.click('[data-act="oc-recover"]'); await p.waitForTimeout(500);
  ok(await p.evaluate(() => !document.getElementById('dialog').hidden && /old key stops working/.test(document.getElementById('dialog').textContent)), 'the dialog warns that the old key stops working');
  await p.click('#dlg-form button[type="submit"]'); await p.waitForTimeout(1500);
  const st = await p.evaluate(() => ({ key: VF.ocppNet.key, saved: localStorage.getItem('voltfleet-os:ocpp') || '' }));
  ok(st.key && st.key.startsWith('NEWKEY_') && st.saved.includes('acct:u1') && st.saved.includes('NEWKEY_'), 'the new key is in use and kept for this account');
  const mine = calls.filter((c) => c.action === 'myNetworks' || c.action === 'reissueKey');
  ok(mine.length === 2 && mine.every((c) => c.auth === 'Bearer tok-u1') && mine[1].networkId === 'net-1', 'both requests say who is asking (' + mine.map((c) => c.action + ':' + (c.auth ? 'bearer' : 'none')).join(', ') + ')');
  ok(calls.filter((c) => c.action === 'network').every((c) => !c.auth), 'ordinary network calls stay keyed, without the sign-in token');
  ok(calls.some((c) => c.action === 'network' && c.key && c.key.startsWith('NEWKEY_')), 'the console loads the network with the new key');
  // The demo (not signed in) never offers it.
  await p.evaluate(() => { VF.mode = 'demo'; VF.ocppNet.owner = null; VF.ocppNet.sync(); VF.ocppNet.key = null; VF.rerender(); }); await p.waitForTimeout(500);
  ok(!(await p.$('[data-act="oc-recover"]')), 'the demo doesn’t offer recovery');
  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await b.close();
})();
