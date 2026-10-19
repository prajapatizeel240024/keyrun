// Apps, workflows, devices and (ciphertext-only) credentials.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { withTx } from '../db/pool.ts';
import { validateWorkflow, type Workflow } from '../engine/schema.ts';
import { allWorkflows } from '../engine/workflows.ts';
import { HttpError } from './queue.ts';
import { DEFAULT_POLICY, PolicySchema } from './policy.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest();

// ---------- apps ----------
export async function upsertApp(db: pg.Pool, app: { id: string; name: string; baseUrl: string; policy?: unknown }) {
  const policy = PolicySchema.parse({ ...DEFAULT_POLICY, ...(app.policy as object | undefined) });
  await db.query(
    `insert into apps (id, name, base_url, policy) values ($1, $2, $3, $4)
     on conflict (id) do update set name = excluded.name, base_url = excluded.base_url`,
    [app.id, app.name, app.baseUrl, policy],
  );
}

export async function setPolicy(db: pg.Pool, appId: string, policy: unknown) {
  const parsed = PolicySchema.safeParse(policy);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const r = await db.query(`update apps set policy = $2 where id = $1 returning *`, [appId, parsed.data]);
  if (!r.rows[0]) throw new HttpError(404, 'no such app');
  return r.rows[0];
}

// ---------- workflows ----------
/** Load the repo's workflow files as new versions when they differ from the latest stored one. */
export async function syncRepoWorkflows(db: pg.Pool): Promise<number> {
  let added = 0;
  const apps = new Set((await db.query(`select id from apps`)).rows.map((r) => r.id));
  for (const wf of allWorkflows()) {
    if (!apps.has(wf.app)) continue;
    const latest = (await db.query(`select version, definition from workflows where app_id = $1 and kind = $2 order by version desc limit 1`, [wf.app, wf.kind])).rows[0];
    if (latest && JSON.stringify(latest.definition) === JSON.stringify(wf)) continue;
    await db.query(`insert into workflows (app_id, kind, version, definition, source) values ($1, $2, $3, $4, 'repo')`, [
      wf.app, wf.kind, (latest?.version ?? 0) + 1, wf,
    ]);
    added++;
  }
  return added;
}

export async function saveWorkflow(db: pg.Pool, json: unknown, source: 'editor' | 'recorder'): Promise<{ id: number; version: number; workflow: Workflow }> {
  const v = validateWorkflow(json);
  if (!v.ok) throw new HttpError(400, v.errors.join('\n'));
  const wf = v.workflow;
  return withTx(db, async (c) => {
    const appKnown = (await c.query(`select 1 from apps where id = $1`, [wf.app])).rowCount;
    const appId = appKnown ? wf.app : null; // drafts for unknown apps are kept unassigned
    await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [`${wf.app}/${wf.kind}`]);
    const latest = (await c.query(`select max(version) as v from workflows where app_id is not distinct from $1 and kind = $2`, [appId, wf.kind])).rows[0].v ?? 0;
    const def = { ...wf, version: latest + 1 };
    const r = await c.query(`insert into workflows (app_id, kind, version, definition, source) values ($1, $2, $3, $4, $5) returning id`, [
      appId, wf.kind, latest + 1, def, source,
    ]);
    return { id: r.rows[0].id, version: latest + 1, workflow: def };
  });
}

// ---------- devices ----------
export async function enrollDevice(db: pg.Pool, name: string, publicKeyB64: string): Promise<{ deviceId: string; token: string }> {
  const pk = Buffer.from(publicKeyB64, 'base64');
  if (pk.length !== 32) throw new HttpError(400, 'publicKey must be a 32-byte X25519 key (base64)');
  const deviceId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await db.query(`insert into devices (id, name, public_key, token_hash) values ($1, $2, $3, $4)`, [deviceId, name, pk, sha256(token)]);
  return { deviceId, token };
}

export async function authenticateDevice(db: pg.Pool, header: string | undefined): Promise<string> {
  const m = /^Bearer ([0-9a-f-]{36})\.([\w-]+)$/.exec(header ?? '');
  if (!m) throw new HttpError(401, 'device token required');
  const r = await db.query(`select token_hash from devices where id = $1`, [m[1]]);
  const want: Buffer | undefined = r.rows[0]?.token_hash;
  const got = sha256(m[2]);
  if (!want || want.length !== got.length || !timingSafeEqual(want, got)) throw new HttpError(401, 'bad device token');
  await db.query(`update devices set last_seen_at = now() where id = $1`, [m[1]]);
  return m[1];
}

// ---------- credentials (ciphertext only) ----------
export type CredentialUpload = {
  id: string;
  appId: string;
  label: string;
  version: number;
  ciphertext: string; // base64
  nonce: string; // base64
  sealedKeys: Array<{ deviceId: string; sealedDek: string }>;
};

/** Store a new credential (version 1) or the next version of an existing one (compare-and-swap). */
export async function putCredential(db: pg.Pool, deviceId: string, up: CredentialUpload): Promise<{ version: number }> {
  if (!/^[0-9a-f-]{36}$/.test(up.id)) throw new HttpError(400, 'credential id must be a uuid chosen by the device');
  if (!up.sealedKeys?.length) throw new HttpError(400, 'at least one sealed key is required');
  const ct = Buffer.from(up.ciphertext, 'base64');
  const nonce = Buffer.from(up.nonce, 'base64');
  if (nonce.length !== 24 || ct.length < 17) throw new HttpError(400, 'not an XChaCha20-Poly1305 envelope');
  return withTx(db, async (c) => {
    const cur = (await c.query(`select * from credentials where id = $1 for update`, [up.id])).rows[0];
    if (!cur) {
      if (up.version !== 1) throw new HttpError(409, 'new credentials start at version 1');
      await c.query(
        `insert into credentials (id, app_id, label, version, ciphertext, nonce, created_by_device) values ($1, $2, $3, 1, $4, $5, $6)`,
        [up.id, up.appId, up.label, ct, nonce, deviceId],
      ).catch((e) => {
        if (e.code === '23505') throw new HttpError(409, `a credential labelled "${up.label}" already exists for ${up.appId}`);
        throw e;
      });
    } else {
      if (cur.app_id !== up.appId || cur.label !== up.label) throw new HttpError(400, 'credential app/label cannot change');
      if (up.version !== cur.version + 1) throw new HttpError(409, `version conflict: stored ${cur.version}, got ${up.version}`);
      const holder = await c.query(`select 1 from credential_keys where credential_id = $1 and device_id = $2`, [up.id, deviceId]);
      if (!holder.rowCount) throw new HttpError(403, 'only a device holding this credential can update it');
      await c.query(`update credentials set version = $2, ciphertext = $3, nonce = $4, updated_at = now() where id = $1`, [up.id, up.version, ct, nonce]);
      await c.query(`delete from credential_keys where credential_id = $1`, [up.id]);
    }
    for (const k of up.sealedKeys) {
      const sealed = Buffer.from(k.sealedDek, 'base64');
      if (sealed.length !== 80) throw new HttpError(400, 'sealed key must be crypto_box_seal of a 32-byte key');
      await c.query(`insert into credential_keys (credential_id, device_id, version, sealed_dek) values ($1, $2, $3, $4)`, [up.id, k.deviceId, up.version, sealed]);
    }
    return { version: up.version };
  });
}

export async function credentialForDevice(db: pg.Pool | pg.PoolClient, credentialId: string, deviceId: string) {
  const r = await db.query(
    `select c.id, c.app_id, c.label, c.version, c.ciphertext, c.nonce, k.sealed_dek
       from credentials c join credential_keys k on k.credential_id = c.id and k.device_id = $2
      where c.id = $1`,
    [credentialId, deviceId],
  );
  const row = r.rows[0];
  if (!row) throw new HttpError(404, 'credential not shared with this device');
  return {
    id: row.id as string,
    appId: row.app_id as string,
    label: row.label as string,
    version: row.version as number,
    ciphertext: (row.ciphertext as Buffer).toString('base64'),
    nonce: (row.nonce as Buffer).toString('base64'),
    sealedDek: (row.sealed_dek as Buffer).toString('base64'),
  };
}
