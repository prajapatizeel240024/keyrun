// The task queue: Postgres rows claimed with FOR UPDATE SKIP LOCKED, leased with a fencing
// token (lease_id), delivered at least once, deduplicated by idempotency key.
import type pg from 'pg';
import { withTx } from '../db/pool.ts';
import { DEFAULT_POLICY, needsApproval, PolicySchema, withinAllowedHours, type Policy } from './policy.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type TaskRow = {
  id: string;
  idempotency_key: string;
  app_id: string;
  kind: string;
  workflow_id: number;
  credential_id: string;
  target_device_id: string | null;
  params: Record<string, string>;
  status: 'pending_approval' | 'queued' | 'leased' | 'succeeded' | 'failed' | 'rejected' | 'dead';
  attempts: number;
  max_attempts: number;
  lease_id: string | null;
  lease_device_id: string | null;
  lease_expires_at: Date | null;
  not_before: Date;
  requested_by: string;
  approved_by: string | null;
  result: Record<string, unknown> | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

type Q = pg.Pool | pg.PoolClient;

export async function event(db: Q, taskId: string, type: string, extra: { deviceId?: string | null; attempt?: number; detail?: object } = {}) {
  await db.query(`insert into task_events (task_id, type, device_id, attempt, detail) values ($1, $2, $3, $4, $5)`, [
    taskId, type, extra.deviceId ?? null, extra.attempt ?? null, extra.detail ?? {},
  ]);
}

export async function appPolicy(db: Q, appId: string): Promise<Policy> {
  const r = await db.query(`select policy from apps where id = $1`, [appId]);
  if (!r.rows[0]) throw new HttpError(404, `unknown app ${appId}`);
  return PolicySchema.parse({ ...DEFAULT_POLICY, ...r.rows[0].policy });
}

/** The server must never be handed a secret, so refuse params that look like one. */
const SECRET_LIKE = /pass(word)?|secret|token|totp|otp|api[_-]?key|credential/i;

export type EnqueueInput = {
  appId: string;
  kind: string;
  params?: Record<string, string>;
  idempotencyKey: string;
  requestedBy: string;
  credentialLabel?: string;
  targetDeviceId?: string | null;
  maxAttempts?: number;
};

export async function enqueue(db: pg.Pool, input: EnqueueInput): Promise<{ task: TaskRow; deduplicated: boolean }> {
  const params = input.params ?? {};
  for (const [k, v] of Object.entries(params)) {
    if (SECRET_LIKE.test(k)) throw new HttpError(400, `param "${k}" looks like a secret; secrets live only in the device vault`);
    if (typeof v !== 'string' || v.length > 500) throw new HttpError(400, `param "${k}" must be a short string`);
  }
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new HttpError(400, 'idempotencyKey is required (≤ 200 chars)');
  return withTx(db, async (c) => {
    const policy = await appPolicy(c, input.appId);
    const wf = await c.query(`select id from workflows where app_id = $1 and kind = $2 order by version desc limit 1`, [input.appId, input.kind]);
    if (!wf.rows[0]) throw new HttpError(400, `no workflow for ${input.appId}/${input.kind}`);
    const cred = await c.query(`select id from credentials where app_id = $1 and label = $2`, [input.appId, input.credentialLabel ?? 'admin']);
    if (!cred.rows[0]) throw new HttpError(400, `no credential "${input.credentialLabel ?? 'admin'}" for ${input.appId}; add one from the device`);
    const status = needsApproval(policy, input.kind) ? 'pending_approval' : 'queued';
    const ins = await c.query(
      `insert into tasks (idempotency_key, app_id, kind, workflow_id, credential_id, target_device_id, params, status, max_attempts, requested_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (idempotency_key) do nothing
       returning *`,
      [input.idempotencyKey, input.appId, input.kind, wf.rows[0].id, cred.rows[0].id, input.targetDeviceId ?? null, params, status,
        input.maxAttempts ?? 3, input.requestedBy],
    );
    if (ins.rows[0]) {
      const task: TaskRow = ins.rows[0];
      await event(c, task.id, 'enqueued', { detail: { by: input.requestedBy, workflowId: wf.rows[0].id } });
      if (status === 'pending_approval') await event(c, task.id, 'approval_requested', { detail: { kind: input.kind } });
      return { task, deduplicated: false };
    }
    // Same key again: return the original task, unless the request is different (a client bug).
    const existing: TaskRow = (await c.query(`select * from tasks where idempotency_key = $1`, [input.idempotencyKey])).rows[0];
    const same = existing.app_id === input.appId && existing.kind === input.kind && JSON.stringify(sortKeys(existing.params)) === JSON.stringify(sortKeys(params));
    if (!same) throw new HttpError(409, 'idempotency key already used for a different request');
    return { task: existing, deduplicated: true };
  });
}

function sortKeys(o: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

export async function decide(db: pg.Pool, taskId: string, approver: string, approve: boolean, reason?: string): Promise<TaskRow> {
  return withTx(db, async (c) => {
    const t: TaskRow | undefined = (await c.query(`select * from tasks where id = $1 for update`, [taskId])).rows[0];
    if (!t) throw new HttpError(404, 'no such task');
    if (t.status !== 'pending_approval') throw new HttpError(409, `task is ${t.status}, not pending approval`);
    if (!approver) throw new HttpError(400, 'approver is required');
    if (approve && approver === t.requested_by) throw new HttpError(403, 'the requester cannot approve their own task');
    const r = await c.query(
      `update tasks set status = $2, approved_by = $3, last_error = $4, updated_at = now() where id = $1 returning *`,
      [taskId, approve ? 'queued' : 'rejected', approver, approve ? null : reason ?? 'rejected'],
    );
    await event(c, taskId, approve ? 'approved' : 'rejected', { detail: { by: approver, reason } });
    return r.rows[0];
  });
}

export type Claimed = TaskRow & { redelivery: boolean };

/**
 * Hand the next runnable task to a device: queued, or leased with an expired lease (the previous
 * holder went quiet, so this is a redelivery). Only apps inside their allowed hours, and only
 * tasks whose credential is sealed to this device.
 */
export async function claim(db: pg.Pool, deviceId: string, leaseMs: number, now = new Date()): Promise<Claimed | null> {
  const apps = (await db.query(`select id, policy from apps`)).rows;
  const open = apps.filter((a) => withinAllowedHours(PolicySchema.parse({ ...DEFAULT_POLICY, ...a.policy }), now)).map((a) => a.id);
  if (!open.length) return null;
  for (;;) {
    const claimed = await withTx(db, async (c) => {
      const pick = await c.query(
        `select t.id, t.status as prev_status, t.lease_device_id as prev_device
           from tasks t
           join credential_keys k on k.credential_id = t.credential_id and k.device_id = $1
          where t.app_id = any($2::text[])
            and t.not_before <= now()
            and (t.target_device_id is null or t.target_device_id = $1)
            and (t.status = 'queued' or (t.status = 'leased' and t.lease_expires_at < now()))
          order by t.not_before, t.created_at
          for update of t skip locked
          limit 1`,
        [deviceId, open],
      );
      const row = pick.rows[0];
      if (!row) return null;
      const t: TaskRow = (await c.query(`select * from tasks where id = $1`, [row.id])).rows[0];
      const redelivery = row.prev_status === 'leased';
      if (redelivery) await event(c, t.id, 'lease_expired', { deviceId: row.prev_device, attempt: t.attempts });
      if (t.attempts >= t.max_attempts) {
        await c.query(`update tasks set status = 'dead', lease_id = null, lease_expires_at = null, updated_at = now(),
                         last_error = coalesce(last_error, 'out of attempts') where id = $1`, [t.id]);
        await event(c, t.id, 'dead', { attempt: t.attempts, detail: { reason: 'max attempts reached' } });
        return 'skip' as const;
      }
      const upd = await c.query(
        `update tasks set status = 'leased', lease_id = gen_random_uuid(), lease_device_id = $2,
                lease_expires_at = now() + ($3::int * interval '1 millisecond'), attempts = attempts + 1, updated_at = now()
          where id = $1 returning *`,
        [t.id, deviceId, leaseMs],
      );
      const leased: TaskRow = upd.rows[0];
      await event(c, t.id, 'leased', { deviceId, attempt: leased.attempts, detail: { leaseMs, redelivery } });
      return { ...leased, redelivery };
    });
    if (claimed !== 'skip') return claimed;
  }
}

export async function heartbeat(db: pg.Pool, taskId: string, deviceId: string, leaseId: string, leaseMs: number): Promise<Date> {
  const r = await db.query(
    `update tasks set lease_expires_at = now() + ($4::int * interval '1 millisecond'), updated_at = now()
      where id = $1 and lease_device_id = $2 and lease_id = $3 and status = 'leased' returning lease_expires_at`,
    [taskId, deviceId, leaseId, leaseMs],
  );
  if (!r.rows[0]) throw new HttpError(409, 'lease lost');
  return r.rows[0].lease_expires_at;
}

export type Report = {
  status: 'succeeded' | 'noop' | 'failed';
  message: string;
  durationMs?: number;
  failure?: { reason: string; retryable: boolean; detail?: string };
  replayed?: boolean;
  credentialVersion?: number;
};

/** Accept a result only from the current lease holder (fencing). Failed attempts may be retried. */
export async function complete(db: pg.Pool, taskId: string, deviceId: string, leaseId: string, report: Report): Promise<TaskRow> {
  const out = await withTx(db, async (c) => {
    const t: TaskRow | undefined = (await c.query(`select * from tasks where id = $1 for update`, [taskId])).rows[0];
    if (!t) throw new HttpError(404, 'no such task');
    if (t.status !== 'leased' || t.lease_id !== leaseId || t.lease_device_id !== deviceId) return 'stale' as const;
    const result = { outcome: report.status, message: report.message.slice(0, 500), durationMs: report.durationMs, replayed: !!report.replayed,
      failure: report.failure, credentialVersion: report.credentialVersion };
    let next: TaskRow;
    if (report.status !== 'failed') {
      next = (await c.query(
        `update tasks set status = 'succeeded', result = $2, last_error = null, lease_id = null, lease_expires_at = null, updated_at = now()
          where id = $1 returning *`, [taskId, result])).rows[0];
      await event(c, taskId, report.status === 'noop' ? 'noop' : 'succeeded', { deviceId, attempt: t.attempts, detail: { message: result.message, replayed: result.replayed } });
    } else if (report.failure?.retryable && t.attempts < t.max_attempts) {
      const delayMs = 5_000 * 2 ** (t.attempts - 1);
      next = (await c.query(
        `update tasks set status = 'queued', result = $2, last_error = $3, lease_id = null, lease_expires_at = null,
                not_before = now() + ($4::int * interval '1 millisecond'), updated_at = now()
          where id = $1 returning *`, [taskId, result, report.failure.reason, delayMs])).rows[0];
      await event(c, taskId, 'failed', { deviceId, attempt: t.attempts, detail: report.failure });
      await event(c, taskId, 'retry_scheduled', { detail: { inMs: delayMs } });
    } else {
      next = (await c.query(
        `update tasks set status = 'failed', result = $2, last_error = $3, lease_id = null, lease_expires_at = null, updated_at = now()
          where id = $1 returning *`, [taskId, result, report.failure?.reason ?? 'failed'])).rows[0];
      await event(c, taskId, 'failed', { deviceId, attempt: t.attempts, detail: report.failure ?? {} });
    }
    return next;
  });
  if (out === 'stale') {
    // Recorded outside the transaction so the rejection itself shows up in the task history.
    await event(db, taskId, 'stale_report_rejected', { deviceId, detail: { status: report.status } });
    throw new HttpError(409, 'stale lease: this task was handed to someone else or already finished');
  }
  return out;
}

/** Give a lease back without using up an attempt (e.g. the device saw the policy window closed). */
export async function release(db: pg.Pool, taskId: string, deviceId: string, leaseId: string, reason: string, retryInMs = 60_000) {
  return withTx(db, async (c) => {
    const r = await c.query(
      `update tasks set status = 'queued', lease_id = null, lease_expires_at = null, attempts = greatest(attempts - 1, 0),
              not_before = now() + ($4::int * interval '1 millisecond'), updated_at = now()
        where id = $1 and lease_device_id = $2 and lease_id = $3 and status = 'leased' returning *`,
      [taskId, deviceId, leaseId, retryInMs],
    );
    if (!r.rows[0]) throw new HttpError(409, 'lease lost');
    await event(c, taskId, 'released', { deviceId, detail: { reason } });
    return r.rows[0] as TaskRow;
  });
}
