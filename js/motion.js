/* VoltFleet OS — motion.
   Pages glide in with staggered cards, key numbers count up, charts draw themselves and the dashboard hero
   cycles through the fleet's cars. Entrance effects run only when you open a page, never on the live updates
   that follow. Settings → Appearance → Motion can reduce it, and the system "reduce motion" setting is honoured. */
'use strict';
(function () {
  const KEY = 'voltfleet-os:motion';
  const M = VF.motion = { slide: 0,
    get() { try { return localStorage.getItem(KEY) === 'reduced' ? 'reduced' : 'full'; } catch (e) { return 'full'; } },
    set(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* not kept */ } document.documentElement.setAttribute('data-motion', v); const view = document.getElementById('view'); if (v === 'reduced' && view) view.classList.remove('enter'); },
    reduced() { return M.get() === 'reduced' || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); },
  };
  M.set(M.get());

  let timer = null;
  // Called by the shell after a page is opened (not after live re-renders).
  M.enter = (view) => {
    if (M.reduced()) return;
    view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter');
    clearTimeout(timer); timer = setTimeout(() => view.classList.remove('enter'), 1900);
    requestAnimationFrame(() => countUp(view));
  };

  // Count numbers up from zero, keeping their format (currency prefix, thousands separators, decimals, units).
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function firstNumberNode(el) {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (/\d/.test(n.nodeValue)) return n;
    return null;
  }
  function countUp(root) {
    const nodes = root.querySelectorAll('.stat-num, .big-metric > span, .dh-stats .stat-value, .wa-gauge b, .sustain-figs strong');
    nodes.forEach((el, k) => {
      const node = firstNumberNode(el); if (!node) return;
      const m = node.nodeValue.match(/^([^\d-]*)(-?\d[\d,]*(?:\.\d+)?)([\s\S]*)$/); if (!m) return;
      const target = parseFloat(m[2].replace(/,/g, '')); if (!isFinite(target) || target === 0) return;
      const dec = (m[2].split('.')[1] || '').length; const grouped = m[2].includes(',') || Math.abs(target) >= 1000;
      const fmtN = (x) => (grouped ? x.toLocaleString('en-GB', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : x.toFixed(dec));
      const t0 = performance.now() + k * 45, dur = 900; let last = null; const final = node.nodeValue;
      const step = (now) => {
        if (last !== null && node.nodeValue !== last) return; // a live update replaced it: stop
        const t = Math.min(1, Math.max(0, (now - t0) / dur));
        last = t >= 1 ? final : m[1] + fmtN(target * ease(t)) + m[3];
        node.nodeValue = last;
        if (t < 1) requestAnimationFrame(step);
      };
      node.nodeValue = last = m[1] + fmtN(0) + m[3];
      requestAnimationFrame(step);
    });
  }

  // Dashboard hero: cycle through the fleet's cars.
  setInterval(() => {
    if (document.hidden || M.reduced()) return;
    for (const box of document.querySelectorAll('[data-slides]')) {
      const s = box.querySelectorAll('.wa-slide'); if (s.length < 2) continue;
      s.forEach((x) => x.classList.remove('on')); s[(M.slide + 1) % s.length].classList.add('on');
    }
    M.slide++;
  }, 4500);

  Object.assign(VF.ACT, { 'motion-set': (el) => { M.set(el.dataset.k); VF.toast(el.dataset.k === 'reduced' ? 'Motion reduced' : 'Full motion on'); VF.rerender(); } });
})();
