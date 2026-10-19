// Queue semantics without a browser: idempotency keys, approvals, allowed hours, leases,
// redelivery, fencing, retries.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { closeAllPools } from '../src/db/pool.ts';
import { claim, complete, decide, enqueue, heartbeat, HttpError, release } from '../src/server/queue.ts';
import { withinAllowedHours } from '../src/server/policy.ts';
import { freshControlDb, startTestServer, type TestServer } from './helpers.ts';

let server: TestServer;
let deviceA: string;
let deviceB: string;
let credId: string;

async function addDeviceAndCredential() {
  const db = server.db;
  deviceA = randomUUID();
  deviceB = randomUUID();
  for (const d of [deviceA, deviceB]) {
    await db.query(`insert into devices (id, name, public_key, token_hash) values ($1, $2, $3, $4)`, [d, d.slice(0, 4), Buffer.alloc(32), Buffer.alloc(32)]);
  }
  credId = randomUUID();
  await db.query(`insert into credentials (id, app_id, label, version, ciphertext, nonce) values ($1, 'hr', 'admin', 1, $2, $3)`, [credId, Buffer.alloc(40, 1), Buffer.alloc(24)]);
  for (const d of [deviceA, deviceB]) {
    await db.query(`insert into credential_keys (credential_id, device_id, version, sealed_dek) values ($1, $2, 1, $3)`, [credId, d, Buffer.alloc(80)]);
  }
}

before(async () => {
  server = await startTestServer({ hr: 'http://127.0.0.1:4101/t/x' });
});
beforeEach(async () => {
  await freshControlDb();
  await server.db.query(`insert into apps (id, name, base_url, policy) values ('hr', 'Mock HR', 'http://127.0.0.1:4101/t/x', '{"requireApproval": []}')`);
  const { syncRepoWorkflows } = await import('../src/server/store.ts');
  await syncRepoWorkflows(server.db);
  await addDeviceAndCredential();
});
after(async () => {
  await server.close();
  await closeAllPools();
});

const base = { appId: 'hr', kind: 'remove_user', params: { email: 'a@example.test' }, requestedBy: 'alex' };

test('the same idempotency key returns the same task instead of a duplicate', async () => {
  const a = await enqueue(server.db, { ...base, idempotencyKey: 'k1' });
  const b = await enqueue(server.db, { ...base, idempotencyKey: 'k1' });
  assert.equal(a.deduplicated, false);
  assert.equal(b.deduplicated, true);
  assert.equal(a.task.id, b.task.id);
  const n = (await server.db.query(`select count(*)::int as n from tasks`)).rows[0].n;
  assert.equal(n, 1);
});

test('reusing a key for a different request is refused', async () => {
  await enqueue(server.db, { ...base, idempotencyKey: 'k1' });
  await assert.rejects(enqueue(server.db, { ...base, params: { email: 'b@example.test' }, idempotencyKey: 'k1' }), (e: HttpError) => e.status === 409);
});

test('the server refuses params that look like secrets', async () => {
  await assert.rejects(enqueue(server.db, { ...base, params: { password: 'x' }, idempotencyKey: 'k2' }), (e: HttpError) => e.status === 400);
  await assert.rejects(enqueue(server.db, { ...base, params: { totp_code: '123456' }, idempotencyKey: 'k3' }), (e: HttpError) => e.status === 400);
});

test('admin tasks wait for approval from someone other than the requester', async () => {
  await server.db.query(`update apps set policy = '{"requireApproval": ["remove_user"]}' where id = 'hr'`);
  const { task } = await enqueue(server.db, { ...base, idempotencyKey: 'k4' });
  assert.equal(task.status, 'pending_approval');
  assert.equal(await claim(server.db, deviceA, 10_000), null, 'not claimable before approval');
  await assert.rejects(decide(server.db, task.id, 'alex', true), (e: HttpError) => e.status === 403);
  const approved = await decide(server.db, task.id, 'sam', true);
  assert.equal(approved.status, 'queued');
  assert.equal(approved.approved_by, 'sam');
  assert.ok(await claim(server.db, deviceA, 10_000));
});

test('rejected tasks never run', async () => {
  await server.db.query(`update apps set policy = '{"requireApproval": ["remove_user"]}' where id = 'hr'`);
  const { task } = await enqueue(server.db, { ...base, idempotencyKey: 'k5' });
  await decide(server.db, task.id, 'sam', false, 'wrong person');
  assert.equal(await claim(server.db, deviceA, 10_000), null);
});

test('tasks are only handed out inside the allowed hours', async () => {
  await server.db.query(`update apps set policy = '{"requireApproval": [], "timezone": "UTC", "allowedHours": {"start": "09:00", "end": "17:00", "days": [1,2,3,4,5]}}' where id = 'hr'`);
  await enqueue(server.db, { ...base, idempotencyKey: 'k6' });
  assert.equal(await claim(server.db, deviceA, 10_000, new Date('2026-10-17T12:00:00Z')), null, 'Saturday noon UTC');
  assert.equal(await claim(server.db, deviceA, 10_000, new Date('2026-10-19T08:59:00Z')), null, 'Monday before 09:00');
  assert.ok(await claim(server.db, deviceA, 10_000, new Date('2026-10-19T09:00:00Z')), 'Monday 09:00');
});

test('allowed-hours math handles time zones and overnight windows', () => {
  const p = { timezone: 'America/New_York', allowedHours: { start: '22:00', end: '06:00' }, requireApproval: [] };
  assert.equal(withinAllowedHours(p, new Date('2026-10-20T03:30:00Z')), true, '23:30 New York');
  assert.equal(withinAllowedHours(p, new Date('2026-10-20T09:30:00Z')), true, '05:30 New York');
  assert.equal(withinAllowedHours(p, new Date('2026-10-20T16:00:00Z')), false, '12:00 New York');
});

test('an expired lease is redelivered, and the old holder can no longer report', async () => {
  const { task } = await enqueue(server.db, { ...base, idempotencyKey: 'k7' });
  const first = (await claim(server.db, deviceA, 50))!;
  assert.equal(first.attempts, 1);
  assert.equal(await claim(server.db, deviceB, 50), null, 'leased tasks are not handed out twice');
  await new Promise((r) => setTimeout(r, 120));
  const second = (await claim(server.db, deviceB, 10_000))!;
  assert.equal(second.id, task.id);
  assert.equal(second.attempts, 2);
  assert.equal(second.redelivery, true);
  // Device A wakes up late: its report is fenced off by the new lease id.
  await assert.rejects(complete(server.db, task.id, deviceA, first.lease_id!, { status: 'succeeded', message: 'late' }), (e: HttpError) => e.status === 409);
  await assert.rejects(heartbeat(server.db, task.id, deviceA, first.lease_id!, 10_000), (e: HttpError) => e.status === 409);
  const done = await complete(server.db, task.id, deviceB, second.lease_id!, { status: 'succeeded', message: 'ok' });
  assert.equal(done.status, 'succeeded');
  const types = (await server.db.query(`select type from task_events where task_id = $1 order by id`, [task.id])).rows.map((r) => r.type);
  assert.deepEqual(types, ['enqueued', 'leased', 'lease_expired', 'leased', 'stale_report_rejected', 'succeeded']);
});

test('heartbeats keep a long run leased', async () => {
  const { task } = await enqueue(server.db, { ...base, idempotencyKey: 'k8' });
  const c = (await claim(server.db, deviceA, 150))!;
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 80));
    await heartbeat(server.db, task.id, deviceA, c.lease_id!, 150);
  }
  assert.equal(await claim(server.db, deviceB, 150), null, 'still leased after 320 ms thanks to heartbeats');
});

test('retryable failures are retried with backoff, then fail for good', async () => {
  const { task } = await enqueue(server.db, { ...base, idempotencyKey: 'k9', maxAttempts: 2 });
  let c = (await claim(server.db, deviceA, 10_000))!;
  let t = await complete(server.db, task.id, deviceA, c.lease_id!, { status: 'failed', message: 'x', failure: { reason: 'element_not_found', retryable: true } });
  assert.equal(t.status, 'queued');
  assert.ok(new Date(t.not_before).getTime() > Date.now() + 3_000, 'backs off before the retry');
  await server.db.query(`update tasks set not_before = now() where id = $1`, [task.id]);
  c = (await claim(server.db, deviceA, 10_000))!;
  t = await complete(server.db, task.id, deviceA, c.lease_id!, { status: 'failed', message: 'x', failure: { reason: 'element_not_found', retryable: true } });
  assert.equal(t.status, 'failed', 'out of attempts');
});

test('a task whose device keeps vanishing ends up dead, not looping forever', async () => {
  const { task } = await enqueue(server.db, { ...base, idempotencyKey: 'k10', maxAttempts: 2 });
  await claim(server.db, deviceA, 20);
  await new Promise((r) => setTimeout(r, 40));
  await claim(server.db, deviceA, 20);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(await claim(server.db, deviceA, 20), null);
  const t = (await server.db.query(`select status from tasks where id = $1`, [task.id])).rows[0];
  assert.equal(t.status, 'dead');
});

test('releasing a lease does not burn an attempt', async () => {
  const { task } = await enqueue(server.db, { ...base, idempotencyKey: 'k11' });
  const c = (await claim(server.db, deviceA, 10_000))!;
  const r = await release(server.db, task.id, deviceA, c.lease_id!, 'outside allowed hours', 0);
  assert.equal(r.status, 'queued');
  assert.equal(r.attempts, 0);
});

test('only devices holding the credential can claim its tasks', async () => {
  const stranger = randomUUID();
  await server.db.query(`insert into devices (id, name, public_key, token_hash) values ($1, 'stranger', $2, $3)`, [stranger, Buffer.alloc(32), Buffer.alloc(32)]);
  await enqueue(server.db, { ...base, idempotencyKey: 'k12' });
  assert.equal(await claim(server.db, stranger, 10_000), null);
  assert.ok(await claim(server.db, deviceA, 10_000));
});
