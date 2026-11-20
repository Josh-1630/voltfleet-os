// Robustness layer (hardening pass after QA round 4):
//  * every dialog form is checked against the limits its fields declare (required, maxlength, min/max, step, pattern,
//    list options) before its own handler runs, so a form can't save a value it says it doesn't accept;
//  * one failing action or background step can't stop the others: errors are isolated, still reported, and the
//    person sees a message instead of a frozen screen.
const { ROOT, FIX, OUT } = require('../lib.cjs');
const { chromium } = require('playwright');
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' }); const p = await ctx.newPage();
  await p.route(/supabase\.co|cartocdn|osrm|wikipedia|wikimedia|open-meteo|fonts\.g/, (r) => r.abort());
  const pageErrors = []; p.on('pageerror', (e) => pageErrors.push(e.message));
  await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(500);
  await p.click('[data-role="manager"]'); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1500);
  await p.evaluate(() => { location.hash = 'm-vehicles'; }); await p.waitForTimeout(800);
  const count = () => p.evaluate(() => VF.state.fleet.vehicles.length);
  const n0 = await count();
  const open = async () => { await p.evaluate(() => VF.ACT['m-add-vehicle']()); await p.waitForTimeout(300); };
  const fill = (vals) => p.evaluate((v) => { for (const [k, x] of Object.entries(v)) { const el = document.querySelector(`#dlg-form [name="${k}"]`); el.value = x; } }, vals);
  const submit = async () => { await p.click('#dlg-form button[type="submit"]'); await p.waitForTimeout(300); return p.evaluate(() => { const e = document.getElementById('dlg-error'); return e && !e.hidden ? e.textContent.trim() : null; }); };
  const good = { name: 'Car QA', plate: 'GR 4321-25', vin: '1HGBH41JXMN109186', year: '2024' };

  await open(); await fill({ ...good, name: 'x'.repeat(31) });
  let err = await submit(); ok(/at most 30 characters/.test(err || '') && (await count()) === n0, `over-long name refused (${err})`);
  await fill({ ...good, year: '99999' }); err = await submit(); ok(/2010 and 2030/.test(err || '') && (await count()) === n0, `out-of-range year refused (${err})`);
  await fill({ ...good, year: '2024.5' }); err = await submit(); ok(err && (await count()) === n0, `fractional year refused (${err})`);
  await fill({ ...good, plate: '' }); err = await submit(); ok(/Fill in Number plate/.test(err || '') && (await count()) === n0, `empty required field refused (${err})`);
  await fill(good); err = await submit(); ok(err === null && (await count()) === n0 + 1, 'valid form still saves');

  // Isolation: a throwing background step doesn't stop the others or the save, and the error stays visible.
  await p.evaluate(() => { window.__ran = 0; VF.tickHooks.unshift(() => { throw new Error('qa: broken hook'); }); VF.tickHooks.push(() => { window.__ran++; }); });
  const saved0 = await p.evaluate(() => VF.state.clock || VF.now());
  await p.waitForTimeout(3500);
  const iso = await p.evaluate(() => ({ ran: window.__ran, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ') }));
  ok(iso.ran >= 2, `other background steps keep running (${iso.ran} runs)`);
  ok(pageErrors.some((m) => /qa: broken hook/.test(m)), 'the failing step is still reported as an error');
  ok(/Something went wrong/.test(iso.toast), 'the person sees a message (' + iso.toast.slice(0, 80) + ')');
  await p.evaluate(() => { VF.tickHooks = VF.tickHooks.filter((f) => !/qa: broken hook/.test(String(f))); });
  // A throwing action: later actions still work.
  await p.evaluate(() => { VF.ACT['qa-throw'] = () => { throw new Error('qa: broken action'); }; const bt = document.createElement('button'); bt.dataset.act = 'qa-throw'; bt.id = 'qa-throw'; bt.textContent = 'x'; document.body.appendChild(bt); });
  await p.evaluate(() => document.getElementById('qa-throw').click()); await p.waitForTimeout(300);
  await p.evaluate(() => VF.ACT['m-add-vehicle']()); await p.waitForTimeout(300);
  ok(await p.evaluate(() => !document.getElementById('dialog').hidden), 'actions still work after one fails');
  ok(pageErrors.some((m) => /qa: broken action/.test(m)), 'the failing action is still reported as an error');
  const other = pageErrors.filter((m) => !/^qa: /.test(m));
  ok(other.length === 0, 'no other page errors' + (other.length ? ': ' + other.slice(0, 3).join(' | ') : ''));
  await b.close();
})();
