// Node-side geometric QA of an episode on the headless engine: the SAME Production code and checks as the browser
// analyzer (validateFrame, handPenetrations, bodyIssues, hero-prop occlusion on frames and at press contacts, swept hands),
// but on EVERY frame instead of every third. Used by tests and dev tools; the pipeline and render worker keep using the
// browser analyzer as the independent verification. Motion metrics (foot slip, teleports, contact error) are not here.
import type { Episode } from '../../../packages/schema/src/episode.ts';
import type { FrameIssue, Library } from '../../../packages/engine/src/production.ts';
import { headlessEngine } from './headless.ts';

/** the pipeline's acceptance classes (packages/story/src/pipeline.ts): hard = any frame blocks; soft = blocks on >= 34 % of a shot */
export const QA_HARD = ['SUBJECT_OUT_OF_FRAME', 'SUBJECT_BEHIND_CAMERA', 'FACE_OUT_OF_FRAME', 'FACE_OCCLUDED', 'HAND_PENETRATION', 'HAND_SWEEP_PENETRATION', 'CAMERA_IN_PROP', 'BODY_PROP_INTERSECTION', 'ACTOR_OVERLAP', 'PROP_OCCLUDED'] as const;
export const QA_SOFT = ['SUBJECT_OUTSIDE_ACTION_SAFE', 'FACE_TURNED_AWAY'] as const;
const SOFT_FRACTION = 0.34;

export interface HeadlessQa {
  issues: FrameIssue[];
  /** issue count per code (every frame; sweep issues count once per window/arm) */
  byCode: Record<string, number>;
  /** what the pipeline's acceptance rule would turn into repair constraints */
  blocking: Array<{ code: string; shot: string; subject: string; frames: number; fraction: number; first: string }>;
  frames: number;
}

export function headlessQa(ep: Episode, lib: Library): HeadlessQa {
  const e = headlessEngine(ep, lib, 270, 480);
  const fps = ep.episode.fps, N = Math.round(ep.episode.duration * fps);
  const hero = ep.props.find((p) => p.hero)?.instance ?? 'button';
  const issues: FrameIssue[] = [];
  const shotFrames = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    const t = i / fps, f = e.prod.evaluate(t);
    shotFrames.set(f.shot.id, (shotFrames.get(f.shot.id) ?? 0) + 1);
    for (const x of [...e.prod.validateFrame(e.renderer as never, f), ...e.prod.handPenetrations(t), ...e.prod.bodyIssues(t), ...e.prod.propOcclusion(f, hero, 'press_surface')]) if (x.code !== 'CAMERA_ADJUSTED') issues.push(x);
  }
  for (const c of e.prod.contacts()) {
    const f = e.prod.evaluate(c.t);
    for (const x of e.prod.propOcclusion(f, hero, 'press_surface')) issues.push({ ...x, message: `at press contact: ${x.message}` });
  }
  for (const s of e.prod.sweptHandIssues({ substeps: 4 })) issues.push({ t: s.t, shot: s.shot, code: s.code, message: s.message, subject: s.subject });
  const byCode: Record<string, number> = {};
  for (const i of issues) byCode[i.code] = (byCode[i.code] ?? 0) + 1;
  const groups = new Map<string, { code: string; shot: string; subject: string; n: number; first: string }>();
  for (const i of issues) {
    const k = `${i.code}:${i.shot}:${i.subject ?? ''}`;
    const g = groups.get(k);
    if (g) g.n++; else groups.set(k, { code: i.code, shot: i.shot, subject: i.subject ?? '', n: 1, first: `${i.message} @${i.t.toFixed(3)}s` });
  }
  const blocking: HeadlessQa['blocking'] = [];
  for (const g of groups.values()) {
    const fraction = g.n / (shotFrames.get(g.shot) ?? 1);
    if ((QA_HARD as readonly string[]).includes(g.code) || ((QA_SOFT as readonly string[]).includes(g.code) && fraction >= SOFT_FRACTION)) blocking.push({ code: g.code, shot: g.shot, subject: g.subject, frames: g.n, fraction: +fraction.toFixed(3), first: g.first });
  }
  return { issues, byCode, blocking, frames: N };
}
