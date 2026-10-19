// `npm run eval`: run every workflow N times against the mock apps with randomized mess,
// then grade each run against the app's own database (the answer key), not the engine's word.
//
// Flags: --runs 50  --concurrency 3  --seed 1  --apps hr,helpdesk  --kinds sign_in,create_user
import { cpus, totalmem, release, platform, arch } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { closeAllPools } from '../db/pool.ts';
import { activeUserCount, activeUsersByEmail, adminPasswordIs, auditActions, auditCount } from '../mocks/answer-key.ts';
import { APP_ROLES, startMocks } from '../mocks/index.ts';
import { APP_IDS, MESS_KINDS, sampleMess, type AppId, type MessKind } from '../mocks/mess.ts';
import { emailFor, personName, seedPeople } from '../mocks/people.ts';
import { runWorkflow, type RunResult } from '../engine/runner.ts';
import { loadWorkflow } from '../engine/workflows.ts';
import { LIFECYCLE_KINDS } from '../engine/schema.ts';
import { generatePassword } from '../shared/passwords.ts';
import { hashSeed, seededRng } from '../shared/rng.ts';
import { isMain } from '../shared/is-main.ts';
import { renderMarkdown, updateReadme } from './report.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RESULTS_DIR = path.join(ROOT, 'evals/results');

export type RunRecord = {
  app: AppId;
  kind: string;
  i: number;
  seed: number;
  expected: 'succeeded' | 'noop';
  status: RunResult['status'];
  pass: boolean;
  /** Why it did not pass: an engine failure reason, or an answer-key mismatch. */
  reason?: string;
  detail?: string;
  /** The engine claimed success but the database disagrees. The worst kind of failure. */
  silent: boolean;
  mess: MessKind[];
  durationMs: number;
  relogins: number;
  reclicks: number;
  fallbacks: number;
  strategyWins: RunResult['strategyWins'];
  interstitials: RunResult['interstitials'];
  artifacts?: string;
};

export type Summary = ReturnType<typeof summarize>;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

type Job = { app: AppId; kind: string; i: number };

export async function runEval(opts: { runs: number; concurrency: number; seed: number; apps: AppId[]; kinds: string[] }) {
  const mocks = await startMocks();
  const browser = await chromium.launch();
  const artifactsDir = path.join(ROOT, 'artifacts/eval');
  const jobs: Job[] = [];
  for (const app of opts.apps) for (const kind of opts.kinds) for (let i = 0; i < opts.runs; i++) jobs.push({ app, kind, i });
  // Interleave apps and kinds so a slow app doesn't hog the tail.
  const order = seededRng(opts.seed).shuffle([...jobs]);
  const records: RunRecord[] = [];
  const started = Date.now();
  let done = 0;

  const runOne = async (job: Job): Promise<RunRecord> => {
    const seed = hashSeed(opts.seed, job.app, job.kind, job.i);
    const rng = seededRng(seed);
    const mess = sampleMess(job.app, rng);
    const roles = APP_ROLES[job.app];
    const users = seedPeople(rng, rng.int(12, 40), roles);
    const targetName = personName(rng);
    const target = { name: targetName, email: emailFor(targetName, `t${job.i}x${rng.int(100, 999)}`), role: rng.pick(roles) };
    const present = job.kind === 'create_user' ? rng.chance(0.2) : job.kind === 'remove_user' ? rng.chance(0.8) : false;
    let targetIndex = -1;
    if (present) {
      targetIndex = rng.int(0, users.length);
      users.splice(targetIndex, 0, target);
    }
    const expected: RunRecord['expected'] =
      (job.kind === 'create_user' && present) || (job.kind === 'remove_user' && !present) ? 'noop' : 'succeeded';
    const newPassword = generatePassword();
    const t = await mocks.createTenant(job.app, { mess, users });
    const before = await activeUserCount(job.app, t.tenantId);

    const r = await runWorkflow({
      workflow: loadWorkflow(job.app, job.kind),
      baseUrl: t.baseUrl,
      params: { email: target.email, name: target.name, role: target.role },
      secrets: { username: t.admin.email, password: t.admin.password, totpSecret: t.admin.totpSecret ?? undefined, newPassword },
      artifactsDir,
      browser,
      runId: `${job.app}-${job.kind}-${job.i}`,
    });

    // ---- grade against the app's database ----
    let keyOk = true;
    let keyDetail = '';
    const fail = (d: string) => {
      keyOk = false;
      keyDetail = keyDetail || d;
    };
    if (job.kind === 'sign_in') {
      if ((await auditCount(job.app, t.tenantId, 'login.success')) < 1) fail('no successful login recorded');
    } else if (job.kind === 'create_user') {
      const rows = await activeUsersByEmail(job.app, t.tenantId, target.email);
      if (rows.length !== 1) fail(`${rows.length} active users with the email (want 1)`);
      else if (!present && (rows[0].name !== target.name || rows[0].role !== target.role)) fail('user created with wrong name or role');
      const creates = await auditCount(job.app, t.tenantId, 'user.create');
      if (creates !== (present ? 0 : 1)) fail(`${creates} create actions (want ${present ? 0 : 1})`);
    } else if (job.kind === 'remove_user') {
      const rows = await activeUsersByEmail(job.app, t.tenantId, target.email);
      if (rows.length !== 0) fail('user still active');
      const after = await activeUserCount(job.app, t.tenantId);
      if (after !== before - (present ? 1 : 0)) fail(`active users ${before} → ${after}`);
    } else if (job.kind === 'rotate_password') {
      if (!(await adminPasswordIs(job.app, t.tenantId, newPassword))) fail('new password does not work');
      const changes = await auditCount(job.app, t.tenantId, 'password.change');
      if (changes !== 1) fail(`${changes} password changes (want 1)`);
    }

    // ---- which mess was actually in play ----
    const actions = new Set(await auditActions(job.app, t.tenantId));
    const kinds: MessKind[] = [];
    if (mess.randomIds) kinds.push('random_ids');
    if (mess.iframeLogin) kinds.push('iframe_login');
    if (mess.totp) kinds.push('totp');
    if (mess.latency) kinds.push('slow_spa');
    if (actions.has('mess.cookie_banner')) kinds.push('cookie_banner');
    if (actions.has('mess.session_expired')) kinds.push('session_expired');
    if (actions.has('mess.announcement')) kinds.push('announcement');
    if (actions.has('mess.survey')) kinds.push('unknown_popup');
    if (mess.labelDrift && job.kind !== 'sign_in') kinds.push('label_drift');
    if (job.kind === 'remove_user' && present) kinds.push('confirm_modal');
    // Pagination counts when the engine had to look past page 1 (Directory searches instead).
    if (job.app !== 'directory' && (job.kind === 'create_user' || job.kind === 'remove_user')) {
      const pages = Math.ceil(users.length / mess.pageSize);
      const targetPage = present ? Math.floor((users.length - 1 - targetIndex) / mess.pageSize) + 1 : pages;
      if (targetPage > 1) kinds.push('pagination');
    }

    const outcomeOk = r.status === expected;
    const pass = outcomeOk && keyOk;
    let reason: string | undefined;
    let detail: string | undefined;
    if (r.status === 'failed') {
      reason = r.failure!.reason;
      detail = `${r.failure!.step}: ${r.failure!.detail}`;
    } else if (!keyOk) {
      reason = 'answer_key_mismatch';
      detail = keyDetail;
    } else if (!outcomeOk) {
      reason = 'wrong_outcome';
      detail = `reported ${r.status}, expected ${expected}: ${r.message}`;
    }
    return {
      app: job.app,
      kind: job.kind,
      i: job.i,
      seed,
      expected,
      status: r.status,
      pass,
      reason,
      detail,
      silent: r.status !== 'failed' && !keyOk,
      mess: kinds,
      durationMs: r.durationMs,
      relogins: r.relogins,
      reclicks: r.reclicks,
      fallbacks: r.fallbacks,
      strategyWins: r.strategyWins,
      interstitials: r.interstitials,
      artifacts: r.artifacts?.dir ? path.relative(ROOT, r.artifacts.dir) : undefined,
    };
  };

  const worker = async () => {
    for (;;) {
      const job = order.shift();
      if (!job) return;
      const rec = await runOne(job).catch((e): RunRecord => ({
        app: job.app, kind: job.kind, i: job.i, seed: 0, expected: 'succeeded', status: 'failed', pass: false,
        reason: 'harness_error', detail: String(e?.message ?? e), silent: false, mess: [], durationMs: 0, relogins: 0, reclicks: 0,
        fallbacks: 0, strategyWins: {}, interstitials: {},
      }));
      records.push(rec);
      done++;
      if (!rec.pass || done % 25 === 0) {
        const tag = rec.pass ? 'ok  ' : 'FAIL';
        process.stdout.write(`[${done}/${jobs.length}] ${tag} ${rec.app}.${rec.kind}#${rec.i}${rec.reason ? ` ${rec.reason}: ${rec.detail}` : ''}\n`);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: opts.concurrency }, worker));
  } finally {
    await browser.close();
    await mocks.close();
  }
  return { records, wallMs: Date.now() - started, browserVersion: browser.version() };
}

function rate(pass: number, n: number) {
  return n === 0 ? null : Math.round((pass / n) * 1000) / 10;
}

function pct(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export function summarize(records: RunRecord[], meta: { runs: number; seed: number; concurrency: number; wallMs: number; browserVersion: string; playwright: string }) {
  const group = <K extends string>(key: (r: RunRecord) => K[] | K) => {
    const m = new Map<K, RunRecord[]>();
    for (const r of records) for (const k of ([] as K[]).concat(key(r))) m.set(k, [...(m.get(k) ?? []), r]);
    return m;
  };
  const stat = (rs: RunRecord[]) => ({
    runs: rs.length,
    passed: rs.filter((r) => r.pass).length,
    rate: rate(rs.filter((r) => r.pass).length, rs.length),
    p50Ms: pct(rs.map((r) => r.durationMs), 50),
    p95Ms: pct(rs.map((r) => r.durationMs), 95),
  });
  const byApp = Object.fromEntries([...group((r) => r.app)].map(([k, v]) => [k, stat(v)]));
  const byWorkflow = Object.fromEntries([...group((r) => `${r.app}.${r.kind}`)].sort().map(([k, v]) => [k, stat(v)]));
  const messGroups = group((r) => r.mess);
  const byMess = Object.fromEntries(MESS_KINDS.filter((k) => messGroups.has(k)).map((k) => [k, stat(messGroups.get(k)!)]));
  const failures = records.filter((r) => !r.pass);
  const reasons = [...group((r) => r.reason ?? 'none')].filter(([k]) => k !== 'none')
    .map(([reason, rs]) => ({
      reason,
      count: rs.length,
      where: [...new Set(rs.map((r) => `${r.app}.${r.kind}`))].join(', '),
      example: rs[0].detail?.slice(0, 220) ?? '',
    }))
    .sort((a, b) => b.count - a.count);
  const wins: Record<string, number> = {};
  let resolutions = 0;
  for (const r of records) for (const [k, v] of Object.entries(r.strategyWins)) {
    wins[k] = (wins[k] ?? 0) + (v ?? 0);
    resolutions += v ?? 0;
  }
  const interstitials: Record<string, number> = {};
  for (const r of records) for (const [k, v] of Object.entries(r.interstitials)) interstitials[k] = (interstitials[k] ?? 0) + (v ?? 0);
  const cpu = cpus();
  return {
    generatedAt: new Date().toISOString(),
    config: { runsPerWorkflow: meta.runs, seed: meta.seed, concurrency: meta.concurrency },
    machine: {
      os: `${platform()} ${release()} (${arch()})`,
      cpu: `${cpu[0]?.model.trim() ?? 'unknown'} × ${cpu.length}`,
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
      playwright: meta.playwright,
      chromium: meta.browserVersion,
    },
    wallSeconds: Math.round(meta.wallMs / 1000),
    overall: stat(records),
    silentFailures: records.filter((r) => r.silent).length,
    byApp,
    byWorkflow,
    byMess,
    failureReasons: reasons,
    locator: {
      resolutions,
      strategyShare: Object.fromEntries(Object.entries(wins).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, rate(v, resolutions)])),
      fallbackRuns: records.filter((r) => r.fallbacks > 0).length,
      fallbacksTotal: records.reduce((a, r) => a + r.fallbacks, 0),
    },
    interstitialsHandled: interstitials,
    reloginRuns: records.filter((r) => r.relogins > 0).length,
    reclickRuns: records.filter((r) => (r.reclicks ?? 0) > 0).length,
    failedRunArtifacts: failures.filter((r) => r.artifacts).slice(0, 20).map((r) => r.artifacts!),
  };
}

if (isMain(import.meta.url) && process.argv.includes('--report-only')) {
  // Re-render latest.md and the README table from the last summary.json (no browsers).
  const summary: Summary = JSON.parse(await readFile(path.join(RESULTS_DIR, 'summary.json'), 'utf8'));
  const md = renderMarkdown(summary);
  await writeFile(path.join(RESULTS_DIR, 'latest.md'), md);
  await updateReadme(path.join(ROOT, 'README.md'), md);
  console.log(md);
} else if (isMain(import.meta.url)) {
  const runs = Number(arg('runs', '50'));
  const concurrency = Number(arg('concurrency', '3'));
  const seed = Number(arg('seed', '1'));
  const apps = arg('apps', APP_IDS.join(',')).split(',') as AppId[];
  const kinds = arg('kinds', LIFECYCLE_KINDS.join(',')).split(',');
  console.log(`Running ${apps.length * kinds.length} workflows × ${runs} runs (concurrency ${concurrency}, seed ${seed})`);
  try {
    const { records, wallMs, browserVersion } = await runEval({ runs, concurrency, seed, apps, kinds });
    const pw = JSON.parse(await readFile(path.join(ROOT, 'node_modules/playwright/package.json'), 'utf8')).version;
    const summary = summarize(records, { runs, seed, concurrency, wallMs, browserVersion, playwright: pw });
    await mkdir(RESULTS_DIR, { recursive: true });
    records.sort((a, b) => `${a.app}.${a.kind}`.localeCompare(`${b.app}.${b.kind}`) || a.i - b.i);
    await writeFile(path.join(RESULTS_DIR, 'runs.json'), JSON.stringify(records, null, 1));
    await writeFile(path.join(RESULTS_DIR, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    const md = renderMarkdown(summary);
    await writeFile(path.join(RESULTS_DIR, 'latest.md'), md);
    if (arg('readme', 'yes') === 'yes') await updateReadme(path.join(ROOT, 'README.md'), md);
    console.log(`\n${md}`);
  } finally {
    await closeAllPools();
  }
}
