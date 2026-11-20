// In-memory stand-in for supabase-js used by the sign-in tests (the sandbox can't reach supabase.co).
// Mirrors the server functions in supabase/migrations/20261108_accounts.sql closely enough to drive the UI.
// QA round 2: invitations need consent and expire, organisations have an owner, workspace pushes are
// compare-and-swap (20261116_invites_owner.sql, 20261116_sync_cas.sql). Set localStorage 'fake-legacy' = '1' to get
// the old auto-joining, unconditional-push behaviour of the live functions.
// QA round 3: localStorage 'fake-r3' = '1' adds the round-3 migrations (20261117_*): authenticators count only once
// confirmed by email (sessions carry amr; sign-in links are "delivered" to localStorage 'fake-magic'),
// trust_my_factor, record_event, and the world_heads / org_world_heads tables. Without it the fake is the round-2
// server (what is live today).
(function () {
  const KEY = 'fake-sb-db', SKEY = 'fake-sb-session';
  const load = () => JSON.parse(localStorage.getItem(KEY) || '{"users":{},"profiles":{},"orgs":{},"invites":[],"worlds":{}}');
  const save = (db) => localStorage.setItem(KEY, JSON.stringify(db));
  const uuid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
  const sess = () => JSON.parse(localStorage.getItem(SKEY) || 'null');
  const uid = () => { const s = sess(); return s && s.user.id; };
  const err = (m) => ({ data: null, error: { message: m } });
  const STAFF = ['manager', 'operator', 'developer', 'admin'];
  const legacy = () => localStorage.getItem('fake-legacy') === '1';
  const r3 = () => localStorage.getItem('fake-r3') === '1' && !legacy();
  const nowS = () => Math.floor(Date.now() / 1000);
  const newSession = (u, method) => ({ user: { id: u.id, email: u.email }, aal: 'aal1', amr: [{ method, timestamp: nowS() }], access_token: 'fake.' + btoa(JSON.stringify({ sub: u.id, role: 'authenticated' })).replace(/=+$/, '') + '.sig' });
  const untrusted = (db, id) => (db.factors || []).filter((f) => f.user === id && f.status === 'verified' && !f.trusted).length;
  const emailProof = () => { const se = sess(); return !!(se && (se.amr || []).some((a) => a.method && !['password', 'totp', 'token_refresh', 'anonymous', 'web3', 'phone'].includes(a.method) && !/^mfa\//.test(a.method) && a.timestamp > nowS() - 3600)); };
  const missing = (fn) => { const e = new Error('Could not find the function public.' + fn + ' in the schema cache'); e.code = 'PGRST202'; return e; };
  const openInvites = (db, email) => db.invites.filter((i) => i.email === String(email || '').toLowerCase() && !i.accepted && !i.declined && (i.expires || Infinity) > Date.now());
  const mfaReq = (db) => { const p = db.profiles[uid()]; const se = sess(); return !!(p && STAFF.includes(p.role) && (!se || se.aal !== 'aal2' || (r3() && untrusted(db, p.id) > 0))); };
  const needMfa = (db) => { if (mfaReq(db)) throw new Error('Two-factor sign-in required.'); };
  function account(db) {
    const id = uid(); const p = db.profiles[id]; const u = db.users[id]; const o = p && p.org_id && db.orgs[p.org_id];
    const req = mfaReq(db);
    const a = { id, email: u.email, phone: null, confirmed: !!u.confirmed, full_name: p.full_name, role: p.role, mfa_required: req, aal: (sess() || {}).aal || 'aal1', org: o ? { id: o.id, name: o.name, kind: o.kind } : null,
      members: o && !req ? Object.values(db.profiles).filter((m) => m.org_id === o.id).map((m) => ({ id: m.id, full_name: m.full_name, role: m.role, you: m.id === id, owner: m.id === o.owner })) : [],
      invites: o && !req && ['manager', 'operator', 'developer'].includes(p.role) ? db.invites.filter((i) => i.org_id === o.id && !i.accepted).map((i) => ({ id: i.id, email: i.email, role: i.role, expires_at: i.expires, expired: i.expires <= Date.now(), declined: !!i.declined })) : [] };
    if (!legacy()) a.owner = !!(o && o.owner === id);
    if (r3()) a.mfa_trust = { untrusted: untrusted(db, id), email_proof: emailProof() };
    return a;
  }
  function createOrg(db, kind, name) {
    const id = uid(); const p = db.profiles[id];
    if (p.org_id) throw new Error('You already belong to an organisation.');
    if (!db.users[id].confirmed) throw new Error('Confirm your email address first.');
    const role = { fleet: 'manager', operator: 'operator', developer: 'developer', driver: 'driver' }[kind]; if (!role) throw new Error('Choose an account type.');
    if (kind === 'driver' && (!name || name.length < 2)) name = p.full_name || 'My account';
    if (!name || name.length < 2) throw new Error('Give your organisation a name.');
    const oid = uuid(); db.orgs[oid] = { id: oid, name: name.replace(/[<>"`]/g, ''), kind, owner: id }; p.org_id = oid; p.role = role; db.worlds[oid] = { org_id: oid, rev: 0, state_gz: null };
  }
  const RPC = {
    complete_signup(db) {
      const id = uid(); const p = db.profiles[id]; const u = db.users[id];
      if (p.org_id) return Object.assign(account(db), { status: 'ready' });
      if (!u.confirmed) return Object.assign(account(db), { status: 'unconfirmed' });
      if (legacy()) { const inv = db.invites.find((i) => i.email === u.email.toLowerCase() && !i.accepted); if (inv) { p.org_id = inv.org_id; p.role = inv.role; inv.accepted = true; return Object.assign(account(db), { status: 'ready' }); } }
      const invs = openInvites(db, u.email);
      if (invs.length) return Object.assign(account(db), { status: 'invited', pending_invites: invs.map((i) => ({ id: i.id, org_name: db.orgs[i.org_id].name, org_kind: db.orgs[i.org_id].kind, role: i.role, invited_at: new Date(i.at || Date.now()).toISOString(), expires_at: new Date(i.expires).toISOString() })) });
      if (u.meta && u.meta.account_type) { try { createOrg(db, u.meta.account_type, u.meta.org_name); return Object.assign(account(db), { status: 'ready' }); } catch (e) { return Object.assign(account(db), { status: 'needs_onboarding', error: e.message }); } }
      return Object.assign(account(db), { status: 'needs_onboarding' });
    },
    my_account: (db) => account(db),
    my_invitations(db) { return RPC.complete_signup(db).pending_invites || []; },
    accept_invite(db, a) { const p = db.profiles[uid()]; if (p.org_id) throw new Error('You already belong to an organisation. Leave it first.'); const inv = openInvites(db, db.users[uid()].email).find((i) => i.id === a.p_id); if (!inv) throw new Error('This invitation is no longer open.'); p.org_id = inv.org_id; p.role = inv.role; inv.accepted = true; return Object.assign(account(db), { status: 'ready' }); },
    decline_invite(db, a) { const inv = openInvites(db, db.users[uid()].email).find((i) => i.id === a.p_id); if (inv) inv.declined = true; return RPC.complete_signup(db); },
    leave_organization(db) { needMfa(db); const p = db.profiles[uid()]; const o = db.orgs[p.org_id]; if (o && o.owner === p.id) throw new Error('You own this organisation, so you can’t leave it.'); p.org_id = null; p.role = 'pending'; return account(db); },
    create_organization(db, a) { createOrg(db, a.p_kind, a.p_name); return account(db); },
    update_my_name(db, a) { db.profiles[uid()].full_name = a.p_name; return account(db); },
    invite_member(db, a) { needMfa(db); const p = db.profiles[uid()]; if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(a.p_email || '')) throw new Error('Enter a valid email address.'); db.invites = db.invites.filter((i) => !(i.org_id === p.org_id && i.email === a.p_email.toLowerCase())); db.invites.push({ id: uuid(), org_id: p.org_id, email: a.p_email.toLowerCase(), role: p.role, at: Date.now(), expires: Date.now() + 7 * 864e5 }); return account(db); },
    revoke_invite(db, a) { db.invites = db.invites.filter((i) => i.id !== a.p_id); return account(db); },
    remove_member(db, a) { needMfa(db); const me = db.profiles[uid()]; const o = db.orgs[me.org_id]; if (!legacy() && o && o.owner === a.p_user) throw new Error('The organisation’s owner can’t be removed.'); if (!legacy() && o && o.owner !== me.id) throw new Error('Only the organisation’s owner can remove people.'); db.profiles[a.p_user].org_id = null; db.profiles[a.p_user].role = 'pending'; return account(db); },
    delete_my_account(db) { needMfa(db); const id = uid(); delete db.users[id]; delete db.profiles[id]; return { ok: true }; },
    org_world_tick(db, a) { needMfa(db); const p = db.profiles[uid()]; const w = db.worlds[p.org_id]; if (w.rev !== a.p_expected) return { ok: false, reason: 'stale', rev: w.rev, leader: true }; w.rev++; w.state_gz = a.p_state; return { ok: true, rev: w.rev, leader: true }; },
    org_world_push(db, a) { needMfa(db); if (legacy() && a.p_expected !== undefined) { const e = new Error('Could not find the function public.org_world_push(p_expected, p_state) in the schema cache'); e.code = 'PGRST202'; throw e; } const p = db.profiles[uid()]; const w = db.worlds[p.org_id]; if (a.p_expected != null && a.p_expected !== w.rev) return { ok: false, reason: 'stale', rev: w.rev }; w.rev++; w.state_gz = a.p_state; return { ok: true, rev: w.rev }; },
    admin_overview() { throw new Error('Platform admins only.'); },
    trust_my_factor(db, a) {
      if (!r3()) throw missing('trust_my_factor');
      const se = sess(); if (!se || se.aal !== 'aal2') throw new Error('Enter a code from your authenticator first.');
      const mine = (db.factors || []).filter((f) => f.user === uid() && f.status === 'verified');
      if (a.p_factor && !mine.some((f) => f.id === a.p_factor)) throw new Error('That authenticator isn’t set up on your account.');
      const others = mine.filter((f) => f.id !== a.p_factor);
      const how = emailProof() ? 'email' : a.p_factor && others.some((f) => f.trusted) && others.every((f) => f.trusted) ? 'trusted factor' : null;
      if (!how) { const e = new Error('Confirm it’s you by email first: open the sign-in link we email you.'); e.code = '42501'; throw e; }
      for (const f of mine) if (!a.p_factor || f.id === a.p_factor) { f.trusted = how; }
      (db.audit = db.audit || []).push({ action: 'two-factor device confirmed', how });
      return account(db);
    },
    record_event(db, a) { if (!r3()) throw missing('record_event'); needMfa(db); (db.audit = db.audit || []).push({ action: 'app: ' + a.p_action, target: a.p_target, reason: a.p_reason, at: Date.now() }); return null; },
  };
  const listeners = [];
  window.supabase = {
    createClient() {
      return {
        auth: {
          async getSession() {
            // An emailed sign-in link opened in this browser (?code=fake-magic-<token>), like the PKCE exchange.
            const m = /[?&]code=fake-magic-([a-z0-9]+)/.exec(location.search); const sent = JSON.parse(localStorage.getItem('fake-magic') || 'null');
            if (m && sent && sent.token === m[1]) { const db = load(); const u = Object.values(db.users).find((x) => x.email === sent.email); localStorage.removeItem('fake-magic'); if (u) localStorage.setItem(SKEY, JSON.stringify(newSession(u, 'magiclink'))); }
            return { data: { session: sess() }, error: null };
          },
          async signInWithPassword({ email, password }) { const db = load(); const u = Object.values(db.users).find((x) => x.email === email); if (!u || u.password !== password) return err('Invalid login credentials'); if (!u.confirmed) return err('Email not confirmed'); const s = newSession(u, 'password'); localStorage.setItem(SKEY, JSON.stringify(s)); return { data: { session: s }, error: null }; },
          async signUp({ email, password, options }) { const db = load(); if (Object.values(db.users).some((x) => x.email === email)) return err('User already registered'); const id = uuid(); const auto = localStorage.getItem('fake-autoconfirm') === '1'; db.users[id] = { id, email, password, confirmed: auto, meta: options && options.data }; db.profiles[id] = { id, full_name: (options && options.data && options.data.full_name) || '', role: 'pending', org_id: null }; save(db); if (auto) { const s = newSession({ id, email }, 'email/signup'); localStorage.setItem(SKEY, JSON.stringify(s)); return { data: { user: s.user, session: s }, error: null }; } return { data: { user: { id, email }, session: null }, error: null }; },
          async signInWithOtp(o) { if (o && o.email) { const token = Math.random().toString(36).slice(2, 10); localStorage.setItem('fake-magic', JSON.stringify({ email: o.email, token, redirect: o.options && o.options.emailRedirectTo })); } return { data: {}, error: null }; }, async verifyOtp() { return err('Token has expired or is invalid'); },
          async resetPasswordForEmail() { return { data: {}, error: null }; }, async resend() { return { data: {}, error: null }; },
          async updateUser({ password }) { const db = load(); db.users[uid()].password = password; save(db); return { data: {}, error: null }; },
          async signOut() { localStorage.removeItem(SKEY); return { error: null }; },
          mfa: {
            async listFactors() { const db = load(); const fs = (db.factors || []).filter((f) => f.user === uid()); return { data: { all: fs, totp: fs }, error: null }; },
            async enroll({ friendlyName }) { const db = load(); db.factors = db.factors || []; const id = uuid(); db.factors.push({ id, user: uid(), status: 'unverified', friendly_name: friendlyName, factor_type: 'totp', created_at: new Date().toISOString() }); save(db); return { data: { id, type: 'totp', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="2" height="2"/><rect x="2" y="2" width="2" height="2"/></svg>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/VoltFleet' } }, error: null }; },
            async unenroll({ factorId }) { const db = load(); db.factors = (db.factors || []).filter((f) => f.id !== factorId); save(db); return { data: {}, error: null }; },
            async challengeAndVerify({ factorId, code }) { if (code !== '123456') return err('Invalid TOTP code entered'); const db = load(); const f = (db.factors || []).find((x) => x.id === factorId); if (!f) return err('Factor not found'); f.status = 'verified'; save(db); const se = sess(); se.aal = 'aal2'; se.amr = (se.amr || []).concat([{ method: 'totp', timestamp: nowS() }]); localStorage.setItem(SKEY, JSON.stringify(se)); return { data: {}, error: null }; },
            async getAuthenticatorAssuranceLevel() { const db = load(); const has = (db.factors || []).some((f) => f.user === uid() && f.status === 'verified'); return { data: { currentLevel: (sess() || {}).aal || 'aal1', nextLevel: has ? 'aal2' : 'aal1' }, error: null }; },
          },
          onAuthStateChange(cb) { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
        },
        async rpc(fn, args) {
          if (fn === 'world_tick' || fn === 'world_push') return err('offline (test)');
          const db = load(); if (!uid()) return err('not signed in');
          try { const r = RPC[fn](db, args || {}); save(db); return { data: JSON.parse(JSON.stringify(r)), error: null }; } catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
        },
        from(table) {
          const q = { _eq: null, select() { return q; }, eq(c, v) { q._eq = v; return q; }, order() { return q; }, limit() { return Promise.resolve({ data: [], error: null }); },
            async maybeSingle() { if (table === 'worlds' || table === 'world_heads') return err('offline (test)');
              if (table === 'org_world_heads' && !r3()) return { data: null, error: { code: '42P01', message: 'relation "public.org_world_heads" does not exist' } }; const db = load(); const w = db.worlds[q._eq]; const p = db.profiles[uid()]; if (!p || p.org_id !== q._eq || mfaReq(db)) return { data: null, error: null }; return { data: w ? Object.assign({}, w) : null, error: null }; } };
          return q;
        },
        channel() { const ch = { on() { return ch; }, subscribe(cb) { setTimeout(() => cb && cb('SUBSCRIBED'), 0); return ch; } }; return ch; },
      };
    },
  };
})();
