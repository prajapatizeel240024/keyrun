// The workflow builder: record clicks and typing, get robust editable steps, replay them on a
// different tenant whose ids, classes and timing are all different.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { closeAllPools } from '../src/db/pool.ts';
import { runWorkflow } from '../src/engine/runner.ts';
import { validateWorkflow } from '../src/engine/schema.ts';
import { activeUsersByEmail } from '../src/mocks/answer-key.ts';
import { startMocks, type MockApps } from '../src/mocks/index.ts';
import { calmMess } from '../src/mocks/mess.ts';
import { startRecording } from '../src/recorder/record.ts';
import { totp } from '../src/shared/totp.ts';
import { tempDir } from './helpers.ts';

let mocks: MockApps;
let browser: Browser;
let artifacts: { dir: string; cleanup: () => Promise<void> };

before(async () => {
  mocks = await startMocks();
  browser = await chromium.launch();
  artifacts = await tempDir('rec');
});
after(async () => {
  await browser.close();
  await mocks.close();
  await artifacts.cleanup();
  await closeAllPools();
});

const people = [
  { email: 'keep.me@example.test', name: 'Keep Me', role: 'Employee' },
  { email: 'remove.me@example.test', name: 'Remove Me', role: 'Manager' },
  { email: 'other.one@example.test', name: 'Other One', role: 'Employee' },
];

test('records an HR removal and replays it on a fresh tenant with different random ids', async () => {
  const t = await mocks.createTenant('hr', { mess: calmMess({ randomIds: true, iframeLogin: true }), users: people });
  const rec = await startRecording({ url: `${t.baseUrl}/login`, app: 'hr', kind: 'remove_user', headless: true, browser });
  const p = rec.page;
  const f = p.frameLocator("iframe[title='Sign in']");
  await f.getByLabel('Work email').fill(t.admin.email);
  await f.getByLabel('Password').fill(t.admin.password);
  await f.getByRole('button', { name: 'Sign in' }).click();
  await p.waitForURL('**/dashboard');
  await p.getByRole('link', { name: 'People' }).click();
  await p.getByRole('row').filter({ hasText: 'remove.me@example.test' }).getByRole('button', { name: 'Remove' }).click();
  await p.getByRole('dialog').getByRole('button', { name: 'Remove person' }).click();
  await p.getByRole('status').waitFor();
  const wf = await rec.stop();

  const v = validateWorkflow(wf);
  assert.ok(v.ok, JSON.stringify(v));
  const json = JSON.stringify(wf);
  assert.ok(!json.includes(t.admin.password), 'password never recorded');
  assert.ok(!json.includes(t.admin.email), 'login username never recorded');
  assert.deepEqual(wf.secrets.sort(), ['password', 'username']);
  assert.equal(wf.login[0].op, 'navigate');
  assert.equal((wf.login[0] as { url: string }).url, '{{baseUrl}}/login', 'base URL templated');
  assert.equal(wf.params.email?.example, 'remove.me@example.test', 'the row identity became a param');
  assert.ok(json.includes('{{params.email}}'));
  for (const s of [...wf.login.slice(1), ...wf.steps]) {
    const target = (s as { target?: Record<string, unknown> }).target;
    if (!target) continue;
    const strategies = ['role', 'label', 'placeholder', 'text', 'testId', 'css'].filter((k) => target[k] !== undefined);
    assert.ok(strategies.length >= 2, `step ${s.op} has fallbacks: ${strategies}`);
    assert.ok(!/#f[0-9a-f]{8}/.test(String(target.css)), 'no random ids in CSS');
  }

  // Replay on a different tenant: new random ids, a consent wall, and different people around.
  const t2 = await mocks.createTenant('hr', { mess: calmMess({ randomIds: true, iframeLogin: true, cookieBanner: { delayMs: 200 } }), users: [...people].reverse() });
  const r = await runWorkflow({
    workflow: v.ok ? v.workflow : wf, baseUrl: t2.baseUrl, browser, artifactsDir: artifacts.dir,
    params: { email: 'remove.me@example.test' }, secrets: { username: t2.admin.email, password: t2.admin.password },
  });
  assert.equal(r.status, 'succeeded', r.message);
  assert.equal((await activeUsersByEmail('hr', t2.tenantId, 'remove.me@example.test')).length, 0);
  assert.equal((await activeUsersByEmail('hr', t2.tenantId, 'keep.me@example.test')).length, 1);
});

test('six one-digit code boxes become a single {{totp}} step, and the recording replays', async () => {
  const t = await mocks.createTenant('directory', { mess: calmMess({ iframeLogin: true, totp: true, randomIds: true }), users: people });
  const rec = await startRecording({ url: `${t.baseUrl}/login`, app: 'directory', kind: 'sign_in', headless: true, browser });
  const f = rec.page.frameLocator("iframe[title='Sign in to Directory']");
  await f.getByLabel('Username').fill(t.admin.email);
  await f.getByLabel('Password').fill(t.admin.password);
  await f.getByRole('button', { name: 'Next' }).click();
  await f.getByLabel('Digit 1').click();
  const code = totp(t.admin.totpSecret!);
  await rec.page.keyboard.type(code, { delay: 20 });
  await f.getByRole('button', { name: 'Verify' }).click();
  await rec.page.waitForURL('**/home');
  const wf = await rec.stop();
  const codeSteps = wf.login.filter((s) => s.op === 'fill' && s.value === '{{totp}}');
  assert.equal(codeSteps.length, 1);
  assert.equal((codeSteps[0] as { mode?: string }).mode, 'type');
  assert.ok(!JSON.stringify(wf).includes(code), 'the code itself was not recorded');
  assert.ok(wf.secrets.includes('totpSecret'));

  const t2 = await mocks.createTenant('directory', { mess: calmMess({ iframeLogin: true, totp: true, randomIds: true }), users: [] });
  const v = validateWorkflow(wf);
  assert.ok(v.ok);
  const r = await runWorkflow({
    workflow: v.ok ? v.workflow : wf, baseUrl: t2.baseUrl, browser, artifactsDir: artifacts.dir,
    secrets: { username: t2.admin.email, password: t2.admin.password, totpSecret: t2.admin.totpSecret! },
  });
  assert.equal(r.status, 'succeeded', r.message);
});
