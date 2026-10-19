// Record a workflow by using the app in a real browser window.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { assertLoopbackUrl } from '../config.ts';
import type { Workflow } from '../engine/schema.ts';
import { guessBaseUrl } from './base-url.ts';
import { eventsToWorkflow, type RecordedEvent } from './to-workflow.ts';

const INJECT = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'inject.js'), 'utf8');

export type Recording = {
  page: Page;
  events: RecordedEvent[];
  /** Stop recording and build the draft workflow. */
  stop(): Promise<Workflow>;
  closed: Promise<void>;
};

export async function startRecording(opts: {
  url: string;
  app: string;
  kind: string;
  baseUrl?: string;
  headless?: boolean;
  browser?: Browser;
}): Promise<Recording> {
  assertLoopbackUrl(opts.url);
  const browser = opts.browser ?? (await chromium.launch({ headless: opts.headless ?? false }));
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const events: RecordedEvent[] = [];
  await context.exposeBinding('__keyrunRecord', (_source, evt: RecordedEvent) => {
    events.push(evt);
  });
  await context.addInitScript(INJECT);
  const page = await context.newPage();
  await page.goto(opts.url);
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  page.on('close', () => resolveClosed());
  let stopped = false;
  return {
    page,
    events,
    closed,
    async stop() {
      if (!stopped) {
        stopped = true;
        await page.waitForTimeout(150).catch(() => {}); // let the last binding calls land
        await context.close().catch(() => {});
        if (!opts.browser) await browser.close().catch(() => {});
      }
      return eventsToWorkflow(events, { startUrl: opts.url, baseUrl: opts.baseUrl ?? guessBaseUrl(opts.url), app: opts.app, kind: opts.kind });
    },
  };
}
