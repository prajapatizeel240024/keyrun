// The automation engine against the real mock apps: strategy fallbacks, retries, interstitials,
// forced re-login, idempotent lifecycle tasks, failure artifacts, and secrets kept out of traces.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('a late 401 from the expired session cannot send the app back to sign-in after a re-login', async () => {
  // A single-page app that, like Mock Helpdesk, shows a modal when the session expires and jumps
  // to its login page on any other 401. The first session dies on the list call while a slow call
  // from the home page is still out; the server holds that call until the list has loaded under
  // the new session, then answers 401. If the re-login reuses the old page, that late answer
  // throws the app back to sign-in with no "expired" text to see (CI caught this once in 600 runs).
  const app = express();
  const live = new Set<string>();
  let sessions = 0;
  let expired = false;
  let answerStale: (() => void) | undefined;
  const sid = (cookie = '') => /sid=(\w+)/.exec(cookie)?.[1] ?? '';
  app.post('/api/login', (_req, res) => {
    const s = `s${++sessions}`;
    live.add(s);
    res.cookie('sid', s).json({});
  });
  app.get('/api/me', (req, res) => {
    const s = sid(req.headers.cookie);
    const answer = () => (live.has(s) ? res.json({}) : res.status(401).json({ error: 'unauthenticated' }));
    if (s === 's1') answerStale = answer;
    else answer();
  });
  app.get('/api/list', (req, res) => {
    const s = sid(req.headers.cookie);
    if (!live.has(s)) {
      res.status(401).json({ error: 'unauthenticated' });
    } else if (!expired) {
      expired = true;
      live.delete(s);
      res.status(401).json({ error: 'session_expired' });
    } else {
      res.json({});
      setTimeout(() => answerStale?.(), 100);
    }
  });
  app.get('/', (_req, res) => {
    res.send(`<!doctype html><div id="root"></div><script>
      function api(path, method) {
        return fetch(path, { method: method || 'GET' }).then(function (r) { return r.json().then(function (j) {
          if (r.status === 401 && j.error === 'session_expired') { expiredModal(); throw 0; }
          if (r.status === 401) { location.hash = '#/login'; throw 0; }
        }); });
      }
      function expiredModal() {
        var d = document.createElement('div');
        d.innerHTML = '<div role="alertdialog" aria-label="Signed out"><p>Session expired</p><button>Log in again</button></div>';
        d.querySelector('button').onclick = function () { d.remove(); location.hash = '#/login'; };
        document.body.appendChild(d);
      }
      var routes = {
        login: function () {
          root.innerHTML = '<button>Continue</button>';
          root.firstChild.onclick = function () { api('/api/login', 'POST').then(function () { location.hash = '#/home'; }, function () {}); };
        },
        home: function () {
          root.innerHTML = '<nav aria-label="Sidebar">Home</nav>';
          api('/api/me').catch(function () {});
        },
        list: function () {
          root.innerHTML = '<nav aria-label="Sidebar">List</nav>';
          api('/api/list').then(function () { root.innerHTML += '<h1>Agents</h1>'; }, function () {});
        },
      };
      function route() { (routes[location.hash.slice(2)] || routes.home)(); }
      addEventListener('hashchange', route);
      route();
    </script>`);
  });
  const srv: Server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  try {
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const wf = parseWorkflow({
      id: 'x', app: 'helpdesk', kind: 'k', version: 1, description: 'x', params: {}, secrets: [],
      login: [
        { op: 'navigate', url: '{{baseUrl}}/#/login' },
        { op: 'click', target: { role: { role: 'button', name: 'Continue' } } },
        { op: 'wait', target: { role: { role: 'navigation', name: 'Sidebar' } } },
      ],
      steps: [
        { op: 'navigate', url: '{{baseUrl}}/#/list', checkpoint: true },
        { op: 'wait', target: { role: { role: 'heading', name: 'Agents' } }, timeoutMs: 5000 },
        { op: 'wait', ms: 600 },
        { op: 'assert', target: { role: { role: 'heading', name: 'Agents' } }, timeoutMs: 1000 },
      ],
    });
    const r = await runWorkflow({ workflow: wf, baseUrl: base, browser, artifactsDir: artifacts.dir });
    assert.equal(r.status, 'succeeded', `${r.failure?.step}: ${r.message}`);
    assert.equal(r.relogins, 1);
    assert.equal(r.interstitials.session_expired, 1);
    assert.ok(answerStale, 'the first session really had a call still in flight');
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test('a session that expires during sign-in itself is signed in again from a blank page', async () => {
  // HR ends the session on its very first signed-in page, so the expiry shows up while the login
  // steps are still running: the retry loop inside the login handles it, not the checkpoint
  // resume. The main frame's navigations show the blank page in between.
  const t = await tenant('hr', { sessionExpiry: { afterRequests: 1 } });
  const seen: string[] = [];
  const spy = {
    newContext: async (opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await browser.newContext(opts);
      ctx.on('page', (p) => p.on('framenavigated', (f) => {
        if (f === p.mainFrame()) seen.push(f.url());
      }));
      return ctx;
    },
  } as unknown as Browser;
  const r = await run('hr', 'sign_in', t, { browser: spy, onStep: (l) => seen.push(`step ${l.path}`) });
  assert.equal(r.status, 'succeeded', r.message);
  assert.equal(r.relogins, 1);
  assert.equal(r.interstitials.session_expired, 1);
  const blank = seen.indexOf('about:blank');
  assert.ok(blank > 0, `the page was reset before signing in again: ${seen.join(' → ')}`);
  assert.ok(!seen.slice(0, blank).includes('step login[4]'), 'the reset came from the login retry: sign-in had not finished yet');
  assert.ok(seen.slice(blank).includes('step login[0]'), 'the login steps ran again after it');
});

test('a click that saves a change is repeated once if a dialog swallowed it, and the server saves once', async () => {
  // The first press on "Save password" pops a "What's new" dialog over the page, so the click
  // lands on the dialog and never reaches the form, while Playwright reports it as done. That is
  // how directory.rotate_password #45 was lost in round 6. No request went out (the dialog's
  // beacon doesn't count, like the mock popup's) and the engine had to dismiss the dialog: the
  // proof it needs before repeating a click that saves a change.
  const app = express();
  let saves = 0;
  app.post('/save', (_req, res) => {
    saves++;
    res.send('<!doctype html><div role="status">Password changed</div>');
  });
  app.post('/beacon', (_req, res) => {
    res.status(204).end();
  });
  app.get('/', (_req, res) => {
    res.send(`<!doctype html><form method="post" action="/save"><button id="save">Save password</button></form>
      <div id="news" role="dialog" aria-label="What's new" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.2)">
        <button id="dismiss">Dismiss</button></div>
      <script>
        var first = true;
        save.addEventListener('pointerdown', function () {
          if (first) { first = false; news.style.display = 'block'; navigator.sendBeacon('/beacon'); }
        });
        dismiss.addEventListener('click', function () { news.style.display = 'none'; });
      </script>`);
  });
  const srv: Server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  try {
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const wf = parseWorkflow({
      id: 'x', app: 'directory', kind: 'k', version: 1, description: 'x', params: {}, secrets: [], login: [],
      steps: [
        { op: 'navigate', url: '{{baseUrl}}/' },
        { op: 'click', target: { role: { role: 'button', name: 'Save password' } }, effect: true },
        { op: 'assert', target: { role: { role: 'status' } }, text: 'Password changed', timeoutMs: 8000 },
      ],
    });
    const r = await runWorkflow({ workflow: wf, baseUrl: base, browser, artifactsDir: artifacts.dir });
    assert.equal(r.status, 'succeeded', `${r.failure?.step}: ${r.message}`);
    assert.equal(r.reclicks, 1, 'the swallowed click was repeated once');
    assert.equal(r.interstitials.announcement, 1, 'the dialog was dismissed');
    assert.equal(saves, 1, 'the server saved exactly once');
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test('a click that saves a change is never repeated once it sent anything, even if a popup follows', async () => {
  // This time the click does reach the server, by fetch or by a WebSocket message, and the
  // "What's new" dialog only pops up afterwards. Everything else looks like a swallowed click;
  // the traffic says it was not, so the engine must not click again.
  const app = express();
  let saves = 0;
  let frames = 0;
  const sockets: Array<{ destroy(): void }> = [];
  app.post('/save', (_req, res) => {
    saves++;
    res.status(204).end();
  });
  app.get('/', (_req, res) => {
    res.send(`<!doctype html><button id="save">Save password</button><p id="out"></p>
      <div id="news" role="dialog" aria-label="What's new" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.2)">
        <button id="dismiss">Dismiss</button></div>
      <script>
        var ws = location.search === '?via=ws' ? new WebSocket('ws://' + location.host + '/ws') : null;
        if (ws) ws.onopen = function () { out.textContent = 'Connected'; };
        save.addEventListener('click', function () {
          if (ws) ws.send('save'); else fetch('/save', { method: 'POST' });
          setTimeout(function () { news.style.display = 'block'; }, 50);
        });
        dismiss.addEventListener('click', function () { news.style.display = 'none'; });
      </script>`);
  });
  const srv: Server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  // Just enough of a WebSocket server to accept the connection and count text frames.
  srv.on('upgrade', (req, socket) => {
    sockets.push(socket);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (buf: Buffer) => {
      if ((buf[0] & 0x0f) === 1) frames++;
    });
  });
  try {
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    for (const via of ['fetch', 'ws'] as const) {
      const wf = parseWorkflow({
        id: 'x', app: 'directory', kind: 'k', version: 1, description: 'x', params: {}, secrets: [], login: [],
        steps: [
          { op: 'navigate', url: `{{baseUrl}}/?via=${via}` },
          { op: 'wait', target: { text: via === 'ws' ? 'Connected' : 'Save password' } },
          { op: 'click', target: { role: { role: 'button', name: 'Save password' } }, effect: true },
          { op: 'assert', target: { role: { role: 'status' } }, text: 'Password changed', timeoutMs: 5000 },
        ],
      });
      const r = await runWorkflow({ workflow: wf, baseUrl: base, browser, artifactsDir: artifacts.dir });
      assert.equal(r.reclicks, 0, `${via}: the click was not repeated`);
      assert.equal(r.failure?.step, 'steps[3]', `${via}: the run waited for the success message and failed there`);
      assert.equal(r.interstitials.announcement, 1, `${via}: the popup was dismissed, so only the traffic stopped a repeat`);
    }
    assert.equal(saves, 1, 'one save by fetch');
    assert.equal(frames, 1, 'one save over the WebSocket');
  } finally {
    for (const s of sockets) s.destroy();
    srv.closeAllConnections();
    srv.close();
  }
});

test('a click that saves a change is not repeated without proof it was swallowed', async () => {
  // The two other parts of the proof. "plain": an overlay with no role eats the click, so there is
  // nothing for the engine to dismiss. "status": a "What's new" dialog is dismissed, but the next
  // step's target (a status message) did show up, with other text. "twice": the same, with two
  // status messages, which still counts as the target showing up. None may click again.
  const app = express();
  let saves = 0;
  app.post('/save', (_req, res) => {
    saves++;
    res.send('<!doctype html><div role="status">Password changed</div>');
  });
  app.get('/', (_req, res) => {
    res.send(`<!doctype html><form method="post" action="/save"><button id="save">Save password</button></form>
      <div id="ov" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.1)"></div>
      <div id="news" role="dialog" aria-label="What's new" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.2)">
        <button id="dismiss">Dismiss</button></div>
      <script>
        var first = true;
        save.addEventListener('pointerdown', function () {
          if (!first) return;
          first = false;
          if (location.search === '?mode=plain') {
            ov.style.display = 'block';
            setTimeout(function () { ov.style.display = 'none'; }, 400);
          } else {
            news.style.display = 'block';
            for (var i = 0; i < (location.search === '?mode=twice' ? 2 : 1); i++) {
              var s = document.createElement('div');
              s.setAttribute('role', 'status');
              s.textContent = 'Saving…';
              document.body.appendChild(s);
            }
          }
        });
        dismiss.addEventListener('click', function () { news.style.display = 'none'; });
      </script>`);
  });
  const srv: Server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  try {
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    for (const mode of ['plain', 'status', 'twice'] as const) {
      const wf = parseWorkflow({
        id: 'x', app: 'directory', kind: 'k', version: 1, description: 'x', params: {}, secrets: [], login: [],
        steps: [
          { op: 'navigate', url: `{{baseUrl}}/?mode=${mode}` },
          { op: 'click', target: { role: { role: 'button', name: 'Save password' } }, effect: true },
          { op: 'assert', target: { role: { role: 'status' } }, text: 'Password changed', timeoutMs: 5000 },
        ],
      });
      const r = await runWorkflow({ workflow: wf, baseUrl: base, browser, artifactsDir: artifacts.dir });
      assert.equal(r.reclicks, 0, `${mode}: the click was not repeated`);
      assert.equal(r.failure?.step, 'steps[2]', `${mode}: the run failed waiting for the success message`);
    }
    assert.equal(saves, 0, 'nothing was saved');
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});
