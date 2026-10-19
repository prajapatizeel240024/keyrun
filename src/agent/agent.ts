// The local agent: claims tasks from the control plane, decrypts the credential on this device,
// runs the workflow with Playwright, and reports back. Safe under at-least-once delivery.
import path from 'node:path';
import type { Browser } from 'playwright';
import { b64, openCredential, sealCredential, sodiumReady, type CredentialSecret, type DeviceKeys } from '../crypto/envelope.ts';
import { RETRYABLE, type FailureReason } from '../engine/errors.ts';
import { runWorkflow, type RunResult } from '../engine/runner.ts';
import { parseWorkflow, type Workflow } from '../engine/schema.ts';
import { withinAllowedHours, type Policy } from '../server/policy.ts';
import { generatePassword } from '../shared/passwords.ts';
import { ApiError, ServerClient } from './client.ts';
import { deviceKeys, loadIdentity, type DeviceIdentity } from './home.ts';
import { Journal, type JournalResult, type PendingSecret } from './journal.ts';
import { decryptEnvelope, uploadCredential, type CredentialEnvelope } from './vault.ts';

export type ClaimedTask = {
  id: string;
  idempotencyKey: string;
  appId: string;
  kind: string;
  params: Record<string, string>;
  attempt: number;
  maxAttempts: number;
  leaseId: string;
  leaseMs: number;
  redelivery: boolean;
  baseUrl: string;
  policy: Policy;
  workflow: unknown;
  verifyWorkflow: unknown | null;
  credential: CredentialEnvelope;
};

export type AgentHooks = {
  /**
   * Test-only: simulate the device dying at an exact moment (no report, no further journal writes).
   *   after_browser       the app has changed, nothing else has happened (for a rotation: the vault
   *                       still holds the old password; only the journal knows the new one)
   *   after_act           everything done except journaling "done" and reporting
   *   after_journal_done  everything done except reporting
   */
  crashAt?: 'after_browser' | 'after_act' | 'after_journal_done';
  /** Observe each browser run (tests count these to prove a replay did not open a browser). */
  onBrowserRun?: (purpose: 'task' | 'verify', r: RunResult) => void;
};

export class SimulatedCrash extends Error {}

export type Outcome = 'idle' | 'done' | 'replayed' | 'released' | 'crashed';

export type AgentOptions = {
  home: string;
  serverUrl?: string;
  artifactsDir?: string;
  headless?: boolean;
  browser?: Browser;
  hooks?: AgentHooks;
  log?: (line: string) => void;
};

export class Agent {
  private id!: DeviceIdentity;
  private keys!: DeviceKeys;
  private client!: ServerClient;
  private journal!: Journal;
  private log: (line: string) => void;

  constructor(private opts: AgentOptions) {
    this.log = opts.log ?? ((l) => console.log(`[agent] ${l}`));
  }

  async init(): Promise<this> {
    await sodiumReady();
    this.id = await loadIdentity(this.opts.home);
    this.keys = deviceKeys(this.id);
    this.client = new ServerClient(this.opts.serverUrl ?? this.id.serverUrl, { device: { id: this.id.deviceId, token: this.id.token } });
    this.journal = await Journal.open(this.opts.home);
    return this;
  }

  get deviceId() {
    return this.id.deviceId;
  }

  /** Poll until stopped. */
  async loop(signal: AbortSignal, idleMs = 1500): Promise<void> {
    while (!signal.aborted) {
      let out: Outcome = 'idle';
      try {
        out = await this.runOnce();
      } catch (e) {
        this.log(`error: ${(e as Error).message}`);
      }
      if (out === 'idle') await new Promise((r) => setTimeout(r, idleMs));
    }
  }

  async runOnce(): Promise<Outcome> {
    const { task } = await this.client.post<{ task: ClaimedTask | null }>('/api/agent/claim');
    if (!task) return 'idle';
    const tag = `${task.appId}.${task.kind} ${task.id.slice(0, 8)} attempt ${task.attempt}${task.redelivery ? ' (redelivery)' : ''}`;
    this.log(`claimed ${tag}`);

    // 1. Already finished on this device? Answer from the journal; never act twice.
    //    (A journaled *failure* is not an answer: that attempt is retried.)
    const entry = this.journal.get(task.idempotencyKey);
    if (entry?.state === 'done' && entry.result && entry.result.status !== 'failed') {
      this.log(`journal says ${task.idempotencyKey} is done; re-reporting without opening a browser`);
      await this.report(task, entry.result, true);
      return 'replayed';
    }

    // 2. The device enforces the policy window too (defense in depth against a misbehaving server).
    if (!withinAllowedHours(task.policy)) {
      await this.client.post(`/api/agent/tasks/${task.id}/release`, { leaseId: task.leaseId, reason: 'outside allowed hours (device clock)' });
      this.log(`released ${tag}: outside allowed hours`);
      return 'released';
    }

    const heartbeat = setInterval(() => {
      this.client.post(`/api/agent/tasks/${task.id}/heartbeat`, { leaseId: task.leaseId }).catch((e) => {
        this.log(`heartbeat failed for ${task.id.slice(0, 8)}: ${(e as Error).message}`);
      });
    }, Math.max(500, Math.floor(task.leaseMs / 3)));

    try {
      const result = await this.execute(task, entry?.pending);
      if (this.opts.hooks?.crashAt === 'after_act') throw new SimulatedCrash('crash after acting, before journaling');
      await this.journal.write({ key: task.idempotencyKey, taskId: task.id, state: 'done', attempt: task.attempt, result });
      if (this.opts.hooks?.crashAt === 'after_journal_done') throw new SimulatedCrash('crash after journaling, before reporting');
      await this.report(task, result, false);
      this.log(`${result.status} ${tag}: ${result.message}`);
      return 'done';
    } catch (e) {
      if (e instanceof SimulatedCrash) {
        this.log(`simulated crash: ${e.message}`);
        return 'crashed';
      }
      throw e;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async execute(task: ClaimedTask, pendingFromEarlier?: PendingSecret): Promise<JournalResult> {
    let secret: CredentialSecret;
    try {
      secret = await decryptEnvelope(task.credential, this.keys);
    } catch (e) {
      return { status: 'failed', message: (e as Error).message, failure: { reason: 'credential_decrypt_failed', retryable: false } };
    }
    // The base URL comes from the server. The origins a secret may be typed into come from the
    // encrypted credential, which only a device can write.
    const origin = new URL(task.baseUrl).origin;
    if (!secret.allowedOrigins.includes(origin)) {
      return {
        status: 'failed',
        message: `server asked to use this credential on ${origin}, but it is bound to ${secret.allowedOrigins.join(', ')}`,
        failure: { reason: 'secret_origin_blocked', retryable: false },
      };
    }
    const workflow = parseWorkflow(task.workflow);

    if (task.kind !== 'rotate_password') {
      await this.journal.write({ key: task.idempotencyKey, taskId: task.id, state: 'started', attempt: task.attempt });
      const r = await this.browse('task', workflow, task, secret);
      if (this.opts.hooks?.crashAt === 'after_browser') throw new SimulatedCrash('crash right after the browser run');
      return redact(toResult(r), [secret.username, secret.password, secret.totpSecret]);
    }

    // ---- password rotation: the new password is born here and never leaves in the clear ----
    let newPassword: string;
    let pending = pendingFromEarlier;
    if (pending) {
      newPassword = this.openPending(task.idempotencyKey, pending).password;
      // An earlier attempt died mid-rotation. Is the new password already live?
      if (task.verifyWorkflow) {
        const v = await this.browse('verify', parseWorkflow(task.verifyWorkflow), task, { ...secret, password: newPassword });
        if (v.status === 'succeeded') {
          const version = await this.storeRotated(task, secret, newPassword);
          return { status: 'succeeded', message: 'rotation was already applied by an earlier attempt; confirmed by signing in with the new password', credentialVersion: version };
        }
      }
    } else {
      newPassword = generatePassword();
      pending = this.sealPending(task.idempotencyKey, { ...secret, password: newPassword });
    }
    await this.journal.write({ key: task.idempotencyKey, taskId: task.id, state: 'started', attempt: task.attempt, pending });
    const r = await this.browse('task', workflow, task, secret, newPassword);
    if (this.opts.hooks?.crashAt === 'after_browser') throw new SimulatedCrash('crash after the app changed, before the vault was updated');
    const result = redact(toResult(r), [secret.username, secret.password, secret.totpSecret, newPassword]);
    if (r.status === 'succeeded') result.credentialVersion = await this.storeRotated(task, secret, newPassword);
    return result;
  }

  private async browse(purpose: 'task' | 'verify', workflow: Workflow, task: ClaimedTask, secret: CredentialSecret, newPassword?: string) {
    const r = await runWorkflow({
      workflow,
      baseUrl: task.baseUrl,
      params: task.params,
      secrets: { username: secret.username, password: secret.password, totpSecret: secret.totpSecret, newPassword },
      allowedOrigins: secret.allowedOrigins,
      artifactsDir: this.opts.artifactsDir ?? path.join(this.opts.home, 'artifacts'),
      browser: this.opts.browser,
      headless: this.opts.headless ?? true,
      runId: `${task.id.slice(0, 8)}-a${task.attempt}-${purpose}`,
    });
    this.opts.hooks?.onBrowserRun?.(purpose, r);
    return r;
  }

  /** Upload the rotated credential as the next version. Tolerates an earlier attempt having done it. */
  private async storeRotated(task: ClaimedTask, secret: CredentialSecret, newPassword: string): Promise<number> {
    const c = task.credential;
    if (secret.password === newPassword) return c.version; // an earlier attempt already stored it
    try {
      const out = await uploadCredential(this.client, { deviceId: this.id.deviceId, keys: this.keys }, {
        id: c.id, appId: c.appId, label: c.label, version: c.version + 1, secret: { ...secret, password: newPassword },
      });
      return out.version;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
      const current = await this.client.get<CredentialEnvelope>(`/api/agent/credentials/${c.id}`);
      const stored = await decryptEnvelope(current, this.keys);
      if (stored.password === newPassword) return current.version;
      throw new Error('credential changed underneath this rotation');
    }
  }

  private sealPending(key: string, secret: CredentialSecret): PendingSecret {
    const s = sealCredential(secret, pendingAad(key), [{ deviceId: this.id.deviceId, publicKey: this.keys.publicKey }]);
    return { ciphertext: b64.enc(s.ciphertext), nonce: b64.enc(s.nonce), sealedDek: b64.enc(s.sealedKeys[0].sealedDek) };
  }

  private openPending(key: string, p: PendingSecret): CredentialSecret {
    return openCredential({ ciphertext: b64.dec(p.ciphertext), nonce: b64.dec(p.nonce), sealedDek: b64.dec(p.sealedDek) }, pendingAad(key), this.keys);
  }

  private async report(task: ClaimedTask, result: JournalResult, replayed: boolean): Promise<void> {
    try {
      await this.client.post(`/api/agent/tasks/${task.id}/complete`, { leaseId: task.leaseId, ...result, replayed });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Someone else holds the task now. Our journal has the result; if this task comes back
        // to us it is answered from there, and on another device the workflow sees the end state.
        this.log(`result for ${task.id.slice(0, 8)} not accepted: ${e.message}`);
        return;
      }
      throw e;
    }
  }
}

function pendingAad(key: string): Uint8Array {
  return new TextEncoder().encode(`keyrun.pending-rotation.v1|${key}`);
}

function toResult(r: RunResult): JournalResult {
  if (r.status !== 'failed') return { status: r.status, message: r.message, durationMs: r.durationMs };
  const reason = r.failure!.reason as FailureReason;
  return {
    status: 'failed',
    message: r.message,
    durationMs: r.durationMs,
    // Only the reason and a short detail leave the device. Screenshot and trace stay local.
    failure: { reason, retryable: RETRYABLE.has(reason), detail: `${r.failure!.step}: ${r.failure!.detail}`.slice(0, 300) },
  };
}

/** Belt and braces: scrub any secret value out of what we send to the server. */
function redact(result: JournalResult, secrets: Array<string | undefined>): JournalResult {
  const values = secrets.filter((v): v is string => !!v && v.length >= 4);
  const scrub = (s: string) => values.reduce((acc, v) => acc.split(v).join('•••'), s);
  return {
    ...result,
    message: scrub(result.message),
    failure: result.failure ? { ...result.failure, detail: result.failure.detail ? scrub(result.failure.detail) : undefined } : undefined,
  };
}
