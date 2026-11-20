// Unit tests for the action patches in js/cloud.js (diff on one device, apply on a newer world).
const { ROOT, FIX, OUT, AXE } = require('../lib.cjs');
const vm = require('vm'); const fs = require('fs');
const ctx = { window: {}, VF: {}, console }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + '/js/cloud.js', 'utf8'), ctx);
const { diff, apply, same } = ctx.VF.syncPatch;
const J = (x) => JSON.parse(JSON.stringify(x));
let n = 0, f = 0; const ok = (c, m) => { n++; if (!c) f++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const base = { rev: 5, seq: 10, audit: [{ t: 3, a: 'x' }, { t: 2, a: 'y' }, { t: 1, a: 'z' }], users: [{ id: 'u1', name: 'A' }, { id: 'u2', name: 'B' }], fleet: { seq: 4, depots: [{ id: 'dp1', name: 'One' }] }, settings: { tz: 0, currency: 'GHS' }, members: { k1: 'u1' } };
// local action: rename u1, add a depot with the next id, log an audit line (capped at 3), change a setting, delete a member key
const local = J(base); local.users[0].name = 'A2'; local.fleet.depots.push({ id: 'dp' + local.fleet.seq++, name: 'Mine' }); local.audit.unshift({ t: 4, a: 'mine' }); local.audit.length = 3; local.settings.tz = 1; delete local.members.k1; local.seq = 11;
const p = diff(J(base), J(local));
// remote moved on meanwhile: renamed u2, added its own depot with the SAME counter id, logged its own audit line, added a user
const remote = J(base); remote.rev = 9; remote.users[1].name = 'B2'; remote.fleet.depots.push({ id: 'dp4', name: 'Theirs' }); remote.fleet.seq = 5; remote.audit.unshift({ t: 4, a: 'theirs' }); remote.audit.length = 3; remote.users.push({ id: 'u3', name: 'C' }); remote.seq = 12;
const out = J(remote); apply(out, p);
ok(out.users.find((u) => u.id === 'u1').name === 'A2' && out.users.find((u) => u.id === 'u2').name === 'B2' && out.users.some((u) => u.id === 'u3'), 'record edits on both sides survive');
const ids = out.fleet.depots.map((d) => d.id);
ok(ids.length === 3 && new Set(ids).size === 3 && out.fleet.depots.some((d) => d.name === 'Mine') && out.fleet.depots.some((d) => d.name === 'Theirs'), 'same counter id on both sides: both kept, renamed ' + ids.join(','));
ok(out.audit.length === 3 && out.audit[0].a === 'mine' && out.audit[1].a === 'theirs', 'newest-first log: own line prepended to theirs, cap kept ' + out.audit.map((x) => x.a).join(','));
ok(out.settings.tz === 1 && out.settings.currency === 'GHS' && !('k1' in out.members), 'settings change and key delete applied');
ok(out.seq === 12 && out.fleet.seq === 5, 'id counters never go backwards (seq ' + out.seq + ', fleet.seq ' + out.fleet.seq + ')');
ok(out.rev === 9, 'revision is the server\'s');
// a record removed remotely: edits to it are dropped, not resurrected
const r2 = J(base); r2.users = r2.users.filter((u) => u.id !== 'u1'); const o2 = J(r2); apply(o2, p);
ok(!o2.users.some((u) => u.id === 'u1'), 'edit to a record deleted elsewhere does not bring it back');
// a local delete of a record
const l3 = J(base); l3.users = l3.users.filter((u) => u.id !== 'u2'); const o3 = J(remote); apply(o3, diff(J(base), l3));
ok(!o3.users.some((u) => u.id === 'u2') && o3.users.some((u) => u.id === 'u3'), 'local delete applied, remote insert kept');
// applying the same patch to the state it came from is a no-op (idempotent)
const o4 = J(local); apply(o4, p); ok(same(o4, local), 'idempotent on its own result');
// later patch referring to a renamed record follows the rename
const l5 = J(local); l5.fleet.depots.find((d) => d.id === 'dp4').name = 'Mine renamed';
const p2 = diff(J(local), J(l5)); const o5 = J(remote); const ren = apply(o5, p); apply(o5, p2, ren);
ok(o5.fleet.depots.find((d) => d.id === 'dp4').name === 'Theirs' && o5.fleet.depots.some((d) => d.name === 'Mine renamed'), 'second action on a renamed record lands on the renamed one');
console.log(`${n - f}/${n} passed`);
