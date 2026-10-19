import pg from 'pg';

// bytea comes back as Buffer, bigint (int8) as number: our counters fit comfortably.
pg.types.setTypeParser(20, (v) => Number(v));

const pools = new Map<string, pg.Pool>();

export function pool(url: string): pg.Pool {
  let p = pools.get(url);
  if (!p) {
    p = new pg.Pool({ connectionString: url, max: 10 });
    pools.set(url, p);
  }
  return p;
}

export async function closeAllPools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((p) => p.end()));
}

export type Queryable = pg.Pool | pg.PoolClient;

export async function withTx<T>(p: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
