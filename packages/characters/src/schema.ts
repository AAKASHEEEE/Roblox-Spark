// Character profile schema v1.0 — strict (unknown keys are errors), data only. A profile describes an ORIGINAL modular
// character by pointing at registered, version-pinned components; it never carries meshes, file paths or code.
import { v, type SchemaT, type Issue } from '../../schema/src/v.ts';

export const CHARACTER_SCHEMA_VERSION = '1.0';
/** keys that must never appear anywhere in a profile or reference (prototype pollution) */
export const FORBIDDEN_KEYS = ['__proto__', 'prototype', 'constructor'] as const;

export const PROVENANCE = ['original', 'commissioned', 'owned', 'licensed', 'public_domain', 'unknown', 'prohibited'] as const;
export type Provenance = (typeof PROVENANCE)[number];
export const REFERENCE_TYPES = ['front_image', 'side_image', 'back_image', 'expression_sheet', 'palette_image', 'owned_glb', 'owned_texture', 'written_details'] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];
export const PROFILE_STATUS = ['draft', 'validated', 'approved', 'locked', 'deprecated'] as const;
export type ProfileStatus = (typeof PROFILE_STATUS)[number];
export const CLOTHING_SLOTS = ['top', 'outer', 'bottom'] as const;
export const ACCESSORY_ANCHORS = ['head_top', 'face', 'neck', 'back', 'wrist_l', 'wrist_r', 'hand_l', 'hand_r', 'waist'] as const;
export const ARCHETYPES = ['protagonist', 'sidekick', 'skeptic', 'rival', 'mentor', 'narrator', 'extra'] as const;

/** pinned component reference: "<id>@<semver>" — ranges, tags and "latest" are not accepted */
export const COMPONENT_REF = /^[a-z][a-z0-9]*(-[a-z0-9]+)*@\d+\.\d+\.\d+$/;
export const CHARACTER_ID = /^[a-z][a-z0-9_]*(-[a-z0-9_]+)*$/;
export const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;
/** opaque content-addressed storage key; never a filesystem path or URL */
export const STORAGE_REF = /^cas:\/\/references\/sha256\/[0-9a-f]{64}$/;

const componentRef = () => v.string({ pattern: COMPONENT_REF, max: 80 });
const hex = () => v.hexColor();
const text = (max: number) => v.string({ min: 1, max });
const paletteMap = () => v.record(hex(), /^[a-z][a-z0-9_]{0,23}$/);

export const ProvenanceSchema = v.object({
  source: v.enum(PROVENANCE),
  owner: text(120),
  licenseName: text(120).optional(),
  attributionRequired: v.boolean(),
  attributionText: text(300).optional(),
  allowsDerivative: v.boolean(),
  allowsOutput: v.boolean(),
  allowsRedistribution: v.boolean(),
  notes: text(500).optional(),
});
export type ProvenanceInfo = SchemaT<typeof ProvenanceSchema>;

/**
 * A reference record. Only referenceId + type are required to PARSE, so a draft can hold a reference whose bytes
 * have not been ingested/attested yet. Every evidence field is still required to VALIDATE (see references.ts
 * REQUIRED_EVIDENCE) and must be confirmed by the trusted workflow (trust.ts). Nothing here has a default: an absent
 * attestation stays absent.
 */
export const AttestationSchema = v.object({ attested: v.boolean(), attestedBy: v.string({ max: 160 }), attestedAt: v.string({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/ }), statement: text(500) });
export type Attestation = SchemaT<typeof AttestationSchema>;
export const ReferenceSchema = v.object({
  referenceId: v.string({ pattern: /^ref_[a-z0-9_]{1,48}$/ }),
  type: v.enum(REFERENCE_TYPES),
  contentHash: v.string({ pattern: CONTENT_HASH }).optional(),
  mimeType: v.string({ min: 3, max: 100 }).optional(),
  byteSize: v.int({ min: 1, max: 50 * 1024 * 1024 }).optional(),
  dimensions: v.object({ width: v.int({ min: 1, max: 8192 }), height: v.int({ min: 1, max: 8192 }) }).optional(),
  displayFilename: v.string({ min: 1, max: 255 }).optional(),
  provenance: ProvenanceSchema.optional(),
  userAttestation: AttestationSchema.optional(),
  storageRef: v.string({ min: 1, max: 200 }).optional(),
  redistributable: v.boolean().optional(),
  mayAppearInOutput: v.boolean().optional(),
  /** written_details only: the user's description (data, never evaluated) */
  details: text(4000).optional(),
});
export type Reference = SchemaT<typeof ReferenceSchema>;

export const ProfileSchema = v.object({
  schemaVersion: v.literal(CHARACTER_SCHEMA_VERSION),
  characterId: v.string({ pattern: CHARACTER_ID, max: 64 }),
  version: v.semver(),
  displayName: text(60),
  role: v.object({ archetype: v.enum(ARCHETYPES), personality: text(500) }),
  status: v.enum(PROFILE_STATUS),
  bodyPreset: componentRef(),
  proportions: v.object({ heightM: v.number({ min: 0.8, max: 2.4 }), headScale: v.number({ min: 0.8, max: 1.3 }), limbScale: v.number({ min: 0.8, max: 1.2 }) }),
  appearance: v.object({
    head: v.object({ preset: componentRef(), palette: paletteMap() }),
    hair: v.object({ assetId: componentRef(), palette: paletteMap() }),
    clothing: v.array(v.object({ assetId: componentRef(), slot: v.enum(CLOTHING_SLOTS), palette: paletteMap() }), { min: 1, max: 4 }),
    shoes: v.object({ assetId: componentRef(), palette: paletteMap() }),
    accessories: v.array(v.object({ assetId: componentRef(), anchor: v.enum(ACCESSORY_ANCHORS), palette: paletteMap() }), { max: 8 }),
    faceStyle: componentRef(),
  }),
  expressions: v.array(v.id(), { min: 1, max: 16 }),
  motionProfile: componentRef(),
  voice: v.object({ voiceId: v.string({ pattern: /^[a-z][a-z0-9_-]{0,47}$/ }).optional(), pitch: v.enum(['low', 'mid', 'high'] as const), pace: v.enum(['slow', 'normal', 'fast'] as const), notes: text(300).optional() }).optional(),
  references: v.array(ReferenceSchema, { max: 16 }),
  /** optional while drafting; required (and gated) from validation onwards */
  license: ProvenanceSchema.optional(),
  /** explicitly approved component substitutions; nothing is ever substituted without one */
  substitutions: v.array(v.object({ requested: componentRef(), substitute: componentRef(), approvedBy: text(120), reason: text(300) }), { max: 16 }).optional(),
  identityRules: v.array(text(200), { max: 12 }).optional(),
  locked: v.boolean(),
  contentHash: v.string({ pattern: CONTENT_HASH }).optional(),
  deprecation: v.object({ reason: text(300), supersededBy: v.semver().optional() }).optional(),
});
export type CharacterProfile = SchemaT<typeof ProfileSchema>;

export type Severity = 'error' | 'warning';
export interface Finding { code: string; path: string; message: string; severity: Severity; suggestion?: { category: string; candidates: string[]; requiresApproval: true } }
export const err = (code: string, path: string, message: string, extra: Partial<Finding> = {}): Finding => ({ code, path, message, severity: 'error', ...extra });
export const warn = (code: string, path: string, message: string): Finding => ({ code, path, message, severity: 'warning' });

/** recursive scan for prototype-pollution keys (JSON.parse creates an OWN "__proto__" property) */
export function findForbiddenKeys(v: unknown, path = '$', out: Finding[] = []): Finding[] {
  if (Array.isArray(v)) v.forEach((x, i) => findForbiddenKeys(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if ((FORBIDDEN_KEYS as readonly string[]).includes(k)) out.push(err('PROTOTYPE_KEY_REJECTED', `${path}.${k}`, `forbidden key "${k}"`));
      else findForbiddenKeys((v as Record<string, unknown>)[k], `${path}.${k}`, out);
    }
  }
  return out;
}

const issueCode = (i: Issue) => {
  if (i.message.startsWith('unknown key')) return 'SCHEMA_UNKNOWN_KEY';
  if (/\.(provenance|license)(\.source)?$/.test(i.path)) return i.message === 'required' ? 'PROVENANCE_MISSING' : 'PROVENANCE_INVALID';
  return 'SCHEMA_INVALID';
};
export const issuesToFindings = (issues: Issue[]): Finding[] => issues.map((i) => err(issueCode(i), i.path, i.message));

/** strict structural parse. Forbidden keys are rejected before the schema sees the value. */
export function parseProfile(raw: unknown): { ok: true; profile: CharacterProfile } | { ok: false; errors: Finding[] } {
  const forbidden = findForbiddenKeys(raw);
  if (forbidden.length) return { ok: false, errors: forbidden };
  const r = ProfileSchema.parse(raw);
  if (!r.ok) return { ok: false, errors: issuesToFindings(r.issues) };
  return { ok: true, profile: r.value };
}
