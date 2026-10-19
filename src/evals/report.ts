import { readFile, writeFile } from 'node:fs/promises';
import type { Summary } from './run.ts';

const MESS_LABELS: Record<string, string> = {
  random_ids: 'Field ids/classes change every load',
  iframe_login: 'Login form inside an iframe',
  totp: 'TOTP second step',
  slow_spa: 'Slow single-page app (150 ms – 4.5 s per call)',
  cookie_banner: 'Consent overlay blocking clicks (appeared)',
  session_expired: 'Session expired mid-task (fired)',
  pagination: 'Target beyond page 1 of the list',
  confirm_modal: 'Confirm modal before removal',
  announcement: '"What\'s new" popup (appeared)',
  label_drift: 'A/B copy test renamed the action buttons',
  unknown_popup: 'Survey popup with no dedicated handler (appeared)',
};

const fmt = (r: number | null) => (r === null ? '–' : `${r.toFixed(1)}%`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function renderMarkdown(s: Summary): string {
  const lines: string[] = [];
  lines.push(`**${s.overall.passed}/${s.overall.runs} runs passed (${fmt(s.overall.rate)})**, graded against each mock app's database. ` +
    `Silent failures (engine said success, database disagreed): **${s.silentFailures}**.`);
  lines.push('');
  lines.push(`Machine: ${s.machine.cpu}, ${s.machine.memoryGb} GB RAM, ${s.machine.os}; Node ${s.machine.node}, ` +
    `Playwright ${s.machine.playwright} (Chromium ${s.machine.chromium}). ${s.config.runsPerWorkflow} runs per workflow, ` +
    `concurrency ${s.config.concurrency}, seed ${s.config.seed}, wall time ${Math.round(s.wallSeconds / 60)} min. Generated ${s.generatedAt.slice(0, 10)}.`);
  lines.push('');
  lines.push('| App | Runs | Passed | Success | p50 | p95 |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const [app, v] of Object.entries(s.byApp)) lines.push(`| ${app} | ${v.runs} | ${v.passed} | ${fmt(v.rate)} | ${secs(v.p50Ms)} | ${secs(v.p95Ms)} |`);
  lines.push('');
  lines.push('| Workflow | Runs | Success | p50 | p95 |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const [wf, v] of Object.entries(s.byWorkflow)) lines.push(`| ${wf} | ${v.runs} | ${fmt(v.rate)} | ${secs(v.p50Ms)} | ${secs(v.p95Ms)} |`);
  lines.push('');
  lines.push('| Kind of mess (runs where it was in play) | Runs | Success |');
  lines.push('|---|---:|---:|');
  for (const [k, v] of Object.entries(s.byMess)) lines.push(`| ${MESS_LABELS[k] ?? k} | ${v.runs} | ${fmt(v.rate)} |`);
  lines.push('');
  if (s.failureReasons.length) {
    lines.push('| Most common failure reasons | Count | Where | Example |');
    lines.push('|---|---:|---|---|');
    for (const f of s.failureReasons.slice(0, 8)) lines.push(`| \`${f.reason}\` | ${f.count} | ${f.where} | ${f.example.replace(/\|/g, '\\|')} |`);
  } else {
    lines.push('No failures in this run.');
  }
  lines.push('');
  const share = Object.entries(s.locator.strategyShare).map(([k, v]) => `${k} ${fmt(v)}`).join(', ');
  lines.push(`Locator: ${s.locator.resolutions} element resolutions; winning strategy share: ${share}. ` +
    `${s.locator.fallbacksTotal} resolutions needed a fallback strategy (in ${s.locator.fallbackRuns} runs). ` +
    `Interstitials handled: ${Object.entries(s.interstitialsHandled).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}. ` +
    `Runs with a forced re-login: ${s.reloginRuns}. Runs that repeated a swallowed click: ${s.reclickRuns ?? 0}.`);
  return lines.join('\n') + '\n';
}

/** Replace the block between <!-- eval:start --> and <!-- eval:end --> in the README. */
export async function updateReadme(file: string, md: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return;
  }
  const start = '<!-- eval:start -->';
  const end = '<!-- eval:end -->';
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 || b < a) return;
  await writeFile(file, `${text.slice(0, a + start.length)}\n${md}${text.slice(b)}`);
}
