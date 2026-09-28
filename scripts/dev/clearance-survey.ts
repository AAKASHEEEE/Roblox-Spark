// dev (tuning data only): padded clearance findings per episode under both profiles
// node scripts/dev/clearance-survey.ts [maxEpisodes=40]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { loadLibrary } from '../../apps/render-worker/lib/library.ts';
import { headlessEngine } from '../../packages/engine/src/headless.ts';
import { measureClearance } from '../../packages/story/src/envelope.ts';
import { pinEpisode } from '../../packages/schema/src/render-compat.ts';
const lib = loadLibrary();
const eps: Array<[string, any]> = [['PoC', JSON.parse(readFileSync('episodes/free-coins-loop-001.json', 'utf8'))]];
const pin = (x: any) => (x.render ? x : pinEpisode(x, { rendererVersion: '1.0.0', motionProfile: 'legacy-head-v1' }));
for (const id of ['A01', 'A04', 'B01', 'C01', 'D02']) if (existsSync(`out/bench-renders/final/${id}/episode.json`)) eps.push([`final-${id}`, pin(JSON.parse(readFileSync(`out/bench-renders/final/${id}/episode.json`, 'utf8')))]);
for (const f of readdirSync('out/bench/run2-rules/episodes').sort().slice(0, Number(process.argv[2] ?? 40))) eps.push([`run2-${f.replace('.json', '')}`, pin(JSON.parse(readFileSync(`out/bench/run2-rules/episodes/${f}`, 'utf8')))]);
const agg: Record<string, Record<string, number>> = { 'legacy-head-v1': {}, 'corrected-head-v2': {} };
let ms = 0;
for (const [name, ep0] of eps) {
  const row: string[] = [name.padEnd(12)];
  for (const mp of ['legacy-head-v1', 'corrected-head-v2']) {
    const t0 = Date.now();
    const iss = measureClearance(headlessEngine({ ...ep0, render: { ...ep0.render, motionProfile: mp } }, lib, 270, 480));
    ms += Date.now() - t0;
    const kinds = [...new Set(iss.map((i) => `${i.code}:${i.what}:${i.window.kind}`))];
    for (const k of kinds) agg[mp][k] = (agg[mp][k] ?? 0) + 1;
    row.push(`${mp === 'legacy-head-v1' ? 'L' : 'V2'} ${iss.length ? iss.map((i) => `${i.code.split('_')[0]}:${i.what}:${i.limb}:${i.window.kind}:${(i.depth * 100).toFixed(1)}`).join(' ') : 'clear'}`);
  }
  console.log(row.join(' | '));
}
console.log('\nepisodes with each finding kind:'); for (const [mp, a] of Object.entries(agg)) console.log(mp, JSON.stringify(Object.entries(a).sort((x, y) => y[1] - x[1])));
console.log(`total measure time ${(ms / 1000).toFixed(1)} s for ${eps.length * 2} measurements`);
