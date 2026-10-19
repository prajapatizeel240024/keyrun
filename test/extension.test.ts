// The Chrome extension recorder (stretch goal). Loads the unpacked extension into Chromium,
// records a flow in a real tab, sends it to the control plane, and replays the draft.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type BrowserContext } from 'playwright';
import { closeAllPools } from '../src/db/pool.ts';
import { runWorkflow } from '../src/engine/runner.ts';
import { parseWorkflow } from '../src/engine/schema.ts';
import { activeUsersByEmail } from '../src/mocks/answer-key.ts';
import { startMocks, type MockApps } from '../src/mocks/index.ts';
import { calmMess } from '../src/mocks/mess.ts';
import { startTestServer, tempDir, type TestServer } from './helpers.ts';

// Just enough of the extension API for the code we evaluate inside the service worker.
declare const chrome: { tabs: { query(q: { url?: string }): Promise<Array<{ id?: number; url?: string }>> } };

const EXT = path.resolve('extension');
let mocks: MockApps;
let server: TestServer;
let ctx: BrowserContext;
let profile: { dir: string; cleanup: () => Promise<void> };

before(async () => {
  mocks = await startMocks();
  server = await startTestServer({});
  profile = await tempDir('ext-profile');
  // Extensions need the full Chromium build ("chromium" channel), which runs them headless too.
  ctx = await chromium.launchPersistentContext(profile.dir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
});
after(async () => {
  await ctx.close();
  await profile.cleanup();
  await server.close();
  await mocks.close();
  await closeAllPools();
});

test('the extension ships the exact same recorder script as the CLI recorder', async () => {
  assert.equal(await readFile(path.join(EXT, 'recorder.js'), 'utf8'), await readFile('src/recorder/inject.js', 'utf8'));
});

test('records in a real tab, uploads to the editor, and the draft replays', async () => {
  const people = [
    { email: 'stay@example.test', name: 'Stay Here', role: 'Agent' },
    { email: 'go@example.test', name: 'Go Away', role: 'Agent' },
  ];
  const t = await mocks.createTenant('helpdesk', { mess: calmMess({ totp: false, randomIds: true }), users: people });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const page = await ctx.newPage();
  await page.goto(`${t.baseUrl}/#/login`);
  await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}*` });
    await (self as unknown as { keyrun: { start(id: number, u: string): Promise<unknown> } }).keyrun.start(tab.id!, tab.url!);
  }, t.baseUrl);

  await page.getByPlaceholder('you@company.com').fill(t.admin.email);
  await page.getByPlaceholder('Password').fill(t.admin.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Agents' }).click();
  await page.getByRole('button', { name: 'Actions for go@example.test' }).click();
  await page.getByRole('menuitem', { name: 'Deactivate' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate agent' }).click();
  await page.getByRole('status').waitFor();
  await page.waitForTimeout(300);

  const saved = await sw.evaluate(async ([server, token]) => {
    const k = (self as unknown as { keyrun: { stop(): Promise<unknown>; upload(s: string, t: string, a: string, k: string): Promise<{ id: number }> } }).keyrun;
    await k.stop();
    return k.upload(server, token, 'helpdesk', 'remove_user');
  }, [server.url, 'test-admin-token']);
  const row = await server.admin.get<{ definition: unknown; source: string }>(`/api/admin/workflows/${saved.id}`);
  assert.equal(row.source, 'recorder');
  const wf = parseWorkflow(row.definition);
  const json = JSON.stringify(wf);
  assert.ok(!json.includes(t.admin.password) && !json.includes(t.admin.email), 'no secrets in the draft');
  assert.equal(wf.params.email?.example, 'go@example.test');

  const t2 = await mocks.createTenant('helpdesk', { mess: calmMess({ totp: false, randomIds: true }), users: [...people].reverse() });
  const artifacts = await tempDir('ext-run');
  const browser = await chromium.launch();
  try {
    const r = await runWorkflow({
      workflow: wf, baseUrl: t2.baseUrl, browser, artifactsDir: artifacts.dir,
      params: { email: 'go@example.test' }, secrets: { username: t2.admin.email, password: t2.admin.password },
    });
    assert.equal(r.status, 'succeeded', r.message);
    assert.equal((await activeUsersByEmail('helpdesk', t2.tenantId, 'go@example.test')).length, 0);
    assert.equal((await activeUsersByEmail('helpdesk', t2.tenantId, 'stay@example.test')).length, 1);
  } finally {
    await browser.close();
    await artifacts.cleanup();
  }
});
