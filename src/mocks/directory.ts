// Mock Directory: a newer admin console. Two-step sign-in inside an iframe with a 6-box TOTP
// input, a "What's new" popup, search plus pagination, radio-button access levels,
// type-the-email-to-confirm deletion, and an inactivity sign-out page.
import type { Request, Response, NextFunction } from 'express';
import type express from 'express';
import {
  announcementPopup, audit, checkPassword, consentOverlay, copy, endSession, surveyPopup, esc, fieldMapInput, forgetTenant, getSession,
  hashPassword, makeIds, mockServer, mocksDb, passwordPolicyError, promoteSession, readFields, shouldExpire, startSession,
  type Ids, type Tenant, type TenantRequest,
} from './core.ts';
import { verifyTotp } from '../shared/totp.ts';

const APP = 'directory' as const;
const LEVELS = ['Reader', 'Editor', 'Owner'];

function styles(c: Ids['c']) {
  return `<style>
  body{margin:0;font:14px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;background:#fbfbfa;color:#18181b}
  .${c('bar')}{display:flex;gap:18px;align-items:center;padding:12px 28px;border-bottom:1px solid #e4e4e7;background:#fff}
  .${c('bar')} a{color:#3f3f46;text-decoration:none}
  .${c('logo')}{font-weight:700;color:#0d9488;margin-right:12px}
  .${c('wrap')}{max-width:900px;margin:28px auto;padding:0 20px}
  .${c('row')}{margin:10px 0;display:flex;flex-direction:column;gap:4px;max-width:380px}
  input[type=text],input[type=email],input[type=password],input[type=search]{padding:8px 10px;border:1px solid #d4d4d8;border-radius:6px;font:inherit}
  .${c('primary')}{background:#0d9488;color:#fff;border:0;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}
  .${c('primary')}[disabled]{opacity:.45;cursor:not-allowed}
  .${c('danger')}{background:#fff;color:#b91c1c;border:1px solid #fca5a5;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit}
  table{border-collapse:collapse;width:100%;background:#fff}
  td,th{padding:8px 10px;border-bottom:1px solid #f0f0f1;text-align:left}
  .${c('flash')}{background:#ecfdf5;border:1px solid #a7f3d0;padding:8px 12px;border-radius:6px;margin-bottom:12px}
  .${c('err')}{background:#fef2f2;border:1px solid #fecaca;padding:8px 12px;border-radius:6px;margin-bottom:12px}
  .${c('otp')} input{width:38px;height:44px;text-align:center;font-size:20px;padding:0;margin-right:6px}
  .${c('mback')}{position:fixed;inset:0;background:rgba(24,24,27,.5);display:none;align-items:center;justify-content:center;z-index:60}
  .${c('modal')}{background:#fff;border-radius:10px;padding:22px;width:420px}
</style>`;
}

function page(t: Tenant, ids: Ids, title: string, body: string, opts: { nav?: boolean } = {}) {
  const c = ids.c;
  const base = `/t/${t.id}`;
  const nav = opts.nav
    ? `<header class="${c('bar')}"><span class="${c('logo')}">Directory</span>
        <a href="${base}/home">Overview</a><a href="${base}/members" data-testid="nav-members">Members</a>
        <a href="${base}/account/password" data-testid="nav-account">Account</a>
        <form method="post" action="${base}/logout" style="margin-left:auto"><button class="${c('danger')}" type="submit">Log out</button></form></header>`
    : `<header class="${c('bar')}"><span class="${c('logo')}">Directory</span></header>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} — Directory</title>${styles(c)}</head>
<body>${nav}<div class="${c('wrap')}">${body}</div>${consentOverlay(APP, t.id, t.mess, ids)}${opts.nav ? announcementPopup(t.id, t.mess, ids, 'Directory') + surveyPopup(t.id, t.mess, ids) : ''}</body></html>`;
}

const framePage = (ids: Ids, inner: string) =>
  `<!doctype html><html><head><meta charset="utf-8">${styles(ids.c)}</head><body style="background:#fff;padding:10px 18px">${inner}</body></html>`;

export function directoryApp(): express.Express {
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
        res.redirect(`${base(t)}/signed-out?reason=timeout`);
        return;
      }
      next();
    };

    r.get('/', (req, res) => {
      res.redirect(`${base((req as TenantRequest).tenant)}/home`);
    });

    r.get('/login', (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      res.send(page(t, ids, 'Sign in', `<h1>Welcome back</h1><p>Sign in with your organisation account.</p>
        <iframe title="Sign in to Directory" src="${base(t)}/auth/start" style="width:460px;height:330px;border:1px solid #e4e4e7;border-radius:8px;background:#fff"></iframe>`));
    });

    const startForm = (t: Tenant, ids: Ids, error?: string) => {
      const c = ids.c;
      return `${error ? `<div class="${c('err')}" role="alert">${esc(error)}</div>` : ''}
      <form method="post" action="${base(t)}/auth/start">
        ${fieldMapInput(ids, ['username', 'password'])}
        <div class="${c('row')}"><span id="${ids.id('ul')}">Username</span>
          <input type="text" id="${ids.id('username')}" name="${ids.id('username')}" aria-labelledby="${ids.id('ul')}" autocomplete="username" data-testid="login-username"></div>
        <div class="${c('row')}"><span id="${ids.id('pl')}">Password</span>
          <input type="password" id="${ids.id('password')}" name="${ids.id('password')}" aria-labelledby="${ids.id('pl')}" autocomplete="current-password" data-testid="login-password"></div>
        <button class="${c('primary')}" type="submit" data-testid="login-next">Next</button>
      </form>`;
    };

    r.get('/auth/start', (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      res.send(framePage(ids, startForm(t, ids)));
    });

    r.post('/auth/start', async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const f = readFields(req.body);
      const ids = makeIds(t.mess);
      if ((f.username ?? '').toLowerCase() !== t.admin_email || !checkPassword(f.password ?? '', t.admin_password_hash)) {
        await audit(APP, t.id, 'login.fail', f.username);
        res.status(401).send(framePage(ids, startForm(t, ids, 'That username and password do not match.')));
        return;
      }
      startSession(APP, res, t.id, 'password_ok');
      res.redirect(`${base(t)}/auth/otp`);
    });

    const otpForm = (t: Tenant, ids: Ids, error?: string) => {
      const c = ids.c;
      const boxes = [1, 2, 3, 4, 5, 6]
        .map((i) => `<input type="text" inputmode="numeric" aria-label="Digit ${i}" data-otp="${i}" id="${ids.id(`d${i}`)}" autocomplete="${i === 1 ? 'one-time-code' : 'off'}">`)
        .join('');
      return `${error ? `<div class="${c('err')}" role="alert">${esc(error)}</div>` : ''}
      <h3 style="margin:4px 0">Enter verification code</h3>
      <p>Open your authenticator app and enter the 6-digit code.</p>
      <form method="post" action="${base(t)}/auth/otp" id="${ids.id('otpform')}">
        <div class="${c('otp')}" role="group" aria-label="Verification code">${boxes}</div>
        <input type="hidden" name="code">
        <button class="${c('primary')}" type="submit" data-testid="otp-submit" style="margin-top:12px">Verify</button>
      </form>
      <script>
      (function(){
        var boxes = Array.prototype.slice.call(document.querySelectorAll('[data-otp]'));
        boxes.forEach(function(b, i){
          b.addEventListener('input', function(){
            var digits = b.value.replace(/\\D/g, '');
            if (digits.length > 1) {
              for (var k = 0; k < digits.length && i + k < boxes.length; k++) boxes[i + k].value = digits[k];
              boxes[Math.min(i + digits.length, boxes.length - 1)].focus();
            } else {
              b.value = digits;
              if (digits && boxes[i + 1]) boxes[i + 1].focus();
            }
          });
          b.addEventListener('keydown', function(ev){ if (ev.key === 'Backspace' && !b.value && boxes[i - 1]) boxes[i - 1].focus(); });
        });
        document.getElementById('${ids.id('otpform')}').addEventListener('submit', function(){
          this.querySelector('input[name=code]').value = boxes.map(function(b){ return b.value; }).join('');
        });
      })();
      </script>`;
    };

    r.get('/auth/otp', (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      res.send(framePage(ids, otpForm(t, ids)));
    });

    r.post('/auth/otp', async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const s = getSession(APP, req, t.id);
      const ids = makeIds(t.mess);
      if (!s || s.s.stage !== 'password_ok') {
        res.status(401).send(framePage(ids, startForm(t, ids, 'Your sign-in attempt timed out. Start again.')));
        return;
      }
      const row = (await mocksDb().query(`select totp_secret, totp_last_counter from directory.tenants where id = $1`, [t.id])).rows[0];
      const used = verifyTotp(row.totp_secret, String(req.body?.code ?? ''), row.totp_last_counter);
      if (used === null) {
        await audit(APP, t.id, 'totp.fail');
        res.status(401).send(framePage(ids, otpForm(t, ids, 'That code is not valid. Try the next one.')));
        return;
      }
      await mocksDb().query(`update directory.tenants set totp_last_counter = $2 where id = $1`, [t.id, used]);
      forgetTenant(APP, t.id);
      promoteSession(s.sid);
      await audit(APP, t.id, 'login.success');
      res.send(`<!doctype html><p>Verified.</p><script>window.top.location.href = '${base(t)}/home';</script>`);
    });

    r.get('/signed-out', (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      res.send(page(t, ids, 'Signed out', `<h1>You were signed out due to inactivity</h1>
        <p>Your session has expired. Sign in again to pick up where you left off.</p>
        <a class="${ids.c('primary')}" href="${base(t)}/login" style="text-decoration:none">Sign in</a>`));
    });

    r.post('/logout', (req, res) => {
      const t = (req as TenantRequest).tenant;
      const s = getSession(APP, req, t.id);
      if (s) endSession(s.sid);
      res.redirect(`${base(t)}/login`);
    });

    r.get('/home', requireAuth, async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      const n = (await mocksDb().query(`select count(*)::int as n from directory.users where tenant_id = $1`, [t.id])).rows[0].n;
      res.send(page(t, ids, 'Overview', `<h1>Directory overview</h1><p data-testid="member-count">${n} members</p>`, { nav: true }));
    });

    r.get('/members', requireAuth, async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      const c = ids.c;
      const q = String(req.query.q ?? '').trim().toLowerCase();
      const size = t.mess.pageSize;
      const where = `tenant_id = $1 and ($2 = '' or lower(email) like '%' || $2 || '%' or lower(name) like '%' || $2 || '%')`;
      const total = (await mocksDb().query(`select count(*)::int as n from directory.users where ${where}`, [t.id, q])).rows[0].n;
      const pages = Math.max(1, Math.ceil(total / size));
      const p = Math.min(Math.max(1, Number(req.query.page) || 1), pages);
      const rows = (await mocksDb().query(
        `select id, email, name, role from directory.users where ${where} order by created_at desc, id desc limit $3 offset $4`,
        [t.id, q, size, (p - 1) * size],
      )).rows;
      const flash = req.query.flash ? `<div class="${c('flash')}" role="status">${esc(req.query.flash)}</div>` : '';
      const qs = (n: number) => `${base(t)}/members?page=${n}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
      res.send(page(t, ids, 'Members', `${flash}
        <div style="display:flex;justify-content:space-between;align-items:center"><h1>Members</h1>
          <a class="${c('primary')}" style="text-decoration:none" href="${base(t)}/members/new" data-testid="add-member">New member</a></div>
        <form method="get" action="${base(t)}/members" role="search" style="margin-bottom:12px">
          <input type="search" name="q" value="${esc(q)}" aria-label="Search members" placeholder="Search by name or email" data-testid="member-search">
          <button type="submit" class="${c('primary')}">Search</button>
        </form>
        <table data-testid="members-table"><thead><tr><th>Name</th><th>Email</th><th>Access</th><th></th></tr></thead><tbody>
        ${rows.map((u) => `<tr data-testid="member-row"><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td>
          <td><button type="button" class="${c('danger')}" data-testid="delete-member" aria-label="Delete ${esc(u.email)}" data-id="${u.id}" data-email="${esc(u.email)}">Delete</button></td></tr>`).join('')}
        </tbody></table>
        ${rows.length === 0 ? '<p data-testid="empty">No members match.</p>' : ''}
        <p>${total} result${total === 1 ? '' : 's'} · page ${p} of ${pages}
          ${p < pages ? ` · <a rel="next" data-testid="next-page" href="${qs(p + 1)}">Next ›</a>` : ''}</p>
        <div class="${c('mback')}" id="${ids.id('mback')}">
          <div class="${c('modal')}" role="dialog" aria-modal="true" aria-labelledby="${ids.id('mtitle')}">
            <h2 id="${ids.id('mtitle')}" style="margin-top:0">Delete member</h2>
            <p>This permanently deletes <strong data-slot="email"></strong>. Type the email address to confirm.</p>
            <form method="post" id="${ids.id('delform')}">
              <input type="text" aria-label="Type the email to confirm" data-testid="confirm-input" autocomplete="off" style="width:100%">
              <div style="margin-top:12px"><button type="button" data-cancel>Cancel</button>
              <button type="submit" class="${c('primary')}" disabled data-testid="confirm-delete">${copy(t.mess, 'Delete member', 'Delete permanently')}</button></div>
            </form>
          </div>
        </div>
        <script>
        (function(){
          var back = document.getElementById('${ids.id('mback')}');
          var form = document.getElementById('${ids.id('delform')}');
          var input = form.querySelector('[data-testid=confirm-input]');
          var go = form.querySelector('[data-testid=confirm-delete]');
          var expected = '';
          document.querySelectorAll('[data-testid=delete-member]').forEach(function(b){
            b.addEventListener('click', function(){
              expected = b.getAttribute('data-email');
              back.querySelector('[data-slot=email]').textContent = expected;
              form.action = '${base(t)}/members/' + b.getAttribute('data-id') + '/delete';
              input.value = ''; go.disabled = true; back.style.display = 'flex'; input.focus();
            });
          });
          input.addEventListener('input', function(){ go.disabled = input.value.trim().toLowerCase() !== expected; });
          back.querySelector('[data-cancel]').addEventListener('click', function(){ back.style.display = 'none'; });
        })();
        </script>`, { nav: true }));
    });

    const newForm = (t: Tenant, ids: Ids, error?: string) => {
      const c = ids.c;
      return `<h1>New member</h1>${error ? `<div class="${c('err')}" role="alert">${esc(error)}</div>` : ''}
      <form method="post" action="${base(t)}/members/new">
        ${fieldMapInput(ids, ['name', 'email', 'level'])}
        <div class="${c('row')}"><span id="${ids.id('nl')}">Display name</span><input type="text" name="${ids.id('name')}" aria-labelledby="${ids.id('nl')}" data-testid="member-name"></div>
        <div class="${c('row')}"><span id="${ids.id('el')}">Email address</span><input type="email" name="${ids.id('email')}" aria-labelledby="${ids.id('el')}" data-testid="member-email"></div>
        <fieldset style="border:0;padding:0;margin:12px 0"><legend>Access level</legend>
          ${LEVELS.map((l, i) => `<label style="margin-right:14px"><input type="radio" name="${ids.id('level')}" value="${l}" ${i === 0 ? 'checked' : ''}> ${l}</label>`).join('')}
        </fieldset>
        <button class="${c('primary')}" type="submit" data-testid="member-submit">${copy(t.mess, 'Add member', 'Create member')}</button>
      </form>`;
    };

    r.get('/members/new', requireAuth, (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      res.send(page(t, ids, 'New member', newForm(t, ids), { nav: true }));
    });

    r.post('/members/new', requireAuth, async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const f = readFields(req.body);
      const ids = makeIds(t.mess);
      if (!f.name || !f.email || !LEVELS.includes(f.level)) {
        res.status(400).send(page(t, ids, 'New member', newForm(t, ids, 'Display name and email are required.'), { nav: true }));
        return;
      }
      const dupe = await mocksDb().query(`select 1 from directory.users where tenant_id = $1 and lower(email) = lower($2)`, [t.id, f.email]);
      if (dupe.rowCount) {
        res.status(409).send(page(t, ids, 'New member', newForm(t, ids, 'A member with that email already exists.'), { nav: true }));
        return;
      }
      await mocksDb().query(`insert into directory.users (tenant_id, email, name, role) values ($1, lower($2), $3, $4)`, [t.id, f.email, f.name, f.level]);
      await audit(APP, t.id, 'user.create', f.email.toLowerCase());
      res.redirect(`${base(t)}/members?flash=${encodeURIComponent(`Member ${f.email.toLowerCase()} added`)}`);
    });

    r.post('/members/:id/delete', requireAuth, async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const del = await mocksDb().query(`delete from directory.users where tenant_id = $1 and id = $2 returning email`, [t.id, Number(req.params.id)]);
      if (del.rows[0]) await audit(APP, t.id, 'user.remove', del.rows[0].email);
      res.redirect(`${base(t)}/members?flash=${encodeURIComponent(del.rows[0] ? `Member ${del.rows[0].email} deleted` : 'Member not found')}`);
    });

    const pwForm = (t: Tenant, ids: Ids, msg?: { ok?: string; error?: string }) => {
      const c = ids.c;
      return `<h1>Account security</h1>
      ${msg?.ok ? `<div class="${c('flash')}" role="status">${esc(msg.ok)}</div>` : ''}
      ${msg?.error ? `<div class="${c('err')}" role="alert">${esc(msg.error)}</div>` : ''}
      <form method="post" action="${base(t)}/account/password">
        ${fieldMapInput(ids, ['current', 'next', 'confirm'])}
        <div class="${c('row')}"><label for="${ids.id('current')}">Current password</label><input type="password" id="${ids.id('current')}" name="${ids.id('current')}" data-testid="pw-current"></div>
        <div class="${c('row')}"><label for="${ids.id('next')}">New password</label><input type="password" id="${ids.id('next')}" name="${ids.id('next')}" data-testid="pw-new"></div>
        <div class="${c('row')}"><label for="${ids.id('confirm')}">Repeat new password</label><input type="password" id="${ids.id('confirm')}" name="${ids.id('confirm')}" data-testid="pw-confirm"></div>
        <button class="${c('primary')}" type="submit" data-testid="pw-save">${copy(t.mess, 'Save password', 'Update password')}</button>
      </form>`;
    };

    r.get('/account/password', requireAuth, (req, res) => {
      const t = (req as TenantRequest).tenant;
      const ids = makeIds(t.mess);
      res.send(page(t, ids, 'Account', pwForm(t, ids), { nav: true }));
    });

    r.post('/account/password', requireAuth, async (req, res) => {
      const t = (req as TenantRequest).tenant;
      const f = readFields(req.body);
      const ids = makeIds(t.mess);
      let error: string | null = null;
      if (!checkPassword(f.current ?? '', t.admin_password_hash)) error = 'Current password is wrong.';
      else if (f.next !== f.confirm) error = 'New passwords do not match.';
      else if (f.next === f.current) error = 'Pick a password you have not used before.';
      else error = passwordPolicyError(f.next ?? '');
      if (error) {
        res.status(400).send(page(t, ids, 'Account', pwForm(t, ids, { error }), { nav: true }));
        return;
      }
      await mocksDb().query(`update directory.tenants set admin_password_hash = $2 where id = $1`, [t.id, hashPassword(f.next)]);
      forgetTenant(APP, t.id);
      await audit(APP, t.id, 'password.change');
      res.send(page(t, ids, 'Account', pwForm(t, ids, { ok: 'Password changed' }), { nav: true }));
    });
  });
}
