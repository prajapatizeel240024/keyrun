// Multi-strategy element resolution. For one target we try every strategy the workflow lists,
// in a fixed order, and accept the first that matches exactly one visible element.
// Retrying (with backoff) happens one level up, in the runner.
import type { FrameLocator, Locator, Page } from 'playwright';
import { STRATEGIES, type Strategy, type Target } from './schema.ts';

type Root = Page | FrameLocator | Locator;
type Sub = (s: string) => string;

export type Resolved = { loc: Locator; strategy: Strategy; fallback: boolean };
export type Probe = { resolved?: Resolved; ambiguous: Strategy[] };

function build(page: Page, root: Root, s: Strategy, t: Target, sub: Sub): Locator {
  switch (s) {
    case 'role': {
      const name = t.role!.name === undefined ? undefined : sub(t.role!.name);
      // Role names come from workflows as strings, so cast to Playwright's role union.
      return root.getByRole(t.role!.role as Parameters<Page['getByRole']>[0], { name, exact: t.role!.exact ?? t.exact });
    }
    case 'label':
      return root.getByLabel(sub(t.label!), { exact: t.exact });
    case 'placeholder':
      return root.getByPlaceholder(sub(t.placeholder!), { exact: t.exact });
    case 'text':
      return root.getByText(sub(t.text!), { exact: t.exact });
    case 'testId':
      return root.getByTestId(sub(t.testId!));
    case 'css':
      void page;
      return root.locator(sub(t.css!));
  }
}

function narrow(page: Page, loc: Locator, t: Target, sub: Sub): Locator {
  let out = loc;
  if (t.hasText) out = out.filter({ hasText: sub(t.hasText) });
  // `has` is evaluated relative to each candidate, so a page-rooted text locator works inside frames too.
  if (t.hasExactText) out = out.filter({ has: page.getByText(sub(t.hasExactText), { exact: true }) });
  return out.filter({ visible: true });
}

function rootFor(page: Page, t: Target, sub: Sub, parent?: Root): Root {
  const base = parent ?? page;
  return t.frame ? base.frameLocator(sub(t.frame)) : base;
}

/** One pass over the strategies. Does not wait. */
export async function probe(page: Page, t: Target, sub: Sub, parent?: Root): Promise<Probe> {
  let root = rootFor(page, t, sub, parent);
  if (t.within) {
    const scope = await probe(page, t.within, sub, root);
    if (!scope.resolved) return { ambiguous: scope.ambiguous };
    root = scope.resolved.loc;
  }
  const listed = STRATEGIES.filter((s) => t[s] !== undefined);
  const ambiguous: Strategy[] = [];
  for (const [i, s] of listed.entries()) {
    const loc = narrow(page, build(page, root, s, t, sub), t, sub);
    let n = 0;
    try {
      n = await loc.count();
    } catch {
      n = 0; // e.g. the iframe is mid-navigation
    }
    if (n === 1) return { resolved: { loc, strategy: s, fallback: i > 0 }, ambiguous };
    if (n > 1 && t.nth !== undefined) return { resolved: { loc: loc.nth(t.nth), strategy: s, fallback: i > 0 }, ambiguous };
    if (n > 1) ambiguous.push(s);
  }
  return { ambiguous };
}

/** All visible matches of the first strategy that matches anything (for list rows). */
export async function probeMany(page: Page, t: Target, sub: Sub): Promise<Locator | null> {
  let root = rootFor(page, t, sub);
  if (t.within) {
    const scope = await probe(page, t.within, sub, root);
    if (!scope.resolved) return null;
    root = scope.resolved.loc;
  }
  for (const s of STRATEGIES.filter((x) => t[x] !== undefined)) {
    const loc = narrow(page, build(page, root, s, t, sub), t, sub);
    if ((await loc.count().catch(() => 0)) > 0) return loc;
  }
  return null;
}

/** Short description of a target for logs (templates only, never resolved secrets). */
export function describeTarget(t: Target): string {
  const parts: string[] = [];
  if (t.role) parts.push(`role=${t.role.role}${t.role.name ? `[${t.role.name}]` : ''}`);
  if (t.label) parts.push(`label=${t.label}`);
  if (t.placeholder) parts.push(`placeholder=${t.placeholder}`);
  if (t.text) parts.push(`text=${t.text}`);
  if (t.testId) parts.push(`testId=${t.testId}`);
  if (t.css) parts.push(`css=${t.css}`);
  let s = parts.join(' | ');
  if (t.hasExactText) s += ` having "${t.hasExactText}"`;
  if (t.within) s += ` within (${describeTarget(t.within)})`;
  if (t.frame) s += ` in frame ${t.frame}`;
  return s;
}
