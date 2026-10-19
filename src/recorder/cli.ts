// `npm run record -- --url http://127.0.0.1:4101/t/demo/login --app hr --kind my_task`
// Opens a browser window. Use the app normally; close the window (or press Ctrl+C) to finish.
// The draft goes to workflows/drafts/ and, with --upload, to the editor at /builder.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ServerClient } from '../agent/client.ts';
import { config } from '../config.ts';
import { WORKFLOWS_DIR } from '../engine/workflows.ts';
import { startRecording } from './record.ts';

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const url = flag('url');
if (!url) {
  console.log('usage: npm run record -- --url <start url> --app <app id> --kind <task kind> [--base-url <url>] [--out file.json] [--upload]');
  process.exit(1);
}
const app = flag('app') ?? 'hr';
const kind = flag('kind') ?? 'recorded';
const rec = await startRecording({ url, app, kind, baseUrl: flag('base-url'), headless: argv.includes('--headless') });
console.log('Recording. Use the app in the browser window; close it (or Ctrl+C) when done.');
await Promise.race([rec.closed, new Promise((r) => process.once('SIGINT', r))]);
const wf = await rec.stop();
const out = flag('out') ?? path.join(WORKFLOWS_DIR, 'drafts', `${app}.${kind}.json`);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(wf, null, 2) + '\n');
console.log(`Captured ${rec.events.length} events → ${wf.login.length} login steps + ${wf.steps.length} steps. Saved ${out}`);
if (argv.includes('--upload')) {
  const client = new ServerClient(config.serverUrl, { adminToken: config.adminToken });
  const saved = await client.post<{ id: number; version: number }>('/api/admin/workflows', { definition: wf, source: 'recorder' });
  console.log(`Uploaded as workflow #${saved.id} (v${saved.version}). Edit it at ${config.serverUrl}/builder?id=${saved.id}`);
}
