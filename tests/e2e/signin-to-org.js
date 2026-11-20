// Sign in from the demo without a page reload: does the demo world's Realtime subscription leak into the private workspace?
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright'); const fs = require('fs');
const FAKE = fs.readFileSync(FIX + '/fake-both.js', 'utf8');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ serviceWorkers: 'block' }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.route(/supabase-2\.118\.0\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE }));
  await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
  await p.goto('http://localhost:8080/'); await p.waitForTimeout(1200);
  await p.evaluate(() => localStorage.setItem('fake-autoconfirm', '1'));
  // Visitor first looks at the demo (no reload afterwards)
  /* no demo click */
  console.log('on the plain sign-in page, subscriptions:', await p.evaluate(() => window.__rt.map((x) => x.name + ' ' + x.filter).join(' | ')));
  // ...then creates a driver account (no 2FA needed for drivers) in the same tab
  await p.click('[data-act="auth-mode"][data-k="signup"]'); await p.waitForTimeout(300);
  await p.click('[data-act="auth-type"][data-k="driver"]'); await p.waitForTimeout(200);
  await p.fill('#auth-signup [name=fullname]', 'Private Person'); await p.fill('#auth-signup [name=email]', 'private@example.com'); await p.fill('#auth-signup [name=password]', 'correct-horse-battery');
  await p.check('#auth-signup [name=agree]'); await p.click('#auth-signup button[type=submit]'); await p.waitForTimeout(2500);
  const before = await p.evaluate(() => ({ mode: VF.mode, key: VF.STORE_KEY, rev: VF.state.rev, subs: window.__rt.map((x) => x.name).join(','), me: VF.user(VF.session.userId).name }));
  console.log('after sign-in:', JSON.stringify(before));
  // Another demo visitor changes the public demo world: Realtime delivers the demo row to every subscriber of world-demo.
  await p.evaluate(async () => {
    const st = JSON.parse(VF.stateJSON(VF.state)); st.stations[0].name = 'DEMO WORLD MARKER';
    const json = JSON.stringify(st); const gz = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    let s = ''; const u = new Uint8Array(gz); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    window.__demo.rev += 1; window.__demo.state_gz = 'gz:' + btoa(s);
    for (const x of window.__rt) if (x.filter === 'id=eq.demo') x.cb({ new: { rev: window.__demo.rev, state_gz: window.__demo.state_gz, leader_id: 'other' } });
  });
  await p.waitForTimeout(1500);
  const after = await p.evaluate(() => ({ mode: VF.mode, rev: VF.state.rev, station0: VF.state.stations[0].name }));
  console.log('private workspace after a demo update:', JSON.stringify(after));
  // A user action in the private workspace now writes the demo world into the organisation's row
  await p.evaluate(() => { VF.save(); }); await p.waitForTimeout(1500);
  const org = await p.evaluate(async () => { const db = JSON.parse(localStorage.getItem('fake-sb-db')); const w = Object.values(db.worlds)[0]; const t = w.state_gz; const bin = atob(t.slice(3)); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const st = JSON.parse(await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'))).text()); return { rev: w.rev, station0: st.stations[0].name }; });
  console.log('organisation row on the server:', JSON.stringify(org));
  console.log('errors:', errs.join(' | ') || 'none');
  await b.close();
})();
