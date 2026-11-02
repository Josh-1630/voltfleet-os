/* VoltFleet OS — install the web app on a phone or computer (Progressive Web App).
   Android, Chrome, Edge and Samsung Internet: the browser's own install prompt (beforeinstallprompt).
   iPhone and iPad: Safari has no prompt, so we show the Share → Add to Home Screen steps.
   On a computer we also show a QR code to open VoltFleet on a phone in one scan. */
'use strict';
(function () {
  const { esc, icon } = VF;
  const C = VF.c;
  const DISMISS = 'voltfleet-os:install-dismissed';
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const isMobile = isIOS || isAndroid || /Mobi/.test(ua);
  const standalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  const I = VF.install = { prompt: null, installed: standalone(), isIOS, isAndroid, isMobile };

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); I.prompt = e; refresh(); });
  window.addEventListener('appinstalled', () => { I.installed = true; I.prompt = null; VF.toast('VoltFleet is installed. Open it from your home screen.'); refresh(); });
  if (window.matchMedia) window.matchMedia('(display-mode: standalone)').addEventListener('change', () => { I.installed = standalone(); refresh(); });
  function refresh() { for (const el of document.querySelectorAll('[data-install-slot]')) el.innerHTML = I.slot(el.dataset.installSlot); if (VF.rerender) VF.rerender(); }

  I.available = () => !I.installed;
  const dismissed = () => { try { return Date.now() - Number(localStorage.getItem(DISMISS) || 0) < 14 * 864e5; } catch (e) { return false; } };
  I.button = (cls) => (I.installed ? '' : `<button type="button" class="btn ${cls || ''}" data-act="install-app">${icon('download')}<span>Install app</span></button>`);
  I.slot = (kind) => (kind === 'signin' ? I.button('ghost small install-signin') : '');
  // Small banner on phones, shown until installed or dismissed (comes back after two weeks).
  I.banner = () => {
    if (I.installed || !isMobile || dismissed()) return '';
    return `<div class="install-banner" role="region" aria-label="Install the app"><img src="icons/icon-192.png" alt="" width="40" height="40"><div><strong>Install VoltFleet</strong><span class="small muted">Full screen, quick to open, works with a weak connection.</span></div><button class="btn small primary" data-act="install-app">Install</button><button class="icon-btn" data-act="install-dismiss" aria-label="Not now">${icon('x')}</button></div>`;
  };

  // QR code (MIT qrcode-generator, loaded only when needed)
  function loadQR() {
    if (window.qrcode) return Promise.resolve();
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'js/vendor/qrcode-generator-1.4.4.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  const appUrl = () => location.origin + location.pathname;
  async function qrSVG() {
    await loadQR();
    const q = window.qrcode(0, 'M'); q.addData(appUrl()); q.make();
    return q.createSvgTag({ cellSize: 5, margin: 2, scalable: true, alt: 'QR code to open VoltFleet', title: appUrl() });
  }

  function steps() {
    if (isIOS) return `<ol class="install-steps">
        <li><span class="step-n">1</span><div><strong>Tap the Share button</strong><span class="small muted">The square with an arrow, at the bottom of Safari (top right on iPad).</span></div>${icon('share')}</li>
        <li><span class="step-n">2</span><div><strong>Choose “Add to Home Screen”</strong><span class="small muted">Scroll down the list if you don’t see it.</span></div>${icon('square-plus')}</li>
        <li><span class="step-n">3</span><div><strong>Tap “Add”</strong><span class="small muted">VoltFleet appears on your home screen and opens full screen.</span></div>${icon('circle-check')}</li></ol>
      ${/CriOS|FxiOS|EdgiOS/.test(ua) ? '<p class="small muted">Using Chrome, Firefox or Edge on iPhone? The same option is in the browser’s Share menu (iOS 16.4 or later); otherwise open this page in Safari.</p>' : ''}`;
    if (isAndroid) return `<ol class="install-steps">
        <li><span class="step-n">1</span><div><strong>Open the browser menu</strong><span class="small muted">The ⋮ button in Chrome, or ≡ in Samsung Internet.</span></div>${icon('ellipsis-vertical')}</li>
        <li><span class="step-n">2</span><div><strong>Tap “Install app” or “Add to Home screen”</strong><span class="small muted">In Samsung Internet: “Add page to” → “Home screen”.</span></div>${icon('square-plus')}</li>
        <li><span class="step-n">3</span><div><strong>Confirm</strong><span class="small muted">VoltFleet appears with your other apps.</span></div>${icon('circle-check')}</li></ol>`;
    return `<ol class="install-steps">
        <li><span class="step-n">1</span><div><strong>On a computer</strong><span class="small muted">In Chrome or Edge, click the install icon at the right of the address bar, or the menu → “Install VoltFleet”.</span></div>${icon('monitor')}</li></ol>`;
  }
  I.open = async () => {
    if (I.installed) { VF.toast('VoltFleet is already installed on this device.'); return; }
    if (I.prompt) {
      const p = I.prompt; I.prompt = null;
      try { await p.prompt(); const r = await p.userChoice; if (r && r.outcome === 'dismissed') VF.toast('You can install VoltFleet any time from the account menu.'); } catch (e) { /* prompt unavailable */ }
      refresh(); return;
    }
    const desktop = !isMobile;
    C.modal({ title: desktop ? 'Install VoltFleet' : 'Install VoltFleet on your phone', sub: 'It opens full screen from your home screen, like any other app. No app store needed.', submitLabel: 'Done', onSubmit: () => null,
      body: `${desktop ? `<div class="install-qr"><div class="qr-box" id="install-qr">${C.skeleton(3)}</div><div><strong>Scan with your phone’s camera</strong><p class="small muted">Opens VoltFleet on your phone. Then tap “Install” in the banner, or follow the steps for your phone.</p><p class="small"><code>${esc(appUrl())}</code></p></div></div>
        <details class="install-more"><summary>Steps for each phone</summary>${(() => { const ios = `<h4>${icon('smartphone')}iPhone (Safari)</h4><p class="small muted">Share → Add to Home Screen → Add.</p>`; const and = `<h4>${icon('smartphone')}Android (Chrome)</h4><p class="small muted">Menu ⋮ → Install app (or Add to Home screen).</p>`; return ios + and; })()}</details>` : ''}
        ${steps()}`,
    });
    if (desktop) { try { const svg = await qrSVG(); const box = document.getElementById('install-qr'); if (box) box.innerHTML = svg; } catch (e) { const box = document.getElementById('install-qr'); if (box) box.innerHTML = '<p class="small muted">QR code unavailable offline.</p>'; } }
  };

  Object.assign(VF.ACT, {
    'install-app': () => I.open(),
    'install-dismiss': () => { try { localStorage.setItem(DISMISS, String(Date.now())); } catch (e) { /* not kept */ } VF.rerender(); },
  });
})();
