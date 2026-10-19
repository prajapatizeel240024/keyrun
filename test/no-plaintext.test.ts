// The core promise: the server never sees a credential. We run real work through the whole
// system (enroll, add credentials, sign in, rotate passwords, fail a task), then:
//   1. scan every column of every row of every table in the control-plane database, and
//   2. scan every request body the server received,
// for each secret in every plausible encoding.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { Agent } from '../src/agent/agent.ts';
import { ServerClient } from '../src/agent/client.ts';
import { deviceKeys, loadIdentity } from '../src/agent/home.ts';
import { decryptEnvelope, setCredential, type CredentialEnvelope } from '../src/agent/vault.ts';
import { closeAllPools } from '../src/db/pool.ts';
import { startMocks, type MockApps } from '../src/mocks/index.ts';
import { calmMess, type AppId } from '../src/mocks/mess.ts';
import { encodings, enrollDevice, startTestServer, tempDir, type TestServer } from './helpers.ts';

let mocks: MockApps;
let browser: Browser;
let server: TestServer;
let home: { dir: string; cleanup: () => Promise<void> };
const bodies: string[] = [];
const secrets: string[] = [];

before(async () => {
  mocks = await startMocks();
  browser = await chromium.launch();
  const tenants = {
    hr: await mocks.createTenant('hr', { mess: calmMess({ iframeLogin: true }), users: [{ email: 'x.y@example.test', name: 'X Y', role: 'Employee' }] }),
    helpdesk: await mocks.createTenant('helpdesk', { mess: calmMess({ totp: true }), users: [] }),
    directory: await mocks.createTenant('directory', { mess: calmMess({ iframeLogin: true, totp: true }), users: [] }),
  };
  server = await startTestServer(
    { hr: tenants.hr.baseUrl, helpdesk: tenants.helpdesk.baseUrl, directory: tenants.directory.baseUrl },
    { onRequestBody: (_path, body) => bodies.push(JSON.stringify(body ?? null)) },
  );
  home = await tempDir('agent');
  const id = await enrollDevice(server, home.dir);
  const device = new ServerClient(server.url, { device: { id: id.deviceId, token: id.token } });
  for (const app of Object.keys(tenants) as AppId[]) {
    const t = tenants[app];
    secrets.push(t.admin.email, t.admin.password);
    if (t.admin.totpSecret) secrets.push(t.admin.totpSecret);
    await setCredential(device, { deviceId: id.deviceId, keys: deviceKeys(id) }, app, 'admin', {
      username: t.admin.email, password: t.admin.password, totpSecret: t.admin.totpSecret ?? undefined, allowedOrigins: [new URL(t.baseUrl).origin],
    });
  }

  // Real work: sign-ins, two password rotations (new passwords are born on the device), one
  // user removal, and one task that fails (failure details are the riskiest thing we send).
  const q = (app: AppId, kind: string, params: Record<string, string> = {}) =>
    server.admin.post('/api/admin/tasks', { app, kind, params, idempotencyKey: `${app}-${kind}`, requestedBy: 'alex' });
  await q('hr', 'sign_in');
  await q('hr', 'rotate_password');
  await q('directory', 'rotate_password');
  await q('helpdesk', 'sign_in');
  await q('hr', 'remove_user', { email: 'x.y@example.test' });
  await server.db.query(`update workflows set definition = jsonb_set(definition, '{steps}', '[{"op":"assert","target":{"text":"never there"},"timeoutMs":800}]') where app_id = 'directory' and kind = 'sign_in'`);
  await q('directory', 'sign_in');
  const agent = await new Agent({ home: home.dir, serverUrl: server.url, browser, log: () => {}, artifactsDir: `${home.dir}/artifacts` }).init();
  while ((await agent.runOnce()) !== 'idle');

  // The rotated passwords exist only on the device; decrypt them here to know what to look for.
  const me = await loadIdentity(home.dir);
  for (const c of await device.get<Array<{ id: string }>>('/api/agent/credentials')) {
    const s = await decryptEnvelope(await device.get<CredentialEnvelope>(`/api/agent/credentials/${c.id}`), deviceKeys(me));
    if (!secrets.includes(s.password)) secrets.push(s.password);
  }
});

after(async () => {
  await server.close();
  await home.cleanup();
  await browser.close();
  await mocks.close();
  await closeAllPools();
});

test('the work actually happened (so the scan below means something)', async () => {
  const rows = (await server.db.query(`select kind, app_id, status from tasks order by created_at`)).rows;
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((r) => r.status === 'succeeded').length, 5);
  assert.ok(rows.some((r) => r.app_id === 'directory' && r.kind === 'sign_in' && (r.status === 'failed' || r.status === 'queued')));
  const versions = (await server.db.query(`select app_id, version from credentials order by app_id`)).rows;
  assert.deepEqual(versions, [{ app_id: 'directory', version: 2 }, { app_id: 'helpdesk', version: 1 }, { app_id: 'hr', version: 2 }]);
  assert.equal(secrets.length, 10, '3 usernames, 3 passwords, 2 TOTP seeds, 2 rotated passwords (new values)');
});

test('no table in the control-plane database holds any secret, in any encoding', async () => {
  const tables = (await server.db.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)).rows.map((r) => r.table_name);
  assert.ok(tables.includes('credentials') && tables.includes('tasks') && tables.includes('task_events'));
  let scannedRows = 0;
  for (const table of tables) {
    const rows = (await server.db.query(`select row_to_json(t)::text as j from "${table}" t`)).rows;
    for (const { j } of rows) {
      scannedRows++;
      for (const s of secrets) for (const enc of encodings(s)) assert.ok(!j.includes(enc), `${table} contains a secret (${enc.slice(0, 4)}…)`);
    }
  }
  assert.ok(scannedRows > 30, `scanned ${scannedRows} rows`);
});

test('no request the server received carried a secret', () => {
  assert.ok(bodies.length > 20);
  for (const b of bodies) for (const s of secrets) for (const enc of encodings(s)) assert.ok(!b.includes(enc), 'a request body contained a secret');
});

test('what the server does hold is ciphertext of the right shape', async () => {
  const rows = (await server.db.query(`select octet_length(ciphertext) as ct, octet_length(nonce) as n from credentials`)).rows;
  for (const r of rows) {
    assert.equal(r.n, 24);
    assert.ok(r.ct > 40);
  }
  const keys = (await server.db.query(`select octet_length(sealed_dek) as k from credential_keys`)).rows;
  for (const k of keys) assert.equal(k.k, 80);
});
