// Prop anchor names the S5 interactions consume (S4 owns the props and their anchor names).
// A role lists the accepted names in preference order; the first one a prop defines wins. The existing props
// (spark_coin: rim / face / center / top, student_desk: top_center / edge_front, suspicious_button: press_surface / base)
// already resolve through the fallbacks, so the interactions work before S4's props land.
// When S4 publishes its final names, only this table changes.
import type { PropInstance } from '../../build.ts';

export const ANCHOR_ROLES = {
  /** where a hand closes around the prop (grab, pick_up, hold, throw, eat, drink, use_phone) */
  grip: ['grip', 'handle', 'rim', 'edge_front', 'base', 'center'],
  /** door: the handle / knob the hand reaches for */
  door_handle: ['handle', 'knob', 'grip'],
  /** door: hinge line (the door swings about it) */
  door_hinge: ['hinge'],
  /** phone / laptop / tv: the screen the character looks at (and the glow source) */
  screen: ['screen', 'face', 'front_face'],
  /** laptop: centre of the keyboard the hands type on */
  keyboard: ['keyboard', 'keys', 'top_center', 'top'],
  /** food: the part that goes into the mouth */
  bite: ['bite', 'top', 'center'],
  /** cup / bottle: the rim that touches the lips */
  lip: ['rim', 'lip', 'top'],
  /** a pushed / tugged object: where the hands press or pull */
  contact: ['contact', 'handle', 'grip', 'front_face', 'edge_front', 'center'],
} as const;
export type AnchorRole = keyof typeof ANCHOR_ROLES;

/** anchor names a prop exposes (anchors, effect anchors and grips, like buildProp) */
export function anchorNames(m: Pick<PropInstance['manifest'], 'anchors' | 'effectAnchors' | 'grips'>): string[] {
  return [...Object.keys(m.anchors ?? {}), ...Object.keys(m.effectAnchors ?? {}), ...Object.keys(m.grips ?? {})];
}
/** first anchor name of `role` that the prop defines, or undefined */
export function resolveAnchor(m: Pick<PropInstance['manifest'], 'anchors' | 'effectAnchors' | 'grips'>, role: AnchorRole): string | undefined {
  const have = new Set(anchorNames(m));
  return ANCHOR_ROLES[role].find((n) => have.has(n));
}
/** "<instance>.<anchor>" target ref for a role (what the track's PointResolver resolves) */
export function anchorRef(instance: string, m: Pick<PropInstance['manifest'], 'anchors' | 'effectAnchors' | 'grips'>, role: AnchorRole): string | undefined {
  const a = resolveAnchor(m, role);
  return a ? `${instance}.${a}` : undefined;
}
