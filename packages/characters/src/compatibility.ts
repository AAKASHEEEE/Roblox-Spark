// Compatibility of a resolved recipe with the rig, face sets, motion, anchors, camera target, bounds, clothing
// layering, accessory limits and environment scale. Pure metadata arithmetic; no geometry is built.
import type { Catalog, RegisteredComponent, Vec3 } from './catalog.ts';
import type { ResolvedRecipe } from './recipe.ts';
import { err, warn, type Finding } from './schema.ts';

export interface CompatibilityOptions {
  /** actions the target episodes need (e.g. from the story registry); all must be in the motion profile */
  requiredActions?: string[];
  /** environment refs the character must fit (id@version) */
  environments?: string[];
}
export interface CompatibilityResult { errors: Finding[]; warnings: Finding[]; boundsM: Vec3; faceTargetM: Vec3 }

const HAND_FOOT = ['hand_l', 'hand_r', 'foot_l', 'foot_r'];
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function checkCompatibility(recipe: ResolvedRecipe, components: Record<string, RegisteredComponent>, catalog: Catalog, opts: CompatibilityOptions = {}): CompatibilityResult {
  const errors: Finding[] = [], warnings: Finding[] = [];
  const C = (ref: string) => components[ref];
  const body = C(recipe.body.ref), head = C(recipe.head.ref), face = C(recipe.faceSet.ref), motion = C(recipe.motion.ref);
  const worn: [string, RegisteredComponent][] = [
    ['$.appearance.head', head], ['$.appearance.hair', C(recipe.hair.ref)],
    ...recipe.clothing.map((x, i): [string, RegisteredComponent] => [`$.appearance.clothing[${i}]`, C(x.ref)]),
    ['$.appearance.shoes', C(recipe.shoes.ref)],
    ...recipe.accessories.map((x, i): [string, RegisteredComponent] => [`$.appearance.accessories[${i}]`, C(x.ref)]),
  ];
  const bodyAnchors = new Set(body.anchors ?? []);

  // rig
  const all: [string, RegisteredComponent][] = [['$.bodyPreset', body], ...worn, ['$.appearance.faceStyle', face], ['$.motionProfile', motion]];
  for (const [path, comp] of all)
    if (!comp.rigs.includes(recipe.rig)) errors.push(err('RIG_INCOMPATIBLE', path, `${comp.ref} does not support rig ${recipe.rig}`));
  for (const a of HAND_FOOT) if (!bodyAnchors.has(a)) errors.push(err('ANCHOR_MISSING', '$.bodyPreset', `${body.ref} has no ${a} anchor`));

  // expressions / face
  if (!(head.faceSets ?? []).includes(face.id)) errors.push(err('FACE_SET_HEAD_INCOMPATIBLE', '$.appearance.faceStyle', `${face.ref} does not fit head ${head.ref}`));
  const seen = new Set<string>();
  recipe.expressions.forEach((e, i) => {
    if (seen.has(e)) errors.push(err('EXPRESSION_DUPLICATE', `$.expressions[${i}]`, `"${e}" listed twice`));
    seen.add(e);
    if (!(face.expressions ?? []).includes(e)) errors.push(err('EXPRESSION_UNAVAILABLE', `$.expressions[${i}]`, `"${e}" is not provided by ${face.ref} (available: ${(face.expressions ?? []).join(', ')})`));
  });
  if (!seen.has('neutral')) warnings.push(warn('EXPRESSION_NO_NEUTRAL', '$.expressions', 'no neutral expression; the renderer rest face will be the first listed'));

  // motion
  for (const a of motion.requiredAnchors ?? []) if (!bodyAnchors.has(a)) errors.push(err('MOTION_ANCHOR_MISSING', '$.motionProfile', `${motion.ref} needs anchor ${a} which ${body.ref} lacks`));
  const [mMin, mMax] = motion.heightRangeM ?? [0, Infinity];
  if (recipe.proportions.heightM < mMin || recipe.proportions.heightM > mMax) errors.push(err('MOTION_HEIGHT_INCOMPATIBLE', '$.proportions.heightM', `${motion.ref} is tuned for ${mMin}-${mMax} m`));
  for (const a of opts.requiredActions ?? []) if (!(motion.actions ?? []).includes(a)) errors.push(err('MOTION_ACTION_UNAVAILABLE', '$.motionProfile', `action "${a}" is not in ${motion.ref}`));

  // proportions / bounds
  const [hMin, hMax] = body.heightRangeM ?? [0, Infinity];
  const h = recipe.proportions.heightM;
  if (h < hMin || h > hMax) errors.push(err('PROPORTIONS_OUT_OF_RANGE', '$.proportions.heightM', `${h} m is outside ${body.ref} range ${hMin}-${hMax} m`));
  const s = h / (body.baseHeightM ?? h);
  const base = body.baseBounds ?? [0, 0, 0];
  const growth = worn.reduce<Vec3>((g, [, comp]) => { const b = comp.boundsGrowth ?? [0, 0, 0]; return [Math.max(g[0], b[0]), g[1] + b[1], g[2] + b[2]]; }, [0, 0, 0]);
  const headExtra = (recipe.proportions.headScale - 1) * 0.52 * s;
  const boundsM: Vec3 = [r3(base[0] * s * recipe.proportions.limbScale + growth[0] * s + Math.max(0, headExtra)), r3(h + growth[1] * s + headExtra), r3(base[2] * s + growth[2] * s)];
  const ft = head.faceTarget;
  if (!ft) errors.push(err('CAMERA_FACE_TARGET_MISSING', '$.appearance.head', `${head.ref} declares no camera face target`));
  const faceTargetM: Vec3 = ft ? [r3(ft[0] * s), r3(h - 0.52 * recipe.proportions.headScale * s + ft[1] * s * recipe.proportions.headScale), r3(ft[2] * s * recipe.proportions.headScale)] : [0, 0, 0];

  // clothing layering / intersections
  const slotSeen = new Map<string, number>();
  recipe.clothing.forEach((cl, i) => {
    if (slotSeen.has(cl.slot)) errors.push(err('CLOTHING_SLOT_DUPLICATE', `$.appearance.clothing[${i}]`, `two garments in slot "${cl.slot}"`));
    slotSeen.set(cl.slot, i);
  });
  if (!slotSeen.has('bottom') || !(slotSeen.has('top') || slotSeen.has('outer'))) warnings.push(warn('CLOTHING_INCOMPLETE', '$.appearance.clothing', 'expected a top/outer garment and a bottom'));
  const zoneOwner = new Map<string, string>();
  for (const [path, comp] of worn) for (const z of comp.zones ?? []) {
    const prev = zoneOwner.get(z);
    if (prev) errors.push(err('CLOTHING_INTERSECTION', path, `${comp.ref} and ${prev} both occupy "${z}"`));
    else zoneOwner.set(z, comp.ref);
  }

  // accessories
  if (recipe.accessories.length > (body.maxAccessories ?? 0)) errors.push(err('ACCESSORY_LIMIT_EXCEEDED', '$.appearance.accessories', `${recipe.accessories.length} accessories exceed the ${body.ref} limit of ${body.maxAccessories ?? 0}`));
  const anchorSeen = new Set<string>();
  recipe.accessories.forEach((ac, i) => {
    const comp = C(ac.ref), path = `$.appearance.accessories[${i}].anchor`;
    if (!(comp.allowedAnchors ?? []).includes(ac.anchor)) errors.push(err('ACCESSORY_ANCHOR_INVALID', path, `${comp.ref} cannot attach to ${ac.anchor}`));
    if (!bodyAnchors.has(ac.anchor)) errors.push(err('ANCHOR_MISSING', path, `${body.ref} has no ${ac.anchor} anchor`));
    if (anchorSeen.has(ac.anchor)) errors.push(err('ACCESSORY_ANCHOR_CONFLICT', path, `two accessories on ${ac.anchor}`));
    anchorSeen.add(ac.anchor);
    if (ac.anchor.startsWith('hand_') && (motion.actions ?? []).some((a) => a === 'hold' || a === 'pick_up')) warnings.push(warn('ACCESSORY_BLOCKS_HAND', path, 'accessory on a hand anchor conflicts with hold/pick_up props'));
    if (ac.anchor === 'face') warnings.push(warn('CAMERA_FACE_PARTIAL', path, 'face accessory partially covers the camera face target'));
  });

  // environments
  for (const ref of opts.environments ?? []) {
    const env = catalog.environments.get(ref);
    if (!env) { errors.push(err('ENVIRONMENT_UNKNOWN', '$', `environment ${ref} is not registered`)); continue; }
    const [eMin, eMax] = env.characterHeightRangeM;
    if (boundsM[1] < eMin || boundsM[1] > eMax) errors.push(err('ENVIRONMENT_SCALE_INCOMPATIBLE', '$.proportions.heightM', `${boundsM[1]} m tall does not fit ${ref} (${eMin}-${eMax} m)`));
    if (Math.max(boundsM[0], boundsM[2]) > env.maxFootprintM) errors.push(err('BOUNDS_EXCEED_ENVIRONMENT', '$.appearance', `footprint ${Math.max(boundsM[0], boundsM[2])} m exceeds ${ref} limit ${env.maxFootprintM} m`));
  }
  return { errors, warnings, boundsM, faceTargetM };
}
