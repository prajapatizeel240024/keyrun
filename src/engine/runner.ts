// Runs one JSON workflow in a fresh browser context.
//
//  - every step first clears known interstitials (consent walls, popups, session expiry)
//  - targets resolve through several strategies with retries and backoff
//  - a session-expired interstitial re-runs the login steps and resumes at the last checkpoint
//  - secrets are typed only into pages on the credential's own origins
//  - on failure: a screenshot and the (secret-free) trace are written to the artifacts folder
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page, type Request } from 'playwright';
import { assertLoopbackUrl } from '../config.ts';
import { classify, EndSignal, firstLine, ReloginSignal, StepFailure, type FailureReason } from './errors.ts';
import { INTERSTITIALS, type InterstitialKind } from './interstitials.ts';
import { describeTarget, probe, probeMany, type Resolved } from './locate.ts';
import { backoffMs, sleep } from './retry.ts';
import type { Step, Strategy, Target, Workflow } from './schema.ts';
import { interpolate, interpolateSync, usesSecrets, type Scope } from './template.ts';
import { nextTotp } from './totp-client.ts';
import { SecretSafeTrace } from './trace.ts';

export type Timeouts = {
  /** How long one step may keep retrying. */
  stepMs: number;
  /** Timeout for a single Playwright action attempt inside a step. */
  attemptMs: number;
  navigationMs: number;
  runMs: number;
  maxRelogins: number;
};

export const DEFAULT_TIMEOUTS: Timeouts = { stepMs: 15_000, attemptMs: 2_500, navigationMs: 20_000, runMs: 120_000, maxRelogins: 3 };

export type Secrets = { username?: string; password?: string; totpSecret?: string; newPassword?: string };

export type RunInput = {
  workflow: Workflow;
  baseUrl: string;
  params?: Record<string, string>;
  secrets?: Secrets;
  /** Origins secrets may be typed into. Defaults to the origin of baseUrl. */
  allowedOrigins?: string[];
  /** Failure screenshots and traces go to <artifactsDir>/<runId>/. They never leave the device. */
  artifactsDir: string;
  browser?: Browser;
  headless?: boolean;
  timeouts?: Partial<Timeouts>;
  runId?: string;
  onStep?: (log: StepLog) => void;
};

export type StepLog = {
  path: string;
  op: Step['op'];
  ms: number;
  target?: string;
  strategy?: Strategy;
  fallback?: boolean;
  attempts?: number;
  info?: string;
};

export type RunResult = {
  runId: string;
  status: 'succeeded' | 'noop' | 'failed';
  message: string;
  failure?: { reason: FailureReason; step: string; detail: string };
  durationMs: number;
  steps: StepLog[];
  strategyWins: Partial<Record<Strategy, number>>;
  fallbacks: number;
  interstitials: Partial<Record<InterstitialKind | 'native_dialog', number>>;
  relogins: number;
  /** Plain clicks repeated because the next step never saw the page react. */
  reclicks: number;
  artifacts?: { dir: string; screenshot?: string; traces: string[] };
};

/** Errors that must stop a step immediately instead of being retried. */
const FATAL: ReadonlySet<FailureReason> = new Set(['secret_origin_blocked', 'non_loopback_url', 'bad_template', 'relogin_limit']);

/** How long a step waits for its target before suspecting the previous click never landed. */
const SWALLOWED_CLICK_AFTER_MS = 3_000;

export async function runWorkflow(input: RunInput): Promise<RunResult> {
  const runId = input.runId ?? `run-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...input.timeouts };
  const browser = input.browser ?? (await chromium.launch({ headless: input.headless ?? true }));
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  context.setDefaultTimeout(timeouts.attemptMs);
  context.setDefaultNavigationTimeout(timeouts.navigationMs);
  const dir = path.join(input.artifactsDir, runId);
  const trace = new SecretSafeTrace(context, dir);
  await trace.start();
  const page = await context.newPage();
  const run = new Run(page, trace, input, timeouts);
  page.on('dialog', (d) => {
    run.bump('native_dialog');
    d.accept().catch(() => {});
  });

  const started = Date.now();
  let status: RunResult['status'] = 'succeeded';
  let message = 'completed';
  let failure: RunResult['failure'];
  let artifacts: RunResult['artifacts'];
  const execution = run.execute();
  execution.catch(() => {}); // if the run timer wins, the abandoned promise must not crash the process
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      execution,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new StepFailure('run_timeout', `run exceeded ${timeouts.runMs} ms`)), timeouts.runMs);
      }),
    ]);
  } catch (e) {
    if (e instanceof EndSignal) {
      status = e.outcome;
      message = e.message;
    } else {
      const c = classify(e);
      status = 'failed';
      message = c.message;
      failure = { reason: c.reason, step: run.currentPath, detail: c.message };
    }
  } finally {
    clearTimeout(timer);
  }

  try {
    if (status === 'failed') {
      await mkdir(dir, { recursive: true });
      const screenshot = path.join(dir, 'failure.png');
      const shot = await page
        .screenshot({ path: screenshot, fullPage: true, timeout: 5_000, mask: [page.locator('input[type=password]')] })
        .then(() => screenshot)
        .catch(() => undefined);
      const traces = await trace.finish(true).catch(() => [] as string[]);
      artifacts = { dir, screenshot: shot, traces };
    } else {
      await trace.finish(false).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await context.close().catch(() => {});
    if (!input.browser) await browser.close().catch(() => {});
  }

  return {
    runId,
    status,
    message,
    failure,
    durationMs: Date.now() - started,
    steps: run.logs,
    strategyWins: run.strategyWins,
    fallbacks: run.fallbacks,
    interstitials: run.interstitials,
    relogins: run.relogins,
    reclicks: run.reclicks,
    artifacts,
  };
}

class Run {
  logs: StepLog[] = [];
  strategyWins: Partial<Record<Strategy, number>> = {};
  fallbacks = 0;
  interstitials: RunResult['interstitials'] = {};
  relogins = 0;
  currentPath = 'start';
  reclicks = 0;
  private effectApplied = false;
  private lastClick?: { target: Target; requestsBefore: number; retried: boolean };
  /** Page loads and XHR/fetch calls so far: if a click caused any, it was not swallowed. */
  private requests = 0;
  private inflight = new Set<Request>();
  private vars: Record<string, string> = {};
  private secretValues: string[];
  private scope: Scope;
  private allowedOrigins: string[];

  constructor(private page: Page, private trace: SecretSafeTrace, private input: RunInput, private t: Timeouts) {
    const ctx = page.context();
    ctx.on('request', (r) => {
      if (!['document', 'xhr', 'fetch'].includes(r.resourceType())) return;
      this.requests++;
      this.inflight.add(r);
    });
    ctx.on('requestfinished', (r) => this.inflight.delete(r));
    ctx.on('requestfailed', (r) => this.inflight.delete(r));
    const s = input.secrets ?? {};
    this.secretValues = [s.username, s.password, s.newPassword, s.totpSecret].filter((v): v is string => !!v);
    this.allowedOrigins = input.allowedOrigins ?? [new URL(input.baseUrl).origin];
    this.scope = {
      baseUrl: input.baseUrl.replace(/\/$/, ''),
      params: input.params ?? {},
      secrets: { ...s },
      vars: this.vars,
      totp: async () => {
        if (!s.totpSecret) throw new StepFailure('bad_template', 'workflow needs {{totp}} but the credential has no TOTP secret');
        const code = await nextTotp(s.totpSecret);
        this.secretValues.push(code);
        return code;
      },
    };
  }

  bump(kind: InterstitialKind | 'native_dialog') {
    this.interstitials[kind] = (this.interstitials[kind] ?? 0) + 1;
  }

  private sub = (s: string) => interpolateSync(s, this.scope);

  async execute(): Promise<void> {
    try {
      await this.runLogin();
      await this.runTop(this.input.workflow.steps);
    } finally {
      await this.settle();
    }
  }

  /**
   * Before calling a run finished (or closing the browser on an early `end`), let page loads and
   * API calls the last click started complete. Without this, a workflow whose last step is a
   * click can close the browser while the form post is still in flight; the recorder test caught
   * a "succeeded" run whose removal never reached the app.
   */
  private async settle(maxMs = 8_000, quietMs = 200): Promise<void> {
    const deadline = Date.now() + maxMs;
    let quietSince = this.inflight.size === 0 ? Date.now() : 0;
    while (Date.now() < deadline) {
      if (this.inflight.size === 0) {
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince >= quietMs) return;
      } else {
        quietSince = 0;
      }
      await sleep(50);
    }
  }

  private async runLogin(): Promise<void> {
    for (;;) {
      try {
        await this.runSeq(this.input.workflow.login, 'login');
        return;
      } catch (e) {
        if (!(e instanceof ReloginSignal)) throw e;
        this.countRelogin();
      }
    }
  }

  private countRelogin() {
    this.relogins++;
    if (this.relogins > this.t.maxRelogins) throw new StepFailure('relogin_limit', `session expired ${this.relogins} times`);
  }

  /** Top-level steps: a forced re-login resumes at the most recent checkpoint. */
  private async runTop(steps: Step[]): Promise<void> {
    let i = 0;
    let checkpoint = 0;
    while (i < steps.length) {
      if (steps[i].checkpoint) checkpoint = i;
      try {
        await this.exec(steps[i], `steps[${i}]`);
        i++;
      } catch (e) {
        if (!(e instanceof ReloginSignal)) throw e;
        this.countRelogin();
        await this.runLogin();
        i = checkpoint;
      }
    }
  }

  private async runSeq(steps: Step[], prefix: string): Promise<void> {
    for (const [i, s] of steps.entries()) await this.exec(s, `${prefix}[${i}]`);
  }

  private async exec(step: Step, at: string): Promise<void> {
    this.currentPath = at;
    const t0 = Date.now();
    const log: StepLog = { path: at, op: step.op, ms: 0 };
    if (step.op === 'if') {
      const hit = this.vars[step.var] === this.sub(step.equals);
      log.info = `${step.var}=${this.vars[step.var]} → ${hit ? 'then' : 'else'}`;
      this.finishLog(log, t0);
      await this.runSeq(hit ? step.then : step.else ?? [], `${at}.${hit ? 'then' : 'else'}`);
      return;
    }
    if (step.op === 'end') {
      this.finishLog(log, t0);
      if (step.outcome === 'noop' && this.effectApplied) {
        throw new EndSignal('succeeded', `${this.sub(step.message)} (applied by this run before a re-login)`);
      }
      throw new EndSignal(step.outcome, this.sub(step.message));
    }
    const secret = step.op === 'fill' && usesSecrets(step.value);
    if (secret) await this.trace.pause();
    else await this.trace.resumeIfClean(this.page, this.secretValues);
    // Navigating away makes any interstitial irrelevant (and the login block starts with one).
    if (step.op !== 'navigate') await this.clearInterstitials();
    const timeout = step.timeoutMs ?? this.t.stepMs;
    const requestsBefore = this.requests;

    switch (step.op) {
      case 'navigate': {
        const url = this.sub(step.url);
        try {
          assertLoopbackUrl(url);
        } catch (e) {
          throw new StepFailure('non_loopback_url', (e as Error).message);
        }
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.t.navigationMs });
            lastErr = undefined;
            break;
          } catch (e) {
            lastErr = e;
            await sleep(backoffMs(attempt + 2));
          }
        }
        if (lastErr) throw new StepFailure('navigation_failed', firstLine(String((lastErr as Error).message)));
        break;
      }
      case 'fill': {
        const value = await interpolate(step.value, this.scope);
        const mode = step.mode ?? 'fill';
        const verify = step.verify ?? mode === 'fill';
        Object.assign(log, await this.act(step.target, timeout, async (loc) => {
          if (secret) await this.assertSecretOrigin(loc);
          if (mode === 'type') {
            // Focus programmatically rather than clicking: a click can land on an overlay that
            // appears mid-action (the eval caught exactly that), and then every key goes nowhere.
            await loc.fill('', { timeout: this.t.attemptMs });
            await loc.focus({ timeout: this.t.attemptMs });
            await this.page.keyboard.type(value, { delay: 30 });
            if ((await loc.inputValue({ timeout: this.t.attemptMs })) === '') {
              throw new StepFailure('fill_mismatch', `typing into ${describeTarget(step.target)} did not land`);
            }
          } else {
            await loc.fill(value, { timeout: this.t.attemptMs });
          }
          if (verify && (await loc.inputValue({ timeout: this.t.attemptMs })) !== value) {
            throw new StepFailure('fill_mismatch', `field ${describeTarget(step.target)} did not keep the value`);
          }
        }));
        break;
      }
      case 'select': {
        const value = this.sub(step.value);
        Object.assign(log, await this.act(step.target, timeout, async (loc) => {
          await loc.selectOption(value, { timeout: this.t.attemptMs });
        }));
        break;
      }
      case 'check':
        Object.assign(log, await this.act(step.target, timeout, (loc) => loc.check({ timeout: this.t.attemptMs })));
        break;
      case 'click': {
        if (step.optional) {
          const found = await this.findOptional(step.target, step.timeoutMs ?? 2_000);
          if (!found) {
            log.info = 'optional element absent, skipped';
            break;
          }
        }
        // noWaitAfter: never block on a navigation the click started. If that wait timed out, the
        // retry loop would click a second time and submit the form twice (the eval caught this).
        Object.assign(log, await this.act(step.target, timeout, (loc) => loc.click({ timeout: this.t.attemptMs, noWaitAfter: true })));
        break;
      }
      case 'press':
        if (step.target) Object.assign(log, await this.act(step.target, timeout, (loc) => loc.press(step.key, { timeout: this.t.attemptMs })));
        else await this.page.keyboard.press(step.key);
        break;
      case 'wait':
        await this.waitStep(step, timeout, log);
        break;
      case 'assert':
        await this.assertStep(step, timeout, log);
        break;
      case 'findInPages':
        await this.findInPages(step, timeout, log);
        break;
    }
    if (step.effect) this.effectApplied = true;
    // Remember a plain (non-effect) click so the next step can recover if it was swallowed.
    this.lastClick = step.op === 'click' && !step.effect && !log.info ? { target: step.target, requestsBefore, retried: false } : undefined;
    this.finishLog(log, t0);
  }

  private finishLog(log: StepLog, t0: number) {
    log.ms = Date.now() - t0;
    this.logs.push(log);
    this.input.onStep?.(log);
  }

  private record(r: Resolved) {
    this.strategyWins[r.strategy] = (this.strategyWins[r.strategy] ?? 0) + 1;
    if (r.fallback) this.fallbacks++;
  }

  /**
   * Resolve the target and run the action, retrying both with backoff until the step deadline.
   * Interstitials are cleared between attempts (that is usually why a click failed).
   */
  private async act(target: Target, timeoutMs: number, action: (loc: Locator) => Promise<void>): Promise<Partial<StepLog>> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    let found = false;
    let ambiguous = false;
    let lastErr: unknown;
    for (let n = 0; ; n++) {
      const p = await probe(this.page, target, this.sub);
      ambiguous = ambiguous || p.ambiguous.length > 0;
      if (!p.resolved && Date.now() - started > SWALLOWED_CLICK_AFTER_MS) await this.recoverSwallowedClick();
      if (p.resolved) {
        found = true;
        try {
          await action(p.resolved.loc);
          this.record(p.resolved);
          return { target: describeTarget(target), strategy: p.resolved.strategy, fallback: p.resolved.fallback, attempts: n + 1 };
        } catch (e) {
          if (e instanceof StepFailure && FATAL.has(e.reason)) throw e;
          lastErr = e;
        }
      }
      await this.clearInterstitials(lastErr !== undefined);
      if (Date.now() >= deadline) break;
      await sleep(Math.min(backoffMs(n), Math.max(0, deadline - Date.now())));
    }
    const what = describeTarget(target);
    if (lastErr instanceof StepFailure) throw lastErr;
    if (found) throw new StepFailure('action_failed', `action on ${what} kept failing: ${firstLine(String((lastErr as Error)?.message ?? lastErr))}`);
    throw new StepFailure(ambiguous ? 'ambiguous_element' : 'element_not_found', `${ambiguous ? 'more than one match for' : 'no match for'} ${what}`);
  }

  /**
   * An overlay that appears at the exact moment of a click can swallow it, and Playwright still
   * reports success (the eval caught this once in 600 runs: a consent wall ate the "Next" click
   * of a sign-in form). If the step after a plain click cannot find its target and the clicked
   * element is still sitting there and the page made no request since, click it once more.
   * Never for `effect` steps, and never if the first click caused any page load or API call:
   * re-sending a "Create" or "Delete" is how you act twice.
   */
  private async recoverSwallowedClick(): Promise<void> {
    const last = this.lastClick;
    if (!last || last.retried) return;
    last.retried = true;
    if (this.requests !== last.requestsBefore) return; // the click did something; just slow
    const p = await probe(this.page, last.target, this.sub);
    if (!p.resolved || !(await p.resolved.loc.isEnabled().catch(() => false))) return;
    await this.clearInterstitials(true);
    try {
      await p.resolved.loc.click({ timeout: this.t.attemptMs, noWaitAfter: true });
      this.reclicks++;
    } catch {
      // Could not click it again; the step will fail on its own terms.
    }
  }

  private async findOptional(target: Target, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (let n = 0; ; n++) {
      if ((await probe(this.page, target, this.sub)).resolved) return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(backoffMs(n), Math.max(0, deadline - Date.now())));
    }
  }

  private async assertSecretOrigin(loc: Locator) {
    const origin = await loc.evaluate((el) => el.ownerDocument.location.origin);
    if (!this.allowedOrigins.includes(origin)) {
      throw new StepFailure('secret_origin_blocked', `refused to type a secret into ${origin}; allowed: ${this.allowedOrigins.join(', ')}`);
    }
  }

  private async waitStep(step: Extract<Step, { op: 'wait' }>, timeoutMs: number, log: StepLog) {
    if (step.ms !== undefined) await sleep(step.ms);
    if (step.url) {
      const want = this.sub(step.url);
      await this.page.waitForURL((u) => u.href.includes(want), { timeout: timeoutMs }).catch(() => {
        throw new StepFailure('assertion_failed', `URL never contained ${want} (at ${this.page.url()})`);
      });
    }
    if (step.target) {
      if ((step.state ?? 'visible') === 'visible') {
        Object.assign(log, await this.act(step.target, timeoutMs, async () => {}));
      } else {
        const deadline = Date.now() + timeoutMs;
        for (let n = 0; ; n++) {
          const p = await probe(this.page, step.target, this.sub);
          if (!p.resolved && p.ambiguous.length === 0) return;
          if (Date.now() >= deadline) throw new StepFailure('assertion_failed', `${describeTarget(step.target)} never went away`);
          await sleep(backoffMs(n));
        }
      }
    }
  }

  private async assertStep(step: Extract<Step, { op: 'assert' }>, timeoutMs: number, log: StepLog) {
    const deadline = Date.now() + timeoutMs;
    const wantText = step.text === undefined ? undefined : this.sub(step.text);
    const wantUrl = step.urlIncludes === undefined ? undefined : this.sub(step.urlIncludes);
    let seen = '';
    for (let n = 0; ; n++) {
      let ok = true;
      if (wantUrl !== undefined && !this.page.url().includes(wantUrl)) {
        ok = false;
        seen = `url ${this.page.url()}`;
      }
      if (ok && step.target) {
        const p = await probe(this.page, step.target, this.sub);
        if (!p.resolved) {
          ok = false;
          seen = `no ${describeTarget(step.target)}`;
        } else if (wantText !== undefined) {
          const text = (await p.resolved.loc.textContent().catch(() => '')) ?? '';
          if (!text.toLowerCase().includes(wantText.toLowerCase())) {
            ok = false;
            seen = `text "${text.trim().slice(0, 80)}"`;
          }
        }
        if (ok && p.resolved) {
          this.record(p.resolved);
          Object.assign(log, { target: describeTarget(step.target), strategy: p.resolved.strategy, fallback: p.resolved.fallback });
        }
      }
      if (ok) return;
      if (Date.now() - (deadline - timeoutMs) > SWALLOWED_CLICK_AFTER_MS) await this.recoverSwallowedClick();
      await this.clearInterstitials();
      if (Date.now() >= deadline) break;
      await sleep(Math.min(backoffMs(n), Math.max(0, deadline - Date.now())));
    }
    // Say what the page is complaining about, if anything: it makes failure reasons useful.
    const alert = await this.page.getByRole('alert').filter({ visible: true }).first().textContent({ timeout: 300 }).catch(() => null);
    throw new StepFailure('assertion_failed', `expected ${step.target ? describeTarget(step.target) : ''}${wantText ? ` with "${wantText}"` : ''}${wantUrl ? ` url~${wantUrl}` : ''}; saw ${seen}${alert ? `; page says "${alert.trim()}"` : ''}`);
  }

  private async findInPages(step: Extract<Step, { op: 'findInPages' }>, timeoutMs: number, log: StepLog) {
    const match = this.sub(step.match);
    const maxPages = step.maxPages ?? 50;
    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      // Wait for the page of results to finish loading before deciding anything.
      await this.act(step.ready, timeoutMs, async () => {});
      const readyNow = await probe(this.page, step.ready, this.sub);
      const readyText = (await readyNow.resolved?.loc.textContent().catch(() => '')) ?? '';
      const rows = await probeMany(this.page, step.row, this.sub);
      const hits = rows ? await rows.filter({ has: this.page.getByText(match, { exact: true }) }).count() : 0;
      if (hits > 0) {
        this.vars[step.saveAs] = 'true';
        log.info = `found on page ${pageNo}`;
        return;
      }
      const next = await probe(this.page, step.next, this.sub);
      const enabled = next.resolved ? await next.resolved.loc.isEnabled().catch(() => false) : false;
      if (!enabled) {
        this.vars[step.saveAs] = 'false';
        log.info = `not found in ${pageNo} page(s)`;
        return;
      }
      await this.act(step.next, timeoutMs, (loc) => loc.click({ timeout: this.t.attemptMs, noWaitAfter: true }));
      // Wait until the list shows a different page (the "ready" text changes).
      const deadline = Date.now() + timeoutMs;
      for (let n = 0; ; n++) {
        const p = await probe(this.page, step.ready, this.sub);
        const txt = p.resolved ? (await p.resolved.loc.textContent().catch(() => '')) ?? '' : '';
        if (p.resolved && txt !== readyText) break;
        await this.clearInterstitials();
        if (Date.now() >= deadline) throw new StepFailure('element_not_found', `page ${pageNo + 1} of the list never loaded`);
        await sleep(backoffMs(n));
      }
    }
    throw new StepFailure('pagination_limit', `gave up after ${maxPages} pages`);
  }

  /** Dismiss known interstitials; a session-expired one aborts the current step via ReloginSignal. */
  private async clearInterstitials(afterFailure = false): Promise<void> {
    for (let round = 0; round < 4; round++) {
      let handled = false;
      for (const it of INTERSTITIALS) {
        if (it.afterFailureOnly && !afterFailure) continue;
        const found = await it.detect(this.page);
        if (!found) continue;
        this.bump(it.kind);
        const outcome = await it.handle(this.page, found).catch(() => 'continue' as const);
        if (outcome === 'relogin') throw new ReloginSignal(it.kind);
        handled = true;
      }
      if (!handled) return;
    }
  }
}
