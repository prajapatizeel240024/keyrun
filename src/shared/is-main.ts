import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when the module at `metaUrl` is the process entry point (works under tsx). */
export function isMain(metaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
