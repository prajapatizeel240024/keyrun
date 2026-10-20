// The automation engine against the real mock apps: strategy fallbacks, retries, interstitials,
// forced re-login, idempotent lifecycle tasks, failure artifacts, and secrets kept out of traces.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { closeAllPools } from '../src/db/pool.ts';
import { runWorkflow, type RunInput } from '../src/engine/runner.ts';
import { parseWorkflow, type Workflow } from '../src/engine/schema.ts';
import { loadWorkflow } from '../src/engine/workflows.ts';
import { activeUsersByEmail, auditCount } from '../src/mocks/answer-key.ts';
import { startMocks, type MockApps } from '../src/mocks/index.ts';
import { calmMess, type AppId, type Mess } from '../src/mocks/mess.ts';
import { encodings, tempDir, unzipEntries } from './helpers.ts';

let mocks: MockApps;
let browser: Browser;
let artifacts: { dir: string; cleanup: () => Promise<void> };

before(async () => {
  mocks = await startMocks();
  browser = await chromium.launch();
  artifacts = await tempDir('artifacts');
});
after(async () => {
  await browser.close();
  await mocks.close();
  await artifacts.cleanup();
  await closeAllPools();
});

const people = [
  { email: 'ada.laine@example.test', name: 'Ada Laine', role: 'Employee' },
  { email: 'bilal.haddad@example.test', name: 'Bilal Haddad', role: 'Manager' },
];

async function tenant(app: AppId, mess: Partial<Mess>, users = people) {
  const structural: Partial<Mess> = app === 'hr' ? { iframeLogin: true } : app === 'helpdesk' ? { totp: true } : { iframeLogin: true, totp: true };
  return mocks.createTenant(app, { mess: calmMess({ ...structural, ...mess }), users });
}

async function run(app: AppId, kind: string, t: Awaited<ReturnType<typeof tenant>>, extra: Partial<RunInput> = {}) {
  return runWorkflow({
    workflow: loadWorkflow(app, kind),
    baseUrl: t.baseUrl,
    params: { email: 'new.person@example.test', name: 'New Person', role: app === 'hr' ? 'Manager' : app === 'helpdesk' ? 'Supervisor' : 'Editor' },
    secrets: { username: t.admin.email, password: t.admin.password, totpSecret: t.admin.totpSecret ?? undefined, newPassword: 'Fresh-Passw0rd!-91' },
    artifactsDir: artifacts.dir,
    browser,
    ...extra,
  });
}

test('falls back to the next strategy when the first one stops matching', async () => {
  // Label drift renames "Create person" to "Save"; the role strategy misses and CSS takes over.
  const t = await tenant('hr', { randomIds: true, labelDrift: true });
  const r = await run('hr', 'create_user', t);
  assert.equal(r.status, 'succeeded', r.message);
  const create = r.steps.find((s) => s.path === 'steps[7]');
  assert.equal(create?.strategy, 'css');
  assert.equal(create?.fallback, true);
  assert.equal((await activeUsersByEmail('hr', t.tenantId, 'new.person@example.test')).length, 1);
});

test('waits with backoff for a slow single-page app', async () => {
  const t = await tenant('helpdesk', { latency: { minMs: 900, maxMs: 1800, spikeChance: 0, spikeMs: 0 } });
  const r = await run('helpdesk', 'create_user', t);
  assert.equal(r.status, 'succeeded', r.message);
  assert.ok(r.steps.some((s) => (s.attempts ?? 1) > 1), 'at least one step needed retries');
});

test('dismisses a consent wall that shows up late, while a slow page is still loading', async () => {
  // Deterministic on any machine: the wall appears 300 ms after the page loads, and the sign-in
  // API alone takes at least a second, so the wall is always on screen while the engine waits.
  // (An earlier version used a fast app and a 250 ms delay; on a fast laptop the run could
  // finish before the wall ever appeared.)
  const t = await tenant('helpdesk', { cookieBanner: { delayMs: 300 }, latency: { minMs: 1000, maxMs: 1200, spikeChance: 0, spikeMs: 0 } });
  const r = await run('helpdesk', 'sign_in', t);
  assert.equal(r.status, 'succeeded', r.message);
  assert.equal(r.interstitials.cookie_banner, 1);
});

test('signs in again after a session-expired interstitial and resumes at the checkpoint', async () => {
  for (const app of ['hr', 'helpdesk', 'directory'] as const) {
    const t = await tenant(app, { sessionExpiry: { afterRequests: 2 } });
    const r = await run(app, 'create_user', t);
    assert.equal(r.status, 'succeeded', `${app}: ${r.message}`);
    assert.equal(r.relogins, 1, app);
    assert.equal(r.interstitials.session_expired, 1, app);
    assert.equal((await activeUsersByEmail(app, t.tenantId, 'new.person@example.test')).length, 1, `${app}: exactly one user`);
  }
});

test('lifecycle tasks are idempotent: create only if missing, remove only if present', async () => {
  // HR happily stores duplicates, so a non-idempotent engine would show up here.
  const t = await tenant('hr', { pageSize: 5 }, Array.from({ length: 12 }, (_, i) => ({ email: `p${i}@example.test`, name: `Person ${i}`, role: 'Employee' })));
  const first = await run('hr', 'create_user', t);
  const second = await run('hr', 'create_user', t);
  assert.equal(first.status, 'succeeded');
  assert.equal(second.status, 'noop');
  assert.equal((await activeUsersByEmail('hr', t.tenantId, 'new.person@example.test')).length, 1);
  const rm1 = await run('hr', 'remove_user', t);
  const rm2 = await run('hr', 'remove_user', t);
  assert.equal(rm1.status, 'succeeded');
  assert.equal(rm2.status, 'noop');
  assert.equal(await auditCount('hr', t.tenantId, 'user.create'), 1);
  assert.equal(await auditCount('hr', t.tenantId, 'user.remove'), 1);
});

test('finds a user several pages deep', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ email: `p${i}@example.test`, name: `Person ${i}`, role: 'Agent' }));
  const t = await tenant('helpdesk', { pageSize: 6 }, many);
  const r = await run('helpdesk', 'remove_user', t, { params: { email: 'p2@example.test' } });
  assert.equal(r.status, 'succeeded', r.message);
  assert.match(r.steps.find((s) => s.op === 'findInPages')?.info ?? '', /page 5/);
  assert.equal((await activeUsersByEmail('helpdesk', t.tenantId, 'p2@example.test')).length, 0);
});

test('types a TOTP code into six auto-advancing boxes', async () => {
  const t = await tenant('directory', { randomIds: true });
  const r = await run('directory', 'sign_in', t);
  assert.equal(r.status, 'succeeded', r.message);
});

test('a failure leaves a screenshot and a trace on disk, with no secret inside the trace', async () => {
  const t = await tenant('hr', {});
  const wf: Workflow = loadWorkflow('hr', 'rotate_password');
  // Break the workflow after the secrets have been typed: the final assert can never pass.
  const broken = parseWorkflow({ ...wf, steps: [...wf.steps.slice(0, -1), { op: 'assert', target: { text: 'This text never appears' }, timeoutMs: 1500 }] });
  const r = await run('hr', 'rotate_password', t, { workflow: broken });
  assert.equal(r.status, 'failed');
  assert.equal(r.failure?.reason, 'assertion_failed');
  assert.ok(r.artifacts?.screenshot, 'screenshot saved');
  const files = await readdir(r.artifacts!.dir);
  assert.ok(files.includes('failure.png'));
  assert.ok(r.artifacts!.traces.length >= 1, 'trace saved');
  const secrets = [t.admin.password, 'Fresh-Passw0rd!-91'];
  let bytes = 0;
  for (const tr of r.artifacts!.traces) {
    for (const [name, content] of unzipEntries(await readFile(tr))) {
      bytes += content.length;
      const text = content.toString('latin1');
      for (const s of secrets) for (const enc of encodings(s)) assert.ok(!text.includes(enc), `${path.basename(tr)}/${name} contains a secret`);
    }
  }
  assert.ok(bytes > 10_000, 'the trace is real, not empty');
});

test('refuses to type a secret into a page outside the credential origins', async () => {
  const t = await tenant('hr', {});
  const other = mocks.origins.helpdesk;
  const evil = parseWorkflow({
    id: 'evil', app: 'hr', kind: 'sign_in', version: 1, description: 'phish', params: {}, secrets: ['password'],
    login: [{ op: 'navigate', url: `${other}/t/${t.tenantId}/` }, { op: 'fill', target: { css: 'body' }, value: '{{secrets.password}}' }],
    steps: [],
  });
  const r = await run('hr', 'sign_in', t, { workflow: evil, allowedOrigins: [mocks.origins.hr] });
  assert.equal(r.status, 'failed');
  assert.equal(r.failure?.reason, 'secret_origin_blocked');
});

test('refuses to navigate anywhere but loopback', async () => {
  const t = await tenant('hr', {});
  const wf = parseWorkflow({ id: 'x', app: 'hr', kind: 'sign_in', version: 1, description: 'x', params: {}, secrets: [], login: [{ op: 'navigate', url: 'https://example.com/' }], steps: [] });
  const r = await run('hr', 'sign_in', t, { workflow: wf });
  assert.equal(r.failure?.reason, 'non_loopback_url');
});

test('reports an ambiguous target instead of clicking a random match', async () => {
  const t = await tenant('hr', {});
  const wf = loadWorkflow('hr', 'sign_in');
  const amb = parseWorkflow({ ...wf, steps: [{ op: 'navigate', url: '{{baseUrl}}/people' }, { op: 'click', target: { role: { role: 'button', name: 'Remove' } }, timeoutMs: 1200 }] });
  const r = await run('hr', 'sign_in', t, { workflow: amb });
  assert.equal(r.failure?.reason, 'ambiguous_element');
});

test('a click swallowed by an overlay is repeated once, but only if the page did nothing', async () => {
  // A page whose first press on "Next" pops an overlay that eats the click (Playwright still
  // reports the click as done), the way a consent wall did once in the 600-run eval.
  const app = express();
  let posts = 0;
  app.post('/save', (_req, res) => {
    posts++;
    res.send('<h2>Saved</h2>');
  });
  app.get('/', (_req, res) => {
    res.send(`<!doctype html><button id="go">Next</button><form method="post" action="/save"><button>Save</button></form><div id="out"></div>
      <div id="ov" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.1)"></div>
      <script>
        var first = true;
        go.addEventListener('pointerdown', function () { if (first) { first = false; ov.style.display = 'block'; setTimeout(function () { ov.style.display = 'none'; }, 400); } });
        go.addEventListener('click', function () { out.innerHTML = '<h2>Step two</h2>'; });
      </script>`);
  });
  const srv: Server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  try {
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const wf = parseWorkflow({
      id: 'x', app: 'hr', kind: 'k', version: 1, description: 'x', params: {}, secrets: [], login: [],
      steps: [
        { op: 'navigate', url: '{{baseUrl}}/' },
        { op: 'click', target: { role: { role: 'button', name: 'Next' } } },
        { op: 'wait', target: { role: { role: 'heading', name: 'Step two' } } },
        { op: 'click', target: { role: { role: 'button', name: 'Save' } } },
        { op: 'wait', target: { role: { role: 'heading', name: 'Nothing like this' } }, timeoutMs: 5000 },
      ],
    });
    const r = await runWorkflow({ workflow: wf, baseUrl: base, browser, artifactsDir: artifacts.dir });
    assert.equal(r.reclicks, 1, 'the swallowed Next click was repeated');
    assert.equal(r.failure?.step, 'steps[4]', 'got past step two, then failed where expected');
    assert.equal(posts, 1, 'the Save click caused a request, so it was never repeated');
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});
