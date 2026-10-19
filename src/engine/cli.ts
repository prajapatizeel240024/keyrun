// `npm run run:workflow -- --workflow workflows/hr/sign_in.json --base-url http://127.0.0.1:4101/t/<tenant> [--param email=a@b.test] [--headed]`
// Runs one workflow directly (no server, no agent). Secrets come from the environment only,
// never from argv (which other processes can read): KEYRUN_USERNAME, KEYRUN_PASSWORD,
// KEYRUN_TOTP_SECRET, KEYRUN_NEW_PASSWORD.
import path from 'node:path';
import { runWorkflow } from './runner.ts';
import { loadWorkflowFile } from './workflows.ts';

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const file = flag('workflow');
const baseUrl = flag('base-url');
if (!file || !baseUrl) {
  console.log('usage: npm run run:workflow -- --workflow <file.json> --base-url <url> [--param k=v]... [--headed]');
  process.exit(1);
}
const params: Record<string, string> = {};
argv.forEach((a, i) => {
  if (a === '--param') {
    const [k, ...v] = (argv[i + 1] ?? '').split('=');
    params[k] = v.join('=');
  }
});
const r = await runWorkflow({
  workflow: loadWorkflowFile(file),
  baseUrl,
  params,
  secrets: {
    username: process.env.KEYRUN_USERNAME,
    password: process.env.KEYRUN_PASSWORD,
    totpSecret: process.env.KEYRUN_TOTP_SECRET,
    newPassword: process.env.KEYRUN_NEW_PASSWORD,
  },
  headless: !argv.includes('--headed'),
  artifactsDir: path.resolve('artifacts/cli'),
  onStep: (s) => console.log(`  ${s.path.padEnd(16)} ${s.op.padEnd(11)} ${String(s.ms).padStart(5)} ms  ${s.strategy ? `via ${s.strategy}${s.fallback ? ' (fallback)' : ''}` : ''} ${s.info ?? ''}`),
});
console.log(`\n${r.status.toUpperCase()}: ${r.message}`);
if (r.failure) console.log(`reason: ${r.failure.reason} at ${r.failure.step}`);
if (r.artifacts) console.log(`screenshot + trace: ${r.artifacts.dir}  (open with: npx playwright show-trace <trace-part.zip>)`);
process.exitCode = r.status === 'failed' ? 1 : 0;
