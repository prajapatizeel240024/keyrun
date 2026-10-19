// Creates the three databases if they are missing and applies migrations.
//   keyrun        control plane (tasks, ciphertext credentials, workflows)
//   keyrun_mocks  the mock apps' own data (the eval answer key)
//   keyrun_test   control plane schema for the test suite
import pg from 'pg';
import { config } from '../config.ts';
import { migrate } from './migrate.ts';
import { closeAllPools } from './pool.ts';
import { isMain } from '../shared/is-main.ts';

export async function ensureDatabase(url: string): Promise<void> {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    const exists = await c.query('select 1 from pg_database where datname = $1', [name]);
    if (exists.rowCount === 0) await c.query(`create database "${name.replace(/"/g, '')}"`);
  } finally {
    await c.end();
  }
}

export async function setupAll(): Promise<void> {
  const targets: Array<[string, 'control' | 'mocks']> = [
    [config.databaseUrl, 'control'],
    [config.mocksDatabaseUrl, 'mocks'],
    [config.testDatabaseUrl, 'control'],
  ];
  for (const [url, target] of targets) {
    await ensureDatabase(url);
    const applied = await migrate(url, target);
    const db = new URL(url).pathname.slice(1);
    console.log(`${db}: ${applied.length ? `applied ${applied.join(', ')}` : 'up to date'}`);
  }
}

if (isMain(import.meta.url)) {
  setupAll()
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(closeAllPools);
}
