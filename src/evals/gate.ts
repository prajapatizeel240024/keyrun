// `npm run eval:gate`: fail the build if any success rate dropped below the committed baseline.
//   --tolerance <points>   allow a drop of up to this many percentage points (default 0: any drop fails)
//   --update-baseline      accept the latest results as the new baseline
//
// Strict by default on purpose: the mess is seeded, so the same scenarios run every time, and in
// this project every "flaky" failure so far turned out to be a real race worth fixing.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Summary } from './run.ts';
import { isMain } from '../shared/is-main.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUMMARY = path.join(ROOT, 'evals/results/summary.json');
const BASELINE = path.join(ROOT, 'evals/baseline.json');

type Rates = Record<string, { rate: number | null; runs: number }>;
export type Baseline = { createdAt: string; source: string; runsPerWorkflow: number; silentFailures: number; rates: Rates };

export function flatten(s: Summary): Rates {
  const out: Rates = { overall: { rate: s.overall.rate, runs: s.overall.runs } };
  for (const [k, v] of Object.entries(s.byApp)) out[`app:${k}`] = { rate: v.rate, runs: v.runs };
  for (const [k, v] of Object.entries(s.byWorkflow)) out[`workflow:${k}`] = { rate: v.rate, runs: v.runs };
  for (const [k, v] of Object.entries(s.byMess)) out[`mess:${k}`] = { rate: v.rate, runs: v.runs };
  return out;
}

export function compare(base: Baseline, current: Summary, tolerancePts: number): { failures: string[]; checked: number } {
  const now = flatten(current);
  const failures: string[] = [];
  let checked = 0;
  for (const [key, b] of Object.entries(base.rates)) {
    if (b.rate === null) continue;
    const c = now[key];
    if (key.startsWith('mess:') && !c) continue; // a kind of mess that happened not to fire this time
    if (!c || c.rate === null) {
      failures.push(`${key}: missing from the latest results (was ${b.rate}%)`);
      continue;
    }
    checked++;
    if (c.rate < b.rate - tolerancePts) failures.push(`${key}: ${b.rate}% → ${c.rate}% (${c.runs} runs)`);
  }
  if (current.silentFailures > base.silentFailures) failures.push(`silent failures: ${base.silentFailures} → ${current.silentFailures}`);
  return { failures, checked };
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--tolerance');
  const tolerance = i >= 0 ? Number(argv[i + 1]) : 0;
  const current: Summary = JSON.parse(await readFile(SUMMARY, 'utf8'));
  if (argv.includes('--update-baseline')) {
    const b: Baseline = {
      createdAt: current.generatedAt,
      source: 'evals/results/summary.json',
      runsPerWorkflow: current.config.runsPerWorkflow,
      silentFailures: current.silentFailures,
      rates: flatten(current),
    };
    await writeFile(BASELINE, JSON.stringify(b, null, 2) + '\n');
    console.log(`Baseline updated from ${current.overall.runs} runs (${current.overall.rate}% overall).`);
    return;
  }
  const base: Baseline = JSON.parse(await readFile(BASELINE, 'utf8'));
  if (current.config.runsPerWorkflow < base.runsPerWorkflow) {
    console.log(`Gate needs at least ${base.runsPerWorkflow} runs per workflow (got ${current.config.runsPerWorkflow}).`);
    process.exitCode = 1;
    return;
  }
  const { failures, checked } = compare(base, current, tolerance);
  if (failures.length) {
    console.log(`Regression gate FAILED (${failures.length} of ${checked} rates dropped, tolerance ${tolerance} pts):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`Regression gate passed: ${checked} success rates at or above baseline (tolerance ${tolerance} pts).`);
  }
}

if (isMain(import.meta.url)) await main();
