// Client-side TOTP that respects server replay protection: never reuse a time step we already
// submitted for this secret. If the next unused step is too far ahead, wait for the clock.
import { counterAt, hotp, TOTP_STEP_SECONDS } from '../shared/totp.ts';
import { sleep } from './retry.ts';

const lastUsed = new Map<string, number>();

export async function nextTotp(secret: string): Promise<string> {
  for (;;) {
    const now = counterAt();
    const want = Math.max(now, (lastUsed.get(secret) ?? -1) + 1);
    if (want <= now + 1) {
      lastUsed.set(secret, want);
      return hotp(secret, want);
    }
    // Wait until `want` is within the server's +1 window.
    const msIntoStep = Date.now() % (TOTP_STEP_SECONDS * 1000);
    await sleep(TOTP_STEP_SECONDS * 1000 - msIntoStep + 50);
  }
}
