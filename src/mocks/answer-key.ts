// Read the real end state out of a mock app's database. Evals and tests trust only this.
import { checkPassword, mocksDb } from './core.ts';
import type { AppId } from './mess.ts';

export type UserRow = { id: number; email: string; name: string; role: string; status: string };

export async function activeUsersByEmail(app: AppId, tenantId: string, email: string): Promise<UserRow[]> {
  const r = await mocksDb().query(
    `select id, email, name, role, status from ${app}.users where tenant_id = $1 and lower(email) = lower($2) and status = 'active'`,
    [tenantId, email],
  );
  return r.rows;
}

export async function activeUserCount(app: AppId, tenantId: string): Promise<number> {
  const r = await mocksDb().query(`select count(*)::int as n from ${app}.users where tenant_id = $1 and status = 'active'`, [tenantId]);
  return r.rows[0].n;
}

export async function auditCount(app: AppId, tenantId: string, action: string): Promise<number> {
  const r = await mocksDb().query(`select count(*)::int as n from ${app}.audit where tenant_id = $1 and action = $2`, [tenantId, action]);
  return r.rows[0].n;
}

export async function auditActions(app: AppId, tenantId: string): Promise<string[]> {
  const r = await mocksDb().query(`select action from ${app}.audit where tenant_id = $1 order by id`, [tenantId]);
  return r.rows.map((x) => x.action);
}

export async function adminPasswordIs(app: AppId, tenantId: string, password: string): Promise<boolean> {
  const r = await mocksDb().query(`select admin_password_hash from ${app}.tenants where id = $1`, [tenantId]);
  return r.rows[0] ? checkPassword(password, r.rows[0].admin_password_hash) : false;
}
