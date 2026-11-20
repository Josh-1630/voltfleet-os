// Supabase stand-in for sync tests: the demo world lives in the Node test process (window.__srv binding),
// implementing world_tick / world_push exactly as supabase/migrations/20261108_world_hardening.sql does.
(function () {
  const err = (m) => ({ data: null, error: { message: m } });
  window.__rtSubs = [];
  window.__netDown = false;
  const call = async (op, args) => { if (window.__netDown) return err('Failed to fetch'); return window.__srv(op, args); };
  window.supabase = { createClient() { return {
    auth: { async getSession() { return { data: { session: null }, error: null }; }, onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; }, mfa: { async getAuthenticatorAssuranceLevel() { return { data: null }; } } },
    async rpc(fn, a) { return call(fn, a); },
    from(table) { const q = { select(c) { q.c = c; return q; }, eq() { return q; }, order() { return q; }, limit() { return Promise.resolve({ data: [], error: null }); }, async maybeSingle() { return call('select', { cols: q.c }); } }; return q; },
    channel() { const ch = { on(_t, _f, cb) { window.__rtSubs.push(cb); return ch; }, subscribe(cb) { setTimeout(() => cb && cb('SUBSCRIBED'), 0); return ch; } }; return ch; },
  }; } };
})();
