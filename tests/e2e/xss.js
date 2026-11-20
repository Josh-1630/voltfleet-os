// Stored-XSS probe: plants payloads in user-controllable string fields of the shared state, then renders every page of every role.
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const { chromium } = require('playwright');
const ROLES = process.argv[2] ? process.argv[2].split(',') : ['manager', 'driver', 'operator', 'admin', 'developer'];
(async () => {
  const b = await chromium.launch(); const report = [];
  for (const role of ROLES) {
    const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } }); const p = await ctx.newPage();
    await p.route(/supabase\.co|fonts|cartocdn|osrm|wikipedia|wikimedia|open-meteo/, (r) => r.abort());
    await p.goto('http://localhost:8080/?demo'); await p.waitForTimeout(400);
    const roleBtn = await p.$(`[data-role="${role}"]`); if (!roleBtn) { report.push(`${role}: no role button`); await ctx.close(); continue; }
    await roleBtn.click(); await p.click('.demo-acct:not([disabled])'); await p.waitForTimeout(1500);
    const planted = await p.evaluate(() => {
      const PAY = (k) => `${k}<img src=x data-xss onerror=window.__x=(window.__x||[]).concat('${k}')>"' data-xss2 onmouseover=window.__x=1 x="`;
      const KEYS = new Set(['name', 'title', 'body', 'plate', 'notes', 'email', 'reason', 'text', 'kind', 'note', 'who', 'ref', 'client', 'support', 'label', 'code', 'vin', 'license', 'phone', 'issue', 'redirect', 'webhook', 'url', 'description']);
      let n = 0; const seen = new Set();
      const walk = (o, path) => {
        if (!o || typeof o !== 'object' || seen.has(o)) return; seen.add(o);
        for (const k of Object.keys(o)) {
          const v = o[k];
          if (typeof v === 'string' && KEYS.has(k) && !/^(id|clock)$/.test(k)) { o[k] = PAY(path + '.' + k); n++; } else if (v && typeof v === 'object') walk(v, path + '.' + k);
        }
      };
      walk(VF.state, 's'); VF.rerender(); return n;
    });
    const navs = await p.evaluate(() => { const a = VF.apps[VF.session.role] || Object.values(VF.apps).find((x) => x.nav.some((n) => n.id === VF.route())); return (a ? a.nav : []).map((n) => n.id); });
    const hits = new Set();
    for (const id of navs) {
      await p.evaluate((h) => { location.hash = h; }, id); await p.waitForTimeout(700);
      // open first sheet / detail where possible
      const found = await p.evaluate(() => ({ x: window.__x || null, el: document.querySelectorAll('[data-xss],[data-xss2]').length }));
      if (found.el || found.x) hits.add(`${id}: ${found.el} injected elements${found.x ? ' · EXECUTED ' + JSON.stringify(found.x).slice(0, 200) : ''}`);
      await p.evaluate(() => { window.__x = null; });
    }
    const EXTRA = {
      manager: ["VF.mgr.ui.vehicle=VF.state.fleet.vehicles[0].id;location.hash='m-vehicle'", "VF.mgr.ui.vtab='maintenance';VF.rerender()", "VF.mgr.ui.vtab='registration';VF.rerender()", "location.hash='m-finance';VF.mgr.ui.finTab='home';VF.rerender()", "VF.mgr.ui.finTab='battery';VF.rerender()", "location.hash='m-settings';VF.mgr.ui.setTab='organisation';VF.rerender()", "VF.mgr.ui.setTab='privacy';VF.rerender()", "VF.mgr.ui.setTab='integrations';VF.rerender()", "location.hash='m-stations';VF.mgr.ui.stView='map';VF.mgr.ui.stSel=VF.state.stations[0].id;VF.rerender()"],
      driver: ["VF.ui.driver.sheet={type:'station',id:VF.state.stations[0].id};VF.rerender()", "VF.ui.driver.sheet={type:'notices'};VF.rerender()", "VF.ui.driver.sheet=null;location.hash='driver-vehicle'"],
      operator: [], admin: [], developer: [],
    };
    for (const js of (EXTRA[role] || []).concat(["document.querySelector('[data-act=\"bell\"],.bell,[data-act=\"notif-toggle\"]')&&document.querySelector('[data-act=\"bell\"],.bell,[data-act=\"notif-toggle\"]').click()", "var i=document.querySelector('#g-search,input[type=search]'); if(i){i.value='a';i.dispatchEvent(new Event('input',{bubbles:true}))}", "var a=document.querySelector('[data-act=\"acct-menu\"],.acct-btn,#acct-btn'); if(a) a.click()"])) {
      try { await p.evaluate(js); } catch (e) { hits.add('extra step failed: ' + js.slice(0, 50)); }
      await p.waitForTimeout(600);
      const found = await p.evaluate(() => ({ x: window.__x || null, el: document.querySelectorAll('[data-xss],[data-xss2]').length }));
      if (found.el || found.x) hits.add(`[${js.slice(0, 60)}]: ${found.el} injected${found.x ? ' · EXECUTED ' + JSON.stringify(found.x).slice(0, 160) : ''}`);
      await p.evaluate(() => { window.__x = null; });
    }
    // login screen with planted names
    await p.evaluate(() => { try { VF.ACT['signout'] ? VF.ACT['signout']() : null; } catch (e) {} });
    await p.waitForTimeout(800); for (const rr of ['manager','driver','operator','admin','developer']) { await p.evaluate((r) => { const b = document.querySelector(`[data-role="${r}"]`); if (b) b.click(); }, rr); await p.waitForTimeout(300); const f = await p.evaluate(() => ({ x: window.__x || null, el: document.querySelectorAll('[data-xss],[data-xss2]').length })); if (f.el || f.x) hits.add(`login(${rr}): ${f.el} injected${f.x ? ' EXECUTED' : ''}`); }
    // hover everything to trigger attribute handlers
    report.push(`${role}: planted ${planted} fields, ${navs.length} pages` + (hits.size ? '\n  ' + [...hits].join('\n  ') : ' · clean'));
    await ctx.close();
  }
  console.log(report.join('\n')); await b.close();
})();
