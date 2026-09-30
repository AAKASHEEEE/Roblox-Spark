// Story/cast/prop/camera compatibility of a request against one exact environment profile. Pure and deterministic.
import type { EnvironmentProfile, ShotIntent, StoryPattern } from './schema.ts';
import { checkPropAnchor } from './anchors.ts';
import { zonesForIntent } from './camera-zones.ts';
import { simultaneousActorCapacity } from './marks.ts';
import { canonicalJson, profileContentHash, sha256Hex } from './lock.ts';

export interface CharacterProfileLike {
  id: string; version: string;
  allowedActions: readonly string[];
  license?: { source: string; attributionRequired: boolean; url?: string };
}
export interface CompatibilityRequest {
  storyPattern: StoryPattern | string;
  characters: readonly CharacterProfileLike[];
  /** actor = character id; omit to require the environment only */
  requiredActions: ReadonlyArray<{ actor?: string; action: string }>;
  requiredProps: ReadonlyArray<{ instance: string; category: string; anchor: string; size?: readonly [number, number, number]; scale?: number }>;
  requiredMarks?: readonly string[];
  castCount: number;
  cameraIntents: readonly (ShotIntent | string)[];
}
export interface CompatibilityReport {
  environment: string;
  contentHash: string;
  compatible: boolean;
  warnings: string[];
  errors: string[];
  missingMarks: string[];
  missingAnchors: string[];
  missingCameraZones: string[];
  unsupportedActions: string[];
  licenseProblems: string[];
  compatibilityHash: string;
}

/** environment features an action needs (beyond being in supportedActions) */
const ACTION_NEEDS: Record<string, { posture?: string; anchorCategory?: string; offscreenCue?: boolean }> = {
  press_button: { anchorCategory: 'device' },
  pick_up: { anchorCategory: 'collectible' }, hold: { anchorCategory: 'collectible' }, put_down: { anchorCategory: 'collectible' }, throw: { anchorCategory: 'collectible' },
  dive_prone: { posture: 'prone' }, cower: { posture: 'crouch' }, hover: { posture: 'hover' },
  enter_frame: { offscreenCue: true }, exit_frame: { offscreenCue: true },
};

const sortU = (xs: string[]) => [...new Set(xs)].sort();

function licenseProblems(src: string, l: { source: string; attributionRequired: boolean; url?: string }): string[] {
  const out: string[] = [];
  if (l.attributionRequired && !l.url) out.push(`${src}: attribution required but no source url recorded`);
  if ((l.source === 'licensed-commercial' || l.source === 'commissioned') && !l.url) out.push(`${src}: ${l.source} asset has no licence/contract reference url`);
  return out;
}

export function checkCompatibility(p: EnvironmentProfile, req: CompatibilityRequest): CompatibilityReport {
  const errors: string[] = [], warnings: string[] = [];
  const missingMarks: string[] = [], missingAnchors: string[] = [], missingCameraZones: string[] = [], unsupportedActions: string[] = [], lic: string[] = [];
  const env = `${p.id}@${p.version}`;

  if (!(p.storyPatterns as readonly string[]).includes(req.storyPattern)) errors.push(`story pattern "${req.storyPattern}" is not supported by ${env} (supports: ${p.storyPatterns.join(', ')})`);

  // cast
  if (!Number.isInteger(req.castCount) || req.castCount < 1) errors.push(`castCount must be a positive integer`);
  else {
    if (req.castCount < p.cast.min || req.castCount > p.cast.max) errors.push(`cast of ${req.castCount} outside ${env} allowed ${p.cast.min}-${p.cast.max}`);
    const cap = simultaneousActorCapacity(p);
    if (req.castCount > cap) errors.push(`cast of ${req.castCount} exceeds ${cap} simultaneously occupiable actor marks`);
  }
  if (req.characters.length !== req.castCount) warnings.push(`castCount ${req.castCount} != ${req.characters.length} character profiles supplied`);
  const chars = new Map(req.characters.map((c) => [c.id, c]));

  // marks
  const marks = new Map(p.marks.map((m) => [m.id, m]));
  for (const id of req.requiredMarks ?? []) {
    const m = marks.get(id);
    if (!m) missingMarks.push(id);
    else if (m.kind === 'offscreen_cue') warnings.push(`mark "${id}" is an off-screen cue: direction only, nothing can stand there`);
  }

  // actions
  for (const ra of req.requiredActions) {
    const label = ra.actor ? `${ra.actor}:${ra.action}` : ra.action;
    if (!(p.supportedActions as readonly string[]).includes(ra.action)) { unsupportedActions.push(label); continue; }
    if (ra.actor) {
      const c = chars.get(ra.actor);
      if (!c) { errors.push(`action ${label} names a character that is not in the cast`); continue; }
      if (!c.allowedActions.includes(ra.action)) { unsupportedActions.push(label); continue; }
    }
    const need = ACTION_NEEDS[ra.action];
    if (need?.posture && !p.marks.some((m) => m.kind === 'actor' && m.postures.includes(need.posture as never))) { unsupportedActions.push(label); missingMarks.push(`<posture:${need.posture}>`); }
    if (need?.anchorCategory && !p.anchors.some((a) => a.role === 'prop' && a.categories.includes(need.anchorCategory!))) { unsupportedActions.push(label); missingAnchors.push(`<category:${need.anchorCategory}>`); }
    if (need?.offscreenCue && !p.marks.some((m) => m.kind === 'offscreen_cue')) { unsupportedActions.push(label); missingMarks.push('<offscreen_cue>'); }
  }

  // props — a missing anchor always blocks; there is no fallback coordinate
  for (const rp of req.requiredProps) {
    const r = checkPropAnchor(p, rp);
    if (r.ok) warnings.push(...r.warnings);
    else { errors.push(r.message); if (r.code === 'anchor_missing') missingAnchors.push(rp.anchor); }
  }

  // camera metadata
  for (const intent of req.cameraIntents) {
    const zones = zonesForIntent(p, intent as ShotIntent);
    if (!zones.length) { missingCameraZones.push(intent); continue; }
    const frame = Math.max(...zones.map((z) => z.maxCastFraming));
    if (req.castCount > frame) warnings.push(`intent ${intent}: safe zones frame at most ${frame} of ${req.castCount} cast`);
  }

  // licensing / provenance
  lic.push(...licenseProblems(env, p.license));
  if (p.status !== 'locked') lic.push(`${env}: draft environment has no locked provenance`);
  if (!p.provenance.derivedFrom.includes(p.asset.key)) lic.push(`${env}: provenance does not record source asset ${p.asset.key}`);
  for (const c of req.characters) {
    if (!c.license) lic.push(`character ${c.id}@${c.version}: no licence metadata`);
    else lic.push(...licenseProblems(`character ${c.id}@${c.version}`, c.license));
  }

  if (missingMarks.length) errors.push(`missing marks: ${sortU(missingMarks).join(', ')}`);
  if (missingCameraZones.length) errors.push(`no camera-safe zone permits: ${sortU(missingCameraZones).join(', ')}`);
  if (unsupportedActions.length) errors.push(`unsupported actions: ${sortU(unsupportedActions).join(', ')}`);
  if (lic.length) errors.push(`licence problems: ${lic.length}`);

  const contentHash = profileContentHash(p);
  const body = {
    environment: env, contentHash,
    compatible: errors.length === 0,
    warnings: sortU(warnings), errors: sortU(errors),
    missingMarks: sortU(missingMarks), missingAnchors: sortU(missingAnchors), missingCameraZones: sortU(missingCameraZones),
    unsupportedActions: sortU(unsupportedActions), licenseProblems: sortU(lic),
  };
  const normalizedRequest = {
    storyPattern: req.storyPattern, castCount: req.castCount,
    characters: req.characters.map((c) => `${c.id}@${c.version}`).sort(),
    requiredActions: sortU(req.requiredActions.map((a) => `${a.actor ?? '*'}:${a.action}`)),
    requiredProps: req.requiredProps.map((r) => canonicalJson(r)).sort(),
    requiredMarks: sortU([...(req.requiredMarks ?? [])]),
    cameraIntents: sortU([...req.cameraIntents]),
  };
  return { ...body, compatibilityHash: sha256Hex(canonicalJson({ request: normalizedRequest, result: body })) };
}
