// Supabase Edge Function entry point: wires the Smartcar bridge (handler.ts) to Postgres and the environment.
// Secrets (set in Supabase → Edge Functions → Secrets): SMARTCAR_CLIENT_ID, SMARTCAR_CLIENT_SECRET.
// Optional: ALLOWED_ORIGINS (comma-separated sites allowed to call this function).
import postgres from 'npm:postgres@3.4.5';
import { handle, type Store } from './handler.ts';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 3, idle_timeout: 20 });
const ms = (t: Date | string | null) => (t ? new Date(t).getTime() : 0);

const store: Store = {
  async addState(hash) { await sql`insert into private.smartcar_states (state_hash) values (${hash})`; await sql`delete from private.smartcar_states where created_at < now() - interval '1 day'`; },
  async pendingStates(sinceMs) { const [r] = await sql`select count(*)::int as n from private.smartcar_states where used_at is null and created_at > ${new Date(sinceMs)}`; return r.n; },
  async takeState(hash, maxAgeMs) {
    const rows = await sql`update private.smartcar_states set used_at = now() where state_hash = ${hash} and used_at is null and created_at > now() - make_interval(secs => ${maxAgeMs / 1000}) returning created_at`;
    return rows.length ? { createdAt: ms(rows[0].created_at) } : null;
  },
  async addLink(keyHash, userId) { await sql`insert into private.smartcar_links (key_hash, user_id) values (${keyHash}, ${userId})`; },
  async findLink(keyHash) { const rows = await sql`update private.smartcar_links set last_used_at = now() where key_hash = ${keyHash} returning user_id`; return rows.length ? { userId: rows[0].user_id } : null; },
  async removeLink(keyHash) {
    const rows = await sql`delete from private.smartcar_links where key_hash = ${keyHash} returning user_id`;
    if (!rows.length) return null;
    const [r] = await sql`select count(*)::int as n from private.smartcar_links where user_id = ${rows[0].user_id}`;
    return { userId: rows[0].user_id, remaining: r.n };
  },
  async getCache(vehicleId) { const rows = await sql`select user_id, info, payload, fetched_at from private.smartcar_cache where vehicle_id = ${vehicleId}`; return rows.length ? { userId: rows[0].user_id, info: rows[0].info, payload: rows[0].payload, fetchedAt: ms(rows[0].fetched_at) } : null; },
  async putCache(vehicleId, userId, info, payload, fetchedAt) {
    await sql`insert into private.smartcar_cache (vehicle_id, user_id, info, payload, fetched_at) values (${vehicleId}, ${userId}, ${sql.json(info)}, ${sql.json(payload)}, ${new Date(fetchedAt)})
      on conflict (vehicle_id) do update set user_id = excluded.user_id, info = excluded.info, payload = excluded.payload, fetched_at = excluded.fetched_at`;
  },
  async dropCache(userId) { await sql`delete from private.smartcar_cache where user_id = ${userId}`; },
  async getToken() { const rows = await sql`select access_token, expires_at from private.smartcar_app_token where id = 1`; return rows.length ? { token: rows[0].access_token, expiresAt: ms(rows[0].expires_at) } : null; },
  async putToken(token, expiresAt) { await sql`insert into private.smartcar_app_token (id, access_token, expires_at) values (1, ${token}, ${new Date(expiresAt)}) on conflict (id) do update set access_token = excluded.access_token, expires_at = excluded.expires_at`; },
};

Deno.serve((req) => handle(req, { fetch, env: (k) => Deno.env.get(k), store, now: Date.now }));
