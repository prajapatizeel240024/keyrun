// Mock Helpdesk: a slow single-page app. Every API call waits (with occasional long spikes),
// ids change on every render, labels are not wired to inputs, sign-in has a TOTP step with
// replay protection, the session can die mid-flow behind an in-app modal, and lifecycle
// actions hide behind a kebab menu plus a confirm dialog.
import type { Request, Response, NextFunction } from 'express';
import type express from 'express';
import {
  audit, checkPassword, consentOverlay, endSession, forgetTenant, getSession, hashPassword, latencyFor, makeIds,
  mockServer, mocksDb, passwordPolicyError, promoteSession, shouldExpire, sleep, startSession, type TenantRequest,
} from './core.ts';
import { verifyTotp } from '../shared/totp.ts';

const APP = 'helpdesk' as const;
const ROLES = ['Agent', 'Supervisor', 'Admin'];

export function helpdeskApp(): express.Express {
  return mockServer(APP, (r) => {
    // Every API call is slow.
    r.use('/api', async (req, _res, next) => {
      await sleep(latencyFor((req as TenantRequest).tenant.mess));
      next();
    });

    const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
      const t = (req as TenantRequest).tenant;
      const s = getSession(APP, req, t.id);
      if (!s || s.s.stage !== 'authed') {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      if (await shouldExpire(APP, t)) {
        endSession(s.sid);
        res.status(401).json({ error: 'session_expired' });
        return;
      }
      next();
    };

    r.post('/api/login', async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const { email, password } = req.body ?? {};
      if (String(email ?? '').toLowerCase() !== t.admin_email || !checkPassword(String(password ?? ''), t.admin_password_hash)) {
        await audit(APP, t.id, 'login.fail', email);
        res.status(401).json({ error: 'invalid_credentials' });
        return;
      }
      startSession(APP, res, t.id, t.mess.totp ? 'password_ok' : 'authed');
      if (!t.mess.totp) await audit(APP, t.id, 'login.success');
      res.json({ next: t.mess.totp ? '2fa' : 'home' });
    });

    r.post('/api/2fa', async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const s = getSession(APP, req, t.id);
      if (!s || s.s.stage !== 'password_ok') {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      // Read the counter fresh: replay protection must not trust a cached tenant row.
      const row = (await mocksDb().query(`select totp_secret, totp_last_counter from helpdesk.tenants where id = $1`, [t.id])).rows[0];
      const used = verifyTotp(row.totp_secret, String(req.body?.code ?? ''), row.totp_last_counter);
      if (used === null) {
        await audit(APP, t.id, 'totp.fail');
        res.status(401).json({ error: 'invalid_code' });
        return;
      }
      await mocksDb().query(`update helpdesk.tenants set totp_last_counter = $2 where id = $1`, [t.id, used]);
      forgetTenant(APP, t.id);
      promoteSession(s.sid);
      await audit(APP, t.id, 'login.success');
      res.json({ next: 'home' });
    });

    r.get('/api/me', requireAuth, (req, res) => {
      const t = (req as TenantRequest).tenant;
      res.json({ name: t.admin_name, email: t.admin_email });
    });

    r.get('/api/roles', requireAuth, (_req, res) => {
      res.json(ROLES);
    });

    r.get('/api/agents', requireAuth, async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const size = t.mess.pageSize;
      const total = (await mocksDb().query(`select count(*)::int as n from helpdesk.users where tenant_id = $1 and status = 'active'`, [t.id])).rows[0].n;
      const pages = Math.max(1, Math.ceil(total / size));
      const page = Math.min(Math.max(1, Number(req.query.page) || 1), pages);
      const items = (await mocksDb().query(
        `select id, email, name, role from helpdesk.users where tenant_id = $1 and status = 'active'
         order by created_at desc, id desc limit $2 offset $3`,
        [t.id, size, (page - 1) * size],
      )).rows;
      res.json({ items, page, pages, total });
    });

    r.post('/api/agents', requireAuth, async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const { name, email, role } = req.body ?? {};
      if (!name || !email || !ROLES.includes(role)) {
        res.status(400).json({ error: 'Please fill in every field.' });
        return;
      }
      const dupe = await mocksDb().query(
        `select 1 from helpdesk.users where tenant_id = $1 and lower(email) = lower($2) and status = 'active'`, [t.id, email]);
      if (dupe.rowCount) {
        res.status(409).json({ error: 'An agent with this email already exists.' });
        return;
      }
      await mocksDb().query(`insert into helpdesk.users (tenant_id, email, name, role) values ($1, lower($2), $3, $4)`, [t.id, email, name, role]);
      await audit(APP, t.id, 'user.create', String(email).toLowerCase());
      res.json({ ok: true });
    });

    r.post('/api/agents/:id/deactivate', requireAuth, async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const u = await mocksDb().query(
        `update helpdesk.users set status = 'deactivated', updated_at = now() where tenant_id = $1 and id = $2 and status = 'active' returning email, name`,
        [t.id, Number(req.params.id)],
      );
      if (u.rows[0]) await audit(APP, t.id, 'user.remove', u.rows[0].email);
      res.json({ ok: true, name: u.rows[0]?.name ?? null });
    });

    r.post('/api/password', requireAuth, async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const { current, next, confirm } = req.body ?? {};
      let error: string | null = null;
      if (!checkPassword(String(current ?? ''), t.admin_password_hash)) error = 'Current password is incorrect.';
      else if (next !== confirm) error = 'Passwords do not match.';
      else if (next === current) error = 'New password must be different.';
      else error = passwordPolicyError(String(next ?? ''));
      if (error) {
        res.status(400).json({ error });
        return;
      }
      await mocksDb().query(`update helpdesk.tenants set admin_password_hash = $2 where id = $1`, [t.id, hashPassword(next)]);
      forgetTenant(APP, t.id);
      await audit(APP, t.id, 'password.change');
      res.json({ ok: true });
    });

    r.post('/api/logout', (req, res) => {
      const t = (req as TenantRequest).tenant;
      const s = getSession(APP, req, t.id);
      if (s) endSession(s.sid);
      res.json({ ok: true });
    });

    r.get('/', (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      res.send(shell(t.id, t.mess.randomIds, ids.salt, consentOverlay(APP, t.id, t.mess, ids), t.mess.labelDrift, t.mess.survey?.delayMs ?? null));
    });
  });
}

function shell(tenantId: string, randomIds: boolean, salt: string, overlay: string, drift: boolean, surveyDelayMs: number | null): string {
  const c = (n: string) => (randomIds ? `${n}-${salt}` : n);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Helpdesk</title>
<style>
  body{margin:0;font:14px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif;background:#f6f7fb;color:#1d2433}
  .${c('shell')}{display:flex;min-height:100vh}
  .${c('side')}{width:190px;background:#1d2433;color:#cfd6e6;padding:18px 14px}
  .${c('side')} a{display:block;color:#cfd6e6;text-decoration:none;padding:6px 8px;border-radius:6px}
  .${c('side')} a:hover{background:#2b3448}
  .${c('content')}{flex:1;padding:28px 36px}
  .${c('card')}{background:#fff;border:1px solid #e3e6ef;border-radius:10px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:14px;position:relative}
  .${c('muted')}{color:#6b7385}
  .${c('lbl')}{font-weight:600;margin-top:12px}
  input,select{padding:8px 10px;border:1px solid #c9cfdc;border-radius:8px;font:inherit;width:280px;display:block}
  .${c('btn')}{margin-top:14px;padding:8px 16px;border-radius:8px;border:0;background:#4f46e5;color:#fff;font:inherit;cursor:pointer}
  .${c('btn')}[disabled]{opacity:.5;cursor:wait}
  .${c('ghost')}{background:#fff;color:#1d2433;border:1px solid #c9cfdc}
  .${c('skel')}{height:52px;border-radius:10px;margin-bottom:10px;background:linear-gradient(90deg,#eceff5,#f7f8fb,#eceff5);background-size:200% 100%;animation:sk 1.2s infinite}
  @keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}
  .${c('menu')}{position:absolute;right:12px;top:44px;background:#fff;border:1px solid #c9cfdc;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.12);z-index:5}
  .${c('menu')} button{display:block;width:100%;text-align:left;padding:8px 14px;border:0;background:none;font:inherit;cursor:pointer}
  .${c('back')}{position:fixed;inset:0;background:rgba(17,24,39,.45);display:flex;align-items:center;justify-content:center;z-index:100}
  .${c('dialog')}{background:#fff;border-radius:12px;padding:22px 24px;width:380px}
  .${c('toast')}{position:fixed;right:20px;bottom:20px;background:#1d2433;color:#fff;padding:10px 14px;border-radius:8px;z-index:200}
  .${c('alert')}{color:#b42318;margin-top:10px}
  .${c('ok')}{color:#067647;margin-top:10px}
</style></head>
<body><div id="root"></div>${overlay}
<script>
(function(){
  var T = '/t/${tenantId}';
  var RANDOM = ${randomIds ? 'true' : 'false'};
  // A/B copy test: the same buttons, different words.
  var L = ${drift ? `{ invite: 'Invite', deactivate: 'Yes, deactivate', change: 'Update' }` : `{ invite: 'Send invite', deactivate: 'Deactivate agent', change: 'Change password' }`};
  var SURVEY = ${surveyDelayMs === null ? 'null' : surveyDelayMs};
  var root = document.getElementById('root');
  function c(n){ return RANDOM ? n + '-${salt}' : n; }
  function rid(n){ return RANDOM ? 'r' + Math.random().toString(36).slice(2, 9) : n; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(ch){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]; }); }
  function Stop(){}
  var renderToken = 0;

  function api(method, path, body){
    return fetch(T + '/api' + path, { method: method, headers: body ? {'content-type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){
        if (r.status === 401 && j.error === 'session_expired') { showExpired(); throw new Stop(); }
        if (r.status === 401 && j.error === 'unauthenticated') { location.hash = '#/login'; throw new Stop(); }
        return { status: r.status, body: j };
      }); });
  }
  function ignoreStop(e){ if (!(e instanceof Stop)) throw e; }

  function toast(msg){
    var t = document.createElement('div'); t.className = c('toast'); t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function(){ t.remove(); }, 4000);
  }
  function showExpired(){
    if (document.querySelector('[data-expired]')) return;
    var b = document.createElement('div'); b.className = c('back'); b.setAttribute('data-expired', '1');
    var tid = rid('exp-title');
    b.innerHTML = '<div class="' + c('dialog') + '" role="alertdialog" aria-modal="true" aria-labelledby="' + tid + '">' +
      '<h2 id="' + tid + '" style="margin-top:0">Session expired</h2><p>For your security you were signed out. Please log in again to continue.</p>' +
      '<button class="' + c('btn') + '" type="button">Log in again</button></div>';
    b.querySelector('button').addEventListener('click', function(){ b.remove(); location.hash = '#/login'; });
    document.body.appendChild(b);
  }
  function layout(inner){
    return '<div class="' + c('shell') + '"><nav class="' + c('side') + '" aria-label="Sidebar"><div style="font-weight:700;color:#fff;margin-bottom:14px">Helpdesk</div>' +
      '<a href="#/home">Home</a><a href="#/agents">Agents</a><a href="#/settings/password">Settings</a></nav>' +
      '<main class="' + c('content') + '">' + inner + '</main></div>';
  }
  function skeleton(n){ var s = ''; for (var i = 0; i < n; i++) s += '<div class="' + c('skel') + '"></div>'; return layout(s); }

  var routes = {
    login: function(){
      var e = rid('email'), p = rid('pw');
      root.innerHTML = '<main class="' + c('content') + '" style="max-width:420px;margin:60px auto"><h1>Sign in to Helpdesk</h1>' +
        '<div class="' + c('lbl') + '">Email</div><input id="' + e + '" type="email" placeholder="you@company.com" autocomplete="username">' +
        '<div class="' + c('lbl') + '">Password</div><input id="' + p + '" type="password" placeholder="Password" autocomplete="current-password">' +
        '<button class="' + c('btn') + '" type="button">Continue</button><div data-msg></div></main>';
      var btn = root.querySelector('button');
      btn.addEventListener('click', function(){
        btn.disabled = true; btn.textContent = 'Signing in…';
        api('POST', '/login', { email: document.getElementById(e).value, password: document.getElementById(p).value }).then(function(r){
          if (r.status !== 200) { btn.disabled = false; btn.textContent = 'Continue'; root.querySelector('[data-msg]').innerHTML = '<div class="' + c('alert') + '" role="alert">Wrong email or password.</div>'; return; }
          location.hash = r.body.next === '2fa' ? '#/2fa' : '#/home';
        }).catch(ignoreStop);
      });
    },
    '2fa': function(){
      var id = rid('code');
      root.innerHTML = '<main class="' + c('content') + '" style="max-width:420px;margin:60px auto"><h1>Two-factor authentication</h1>' +
        '<p class="' + c('muted') + '">Enter the 6-digit code from your authenticator app.</p>' +
        '<input id="' + id + '" aria-label="Authentication code" inputmode="numeric" autocomplete="one-time-code" maxlength="6">' +
        '<button class="' + c('btn') + '" type="button">Verify</button><div data-msg></div></main>';
      var btn = root.querySelector('button');
      btn.addEventListener('click', function(){
        btn.disabled = true;
        api('POST', '/2fa', { code: document.getElementById(id).value }).then(function(r){
          btn.disabled = false;
          if (r.status !== 200) { root.querySelector('[data-msg]').innerHTML = '<div class="' + c('alert') + '" role="alert">That code didn\\'t work. Try again.</div>'; return; }
          location.hash = '#/home';
        }).catch(ignoreStop);
      });
    },
    home: function(token){
      root.innerHTML = skeleton(2);
      api('GET', '/me').then(function(r){
        if (token !== renderToken) return;
        root.innerHTML = layout('<h1>Hi ' + esc(r.body.name.split(' ')[0]) + '</h1><p class="' + c('muted') + '">Here is what is happening in your helpdesk today.</p>');
      }).catch(ignoreStop);
    },
    agents: function(token, q){
      var page = Number(q.page || 1);
      root.innerHTML = skeleton(4);
      api('GET', '/agents?page=' + page).then(function(r){
        if (token !== renderToken) return;
        var d = r.body;
        var items = d.items.map(function(a){
          return '<li class="' + c('card') + '"><div style="flex:1"><div style="font-weight:600">' + esc(a.name) + '</div><div class="' + c('muted') + '">' + esc(a.email) + '</div></div>' +
            '<span class="' + c('muted') + '">' + esc(a.role) + '</span>' +
            '<button type="button" class="' + c('ghost') + '" aria-label="Actions for ' + esc(a.email) + '" aria-haspopup="menu" data-kebab="' + a.id + '" data-name="' + esc(a.name) + '">⋯</button></li>';
        }).join('');
        root.innerHTML = layout('<div style="display:flex;justify-content:space-between;align-items:center"><h1>Agents</h1>' +
          '<button type="button" class="' + c('btn') + '" data-invite>Invite agent</button></div>' +
          '<ul aria-label="Agents" style="list-style:none;padding:0">' + items + '</ul>' +
          '<div style="display:flex;gap:10px;align-items:center">' +
          '<button type="button" class="' + c('ghost') + '" aria-label="Previous page" ' + (d.page <= 1 ? 'disabled' : '') + ' data-page="' + (d.page - 1) + '">‹</button>' +
          '<span>Page ' + d.page + ' / ' + d.pages + '</span>' +
          '<button type="button" class="' + c('ghost') + '" aria-label="Next page" ' + (d.page >= d.pages ? 'disabled' : '') + ' data-page="' + (d.page + 1) + '">›</button></div>');
        root.querySelector('[data-invite]').addEventListener('click', function(){ location.hash = '#/agents/new'; });
        root.querySelectorAll('[data-page]').forEach(function(b){ b.addEventListener('click', function(){ location.hash = '#/agents?page=' + b.getAttribute('data-page'); }); });
        root.querySelectorAll('[data-kebab]').forEach(function(b){
          b.addEventListener('click', function(){
            root.querySelectorAll('[role=menu]').forEach(function(m){ m.remove(); });
            var m = document.createElement('div'); m.className = c('menu'); m.setAttribute('role', 'menu');
            m.innerHTML = '<button type="button" role="menuitem">Edit</button><button type="button" role="menuitem">Deactivate</button>';
            m.children[1].addEventListener('click', function(){ m.remove(); confirmDeactivate(b.getAttribute('data-kebab'), b.getAttribute('data-name'), page); });
            b.parentNode.appendChild(m);
          });
        });
      }).catch(ignoreStop);
    },
    'agents/new': function(token){
      var n = rid('name'), e = rid('email'), ro = rid('role');
      root.innerHTML = layout('<h1>Invite an agent</h1>' +
        '<div class="' + c('lbl') + '">Full name</div><input id="' + n + '" aria-label="Full name">' +
        '<div class="' + c('lbl') + '">Email</div><input id="' + e + '" type="email" aria-label="Email">' +
        '<div class="' + c('lbl') + '">Role</div><select id="' + ro + '" aria-label="Role" disabled><option>Loading…</option></select>' +
        '<button class="' + c('btn') + '" type="button" disabled>' + L.invite + '</button><div data-msg></div>');
      var btn = root.querySelector('button.' + c('btn'));
      api('GET', '/roles').then(function(r){
        if (token !== renderToken) return;
        var sel = document.getElementById(ro);
        sel.innerHTML = r.body.map(function(x){ return '<option>' + esc(x) + '</option>'; }).join('');
        sel.disabled = false; btn.disabled = false;
      }).catch(ignoreStop);
      btn.addEventListener('click', function(){
        btn.disabled = true; btn.textContent = 'Sending…';
        var email = document.getElementById(e).value;
        api('POST', '/agents', { name: document.getElementById(n).value, email: email, role: document.getElementById(ro).value }).then(function(r){
          if (r.status !== 200) { btn.disabled = false; btn.textContent = L.invite; root.querySelector('[data-msg]').innerHTML = '<div class="' + c('alert') + '" role="alert">' + esc(r.body.error) + '</div>'; return; }
          toast('Invitation sent to ' + email);
          location.hash = '#/agents';
        }).catch(ignoreStop);
      });
    },
    'settings/password': function(){
      var a = rid('cur'), b = rid('new'), d = rid('conf');
      root.innerHTML = layout('<h1>Change password</h1>' +
        '<label class="' + c('lbl') + '" for="' + a + '" style="display:block">Current password</label><input id="' + a + '" type="password" autocomplete="current-password">' +
        '<label class="' + c('lbl') + '" for="' + b + '" style="display:block">New password</label><input id="' + b + '" type="password" autocomplete="new-password">' +
        '<label class="' + c('lbl') + '" for="' + d + '" style="display:block">Confirm password</label><input id="' + d + '" type="password" autocomplete="new-password">' +
        '<button class="' + c('btn') + '" type="button">' + L.change + '</button><div data-msg></div>');
      var btn = root.querySelector('button.' + c('btn'));
      btn.addEventListener('click', function(){
        btn.disabled = true;
        api('POST', '/password', { current: document.getElementById(a).value, next: document.getElementById(b).value, confirm: document.getElementById(d).value }).then(function(r){
          btn.disabled = false;
          var msg = root.querySelector('[data-msg]');
          if (r.status !== 200) { msg.innerHTML = '<div class="' + c('alert') + '" role="alert">' + esc(r.body.error) + '</div>'; return; }
          msg.innerHTML = '<div class="' + c('ok') + '" role="status">Your password has been changed.</div>';
        }).catch(ignoreStop);
      });
    }
  };

  function confirmDeactivate(id, name, page){
    var b = document.createElement('div'); b.className = c('back');
    var tid = rid('dlg');
    b.innerHTML = '<div class="' + c('dialog') + '" role="dialog" aria-modal="true" aria-labelledby="' + tid + '"><h2 id="' + tid + '" style="margin-top:0">Deactivate ' + esc(name) + '?</h2>' +
      '<p>They will no longer be able to sign in or receive tickets.</p>' +
      '<button type="button" class="' + c('btn') + ' ' + c('ghost') + '" data-x>Cancel</button> <button type="button" class="' + c('btn') + '" data-go>' + L.deactivate + '</button></div>';
    b.querySelector('[data-x]').addEventListener('click', function(){ b.remove(); });
    b.querySelector('[data-go]').addEventListener('click', function(){
      b.querySelector('[data-go]').disabled = true;
      api('POST', '/agents/' + id + '/deactivate').then(function(){
        b.remove(); toast(name + ' was deactivated');
        renderToken++; routes.agents(renderToken, { page: String(page) });
      }).catch(function(e){ b.remove(); ignoreStop(e); });
    });
    document.body.appendChild(b);
  }

  function route(){
    var h = location.hash.replace(/^#\\/?/, '') || 'home';
    var qi = h.indexOf('?');
    var path = qi >= 0 ? h.slice(0, qi) : h;
    var q = {};
    if (qi >= 0) h.slice(qi + 1).split('&').forEach(function(kv){ var p = kv.split('='); q[p[0]] = decodeURIComponent(p[1] || ''); });
    renderToken++;
    (routes[path] || routes.home)(renderToken, q);
  }
  window.addEventListener('hashchange', route);
  route();

  // A feedback survey nobody warned the automation about.
  if (SURVEY !== null && !sessionStorage.getItem('sv_${tenantId}')) {
    setTimeout(function(){
      if (sessionStorage.getItem('sv_${tenantId}') || !document.querySelector('nav')) return;
      var b = document.createElement('div'); b.className = c('back');
      b.innerHTML = '<div class="' + c('dialog') + '" role="dialog" aria-modal="true" aria-label="Feedback"><h3 style="margin-top:0">Got 30 seconds?</h3>' +
        '<p>Tell us how we are doing.</p><button type="button" class="' + c('btn') + '">Take the survey</button> <button type="button" class="' + c('btn') + ' ' + c('ghost') + '">No thanks</button></div>';
      b.querySelectorAll('button').forEach(function(x){ x.addEventListener('click', function(){ sessionStorage.setItem('sv_${tenantId}', '1'); b.remove(); }); });
      document.body.appendChild(b);
      try { navigator.sendBeacon(T + '/__mess?kind=survey'); } catch (e) {}
    }, SURVEY);
  }
})();
</script></body></html>`;
}
