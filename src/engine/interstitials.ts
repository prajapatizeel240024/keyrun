// Known interstitials: things that pop up between you and the page you wanted.
// The runner checks for these before every step and whenever a step attempt fails.
import type { Locator, Page } from 'playwright';

export type InterstitialKind = 'session_expired' | 'cookie_banner' | 'announcement' | 'unknown_popup';

export type Interstitial = {
  kind: InterstitialKind;
  /** Only consulted after an action failed (it is a heuristic, so it does not run proactively). */
  afterFailureOnly?: boolean;
  /** Returns something visible if this interstitial is on screen. Must not wait. */
  detect(page: Page): Promise<Locator | null>;
  /** 'continue' = dismissed, carry on. 'relogin' = sign in again and resume from the last checkpoint. */
  handle(page: Page, found: Locator): Promise<'continue' | 'relogin'>;
};

/** Buttons that decline or close without committing to anything. Never "OK", "Cancel" or "Confirm". */
const SAFE_DISMISS = /^(no,? thanks|not now|maybe later|remind me later|skip|dismiss|close|×|✕)$/i;

async function firstVisible(loc: Locator): Promise<Locator | null> {
  const v = loc.filter({ visible: true });
  return (await v.count().catch(() => 0)) > 0 ? v.first() : null;
}

export const INTERSTITIALS: Interstitial[] = [
  {
    kind: 'session_expired',
    detect: (page) =>
      firstVisible(page.getByText(/session (has )?expired|signed out due to inactivity|you were signed out/i)),
    async handle(page) {
      // Click the interstitial's own way out if it has one (an in-app modal must be closed),
      // then let the runner drive the login steps.
      const btn = await firstVisible(page.getByRole('button', { name: /^(log ?in|sign ?in)( again)?$/i }));
      if (btn) await btn.click({ timeout: 2000 }).catch(() => {});
      return 'relogin';
    },
  },
  {
    kind: 'cookie_banner',
    detect: (page) => firstVisible(page.getByRole('dialog', { name: /cookie|privacy|consent/i })),
    async handle(_page, found) {
      const accept = found.getByRole('button', { name: /^(accept all|accept|allow all|agree|i agree|got it|ok)$/i }).first();
      await accept.click({ timeout: 2000 });
      return 'continue';
    },
  },
  {
    kind: 'announcement',
    detect: (page) => firstVisible(page.getByRole('dialog', { name: /what'?s new|announcement|new feature/i })),
    async handle(_page, found) {
      await found.getByRole('button', { name: /^(dismiss|close|got it|maybe later|skip)$/i }).first().click({ timeout: 2000 });
      return 'continue';
    },
  },
  {
    // Last resort for popups nobody told us about (surveys, promos). Added after the eval showed
    // a feedback survey blocking clicks. It only ever presses a non-committal way out, and only
    // once an action has already failed, so it cannot pre-empt a dialog the workflow wants.
    kind: 'unknown_popup',
    afterFailureOnly: true,
    detect: (page) =>
      firstVisible(
        page.getByRole('dialog').or(page.getByRole('alertdialog'))
          .filter({ has: page.getByRole('button', { name: SAFE_DISMISS }) }),
      ),
    async handle(_page, found) {
      await found.getByRole('button', { name: SAFE_DISMISS }).first().click({ timeout: 2000 });
      return 'continue';
    },
  },
];
