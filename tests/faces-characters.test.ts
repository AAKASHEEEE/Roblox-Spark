// S3: characters and faces (face set v2, talking mouth shapes, cast manifests, crowd variants, kira@1.2.0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';
import { LIBRARY, idsOf } from '../packages/library/src/ids.ts';
import { FACE_SET_V2_IDS, EXPRESSION_DEFS, MOUTH_SHAPES, faceTexture, faceStatesFor, hasFace, setFace } from '../packages/engine/src/faces/index.ts';
import { characterRecipes, crowdVariant, applyCrowdVariant } from '../packages/engine/src/faces/recipes.ts';
import { buildCharacter } from '../packages/engine/src/build.ts';
import { hex } from '../packages/engine/src/gl/scene.ts';

// permissive 2D context so the real face drawing code runs in node (every call is accepted)
class RecCanvas {
  width: number; height: number;
  constructor(w: number, h: number) { this.width = w; this.height = h; }
  getContext() {
    const target: Record<string | symbol, unknown> = {};
    return new Proxy(target, {
      get(t, k) { if (k in t) return t[k]; return () => undefined; },
      set(t, k, v) { t[k] = v; return true; },
    });
  }
}
(globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = RecCanvas;

const lib = loadLibrary();
const NEW = ['teacher', 'mom', 'dad', 'friend_boy', 'friend_girl', 'noob', 'pro', 'crowd_kid'];
const ADULTS = ['teacher', 'mom', 'dad'];
const recipes = characterRecipes(lib.characters);

test('library loads locked with the new cast and kira@1.2.0', () => {
  assert.deepEqual(lib.errors, []);
  for (const id of NEW) assert.ok(lib.characters[`${id}@1.0.0`], id);
  assert.ok(lib.characters['kira@1.2.0']);
  // every published S3 character is available through a recipe
  for (const id of idsOf('characters', 'available')) assert.ok(recipes[id], `recipe for ${id}`);
});

test('every allowed expression has a locked face state; defaults are drawable', () => {
  for (const m of Object.values(lib.characters)) {
    for (const e of m.allowedExpressions) assert.ok(m.face.states[e], `${m.id}@${m.version}: ${e}`);
  }
  for (const r of Object.values(recipes)) {
    assert.ok(hasFace(r.manifest, r.defaultExpression));
    assert.deepEqual(r.expressions, faceStatesFor(r.manifest));
  }
});

test('adults read as adults: taller and a smaller head-to-height ratio than every kid', () => {
  const dims = (id: string) => buildCharacter(recipes[id].manifest).dims;
  const kids = ['zapp', 'kira', 'friend_boy', 'friend_girl', 'noob', 'pro', 'crowd_kid'].map(dims);
  for (const a of ADULTS.map(dims)) for (const k of kids) {
    assert.ok(a.height > k.height + 0.25, 'adult taller');
    assert.ok(a.headH / a.height < k.headH / k.height - 0.03, 'adult head ratio smaller');
  }
});

test('cast silhouettes and colours differ', () => {
  const ms = Object.values(recipes).map((r) => r.manifest);
  const sig = ms.map((m) => `${m.body.torso.join()}|${m.body.headSize.join()}|${m.body.upperLeg}`);
  assert.equal(new Set(sig).size, ms.length, 'proportions');
  assert.equal(new Set(ms.map((m) => m.body.torsoColor)).size, ms.length, 'main colours');
  // no platform default-avatar scheme on the newbie (docs/LEGAL_AND_ASSET_SAFETY.md)
  // the newbie's outfit is neutral grey (saturation < 10%), never a yellow/blue/green scheme
  const n = recipes.noob.manifest.body;
  const sat = (h: string) => { const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); return (Math.max(...v) - Math.min(...v)) / Math.max(1, Math.max(...v)); };
  for (const c of [n.torsoColor, n.sleeveColor, n.legColor, n.shoeColor]) assert.ok(sat(c) < 0.1, c);
});

test('face set v2 covers the published S3 expression definitions', () => {
  assert.deepEqual(EXPRESSION_DEFS.map((d) => d.id).sort(), [...FACE_SET_V2_IDS].sort());
  for (const d of EXPRESSION_DEFS) {
    const e = LIBRARY.expressions.find((x) => x.id === d.id);
    assert.equal(e?.owner, 'S3');
    assert.equal(e?.status, 'available');
    assert.deepEqual(e?.versions, ['1.0.0']);
  }
  assert.deepEqual([...MOUTH_SHAPES], ['closed', 'open', 'wide', 'o']);
});

test('every character draws every v1 state, every v2 expression and every talking shape', () => {
  for (const r of Object.values(recipes)) for (const s of r.expressions) for (const mouth of [null, ...MOUTH_SHAPES]) for (const blink of [0, 1]) {
    const t = faceTexture(r.manifest, s, blink, mouth);
    assert.ok(t.key.includes(`:${s}:`), t.key);
  }
  for (const d of EXPRESSION_DEFS) {
    const c = new RecCanvas(256, 256);
    d.draw({ ctx2d: c.getContext() as never, size: 256, skin: '#c68a5e', blink: 0, talk: 0.6, t: 0, seed: 1 });
  }
  assert.throws(() => faceTexture(recipes.zapp.manifest, 'nope', 0), /no face state/);
  assert.throws(() => faceTexture(recipes.zapp.manifest, 'neutral', 0, 'x' as never), /unknown mouth shape/);
});

test('face set v1 without talking keeps the pre-v2 texture key (existing renders unchanged)', () => {
  const z = lib.characters['zapp@1.0.0'];
  assert.equal(faceTexture(z, 'neutral', 0.3).key, 'face:zapp@1.0.0:neutral:0.25:0');
  assert.notEqual(faceTexture(z, 'neutral', 0, 'open').key, faceTexture(z, 'neutral', 0).key);
  // build.ts's own Rig.setFace reaches face set v2; the faces hook adds the talking mouth
  const rig = buildCharacter(z);
  rig.setFace('furious', 0);
  assert.match(rig.face.material!.texture!.key, /^face2:zapp@1\.0\.0:.*:furious:0:-$/);
  setFace(rig, 'furious', 0, 'wide');
  assert.match(rig.face.material!.texture!.key, /^face2:zapp@1\.0\.0:.*:furious:0:wide$/);
  setFace(rig, 'neutral', 0);
  assert.equal(rig.face.material!.texture!.key, 'face:zapp@1.0.0:neutral:0:0');
});

test('crowd_kid colour variants are deterministic, varied, and seed 0 is the manifest', () => {
  const m = recipes.crowd_kid.manifest;
  assert.deepEqual(crowdVariant(m, 7), crowdVariant(m, 7));
  const v0 = crowdVariant(m, 0);
  assert.equal(v0.shirt, m.body.torsoColor);
  const vs = Array.from({ length: 24 }, (_, i) => crowdVariant(m, i + 1));
  for (const k of ['skin', 'shirt', 'pants', 'shoes', 'hair'] as const) assert.ok(new Set(vs.map((v) => v[k])).size >= 4, k);
  assert.ok(new Set(vs.map((v) => JSON.stringify(v))).size >= 22, 'outfits');
  const rig = buildCharacter(m);
  const v = applyCrowdVariant(rig, 3);
  assert.deepEqual(rig.meshes.find((n) => n.name === 'torso_mesh')!.material!.color, hex(v.shirt));
  assert.deepEqual(rig.meshes.find((n) => n.name === 'head_mesh')!.material!.color, hex(v.skin));
  assert.deepEqual(rig.meshes.find((n) => n.name === 'hair_top')!.material!.color, hex(v.hair));
  recipes.crowd_kid.decorate!(buildCharacter(m), { seed: 5 });
  rig.setFace('love_eyes', 0);
  assert.ok(rig.face.material!.texture!.key.includes(v.skin), 'v2 face tints use the variant skin');
  setFace(rig, 'love_eyes', 0, 'o');
  assert.ok(rig.face.material!.texture!.key.includes(v.skin), 'talking keeps the variant skin');
});

test('kira@1.2.0 only reshapes the side hair and clears the three-quarter cheek', () => {
  const a = lib.characters['kira@1.1.0'], b = lib.characters['kira@1.2.0'];
  const strip = (m: typeof a) => ({ ...m, version: '', description: '', identityRules: [], parts: m.parts.filter((p) => !/^bob_(side|temple)_/.test(p.id)) });
  assert.deepEqual(strip(b), strip(a), 'everything except the side hair is unchanged');
  assert.deepEqual(b.identityRules.slice(0, a.identityRules.length), a.identityRules);
  const faceZ = b.body.headSize[2] / 2;
  for (const s of ['l', 'r']) {
    const side = b.parts.find((p) => p.id === `bob_side_${s}`)!;
    const old = a.parts.find((p) => p.id === `bob_side_${s}`)!;
    assert.equal(side.size[1], old.size[1], 'still jaw length');
    assert.ok(side.pos[2] + side.size[2] / 2 < faceZ - 0.1, 'side panel ends behind the cheek');
    const temple = b.parts.find((p) => p.id === `bob_temple_${s}`)!;
    assert.ok(temple.pos[1] - temple.size[1] / 2 > b.body.headSize[1] * (1 - b.face.eyeY) + 0.1, 'temple lock sits above the eyes');
  }
});
