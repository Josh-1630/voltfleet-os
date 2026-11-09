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
  async function rpc(fn, args) { const { data, error } = await sb.rpc(fn, args || {}); if (error) throw new Error(friendly(error)); return data; }
  A.rpc = rpc;
  const cacheAccount = (a) => { try { if (a) localStorage.setItem(ACCT_CACHE, JSON.stringify(a)); else localStorage.removeItem(ACCT_CACHE); } catch (e) { /* not kept */ } };

  // ---------------------------------------------------------------- session
  A.init = async function () {
    // Is phone sign-in available? (public settings endpoint; cheap, never blocks sign-in)
    fetch(cfg.url.replace(/\/$/, '') + '/auth/v1/settings', { headers: { apikey: cfg.key } }).then((r) => r.json()).then((j) => { A.phone = !!(j && j.external && j.external.phone); if (VF.ui.login && document.querySelector('.auth')) VF.renderSignin(); }).catch(() => {});
    const q = new URLSearchParams(location.search);
    const urlError = q.get('error_description') || q.get('error');
    const { data } = await sb.auth.getSession(); // also completes a ?code= sign-in link (PKCE)
    if (q.has('code') || urlError) { history.replaceState(null, '', location.pathname + location.hash); }
    if (urlError) VF.ui.login.error = friendly(urlError);
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
    if (acct.status === 'needs_onboarding' || !acct.org) return 'onboard';
    let lvl = null; try { const r = await sb.auth.mfa.getAuthenticatorAssuranceLevel(); lvl = r && r.data; } catch (e) { /* older session */ }
    if (lvl && lvl.nextLevel === 'aal2' && lvl.currentLevel !== 'aal2') return 'mfa';       // has an authenticator: use it
    if (acct.mfa_required || (A.isStaff(acct) && lvl && lvl.currentLevel !== 'aal2')) return 'mfa-enroll'; // staff without one: set it up
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
    if (VF.cloud && VF.cloud.start) VF.cloud.start({ org: acct.org.id, onAdopt: () => { VF.session = { userId: personalise(VF.state, A.account), account: true }; } });
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

  A.signOut = async function (everywhere) {
    try { await sb.auth.signOut({ scope: everywhere ? 'global' : 'local' }); } catch (e) { /* signed out locally anyway */ }
    // Shared devices: remove this account's workspace copy from the browser.
    try { for (const k of Object.keys(localStorage)) if (k.startsWith(ORG_PREFIX)) localStorage.removeItem(k); } catch (e) { /* none */ }
    cacheAccount(null); try { sessionStorage.removeItem('voltfleet-os:session'); } catch (e) { /* none */ }
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
        ${err(ui)}${ok(ui)}${btn('Sign in')}</form>
        <div class="auth-alt"><button type="button" class="btn" data-act="auth-mode" data-k="magic">${icon('mail')}Email me a sign-in link</button>${A.phone ? `<button type="button" class="btn" data-act="auth-mode" data-k="phone">${icon('smartphone')}Use my phone number</button>` : ''}</div>`;
    else if (m === 'magic') body = head('Sign in with a link', 'We’ll email you a one-time link. No password needed.') + tabs + `<form id="auth-magic" class="auth-form" novalidate>${field('Email', `<input class="input lg" name="email" type="email" autocomplete="username" required value="${esc(ui.email || '')}">`)}${err(ui)}${ok(ui)}${btn('Send sign-in link')}</form><button type="button" class="link-btn" data-act="auth-mode" data-k="signin">${icon('arrow-left')}Back to password sign-in</button>`;
    else if (m === 'phone') body = head('Sign in with your phone', ui.phoneSent ? `Enter the 6-digit code we sent to ${esc(ui.phone || '')}.` : 'We’ll text you a 6-digit code.') + tabs + `<form id="auth-phone" class="auth-form" novalidate>${ui.phoneSent ? field('Code', '<input class="input lg mono" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>') : field('Phone number', `<input class="input lg" name="phone" type="tel" autocomplete="tel" placeholder="+233 24 123 4567" required value="${esc(ui.phone || '')}">`, 'Include the country code, e.g. +233.')}${err(ui)}${ok(ui)}${btn(ui.phoneSent ? 'Verify and sign in' : 'Send code')}</form><button type="button" class="link-btn" data-act="auth-mode" data-k="signin">${icon('arrow-left')}Back</button>`;
    else if (m === 'reset') body = head('Reset your password', 'We’ll email you a link to choose a new one.') + tabs + `<form id="auth-reset" class="auth-form" novalidate>${field('Email', `<input class="input lg" name="email" type="email" autocomplete="username" required value="${esc(ui.email || '')}">`)}${err(ui)}${ok(ui)}${btn('Send reset link')}</form><button type="button" class="link-btn" data-act="auth-mode" data-k="signin">${icon('arrow-left')}Back to sign in</button>`;
    else if (m === 'mfa') body = head('Two-factor sign-in', 'Enter the 6-digit code from your authenticator app.') + `<form id="auth-mfa" class="auth-form" novalidate>${field('Code', '<input class="input lg mono" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" required autofocus>')}${err(ui)}${btn('Verify')}</form>
        <details class="small muted"><summary>Lost your phone or authenticator?</summary><p>Ask your VoltFleet administrator to reset two-factor sign-in for your account after they’ve confirmed who you are. If you added a backup device, use that instead.</p></details>
        <button type="button" class="link-btn" data-act="auth-signout">${icon('log-out')}Sign out</button>`;
    else if (m === 'mfa-enroll') body = head('Protect your account', `${ui.staffNote === false ? 'Turn on two-factor sign-in.' : 'Staff accounts need two-factor sign-in: a password plus a code from an app on your phone.'}`) + (ui.enroll ? enrollBox(ui.enroll, 'auth-mfa-enroll') : `${err(ui)}<button type="button" class="btn" data-act="auth-enroll-retry">${icon('refresh-cw')}Try again</button>`) + `<button type="button" class="link-btn" data-act="auth-signout">${icon('log-out')}Sign out</button>`;
    else if (m === 'recover') body = head('Choose a new password', 'At least 10 characters.') + `<form id="auth-recover" class="auth-form" novalidate>${field('New password', '<input class="input lg" name="password" type="password" autocomplete="new-password" minlength="10" required>')}${err(ui)}${btn('Save and continue')}</form>`;
    else if (m === 'signup' || m === 'onboard') {
      const type = ui.type || 'fleet'; const onboard = m === 'onboard';
      body = head(onboard ? 'Set up your account' : 'Create your account', onboard ? 'One last step: tell us how you use VoltFleet.' : 'Free while in beta. Your organisation’s data is private to your team.') + (onboard ? '' : tabs) + `<form id="${onboard ? 'auth-onboard' : 'auth-signup'}" class="auth-form" novalidate>
        <div class="type-grid" role="radiogroup" aria-label="Account type">${TYPES.map(([k, l, ic, d]) => `<button type="button" role="radio" aria-checked="${type === k}" class="type-opt" data-act="auth-type" data-k="${k}">${icon(ic)}<strong>${l}</strong><span class="small muted">${d}</span></button>`).join('')}</div>
        ${onboard ? '' : field('Full name', `<input class="input lg" name="fullname" autocomplete="name" maxlength="80" required value="${esc(ui.fullname || '')}">`)}
        ${type === 'driver' ? '' : field(type === 'fleet' ? 'Company name' : type === 'operator' ? 'Charging network name' : 'Company name', `<input class="input lg" name="org" autocomplete="organization" maxlength="80" required value="${esc(ui.org || '')}">`)}
        ${onboard ? '' : field('Work email', `<input class="input lg" name="email" type="email" autocomplete="email" required value="${esc(ui.email || '')}">`) + field('Password', '<input class="input lg" name="password" type="password" autocomplete="new-password" minlength="10" required>', 'At least 10 characters. Use a password manager if you can.')}
        ${onboard ? '' : `<label class="check small"><input type="checkbox" name="agree" required ${ui.agree ? 'checked' : ''}>I agree to the terms and the privacy notice, and confirm I’m allowed to add my organisation.</label>`}
        ${err(ui)}${ok(ui)}${btn(onboard ? 'Create workspace' : 'Create account')}</form>
        ${onboard ? `<button type="button" class="link-btn" data-act="auth-signout">${icon('log-out')}Sign out</button>` : ''}`;
    } else if (m === 'check') body = head('Check your email', `We sent a confirmation link to <strong>${esc(ui.email || 'your inbox')}</strong>. Open it on this device to finish creating your account.`) + `${ok(ui)}${err(ui)}<div class="auth-alt"><button type="button" class="btn" data-act="auth-resend">${icon('mail')}Send it again</button><button type="button" class="btn ghost" data-act="auth-mode" data-k="signin">I’ve confirmed: sign in</button></div><p class="small muted">Can’t find it? Check spam, or ask your administrator to allow emails from VoltFleet.</p>`;
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
  async function afterSignIn() {
    const acct = await rpc('complete_signup'); A.account = acct; cacheAccount(acct); A.busy = false;
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
        busy(); const { error } = await sb.auth.signInWithPassword({ email, password: d.password }); if (error) return setErr(friendly(error));
        return afterSignIn();
      }
      if (id === 'auth-magic') {
        if (!emailOk(email)) return setErr('Enter a valid email address.');
        busy(); const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect(), shouldCreateUser: false } });
        return error ? setErr(friendly(error)) : setOk('If that email has an account, a sign-in link is on its way. Open it on this device.');
      }
      if (id === 'auth-reset') {
        if (!emailOk(email)) return setErr('Enter a valid email address.');
        busy(); const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirect() });
        return error ? setErr(friendly(error)) : setOk('If that email has an account, a reset link is on its way.');
      }
      if (id === 'auth-mfa' || id === 'auth-mfa-enroll') {
        const code = String(d.code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(code)) return setErr('Enter the 6-digit code.');
        let factorId = id === 'auth-mfa-enroll' ? L().enroll && L().enroll.id : null;
        if (!factorId) { const fs = await verifiedFactors(); factorId = fs[0] && fs[0].id; }
        if (!factorId) return setErr('No authenticator found. Sign out and in again.');
        busy(); const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code }); if (error) return setErr(friendly(error));
        if (id === 'auth-mfa-enroll') VF.toast('Two-factor sign-in is on');
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
          busy(); const { error } = await sb.auth.signInWithOtp({ phone }); if (error) return setErr(friendly(error));
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
        busy();
        const { data, error } = await sb.auth.signUp({ email, password: d.password, options: { emailRedirectTo: redirect(), data: { full_name: fullname, account_type: type, org_name: org } } });
        if (error) return setErr(friendly(error));
        if (data && data.session) return afterSignIn();
        A.busy = false; L().mode = 'check'; L().ok = ''; return VF.renderSignin();
      }
    } catch (e) { setErr(friendly(e)); }
  };
  document.addEventListener('submit', (e) => { const f = e.target; if (f && /^auth-/.test(f.getAttribute('id') || '')) { e.preventDefault(); if (!A.busy) A.submit(f); } });

  Object.assign(VF.ACT, {
    'auth-mode': (el) => { Object.assign(L(), { mode: el.dataset.k, error: '', ok: '', phoneSent: false }); VF.renderSignin(); },
    'auth-type': (el) => { const f = el.closest('form'); if (f) { const n = f.querySelector('[name="org"]'); if (n) L().org = n.value; const fn = f.querySelector('[name="fullname"]'); if (fn) L().fullname = fn.value; const em = f.querySelector('[name="email"]'); if (em) L().email = em.value; } L().type = el.dataset.k; VF.renderSignin(); },
    'auth-resend': async () => { const email = L().email; if (!email) return; const { error } = await sb.auth.resend({ type: 'signup', email, options: { emailRedirectTo: redirect() } }); if (error) setErr(friendly(error)); else setOk('Sent again. It can take a minute to arrive.'); },
    'auth-signout': () => A.signOut(false),
    'auth-enroll-retry': async () => { await A.startEnroll(); VF.renderSignin(); },
    'auth-copy-secret': (el) => { try { navigator.clipboard.writeText(el.dataset.secret); VF.toast('Key copied'); } catch (e) { VF.toast('Copy the key by hand'); } },
    'acct-mfa-add': async () => { try { A.acctEnroll = await newFactor(); } catch (e) { A.acctEnroll = null; return acctErr(friendly(e)); } openAccount(); },
    'acct-mfa-verify': async () => {
      const i = document.querySelector('#acct-mfa-form [name="code"]'); const code = i ? i.value.replace(/\s/g, '') : '';
      if (!/^\d{6}$/.test(code) || !A.acctEnroll) { const e = document.getElementById('acct-mfa-error'); if (e) { e.hidden = false; e.lastElementChild.textContent = 'Enter the 6-digit code.'; } return; }
      const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: A.acctEnroll.id, code });
      if (error) { const e = document.getElementById('acct-mfa-error'); if (e) { e.hidden = false; e.lastElementChild.textContent = friendly(error); } return; }
      A.acctEnroll = null; VF.toast('Authenticator added'); openAccount();
    },
    'acct-mfa-cancel': async () => { if (A.acctEnroll) { try { await sb.auth.mfa.unenroll({ factorId: A.acctEnroll.id }); } catch (e) { /* unverified */ } } A.acctEnroll = null; openAccount(); },
    'acct-mfa-remove': async (el) => {
      if (!await VF.c.confirm({ title: 'Remove this authenticator?', body: A.isStaff(A.account) ? 'You still need another authenticator: staff accounts can’t sign in without one.' : 'Signing in will need only your password.', confirmLabel: 'Remove', danger: true })) return openAccount();
      const { error } = await sb.auth.mfa.unenroll({ factorId: el.dataset.id }); if (error) VF.toast(friendly(error)); else VF.toast('Authenticator removed'); openAccount();
    },
    'auth-acct': () => openAccount(),
    'acct-invite': async () => { const i = document.getElementById('acct-invite-email'); const v = i ? i.value.trim() : ''; try { A.account = await rpc('invite_member', { p_email: v }); VF.toast('Invitation saved'); openAccount(); } catch (e) { acctErr(e.message); } },
    'acct-revoke': async (el) => { try { A.account = await rpc('revoke_invite', { p_id: el.dataset.id }); openAccount(); } catch (e) { acctErr(e.message); } },
    'acct-remove': async (el) => { if (!await VF.c.confirm({ title: 'Remove this person from your organisation?', body: 'They keep their login but lose access to your workspace straight away.', confirmLabel: 'Remove', danger: true })) return openAccount(); try { A.account = await rpc('remove_member', { p_user: el.dataset.id }); openAccount(); } catch (e) { VF.toast(e.message); } },
    'acct-password': async () => { const i = document.getElementById('acct-new-pass'); const v = i ? i.value : ''; if (v.length < 10) return acctErr('Use at least 10 characters.'); const { error } = await sb.auth.updateUser({ password: v }); if (error) return acctErr(friendly(error)); VF.toast('Password changed'); openAccount(); },
    'acct-signout-all': async () => { if (!await VF.c.confirm({ title: 'Sign out everywhere?', body: 'Every device signed in to your account is signed out, including this one.', confirmLabel: 'Sign out everywhere' })) return; A.signOut(true); },
    'acct-delete': async () => {
      if (!await VF.c.confirm({ title: 'Delete your account?', body: 'Your login and profile are erased now. If nobody else is in your organisation, its workspace is deleted too. This can’t be undone.', confirmLabel: 'Delete my account', danger: true })) return;
      try { await rpc('delete_my_account'); VF.toast('Account deleted'); setTimeout(() => A.signOut(false), 600); } catch (e) { VF.toast(e.message); }
    },
  });

  // ---------------------------------------------------------------- account & team panel
  const acctErr = (m) => { const el = document.getElementById('acct-error'); if (el) { el.hidden = false; el.lastElementChild.textContent = m; } };
  async function openAccount() {
    try { A.account = Object.assign({}, A.account, await rpc('my_account')); cacheAccount(A.account); } catch (e) { /* show cached */ }
    const a = A.account || {}; const admin = ['manager', 'operator', 'developer'].includes(a.role);
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
      ${a.org ? `<section class="acct-team"><h4>Team · ${esc(a.org.name)}</h4><ul class="plain-list">${(a.members || []).map((m) => `<li><div><strong>${esc(m.full_name || 'Unnamed')}</strong>${m.you ? ' <span class="badge teal">You</span>' : ''}<div class="small muted">${esc(ROLE_LABEL[m.role] || m.role)}</div></div>${admin && !m.you ? `<button type="button" class="btn small ghost" data-act="acct-remove" data-id="${esc(m.id)}">Remove</button>` : ''}</li>`).join('')}</ul>
        ${admin ? `<div class="row gap acct-invite"><input class="input" id="acct-invite-email" type="email" placeholder="colleague@company.com" aria-label="Email to invite"><button type="button" class="btn" data-act="acct-invite">${icon('user-plus')}Invite</button></div><p class="small muted">They join your workspace when they create a VoltFleet account with this email and confirm it.</p>
        ${(a.invites || []).length ? `<ul class="plain-list">${a.invites.map((i) => `<li><div><strong>${esc(i.email)}</strong><div class="small muted">Invited · ${esc(ROLE_LABEL[i.role] || i.role)}</div></div><button type="button" class="btn small ghost" data-act="acct-revoke" data-id="${esc(i.id)}">Revoke</button></li>`).join('')}</ul>` : ''}` : ''}</section>` : ''}
      ${audit.length ? `<section><h4>Recent activity</h4><ul class="plain-list small">${audit.map((x) => `<li><span>${esc(x.action)}${x.detail && x.detail.email ? ' · ' + esc(x.detail.email) : ''}</span><span class="faint">${esc(new Date(x.at).toLocaleString())}</span></li>`).join('')}</ul></section>` : ''}
      ${platform ? `<section><h4>Platform</h4><p class="small">${platform.accounts} accounts · ${platform.pending} unfinished sign-ups · ${platform.signups_7d} new this week · ${platform.staff_with_2fa != null ? platform.staff_with_2fa + ' staff with two-factor · ' : ''} ${Object.entries(platform.organisations || {}).map(([k, n]) => `${n} ${esc(k)}`).join(', ')}</p></section>` : ''}
      <section class="acct-danger"><h4>Delete account</h4><p class="small muted">Erases your login and profile (your right to erasure). Workspaces with other members stay.</p><button type="button" class="btn small danger" data-act="acct-delete">${icon('trash-2')}Delete my account</button></section>
      <div class="form-error" id="acct-error" hidden>${icon('warn')}<span></span></div>`,
      onSubmit(d) { rpc('update_my_name', { p_name: d.fullname }).then((acct) => { A.account = Object.assign(A.account, acct); cacheAccount(A.account); personalise(VF.state, A.account); VF.save(); VF.toast('Name saved'); VF.rerender(); }).catch((e) => VF.toast(e.message)); return null; } });
  }
  A.openAccount = openAccount;
})();
