// Renders the same episode twice from scratch (fresh browser each time) and compares the MP4 bytes and
// per-frame raw pixel hashes. Usage: node scripts/determinism.ts [--scale 1] [--episode ...]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderEpisode } from '../apps/render-worker/render.ts';
import { ROOT } from '../apps/render-worker/lib/server.ts';

const a = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const episode = a('episode', 'episodes/free-coins-loop-001.json');
const scale = Number(a('scale', '1'));
const runs: any[] = [];
// run A is the canonical, fully verified output; run B is an independent from-scratch re-render (fresh browser)
const id = JSON.parse(readFileSync(join(ROOT, episode), 'utf8')).episode.id;
for (const tag of ['a', 'b']) {
  const out = tag === 'a' ? join('out', scale === 1 ? id : `${id}-x${scale}`) : join('out', 'determinism', tag);
  // PoC acceptance case: explicitly declares the original brief's narrower 14-18 s target (channel boundary is 14-22 s)
  const r = await renderEpisode({ episode, out, scale, verify: tag === 'a', hashEvery: 1, durationTargetSec: [14, 18] });
  const log = JSON.parse(readFileSync(join(ROOT, out, 'render-log.json'), 'utf8'));
  runs.push({ tag, ok: r.ok, mp4Sha256: log.mp4Sha256, frameHashes: log.frameHashes, msPerFrame: log.timing.msPerFrame });
}
const [A, B] = runs;
const diffFrames = A.frameHashes.filter((h: [number, string], i: number) => h[1] !== B.frameHashes[i]?.[1]).map((h: [number, string]) => h[0]);
const report = { episode, scale, framesCompared: A.frameHashes.length, identicalFramePixels: diffFrames.length === 0, differingFrames: diffFrames, identicalMp4Bytes: A.mp4Sha256 === B.mp4Sha256, mp4Sha256: [A.mp4Sha256, B.mp4Sha256], msPerFrame: [A.msPerFrame, B.msPerFrame] };
mkdirSync(join(ROOT, 'out', 'determinism'), { recursive: true });
writeFileSync(join(ROOT, 'out', 'determinism', 'determinism-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.identicalFramePixels && report.identicalMp4Bytes ? 0 : 1);
