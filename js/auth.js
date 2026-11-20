/* VoltFleet OS — real accounts with Supabase Auth.
   Sign in with email + password, an emailed sign-in link, or a phone code (when an SMS provider is enabled in
   Supabase). New accounts pick a type (fleet, charge-point operator, driver, developer); the server creates their
   organisation and sets their role. Each organisation works in its own private workspace (public.org_worlds),
   readable and writable only by its members (RLS + server functions). The public demo stays available.
   Sessions are kept by supabase-js (PKCE flow). No secrets live in this file. */
'use strict';
(function () {
  const { esc, icon } = VF;
  const cfg = window.VOLTFLEET_CLOUD || {};
  const A = VF.auth = { enabled: false, sb: null, session: null, account: null, phone: false, busy: false };
  const ACCT_CACHE = 'voltfleet-os:account';
  const ORG_PREFIX = 'voltfleet-os:org:';
  if (!cfg.url || !cfg.key || !window.supabase || typeof window.supabase.createClient !== 'function') return;
  A.enabled = true;
  const sb = A.sb = VF.sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', storageKey: 'voltfleet-os:auth' } });
  const redirect = () => location.origin + location.pathname;
  const TYPES = [
    ['fleet', 'Fleet', 'truck', 'I run company vehicles'],
    ['operator', 'Charge point operator', 'plug-zap', 'I run charging stations'],
    ['driver', 'Driver', 'car-front', 'I drive an electric car'],
    ['developer', 'Developer', 'code', 'I build on the VoltFleet API'],
  ];
  const ROLE_LABEL = { manager: 'Fleet manager', operator: 'Operator', driver: 'Driver', developer: 'Developer', admin: 'Platform admin', pending: 'New account' };

  // ---------------------------------------------------------------- errors people can act on
  function friendly(e) {
    const m = String((e && (e.message || e.error_description)) || e || 'Something went wrong');
    if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
    if (/email not confirmed/i.test(m)) return 'Confirm your email first: open the link we sent you, then sign in.';
    if (/user already registered|already been registered/i.test(m)) return 'An account already uses that email. Sign in instead, or reset your password.';
    if (/captcha/i.test(m)) return 'The security check didn’t pass. Complete it again and retry.';
    if (/for security purposes|rate limit|too many/i.test(m)) return 'Too many attempts. Wait a minute and try again.';
    if (/password should be|weak password|pwned/i.test(m)) return 'Choose a stronger password: at least 10 characters, not one that has appeared in a data breach.';
    if (/signups not allowed|signup is disabled/i.test(m)) return 'New sign-ups are closed right now.';
    if (/phone.*(disabled|provider)|sms/i.test(m)) return 'Phone sign-in isn’t switched on yet. Use email.';
    if (/failed to fetch|network/i.test(m)) return 'Can’t reach VoltFleet. Check your connection and try again.';
    if (/invalid totp|invalid mfa|code.*(invalid|incorrect)/i.test(m)) return 'That code didn’t work. Check your phone’s clock is right and enter the newest code.';
    if (/mfa.*(disabled|not enabled)|enroll.*disabled/i.test(m)) return 'Two-factor sign-in isn’t switched on for this project yet (Supabase → Authentication → MFA).';
    if (/two-factor sign-in required|aal2/i.test(m)) return 'Finish two-factor sign-in first.';
    if (/expired|invalid.*(otp|token)/i.test(m)) return 'That code or link has expired. Request a new one.';
    return m.replace(/^error:\s*/i, '');
  }
  A.friendly = friendly;
  function linkError(code) {
    if (/otp_expired|expired/i.test(code)) return 'That link has expired or was already used. Request a new one.';
    if (/access_denied/i.test(code)) return 'That sign-in link didn’t work. Request a new one.';
    if (/email_not_confirmed/i.test(code)) return 'Confirm your email first: open the link we sent you, then sign in.';
    return 'That sign-in link didn’t work. Request a new one.';
  }
  async function rpc(fn, args) { const { data, error } = await sb.rpc(fn, args || {}); if (error) throw new Error(friendly(error)); return data; }
  A.rpc = rpc;
  // For our own Edge Functions: the signed-in person's session, so per-person limits apply (QA R1-08). Never sent
  // anywhere else; the demo stays anonymous.
  A.bearer = () => (VF.mode === 'account' && A.session && A.session.access_token ? 'Bearer ' + A.session.access_token : null);
  const missingFn = (e) => /PGRST202|could not find the function|schema cache/i.test(String((e && (e.code + ' ' + e.message)) || e || ''));
  // QA R1-17: an authenticator counts only once it is confirmed by email (or added from a session that already used a
  // confirmed one). Servers without migration 20261117_mfa_trust.sql don't have the function: nothing to do there.
  async function trustFactor(factorId) {
    const { data, error } = await sb.rpc('trust_my_factor', { p_factor: factorId || null });
    if (error) { if (missingFn(error)) return null; throw new Error(friendly(error)); }
    return data;
  }
  // QA R2-07: in a team workspace, security-relevant events also go to the server's audit log (public.audit_log), which
  // members can read but nobody can rewrite. The in-app trail stays as it was (it is part of the shared snapshot).
  const SERVER_EVENTS = new Set(['reveal-pii', 'data-export', 'erasure', 'consent-change', 'retention-change', 'station-status', 'export', 'reveal-secret', 'rotate-secret', 'webhook-create', 'connect-grant', 'connect-revoke', 'app-status', 'pricing-change', 'remote-command', 'booking-cancel', 'access-denied']);
  const audit0 = VF.audit;
  VF.audit = function (actor, action, target, reason, t) {
    audit0(actor, action, target, reason, t);
    if (VF.mode !== 'account' || !A.account || !A.account.org || !SERVER_EVENTS.has(action)) return;
    const clip = (x) => (x == null ? null : String(x).slice(0, 300));
    Promise.resolve(sb.rpc('record_event', { p_action: action, p_target: clip(target), p_reason: clip(reason) }))
      .then((r) => { if (r && r.error && !/PGRST202|could not find the function|schema cache/i.test((r.error.code || '') + ' ' + (r.error.message || ''))) console.warn('VoltFleet audit:', r.error.message); })
      .catch(() => { /* offline: the in-app trail still has it */ });
  };
  // ---------------------------------------------------------------- optional CAPTCHA (QA R1-08 remainder), off by default
  // Only with a site key in js/config.js (VOLTFLEET_CAPTCHA) and the provider allowed in the CSP. The token goes to
  // Supabase Auth with each request it checks (sign-up, password sign-in, emailed links and codes, password reset);
  // the provider's secret key lives in Supabase's settings only. Each token is used once, so the widget resets.
  const capCfg = Object.assign({ provider: '', siteKey: '' }, window.VOLTFLEET_CAPTCHA || {});
  const CAP = { turnstile: { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', g: 'turnstile' }, hcaptcha: { src: 'https://js.hcaptcha.com/1/api.js?render=explicit&recaptchacompat=off', g: 'hcaptcha' } }[capCfg.provider];
  A.captchaOn = !!(CAP && /^[\w-]{10,100}$/.test(String(capCfg.siteKey || '')));
  let capLoading = null, capWidget = null, capEl = null;
  const capApi = () => (CAP ? window[CAP.g] : null);
  function loadCaptcha() {
    if (capLoading) return capLoading;
    capLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = CAP.src; s.async = true;
      s.onload = () => (capApi() ? resolve(capApi()) : reject(new Error('captcha'))); s.onerror = () => { capLoading = null; reject(new Error('captcha')); };
      document.head.appendChild(s);
    });
    return capLoading;
  }
  const captchaSlot = () => (A.captchaOn ? '<div class="captcha-slot" id="auth-captcha"></div>' : '');
  A.mountCaptcha = async function () {
    if (!A.captchaOn) return;
    const el = document.getElementById('auth-captcha'); if (!el || el === capEl) return;
    try {
      const api = await loadCaptcha(); if (!el.isConnected) return;
      if (capWidget != null) { try { api.remove(capWidget); } catch (e) { /* already gone with its element */ } }
      capEl = el; capWidget = api.render(el, { sitekey: capCfg.siteKey, theme: VF.theme.get() === 'dark' ? 'dark' : 'light' });
    } catch (e) { capEl = null; /* the submit says what to do */ }
  };
  // undefined: CAPTCHA is off. null: it's on and not solved (or couldn't load).
  const captchaToken = () => { if (!A.captchaOn) return undefined; const api = capApi(); let t = ''; try { t = api && capWidget != null ? api.getResponse(capWidget) : ''; } catch (e) { /* none */ } return t || null; };
  const captchaReset = () => { const api = capApi(); try { if (api && capWidget != null) api.reset(capWidget); } catch (e) { /* none */ } };
  const withCaptcha = (o, t) => (t ? Object.assign({}, o, { captchaToken: t }) : o);
  const cacheAccount = (a) => { try { if (a) localStorage.setItem(ACCT_CACHE, JSON.stringify(a)); else localStorage.removeItem(ACCT_CACHE); } catch (e) { /* not kept */ } };

  // ---------------------------------------------------------------- session
  A.init = async function () {
    // Is phone sign-in available? (public settings endpoint; cheap, never blocks sign-in)
    fetch(cfg.url.replace(/\/$/, '') + '/auth/v1/settings', { headers: { apikey: cfg.key } }).then((r) => r.json()).then((j) => { A.phone = !!(j && j.external && j.external.phone); if (VF.ui.login && document.querySelector('.auth')) VF.renderSignin(); }).catch(() => {});
    const q = new URLSearchParams(location.search);
    // Never show text from the URL (QA R1-15: anyone could put a message on the sign-in page). Known codes get a
    // fixed message; anything else a generic one.
    const urlError = q.get('error_description') || q.get('error') || q.get('error_code') ? linkError(q.get('error_code') || q.get('error') || '') : '';
    const { data } = await sb.auth.getSession(); // also completes a ?code= sign-in link (PKCE)
    if (q.has('code') || urlError) { history.replaceState(null, '', location.pathname + location.hash); }
    if (q.has('error') || q.has('error_code') || q.has('error_description')) history.replaceState(null, '', location.pathname + location.hash);
    if (urlError) VF.ui.login.error = urlError;
    A.session = data && data.session;
    if (!A.session) { cacheAccount(null); return null; }
    try { A.account = await rpc('complete_signup'); cacheAccount(A.account); }
    catch (e) {
      let cached = null; try { cached = JSON.parse(localStorage.getItem(ACCT_CACHE) || 'null'); } catch (x) { /* none */ }
      A.account = cached && cached.id === A.session.user.id ? cached : null; // offline: keep working from this device
    }
    return A.account;
  };
  sb.auth.onAuthStateChange((event, session) => {
    A.session = session;
    if (event === 'PASSWORD_RECOVERY') { VF.ui.login.mode = 'recover'; if (VF.session) VF.session = null; VF.renderSignin(); }
  });

  // ---------------------------------------------------------------- two-factor sign-in (TOTP)
  const STAFF = ['manager', 'operator', 'developer', 'admin'];
  A.isStaff = (acct) => !!acct && STAFF.includes(acct.role);
  // What the person must do next: confirm email, set up their organisation, use or set up two-factor, or go in.
  A.next = async function (acct) {
    if (!acct) return 'signin';
    if (acct.status === 'unconfirmed') return 'check';
    // An organisation invited this email: the person decides (QA R1-04). Never joined on their behalf.
    if (acct.status === 'invited' && !acct.org) { L().invites = acct.pending_invites || []; return 'invite'; }
    if (acct.status === 'needs_onboarding' || !acct.org) return 'onboard';
    let lvl = null; try { const r = await sb.auth.mfa.getAuthenticatorAssuranceLevel(); lvl = r && r.data; } catch (e) { /* older session */ }
    if (lvl && lvl.nextLevel === 'aal2' && lvl.currentLevel !== 'aal2') return 'mfa';       // has an authenticator: use it
    // QA R1-17 (servers with 20261117_mfa_trust.sql report mfa_trust): a password alone can't add an authenticator.
    const trust = A.isStaff(acct) && acct.mfa_trust && typeof acct.mfa_trust === 'object' ? acct.mfa_trust : null;
    if (trust && trust.untrusted > 0 && lvl && lvl.currentLevel === 'aal2') {
      if (trust.email_proof) { try { const a2 = await trustFactor(null); if (a2) { Object.assign(acct, a2); A.account = acct; cacheAccount(acct); } if (!acct.mfa_required) return 'enter'; } catch (e) { /* ask for the email step */ } }
      L().mfaEmail = { confirm: true }; return 'mfa-email';
    }
    if (acct.mfa_required || (A.isStaff(acct) && lvl && lvl.currentLevel !== 'aal2')) {   // staff without one: set it up
      if (trust && !trust.email_proof) { L().mfaEmail = { confirm: false }; return 'mfa-email'; } // only from an emailed link
      return 'mfa-enroll';
    }
    return 'enter';
  };
  async function verifiedFactors() { const { data, error } = await sb.auth.mfa.listFactors(); if (error) throw error; return ((data && data.totp) || []).filter((f) => f.status === 'verified'); }
  A.verifiedFactors = verifiedFactors;
  async function newFactor() {
    const { data: all } = await sb.auth.mfa.listFactors();
    for (const f of ((all && all.all) || []).filter((x) => x.status === 'unverified')) { try { await sb.auth.mfa.unenroll({ factorId: f.id }); } catch (e) { /* stale */ } }
    const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', issuer: 'VoltFleet', friendlyName: 'Authenticator ' + new Date().toISOString().slice(0, 10) + ' ' + Math.random().toString(36).slice(2, 6) });
    if (error) throw error;
    const qr = String(data.totp.qr_code || '');
    return { id: data.id, qr: /^data:/.test(qr) ? qr : 'data:image/svg+xml;utf-8,' + encodeURIComponent(qr), secret: data.totp.secret };
  }
  A.startEnroll = async function () { try { VF.ui.login.enroll = await newFactor(); VF.ui.login.error = ''; } catch (e) { VF.ui.login.enroll = null; VF.ui.login.error = friendly(e); } };
  const enrollBox = (en, formId) => `<div class="mfa-enroll"><img class="mfa-qr" src="${esc(en.qr)}" alt="QR code to add VoltFleet to your authenticator app" width="180" height="180">
      <div><ol class="small"><li>Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy).</li><li>Scan this code, or type the key below.</li><li>Enter the 6-digit code it shows.</li></ol>
      <div class="mfa-secret"><code class="mono">${esc(String(en.secret || '').replace(/(.{4})/g, '$1 ').trim())}</code><button type="button" class="icon-btn" data-act="auth-copy-secret" data-secret="${esc(en.secret || '')}" aria-label="Copy key" data-tip="Copy key">${icon('copy')}</button></div></div></div>
      <${formId === 'auth-mfa-enroll' ? 'form' : 'div'} id="${formId}" class="auth-form" novalidate>${field('6-digit code', '<input class="input lg mono" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" required>')}<div class="form-error" id="${formId === 'auth-mfa-enroll' ? 'auth-error' : 'acct-mfa-error'}" hidden>${icon('warn')}<span></span></div>${formId === 'auth-mfa-enroll' ? btn('Turn on and continue') : `<button type="button" class="btn primary" data-act="acct-mfa-verify">Verify and add</button>`}</${formId === 'auth-mfa-enroll' ? 'form' : 'div'}>`;
  A.enrollBox = enrollBox;

  // Move into the organisation's private workspace and map the account to a person in it.
  A.enter = async function (acct) {
    VF.mode = 'account'; A.account = acct;
    VF.setStoreKey(ORG_PREFIX + acct.org.id);
    if (!VF.load()) { VF.reset(); VF.state.rev = 0; }
    VF.ensureConnect(); VF.ensureFleet();
    const userId = personalise(VF.state, acct);
    VF.session = { userId, account: true };
    VF.saveLocal();
    // Whenever the team's saved workspace arrives, map this account to its own person in it again.
    // Returns true when that changed the workspace, so the change is shared with the team.
    A.leaving = false;
    if (VF.cloud && VF.cloud.start) VF.cloud.start({ org: acct.org.id, onAdopt: () => {
      if (A.leaving) return false; // leaving or deleting the account (QA R4-04)
      const mine = () => JSON.stringify([VF.state.members && VF.state.members[A.account.id], VF.session && VF.user(VF.session.userId)]);
      const before = JSON.stringify([VF.state.members && VF.state.members[A.account.id], (VF.state.members && VF.state.members[A.account.id] && VF.user(VF.state.members[A.account.id])) || null]);
      VF.session = { userId: personalise(VF.state, A.account), account: true };
      return mine() !== before;
    }, onGone: async () => {
      // Removed from the team (or the organisation was deleted): don't keep showing, or holding, its data.
      let acct = null; try { acct = await rpc('my_account'); } catch (e) { return; } // offline: try again later
      if (acct && acct.org && acct.org.id === A.account.org.id) return;
      VF.toast('You no longer have access to this workspace.'); setTimeout(() => A.signOut(false), 1200);
    } });
  };
  function personalise(s, acct) {
    s.members = s.members || {};
    let u = s.members[acct.id] && VF.user(s.members[acct.id]);
    if (!u) {
      const taken = new Set(Object.values(s.members));
      const base = { manager: 'u-fm1', operator: 'u-op1', admin: 'u-admin', developer: 'u-dev1' }[acct.role];
      if (acct.role === 'driver') u = s.users.find((x) => x.role === 'driver' && x.demo && !taken.has(x.id));
      else if (base && VF.user(base) && !taken.has(base)) u = VF.user(base);
      else if (base && VF.user(base)) { u = Object.assign({}, VF.user(base), { id: 'u-' + acct.id.replace(/-/g, '').slice(0, 10) }); s.users.push(u); }
      if (!u) throw new Error('This workspace has no place for a ' + acct.role);
      s.members[acct.id] = u.id;
    }
    Object.assign(u, { name: acct.full_name || (acct.email || '').split('@')[0] || 'You', email: acct.email || '', phone: acct.phone ? '+' + String(acct.phone).replace(/^\+/, '') : '', role: acct.role, demo: false, account: true, deleted: false });
    const org = acct.org && acct.org.name;
    if (org) {
      if (acct.role === 'manager' && s.fleet) s.fleet.org.name = org;
      if (acct.role === 'operator' && u.operatorId) { const op = (s.operators || []).find((o) => o.id === u.operatorId); if (op) op.name = org; }
      if (acct.role === 'developer' && s.connect) { const o = s.connect.orgs.find((x) => x.id === u.orgId); if (o) o.name = org; }
    }
    return u.id;
  }

  // QA R4-04: the team workspace (a shared snapshot) holds a copy of each member's name, email and phone, written by
  // personalise(). When someone deletes their account, leaves, or is removed, that copy is taken out of the workspace:
  // erasure removes the name too; leaving or removal keeps the name (who did what stays readable for the team) but drops
  // the contact details. Best effort, waits at most 5 s for the write; must run while the writer is still a member.
  async function scrubMember(accountId, erase) {
    const s = VF.state; if (VF.mode !== 'account' || !s || !s.members || !accountId) return;
    if (A.account && accountId === A.account.id) A.leaving = true; // a newer workspace arriving meanwhile doesn't put the details back
    const uid = s.members[accountId]; const u = uid && VF.user(uid);
    if (u) Object.assign(u, { email: '', phone: '', account: false }, erase ? { name: 'Former member' } : {});
    delete s.members[accountId];
    VF.save();
    if (VF.cloud && VF.cloud.flush) await Promise.race([VF.cloud.flush(), new Promise((r) => setTimeout(r, 5000))]);
  }
  A.scrubMember = scrubMember;
  // The server refused (offline, second factor needed...): the person is still a member, so their details go back.
  function stay() { if (!A.leaving || !A.account) return; A.leaving = false; try { VF.session = { userId: personalise(VF.state, A.account), account: true }; VF.save(); } catch (e) { /* next adopt maps it */ } }
  A.signOut = async function (everywhere) {
    // QA R4-01: cars connected in this account are disconnected and their readings (location included) removed from
    // this browser first, while the account is still the one they belong to.
    try { if (VF.real && VF.real.signOut) await VF.real.signOut(); } catch (e) { /* removed locally anyway */ }
    try { if (VF.ocppNet && VF.ocppNet.wipeAccounts) VF.ocppNet.wipeAccounts(); } catch (e) { /* removed on reload anyway */ }
    try { await sb.auth.signOut({ scope: everywhere ? 'global' : 'local' }); } catch (e) { /* signed out locally anyway */ }
    // Shared devices: remove this account's workspace copy from the browser.
    try { for (const k of Object.keys(localStorage)) if (k.startsWith(ORG_PREFIX)) localStorage.removeItem(k); } catch (e) { /* none */ }
    cacheAccount(null); try { for (const k of ['voltfleet-os:session', 'voltfleet-os:ocpp-pw', 'voltfleet-os:smartcar-state']) sessionStorage.removeItem(k); } catch (e) { /* none */ }
    location.replace(location.pathname + '#signin'); location.reload();
  };

  // ---------------------------------------------------------------- sign-in screens (rendered inside the sign-in card)
  const field = (label, input, hint) => `<label class="field"><span>${label}</span>${input}${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
  const err = (ui) => `<div class="form-error" id="auth-error" ${ui.error ? '' : 'hidden'}>${icon('warn')}<span>${esc(ui.error || '')}</span></div>`;
  const ok = (ui) => (ui.ok ? `<div class="banner-note ok">${icon('circle-check')}<div>${esc(ui.ok)}</div></div>` : '');
  const btn = (label) => `<button class="btn primary big" type="submit" data-label="${esc(label)}" ${A.busy ? 'disabled' : ''}>${A.busy ? 'Please wait…' : label}</button>`;
  A.panel = function (ui, demoHTML) {
    const m = ui.mode || 'signin';
    const tabs = `<div class="auth-tabs" role="tablist">${[['signin', 'Sign in'], ['signup', 'Create account'], ['demo', 'Try the demo']].map(([k, l]) => `<button type="button" role="tab" aria-selected="${m === k || (k === 'signin' && ['reset', 'phone', 'magic'].includes(m))}" data-act="auth-mode" data-k="${k}">${l}</button>`).join('')}</div>`;
    const head = (t, s) => `<div class="auth-head"><div class="row between"><h2>${t}</h2><span data-install-slot="signin">${VF.install ? VF.install.slot('signin') : ''}</span></div><p class="muted">${s}</p></div>`;
    let body = '';
    if (m === 'demo') return head('Try the demo', 'Explore with sample data. No account needed.') + tabs + demoHTML;
    if (m === 'signin') body = head('Sign in', 'Welcome back to VoltFleet.') + tabs + `<form id="auth-signin" class="auth-form" novalidate>
        ${field('Email', `<input class="input lg" name="email" type="email" autocomplete="username" required value="${esc(ui.email || '')}">`)}
        ${field('<span class="row between"><span>Password</span><button type="button" class="link-btn small" data-act="auth-mode" data-k="reset">Forgot password?</button></span>', '<input class="input lg" name="password" type="password" autocomplete="current-password" required>')}
        ${captchaSlot()}${err(ui)}${ok(ui)}${btn('Sign in')}</form>
        <div class="auth-alt"><button type="button" class="btn" data-act="auth-mode" data-k="magic">${icon('mail')}Email me a sign-in link</button>${A.phone ? `<button type="button" class="btn" data-act="auth-mode" data-k="phone">${icon('smartphone')}Use my phone number</button>` : ''}</div>`;
    else if (m === 'magic') body = head('Sign in with a link', 'We’ll email you a one-time link. No password needed.') + tabs + `<form id="auth-magic" class="auth-form" novalidate>${field('Email', `<input class="input lg" name="email" type="email" autocomplete="username" required value="${esc(ui.email || '')}">`)}${captchaSlot()}${err(ui)}${ok(ui)}${btn('Send sign-in link')}</form><button type="button" class="link-btn" data-act="auth-mode" data-k="signin">${icon('arrow-left')}Back to password sign-in</button>`;
    else if (m === 'phone') body = head('Sign in with your phone', ui.phoneSent ? `Enter the 6-digit code we sent to ${esc(ui.phone || '')}.` : 'We’ll text you a 6-digit code.') + tabs + `<form id="auth-phone" class="auth-form" novalidate>${ui.phoneSent ? field('Code', '<input class="input lg mono" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>') : field('Phone number', `<input class="input lg" name="phone" type="tel" autocomplete="tel" placeholder="+233 24 123 4567" required value="${esc(ui.phone || '')}">`, 'Include the country code, e.g. +233.')}${ui.phoneSent ? '' : captchaSlot()}${err(ui)}${ok(ui)}${btn(ui.phoneSent ? 'Verify and sign in' : 'Send code')}</form><button type="button" class="link-btn" data-act="auth-mode" data-k="signin">${icon('arrow-left')}Back</button>`;
    else if (m === 'reset') body = head('Reset your password', 'We’ll email you a link to choose a new one.') + tabs + `<form id="auth-reset" class="auth-form" novalidate>${field('Email', `<input class="input lg" name="email" type="email" autocomplete="username" required value="${esc(ui.email || '')}">`)}${captchaSlot()}${err(ui)}${ok(ui)}${btn('Send reset link')}</form><button type="button" class="link-btn" data-act="auth-mode" data-k="signin">${icon('arrow-left')}Back to sign in</button>`;
    else if (m === 'mfa') body = head('Two-factor sign-in', 'Enter the 6-digit code from your authenticator app.') + `<form id="auth-mfa" class="auth-form" novalidate>${field('Code', '<input class="input lg mono" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" required autofocus>')}${err(ui)}${btn('Verify')}</form>
        <details class="small muted"><summary>Lost your phone or authenticator?</summary><p>Ask your VoltFleet administrator to reset two-factor sign-in for your account after they’ve confirmed who you are. If you added a backup device, use that instead.</p></details>
        <button type="button" class="link-btn" data-act="auth-signout">${icon('log-out')}Sign out</button>`;
    else if (m === 'mfa-email') {
      const me = ui.mfaEmail || {};
      body = head(me.confirm ? 'Confirm your authenticator' : 'Confirm it’s you', me.confirm
        ? 'This authenticator hasn’t been confirmed by email yet, so it can’t open your team’s workspace. We’ll email you a one-time sign-in link; open it on this device, then enter a code from your authenticator again.'
        : 'Before you add an authenticator, we email you a one-time sign-in link. That way, someone who only knows your password can’t add their own phone to your account.') +
        `<form id="auth-mfa-email" class="auth-form" novalidate><p class="small muted">${icon('mail')} The link goes to <strong>${esc((A.account && A.account.email) || ui.email || 'your email address')}</strong>. Open it in this browser.</p>${captchaSlot()}${err(ui)}${ok(ui)}${btn(me.sent ? 'Send the link again' : 'Email me the link')}</form>
        <details class="small muted"><summary>Didn’t add an authenticator yourself?</summary><p>Someone may know your password. Change it now (Forgot password? on the sign-in page), and ask your VoltFleet administrator to remove authenticators you don’t recognise.</p></details>
        <button type="button" class="link-btn" data-act="auth-signout">${icon('log-out')}Sign out</button>`;
    } else if (m === 'mfa-enroll') body = head('Protect your account', `${ui.staffNote === false ? 'Turn on two-factor sign-in.' : 'Staff accounts need two-factor sign-in: a password plus a code from an app on your phone.'}`) + (ui.enroll ? enrollBox(ui.enroll, 'auth-mfa-enroll') : `${err(ui)}<button type="button" class="btn" data-act="auth-enroll-retry">${icon('refresh-cw')}Try again</button>`) + `<button type="button" class="link-btn" data-act="auth-signout">${icon('log-out')}Sign out</button>`;
    else if (m === 'invite') {
      const inv = ui.invites || [];
      body = head('You’ve been invited', 'Joining shares your name and email with that organisation, and everything you add in its workspace is visible to its team. Only accept an invitation you expected.') +
        `<ul class="plain-list invite-list">${inv.map((i) => `<li><div><strong>${esc(i.org_name || 'An organisation')}</strong><div class="small muted">${esc(ROLE_LABEL[i.role] || i.role)} · invited ${esc(new Date(i.invited_at).toLocaleDateString())} · expires ${esc(new Date(i.expires_at).toLocaleDateString())}</div></div>
          <div class="row gap"><button type="button" class="btn primary small" data-act="auth-invite-accept" data-id="${esc(i.id)}" ${A.busy ? 'disabled' : ''}>Join</button><button type="button" class="btn small ghost" data-act="auth-invite-decline" data-id="${esc(i.id)}" ${A.busy ? 'disabled' : ''}>No thanks</button></div></li>`).join('')}</ul>
        ${err(ui)}<p class="small muted">If you decline, we set up the account you chose when you signed up.</p><button type="button" class="link-btn" data-act="auth-signout">${icon('log-out')}Sign out</button>`;
    } else if (m === 'recover') body = head('Choose a new password', 'At least 10 characters.') + `<form id="auth-recover" class="auth-form" novalidate>${field('New password', '<input class="input lg" name="password" type="password" autocomplete="new-password" minlength="10" required>')}${err(ui)}${btn('Save and continue')}</form>`;
    else if (m === 'signup' || m === 'onboard') {
      const type = ui.type || 'fleet'; const onboard = m === 'onboard';
      body = head(onboard ? 'Set up your account' : 'Create your account', onboard ? 'One last step: tell us how you use VoltFleet.' : 'Free while in beta. Your organisation’s data is private to your team.') + (onboard ? '' : tabs) + `<form id="${onboard ? 'auth-onboard' : 'auth-signup'}" class="auth-form" novalidate>
        <div class="type-grid" role="radiogroup" aria-label="Account type">${TYPES.map(([k, l, ic, d]) => `<button type="button" role="radio" aria-checked="${type === k}" class="type-opt" data-act="auth-type" data-k="${k}">${icon(ic)}<strong>${l}</strong><span class="small muted">${d}</span></button>`).join('')}</div>
        ${onboard ? '' : field('Full name', `<input class="input lg" name="fullname" autocomplete="name" maxlength="80" required value="${esc(ui.fullname || '')}">`)}
        ${type === 'driver' ? '' : field(type === 'fleet' ? 'Company name' : type === 'operator' ? 'Charging network name' : 'Company name', `<input class="input lg" name="org" autocomplete="organization" maxlength="80" required value="${esc(ui.org || '')}">`)}
        ${onboard ? '' : field('Work email', `<input class="input lg" name="email" type="email" autocomplete="email" required value="${esc(ui.email || '')}">`) + field('Password', '<input class="input lg" name="password" type="password" autocomplete="new-password" minlength="10" required>', 'At least 10 characters. Use a password manager if you can.')}
        ${onboard ? '' : `<label class="check small"><input type="checkbox" name="agree" required ${ui.agree ? 'checked' : ''}>I agree to the terms and the privacy notice, and confirm I’m allowed to add my organisation.</label>`}
        ${onboard ? '' : captchaSlot()}${err(ui)}${ok(ui)}${btn(onboard ? 'Create workspace' : 'Create account')}</form>
        ${onboard ? `<button type="button" class="link-btn" data-act="auth-signout">${icon('log-out')}Sign out</button>` : ''}`;
    } else if (m === 'check') body = head('Check your email', `We sent a confirmation link to <strong>${esc(ui.email || 'your inbox')}</strong>. Open it on this device to finish creating your account.`) + `${ok(ui)}${err(ui)}${captchaSlot()}<div class="auth-alt"><button type="button" class="btn" data-act="auth-resend">${icon('mail')}Send it again</button><button type="button" class="btn ghost" data-act="auth-mode" data-k="signin">I’ve confirmed: sign in</button></div><p class="small muted">Can’t find it? Check spam, or ask your administrator to allow emails from VoltFleet.</p>`;
    return body;
  };
  A.foot = (ui) => (ui.mode === 'demo'
    ? 'Demo data is simulated and shared with every visitor, so don’t enter real personal details.'
    : 'Your organisation’s workspace is private to your team. Passwords are handled by our identity provider and never stored by VoltFleet.');

  // ---------------------------------------------------------------- form handling
  const L = () => VF.ui.login;
  // Errors and the busy state update in place, so what the person typed (including the password) stays put.
  const patch = () => {
    const e = document.getElementById('auth-error'); const b = document.querySelector('.auth-form button[type=submit]');
    if (!e || !b) { VF.renderSignin(); return; }
    e.hidden = !L().error; e.lastElementChild.textContent = L().error || '';
    b.disabled = A.busy; b.textContent = A.busy ? 'Please wait…' : b.dataset.label;
    if (L().error) { const f = e.closest('form'); const first = f && f.querySelector('input:not([type=checkbox])'); if (first && !first.value) first.focus(); }
  };
  const setErr = (m) => { L().error = m; L().ok = ''; A.busy = false; patch(); };
  const setOk = (m) => { L().ok = m; L().error = ''; A.busy = false; VF.renderSignin(); };
  const busy = () => { A.busy = true; L().error = ''; L().ok = ''; patch(); };
  const emailOk = (e) => /^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,24}$/i.test(e);
  async function afterSignIn(given) {
    const acct = given && given.id ? given : await rpc('complete_signup'); A.account = acct; cacheAccount(acct); A.busy = false;
    const step = await A.next(acct);
    if (step === 'enter') { await A.enter(acct); L().error = ''; L().enroll = null; location.hash = ''; VF.routeChange(); return; }
    L().mode = step; if (acct.error) L().error = acct.error;
    if (step === 'mfa-enroll') await A.startEnroll();
    VF.renderSignin();
  }
  A.submit = async function (form) {
    const id = form.getAttribute('id'); const d = Object.fromEntries(new FormData(form).entries());
    const email = String(d.email || '').trim().toLowerCase(); if (email) L().email = email;
    try {
      if (id === 'auth-signin') {
        if (!emailOk(email) || !d.password) return setErr('Enter your email and password.');
        const ct = captchaToken(); if (ct === null) return setErr('Complete the security check first.');
        busy(); const { error } = await sb.auth.signInWithPassword({ email, password: d.password, options: withCaptcha({}, ct) }); captchaReset(); if (error) return setErr(friendly(error));
        return afterSignIn();
      }
      if (id === 'auth-magic') {
        if (!emailOk(email)) return setErr('Enter a valid email address.');
        const ct = captchaToken(); if (ct === null) return setErr('Complete the security check first.');
        busy(); const { error } = await sb.auth.signInWithOtp({ email, options: withCaptcha({ emailRedirectTo: redirect(), shouldCreateUser: false }, ct) }); captchaReset();
        return error ? setErr(friendly(error)) : setOk('If that email has an account, a sign-in link is on its way. Open it on this device.');
      }
      if (id === 'auth-mfa-email') {
        const to = String((A.account && A.account.email) || L().email || '').trim().toLowerCase();
        if (!emailOk(to)) return setErr('This account has no email address to confirm. Ask your administrator.');
        const ct = captchaToken(); if (ct === null) return setErr('Complete the security check first.');
        busy(); const { error } = await sb.auth.signInWithOtp({ email: to, options: withCaptcha({ emailRedirectTo: redirect(), shouldCreateUser: false }, ct) }); captchaReset();
        if (error) return setErr(friendly(error));
        L().mfaEmail = Object.assign({}, L().mfaEmail, { sent: true }); return setOk('Link sent. Open it in this browser to continue. It can take a minute to arrive.');
      }
      if (id === 'auth-reset') {
        if (!emailOk(email)) return setErr('Enter a valid email address.');
        const ct = captchaToken(); if (ct === null) return setErr('Complete the security check first.');
        busy(); const { error } = await sb.auth.resetPasswordForEmail(email, withCaptcha({ redirectTo: redirect() }, ct)); captchaReset();
        return error ? setErr(friendly(error)) : setOk('If that email has an account, a reset link is on its way.');
      }
      if (id === 'auth-mfa' || id === 'auth-mfa-enroll') {
        const code = String(d.code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(code)) return setErr('Enter the 6-digit code.');
        let factorId = id === 'auth-mfa-enroll' ? L().enroll && L().enroll.id : null;
        if (!factorId) { const fs = await verifiedFactors(); factorId = fs[0] && fs[0].id; }
        if (!factorId) return setErr('No authenticator found. Sign out and in again.');
        busy(); const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code }); if (error) return setErr(friendly(error));
        if (id === 'auth-mfa-enroll') { try { await trustFactor(factorId); } catch (e) { /* the next step asks for the email link */ } VF.toast('Two-factor sign-in is on'); }
        L().enroll = null; return afterSignIn();
      }
      if (id === 'auth-recover') {
        if (String(d.password || '').length < 10) return setErr('Use at least 10 characters.');
        busy(); const { error } = await sb.auth.updateUser({ password: d.password }); if (error) return setErr(friendly(error));
        L().mode = 'signin'; return afterSignIn();
      }
      if (id === 'auth-phone') {
        if (!L().phoneSent) {
          const phone = '+' + String(d.phone || '').replace(/[^\d]/g, ''); if (phone.length < 9) return setErr('Enter your phone number with the country code.');
          const ct = captchaToken(); if (ct === null) return setErr('Complete the security check first.');
          busy(); const { error } = await sb.auth.signInWithOtp(ct ? { phone, options: { captchaToken: ct } } : { phone }); captchaReset(); if (error) return setErr(friendly(error));
          L().phone = phone; L().phoneSent = true; return setOk('Code sent.');
        }
        if (!/^\d{6}$/.test(String(d.code || ''))) return setErr('Enter the 6-digit code.');
        busy(); const { error } = await sb.auth.verifyOtp({ phone: L().phone, token: d.code, type: 'sms' }); if (error) return setErr(friendly(error));
        L().phoneSent = false; return afterSignIn();
      }
      if (id === 'auth-signup' || id === 'auth-onboard') {
        const type = L().type || 'fleet'; const org = String(d.org || '').trim(); L().org = org;
        if (type !== 'driver' && org.length < 2) return setErr('Enter your organisation’s name.');
        if (id === 'auth-onboard') { busy(); const acct = await rpc('create_organization', { p_kind: type, p_name: org }); A.busy = false; return afterSignIn(acct); }
        const fullname = String(d.fullname || '').trim(); L().fullname = fullname; L().agree = !!d.agree;
        if (fullname.length < 2) return setErr('Enter your full name.');
        if (!emailOk(email)) return setErr('Enter a valid email address.');
        if (String(d.password || '').length < 10) return setErr('Use a password of at least 10 characters.');
        if (!d.agree) return setErr('Please accept the terms and privacy notice.');
        const ct = captchaToken(); if (ct === null) return setErr('Complete the security check first.');
        busy();
        const { data, error } = await sb.auth.signUp({ email, password: d.password, options: withCaptcha({ emailRedirectTo: redirect(), data: { full_name: fullname, account_type: type, org_name: org } }, ct) }); captchaReset();
        if (error) return setErr(friendly(error));
        if (data && data.session) return afterSignIn();
        A.busy = false; L().mode = 'check'; L().ok = ''; return VF.renderSignin();
      }
    } catch (e) { setErr(friendly(e)); }
  };
  document.addEventListener('submit', (e) => { const f = e.target; if (f && /^auth-/.test(f.getAttribute('id') || '')) { e.preventDefault(); if (!A.busy) A.submit(f); } });
  // The account panel is one form whose submit saves the name. Enter in another section runs that section's action
  // instead (QA R1-14: Enter in "New password" used to save the name and drop the password).
  const ENTER_ACT = { 'acct-new-pass': 'acct-password', 'acct-invite-email': 'acct-invite' };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target || !e.target.closest) return;
    const id = e.target.getAttribute('id'); let act = ENTER_ACT[id];
    if (!act && e.target.closest('#acct-mfa-form')) act = 'acct-mfa-verify';
    if (!act) return;
    e.preventDefault(); e.stopPropagation(); if (VF.ACT[act]) VF.ACT[act](e.target, e);
  }, true);

  Object.assign(VF.ACT, {
    'auth-mode': (el) => { Object.assign(L(), { mode: el.dataset.k, error: '', ok: '', phoneSent: false }); if (el.dataset.k === 'demo' && VF.startDemoSync) VF.startDemoSync(); VF.renderSignin(); },
    'auth-type': (el) => { const f = el.closest('form'); if (f) { const n = f.querySelector('[name="org"]'); if (n) L().org = n.value; const fn = f.querySelector('[name="fullname"]'); if (fn) L().fullname = fn.value; const em = f.querySelector('[name="email"]'); if (em) L().email = em.value; } L().type = el.dataset.k; VF.renderSignin(); },
    'auth-resend': async () => { const email = L().email; if (!email) return; const ct = captchaToken(); if (ct === null) return setErr('Complete the security check first.'); const { error } = await sb.auth.resend({ type: 'signup', email, options: withCaptcha({ emailRedirectTo: redirect() }, ct) }); captchaReset(); if (error) setErr(friendly(error)); else setOk('Sent again. It can take a minute to arrive.'); },
    'auth-signout': () => A.signOut(false),
    'auth-invite-accept': async (el) => { if (A.busy) return; A.busy = true; L().error = ''; VF.renderSignin(); try { await afterSignIn(await rpc('accept_invite', { p_id: el.dataset.id })); } catch (e) { A.busy = false; L().error = friendly(e); VF.renderSignin(); } },
    'auth-invite-decline': async (el) => { if (A.busy) return; A.busy = true; L().error = ''; VF.renderSignin(); try { await afterSignIn(await rpc('decline_invite', { p_id: el.dataset.id })); } catch (e) { A.busy = false; L().error = friendly(e); VF.renderSignin(); } },
    'acct-leave': async () => { if (!await VF.c.confirm({ title: 'Leave this organisation?', body: 'You lose access to its workspace straight away. Your login stays; you can join or create another organisation.', confirmLabel: 'Leave', danger: true })) return openAccount(); try { await scrubMember(A.account && A.account.id, false); await rpc('leave_organization'); VF.toast('You left the organisation'); setTimeout(() => A.signOut(false), 600); } catch (e) { stay(); VF.toast(e.message); } },
    'auth-enroll-retry': async () => { await A.startEnroll(); VF.renderSignin(); },
    'auth-copy-secret': (el) => VF.copyText(el.dataset.secret, 'Key'), // waits for the clipboard; falls back, never claims a copy that failed (QA R1-14)
    'acct-mfa-add': async () => { try { A.acctEnroll = await newFactor(); } catch (e) { A.acctEnroll = null; return acctErr(friendly(e)); } openAccount(); },
    'acct-mfa-verify': async () => {
      const i = document.querySelector('#acct-mfa-form [name="code"]'); const code = i ? i.value.replace(/\s/g, '') : '';
      if (!/^\d{6}$/.test(code) || !A.acctEnroll) { const e = document.getElementById('acct-mfa-error'); if (e) { e.hidden = false; e.lastElementChild.textContent = 'Enter the 6-digit code.'; } return; }
      const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: A.acctEnroll.id, code });
      if (error) { const e = document.getElementById('acct-mfa-error'); if (e) { e.hidden = false; e.lastElementChild.textContent = friendly(error); } return; }
      const added = A.acctEnroll.id; A.acctEnroll = null;
      try { await trustFactor(added); VF.toast('Authenticator added'); } catch (e) { VF.toast(e.message); }
      openAccount();
    },
    'acct-mfa-cancel': async () => { if (A.acctEnroll) { try { await sb.auth.mfa.unenroll({ factorId: A.acctEnroll.id }); } catch (e) { /* unverified */ } } A.acctEnroll = null; openAccount(); },
    'acct-mfa-remove': async (el) => {
      if (!await VF.c.confirm({ title: 'Remove this authenticator?', body: A.isStaff(A.account) ? 'You still need another authenticator: staff accounts can’t sign in without one.' : 'Signing in will need only your password.', confirmLabel: 'Remove', danger: true })) return openAccount();
      const { error } = await sb.auth.mfa.unenroll({ factorId: el.dataset.id }); if (error) VF.toast(friendly(error)); else VF.toast('Authenticator removed'); openAccount();
    },
    'auth-acct': () => openAccount(),
    'acct-invite': async () => { const i = document.getElementById('acct-invite-email'); const v = i ? i.value.trim() : ''; try { A.account = await rpc('invite_member', { p_email: v }); VF.toast('Invitation saved'); openAccount(); } catch (e) { acctErr(e.message); } },
    'acct-revoke': async (el) => { try { A.account = await rpc('revoke_invite', { p_id: el.dataset.id }); openAccount(); } catch (e) { acctErr(e.message); } },
    'acct-remove': async (el) => { if (!await VF.c.confirm({ title: 'Remove this person from your organisation?', body: 'They keep their login but lose access to your workspace straight away.', confirmLabel: 'Remove', danger: true })) return openAccount(); try { A.account = await rpc('remove_member', { p_user: el.dataset.id }); await scrubMember(el.dataset.id, false); openAccount(); } catch (e) { VF.toast(e.message); } },
    'acct-password': async () => { const i = document.getElementById('acct-new-pass'); const v = i ? i.value : ''; if (v.length < 10) return acctErr('Use at least 10 characters.'); const { error } = await sb.auth.updateUser({ password: v }); if (error) return acctErr(friendly(error)); VF.toast('Password changed'); openAccount(); },
    'acct-signout-all': async () => { if (!await VF.c.confirm({ title: 'Sign out everywhere?', body: 'Every device signed in to your account is signed out, including this one.', confirmLabel: 'Sign out everywhere' })) return; A.signOut(true); },
    'acct-delete': async () => {
      if (!await VF.c.confirm({ title: 'Delete your account?', body: 'Your login and profile are erased now. If nobody else is in your organisation, its workspace is deleted too. This can’t be undone.', confirmLabel: 'Delete my account', danger: true })) return;
      try { await scrubMember(A.account && A.account.id, true); await rpc('delete_my_account'); VF.toast('Account deleted'); setTimeout(() => A.signOut(false), 600); } catch (e) { stay(); VF.toast(e.message); }
    },
  });

  // ---------------------------------------------------------------- account & team panel
  const acctErr = (m) => { const el = document.getElementById('acct-error'); if (el) { el.hidden = false; el.lastElementChild.textContent = m; } };
  async function openAccount() {
    try { A.account = Object.assign({}, A.account, await rpc('my_account')); cacheAccount(A.account); } catch (e) { /* show cached */ }
    const a = A.account || {}; const admin = ['manager', 'operator', 'developer'].includes(a.role);
    // Only the owner removes people, and nobody removes the owner (QA R1-06). Older servers don't report an owner.
    const canRemove = a.owner === undefined ? admin : a.owner === true;
    let audit = [];
    if (admin) { const { data } = await sb.from('audit_log').select('action,detail,at').order('at', { ascending: false }).limit(8); audit = data || []; }
    let platform = null; if (a.role === 'admin') { try { platform = await rpc('admin_overview'); } catch (e) { /* not admin */ } }
    let factors = []; try { factors = await verifiedFactors(); } catch (e) { /* MFA unavailable */ }
    const staff = A.isStaff(a);
    const mfaHTML = `<section class="acct-mfa"><h4>Two-factor sign-in</h4>
      ${factors.length ? `<p class="small">${icon('shield-check')} On${staff ? ' · required for staff accounts' : ''}.</p><ul class="plain-list">${factors.map((f) => `<li><div><strong>${esc(f.friendly_name || 'Authenticator app')}</strong><div class="small muted">Added ${esc(new Date(f.created_at).toLocaleDateString())}</div></div><button type="button" class="btn small ghost" data-act="acct-mfa-remove" data-id="${esc(f.id)}" ${staff && factors.length < 2 ? 'disabled title="Add another authenticator before removing this one"' : ''}>Remove</button></li>`).join('')}</ul>`
        : `<p class="small muted">${staff ? 'Required for staff accounts.' : 'Off. Add a code from an app on your phone so a stolen password isn’t enough to get in.'}</p>`}
      ${A.acctEnroll ? `<div id="acct-mfa-form">${enrollBox(A.acctEnroll, 'acct-mfa-form-inner')}<button type="button" class="link-btn" data-act="acct-mfa-cancel">Cancel</button></div>` : `<button type="button" class="btn small" data-act="acct-mfa-add">${icon('key-round')}${factors.length ? 'Add a backup device' : 'Turn on two-factor sign-in'}</button>`}
    </section>`;
    VF.c.modal({ title: 'Account & team', sub: `${ROLE_LABEL[a.role] || a.role} · ${a.org ? a.org.name : 'No organisation'}`, submitLabel: 'Save name', body: `
      <div class="acct-grid">
        <section><h4>Profile</h4>${field('Full name', `<input class="input" name="fullname" maxlength="80" value="${esc(a.full_name || '')}">`)}<p class="small muted">${icon('mail')} ${esc(a.email || a.phone || '')}</p></section>
        <section><h4>Security</h4>${field('New password', '<input class="input" id="acct-new-pass" type="password" autocomplete="new-password" minlength="10">')}<div class="row gap"><button type="button" class="btn small" data-act="acct-password">Change password</button><button type="button" class="btn small ghost" data-act="acct-signout-all">Sign out everywhere</button></div></section>
      </div>
      ${mfaHTML}
      ${a.org ? `<section class="acct-team"><h4>Team · ${esc(a.org.name)}</h4><ul class="plain-list">${(a.members || []).map((m) => `<li><div><strong>${esc(m.full_name || 'Unnamed')}</strong>${m.you ? ' <span class="badge teal">You</span>' : ''}<div class="small muted">${esc(ROLE_LABEL[m.role] || m.role)}${m.owner ? ' · Owner' : ''}</div></div>${canRemove && !m.you && !m.owner ? `<button type="button" class="btn small ghost" data-act="acct-remove" data-id="${esc(m.id)}">Remove</button>` : ''}</li>`).join('')}</ul>
        ${admin ? `<div class="row gap acct-invite"><input class="input" id="acct-invite-email" type="email" placeholder="colleague@company.com" aria-label="Email to invite"><button type="button" class="btn" data-act="acct-invite">${icon('user-plus')}Invite</button></div><p class="small muted">When they sign in with this email they’re asked to accept. Invitations expire after 7 days.</p>
        ${(a.invites || []).length ? `<ul class="plain-list">${a.invites.map((i) => `<li><div><strong>${esc(i.email)}</strong><div class="small muted">${i.declined ? 'Declined' : i.expired ? 'Expired' : 'Invited'} · ${esc(ROLE_LABEL[i.role] || i.role)}${i.expires_at && !i.expired && !i.declined ? ' · until ' + esc(new Date(i.expires_at).toLocaleDateString()) : ''}</div></div><button type="button" class="btn small ghost" data-act="acct-revoke" data-id="${esc(i.id)}">${i.declined || i.expired ? 'Remove' : 'Revoke'}</button></li>`).join('')}</ul>` : ''}` : ''}
        ${a.owner === false ? `<button type="button" class="btn small ghost" data-act="acct-leave">${icon('log-out')}Leave organisation</button>` : ''}</section>` : ''}
      ${audit.length ? `<section><h4>Recent activity</h4><ul class="plain-list small">${audit.map((x) => `<li><span>${esc(x.action)}${x.detail && x.detail.email ? ' · ' + esc(x.detail.email) : ''}</span><span class="faint">${esc(new Date(x.at).toLocaleString())}</span></li>`).join('')}</ul></section>` : ''}
      ${platform ? `<section><h4>Platform</h4><p class="small">${esc(platform.accounts)} accounts · ${esc(platform.pending)} unfinished sign-ups · ${esc(platform.signups_7d)} new this week · ${platform.staff_with_2fa != null ? esc(platform.staff_with_2fa) + ' staff with two-factor · ' : ''} ${Object.entries(platform.organisations || {}).map(([k, n]) => `${n} ${esc(k)}`).join(', ')}</p></section>` : ''}
      <section class="acct-danger"><h4>Delete account</h4><p class="small muted">Erases your login and profile (your right to erasure). Workspaces with other members stay.</p><button type="button" class="btn small danger" data-act="acct-delete">${icon('trash-2')}Delete my account</button></section>
      <div class="form-error" id="acct-error" hidden>${icon('warn')}<span></span></div>`,
      onSubmit(d) { rpc('update_my_name', { p_name: d.fullname }).then((acct) => { A.account = Object.assign(A.account, acct); cacheAccount(A.account); personalise(VF.state, A.account); VF.save(); VF.toast('Name saved'); VF.rerender(); }).catch((e) => VF.toast(e.message)); return null; } });
  }
  A.openAccount = openAccount;
})();
