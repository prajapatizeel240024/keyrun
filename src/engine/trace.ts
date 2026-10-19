// Playwright tracing with secrets kept out.
//
// Playwright traces record every API call's arguments (including the text passed to fill), DOM
// snapshots that include input values (password fields too), and request bodies (a login POST).
// So the trace is recorded in parts: tracing stops completely before any step that handles a
// secret, and starts again only once no input still holds a secret value and every request sent
// while stopped has finished. (Trace *chunks* are not enough: the network log keeps recording
// between chunks; the eval's trace check caught that.) test/engine.test.ts unzips a failure
// trace and checks that no secret appears in it, in any encoding.
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page, Request } from 'playwright';

export class SecretSafeTrace {
  private chunks: string[] = [];
  private recording = false;
  private n = 0;
  /** Requests sent while recording was paused. Their bodies may carry a secret (a login POST),
   *  and Playwright writes the network entry when the response completes, so we stay paused
   *  until every one of them has finished. */
  private inflight = new Set<Request>();

  constructor(private context: BrowserContext, private dir: string) {
    context.on('request', (r) => {
      if (!this.recording) this.inflight.add(r);
    });
    const done = (r: Request) => this.inflight.delete(r);
    context.on('requestfinished', done);
    context.on('requestfailed', done);
  }

  async start(): Promise<void> {
    await this.context.tracing.start({ screenshots: true, snapshots: true });
    this.recording = true;
  }

  /** Stop recording (keeping what we have so far) before a secret-bearing step. */
  async pause(): Promise<void> {
    if (!this.recording) return;
    await mkdir(this.dir, { recursive: true });
    const p = path.join(this.dir, `trace-part${++this.n}.zip`);
    await this.context.tracing.stop({ path: p });
    this.chunks.push(p);
    this.recording = false;
  }

  /** Resume only if no field on any frame still holds one of the secret values. */
  async resumeIfClean(page: Page, secretValues: string[]): Promise<boolean> {
    if (this.recording) return true;
    if (this.inflight.size > 0) return false;
    if (await fieldsHoldSecret(page, secretValues)) return false;
    await this.context.tracing.start({ screenshots: true, snapshots: true });
    this.recording = true;
    return true;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  /** On failure, keep every chunk. On success, throw them away. Returns kept paths. */
  async finish(keep: boolean): Promise<string[]> {
    if (this.recording) {
      this.recording = false;
      if (keep) {
        await mkdir(this.dir, { recursive: true });
        const p = path.join(this.dir, `trace-part${++this.n}.zip`);
        await this.context.tracing.stop({ path: p });
        this.chunks.push(p);
      } else {
        await this.context.tracing.stop();
      }
    }
    if (!keep) {
      await Promise.all(this.chunks.map((c) => rm(c, { force: true })));
      return [];
    }
    return this.chunks;
  }
}

export async function fieldsHoldSecret(page: Page, secretValues: string[]): Promise<boolean> {
  const values = secretValues.filter((v) => v && v.length >= 4);
  if (!values.length) return false;
  for (const frame of page.frames()) {
    const dirty = await frame
      .evaluate((vals) => Array.from(document.querySelectorAll('input, textarea')).some((el) => vals.includes((el as HTMLInputElement).value)), values)
      .catch(() => false);
    if (dirty) return true;
  }
  return false;
}
