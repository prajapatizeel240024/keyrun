// Per-app controls: when tasks may run, and which kinds need a second person to approve.
import { z } from 'zod';

export const PolicySchema = z.object({
  /** IANA zone the allowed hours are written in. */
  timezone: z.string().default('UTC'),
  /** Tasks run only inside this window. Omit for "any time". end < start means overnight. */
  allowedHours: z
    .object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      /** 0 = Sunday … 6 = Saturday. Omit for every day. */
      days: z.array(z.number().int().min(0).max(6)).optional(),
    })
    .optional(),
  /** Task kinds that need approval from someone other than the requester. */
  requireApproval: z.array(z.string()).default([]),
});
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = {
  timezone: 'UTC',
  requireApproval: ['create_user', 'remove_user', 'rotate_password'],
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function localParts(now: Date, tz: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: WEEKDAYS.indexOf(get('weekday')), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function withinAllowedHours(policy: Policy, now = new Date()): boolean {
  const w = policy.allowedHours;
  if (!w) return true;
  const { day, minutes } = localParts(now, policy.timezone);
  const start = toMinutes(w.start);
  const end = toMinutes(w.end);
  if (start === end) return !w.days || w.days.includes(day);
  if (start < end) return (!w.days || w.days.includes(day)) && minutes >= start && minutes < end;
  // Overnight window: the part after midnight belongs to the previous day's window.
  if (minutes >= start) return !w.days || w.days.includes(day);
  if (minutes < end) return !w.days || w.days.includes((day + 6) % 7);
  return false;
}

export function needsApproval(policy: Policy, kind: string): boolean {
  return policy.requireApproval.includes(kind);
}

export function describeWindow(policy: Policy): string {
  const w = policy.allowedHours;
  if (!w) return 'any time';
  const days = w.days ? w.days.map((d) => WEEKDAYS[d]).join(',') : 'every day';
  return `${w.start}–${w.end} ${policy.timezone} (${days})`;
}
