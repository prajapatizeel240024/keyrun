// End to end: control plane + local agent + mock apps. Proves at-least-once delivery never makes
// a task act twice, including when the device dies at the worst possible moment.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { Agent, type AgentHooks } from '../src/agent/agent.ts';
import { deviceKeys, loadIdentity } from '../src/agent/home.ts';
import { ServerClient } from '../src/agent/client.ts';
import { decryptEnvelope, setCredential, type CredentialEnvelope } from '../src/agent/vault.ts';
import { closeAllPools } from '../src/db/pool.ts';
import { activeUsersByEmail, adminPasswordIs, auditCount } from '../src/mocks/answer-key.ts';
import type { CreatedTenant } from '../src/mocks/core.ts';
import { startMocks, type MockApps } from '../src/mocks/index.ts';
import { calmMess, type AppId } from '../src/mocks/mess.ts';
import { encodings, enrollDevice, startTestServer, tempDir, type TestServer } from './helpers.ts';

let mocks: MockApps;
let browser: Browser;
let server: TestServer;
let home: { dir: string; cleanup: () => Promise<void> };
let tenants: Record<AppId, CreatedTenant>;

const users = [
  { email: 'ada.laine@example.test', name: 'Ada Laine', role: 'Employee' },
  { email: 'leaving.soon@example.test', name: 'Leaving Soon', role: 'Employee' },
];

before(async () => {
  mocks = await startMocks();
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await mocks.close();
  await closeAllPools();
});

beforeEach(async () => {
  tenants = {
    hr: await mocks.createTenant('hr', { mess: calmMess({ iframeLogin: true, randomIds: true }), users }),
    helpdesk: await mocks.createTenant('helpdesk', { mess: calmMess({ totp: true }), users }),
    directory: await mocks.createTenant('directory', { mess: calmMess({ iframeLogin: true, totp: true }), users }),
  };
  server = await startTestServer({ hr: tenants.hr.baseUrl, helpdesk: tenants.helpdesk.baseUrl, directory: tenants.directory.baseUrl }, { leaseMs: 1500 });
  home = await tempDir('agent');
  const id = await enrollDevice(server, home.dir);
  const device = new ServerClient(server.url, { device: { id: id.deviceId, token: id.token } });
  for (const app of ['hr', 'helpdesk', 'directory'] as const) {
    const t = tenants[app];
    await setCredential(device, { deviceId: id.deviceId, keys: deviceKeys(id) }, app, 'admin', {
      username: t.admin.email, password: t.admin.password, totpSecret: t.admin.totpSecret ?? undefined, allowedOrigins: [new URL(t.baseUrl).origin],
    });
  }
});
afterEach(async () => {
  await server.close();
  await home.cleanup();
});

function agent(hooks: AgentHooks = {}) {
  return new Agent({ home: home.dir, serverUrl: server.url, browser, hooks, log: () => {}, artifactsDir: `${home.dir}/artifacts` }).init();
}

async function task(id: string) {
  return server.admin.get<{ task: { status: string; attempts: number; result: { outcome: string; replayed: boolean; credentialVersion?: number } }; events: Array<{ type: string }> }>(`/api/admin/tasks/${id}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a queued task runs on the device and changes the real app', async () => {
  const { task: t } = await server.admin.post<{ task: { id: string } }>('/api/admin/tasks', {
    app: 'helpdesk', kind: 'create_user', params: { email: 'noor@example.test', name: 'Noor T', role: 'Agent' }, idempotencyKey: 'e2e-1', requestedBy: 'alex',
  });
  const a = await agent();
  assert.equal(await a.runOnce(), 'done');
  const d = await task(t.id);
  assert.equal(d.task.status, 'succeeded');
  assert.deepEqual(d.events.map((e) => e.type), ['enqueued', 'leased', 'succeeded']);
  assert.equal((await activeUsersByEmail('helpdesk', tenants.helpdesk.tenantId, 'noor@example.test')).length, 1);
  assert.equal(await a.runOnce(), 'idle');
});

test('device dies after acting but before reporting: the redelivered task does not act twice', async () => {
  // HR allows duplicate people, so acting twice would be visible in its database.
  const { task: t } = await server.admin.post<{ task: { id: string } }>('/api/admin/tasks', {
    app: 'hr', kind: 'create_user', params: { email: 'new.hire@example.test', name: 'New Hire', role: 'Manager' }, idempotencyKey: 'e2e-2', requestedBy: 'alex',
  });
  assert.equal(await (await agent({ crashAt: 'after_act' })).runOnce(), 'crashed');
  assert.equal((await task(t.id)).task.status, 'leased', 'nobody reported');
  await sleep(1700); // lease (1.5 s) expires
  let browserRuns = 0;
  const b = await agent({ onBrowserRun: () => browserRuns++ });
  assert.equal(await b.runOnce(), 'done');
  const d = await task(t.id);
  assert.equal(d.task.status, 'succeeded');
  assert.equal(d.task.attempts, 2);
  assert.ok(d.events.some((e) => e.type === 'lease_expired'));
  assert.equal(browserRuns, 1, 'the retry re-checked the app');
  assert.equal(d.task.result.outcome, 'noop', 'and found the person already there');
  assert.equal((await activeUsersByEmail('hr', tenants.hr.tenantId, 'new.hire@example.test')).length, 1);
  assert.equal(await auditCount('hr', tenants.hr.tenantId, 'user.create'), 1);
});

test('device dies after journaling but before reporting: the retry is answered from the journal without a browser', async () => {
  const { task: t } = await server.admin.post<{ task: { id: string } }>('/api/admin/tasks', {
    app: 'hr', kind: 'remove_user', params: { email: 'leaving.soon@example.test' }, idempotencyKey: 'e2e-3', requestedBy: 'alex',
  });
  assert.equal(await (await agent({ crashAt: 'after_journal_done' })).runOnce(), 'crashed');
  await sleep(1700);
  let browserRuns = 0;
  const b = await agent({ onBrowserRun: () => browserRuns++ });
  assert.equal(await b.runOnce(), 'replayed');
  assert.equal(browserRuns, 0);
  const d = await task(t.id);
  assert.equal(d.task.status, 'succeeded');
  assert.equal(d.task.result.replayed, true);
  assert.equal(await auditCount('hr', tenants.hr.tenantId, 'user.remove'), 1);
});

test('password rotation interrupted after the change: the retry confirms it and rotates exactly once', async () => {
  const { task: t } = await server.admin.post<{ task: { id: string } }>('/api/admin/tasks', {
    app: 'directory', kind: 'rotate_password', params: {}, idempotencyKey: 'e2e-4', requestedBy: 'alex',
  });
  // The worst moment: the app has the new password, the vault still has the old one.
  assert.equal(await (await agent({ crashAt: 'after_browser' })).runOnce(), 'crashed');
  await sleep(1700);
  const purposes: string[] = [];
  const b = await agent({ onBrowserRun: (p) => purposes.push(p) });
  assert.equal(await b.runOnce(), 'done');
  assert.deepEqual(purposes, ['verify'], 'signed in with the new password instead of rotating again');
  const d = await task(t.id);
  assert.equal(d.task.status, 'succeeded');
  assert.equal(await auditCount('directory', tenants.directory.tenantId, 'password.change'), 1);
  // The vault now holds v2, and v2 is the password the app accepts.
  const id = await loadIdentity(home.dir);
  const device = new ServerClient(server.url, { device: { id: id.deviceId, token: id.token } });
  const creds = await device.get<Array<{ id: string; app_id: string; version: number }>>('/api/agent/credentials');
  const dir = creds.find((c) => c.app_id === 'directory')!;
  assert.equal(dir.version, 2);
  const secret = await decryptEnvelope(await device.get<CredentialEnvelope>(`/api/agent/credentials/${dir.id}`), deviceKeys(id));
  assert.notEqual(secret.password, tenants.directory.admin.password);
  assert.equal(await adminPasswordIs('directory', tenants.directory.tenantId, secret.password), true);
  // The journal held the new password across the crash, but only sealed to the device key.
  const journal = await readFile(path.join(home.dir, 'journal.jsonl'), 'utf8');
  assert.match(journal, /"pending"/);
  for (const s of [secret.password, tenants.directory.admin.password]) for (const enc of encodings(s)) assert.ok(!journal.includes(enc));
});

test('a failed attempt is retried for real, not replayed from the journal', async () => {
  const { task: t } = await server.admin.post<{ task: { id: string; workflow_id: number } }>('/api/admin/tasks', {
    app: 'helpdesk', kind: 'create_user', params: { email: 'second.try@example.test', name: 'Second Try', role: 'Agent' }, idempotencyKey: 'e2e-7', requestedBy: 'alex',
  });
  // Break this task's pinned workflow version so attempt 1 fails before it changes anything.
  const original = (await server.db.query(`select definition from workflows where id = $1`, [t.workflow_id])).rows[0].definition;
  const broken = { ...original, steps: [{ op: 'click', target: { role: { role: 'button', name: 'No such button' } }, timeoutMs: 600 }] };
  await server.db.query(`update workflows set definition = $2 where id = $1`, [t.workflow_id, broken]);
  const a = await agent();
  assert.equal(await a.runOnce(), 'done');
  assert.equal((await task(t.id)).task.status, 'queued', 'retryable failure goes back in the queue');
  await server.db.query(`update workflows set definition = $2 where id = $1`, [t.workflow_id, original]);
  await server.db.query(`update tasks set not_before = now() where id = $1`, [t.id]);
  let browserRuns = 0;
  const b = await agent({ onBrowserRun: () => browserRuns++ });
  assert.equal(await b.runOnce(), 'done');
  assert.equal(browserRuns, 1);
  const d = await task(t.id);
  assert.equal(d.task.status, 'succeeded');
  assert.equal(d.task.attempts, 2);
  assert.equal((await activeUsersByEmail('helpdesk', tenants.helpdesk.tenantId, 'second.try@example.test')).length, 1);
});

test('a later sign-in uses the rotated password from the vault', async () => {
  await server.admin.post('/api/admin/tasks', { app: 'hr', kind: 'rotate_password', params: {}, idempotencyKey: 'e2e-5a', requestedBy: 'alex' });
  const a = await agent();
  assert.equal(await a.runOnce(), 'done');
  const { task: t } = await server.admin.post<{ task: { id: string } }>('/api/admin/tasks', { app: 'hr', kind: 'sign_in', params: {}, idempotencyKey: 'e2e-5b', requestedBy: 'alex' });
  assert.equal(await a.runOnce(), 'done');
  assert.equal((await task(t.id)).task.status, 'succeeded');
});

test('the device refuses to use a credential on an origin it was not bound to', async () => {
  // A compromised server repoints the app at another origin to harvest the password.
  await server.db.query(`update apps set base_url = $1 where id = 'hr'`, [`${mocks.origins.helpdesk}/t/${tenants.helpdesk.tenantId}`]);
  const { task: t } = await server.admin.post<{ task: { id: string } }>('/api/admin/tasks', { app: 'hr', kind: 'sign_in', params: {}, idempotencyKey: 'e2e-6', requestedBy: 'alex' });
  let browserRuns = 0;
  assert.equal(await (await agent({ onBrowserRun: () => browserRuns++ })).runOnce(), 'done');
  const d = await task(t.id);
  assert.equal(d.task.status, 'failed');
  assert.equal(browserRuns, 0, 'never opened a browser');
});
