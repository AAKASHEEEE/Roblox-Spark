// Regression guard: re-render the PoC episode and compare every frame's raw-RGBA SHA-256 with the baseline captured at
// commit 1dc7a26 (before the story-generator branch). Proves engine changes did not alter PoC pixels.
//   node scripts/baseline-compare.ts [--episode episodes/free-coins-loop-001.json] [--baseline docs/poc/frame-hashes-baseline.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { renderEpisode } from '../apps/render-worker/render.ts';
import { ROOT } from '../apps/render-worker/lib/server.ts';
import { canonical } from '../apps/render-worker/lib/library.ts';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const episode = arg('episode', 'episodes/free-coins-loop-001.json');
const baseline = JSON.parse(readFileSync(resolve(ROOT, arg('baseline', 'docs/poc/frame-hashes-baseline.json')), 'utf8'));
const epRaw = JSON.parse(readFileSync(resolve(ROOT, episode), 'utf8'));
// the baseline hashed the canonical schema-1.0 episode; the pinned fixture must be that same content + a render block
const { render: declared, ...content } = epRaw;
const epSha = createHash('sha256').update(canonical({ ...content, schemaVersion: '1.0' })).digest('hex');
const out = join('out', 'baseline-compare');
// PoC acceptance case: explicitly declares the original brief's narrower 14-18 s target (channel boundary is 14-22 s)
const r = await renderEpisode({ episode, out, scale: 1, verify: true, hashEvery: 1, durationTargetSec: [14, 18] });
const log = JSON.parse(readFileSync(join(ROOT, out, 'render-log.json'), 'utf8'));
const base = new Map<number, string>(baseline.frameHashes);
const diff = (log.frameHashes as Array<[number, string]>).filter(([i, h]) => base.get(i) !== h).map(([i]) => i);
const report = {
  episode, declared, contentSha256AsSchema10: epSha, contentUnchangedSinceBaseline: epSha === baseline.episodeSha256, baselineCommit: baseline.commit,
  framesCompared: log.frameHashes.length, baselineFrames: baseline.frameHashes.length, identicalFramePixels: diff.length === 0 && log.frameHashes.length === baseline.frameHashes.length,
  differingFrames: diff, renderOk: r.ok, gatesPassed: r.report?.summary ? `${r.report.summary.passed}/${r.report.summary.total}` : null, failedGates: r.report?.summary?.failed ?? null, mp4Sha256: log.mp4Sha256, audioCodec: log.audioCodec ?? null,
};
writeFileSync(join(ROOT, out, 'baseline-compare.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, differingFrames: diff.slice(0, 20) }, null, 2));
process.exit(report.identicalFramePixels ? 0 : 1);
