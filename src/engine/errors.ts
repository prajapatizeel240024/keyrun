// Failure taxonomy. Every failed run ends with exactly one of these reasons, which is what the
// eval report groups by and what the agent reports to the server (never a screenshot or trace).
export const FAILURE_REASONS = [
  'element_not_found', // no strategy found a visible match before the step timed out
  'ambiguous_element', // strategies matched, but only ever more than one element
  'action_failed', // found the element but the click/fill kept failing (covered, disabled, detached)
  'fill_mismatch', // the field did not hold the value we typed (re-rendered, masked, truncated)
  'assertion_failed', // the expected end state never appeared
  'navigation_failed',
  'relogin_limit', // the session kept expiring
  'secret_origin_blocked', // a step tried to type a secret into a page outside the credential's origins
  'non_loopback_url', // Keyrun only automates local apps
  'pagination_limit',
  'bad_template',
  'run_timeout',
  'unexpected_error',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/** Reasons worth retrying later (the page may simply have been slow or flaky). */
export const RETRYABLE: ReadonlySet<FailureReason> = new Set([
  'element_not_found', 'action_failed', 'fill_mismatch', 'assertion_failed', 'navigation_failed', 'relogin_limit', 'run_timeout', 'unexpected_error',
]);

export class StepFailure extends Error {
  constructor(public reason: FailureReason, message: string) {
    super(message);
  }
}

/** Thrown when a session-expired interstitial is detected: re-run login, resume at the last checkpoint. */
export class ReloginSignal extends Error {
  constructor(public via: string) {
    super(`session expired (${via})`);
  }
}

/** Thrown by an `end` step to finish early, e.g. "user already exists". */
export class EndSignal extends Error {
  constructor(public outcome: 'succeeded' | 'noop', message: string) {
    super(message);
  }
}

export function classify(e: unknown): { reason: FailureReason; message: string } {
  if (e instanceof StepFailure) return { reason: e.reason, message: e.message };
  const msg = e instanceof Error ? e.message : String(e);
  if (/net::|NS_ERROR|ERR_CONNECTION|navigation/i.test(msg)) return { reason: 'navigation_failed', message: firstLine(msg) };
  return { reason: 'unexpected_error', message: firstLine(msg) };
}

export function firstLine(s: string): string {
  return s.split('\n')[0].slice(0, 300);
}
