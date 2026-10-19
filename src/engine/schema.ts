// Workflow JSON schema. Workflows are data: the recorder writes them, the editor edits them,
// the server stores them, and only the engine on the device executes them.
import { z } from 'zod';

const RoleRef = z.object({
  role: z.string(),
  name: z.string().optional(),
  exact: z.boolean().optional(),
}).strict();

/**
 * How to find one element. Strategies are tried in a fixed order:
 * role → label → placeholder → text → testId → css. The first that matches exactly one
 * visible element wins; the rest are fallbacks.
 */
export type Target = {
  role?: { role: string; name?: string; exact?: boolean };
  label?: string;
  placeholder?: string;
  text?: string;
  testId?: string;
  css?: string;
  /** Match label/text exactly instead of as a case-insensitive substring. */
  exact?: boolean;
  /** Keep only matches whose text contains this. */
  hasText?: string;
  /** Keep only matches that contain an element whose full text is exactly this (e.g. an email cell). */
  hasExactText?: string;
  /** CSS selector of the iframe the element lives in. */
  frame?: string;
  /** If several elements match, take this one (0-based) instead of treating it as ambiguous. */
  nth?: number;
  /** Resolve this container first and search inside it (e.g. the row for one user, or a dialog). */
  within?: Target;
};

export const STRATEGIES = ['role', 'label', 'placeholder', 'text', 'testId', 'css'] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const TargetSchema: z.ZodType<Target> = z.lazy(() =>
  z.object({
    role: RoleRef.optional(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    text: z.string().optional(),
    testId: z.string().optional(),
    css: z.string().optional(),
    exact: z.boolean().optional(),
    hasText: z.string().optional(),
    hasExactText: z.string().optional(),
    frame: z.string().optional(),
    nth: z.number().int().min(0).optional(),
    within: TargetSchema.optional(),
  }).strict().refine(
    (t) => STRATEGIES.some((k) => t[k] !== undefined),
    { message: 'a target needs at least one strategy (role, label, placeholder, text, testId or css)' },
  ),
);

const base = {
  /** Optional human note shown in the editor. */
  note: z.string().optional(),
  /** Resume point after a forced re-login (top-level steps only). */
  checkpoint: z.boolean().optional(),
  /**
   * This step commits the change (e.g. the final "Create" click). If a later re-login finds the
   * change already in place, the run reports success rather than no-op, because it was this run.
   */
  effect: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
};

const Navigate = z.object({ op: z.literal('navigate'), url: z.string(), ...base }).strict();
const Fill = z.object({
  op: z.literal('fill'),
  target: TargetSchema,
  value: z.string(),
  /** 'type' presses keys one by one into the focused element (for auto-advancing code boxes). */
  mode: z.enum(['fill', 'type']).optional(),
  /** Read the value back after filling (default true for mode 'fill'). */
  verify: z.boolean().optional(),
  ...base,
}).strict();
const Select = z.object({ op: z.literal('select'), target: TargetSchema, value: z.string(), ...base }).strict();
const Check = z.object({ op: z.literal('check'), target: TargetSchema, ...base }).strict();
const Click = z.object({
  op: z.literal('click'),
  target: TargetSchema,
  /** Skip quietly if the element does not show up within timeoutMs (default 2 s). */
  optional: z.boolean().optional(),
  ...base,
}).strict();
const Press = z.object({ op: z.literal('press'), target: TargetSchema.optional(), key: z.string(), ...base }).strict();
const Wait = z.object({
  op: z.literal('wait'),
  target: TargetSchema.optional(),
  state: z.enum(['visible', 'hidden']).optional(),
  url: z.string().optional(),
  ms: z.number().int().nonnegative().optional(),
  ...base,
}).strict();
const Assert = z.object({
  op: z.literal('assert'),
  target: TargetSchema.optional(),
  /** Text the target must contain. */
  text: z.string().optional(),
  urlIncludes: z.string().optional(),
  ...base,
}).strict();
const FindInPages = z.object({
  op: z.literal('findInPages'),
  /** One row of the list. */
  row: TargetSchema,
  /** Exact text of a cell that identifies the row we want (usually the email). */
  match: z.string(),
  /** Visible once a page of the list has loaded; its text changes from page to page (e.g. "Page 2 of 4"). */
  ready: TargetSchema,
  /** The "next page" control. When it is missing or disabled, the search ends. */
  next: TargetSchema,
  /** Variable that receives "true" or "false". */
  saveAs: z.string(),
  maxPages: z.number().int().positive().optional(),
  ...base,
}).strict();
const End = z.object({
  op: z.literal('end'),
  outcome: z.enum(['succeeded', 'noop']),
  message: z.string(),
  ...base,
}).strict();

export type Step =
  | z.infer<typeof Navigate>
  | z.infer<typeof Fill>
  | z.infer<typeof Select>
  | z.infer<typeof Check>
  | z.infer<typeof Click>
  | z.infer<typeof Press>
  | z.infer<typeof Wait>
  | z.infer<typeof Assert>
  | z.infer<typeof FindInPages>
  | z.infer<typeof End>
  | { op: 'if'; var: string; equals: string; then: Step[]; else?: Step[]; note?: string; checkpoint?: boolean; effect?: boolean; timeoutMs?: number };

export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion('op', [
    Navigate, Fill, Select, Check, Click, Press, Wait, Assert, FindInPages, End,
    z.object({
      op: z.literal('if'),
      var: z.string(),
      equals: z.string(),
      then: z.array(StepSchema),
      else: z.array(StepSchema).optional(),
      ...base,
    }).strict(),
  ]),
) as z.ZodType<Step>;

export const LIFECYCLE_KINDS = ['sign_in', 'create_user', 'remove_user', 'rotate_password'] as const;

export const WorkflowSchema = z.object({
  id: z.string(),
  app: z.string(),
  kind: z.string(),
  version: z.number().int().positive(),
  description: z.string(),
  /** Non-secret inputs (sent by the server in the clear). */
  params: z.record(z.string(), z.object({ description: z.string(), example: z.string().optional() })).default({}),
  /** Names of secret inputs, filled on the device from the decrypted credential. */
  secrets: z.array(z.enum(['username', 'password', 'totpSecret', 'newPassword'])).default([]),
  /** Sign-in steps. Run first, and again whenever a session-expired interstitial shows up. */
  login: z.array(StepSchema),
  steps: z.array(StepSchema),
}).strict();
export type Workflow = z.infer<typeof WorkflowSchema>;

export function parseWorkflow(json: unknown): Workflow {
  return WorkflowSchema.parse(json);
}

/** Human-readable list of problems, for the editor. */
export function validateWorkflow(json: unknown): { ok: true; workflow: Workflow } | { ok: false; errors: string[] } {
  const r = WorkflowSchema.safeParse(json);
  if (r.success) return { ok: true, workflow: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
