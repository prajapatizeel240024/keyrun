// HTTP surface of the control plane: auth, device enrollment, credential versioning, workflow
// editing, and the regression gate's comparison logic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ApiError, ServerClient } from '../src/agent/client.ts';
import { closeAllPools } from '../src/db/pool.ts';
import { loadWorkflow } from '../src/engine/workflows.ts';
import { compare, flatten, type Baseline } from '../src/evals/gate.ts';
import type { Summary } from '../src/evals/run.ts';
import { ADMIN, startTestServer, type TestServer } from './helpers.ts';

let server: TestServer;
before(async () => {
  server = await startTestServer({});
});
after(async () => {
  await server.close();
  await closeAllPools();
});

const fakeEnvelope = (id: string, version: number, deviceId: string) => ({
  id, appId: 'hr', label: 'admin', version,
  ciphertext: Buffer.alloc(64, version).toString('base64'), nonce: Buffer.alloc(24).toString('base64'),
  sealedKeys: [{ deviceId, sealedDek: Buffer.alloc(80).toString('base64') }],
});

test('admin API and dashboard need the admin token', async () => {
  const anon = new ServerClient(server.url);
  await assert.rejects(anon.get('/api/admin/tasks'), (e: ApiError) => e.status === 401);
  const page = await fetch(`${server.url}/`);
  assert.match(await page.text(), /Enter the admin token/);
  const login = await fetch(`${server.url}/login`, { method: 'POST', body: new URLSearchParams({ token: ADMIN }), redirect: 'manual' });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.match(cookie, /^keyrun_admin=/);
  const dash = await fetch(`${server.url}/`, { headers: { cookie } });
  assert.match(await dash.text(), /Queue a task/);
});

test('agent API needs a valid device token', async () => {
  const fake = new ServerClient(server.url, { device: { id: randomUUID(), token: 'nope' } });
  await assert.rejects(fake.post('/api/agent/claim'), (e: ApiError) => e.status === 401);
});

test('credential versions are compare-and-swap, and only holders can update', async () => {
  const pk = Buffer.alloc(32, 7).toString('base64');
  const a = await server.admin.post<{ deviceId: string; token: string }>('/api/admin/devices', { name: 'a', publicKey: pk });
  const b = await server.admin.post<{ deviceId: string; token: string }>('/api/admin/devices', { name: 'b', publicKey: pk });
  const devA = new ServerClient(server.url, { device: { id: a.deviceId, token: a.token } });
  const devB = new ServerClient(server.url, { device: { id: b.deviceId, token: b.token } });
  const id = randomUUID();
  await devA.put(`/api/agent/credentials/${id}`, fakeEnvelope(id, 1, a.deviceId));
  await assert.rejects(devA.put(`/api/agent/credentials/${id}`, fakeEnvelope(id, 3, a.deviceId)), (e: ApiError) => e.status === 409, 'skipping a version');
  await assert.rejects(devB.put(`/api/agent/credentials/${id}`, fakeEnvelope(id, 2, b.deviceId)), (e: ApiError) => e.status === 403, 'not a holder');
  await devA.put(`/api/agent/credentials/${id}`, fakeEnvelope(id, 2, a.deviceId));
  await assert.rejects(devA.put(`/api/agent/credentials/${id}`, fakeEnvelope(id, 2, a.deviceId)), (e: ApiError) => e.status === 409, 'stale write');
  await assert.rejects(devB.get(`/api/agent/credentials/${id}`), (e: ApiError) => e.status === 404, 'not shared with b');
  const bad = { ...fakeEnvelope(randomUUID(), 1, a.deviceId), nonce: 'AAAA' };
  await assert.rejects(devA.put(`/api/agent/credentials/${bad.id}`, bad), (e: ApiError) => e.status === 400, 'not an XChaCha20 envelope');
});

test('the editor validates workflows and saves new versions', async () => {
  const wf = loadWorkflow('hr', 'sign_in');
  const bad = await server.admin.post<{ ok: boolean; errors?: string[] }>('/api/admin/workflows/validate', { ...wf, steps: [{ op: 'click', target: {} }] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors!.join(), /at least one strategy/);
  const saved = await server.admin.post<{ version: number }>('/api/admin/workflows', { definition: { ...wf, description: 'edited' }, source: 'editor' });
  assert.equal(saved.version, 2);
  await assert.rejects(server.admin.post('/api/admin/workflows', { definition: { ...wf, login: 'nope' } }), (e: ApiError) => e.status === 400);
});

test('apps can only point at loopback URLs', async () => {
  await assert.rejects(server.admin.put('/api/admin/apps/hr', { name: 'HR', baseUrl: 'https://example.com/' }), (e: ApiError) => e.status === 400);
});

test('the regression gate flags any drop, missing metrics and new silent failures', () => {
  const summary = (rates: Record<string, number>, silent = 0) => ({
    overall: { rate: rates.overall, runs: 100 },
    byApp: { hr: { rate: rates.hr, runs: 50 } },
    byWorkflow: { 'hr.sign_in': { rate: rates.wf, runs: 50 } },
    byMess: rates.mess === undefined ? {} : { cookie_banner: { rate: rates.mess, runs: 20 } },
    silentFailures: silent,
  }) as unknown as Summary;
  const base: Baseline = { createdAt: '', source: '', runsPerWorkflow: 50, silentFailures: 0, rates: flatten(summary({ overall: 98, hr: 98, wf: 100, mess: 95 })) };
  assert.deepEqual(compare(base, summary({ overall: 98, hr: 98, wf: 100, mess: 95 }), 0).failures, []);
  assert.deepEqual(compare(base, summary({ overall: 99, hr: 100, wf: 100, mess: 100 }), 0).failures, [], 'improvements pass');
  assert.equal(compare(base, summary({ overall: 98, hr: 96, wf: 100, mess: 95 }), 0).failures.length, 1, 'any app drop fails');
  assert.equal(compare(base, summary({ overall: 98, hr: 96, wf: 100, mess: 95 }), 2).failures.length, 0, 'within tolerance');
  assert.equal(compare(base, summary({ overall: 98, hr: 98, wf: 100 }), 0).failures.length, 0, 'mess that did not fire is skipped');
  assert.equal(compare(base, summary({ overall: 98, hr: 98, wf: 100, mess: 95 }, 1), 0).failures.length, 1, 'silent failure fails');
});
