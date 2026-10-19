// "Mess" is everything that makes real admin portals hard to automate.
// Each mock app supports the mess that is realistic for its style, and the eval samples it per run.
import type { Rng } from '../shared/rng.ts';

export type AppId = 'hr' | 'helpdesk' | 'directory';
export const APP_IDS: AppId[] = ['hr', 'helpdesk', 'directory'];

export type Mess = {
  /** Field ids, names and CSS class names change on every page load (or render, for the SPA). */
  randomIds: boolean;
  /** The sign-in form lives inside an iframe. */
  iframeLogin: boolean;
  /** A TOTP second step after the password. */
  totp: boolean;
  /** A consent overlay that blocks clicks until dismissed; may appear after a delay. */
  cookieBanner: null | { delayMs: number };
  /** Slow single-page app: every API call waits, with occasional long spikes. */
  latency: null | { minMs: number; maxMs: number; spikeChance: number; spikeMs: number };
  /** The session dies after N authenticated requests and an interstitial appears (once per tenant). */
  sessionExpiry: null | { afterRequests: number };
  /** Rows per page in the user list. */
  pageSize: number;
  /** A "What's new" modal that pops over the dashboard. */
  announcement: null | { delayMs: number };
  /** A/B copy test: primary buttons carry different labels ("Create person" becomes "Save"). */
  labelDrift: boolean;
  /** A feedback-survey modal the engine has no specific handler for. */
  survey: null | { delayMs: number };
};

export const MESS_KINDS = [
  'random_ids',
  'iframe_login',
  'totp',
  'cookie_banner',
  'slow_spa',
  'session_expired',
  'pagination',
  'confirm_modal',
  'announcement',
  'label_drift',
  'unknown_popup',
] as const;
export type MessKind = (typeof MESS_KINDS)[number];

export function calmMess(overrides: Partial<Mess> = {}): Mess {
  return {
    randomIds: false,
    iframeLogin: false,
    totp: false,
    cookieBanner: null,
    latency: null,
    sessionExpiry: null,
    pageSize: 10,
    announcement: null,
    labelDrift: false,
    survey: null,
    ...overrides,
  };
}

/** What each app looks like structurally (always on) plus the random mess the eval layers on top. */
export function sampleMess(app: AppId, rng: Rng): Mess {
  switch (app) {
    case 'hr':
      // Old server-rendered HR portal: iframe login, random ids, consent wall, short sessions.
      return {
        randomIds: true,
        iframeLogin: true,
        totp: false,
        cookieBanner: rng.chance(0.6) ? { delayMs: rng.int(0, 2000) } : null,
        latency: null,
        sessionExpiry: rng.chance(0.35) ? { afterRequests: rng.int(1, 5) } : null,
        pageSize: rng.pick([5, 8, 10]),
        announcement: null,
        labelDrift: rng.chance(0.3),
        survey: rng.chance(0.2) ? { delayMs: rng.int(0, 3000) } : null,
      };
    case 'helpdesk':
      // Slow SPA with TOTP, ids that change on every render, and an in-app expiry modal.
      return {
        randomIds: true,
        iframeLogin: false,
        totp: true,
        cookieBanner: rng.chance(0.5) ? { delayMs: rng.int(0, 2500) } : null,
        latency: { minMs: 150, maxMs: 1500, spikeChance: 0.08, spikeMs: 4500 },
        sessionExpiry: rng.chance(0.35) ? { afterRequests: rng.int(2, 8) } : null,
        pageSize: rng.pick([6, 10]),
        announcement: null,
        labelDrift: rng.chance(0.3),
        survey: rng.chance(0.2) ? { delayMs: rng.int(0, 3000) } : null,
      };
    case 'directory':
      // Newer directory admin: iframe login with a 6-box TOTP, type-to-confirm delete, popups.
      return {
        randomIds: rng.chance(0.7),
        iframeLogin: true,
        totp: true,
        cookieBanner: rng.chance(0.5) ? { delayMs: rng.int(0, 1500) } : null,
        latency: null,
        sessionExpiry: rng.chance(0.3) ? { afterRequests: rng.int(1, 4) } : null,
        pageSize: rng.pick([5, 10]),
        announcement: rng.chance(0.4) ? { delayMs: rng.int(0, 1500) } : null,
        labelDrift: rng.chance(0.3),
        survey: rng.chance(0.2) ? { delayMs: rng.int(0, 3000) } : null,
      };
  }
}

/** The mess kinds that were actually in play for one run, used to slice eval results. */
export function activeMessKinds(mess: Mess, opts: { kind: string; targetPage: number | null }): MessKind[] {
  const out: MessKind[] = [];
  if (mess.randomIds) out.push('random_ids');
  if (mess.iframeLogin) out.push('iframe_login');
  if (mess.totp) out.push('totp');
  if (mess.cookieBanner) out.push('cookie_banner');
  if (mess.latency) out.push('slow_spa');
  if (mess.sessionExpiry) out.push('session_expired');
  if (opts.targetPage !== null && opts.targetPage > 1) out.push('pagination');
  if (opts.kind === 'remove_user') out.push('confirm_modal');
  if (mess.announcement) out.push('announcement');
  if (mess.labelDrift) out.push('label_drift');
  if (mess.survey) out.push('unknown_popup');
  return out;
}
