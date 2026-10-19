export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with jitter: 150, 300, 600, 1200, then 2000 ms max. */
export function backoffMs(attempt: number, baseMs = 150, capMs = 2000): number {
  return Math.min(capMs, baseMs * 2 ** attempt) + Math.floor(Math.random() * 100);
}

/**
 * Call `attempt` until it returns a value or the deadline passes. Between attempts, `between`
 * runs (the engine uses it to clear interstitials) and we back off.
 */
export async function retryUntil<T>(
  deadline: number,
  attempt: (n: number) => Promise<T | undefined>,
  between?: (n: number, err?: unknown) => Promise<void>,
): Promise<{ value: T; attempts: number } | { value: undefined; attempts: number; lastError?: unknown }> {
  let n = 0;
  let lastError: unknown;
  for (;;) {
    try {
      const v = await attempt(n);
      if (v !== undefined) return { value: v, attempts: n + 1 };
      lastError = undefined;
    } catch (e) {
      lastError = e;
    }
    if (between) await between(n, lastError);
    if (Date.now() + 50 >= deadline) return { value: undefined, attempts: n + 1, lastError };
    await sleep(Math.min(backoffMs(n), Math.max(0, deadline - Date.now())));
    n++;
  }
}
