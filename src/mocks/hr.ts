// Mock HR: an old server-rendered portal. Sign-in inside an iframe, ids and class names that
// change on every load, a consent wall, short sessions with an interstitial, server-side
// pagination, a confirm modal for removal, and (sloppily) no duplicate-email check.
import type { Request, Response, NextFunction } from 'express';
import type express from 'express';
import {
  audit, checkPassword, consentOverlay, copy, endSession, surveyPopup, esc, fieldMapInput, forgetTenant, getSession, hashPassword,
  makeIds, mockServer, mocksDb, passwordPolicyError, readFields, shouldExpire, startSession,
  type Ids, type Tenant, type TenantRequest,
} from './core.ts';

const APP = 'hr' as const;
const ROLES = ['Employee', 'Manager', 'Admin'];

function styles(c: Ids['c']) {
  return `<style>
  body{margin:0;font:15px/1.45 Georgia,'Times New Roman',serif;background:#f4f1ea;color:#222}
  .${c('top')}{background:#23395b;color:#fff;padding:12px 24px;display:flex;gap:24px;align-items:center}
  .${c('top')} a,.${c('top')} button{color:#fff;text-decoration:none;font:inherit;background:none;border:0;cursor:pointer}
  .${c('brand')}{font-weight:bold;letter-spacing:.5px}
  .${c('main')}{max-width:880px;margin:24px auto;background:#fff;padding:24px 28px;border:1px solid #d8d2c4}
  .${c('field')}{margin:12px 0;display:flex;flex-direction:column;gap:4px;max-width:360px}
  .${c('field')} input,.${c('field')} select{padding:7px;border:1px solid #9a927f;font:inherit}
  .${c('btn')}{padding:7px 14px;background:#23395b;color:#fff;border:0;cursor:pointer;font:inherit}
  .${c('btn-danger')}{padding:4px 10px;background:#fff;color:#9b1c1c;border:1px solid #9b1c1c;cursor:pointer;font:inherit}
  .${c('grid')}{border-collapse:collapse;width:100%}
  .${c('grid')} td,.${c('grid')} th{border-bottom:1px solid #e3ddcf;padding:6px 8px;text-align:left}
  .${c('flash')}{background:#e8f3e8;border:1px solid #9cc49c;padding:8px 12px;margin-bottom:12px}
  .${c('error')}{background:#fbeaea;border:1px solid #d79a9a;padding:8px 12px;margin-bottom:12px}
  .${c('modal-back')}{position:fixed;inset:0;background:rgba(0,0,0,.4);display:none;align-items:center;justify-content:center;z-index:50}
  .${c('modal')}{background:#fff;padding:20px 24px;max-width:420px;border:1px solid #888}
  .${c('pager')}{margin-top:14px;display:flex;gap:14px}
  .${c('sr')}{position:absolute;left:-9999px}
</style>`;
}

function page(t: Tenant, ids: Ids, title: string, body: string, opts: { nav?: boolean; overlay?: boolean } = {}) {
  const c = ids.c;
  const base = `/t/${t.id}`;
  const nav = opts.nav
    ? `<nav class="${c('top')}" aria-label="Main">
        <span class="${c('brand')}">Mock HR</span>
        <a href="${base}/dashboard">Dashboard</a><a href="${base}/people">People</a><a href="${base}/settings/password">Settings</a>
        <form method="post" action="${base}/logout" style="margin-left:auto"><button type="submit">Sign out</button></form>
      </nav>`
    : `<div class="${c('top')}"><span class="${c('brand')}">Mock HR</span></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Mock HR</title>${styles(c)}</head>
<body>${nav}<main class="${c('main')}">${body}</main>${opts.overlay === false ? '' : consentOverlay(APP, t.id, t.mess, ids)}${opts.nav ? surveyPopup(t.id, t.mess, ids) : ''}</body></html>`;
}

function loginForm(t: Tenant, ids: Ids, action: string, error?: string) {
  const c = ids.c;
  return `${error ? `<div class="${c('error')}" role="alert">${esc(error)}</div>` : ''}
<form method="post" action="${action}">
  ${fieldMapInput(ids, ['email', 'password'])}
  <div class="${c('field')}"><label for="${ids.id('email')}">Work email</label>
    <input id="${ids.id('email')}" name="${ids.id('email')}" type="email" autocomplete="username" required></div>
  <div class="${c('field')}"><label for="${ids.id('password')}">Password</label>
    <input id="${ids.id('password')}" name="${ids.id('password')}" type="password" autocomplete="current-password" required></div>
  <button class="${c('btn')}" type="submit">Sign in</button>
</form>`;
}

export function hrApp(): express.Express {
  return mockServer(APP, (r) => {
    const base = (t: Tenant) => `/t/${t.id}`;

    const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
      const t = (req as TenantRequest).tenant;
      const s = getSession(APP, req, t.id);
      if (!s || s.s.stage !== 'authed') {
        res.redirect(`${base(t)}/login`);
        return;
      }
      if (await shouldExpire(APP, t)) {
        endSession(s.sid);
        res.redirect(`${base(t)}/session-expired?next=${encodeURIComponent(req.originalUrl)}`);
        return;
      }
      next();
    };

    r.get('/', (req, res) => {
      res.redirect(`${base((req as TenantRequest).tenant)}/dashboard`);
    });

    r.get('/login', (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      const notice = req.query.notice === 'password_changed'
        ? `<div class="${ids.c('flash')}" role="status">Password updated. Please sign in again.</div>` : '';
      const inner = t.mess.iframeLogin
        ? `<iframe title="Sign in" name="${ids.id('authframe')}" src="${base(t)}/auth/frame" style="width:440px;height:290px;border:1px solid #d8d2c4"></iframe>`
        : loginForm(t, ids, `${base(t)}/login`);
      res.send(page(t, ids, 'Sign in', `<h1>Sign in to Mock HR</h1>${notice}${inner}`));
    });

    const handleLogin = async (req: Request, res: Response, inFrame: boolean) => {
      const t = (req as TenantRequest).tenant;
      const f = readFields(req.body);
      const ok = f.email?.toLowerCase() === t.admin_email && checkPassword(f.password ?? '', t.admin_password_hash);
      if (!ok) {
        await audit(APP, t.id, 'login.fail', f.email);
        const ids = makeIds(t.mess);
        const form = loginForm(t, ids, inFrame ? `${base(t)}/auth/frame` : `${base(t)}/login`, 'Invalid email or password.');
        res.status(401).send(inFrame ? framePage(ids, form) : page(t, ids, 'Sign in', `<h1>Sign in to Mock HR</h1>${form}`));
        return;
      }
      startSession(APP, res, t.id, 'authed');
      await audit(APP, t.id, 'login.success');
      if (inFrame) {
        res.send(`<!doctype html><p>Signing you in…</p><script>window.top.location.href = '${base(t)}/dashboard';</script>`);
      } else {
        res.redirect(`${base(t)}/dashboard`);
      }
    };

    const framePage = (ids: Ids, inner: string) =>
      `<!doctype html><html><head><meta charset="utf-8">${styles(ids.c)}</head><body style="background:#fff;padding:8px 16px">${inner}</body></html>`;

    r.get('/auth/frame', (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      res.send(framePage(ids, loginForm(t, ids, `${base(t)}/auth/frame`)));
    });
    r.post('/auth/frame', (req, res) => handleLogin(req, res, true));
    r.post('/login', (req, res) => handleLogin(req, res, false));

    r.get('/session-expired', (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      // Realistic mess: "Sign in again" ignores where you were and lands on the dashboard.
      res.status(440).send(page(t, ids, 'Session expired', `
        <h1>Your session has expired</h1>
        <p>For your security, you were signed out after a period of inactivity.</p>
        <a class="${ids.c('btn')}" href="${base(t)}/login">Sign in again</a>`));
    });

    r.post('/logout', (req, res) => {
      const t = (req as TenantRequest).tenant;
      const s = getSession(APP, req, t.id);
      if (s) endSession(s.sid);
      res.redirect(`${base(t)}/login`);
    });

    r.get('/dashboard', requireAuth, async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      const n = (await mocksDb().query(`select count(*)::int as n from hr.users where tenant_id = $1 and status = 'active'`, [t.id])).rows[0].n;
      res.send(page(t, ids, 'Dashboard', `<h1>Welcome back, ${esc(t.admin_name.split(' ')[0])}</h1>
        <p>You have <strong>${n}</strong> people in your organisation.</p>`, { nav: true }));
    });

    r.get('/people', requireAuth, async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      const c = ids.c;
      const size = t.mess.pageSize;
      const total = (await mocksDb().query(`select count(*)::int as n from hr.users where tenant_id = $1`, [t.id])).rows[0].n;
      const pages = Math.max(1, Math.ceil(total / size));
      const p = Math.min(Math.max(1, Number(req.query.page) || 1), pages);
      const rows = (await mocksDb().query(
        `select id, email, name, role, status from hr.users where tenant_id = $1 order by created_at desc, id desc limit $2 offset $3`,
        [t.id, size, (p - 1) * size],
      )).rows;
      const flash = req.query.flash ? `<div class="${c('flash')}" role="status">${esc(req.query.flash)}</div>` : '';
      const body = `${flash}
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h1>People</h1><a class="${c('btn')}" href="${base(t)}/people/new">Add person</a>
        </div>
        <table class="${c('grid')}" aria-label="People">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th><span class="${c('sr')}">Actions</span></th></tr></thead>
          <tbody>${rows.map((u) => `<tr>
            <td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${u.status === 'active' ? 'Active' : 'Inactive'}</td>
            <td><button type="button" class="${c('btn-danger')}" data-remove="${u.id}" data-name="${esc(u.name)}">Remove</button></td>
          </tr>`).join('')}</tbody>
        </table>
        <nav class="${c('pager')}" aria-label="Pagination">
          ${p > 1 ? `<a href="${base(t)}/people?page=${p - 1}">Previous</a>` : '<span aria-disabled="true">Previous</span>'}
          <span>Page ${p} of ${pages}</span>
          ${p < pages ? `<a href="${base(t)}/people?page=${p + 1}">Next</a>` : '<span aria-disabled="true">Next</span>'}
        </nav>
        <div class="${c('modal-back')}" id="${ids.id('back')}">
          <div class="${c('modal')}" role="dialog" aria-modal="true" aria-labelledby="${ids.id('mt')}">
            <h2 id="${ids.id('mt')}">Remove <span data-slot="name"></span>?</h2>
            <p>They will lose access to Mock HR immediately. This cannot be undone.</p>
            <form method="post" id="${ids.id('rmform')}">
              <button type="button" data-cancel>Cancel</button>
              <button type="submit" class="${c('btn')}">${copy(t.mess, 'Remove person', 'Yes, remove')}</button>
            </form>
          </div>
        </div>
        <script>
          (function(){
            var back = document.getElementById('${ids.id('back')}');
            document.querySelectorAll('[data-remove]').forEach(function(b){
              b.addEventListener('click', function(){
                back.querySelector('[data-slot=name]').textContent = b.getAttribute('data-name');
                document.getElementById('${ids.id('rmform')}').action = '${base(t)}/people/' + b.getAttribute('data-remove') + '/remove';
                back.style.display = 'flex';
              });
            });
            back.querySelector('[data-cancel]').addEventListener('click', function(){ back.style.display = 'none'; });
          })();
        </script>`;
      res.send(page(t, ids, 'People', body, { nav: true }));
    });

    const newPersonForm = (t: Tenant, ids: Ids, error?: string) => {
      const c = ids.c;
      return `<h1>Add person</h1>
      ${error ? `<div class="${c('error')}" role="alert">${esc(error)}</div>` : ''}
      <form method="post" action="${base(t)}/people/new">
        ${fieldMapInput(ids, ['name', 'email', 'role'])}
        <div class="${c('field')}"><label for="${ids.id('name')}">Full name</label><input id="${ids.id('name')}" name="${ids.id('name')}" required></div>
        <div class="${c('field')}"><label for="${ids.id('email')}">Work email</label><input id="${ids.id('email')}" name="${ids.id('email')}" type="email" required></div>
        <div class="${c('field')}"><label for="${ids.id('role')}">Role</label>
          <select id="${ids.id('role')}" name="${ids.id('role')}">${ROLES.map((x) => `<option>${x}</option>`).join('')}</select></div>
        <button class="${c('btn')}" type="submit">${copy(t.mess, 'Create person', 'Save')}</button>
      </form>`;
    };

    r.get('/people/new', requireAuth, (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      res.send(page(t, ids, 'Add person', newPersonForm(t, ids), { nav: true }));
    });

    r.post('/people/new', requireAuth, async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const f = readFields(req.body);
      if (!f.name || !f.email || !ROLES.includes(f.role)) {
        const ids = makeIds(t.mess);
        res.status(400).send(page(t, ids, 'Add person', newPersonForm(t, ids, 'Please fill in every field.'), { nav: true }));
        return;
      }
      // No duplicate check: this legacy app will happily create the same person twice.
      await mocksDb().query(`insert into hr.users (tenant_id, email, name, role) values ($1, $2, $3, $4)`, [t.id, f.email.toLowerCase(), f.name, f.role]);
      await audit(APP, t.id, 'user.create', f.email.toLowerCase());
      res.redirect(`${base(t)}/people?flash=${encodeURIComponent(`Added ${f.name}.`)}`);
    });

    r.post('/people/:id/remove', requireAuth, async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const del = await mocksDb().query(`delete from hr.users where tenant_id = $1 and id = $2 returning email, name`, [t.id, Number(req.params.id)]);
      if (del.rows[0]) await audit(APP, t.id, 'user.remove', del.rows[0].email);
      res.redirect(`${base(t)}/people?flash=${encodeURIComponent(del.rows[0] ? `Removed ${del.rows[0].name}.` : 'Nothing to remove.')}`);
    });

    const passwordForm = (t: Tenant, ids: Ids, error?: string) => {
      const c = ids.c;
      return `<h1>Change your password</h1>
      ${error ? `<div class="${c('error')}" role="alert">${esc(error)}</div>` : ''}
      <form method="post" action="${base(t)}/settings/password">
        ${fieldMapInput(ids, ['current', 'next', 'confirm'])}
        <div class="${c('field')}"><label for="${ids.id('current')}">Current password</label><input id="${ids.id('current')}" name="${ids.id('current')}" type="password" autocomplete="current-password"></div>
        <div class="${c('field')}"><label for="${ids.id('next')}">New password</label><input id="${ids.id('next')}" name="${ids.id('next')}" type="password" autocomplete="new-password"></div>
        <div class="${c('field')}"><label for="${ids.id('confirm')}">Confirm new password</label><input id="${ids.id('confirm')}" name="${ids.id('confirm')}" type="password" autocomplete="new-password"></div>
        <button class="${c('btn')}" type="submit">${copy(t.mess, 'Update password', 'Save changes')}</button>
      </form>`;
    };

    r.get('/settings/password', requireAuth, (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      res.send(page(t, ids, 'Settings', passwordForm(t, ids), { nav: true }));
    });

    r.post('/settings/password', requireAuth, async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const f = readFields(req.body);
      const ids = makeIds(t.mess);
      let error: string | null = null;
      if (!checkPassword(f.current ?? '', t.admin_password_hash)) error = 'Your current password is incorrect.';
      else if (f.next !== f.confirm) error = 'The new passwords do not match.';
      else if (f.next === f.current) error = 'Choose a password you have not used before.';
      else error = passwordPolicyError(f.next ?? '');
      if (error) {
        res.status(400).send(page(t, ids, 'Settings', passwordForm(t, ids, error), { nav: true }));
        return;
      }
      await mocksDb().query(`update hr.tenants set admin_password_hash = $2 where id = $1`, [t.id, hashPassword(f.next)]);
      forgetTenant(APP, t.id);
      await audit(APP, t.id, 'password.change');
      // Realistic: changing your password signs you out everywhere.
      const s = getSession(APP, req, t.id);
      if (s) endSession(s.sid);
      res.redirect(`${base(t)}/login?notice=password_changed`);
    });
  });
}
