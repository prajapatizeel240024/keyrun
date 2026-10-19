import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTx } from './pool.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');

/** Apply db/<target>/*.sql in filename order, once each. */
export async function migrate(url: string, target: 'control' | 'mocks'): Promise<string[]> {
  const p = pool(url);
  await p.query(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await p.query('select name from schema_migrations')).rows.map((r) => r.name));
  const dir = path.join(root, target);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(dir, f), 'utf8');
    await withTx(p, async (c) => {
      await c.query(sql);
      await c.query('insert into schema_migrations (name) values ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}
