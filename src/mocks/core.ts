// Shared plumbing for the three mock apps: tenants, sessions, password hashing, page chrome,
// randomized ids/classes, the consent overlay, and the session-expiry counter.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.ts';
import { pool } from '../db/pool.ts';
import { newTotpSecret } from '../shared/totp.ts';
import type { AppId, Mess } from './mess.ts';

export const mocksDb = () => pool(config.mocksDatabaseUrl);

// ---------- password hashing (scrypt) ----------
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32, { N: 4096 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function checkPassword(pw: string, stored: string): boolean {
  const [, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64');
  const got = scryptSync(pw, Buffer.from(saltB64, 'base64'), 32, { N: 4096 });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Password policy shared by all three apps. */
export function passwordPolicyError(pw: string): string | null {
  if (pw.length < 12) return 'Password must be at least 12 characters.';
  if (!/[0-9]/.test(pw)) return 'Password must contain a number.';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must contain a symbol.';
  return null;
}

// ---------- tenants ----------
export type Tenant = {
  id: string;
  mess: Mess;
  admin_email: string;
  admin_name: string;
  admin_password_hash: string;
  totp_secret: string | null;
  totp_last_counter: number;
};

export type SeedUser = { email: string; name: string; role: string };

export type CreatedTenant = {
  tenantId: string;
  baseUrl: string;
  admin: { email: string; name: string; password: string; totpSecret: string | null };
};

const tenantCache = new Map<string, Tenant>();

export async function loadTenant(app: AppId, id: string): Promise<Tenant | null> {
  const key = `${app}:${id}`;
  const hit = tenantCache.get(key);
  if (hit) return hit;
  const r = await mocksDb().query(`select * from ${app}.tenants where id = $1`, [id]);
  if (!r.rows[0]) return null;
  tenantCache.set(key, r.rows[0]);
  return r.rows[0];
}

export function forgetTenant(app: AppId, id: string) {
  tenantCache.delete(`${app}:${id}`);
}

export async function audit(app: AppId, tenantId: string, action: string, target: string | null = null) {
  await mocksDb().query(`insert into ${app}.audit (tenant_id, action, target) values ($1, $2, $3)`, [tenantId, action, target]);
}

export async function createTenant(
  app: AppId,
  origin: string,
  opts: { mess: Mess; users: SeedUser[]; adminPassword?: string; tenantId?: string },
): Promise<CreatedTenant> {
  const tenantId = opts.tenantId ?? `t${randomBytes(5).toString('hex')}`;
  const password = opts.adminPassword ?? `Init-${randomBytes(6).toString('base64url')}-7!`;
  const admin = { email: `admin@${tenantId}.example.test`, name: 'Avery Admin', password };
  const totpSecret = opts.mess.totp ? newTotpSecret() : null;
  const db = mocksDb();
  await db.query(
    `insert into ${app}.tenants (id, mess, admin_email, admin_name, admin_password_hash, totp_secret)
     values ($1, $2, $3, $4, $5, $6)`,
    [tenantId, opts.mess, admin.email, admin.name, hashPassword(password), totpSecret],
  );
  if (opts.users.length) {
    // Spread created_at so list order (newest first) is deterministic.
    const values: string[] = [];
    const args: unknown[] = [tenantId];
    opts.users.forEach((u, i) => {
      values.push(`($1, $${args.length + 1}, $${args.length + 2}, $${args.length + 3}, now() - interval '${opts.users.length - i} minutes')`);
      args.push(u.email, u.name, u.role);
    });
    await db.query(`insert into ${app}.users (tenant_id, email, name, role, created_at) values ${values.join(',')}`, args);
  }
  return { tenantId, baseUrl: `${origin}/t/${tenantId}`, admin: { ...admin, totpSecret } };
}

// ---------- sessions (in memory; the mock does not need them durable) ----------
export type Session = { tenantId: string; stage: 'password_ok' | 'authed' };
const sessions = new Map<string, Session>();

export function sessionCookieName(app: AppId) {
  return `${app}_sid`;
}

export function readCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function getSession(app: AppId, req: Request, tenantId: string): { sid: string; s: Session } | null {
  const sid = readCookies(req)[sessionCookieName(app)];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s || s.tenantId !== tenantId) return null;
  return { sid, s };
}

export function startSession(app: AppId, res: Response, tenantId: string, stage: Session['stage']): string {
  const sid = randomBytes(18).toString('base64url');
  sessions.set(sid, { tenantId, stage });
  res.cookie(sessionCookieName(app), sid, { httpOnly: true, sameSite: 'lax', path: `/t/${tenantId}` });
  return sid;
}

export function promoteSession(sid: string) {
  const s = sessions.get(sid);
  if (s) s.stage = 'authed';
}

export function endSession(sid: string) {
  sessions.delete(sid);
}

/**
 * Counts authenticated requests per tenant. When the tenant's mess says so, the session dies once,
 * after N requests, and the app shows its "session expired" interstitial.
 */
const authedRequests = new Map<string, number>();
const expiryFired = new Set<string>();

export async function shouldExpire(app: AppId, tenant: Tenant): Promise<boolean> {
  const key = `${app}:${tenant.id}`;
  if (!tenant.mess.sessionExpiry || expiryFired.has(key)) return false;
  const n = (authedRequests.get(key) ?? 0) + 1;
  authedRequests.set(key, n);
  if (n >= tenant.mess.sessionExpiry.afterRequests) {
    expiryFired.add(key);
    await audit(app, tenant.id, 'mess.session_expired');
    return true;
  }
  return false;
}

// ---------- randomized ids and class names ----------
export type Ids = { id: (name: string) => string; c: (name: string) => string; salt: string };

export function makeIds(mess: Mess): Ids {
  const salt = randomBytes(3).toString('hex');
  if (!mess.randomIds) return { id: (n) => n, c: (n) => n, salt: '' };
  const seen = new Map<string, string>();
  return {
    salt,
    id: (n) => {
      let v = seen.get(n);
      if (!v) {
        v = `f${randomBytes(4).toString('hex')}`;
        seen.set(n, v);
      }
      return v;
    },
    c: (n) => `${n}_${salt}`,
  };
}

/** Random field names need a map back to meaning; real apps do this with hidden form tokens. */
export function fieldMapInput(ids: Ids, fields: string[]): string {
  const map = Object.fromEntries(fields.map((f) => [ids.id(f), f]));
  return `<input type="hidden" name="_fm" value="${esc(Buffer.from(JSON.stringify(map)).toString('base64'))}">`;
}

export function readFields(body: Record<string, string>): Record<string, string> {
  if (!body._fm) return body;
  const map: Record<string, string> = JSON.parse(Buffer.from(body._fm, 'base64').toString('utf8'));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) out[map[k] ?? k] = v;
  return out;
}

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

// ---------- page chrome: consent overlay + announcement popup ----------
/**
 * The consent overlay is a full-screen layer that intercepts pointer events until the user picks
 * an option, which is what makes real consent walls break naive automation.
 */
export function consentOverlay(app: AppId, tenantId: string, mess: Mess, ids: Ids): string {
  if (!mess.cookieBanner) return '';
  const c = ids.c;
  return `
<style>
  .${c('cc-wall')}{position:fixed;inset:0;background:rgba(15,23,42,.25);z-index:9000;display:none}
  .${c('cc-box')}{position:fixed;left:16px;right:16px;bottom:16px;max-width:560px;margin:auto;background:#fff;border:1px solid #cbd5e1;
    border-radius:10px;padding:16px 18px;box-shadow:0 10px 30px rgba(0,0,0,.2);font:14px system-ui;z-index:9001}
  .${c('cc-box')} button{margin-right:8px;margin-top:10px;padding:7px 12px;border-radius:6px;border:1px solid #94a3b8;background:#f8fafc;cursor:pointer}
  .${c('cc-box')} button.${c('cc-primary')}{background:#0f172a;color:#fff;border-color:#0f172a}
</style>
<div class="${c('cc-wall')}" id="${ids.id('ccwall')}">
  <div class="${c('cc-box')}" role="dialog" aria-modal="true" aria-label="Cookie preferences">
    <strong>We value your privacy</strong>
    <p style="margin:6px 0 0">We use cookies to keep you signed in and to understand how this portal is used.</p>
    <button type="button" data-cc="settings">Preferences</button>
    <button type="button" data-cc="reject">Reject non-essential</button>
    <button type="button" class="${c('cc-primary')}" data-cc="accept">Accept all</button>
  </div>
</div>
<script>
(function(){
  var key = 'consent_${app}_${tenantId}';
  if (document.cookie.indexOf(key + '=') >= 0) return;
  var wall = document.getElementById('${ids.id('ccwall')}');
  setTimeout(function(){
    wall.style.display = 'block';
    try { navigator.sendBeacon('/t/${tenantId}/__mess?kind=cookie_banner'); } catch (e) {}
  }, ${mess.cookieBanner.delayMs});
  wall.addEventListener('click', function(ev){
    var choice = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-cc');
    if (choice === 'accept' || choice === 'reject') {
      document.cookie = key + '=' + choice + '; path=/';
      wall.remove();
    } else if (choice === 'settings') {
      ev.target.textContent = 'Preferences (coming soon)';
    }
  });
})();
</script>`;
}

export function announcementPopup(tenantId: string, mess: Mess, ids: Ids, title: string): string {
  if (!mess.announcement) return '';
  const c = ids.c;
  return `
<style>
  .${c('ann-back')}{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:8000;display:none;align-items:center;justify-content:center}
  .${c('ann')}{background:#fff;border-radius:12px;padding:22px;max-width:420px;font:14px system-ui}
</style>
<div class="${c('ann-back')}" id="${ids.id('annback')}">
  <div class="${c('ann')}" role="dialog" aria-modal="true" aria-labelledby="${ids.id('anntitle')}">
    <h2 id="${ids.id('anntitle')}" style="margin-top:0">What's new in ${esc(title)}</h2>
    <p>Bulk import is here, and member pages load twice as fast.</p>
    <button type="button" id="${ids.id('anndismiss')}">Dismiss</button>
  </div>
</div>
<script>
(function(){
  var key = 'ann_${tenantId}';
  if (sessionStorage.getItem(key)) return;
  var back = document.getElementById('${ids.id('annback')}');
  setTimeout(function(){
    back.style.display = 'flex';
    try { navigator.sendBeacon('/t/${tenantId}/__mess?kind=announcement'); } catch (e) {}
  }, ${mess.announcement.delayMs});
  document.getElementById('${ids.id('anndismiss')}').addEventListener('click', function(){
    sessionStorage.setItem(key, '1'); back.remove();
  });
})();
</script>`;
}

/**
 * A feedback survey modal. Unlike the cookie wall and the announcement, the engine has no
 * dedicated handler for this one: it is the stand-in for "a popup nobody told us about".
 */
export function surveyPopup(tenantId: string, mess: Mess, ids: Ids): string {
  if (!mess.survey) return '';
  const c = ids.c;
  return `
<style>
  .${c('sv-back')}{position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:8500;display:none;align-items:center;justify-content:center}
  .${c('sv')}{background:#fff;border-radius:10px;padding:20px 22px;max-width:380px;font:14px system-ui}
</style>
<div class="${c('sv-back')}" id="${ids.id('svback')}">
  <div class="${c('sv')}" role="dialog" aria-modal="true" aria-label="Feedback">
    <h3 style="margin-top:0">Got 30 seconds?</h3>
    <p>Tell us how we're doing. It helps us build a better product.</p>
    <button type="button" data-sv="take">Take the survey</button>
    <button type="button" data-sv="no">No thanks</button>
  </div>
</div>
<script>
(function(){
  var key = 'sv_${tenantId}';
  if (sessionStorage.getItem(key)) return;
  var back = document.getElementById('${ids.id('svback')}');
  setTimeout(function(){
    if (sessionStorage.getItem(key)) return;
    back.style.display = 'flex';
    try { navigator.sendBeacon('/t/${tenantId}/__mess?kind=survey'); } catch (e) {}
  }, ${mess.survey.delayMs});
  back.addEventListener('click', function(ev){
    var a = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-sv');
    if (a) { sessionStorage.setItem(key, '1'); back.remove(); }
  });
})();
</script>`;
}

/** Pick the A/B-test variant of a button label. */
export function copy(mess: Mess, normal: string, variant: string): string {
  return mess.labelDrift ? variant : normal;
}

// ---------- app server scaffolding ----------
export type TenantRequest = Request & { tenant: Tenant };

export function tenantRouter(app: AppId): express.Router {
  const r = express.Router({ mergeParams: true });
  r.use(async (req: Request, res: Response, next: NextFunction) => {
    const t = await loadTenant(app, (req.params as Record<string, string>).tenant);
    if (!t) {
      res.status(404).send('Unknown tenant');
      return;
    }
    (req as TenantRequest).tenant = t;
    next();
  });
  // Beacons from the page so the eval knows which client-side mess actually appeared.
  r.post('/__mess', async (req, res) => {
    const kind = String(req.query.kind ?? '');
    if (kind === 'cookie_banner' || kind === 'announcement' || kind === 'survey') await audit(app, (req as TenantRequest).tenant.id, `mess.${kind}`);
    res.status(204).end();
  });
  return r;
}

export function mockServer(app: AppId, mount: (r: express.Router) => void): express.Express {
  const server = express();
  server.disable('x-powered-by');
  server.use(express.urlencoded({ extended: false }));
  server.use(express.json());
  // Test-harness endpoint to create a tenant. Loopback only, like everything else.
  server.post('/__admin/tenants', async (req, res) => {
    const origin = `http://${req.headers.host}`;
    const created = await createTenant(app, origin, req.body);
    res.json(created);
  });
  server.get('/__admin/health', (_req, res) => {
    res.json({ ok: true, app });
  });
  const r = tenantRouter(app);
  mount(r);
  server.use('/t/:tenant', r);
  server.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`[${app}]`, err);
    res.status(500).send('Internal error');
  });
  return server;
}

/** Random delay used by the slow SPA. */
export function latencyFor(mess: Mess): number {
  if (!mess.latency) return 0;
  const { minMs, maxMs, spikeChance, spikeMs } = mess.latency;
  if (Math.random() < spikeChance) return spikeMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
