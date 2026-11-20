// fake-supabase.js (accounts, MFA, org workspaces) plus a demo world and Realtime callbacks driven from the test.
// In-memory stand-in for supabase-js used by the sign-in tests (the sandbox can't reach supabase.co).
// Mirrors the server functions in supabase/migrations/20261108_accounts.sql closely enough to drive the UI.
(function () {
  const KEY = 'fake-sb-db', SKEY = 'fake-sb-session';
  const load = () => JSON.parse(localStorage.getItem(KEY) || '{"users":{},"profiles":{},"orgs":{},"invites":[],"worlds":{}}');
  const save = (db) => localStorage.setItem(KEY, JSON.stringify(db));
  const uuid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
  const sess = () => JSON.parse(localStorage.getItem(SKEY) || 'null');
  const uid = () => { const s = sess(); return s && s.user.id; };
  const err = (m) => ({ data: null, error: { message: m } });
  const STAFF = ['manager', 'operator', 'developer', 'admin'];
  const mfaReq = (db) => { const p = db.profiles[uid()]; const se = sess(); return !!(p && STAFF.includes(p.role) && (!se || se.aal !== 'aal2')); };
  const needMfa = (db) => { if (mfaReq(db)) throw new Error('Two-factor sign-in required.'); };
  function account(db) {
    const id = uid(); const p = db.profiles[id]; const u = db.users[id]; const o = p && p.org_id && db.orgs[p.org_id];
    const req = mfaReq(db);
    return { id, email: u.email, phone: null, confirmed: !!u.confirmed, full_name: p.full_name, role: p.role, mfa_required: req, aal: (sess() || {}).aal || 'aal1', org: o ? { id: o.id, name: o.name, kind: o.kind } : null,
      members: o && !req ? Object.values(db.profiles).filter((m) => m.org_id === o.id).map((m) => ({ id: m.id, full_name: m.full_name, role: m.role, you: m.id === id })) : [],
      invites: o && !req && ['manager', 'operator', 'developer'].includes(p.role) ? db.invites.filter((i) => i.org_id === o.id && !i.accepted).map((i) => ({ id: i.id, email: i.email, role: i.role })) : [] };
  }
  function createOrg(db, kind, name) {
    const id = uid(); const p = db.profiles[id];
    if (p.org_id) throw new Error('You already belong to an organisation.');
    if (!db.users[id].confirmed) throw new Error('Confirm your email address first.');
    const role = { fleet: 'manager', operator: 'operator', developer: 'developer', driver: 'driver' }[kind]; if (!role) throw new Error('Choose an account type.');
    if (kind === 'driver' && (!name || name.length < 2)) name = p.full_name || 'My account';
    if (!name || name.length < 2) throw new Error('Give your organisation a name.');
    const oid = uuid(); db.orgs[oid] = { id: oid, name: name.replace(/[<>"`]/g, ''), kind }; p.org_id = oid; p.role = role; db.worlds[oid] = { org_id: oid, rev: 0, state_gz: null };
  }
  const RPC = {
    complete_signup(db) {
      const id = uid(); const p = db.profiles[id]; const u = db.users[id];
      if (p.org_id) return Object.assign(account(db), { status: 'ready' });
      if (!u.confirmed) return Object.assign(account(db), { status: 'unconfirmed' });
      const inv = db.invites.find((i) => i.email === u.email.toLowerCase() && !i.accepted);
      if (inv) { p.org_id = inv.org_id; p.role = inv.role; inv.accepted = true; return Object.assign(account(db), { status: 'ready' }); }
      if (u.meta && u.meta.account_type) { try { createOrg(db, u.meta.account_type, u.meta.org_name); return Object.assign(account(db), { status: 'ready' }); } catch (e) { return Object.assign(account(db), { status: 'needs_onboarding', error: e.message }); } }
      return Object.assign(account(db), { status: 'needs_onboarding' });
    },
    my_account: (db) => account(db),
    create_organization(db, a) { createOrg(db, a.p_kind, a.p_name); return account(db); },
    update_my_name(db, a) { db.profiles[uid()].full_name = a.p_name; return account(db); },
    invite_member(db, a) { needMfa(db); const p = db.profiles[uid()]; if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(a.p_email || '')) throw new Error('Enter a valid email address.'); db.invites.push({ id: uuid(), org_id: p.org_id, email: a.p_email.toLowerCase(), role: p.role }); return account(db); },
    revoke_invite(db, a) { db.invites = db.invites.filter((i) => i.id !== a.p_id); return account(db); },
    remove_member(db, a) { db.profiles[a.p_user].org_id = null; db.profiles[a.p_user].role = 'pending'; return account(db); },
    delete_my_account(db) { needMfa(db); const id = uid(); delete db.users[id]; delete db.profiles[id]; return { ok: true }; },
    org_world_tick(db, a) { needMfa(db); const p = db.profiles[uid()]; const w = db.worlds[p.org_id]; if (w.rev !== a.p_expected) return { ok: false, reason: 'stale', rev: w.rev, leader: true }; w.rev++; w.state_gz = a.p_state; return { ok: true, rev: w.rev, leader: true }; },
    org_world_push(db, a) { needMfa(db); const p = db.profiles[uid()]; const w = db.worlds[p.org_id]; w.rev++; w.state_gz = a.p_state; return { ok: true, rev: w.rev }; },
    admin_overview() { throw new Error('Platform admins only.'); },
  };
  const listeners = [];
  window.supabase = {
    createClient() {
      return {
        auth: {
          async getSession() { return { data: { session: sess() }, error: null }; },
          async signInWithPassword({ email, password }) { const db = load(); const u = Object.values(db.users).find((x) => x.email === email); if (!u || u.password !== password) return err('Invalid login credentials'); if (!u.confirmed) return err('Email not confirmed'); const s = { user: { id: u.id, email }, aal: 'aal1' }; localStorage.setItem(SKEY, JSON.stringify(s)); return { data: { session: s }, error: null }; },
          async signUp({ email, password, options }) { const db = load(); if (Object.values(db.users).some((x) => x.email === email)) return err('User already registered'); const id = uuid(); const auto = localStorage.getItem('fake-autoconfirm') === '1'; db.users[id] = { id, email, password, confirmed: auto, meta: options && options.data }; db.profiles[id] = { id, full_name: (options && options.data && options.data.full_name) || '', role: 'pending', org_id: null }; save(db); if (auto) { const s = { user: { id, email }, aal: 'aal1' }; localStorage.setItem(SKEY, JSON.stringify(s)); return { data: { user: s.user, session: s }, error: null }; } return { data: { user: { id, email }, session: null }, error: null }; },
          async signInWithOtp() { return { data: {}, error: null }; }, async verifyOtp() { return err('Token has expired or is invalid'); },
          async resetPasswordForEmail() { return { data: {}, error: null }; }, async resend() { return { data: {}, error: null }; },
          async updateUser({ password }) { const db = load(); db.users[uid()].password = password; save(db); return { data: {}, error: null }; },
          async signOut() { localStorage.removeItem(SKEY); return { error: null }; },
          mfa: {
            async listFactors() { const db = load(); const fs = (db.factors || []).filter((f) => f.user === uid()); return { data: { all: fs, totp: fs }, error: null }; },
            async enroll({ friendlyName }) { const db = load(); db.factors = db.factors || []; const id = uuid(); db.factors.push({ id, user: uid(), status: 'unverified', friendly_name: friendlyName, factor_type: 'totp', created_at: new Date().toISOString() }); save(db); return { data: { id, type: 'totp', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="2" height="2"/><rect x="2" y="2" width="2" height="2"/></svg>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/VoltFleet' } }, error: null }; },
            async unenroll({ factorId }) { const db = load(); db.factors = (db.factors || []).filter((f) => f.id !== factorId); save(db); return { data: {}, error: null }; },
            async challengeAndVerify({ factorId, code }) { if (code !== '123456') return err('Invalid TOTP code entered'); const db = load(); const f = (db.factors || []).find((x) => x.id === factorId); if (!f) return err('Factor not found'); f.status = 'verified'; save(db); const se = sess(); se.aal = 'aal2'; localStorage.setItem(SKEY, JSON.stringify(se)); return { data: {}, error: null }; },
            async getAuthenticatorAssuranceLevel() { const db = load(); const has = (db.factors || []).some((f) => f.user === uid() && f.status === 'verified'); return { data: { currentLevel: (sess() || {}).aal || 'aal1', nextLevel: has ? 'aal2' : 'aal1' }, error: null }; },
          },
          onAuthStateChange(cb) { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
        },
        async rpc(fn, args) {
          if (fn === 'world_tick' || fn === 'world_push') return err('offline (test)');
          const db = load(); if (!uid()) return err('not signed in');
          try { const r = RPC[fn](db, args || {}); save(db); return { data: JSON.parse(JSON.stringify(r)), error: null }; } catch (e) { return err(e.message); }
        },
        from(table) {
          const q = { _eq: null, select() { return q; }, eq(c, v) { q._eq = v; return q; }, order() { return q; }, limit() { return Promise.resolve({ data: [], error: null }); },
            async maybeSingle() { if (table === 'worlds') return err('offline (test)'); const db = load(); const w = db.worlds[q._eq]; const p = db.profiles[uid()]; if (!p || p.org_id !== q._eq || mfaReq(db)) return { data: null, error: null }; return { data: w ? Object.assign({}, w) : null, error: null }; } };
          return q;
        },
        channel() { const ch = { on() { return ch; }, subscribe(cb) { setTimeout(() => cb && cb('SUBSCRIBED'), 0); return ch; } }; return ch; },
      };
    },
  };
})();
(function () {
  const base = window.supabase.createClient;
  window.__rt = [];
  window.__demo = { rev: 5000, state_gz: null };
  window.supabase.createClient = function () {
    const c = base.apply(this, arguments);
    const rpc0 = c.rpc.bind(c), from0 = c.from.bind(c);
    c.rpc = async (fn, a) => {
      const D = window.__demo;
      if (fn === 'world_tick') { if (!D.state_gz) { D.state_gz = a.p_state; D.rev++; return { data: { ok: true, rev: D.rev, leader: true }, error: null }; } return { data: { ok: false, reason: 'not_leader', rev: D.rev, leader: false }, error: null }; }
      if (fn === 'world_push') { D.rev++; D.state_gz = a.p_state; return { data: { ok: true, rev: D.rev }, error: null }; }
      return rpc0(fn, a);
    };
    c.from = (table) => { if (table !== 'worlds') return from0(table); const q = { select() { return q; }, eq() { return q; }, async maybeSingle() { const D = window.__demo; return { data: D.state_gz ? { rev: D.rev, state_gz: D.state_gz, leader_id: 'other' } : null, error: null }; } }; return q; };
    c.channel = (name) => { const ch = { on(_t, f, cb) { window.__rt.push({ name, filter: f.filter, cb }); return ch; }, subscribe(cb) { setTimeout(() => cb && cb('SUBSCRIBED'), 0); return ch; } }; return ch; };
    return c;
  };
})();
