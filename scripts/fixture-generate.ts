// Freeze a GENERATED episode as a test fixture (the generator output is stored verbatim; nobody edits it).
//   node scripts/fixture-generate.ts --idea "<idea>" --seed 17 --out tests/fixtures/episodes/<name>.json [--duration 17] [--static]
// Uses the offline rules provider and (unless --static) the browser analyzer, exactly like the benchmark harness.
// Refuses to overwrite an existing fixture: goldens are keyed to the fixture's content.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';
import { BrowserAnalyzer } from '../apps/render-worker/lib/analyzer.ts';
import { buildRegistry } from '../packages/story/src/registry.ts';
import { generateEpisode } from '../packages/story/src/pipeline.ts';
import { RulesProvider } from '../packages/story/src/providers/rules.ts';

const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const idea = flag('idea'), out = flag('out');
if (!idea || !out) { console.error('usage: fixture-generate.ts --idea "<idea>" --seed N --out <file>'); process.exit(1); }
if (existsSync(resolve(out))) { console.error(`refusing to overwrite ${out}`); process.exit(1); }
const lib = loadLibrary();
const analyzer = process.argv.includes('--static') ? null : new BrowserAnalyzer(lib);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const rec = await generateEpisode({ idea, durationTarget: Number(flag('duration', '17')), comedyEngine: null, seed: Number(flag('seed', '17')) }, { provider: new RulesProvider(), registry: buildRegistry(lib), lib, analyzer, sha256, maxRepairs: 3 });
await analyzer?.close();
if (rec.status !== 'accepted' || !rec.episode) { console.error(`not accepted: ${rec.status} ${JSON.stringify(rec.rejection ?? rec.failure)}`); process.exit(1); }
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(resolve(out), JSON.stringify(rec.episode, null, 2) + '\n');
console.log(`${out}: ${rec.episode.episode.id} ${rec.episode.episode.duration}s, render ${JSON.stringify(rec.episode.render)}, repairs ${rec.repairs}, substitutions ${rec.substitutions.length}`);
