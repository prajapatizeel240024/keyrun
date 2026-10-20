// Turn raw recorder events into an editable workflow draft:
//  - consecutive typing into one field becomes a single fill
//  - six one-digit code boxes become one "type {{totp}}" step
//  - secrets become {{secrets.*}} placeholders (their values were never recorded)
//  - other typed values become named params, and the same literal elsewhere (e.g. the email
//    in a table row) is replaced by the same param, so the draft is reusable
//  - steps up to the sign-in submit go into `login`, the rest into `steps`
import type { Step, Target, Workflow } from '../engine/schema.ts';

export type RecordedEvent = {
  type: 'click' | 'fill' | 'otp' | 'select' | 'check' | 'press';
  target: Target;
  url: string;
  framePath: string[];
  ts: number;
  value?: string | null;
  secret?: 'username' | 'password' | 'newPassword' | 'totp' | null;
  fieldName?: string;
  key?: string;
};

type Draft = { step: Step; secret?: string; param?: { name: string; value: string } };

function withFrame(t: Target, framePath: string[]): Target {
  if (!framePath.length) return t;
  // The engine supports one level of iframe (enough for every login frame we have seen).
  return { ...t, frame: framePath[framePath.length - 1] };
}

function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
  return out || 'value';
}

export function eventsToWorkflow(
  events: RecordedEvent[],
  opts: { startUrl: string; baseUrl: string; app: string; kind: string; description?: string },
): Workflow {
  const drafts: Draft[] = [];
  const sameTarget = (a: Target, b: Target) => JSON.stringify(a) === JSON.stringify(b);
  for (const e of events) {
    const target = withFrame(e.target, e.framePath);
    const last = drafts[drafts.length - 1];
    if (e.type === 'fill') {
      const value = e.secret ? (e.secret === 'totp' ? '{{totp}}' : `{{secrets.${e.secret}}}`) : (e.value ?? '');
      if (last && last.step.op === 'fill' && sameTarget(last.step.target, target)) {
        last.step.value = value;
        if (last.param) last.param.value = value;
        continue;
      }
      const d: Draft = { step: { op: 'fill', target, value } };
      if (e.secret) d.secret = e.secret === 'totp' ? 'totpSecret' : e.secret;
      else d.param = { name: slug(e.fieldName || 'value'), value };
      drafts.push(d);
    } else if (e.type === 'otp') {
      // Collapse a run of digit boxes into one typed code, starting at the first box.
      if (last && last.step.op === 'fill' && last.step.mode === 'type' && last.step.value === '{{totp}}') continue;
      drafts.push({ step: { op: 'fill', target, value: '{{totp}}', mode: 'type' }, secret: 'totpSecret' });
    } else if (e.type === 'click') {
      drafts.push({ step: { op: 'click', target } });
    } else if (e.type === 'select') {
      drafts.push({ step: { op: 'select', target, value: e.value ?? '' }, param: { name: slug(e.fieldName || 'option'), value: e.value ?? '' } });
    } else if (e.type === 'check') {
      drafts.push({ step: { op: 'check', target } });
    } else if (e.type === 'press') {
      drafts.push({ step: { op: 'press', target, key: e.key ?? 'Enter' } });
    }
  }

  // Name params uniquely and swap their literal values for templates everywhere.
  const params: Workflow['params'] = {};
  const literalToParam = new Map<string, string>();
  for (const d of drafts) {
    if (!d.param || !d.param.value) continue;
    let name = d.param.name;
    for (let i = 2; params[name] && params[name].example !== d.param.value; i++) name = `${d.param.name}_${i}`;
    params[name] = { description: `Recorded value for "${d.param.name.replace(/_/g, ' ')}"`, example: d.param.value };
    literalToParam.set(d.param.value, name);
  }
  // Emails the user clicked next to (a row's identity, "Actions for x@y") become params too.
  const EMAIL = /[^\s@"']+@[^\s@"']+\.[a-z]{2,}/i;
  const addEmail = (email: string) => {
    if (literalToParam.has(email)) return;
    let name = 'email';
    for (let i = 2; params[name]; i++) name = `email_${i}`;
    params[name] = { description: 'Email of the user this task acts on', example: email };
    literalToParam.set(email, name);
  };
  const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
  const collect = (t: Target | undefined) => {
    if (!t) return;
    // A field's name is usually its placeholder ("you@company.com"), not someone's identity.
    const roleName = t.role && !FIELD_ROLES.has(t.role.role) ? t.role.name : undefined;
    for (const text of [t.hasExactText, t.hasText, roleName, t.text]) {
      const m = text ? EMAIL.exec(text) : null;
      if (m) addEmail(m[0]);
    }
    collect(t.within);
  };
  for (const d of drafts) if (d.step.op !== 'fill') collect((d.step as { target?: Target }).target);
  const templ = (s: string) => {
    const p = literalToParam.get(s);
    return p ? `{{params.${p}}}` : s;
  };
  const fixTarget = (t: Target): Target => {
    const o: Target = { ...t };
    if (o.hasExactText) o.hasExactText = templ(o.hasExactText);
    if (o.hasText) o.hasText = templ(o.hasText);
    if (o.role?.name) {
      let n = o.role.name;
      for (const [lit, p] of literalToParam) if (lit.length >= 4 && n.includes(lit)) n = n.split(lit).join(`{{params.${p}}}`);
      o.role = { ...o.role, name: n };
    }
    if (o.text) {
      for (const [lit, p] of literalToParam) if (lit.length >= 4 && o.text.includes(lit)) o.text = o.text.split(lit).join(`{{params.${p}}}`);
    }
    if (o.within) o.within = fixTarget(o.within);
    return o;
  };
  for (const d of drafts) {
    const s = d.step as Step & { target?: Target; value?: string };
    if (s.target) s.target = fixTarget(s.target);
    if ((s.op === 'fill' || s.op === 'select') && typeof s.value === 'string' && !s.value.startsWith('{{')) s.value = templ(s.value);
  }

  // Split at the click that submits the last sign-in secret (password or code).
  let split = -1;
  let sawLoginSecret = false;
  for (const [i, d] of drafts.entries()) {
    if (d.secret === 'newPassword') break;
    if (d.secret === 'password' || d.secret === 'totpSecret' || d.secret === 'username') sawLoginSecret = true;
    else if (sawLoginSecret && (d.step.op === 'click' || d.step.op === 'press')) {
      split = i;
      if (!drafts.slice(i + 1).some((x) => x.secret === 'password' || x.secret === 'totpSecret')) break;
      sawLoginSecret = false;
    }
  }
  const base = opts.baseUrl.replace(/\/$/, '');
  const startUrl = opts.startUrl.startsWith(base) ? `{{baseUrl}}${opts.startUrl.slice(base.length)}` : opts.startUrl;
  const login: Step[] = [{ op: 'navigate', url: startUrl }, ...drafts.slice(0, split + 1).map((d) => d.step)];
  const steps: Step[] = drafts.slice(split + 1).map((d) => d.step);
  // Resume here after a forced re-login.
  if (steps[0]) steps[0] = { ...steps[0], checkpoint: true };
  // The last click usually commits the change. Mark it so the engine repeats it only with proof
  // the first click never reached the app; the editor shows the flag so a person can move it.
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].op === 'click') {
      steps[i] = { ...steps[i], effect: true };
      break;
    }
  }
  const secrets = [...new Set(drafts.map((d) => d.secret).filter(Boolean))] as Workflow['secrets'];
  return {
    id: `draft.${opts.app}.${opts.kind}`,
    app: opts.app,
    kind: opts.kind,
    version: 1,
    description: opts.description ?? `Recorded ${new Date().toISOString().slice(0, 16).replace('T', ' ')} from ${startUrl}`,
    params,
    secrets,
    login,
    steps,
  };
}
