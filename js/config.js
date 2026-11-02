/* VoltFleet OS — integration settings. Nothing secret belongs in this file: it is served to every browser.

   Cloud sync: the publishable key is safe to ship in the browser. The database only allows reads of the demo
   world, and writes go through two checked functions (world_tick, world_push). Remove `url` to run fully offline. */
window.VOLTFLEET_CLOUD = {
  url: 'https://kwxadepnkyxgspvvqbzo.supabase.co',
  key: 'sb_publishable_XrkE8_IRZ1ejAOvdynd6bQ_nTAdog7c',
  region: 'London (eu-west-2)',
};

/* Maps: street maps drawn with Leaflet (js/vendor). Choose a tile provider:
     'carto'    CARTO Positron / Dark Matter. No key. Free for low traffic and non-commercial use; a commercial
                launch needs a CARTO licence or another provider.
     'osm'      OpenStreetMap's own tiles. No key. Light use only (tile.openstreetmap.org usage policy).
     'maptiler' MapTiler streets. Needs `key`: create one at maptiler.com and restrict it to your domain.
     'mapbox'   Mapbox light/dark. Needs `key` (a public pk. token restricted to your domain).
     'custom'   Your own tiles: set `url` (with {z}/{x}/{y}) and `attribution`.
     'none'     The built-in schematic map, no network needed.
   Routes: 'osrm' snaps journey lines to real roads through an OSRM server. The default is the public demo
   server, which is for testing only; run your own OSRM (or set routing: 'none') for production. */
window.VOLTFLEET_MAPS = {
  provider: 'carto',
  key: '',
  routing: 'osrm',
  osrmUrl: 'https://router.project-osrm.org',
};
