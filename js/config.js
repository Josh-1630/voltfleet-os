/* VoltFleet OS — cloud sync settings.
   The publishable key is safe to ship in the browser: the database only allows reads of the demo world,
   and writes go through two checked functions (world_tick, world_push). Remove `url` to run fully offline. */
window.VOLTFLEET_CLOUD = {
  url: 'https://kwxadepnkyxgspvvqbzo.supabase.co',
  key: 'sb_publishable_XrkE8_IRZ1ejAOvdynd6bQ_nTAdog7c',
  region: 'London (eu-west-2)',
};
