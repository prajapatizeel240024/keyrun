// `npm run server`: control plane on 127.0.0.1 (dashboard at /, workflow editor at /builder).
import type { Server } from 'node:http';
import type pg from 'pg';
import { config, HOST } from '../config.ts';
import { pool } from '../db/pool.ts';
import { APP_NAMES } from '../mocks/index.ts';
import { APP_IDS } from '../mocks/mess.ts';
import { isMain } from '../shared/is-main.ts';
import { buildServer } from './app.ts';
import { syncRepoWorkflows, upsertApp } from './store.ts';

export async function startControlPlane(db: pg.Pool, port = config.serverPort): Promise<{ server: Server; url: string; added: number }> {
  // Register the three mock apps (base URLs are pointed at real tenants by the demo setup).
  for (const id of APP_IDS) {
    const exists = (await db.query(`select 1 from apps where id = $1`, [id])).rowCount;
    if (!exists) await upsertApp(db, { id, name: APP_NAMES[id], baseUrl: `http://${HOST}:${config.ports[id]}/t/demo` });
  }
  const added = await syncRepoWorkflows(db);
  const server = await new Promise<Server>((resolve, reject) => {
    const s = buildServer({ db, adminToken: config.adminToken }).listen(port, HOST, () => resolve(s));
    s.on('error', reject);
  });
  return { server, url: `http://${HOST}:${port}`, added };
}

if (isMain(import.meta.url)) {
  const { url, added } = await startControlPlane(pool(config.databaseUrl));
  console.log(`Keyrun control plane on ${url}  (dashboard /, workflow editor /builder)`);
  if (added) console.log(`Loaded ${added} workflow version(s) from workflows/.`);
  if (config.adminToken === 'dev-admin-token') console.log('Admin token: dev-admin-token (set KEYRUN_ADMIN_TOKEN to change it)');
}
