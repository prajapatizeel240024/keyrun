// Control plane HTTP API, dashboard and workflow editor. It queues work and stores ciphertext;
// it never sees a password, and it never runs a browser.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import type pg from 'pg';
import { validateWorkflow } from '../engine/schema.ts';
import { eventsToWorkflow } from '../recorder/to-workflow.ts';
import { guessBaseUrl } from '../recorder/base-url.ts';
import { claim, complete, decide, enqueue, heartbeat, HttpError, release, type TaskRow } from './queue.ts';
import { DEFAULT_POLICY, describeWindow, PolicySchema, withinAllowedHours } from './policy.ts';
import { authenticateDevice, credentialForDevice, enrollDevice, putCredential, saveWorkflow, setPolicy, upsertApp } from './store.ts';
import { assertLoopbackUrl } from '../config.ts';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');

export type ServerOptions = {
  db: pg.Pool;
  adminToken: string;
  leaseMs?: number;
  /** Test hook: sees every request body the server receives. */
  onRequestBody?: (path: string, body: unknown) => void;
};

const digest = (s: string) => createHash('sha256').update(s).digest();

export function buildServer(opts: ServerOptions): express.Express {
  const { db } = opts;
  const leaseMs = opts.leaseMs ?? 60_000;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    opts.onRequestBody?.(req.path, req.body);
    next();
  });

  // ---------- admin auth (dashboard + editor) ----------
  const isAdmin = (req: Request) => {
    const cookie = /(?:^|;\s*)keyrun_admin=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const given = (req.headers['x-keyrun-admin'] as string | undefined) ?? (cookie ? decodeURIComponent(cookie) : undefined);
    return !!given && timingSafeEqual(digest(given), digest(opts.adminToken));
  };
  const admin = (req: Request, _res: Response, next: NextFunction) => {
    if (!isAdmin(req)) throw new HttpError(401, 'admin token required');
    next();
  };
  const page = (file: string) => (req: Request, res: Response) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
    res.type('html').send(readFileSync(path.join(UI, isAdmin(req) ? file : 'login.html'), 'utf8'));
  };
  app.get('/', page('dashboard.html'));
  app.get('/builder', page('builder.html'));
  app.post('/login', (req, res) => {
    const token = String(req.body?.token ?? '');
    if (!timingSafeEqual(digest(token), digest(opts.adminToken))) {
      res.status(401).type('html').send(readFileSync(path.join(UI, 'login.html'), 'utf8').replace('<!--error-->', '<p class="err">Wrong token.</p>'));
      return;
    }
    res.cookie('keyrun_admin', token, { httpOnly: true, sameSite: 'strict', path: '/' });
    res.redirect(typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/');
  });

  // ---------- admin API ----------
  const a = express.Router();
  a.use(admin);

  a.get('/overview', async (_req, res) => {
    const [apps, devices, creds, workflows] = await Promise.all([
      db.query(`select id, name, base_url, policy from apps order by id`),
      db.query(`select id, name, enrolled_at, last_seen_at, encode(public_key, 'base64') as public_key from devices order by enrolled_at`),
      db.query(`select c.id, c.app_id, c.label, c.version, octet_length(c.ciphertext) as ciphertext_bytes, c.updated_at,
                       encode(substring(c.ciphertext from 1 for 12), 'hex') as ciphertext_head,
                       coalesce(json_agg(d.name) filter (where d.id is not null), '[]') as devices
                  from credentials c left join credential_keys k on k.credential_id = c.id left join devices d on d.id = k.device_id
                 group by c.id order by c.app_id, c.label`),
      db.query(`select distinct on (coalesce(app_id, '_draft'), kind) id, app_id, kind, version, source, created_at,
                       definition->>'description' as description
                  from workflows order by coalesce(app_id, '_draft'), kind, version desc`),
    ]);
    const now = new Date();
    res.json({
      apps: apps.rows.map((r) => {
        const policy = PolicySchema.parse({ ...DEFAULT_POLICY, ...r.policy });
        return { ...r, policy, window: describeWindow(policy), openNow: withinAllowedHours(policy, now) };
      }),
      devices: devices.rows,
      credentials: creds.rows,
      workflows: workflows.rows,
    });
  });

  a.get('/tasks', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const r = await db.query(
      `select t.*, d.name as lease_device_name from tasks t left join devices d on d.id = t.lease_device_id
        order by t.created_at desc limit $1`, [limit]);
    res.json(r.rows.map(publicTask));
  });

  a.get('/tasks/:id', async (req, res) => {
    const t = (await db.query(`select * from tasks where id = $1`, [req.params.id])).rows[0];
    if (!t) throw new HttpError(404, 'no such task');
    const events = (await db.query(
      `select e.*, d.name as device_name from task_events e left join devices d on d.id = e.device_id where task_id = $1 order by e.id`, [req.params.id])).rows;
    res.json({ task: publicTask(t), events });
  });

  a.post('/tasks', async (req, res) => {
    const b = req.body ?? {};
    const out = await enqueue(db, {
      appId: String(b.app ?? ''),
      kind: String(b.kind ?? ''),
      params: b.params ?? {},
      idempotencyKey: String(b.idempotencyKey ?? ''),
      requestedBy: String(b.requestedBy ?? 'dashboard'),
      credentialLabel: b.credentialLabel,
      targetDeviceId: b.targetDeviceId ?? null,
      maxAttempts: b.maxAttempts,
    });
    res.status(out.deduplicated ? 200 : 201).json({ task: publicTask(out.task), deduplicated: out.deduplicated });
  });

  a.post('/tasks/:id/approve', async (req, res) => {
    res.json(publicTask(await decide(db, String(req.params.id), String(req.body?.by ?? ''), true)));
  });
  a.post('/tasks/:id/reject', async (req, res) => {
    res.json(publicTask(await decide(db, String(req.params.id), String(req.body?.by ?? ''), false, req.body?.reason)));
  });

  a.put('/apps/:id', async (req, res) => {
    const baseUrl = String(req.body?.baseUrl ?? '');
    try {
      assertLoopbackUrl(baseUrl);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    await upsertApp(db, { id: String(req.params.id), name: String(req.body?.name ?? req.params.id), baseUrl });
    res.json({ ok: true });
  });

  a.put('/apps/:id/policy', async (req, res) => {
    res.json(await setPolicy(db, String(req.params.id), req.body));
  });

  a.get('/workflows/:id', async (req, res) => {
    const r = await db.query(`select * from workflows where id = $1`, [Number(req.params.id)]);
    if (!r.rows[0]) throw new HttpError(404, 'no such workflow');
    const versions = await db.query(`select id, version, source, created_at from workflows where app_id is not distinct from $1 and kind = $2 order by version desc`,
      [r.rows[0].app_id, r.rows[0].kind]);
    res.json({ ...r.rows[0], versions: versions.rows });
  });
  a.post('/workflows/validate', (req, res) => {
    res.json(validateWorkflow(req.body));
  });
  a.post('/workflows', async (req, res) => {
    res.status(201).json(await saveWorkflow(db, req.body?.definition, req.body?.source === 'recorder' ? 'recorder' : 'editor'));
  });
  // Raw events from the browser extension recorder; turned into a draft the same way the CLI does.
  a.post('/recordings', async (req, res) => {
    const b = req.body ?? {};
    if (!Array.isArray(b.events) || typeof b.startUrl !== 'string') throw new HttpError(400, 'events[] and startUrl are required');
    try {
      assertLoopbackUrl(b.startUrl);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const wf = eventsToWorkflow(b.events, {
      startUrl: b.startUrl, baseUrl: typeof b.baseUrl === 'string' ? b.baseUrl : guessBaseUrl(b.startUrl), app: String(b.app ?? 'hr'), kind: String(b.kind ?? 'recorded'),
    });
    res.status(201).json(await saveWorkflow(db, wf, 'recorder'));
  });

  // Device enrollment is an admin action: a person vouches for the device's public key.
  a.post('/devices', async (req, res) => {
    res.status(201).json(await enrollDevice(db, String(req.body?.name ?? 'device'), String(req.body?.publicKey ?? '')));
  });

  app.use('/api/admin', a);

  // ---------- agent API (device token) ----------
  const g = express.Router();
  g.use(async (req, _res, next) => {
    (req as Request & { deviceId: string }).deviceId = await authenticateDevice(db, req.headers.authorization);
    next();
  });
  const dev = (req: Request) => (req as Request & { deviceId: string }).deviceId;

  g.get('/devices', async (_req, res) => {
    const r = await db.query(`select id, name, encode(public_key, 'base64') as public_key from devices order by enrolled_at`);
    res.json(r.rows);
  });

  g.get('/apps', async (_req, res) => {
    res.json((await db.query(`select id, name, base_url from apps order by id`)).rows);
  });

  g.get('/credentials', async (req, res) => {
    const r = await db.query(
      `select c.id, c.app_id, c.label, c.version from credentials c join credential_keys k on k.credential_id = c.id and k.device_id = $1 order by c.app_id`,
      [dev(req)]);
    res.json(r.rows);
  });
  g.get('/credentials/:id', async (req, res) => {
    res.json(await credentialForDevice(db, String(req.params.id), dev(req)));
  });
  g.put('/credentials/:id', async (req, res) => {
    if (req.body?.id !== req.params.id) throw new HttpError(400, 'id mismatch');
    res.json(await putCredential(db, dev(req), req.body));
  });

  g.post('/claim', async (req, res) => {
    const t = await claim(db, dev(req), leaseMs);
    if (!t) {
      res.json({ task: null });
      return;
    }
    const wf = (await db.query(`select definition from workflows where id = $1`, [t.workflow_id])).rows[0].definition;
    const appRow = (await db.query(`select base_url, policy from apps where id = $1`, [t.app_id])).rows[0];
    // Rotations ship the app's sign-in workflow too, so a device that crashed mid-rotation can
    // check which password is live before acting again.
    const verify = t.kind === 'rotate_password'
      ? (await db.query(`select definition from workflows where app_id = $1 and kind = 'sign_in' order by version desc limit 1`, [t.app_id])).rows[0]?.definition ?? null
      : null;
    res.json({
      task: {
        id: t.id,
        idempotencyKey: t.idempotency_key,
        appId: t.app_id,
        kind: t.kind,
        params: t.params,
        attempt: t.attempts,
        maxAttempts: t.max_attempts,
        leaseId: t.lease_id,
        leaseMs,
        redelivery: t.redelivery,
        baseUrl: appRow.base_url,
        policy: PolicySchema.parse({ ...DEFAULT_POLICY, ...appRow.policy }),
        workflow: wf,
        verifyWorkflow: verify,
        credential: await credentialForDevice(db, t.credential_id, dev(req)),
      },
    });
  });
  g.post('/tasks/:id/heartbeat', async (req, res) => {
    res.json({ leaseExpiresAt: await heartbeat(db, String(req.params.id), dev(req), String(req.body?.leaseId), leaseMs) });
  });
  g.post('/tasks/:id/complete', async (req, res) => {
    const b = req.body ?? {};
    const t = await complete(db, String(req.params.id), dev(req), String(b.leaseId), {
      status: b.status, message: String(b.message ?? ''), durationMs: b.durationMs, failure: b.failure, replayed: b.replayed, credentialVersion: b.credentialVersion,
    });
    res.json(publicTask(t));
  });
  g.post('/tasks/:id/release', async (req, res) => {
    res.json(publicTask(await release(db, String(req.params.id), dev(req), String(req.body?.leaseId), String(req.body?.reason ?? 'released'), req.body?.retryInMs)));
  });
  app.use('/api/agent', g);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if ((err as { type?: string })?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid JSON' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}

function publicTask(t: TaskRow & { lease_device_name?: string }) {
  const { lease_id: _lease, ...rest } = t;
  const leaseExpired = t.status === 'leased' && t.lease_expires_at !== null && new Date(t.lease_expires_at) < new Date();
  return { ...rest, lease_expired: leaseExpired };
}
