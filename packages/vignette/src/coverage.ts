// Script coverage check (S6): every beat's cast, props and events must be visible in the beat's shot.
//   cast / prop : seen (line of sight, in frame, readable size) in >= half of the beat's frames where it is on screen
//   event       : its witness is seen at least once in the event window (enter: [at, at + 0.6]; exit: [at - 0.6, at];
//                 door open/close: the door; VFX / text graphic with a target: the target over [at, at + 0.5];
//                 screen-space VFX / text: always visible)
//   SFX are audio-only: listed, never counted in the visual coverage.
// Coverage % = covered / visual items over the whole sheet; below COVERAGE_THRESHOLD (90 %) the sheet is blocked.
import type { Vec3 } from '../../engine/src/math.ts';
import { ASPECT } from './camera-recipes.ts';
import { poseAt, type ShotChoice } from './camera.ts';
import { frameGeometry, visibilityOf, type FrameGeometry } from './geometry.ts';
import type { VignetteScene } from './scene.ts';
import { actorPresent, type StagePlan, type StagedBeat } from './stage.ts';

export const COVERAGE_THRESHOLD = 0.9;
export const COVERAGE_STEP = 1 / 3;

export interface CoverageItem {
  beat: string; kind: 'cast' | 'prop' | 'event'; id: string; label: string; witness: string[]; space: 'world' | 'screen' | 'audio';
  counted: boolean; samples: number; seen: number; covered: boolean; reason?: string;
}
export interface CoverageBeat { beat: string; recipeId: string; visual: number; covered: number; pct: number; missing: string[] }
export interface CoverageReport { threshold: number; step: number; visual: number; covered: number; pct: number; blocking: boolean; audioOnly: number; beats: CoverageBeat[]; items: CoverageItem[] }

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function coverageCheck(scene: VignetteScene, plan: StagePlan, shots: Record<string, ShotChoice>): CoverageReport {
  const items: CoverageItem[] = [];
  const cache = new Map<number, FrameGeometry>();
  const geoAt = (t: number) => { const k = r4(t); let g = cache.get(k); if (!g) { g = frameGeometry(scene, scene.pose(k)); cache.set(k, g); } return g; };
  const doorPts = (b: StagedBeat, doorId: string): Vec3[] => {
    const d = plan.sets.find((s) => s.id === b.setId)!.doors[doorId];
    if (!d) return [];
    const a = (d.facingDeg * Math.PI) / 180, sx = Math.cos(a), sz = -Math.sin(a), out: Vec3[] = [];
    for (const u of [-0.45, 0, 0.45]) for (const y of [0.3, 1.1, 1.9]) out.push([d.threshold[0] + sx * u, y, d.threshold[2] + sz * u]);
    return out;
  };
  const seenAt = (b: StagedBeat, t: number, witness: string) => {
    const g = geoAt(t), cam = poseAt(shots[b.phraseId], b.start, t);
    if (witness.startsWith('door:')) return visibilityOf(g, cam, ASPECT, witness, doorPts(b, witness.slice(5))).ok;
    if (!g.actors[witness] && !g.props[witness]) {
      const set = plan.sets.find((s) => s.id === b.setId)!, m = set.marks[witness];
      if (m) return visibilityOf(g, cam, ASPECT, witness, [[m.pos[0], 0.5, m.pos[2]], [m.pos[0], 1.2, m.pos[2]]]).ok;
      if (set.doors[witness]) return visibilityOf(g, cam, ASPECT, witness, doorPts(b, witness)).ok;
      return false;
    }
    return visibilityOf(g, cam, ASPECT, witness).ok;
  };
  const times = (t0: number, t1: number) => { const out: number[] = []; for (let t = t0; t <= t1 + 1e-9; t += COVERAGE_STEP) out.push(r4(t)); if (!out.length) out.push(r4(t0)); return out; };

  for (const b of plan.beats) {
    const S = b.start + 0.05, E = b.end - 0.05;
    const grid = times(S, E);
    for (const c of b.cast) {
      const ts = grid.filter((t) => actorPresent(plan, c.id, t, b.setId));
      const seen = ts.filter((t) => seenAt(b, t, c.id)).length;
      items.push({ beat: b.phraseId, kind: 'cast', id: c.id, label: `${c.id} (${c.actionId})`, witness: [c.id], space: 'world', counted: true, samples: ts.length, seen, covered: ts.length > 0 && seen * 2 >= ts.length, ...(ts.length ? {} : { reason: 'never on screen during the beat' }) });
    }
    for (const id of b.props) {
      const ts = grid.filter((t) => { const g = geoAt(t); return !!g.props[id]; });
      const seen = ts.filter((t) => seenAt(b, t, id)).length;
      const st = plan.props[id]?.spans.find((s) => s.beat === b.phraseId)?.state ?? '';
      items.push({ beat: b.phraseId, kind: 'prop', id, label: `${id} (${st})`, witness: [id], space: 'world', counted: true, samples: ts.length, seen, covered: ts.length > 0 && seen * 2 >= ts.length, ...(ts.length ? {} : { reason: 'not visible in the world during the beat' }) });
    }
    for (const e of b.events) {
      const ev = e.event;
      const label = ev.type === 'sfx' ? `sfx ${ev.sfxId}@${ev.at}` : ev.type === 'vfx' ? `vfx ${ev.vfxId}@${ev.at}${ev.target ? `->${ev.target}` : ''}` : ev.type === 'text_graphic' ? `text ${ev.textStyleId}@${ev.at}${ev.target ? `->${ev.target}` : ''}` : `${ev.type} ${'characterId' in ev ? ev.characterId + ' ' : ''}${'doorId' in ev ? ev.doorId : ''}@${ev.at}`;
      const id = `${b.phraseId}#${e.index}`;
      if (e.space === 'audio') { items.push({ beat: b.phraseId, kind: 'event', id, label, witness: [], space: 'audio', counted: false, samples: 0, seen: 0, covered: true, reason: 'audio only' }); continue; }
      if (e.space === 'screen') { items.push({ beat: b.phraseId, kind: 'event', id, label, witness: [], space: 'screen', counted: true, samples: 1, seen: 1, covered: true, reason: 'screen-space' }); continue; }
      const [w0, w1] = ev.type === 'exit' ? [ev.at - 0.6, ev.at] : ev.type === 'enter' ? [ev.at, ev.at + 0.6] : ev.type === 'text_graphic' ? [ev.at, Math.min(ev.at + ev.duration, ev.at + 0.6)] : [ev.at, ev.at + 0.5];
      const ts = [w0, (w0 + w1) / 2, w1].map((t) => r4(Math.max(b.start, Math.min(b.end - 0.01, t))));
      const seen = ts.filter((t) => e.witness.some((w) => seenAt(b, t, w))).length;
      items.push({ beat: b.phraseId, kind: 'event', id, label, witness: e.witness, space: 'world', counted: true, samples: ts.length, seen, covered: seen > 0 });
    }
  }
  const beats: CoverageBeat[] = plan.beats.map((b) => {
    const xs = items.filter((i) => i.beat === b.phraseId && i.counted);
    const cov = xs.filter((i) => i.covered);
    return { beat: b.phraseId, recipeId: b.camera.recipeId, visual: xs.length, covered: cov.length, pct: r4(xs.length ? cov.length / xs.length : 1), missing: xs.filter((i) => !i.covered).map((i) => i.label) };
  });
  const counted = items.filter((i) => i.counted), covered = counted.filter((i) => i.covered).length;
  const pct = counted.length ? covered / counted.length : 1;
  return { threshold: COVERAGE_THRESHOLD, step: r4(COVERAGE_STEP), visual: counted.length, covered, pct: r4(pct), blocking: pct < COVERAGE_THRESHOLD, audioOnly: items.length - counted.length, beats, items };
}
