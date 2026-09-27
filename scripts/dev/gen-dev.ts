import { readFileSync } from 'node:fs';
import { loadLibrary, sha256 } from '../../apps/render-worker/lib/library.ts';
import { buildRegistry } from '../../packages/story/src/registry.ts';
import { RulesProvider } from '../../packages/story/src/providers/rules.ts';
import { generateEpisode } from '../../packages/story/src/pipeline.ts';
const set = JSON.parse(readFileSync(process.argv[2] ?? 'bench/dev-ideas.json', 'utf8'));
const lib = loadLibrary(); const reg = buildRegistry(lib);
for (const it of set.ideas) {
  const r = await generateEpisode(it.request, { provider: new RulesProvider(), registry: reg, lib, sha256 });
  console.log(it.id, r.status, r.rejection?.category ?? '', (r.rejection?.reason ?? r.failure ?? '').slice(0, 150), 'repairs', r.repairs, 'subs', r.substitutions.length, r.episode ? `D=${r.episode.episode.duration} shots=${r.episode.shots.length}` : '');
  for (const a of r.attempts) if (a.constraints.length) console.log('   attempt', a.n, a.constraints.map((c) => c.code + '@' + c.beatId + ':' + c.field + ' ' + c.message.slice(0, 110)).join(' || '), 'applied', JSON.stringify(a.patchesApplied), 'rejected', a.patchesRejected.length);
}
