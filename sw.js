// Offline cache for the app shell, so dispatchers keep working through connectivity drops.
const CACHE = 'voltfleet-os-v8';
const SHELL = ['./', 'index.html', 'styles.css', 'js/core.js', 'js/icons.js', 'js/ui.js', 'js/fleet.js', 'js/config.js', 'js/vendor/leaflet-1.9.4.js', 'js/vendor/leaflet-1.9.4.css', 'js/map.js', 'js/driver.js', 'js/operator.js', 'js/admin.js', 'js/connect.js', 'js/manager.js', 'js/manager-more.js', 'js/vendor/supabase-2.118.0.js', 'js/cloud.js', 'js/app.js', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return; // never cache the sync API
  // Network first, cache fallback: fresh when online, still usable offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && new URL(e.request.url).origin === location.origin) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
