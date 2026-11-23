// Offline cache for the app shell, so dispatchers keep working through connectivity drops.
const CACHE = 'voltfleet-os-v28';
const SHELL = ['./', 'index.html', 'styles.css', 'js/core.js', 'js/icons.js', 'js/ui.js', 'js/install.js', 'js/car-photos.js', 'js/photos.js', 'js/motion.js', 'js/vendor/qrcode-generator-1.4.4.js', 'js/fleet.js', 'js/config.js', 'js/vendor/leaflet-1.9.4.js', 'js/vendor/leaflet-1.9.4.css', 'js/map.js', 'js/driver.js', 'js/operator.js', 'js/ocpp-sim.js', 'js/ocpp.js', 'js/admin.js', 'js/connect.js', 'js/manager.js', 'js/manager-more.js', 'js/intel.js', 'js/manager-intel.js', 'js/ops.js', 'js/manager-ops.js', 'js/driver-plus.js', 'js/smartcar.js', 'js/vendor/supabase-2.118.0.js', 'js/auth.js', 'js/cloud.js', 'js/app.js', 'manifest.webmanifest', 'icon.svg', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'fonts/geist-latin-wght-normal.woff2', 'fonts/geist-latin-ext-wght-normal.woff2', 'fonts/geist-mono-latin-wght-normal.woff2', 'fonts/geist-mono-latin-ext-wght-normal.woff2'];
// Each file is cached on its own, so one file that can't be fetched (a blocked font, a flaky connection) doesn't leave
// the whole app without offline support (QA round 3: cache.addAll fails as a unit).
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first, cache fallback: fresh when online, still usable offline.
// Only clean URLs are cached (QA R1-16): every page load is kept as the one app shell ('./'), and anything with a
// query string (one-time ?code= sign-in links, ?user_id=&state= from Smartcar, ?error=...) is never stored.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // never cache the sync API
  const nav = e.request.mode === 'navigate';
  const key = nav ? './' : url.search ? null : e.request;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && key && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(nav ? './' : e.request, { ignoreSearch: !nav && !!url.search }).then((r) => r || (nav ? caches.match('index.html') : undefined)).then((r) => r || Response.error()))
  );
});
