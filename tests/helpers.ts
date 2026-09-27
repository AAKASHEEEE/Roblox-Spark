import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';
export const lib = loadLibrary();
export const sample = (): any => JSON.parse(readFileSync(join(ROOT, 'episodes/free-coins-loop-001.json'), 'utf8'));
export { ROOT };
