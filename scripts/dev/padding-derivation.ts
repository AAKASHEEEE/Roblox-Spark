// dev (derivation data for docs/story/CLEARANCE_AND_FRAMING.md; tuning data, NOT a result): sample the frozen Run 3
// episodes under both declared profiles and report the motion quantities the padding constants are derived from.
// node scripts/dev/padding-derivation.ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadLibrary } from '../../apps/render-worker/lib/library.ts';
import { headlessEngine } from '../../packages/engine/src/headless.ts';
import { motionWindows } from '../../packages/story/src/envelope.ts';

const lib = loadLibrary();
const eps: any[] = [];
for (const d of ['run3-holdout2', 'run3-holdout-posthoc', 'run3-rules-posthoc']) for (const f of readdirSync(join('docs/story/bench', d, 'records')).sort()) {
  const r = JSON.parse(readFileSync(join('docs/story/bench', d, 'records', f), 'utf8')).record;
  const ep = r.episode ?? r.lastCompiled; if (ep) eps.push(ep);
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const STEP = 0.06; // per-1/120 s displacement above this = a pose step (sub-frame discontinuity), counted separately
for (const mp of ['legacy-head-v1', 'corrected-head-v2']) {
  const hand: number[] = [], head: number[] = [], coin: number[] = [], faceDeg: number[] = [], faceRel: number[] = [], growPerFrame: number[] = [];
  let steps = 0, samples = 0, dev = 0, devAt = '';
  for (const ep0 of eps) {
    const ep = { ...ep0, render: { ...ep0.render, motionProfile: mp } };
    const e = headlessEngine(ep, lib, 270, 480), dt = 1 / 120;
    for (const w of motionWindows(ep)) {
      const prev = new Map<string, number[]>();
      const a = w.kind === 'onset' ? ep.actions.find((x: any) => x.actor === w.actor && x.start === w.start && x.action === w.action) : null;
      let from: number[] | null = null;
      for (let k = Math.ceil(w.t0 / dt); k * dt <= w.t1; k++) {
        const t = k * dt; e.prod.evaluate(t); e.prod.root.updateWorld();
        if (w.kind === 'prop_motion' && w.event === 'hop_to') {
          const p = e.prod.props.get(w.prop!)!.inst.root.worldPos(), q = prev.get('coin'); prev.set('coin', p);
          if (q) coin.push(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
          continue;
        }
        if (!w.actor) continue;
        const rig = e.prod.rigs.get(w.actor)!;
        const pts: Array<[string, number[], number[]]> = [['hl', rig.hand_l.worldPos(), hand], ['hr', rig.hand_r.worldPos(), hand], ...rig.probes.filter((p) => p.name.startsWith('probe:head')).map((p, i) => [`h${i}`, p.worldPos(), head] as [string, number[], number[]])];
        for (const [n, p, sink] of pts) {
          const q = prev.get(n); prev.set(n, p);
          if (!q) continue;
          const s = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
          samples++;
          if (s > STEP) steps++; else sink.push(s);
        }
        if (a && a.to && t >= a.start && t <= a.start + Math.min(a.duration, 1.0)) {
          const root = rig.root.worldPos();
          from ??= root;
          const to = e.prod.env.manifest.marks[a.to].pos, dx = to[0] - from[0], dz = to[2] - from[2], L2 = dx * dx + dz * dz || 1;
          const u = Math.max(0, Math.min(1, ((root[0] - from[0]) * dx + (root[2] - from[2]) * dz) / L2));
          const d = Math.hypot(from[0] + dx * u - root[0], from[2] + dz * u - root[2]);
          if (d > dev) { dev = d; devAt = `${ep.episode.id} ${a.action}@${a.start}`; }
        }
      }
    }
    // face-normal change between consecutive video frames inside a shot, and (face-framed presets) the largest change
    // relative to the shot's FIRST frame, i.e. what a camera solved once at shot start would have to absorb
    for (const sh of ep.shots) for (const sid of sh.subjects) {
      const rig = e.prod.rigs.get(sid.split('.')[0]); if (!rig) continue;
      let n0: number[] | null = null, first: number[] | null = null, rel = 0;
      for (let k = Math.ceil(sh.start * 30); k / 30 < sh.end; k++) {
        e.prod.evaluate(k / 30);
        const w = rig.face.world, L = Math.hypot(w[8], w[9], w[10]), n = [w[8] / L, w[9] / L, w[10] / L];
        const ang = (a: number[], b: number[]) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;
        if (n0) faceDeg.push(ang(n, n0));
        first ??= n; rel = Math.max(rel, ang(n, first));
        n0 = n;
      }
      if (['frontal_medium', 'reaction_punch_in', 'two_shot'].includes(sh.preset)) faceRel.push(rel);
    }
    // surface speed of a growing prop (radius change per video frame): the camera must stay clear of it frame to frame
    for (const g of ep.propEvents.filter((x: any) => x.event === 'grow')) {
      let r0: number | null = null;
      for (let k = Math.ceil(g.start * 30); k / 30 <= g.start + g.duration + 0.2; k++) {
        const s = e.prod.props.get(g.prop)!.track.stateAt(k / 30).scale * 0.09;
        if (r0 !== null) growPerFrame.push(Math.abs(s - r0));
        r0 = s;
      }
    }
  }
  console.log(`  face-framed shots: face-normal change vs the shot's first frame p50 ${pct(faceRel, 0.5).toFixed(1)} p90 ${pct(faceRel, 0.9).toFixed(1)} max ${Math.max(...faceRel).toFixed(1)} deg (${faceRel.length} subject-shots)`);
  console.log(`  growing prop radius change per video frame: p99 ${(pct(growPerFrame, 0.99) * 100).toFixed(1)} max ${(Math.max(...growPerFrame) * 100).toFixed(1)} cm`);
  console.log(`${mp}: ${eps.length} episodes`);
  console.log(`  per-120Hz-sample displacement, hands: p50 ${(pct(hand, 0.5) * 100).toFixed(2)} p99 ${(pct(hand, 0.99) * 100).toFixed(2)} p99.9 ${(pct(hand, 0.999) * 100).toFixed(2)} cm; head corners: p99 ${(pct(head, 0.99) * 100).toFixed(2)} p99.9 ${(pct(head, 0.999) * 100).toFixed(2)} cm`);
  console.log(`  pose steps (> ${STEP * 100} cm in 1/120 s): ${steps} of ${samples} point-samples (${(100 * steps / samples).toFixed(2)} %)`);
  console.log(`  leaping prop per-sample displacement: p99 ${(pct(coin, 0.99) * 100).toFixed(1)} max ${(Math.max(...coin) * 100).toFixed(1)} cm`);
  console.log(`  root deviation from the straight path, first 1 s of a move: max ${(dev * 100).toFixed(1)} cm (${devAt})`);
  console.log(`  face-normal change between consecutive frames: p99 ${pct(faceDeg, 0.99).toFixed(2)} p99.9 ${pct(faceDeg, 0.999).toFixed(2)} max ${Math.max(...faceDeg).toFixed(1)} deg`);
}
