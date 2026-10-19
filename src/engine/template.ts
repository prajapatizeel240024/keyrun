// {{...}} interpolation. Step logs keep the template, never the resolved value, so secrets
// cannot leak through logs.
import { StepFailure } from './errors.ts';

export type Scope = {
  baseUrl: string;
  params: Record<string, string>;
  secrets: Record<string, string | undefined>;
  vars: Record<string, string>;
  totp: () => Promise<string>;
};

const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;

export function usesSecrets(tpl: string | undefined): boolean {
  return !!tpl && /\{\{\s*(secrets\.|totp\b)/.test(tpl);
}

export async function interpolate(tpl: string, scope: Scope): Promise<string> {
  const parts: string[] = [];
  let last = 0;
  for (const m of tpl.matchAll(TOKEN)) {
    parts.push(tpl.slice(last, m.index));
    parts.push(await resolveToken(m[1], scope));
    last = m.index! + m[0].length;
  }
  parts.push(tpl.slice(last));
  return parts.join('');
}

/** Synchronous variant for selectors/targets: secrets and TOTP are not allowed there. */
export function interpolateSync(tpl: string, scope: Scope): string {
  return tpl.replace(TOKEN, (_m, key: string) => {
    if (key === 'totp' || key.startsWith('secrets.')) throw new StepFailure('bad_template', `secrets cannot be used in a selector ({{${key}}})`);
    return resolvePlain(key, scope);
  });
}

async function resolveToken(key: string, scope: Scope): Promise<string> {
  if (key === 'totp') return scope.totp();
  if (key.startsWith('secrets.')) {
    const v = scope.secrets[key.slice(8)];
    if (v === undefined) throw new StepFailure('bad_template', `missing secret {{${key}}}`);
    return v;
  }
  return resolvePlain(key, scope);
}

function resolvePlain(key: string, scope: Scope): string {
  if (key === 'baseUrl') return scope.baseUrl;
  const [ns, name] = key.split('.', 2);
  const bag = ns === 'params' ? scope.params : ns === 'vars' ? scope.vars : undefined;
  if (!bag || name === undefined || bag[name] === undefined) throw new StepFailure('bad_template', `unknown template value {{${key}}}`);
  return bag[name];
}
