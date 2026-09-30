// Faces (S3): one entry point for every face texture the engine draws.
//   - face set v1 (legacy.ts): the manifest's locked face.states. Unchanged pixels and cache keys when not talking.
//   - face set v2 (expressions.ts): the planned library expressions, drawn from the character's locked face layout.
//   - talking mouth shapes (mouths.ts): closed / open / wide / o, drawn over either set's eyes and brows.
import type { CharacterManifest } from '../../../schema/src/assets.ts';
import type { ExpressionDef } from '../../../library/src/types.ts';
import type { TextureSource, Node } from '../gl/scene.ts';
import { drawLegacyFace } from './legacy.ts';
import { type Ctx, type FaceDesign, DEFAULT_DESIGN, designOf, layout } from './design.ts';
import { FACE_SET_V2, FACE_SET_V2_IDS, type FaceDraw } from './expressions.ts';
import { type MouthShape, type TalkStyle, MOUTH_SHAPES, isMouthShape, drawTalk } from './mouths.ts';

export { MOUTH_SHAPES, isMouthShape, FACE_SET_V2_IDS, DEFAULT_DESIGN, designOf };
export type { MouthShape, TalkStyle, FaceDesign };

export const FACE_TEXTURE_SIZE = 256;
const S = FACE_TEXTURE_SIZE;
const cache = new Map<string, TextureSource>();

/** talking style for each face-set-v1 mouth, so a v1 state keeps its mood while the lips move */
const LEGACY_TALK: Record<string, TalkStyle> = {
  half_smile: { bias: 0.45, scale: 1 }, flat: { bias: 0, scale: 0.95 }, o: { bias: 0, scale: 1.05 }, smug: { bias: 0.5, scale: 0.95 },
  grin: { bias: 0.8, scale: 1.05 }, open_grin: { bias: 1, scale: 1.15 }, frown: { bias: -0.8, scale: 0.95 }, tight: { bias: -0.1, scale: 0.85 }, wobbly: { bias: -0.45, scale: 0.95 },
};

/** every expression id this character can show: its locked face states plus face set v2 */
export function faceStatesFor(ch: CharacterManifest): string[] {
  return [...new Set([...Object.keys(ch.face.states), ...FACE_SET_V2_IDS])];
}
export function hasFace(ch: CharacterManifest, state: string): boolean {
  return state in ch.face.states || state in FACE_SET_V2;
}
/** which set draws this state for this character (v1 wins: a character's locked state is never replaced) */
export function faceSource(ch: CharacterManifest, state: string): 'v1' | 'v2' | null {
  return state in ch.face.states ? 'v1' : state in FACE_SET_V2 ? 'v2' : null;
}

function canvas(): { c: HTMLCanvasElement | OffscreenCanvas; g: Ctx } {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(S, S) : Object.assign(document.createElement('canvas'), { width: S, height: S });
  return { c, g: c.getContext('2d') as Ctx };
}

/** draw a face-set-v2 expression into g (size x size) */
export function drawV2(g: Ctx, d: FaceDesign, state: string, size: number, blink: number, mouth: MouthShape | null, talkAmount = 1): void {
  const f: FaceDraw | undefined = FACE_SET_V2[state];
  if (!f) throw new Error(`face set v2 has no expression "${state}"`);
  const L = layout(d, size);
  g.clearRect(0, 0, size, size);
  g.lineCap = 'round'; g.lineJoin = 'round';
  f.upper(g, L, f.blinks ? blink : 0);
  if (mouth) drawTalk(g, L, mouth, f.talk, talkAmount); else f.mouth(g, L);
  f.extras?.(g, L);
}

/**
 * Face texture for a character. `mouth` = talking shape (S5 drives it; null/undefined = the expression's own mouth).
 * `skin` overrides the skin the v2 tints mix with (crowd colour variants). Throws for an unknown state.
 */
export function faceTexture(ch: CharacterManifest, state: string, blink: number, mouth?: MouthShape | null, skin?: string, talkAmount = 1): TextureSource {
  const b = Math.round(blink * 4) / 4; // quantize -> small cache
  const amount = Math.round(Math.max(0, Math.min(1, talkAmount)) * 4) / 4;
  const src = faceSource(ch, state);
  if (!src) throw new Error(`${ch.id} has no face state "${state}"`);
  if (mouth != null && !isMouthShape(mouth)) throw new Error(`unknown mouth shape "${mouth}" (use ${MOUTH_SHAPES.join(', ')})`);
  // v1 without talking keeps the exact pre-v2 cache key and drawing
  const amountKey = mouth && amount !== 1 ? `:a=${amount}` : '';
  const key = src === 'v1'
    ? (mouth ? `face:${ch.id}@${ch.version}:${state}:${b}:m=${mouth}${amountKey}` : `face:${ch.id}@${ch.version}:${state}:${b}:0`)
    : `face2:${ch.id}@${ch.version}:${skin ?? ch.body.skin}:${state}:${b}:${mouth ?? '-'}${amountKey}`;
  let t = cache.get(key);
  if (t) return t;
  const { c, g } = canvas();
  if (src === 'v1') {
    drawLegacyFace(g, ch, state, b, { mouth: !mouth });
    if (mouth) {
      g.lineCap = 'round'; g.lineJoin = 'round';
      drawTalk(g, layout(designOf(ch, skin), S), mouth, LEGACY_TALK[ch.face.states[state].mouth] ?? { bias: 0, scale: 1 }, amount);
    }
  } else drawV2(g, designOf(ch, skin), state, S, b, mouth ?? null, amount);
  t = { key, canvas: c };
  cache.set(key, t);
  return t;
}

// ---------------------------------------------------------------- library contract (packages/library/src/types.ts)

/** talk 0..1 from the ExpressionDef contract -> talking shape (0 = the expression's own mouth) */
const talkShape = (talk: number): MouthShape | null => (talk <= 0.08 ? null : 'open');

/** ExpressionDef for every face-set-v2 expression (drawn with DEFAULT_DESIGN on the given skin) */
export const EXPRESSION_DEFS: ExpressionDef[] = FACE_SET_V2_IDS.map((id) => ({
  id, version: '1.0.0', kind: 'expression' as const,
  ...(FACE_SET_V2[id].emoteVfxId ? { emoteVfxId: FACE_SET_V2[id].emoteVfxId } : {}),
  draw(ctx) {
    drawV2(ctx.ctx2d, { ...DEFAULT_DESIGN, skin: ctx.skin }, id, ctx.size, ctx.blink, talkShape(ctx.talk), ctx.talk);
  },
}));

// ---------------------------------------------------------------- rig hook (talking)

/** the parts of a built Rig the face hook needs (structural, so this module does not import build.ts) */
export interface FaceRig { manifest: CharacterManifest; face: Node }
/** per-rig skin override (crowd colour variants), keyed by the rig's face node */
const skinOverride = new WeakMap<Node, string>();
export function setFaceSkin(rig: FaceRig, skin: string | null): void {
  if (skin) skinOverride.set(rig.face, skin); else skinOverride.delete(rig.face);
}

/**
 * Face hook for S5: expression + blink + talking mouth shape on a built rig. Same texture as Rig.setFace when `mouth`
 * is null/undefined; `mouth` swaps the expression's mouth for closed / open / wide / o. Call it after the animator's
 * own setFace in the frame (it only replaces the face decal texture).
 */
export function setFace(rig: FaceRig, state: string, blink: number, mouth?: MouthShape | null, talkAmount = 1): void {
  rig.face.material!.texture = faceTexture(rig.manifest, state, blink, mouth, skinOverride.get(rig.face), talkAmount);
}
