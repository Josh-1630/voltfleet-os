#!/usr/bin/env node
// VoltFleet OS regression suite: the checks written during QA rounds 1-4, as one command.
//   node tests/run.cjs                 all browser, unit and Edge Function tests (+ database tests with --sql)
//   node tests/run.cjs xss csp         only the named tests
//   node tests/run.cjs --sql           also run tests/sql/run.sh (needs Postgres: PGHOST/PGUSER/PGPASSWORD)
// A test fails when it exits non-zero, prints a line starting with "FAIL", or misses its expectations below.
// Serves the app on :8080 and the cross-origin "attacker" page on 127.0.0.1:8091 unless VF_NO_SERVE=1.
const { spawn } = require('child_process'); const path = require('path'); const fs = require('fs');
const { serve } = require('./serve.cjs'); const { ROOT, OUT } = require('./lib.cjs');
const T = __dirname;
const e2e = (f) => ({ cmd: 'node', args: [path.join(T, 'e2e', f + '.js')] });
const mts = (f) => ({ cmd: 'node', args: ['--experimental-strip-types', '--no-warnings', path.join(T, 'functions', f + '.mts')] });
const has = (...re) => ({ must: re });
const TESTS = {
  // round 1-2: accounts, sync, injection, accessibility
  'auth': e2e('auth'), 'auth-legacy': e2e('auth-legacy'), 'auth-r3': e2e('auth-r3'),
  'sync-cas': { ...e2e('sync-cas'), extra: ['cas'] },
  'xss': { ...e2e('xss'), must: [/manager: .*· clean/, /driver: .*· clean/, /operator: .*· clean/, /admin: .*· clean/, /developer: .*· clean/] },
  'csp': { ...e2e('csp'), ...has(/^no CSP violations$/m) },
  'sanitize': e2e('sanitize'),
  'manager-ops': e2e('manager-ops'), 'ops-phone': e2e('ops-phone'), 'driver-plus': e2e('driver-plus'), 'photos': e2e('photos'),
  'pages': { ...e2e('pages'), extra: [OUT], noPass: true }, 'pages-driver': { ...e2e('pages-driver'), extra: [OUT] }, 'pages-more': { ...e2e('pages-more'), extra: [OUT] },
  'signin-to-org': { ...e2e('signin-to-org'), ...has(/^errors: none$/m, /private workspace after a demo update: \{"mode":"account"/) },
  'demo-to-org': { ...e2e('demo-to-org'), ...has(/^errors: none$/m, /private workspace after a demo update: \{"mode":"account"/) },
  'removed-member': e2e('removed-member'),
  'badref': { ...e2e('badref'), ...has(/^distinct errors: ?$/m), mustNot: [/"pageErrors":[1-9]/, /"failedPage":true/, /"shell":false/] },
  'badref-fleet': e2e('badref-fleet'),
  'frame': { ...e2e('frame'), ...has(/frame-guard present: true/, /app rendered in frame \(auth\/demo UI\): false/) },
  'swcache': { ...e2e('swcache'), ...has(/no query URLs cached/, /offline: app shell served: true/, /cache names: voltfleet-os-v\d+$/m) },
  'spoof': { ...e2e('spoof'), ...has(/sign-in error box: "That sign-in link didn’t work/) },
  'acct-enter': { ...e2e('acct-enter'), ...has(/toasts: \["Password changed"\]/, /stored password changed: true/) },
  'cssinj': { ...e2e('cssinj'), extra: [path.join(OUT, 'cssinj.png')], ...has(/score after sanitizeState: 0/, /injected styled elements: \[\]/) },
  'mobile': { ...e2e('mobile'), ...has(/no horizontal overflow at 393px/, /in-dialog:Cancel -> in-dialog:Confirm -> in-dialog:Cancel -> in-dialog:Confirm/) },
  'a11y': { ...e2e('a11y'), empty: true },
  'a11y-r3': { ...e2e('a11y-r3'), ...has(/no violations on the round-3 screens/), mustNot: [/unexpected screen/] },
  // round 3-4
  'robust': e2e('robust'), 'ocpp-recover': e2e('ocpp-recover'), 'map-privacy': e2e('map-privacy'), 'dashboard-links': e2e('dashboard-links'), 'slow-load': e2e('slow-load'),
  'heads': e2e('heads'), 'r3-app': e2e('r3-app'), 'r4-app': e2e('r4-app'), 'signout': e2e('signout'),
  'patch': { cmd: 'node', args: [path.join(T, 'unit', 'patch.js')] },
  'fn-smartcar-r2': mts('smartcar-r2'), 'fn-smartcar-r3': mts('smartcar-r3'), 'fn-ocpp': mts('ocpp'),
};
const argv = process.argv.slice(2); const wantSql = argv.includes('--sql'); const names = argv.filter((a) => !a.startsWith('--'));
for (const n of names) if (!TESTS[n] && n !== 'sql') { console.error('unknown test: ' + n + '\nknown: ' + Object.keys(TESTS).join(' ')); process.exit(2); }
const list = names.length ? names.filter((n) => n !== 'sql') : Object.keys(TESTS);
const PAR = +(process.env.VF_TEST_JOBS || 3); const TIMEOUT = +(process.env.VF_TEST_TIMEOUT || 600) * 1000;

function judge(name, t, code, out) {
  const why = [];
  if (code !== 0) why.push('exit code ' + code);
  const fails = out.split('\n').filter((l) => /^FAIL\b/.test(l)); if (fails.length) why.push(...fails);
  for (const re of t.must || []) if (!re.test(out)) why.push('missing: ' + re);
  for (const re of t.mustNot || []) if (re.test(out)) why.push('unexpected: ' + re);
  if (t.empty && out.trim()) why.push('expected no output, got: ' + out.trim().split('\n').slice(0, 5).join(' / '));
  if (!t.must && !t.empty && !t.noPass && !/^PASS\b/m.test(out)) why.push('no PASS lines');
  return why;
}
function runOne(name) {
  const t = TESTS[name];
  return new Promise((resolve) => {
    const started = Date.now(); let out = '';
    const ch = spawn(t.cmd, [...t.args, ...(t.extra || [])], { cwd: ROOT, env: { ...process.env, VF_TEST_OUT: OUT } });
    const timer = setTimeout(() => { out += '\nFAIL timed out\n'; ch.kill('SIGKILL'); }, TIMEOUT);
    ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { out += d; });
    ch.on('close', (code) => {
      clearTimeout(timer); fs.writeFileSync(path.join(OUT, name + '.log'), out);
      const why = judge(name, t, code, out); const passes = (out.match(/^PASS\b/gm) || []).length;
      console.log(`${why.length ? 'FAIL' : 'ok  '}  ${name.padEnd(16)} ${String(passes).padStart(3)} checks  ${((Date.now() - started) / 1000).toFixed(0)}s`);
      for (const w of why.slice(0, 8)) console.log('        ' + w.slice(0, 300));
      // A crash (exit code without FAIL lines) is easiest to fix with its last lines in the CI log itself.
      if (code !== 0) for (const l of out.split('\n').filter((x) => x.trim() && !/^PASS\b/.test(x)).slice(-12)) console.log('        | ' + l.slice(0, 240));
      resolve(why.length === 0);
    });
  });
}
function runSql() {
  return new Promise((resolve) => {
    const ch = spawn('bash', [path.join(T, 'sql', 'run.sh')], { cwd: ROOT, env: process.env }); let out = '';
    ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { out += d; });
    ch.on('close', (code) => { fs.writeFileSync(path.join(OUT, 'sql.log'), out); const ok = code === 0 && !/^FAIL/m.test(out); console.log(`${ok ? 'ok  ' : 'FAIL'}  sql`); if (!ok) console.log(out.split('\n').slice(0, 40).map((l) => '        ' + l).join('\n')); resolve(ok); });
  });
}
(async () => {
  const servers = [];
  if (!process.env.VF_NO_SERVE) { servers.push(await serve(ROOT, 8080, undefined)); servers.push(await serve(path.join(T, 'fixtures', 'evil'), 8091, '127.0.0.1')); }
  const queue = [...list]; let failed = 0;
  await Promise.all(Array.from({ length: Math.min(PAR, queue.length) }, async () => { while (queue.length) if (!(await runOne(queue.shift()))) failed++; }));
  if (wantSql || names.includes('sql')) if (!(await runSql())) failed++;
  for (const s of servers) s.close();
  console.log(failed ? `\n${failed} test file(s) failed. Logs: ${OUT}` : `\nAll ${list.length + (wantSql || names.includes('sql') ? 1 : 0)} test files passed.`);
  process.exit(failed ? 1 : 0);
})();
