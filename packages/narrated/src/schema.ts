// Narrated Story — versioned storyboard schema (strict: unknown keys are errors) plus semantic checks the type system
// cannot express: timing order, overlaps, bounds inside the audio, registry membership, forbidden keys.
// The storyboard is DATA ONLY: nothing in it is ever evaluated, and script text is never turned into code.
import { v, type SchemaT, type Issue } from '../../schema/src/v.ts';
import { CAMERA_PRESETS, EXPRESSIONS } from '../../schema/src/episode.ts';

export const NARRATED_SCHEMA_VERSION = '1.0';
export const STORY_PATTERNS = ['comparison', 'hypothetical', 'escalating_consequence', 'narrated_comedy'] as const;
export type StoryPattern = (typeof STORY_PATTERNS)[number];
export const CAPTION_PRESETS = ['shorts_default'] as const;
export const ALIGNMENT_METHODS = ['silence-guided', 'merged-regions', 'split-region', 'word-proportional'] as const;
export type AlignmentMethod = (typeof ALIGNMENT_METHODS)[number];
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export const STORY_PURPOSES = ['hook', 'setup', 'initial-benefit', 'escalation', 'turn', 'consequence', 'reaction', 'comparison-a', 'comparison-b', 'punchline', 'closing'] as const;
export type StoryPurpose = (typeof STORY_PURPOSES)[number];
export const AUDIO_FORMATS = ['wav', 'mp3', 'm4a'] as const;
/** keys that must never appear anywhere in a storyboard or request (prototype pollution) */
export const FORBIDDEN_KEYS = ['__proto__', 'prototype', 'constructor'] as const;

/** caption safe-area preset; fractions of the 1080x1920 frame (burn-in is Phase 2) */
export const CAPTION_STYLE = {
  shorts_default: { maxLines: 2, maxCharsPerLine: 32, anchor: 'lower_middle', centerY: 0.72, bottomSafe: 0.16, maxWordsPerSecond: 3.6 },
} as const;

export interface VocabIds { characters: readonly string[]; actions: readonly string[]; expressions: readonly string[]; environments: readonly string[]; cameras: readonly string[] }

const finding = v.object({ code: v.string({ pattern: /^[A-Z][A-Z0-9_]*$/, max: 48 }), message: v.string({ max: 300 }) });
export function narratedStoryboardSchema(ids: VocabIds) {
  const time = () => v.number({ min: 0, max: 600 });
  const character = v.enum(ids.characters as readonly string[]);
  const phrase = v.object({
    id: v.string({ pattern: /^p\d{2,3}$/ }),
    section: v.int({ min: 1, max: 80 }),
    text: v.string({ min: 1, max: 200 }),
    words: v.int({ min: 1, max: 60 }),
    start: time(), end: time(),
    alignmentMethod: v.enum(ALIGNMENT_METHODS),
    alignmentConfidence: v.number({ min: 0, max: 1 }),
    storyPurpose: v.enum(STORY_PURPOSES),
    actor: character,
    supportingCharacter: character.nullable(),
    semanticAction: v.enum(ids.actions as readonly string[]),
    target: v.string({ pattern: /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)?$/, max: 48 }).nullable(),
    expression: v.enum(ids.expressions as readonly string[]),
    supportingExpression: v.enum(ids.expressions as readonly string[]).nullable(),
    environment: v.enum(ids.environments as readonly string[]),
    cameraPreset: v.enum(ids.cameras as readonly string[]),
    visualIntent: v.string({ min: 1, max: 200 }),
    substitutions: v.array(v.object({ requested: v.string({ max: 60 }), used: v.string({ max: 60 }), reason: v.string({ max: 200 }) }), { max: 6 }),
    caption: v.object({
      lines: v.array(v.string({ min: 1, max: CAPTION_STYLE.shorts_default.maxCharsPerLine }), { min: 1, max: CAPTION_STYLE.shorts_default.maxLines }),
      emphasisWords: v.array(v.string({ min: 1, max: 40 }), { max: 3 }),
      wordsPerSecond: v.number({ min: 0, max: 100 }),
    }),
    warnings: v.array(finding, { max: 12 }),
  });
  return v.object({
    schemaVersion: v.literal(NARRATED_SCHEMA_VERSION),
    mode: v.literal('narrated_story'),
    id: v.string({ pattern: /^nr-[0-9a-f]{12}$/ }),
    title: v.string({ min: 1, max: 80 }),
    seed: v.int({ min: 0, max: 2147483647 }),
    storyPattern: v.enum(STORY_PATTERNS),
    captionPreset: v.enum(CAPTION_PRESETS),
    audio: v.object({
      source: v.literal('uploaded'), format: v.enum(AUDIO_FORMATS), codec: v.string({ max: 24 }),
      originalFilename: v.string({ min: 1, max: 120 }), durationSeconds: v.number({ min: 0.5, max: 600 }),
      sampleRate: v.int({ min: 8000, max: 192000 }), channels: v.int({ min: 1, max: 8 }), contentHash: v.string({ pattern: /^[0-9a-f]{64}$/ }),
    }),
    characters: v.array(character, { min: 1, max: 2 }),
    script: v.object({ originalText: v.string({ min: 1, max: 6000 }), phrases: v.array(phrase, { min: 1, max: 80 }) }),
    alignment: v.object({
      method: v.string({ max: 40 }), level: v.enum(CONFIDENCE_LEVELS), confidence: v.number({ min: 0, max: 1 }),
      phraseCount: v.int({ min: 1 }), speechRegions: v.int({ min: 0 }), estimatedPhrases: v.int({ min: 0 }), note: v.string({ max: 300 }),
    }),
    captionStyle: v.object({ preset: v.enum(CAPTION_PRESETS), anchor: v.literal('lower_middle'), centerY: v.number({ min: 0.5, max: 0.84 }), bottomSafe: v.number({ min: 0.1, max: 0.3 }), maxLines: v.int({ min: 1, max: 2 }), maxCharsPerLine: v.int({ min: 10, max: 40 }) }),
    timeline: v.array(v.object({ beatId: v.string({ pattern: /^b\d{2,3}$/ }), phraseId: v.string({ pattern: /^p\d{2,3}$/ }), start: time(), end: time(), cameraPreset: v.enum(ids.cameras as readonly string[]), actor: character, semanticAction: v.enum(ids.actions as readonly string[]) }), { min: 1, max: 80 }),
    validation: v.object({ status: v.enum(['ok', 'warning'] as const), errors: v.array(finding), warnings: v.array(finding) }),
  });
}
export type NarratedStoryboard = SchemaT<ReturnType<typeof narratedStoryboardSchema>>;
export type NarratedPhrase = NarratedStoryboard['script']['phrases'][number];

export const DEFAULT_EXPRESSIONS: readonly string[] = EXPRESSIONS;
export const DEFAULT_CAMERAS: readonly string[] = CAMERA_PRESETS;

/** own keys named __proto__/prototype/constructor anywhere in a JSON value (JSON.parse creates them as own keys) */
export function forbiddenKeyPaths(x: unknown, path = '$', out: string[] = []): string[] {
  if (x && typeof x === 'object') {
    for (const k of Object.keys(x)) {
      if ((FORBIDDEN_KEYS as readonly string[]).includes(k)) out.push(`${path}.${k}`);
      else forbiddenKeyPaths((x as Record<string, unknown>)[k], `${path}.${k}`, out);
    }
  }
  return out;
}

/** strict schema + semantic checks; `extra` = per-character vocabulary (a character may only use its own actions/faces) */
export function validateNarratedStoryboard(raw: unknown, ids: VocabIds, perCharacter?: Record<string, { actions: readonly string[]; expressions: readonly string[] }>): { ok: true; value: NarratedStoryboard } | { ok: false; issues: Issue[] } {
  const bad = forbiddenKeyPaths(raw);
  if (bad.length) return { ok: false, issues: bad.map((p) => ({ path: p, message: 'forbidden key' })) };
  const r = narratedStoryboardSchema(ids).parse(raw);
  if (!r.ok) return r;
  const sb = r.value, issues: Issue[] = [], D = sb.audio.durationSeconds;
  let prevEnd = 0;
  sb.script.phrases.forEach((p, i) => {
    const at = `$.script.phrases[${i}]`;
    if (p.id !== `p${String(i + 1).padStart(2, '0')}`) issues.push({ path: `${at}.id`, message: 'phrase ids must be sequential' });
    if (!(p.end > p.start)) issues.push({ path: at, message: 'phrase end must be after start' });
    if (p.start < prevEnd - 1e-9) issues.push({ path: at, message: 'phrase overlaps the previous phrase' });
    if (p.end > D + 1e-9) issues.push({ path: at, message: 'phrase ends after the audio' });
    if (!p.caption.lines.join('').trim()) issues.push({ path: `${at}.caption`, message: 'empty caption' });
    if (p.supportingCharacter && p.supportingCharacter === p.actor) issues.push({ path: `${at}.supportingCharacter`, message: 'supporting character must differ from the actor' });
    if (!sb.characters.includes(p.actor) || (p.supportingCharacter && !sb.characters.includes(p.supportingCharacter))) issues.push({ path: at, message: 'character not selected for this storyboard' });
    const c = perCharacter?.[p.actor];
    if (c && !c.actions.includes(p.semanticAction)) issues.push({ path: `${at}.semanticAction`, message: `${p.actor} cannot perform ${p.semanticAction}` });
    if (c && !c.expressions.includes(p.expression)) issues.push({ path: `${at}.expression`, message: `${p.actor} has no ${p.expression} face` });
    const s = p.supportingCharacter ? perCharacter?.[p.supportingCharacter] : undefined;
    if (s && p.supportingExpression && !s.expressions.includes(p.supportingExpression)) issues.push({ path: `${at}.supportingExpression`, message: `${p.supportingCharacter} has no ${p.supportingExpression} face` });
    prevEnd = p.end;
  });
  if (sb.timeline.length !== sb.script.phrases.length) issues.push({ path: '$.timeline', message: 'one beat per phrase' });
  sb.timeline.forEach((t, i) => {
    const p = sb.script.phrases[i];
    if (!p || t.phraseId !== p.id || t.start !== p.start || t.end !== p.end || t.cameraPreset !== p.cameraPreset || t.actor !== p.actor || t.semanticAction !== p.semanticAction) issues.push({ path: `$.timeline[${i}]`, message: 'timeline beat does not match its phrase' });
    if (t.start < 0 || t.end > D + 1e-9) issues.push({ path: `$.timeline[${i}]`, message: 'timeline outside the audio duration' });
  });
  if (sb.alignment.phraseCount !== sb.script.phrases.length) issues.push({ path: '$.alignment.phraseCount', message: 'phrase count mismatch' });
  return issues.length ? { ok: false, issues } : { ok: true, value: sb };
}
