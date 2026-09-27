// Rendering compatibility contract. Every episode DECLARES the renderer version and the motion profile it was
// authored against, in its `render` block. Nothing is ever inferred: not from episode ids, file names, creation dates,
// schema history or special cases. A missing, unknown or unsupported declaration is a hard error — there is no
// fallback profile. See docs/RENDERING_COMPATIBILITY.md for the policy.
// Pure data + pure functions (browser-safe: used by the engine, the validator, the compiler and the CLIs).

/** episode schema version that introduced the mandatory render block */
export const EPISODE_SCHEMA_VERSION = '1.1';

/** renderer (pixel pipeline) versions this build can reproduce */
export const RENDERER_VERSIONS = ['1.0.0'] as const;
export type RendererVersion = (typeof RENDERER_VERSIONS)[number];
/** version written into NEW episodes */
export const CURRENT_RENDERER_VERSION: RendererVersion = '1.0.0';

/** animation behaviour switches selected by a motion profile (engine reads ONLY these, never the profile name) */
export interface MotionBehaviour {
  /** neck look-at composition: legacy Euler blend (pitch applied about the SPINE x axis) or yaw-then-pitch */
  lookAt: 'euler-spine-pitch' | 'yaw-then-pitch';
  /** additive head layers (head_shake) keep full amplitude while a look-at is active */
  headLayersOverLookAt: boolean;
  /** turn_toward / startFacing targets that are actors listed LATER in the cast resolve (legacy: silently ignored) */
  laterCastTargets: boolean;
  /** locomotion start: legacy pose blend + yaw blend about the root, or root/gait/planted-foot synchronised onset */
  locomotionOnset: 'blended' | 'synchronized';
}

export interface MotionProfileSpec {
  /** frozen = reproduced bit-for-bit forever, never changed; current = default for newly generated episodes */
  status: 'frozen' | 'current';
  description: string;
  behaviour: MotionBehaviour;
}

export const MOTION_PROFILE_IDS = ['legacy-head-v1', 'corrected-head-v2'] as const;
export type MotionProfileId = (typeof MOTION_PROFILE_IDS)[number];

export const MOTION_PROFILES: Record<MotionProfileId, MotionProfileSpec> = {
  'legacy-head-v1': {
    status: 'frozen',
    description: 'Motion exactly as rendered before explicit versioning (PoC commit 1dc7a26), including the known defects: look-at pitch composed about the spine axis, head_shake attenuated by an active look-at, turn/startFacing toward a later-cast actor ignored, locomotion onset blended while the root already rotates and translates.',
    behaviour: { lookAt: 'euler-spine-pitch', headLayersOverLookAt: false, laterCastTargets: false, locomotionOnset: 'blended' },
  },
  'corrected-head-v2': {
    status: 'current',
    description: 'Corrections found by the action reel: yaw-then-pitch look-at, head layers preserved under look-at, later-cast actor targets resolved, synchronised locomotion onset (root translation, gait phase and planted foot share one state).',
    behaviour: { lookAt: 'yaw-then-pitch', headLayersOverLookAt: true, laterCastTargets: true, locomotionOnset: 'synchronized' },
  },
};
/** profile written into NEWLY generated episodes (existing episodes keep whatever they declare) */
export const DEFAULT_MOTION_PROFILE: MotionProfileId = 'corrected-head-v2';

/** which motion profiles each renderer version supports */
export const SUPPORTED_COMBINATIONS: Record<RendererVersion, readonly MotionProfileId[]> = { '1.0.0': ['legacy-head-v1', 'corrected-head-v2'] };

export interface RenderDeclaration {
  rendererVersion: RendererVersion;
  motionProfile: MotionProfileId;
  /** provenance written by upgradeEpisode (excluded from the semantic content) */
  upgradedFrom?: { rendererVersion: RendererVersion; motionProfile: MotionProfileId; sourceSha256: string };
}

export type CompatCode = 'UNSUPPORTED_SCHEMA_VERSION' | 'RENDER_VERSION_MISSING' | 'RENDERER_VERSION_MISSING' | 'MOTION_PROFILE_MISSING'
  | 'UNSUPPORTED_RENDERER_VERSION' | 'UNSUPPORTED_MOTION_PROFILE' | 'UNSUPPORTED_COMBINATION';

export class RenderCompatError extends Error {
  readonly code: CompatCode;
  constructor(code: CompatCode, message: string) { super(`${code}: ${message}`); this.code = code; this.name = 'RenderCompatError'; }
}

export type CompatResult = { ok: true; decl: RenderDeclaration; behaviour: MotionBehaviour; key: string } | { ok: false; code: CompatCode; message: string; path: string };

const HOW_TO = 'declare it explicitly: `node scripts/episode-version.ts pin <file> --renderer <version> --profile <id>` for an existing episode that must keep its pixels, or generate/upgrade it (`episode-version.ts upgrade`) for the current profile';

/** Explicit check of an episode's render declaration. Never substitutes a default. */
export function checkRenderDeclaration(raw: unknown): CompatResult {
  const e = (raw ?? {}) as Record<string, unknown>;
  if (e.schemaVersion !== EPISODE_SCHEMA_VERSION) {
    return { ok: false, code: 'UNSUPPORTED_SCHEMA_VERSION', path: '$.schemaVersion', message: `episode schemaVersion ${JSON.stringify(e.schemaVersion)} is not supported (this build reads ${EPISODE_SCHEMA_VERSION}, which requires an explicit render block); ${HOW_TO}` };
  }
  const r = e.render as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object') return { ok: false, code: 'RENDER_VERSION_MISSING', path: '$.render', message: `episode declares no render block (rendererVersion + motionProfile); ${HOW_TO}` };
  if (r.rendererVersion === undefined) return { ok: false, code: 'RENDERER_VERSION_MISSING', path: '$.render.rendererVersion', message: `render.rendererVersion is missing; ${HOW_TO}` };
  if (r.motionProfile === undefined) return { ok: false, code: 'MOTION_PROFILE_MISSING', path: '$.render.motionProfile', message: `render.motionProfile is missing; ${HOW_TO}` };
  if (!(RENDERER_VERSIONS as readonly unknown[]).includes(r.rendererVersion)) return { ok: false, code: 'UNSUPPORTED_RENDERER_VERSION', path: '$.render.rendererVersion', message: `renderer version ${JSON.stringify(r.rendererVersion)} is not supported by this build (supported: ${RENDERER_VERSIONS.join(', ')})` };
  if (!(MOTION_PROFILE_IDS as readonly unknown[]).includes(r.motionProfile)) return { ok: false, code: 'UNSUPPORTED_MOTION_PROFILE', path: '$.render.motionProfile', message: `motion profile ${JSON.stringify(r.motionProfile)} is not supported by this build (supported: ${MOTION_PROFILE_IDS.join(', ')})` };
  const rv = r.rendererVersion as RendererVersion, mp = r.motionProfile as MotionProfileId;
  if (!SUPPORTED_COMBINATIONS[rv].includes(mp)) return { ok: false, code: 'UNSUPPORTED_COMBINATION', path: '$.render', message: `renderer ${rv} does not support motion profile ${mp} (supported with ${rv}: ${SUPPORTED_COMBINATIONS[rv].join(', ')})` };
  return { ok: true, decl: r as unknown as RenderDeclaration, behaviour: MOTION_PROFILES[mp].behaviour, key: renderKey({ rendererVersion: rv, motionProfile: mp }) };
}

/** Same check, throwing. Used by the engine so that no code path can render with an undeclared profile. */
export function resolveRenderCompat(raw: unknown): { decl: RenderDeclaration; behaviour: MotionBehaviour; key: string } {
  const r = checkRenderDeclaration(raw);
  if (!r.ok) throw new RenderCompatError(r.code, r.message);
  return r;
}

/** storage key for golden hashes: one golden set per renderer/profile combination */
export function renderKey(d: { rendererVersion: string; motionProfile: string }): string { return `${d.rendererVersion}__${d.motionProfile}`; }

/** canonical JSON (sorted keys, no whitespace) */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(v);
}

/** the episode's story content: everything except the render declaration (same semantics => same value) */
export function semanticContent(ep: unknown): Record<string, unknown> {
  const { render: _r, ...rest } = ep as Record<string, unknown>;
  void _r;
  return rest;
}

/**
 * Explicit upgrade: returns a NEW episode object declaring `to` (and the current renderer version). The source object is
 * never mutated. The source must already declare its versions — an undeclared episode cannot be upgraded because its
 * original behaviour would have to be guessed.
 */
export function upgradeEpisode<T extends Record<string, unknown>>(src: T, to: MotionProfileId, opts: { sourceSha256: string }): T {
  const c = checkRenderDeclaration(src);
  if (!c.ok) throw new RenderCompatError(c.code, `cannot upgrade: ${c.message}`);
  if (!MOTION_PROFILE_IDS.includes(to)) throw new RenderCompatError('UNSUPPORTED_MOTION_PROFILE', `cannot upgrade to unknown motion profile ${JSON.stringify(to)}`);
  if (!SUPPORTED_COMBINATIONS[CURRENT_RENDERER_VERSION].includes(to)) throw new RenderCompatError('UNSUPPORTED_COMBINATION', `renderer ${CURRENT_RENDERER_VERSION} does not support ${to}`);
  if (c.decl.motionProfile === to && c.decl.rendererVersion === CURRENT_RENDERER_VERSION) throw new RenderCompatError('UNSUPPORTED_COMBINATION', `episode already declares ${renderKey(c.decl)}; nothing to upgrade`);
  if (!/^[0-9a-f]{64}$/.test(opts.sourceSha256)) throw new Error('upgradeEpisode: sourceSha256 must be the sha256 of the source file');
  const copy = JSON.parse(JSON.stringify(src)) as Record<string, unknown>;
  const { schemaVersion, render: _old, ...rest } = copy;
  void _old;
  return {
    schemaVersion,
    render: { rendererVersion: CURRENT_RENDERER_VERSION, motionProfile: to, upgradedFrom: { rendererVersion: c.decl.rendererVersion, motionProfile: c.decl.motionProfile, sourceSha256: opts.sourceSha256 } },
    ...rest,
  } as unknown as T;
}

/**
 * Explicit pin of an UNDECLARED legacy (schema 1.0) episode to a caller-chosen renderer/profile. Both values are required
 * arguments: this function never chooses a profile. Refuses episodes that already declare one (use upgradeEpisode).
 */
export function pinEpisode<T extends Record<string, unknown>>(src: T, decl: { rendererVersion: string; motionProfile: string }): T {
  if ((src as Record<string, unknown>).render !== undefined) throw new RenderCompatError('UNSUPPORTED_COMBINATION', 'episode already declares a render block; changing a declared profile must go through upgradeEpisode (copy)');
  if ((src as Record<string, unknown>).schemaVersion !== '1.0') throw new RenderCompatError('UNSUPPORTED_SCHEMA_VERSION', `pin only migrates undeclared schema 1.0 episodes (got ${JSON.stringify((src as Record<string, unknown>).schemaVersion)})`);
  if (!(RENDERER_VERSIONS as readonly string[]).includes(decl.rendererVersion)) throw new RenderCompatError('UNSUPPORTED_RENDERER_VERSION', `unknown renderer version ${JSON.stringify(decl.rendererVersion)}`);
  if (!(MOTION_PROFILE_IDS as readonly string[]).includes(decl.motionProfile)) throw new RenderCompatError('UNSUPPORTED_MOTION_PROFILE', `unknown motion profile ${JSON.stringify(decl.motionProfile)}`);
  const copy = JSON.parse(JSON.stringify(src)) as Record<string, unknown>;
  const { schemaVersion: _sv, ...rest } = copy;
  void _sv;
  return { schemaVersion: EPISODE_SCHEMA_VERSION, render: { rendererVersion: decl.rendererVersion, motionProfile: decl.motionProfile }, ...rest } as unknown as T;
}
