import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflow, type Workflow } from './schema.ts';

export const WORKFLOWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../workflows');

export function loadWorkflowFile(file: string): Workflow {
  return parseWorkflow(JSON.parse(readFileSync(file, 'utf8')));
}

export function loadWorkflow(app: string, kind: string): Workflow {
  return loadWorkflowFile(path.join(WORKFLOWS_DIR, app, `${kind}.json`));
}

/** Every workflow shipped in the repo (excluding recorder drafts). */
export function allWorkflows(): Workflow[] {
  const out: Workflow[] = [];
  for (const app of readdirSync(WORKFLOWS_DIR, { withFileTypes: true })) {
    if (!app.isDirectory() || app.name === 'drafts') continue;
    for (const f of readdirSync(path.join(WORKFLOWS_DIR, app.name)).filter((x) => x.endsWith('.json')).sort()) {
      out.push(loadWorkflowFile(path.join(WORKFLOWS_DIR, app.name, f)));
    }
  }
  return out;
}
