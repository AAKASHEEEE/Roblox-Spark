import { readFileSync } from 'node:fs';
import { loadLibrary } from '../../apps/render-worker/lib/library.ts';
import { BrowserAnalyzer } from '../../apps/render-worker/lib/analyzer.ts';
const lib = loadLibrary(); const an = new BrowserAnalyzer(lib);
for (const id of process.argv.slice(2)) {
  const ep = JSON.parse(readFileSync(`out/dev-episodes/${id}.json`, 'utf8'));
  const r = await an.analyze(ep);
  const by: Record<string, Record<string, number>> = {};
  for (const i of r.issues) { if (i.code === 'CAMERA_ADJUSTED') continue; const m = (by[i.shot] ??= {}); const k = `${i.code}:${i.subject ?? ''}`; m[k] = (m[k] ?? 0) + 1; }
  console.log(id, ep.cast.map((c: any) => `${c.id}@${c.startMark}`).join(' '), JSON.stringify(r.metrics));
  for (const s of ep.shots) console.log('  ', s.id, s.preset.padEnd(18), `${s.start.toFixed(2)}-${s.end.toFixed(2)}`, s.subjects.join('+').padEnd(16), JSON.stringify(by[s.id] ?? {}));
}
await an.close();
