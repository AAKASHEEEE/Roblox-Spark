// dev: generate the same benchmark ideas under each declared motion profile (A/B of the generator's acceptance)
// node scripts/dev/profile-ab.ts bench/ideas.json A04,B03,C05,D02
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadLibrary } from '../../apps/render-worker/lib/library.ts';
import { BrowserAnalyzer } from '../../apps/render-worker/lib/analyzer.ts';
import { buildRegistry } from '../../packages/story/src/registry.ts';
import { generateEpisode } from '../../packages/story/src/pipeline.ts';
import { RulesProvider } from '../../packages/story/src/providers/rules.ts';
const [setFile, ids] = process.argv.slice(2);
const set = JSON.parse(readFileSync(setFile, 'utf8'));
const lib = loadLibrary(); const reg = buildRegistry(lib); const an = new BrowserAnalyzer(lib);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
for (const it of set.ideas.filter((i: any) => !ids || ids.split(',').includes(i.id))) {
  const row: string[] = [it.id];
  for (const mp of ['legacy-head-v1', 'corrected-head-v2']) {
    const r = await generateEpisode({ ...it.request, motionProfile: mp }, { provider: new RulesProvider(), registry: reg, lib, analyzer: an, sha256, maxRepairs: 3 });
    const codes = [...new Set(r.attempts.flatMap((a) => a.constraints.map((c) => c.code)))].join(',');
    row.push(`${mp}: ${r.status} rep=${r.repairs}${codes ? ' [' + codes + ']' : ''}`);
  }
  console.log(row.join(' | '));
}
await an.close();
