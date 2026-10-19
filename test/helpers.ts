// Shared test plumbing. Tests use the keyrun_test database for the control plane (wiped per
// file) and isolated tenants in keyrun_mocks. Temp files go to the OS temp dir and are removed.
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { b64, newDeviceKeys, sodiumReady } from '../src/crypto/envelope.ts';
import { config, HOST } from '../src/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { pool } from '../src/db/pool.ts';
import { ensureDatabase } from '../src/db/setup.ts';
import { APP_NAMES } from '../src/mocks/index.ts';
import { APP_IDS, type AppId } from '../src/mocks/mess.ts';
import { buildServer, type ServerOptions } from '../src/server/app.ts';
import { syncRepoWorkflows, upsertApp } from '../src/server/store.ts';
import { saveIdentity, type DeviceIdentity } from '../src/agent/home.ts';
import { ServerClient } from '../src/agent/client.ts';

export const ADMIN = 'test-admin-token';

export async function freshControlDb() {
  await ensureDatabase(config.testDatabaseUrl);
  await migrate(config.testDatabaseUrl, 'control');
  const db = pool(config.testDatabaseUrl);
  await db.query(`truncate task_events, tasks, credential_keys, credentials, workflows, devices, apps restart identity cascade`);
  return db;
}

export async function tempDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), `keyrun-${prefix}-`));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export type TestServer = { url: string; db: ReturnType<typeof pool>; admin: ServerClient; close: () => Promise<void> };

/** Control plane on a free port, with the three apps registered at the given origins/tenants. */
export async function startTestServer(
  baseUrls: Partial<Record<AppId, string>>,
  opts: Partial<ServerOptions> = {},
): Promise<TestServer> {
  const db = await freshControlDb();
  for (const app of APP_IDS) {
    await upsertApp(db, { id: app, name: APP_NAMES[app], baseUrl: baseUrls[app] ?? `http://${HOST}:1/t/none`, policy: { requireApproval: [] } });
  }
  await syncRepoWorkflows(db);
  const server: Server = await new Promise((resolve) => {
    const s = buildServer({ db, adminToken: ADMIN, leaseMs: 60_000, ...opts }).listen(0, HOST, () => resolve(s));
  });
  const url = `http://${HOST}:${(server.address() as AddressInfo).port}`;
  return {
    url,
    db,
    admin: new ServerClient(url, { adminToken: ADMIN }),
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

/** Enroll a device the way `npm run agent -- enroll` does and write its identity to `home`. */
export async function enrollDevice(server: TestServer, home: string, name = 'test-laptop'): Promise<DeviceIdentity> {
  await sodiumReady();
  const keys = newDeviceKeys();
  const { deviceId, token } = await server.admin.post<{ deviceId: string; token: string }>('/api/admin/devices', { name, publicKey: b64.enc(keys.publicKey) });
  const id: DeviceIdentity = { deviceId, token, name, serverUrl: server.url, publicKey: b64.enc(keys.publicKey), privateKey: b64.enc(keys.privateKey) };
  await saveIdentity(home, id);
  return id;
}

/** Minimal ZIP reader (stored + deflate), enough to look inside Playwright trace files. */
export function unzipEntries(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Every way a secret could plausibly be written down: raw, URL-encoded, JSON-escaped, hex, base64. */
export function encodings(secret: string): string[] {
  const b = Buffer.from(secret, 'utf8');
  return [...new Set([
    secret,
    encodeURIComponent(secret), // form posts and query strings
    JSON.stringify(secret).slice(1, -1), // inside JSON
    b.toString('hex'),
    b.toString('base64').replace(/=+$/, ''),
    b.toString('base64url'),
  ])];
}
