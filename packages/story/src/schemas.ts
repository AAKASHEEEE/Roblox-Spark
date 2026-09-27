// Strict schemas for every generation stage. Model output is DATA ONLY and must pass these before use.
// Schemas are built from the live capability registry so enums always equal what the engine can render.
import { v, type SchemaT } from '../../schema/src/v.ts';
import { ACTIONS, EXPRESSIONS, CAMERA_PRESETS } from '../../schema/src/episode.ts';
import { MOTION_PROFILE_IDS } from '../../schema/src/render-compat.ts';

export const ENGINES = ['ordinary_object_extreme', 'visible_secret_chase', 'apparent_win_instant_loss', 'noob_vs_smart'] as const;
export type Engine = (typeof ENGINES)[number];

export const SLOTS = [
  'premise', 'notice', 'foil_notice', 'warn', 'race', 'attempt_fail', 'press_reward', 'reward_reveal', 'celebrate',
  'smart_attempt', 'escalate', 'leap', 'threat', 'instant_loss', 'reversal', 'payoff', 'loop',
] as const;
export type Slot = (typeof SLOTS)[number];

export const PROP_EFFECTS = ['flash', 'press', 'spawn', 'spin', 'stand_up', 'grow', 'hop', 'wobble', 'tip_over', 'reset', 'none'] as const;
export const MAGNITUDES = ['small', 'big', 'huge', 'giant'] as const;
export const EMOTES = ['?', '!', '...'] as const;
export const SAFETY_CLASSES = ['safe', 'unsafe', 'protected_ip', 'ip_transformed'] as const;
export const SAFETY_CATEGORIES = ['violence', 'weapon', 'sexual', 'drugs_alcohol', 'dangerous_imitation', 'self_harm', 'real_money_giveaway', 'platform_currency', 'cruelty', 'protected_character', 'protected_brand', 'real_person'] as const;
export const REJECT_CATEGORIES = ['unsafe', 'protected_ip', 'unavailable', 'impossible', 'requires_dialogue', 'requires_text', 'duration', 'provider_failure'] as const;
export type RejectCategory = (typeof REJECT_CATEGORIES)[number];

export const StoryRequestSchema = v.object({
  idea: v.string({ min: 1, max: 400 }),
  durationTarget: v.number({ min: 14, max: 22 }),
  comedyEngine: v.enum(ENGINES).nullable(),
  seed: v.int({ min: 0, max: 2 ** 31 - 1 }),
  /** motion profile declared by the generated episode; absent => DEFAULT_MOTION_PROFILE (render-compat.ts) */
  motionProfile: v.enum(MOTION_PROFILE_IDS).optional(),
});
export type StoryRequest = SchemaT<typeof StoryRequestSchema>;

export interface RegistrySummaryForSchema { characters: string[]; props: string[]; environments: string[]; /** actions AVAILABLE to the generator (unavailable ones are not offered) */ actions?: string[] }

/** Stage A output. `id` fields are registry ids; `mention` is the raw words from the idea (for substitution audit). */
export function normalizedIdeaSchema(r: RegistrySummaryForSchema) {
  const binding = (ids: string[]) => v.object({ id: v.enum(ids as unknown as readonly string[]).nullable(), mention: v.string({ max: 60 }) });
  return v.object({
    engine: v.enum(ENGINES),
    protagonist: binding(r.characters),
    support: binding(r.characters),
    environment: binding(r.environments),
    causalProp: binding(r.props),
    escalationProp: binding(r.props),
    initialSituation: v.string({ min: 1, max: 200 }),
    goal: v.string({ min: 1, max: 200 }),
    escalation: v.string({ min: 1, max: 200 }),
    reversal: v.object({ kind: v.enum(['topple_onto'] as const), victim: v.enum(['protagonist', 'support'] as const), description: v.string({ min: 1, max: 200 }) }),
    loopMechanism: v.enum(['button_resets'] as const),
    requested: v.object({
      characters: v.array(v.string({ max: 40 }), { max: 8 }), props: v.array(v.string({ max: 40 }), { max: 8 }),
      places: v.array(v.string({ max: 40 }), { max: 4 }), actions: v.array(v.string({ max: 40 }), { max: 12 }),
    }),
    substitutions: v.array(v.object({ requested: v.string({ max: 60 }), used: v.string({ max: 60 }), kind: v.enum(['character', 'prop', 'place', 'action', 'mechanism', 'brand'] as const), reason: v.string({ max: 200 }) }), { max: 12 }),
    requiresDialogue: v.boolean(),
    requiresReadableText: v.boolean(),
    safety: v.object({ classification: v.enum(SAFETY_CLASSES), categories: v.array(v.enum(SAFETY_CATEGORIES), { max: 6 }), notes: v.string({ max: 300 }) }),
    rejection: v.object({ category: v.enum(REJECT_CATEGORIES), reason: v.string({ min: 1, max: 300 }) }).nullable(),
  });
}
export type NormalizedIdea = SchemaT<ReturnType<typeof normalizedIdeaSchema>>;

export function beatPlanSchema(r: RegistrySummaryForSchema) {
  const chars = r.characters as unknown as readonly string[];
  const ref = v.string({ pattern: /^[a-z][a-z0-9_-]*(\.[a-z0-9_]+)?$/, max: 80 });
  return v.object({
    engine: v.enum(ENGINES),
    title: v.string({ min: 1, max: 60 }),
    logline: v.string({ min: 1, max: 240 }),
    roles: v.object({ protagonist: v.enum(chars), foil: v.enum(chars), victim: v.enum(chars) }),
    /** staging layout variant (0 = standard); repairs may switch it to resolve collisions/framing */
    stagingVariant: v.int({ min: 0, max: 2 }),
    beats: v.array(v.object({
      id: v.string({ pattern: /^b\d{2}$/ }),
      slot: v.enum(SLOTS),
      purpose: v.string({ min: 1, max: 160 }),
      visibleChange: v.string({ min: 1, max: 160 }),
      actor: v.enum([...chars, 'none'] as unknown as readonly string[]),
      action: v.enum([...(r.actions ?? ACTIONS), 'none'] as unknown as readonly string[]),
      target: ref.nullable(),
      propEffect: v.object({ prop: v.enum(['button', 'coin', 'desk'] as const), effect: v.enum(PROP_EFFECTS), magnitude: v.enum(MAGNITUDES).nullable() }).nullable(),
      expressionBefore: v.enum(EXPRESSIONS).nullable(),
      expressionAfter: v.enum(EXPRESSIONS).nullable(),
      reactor: v.object({ actor: v.enum(chars), action: v.enum([...(r.actions ?? ACTIONS), 'none'] as unknown as readonly string[]), expression: v.enum(EXPRESSIONS).nullable() }).nullable(),
      emote: v.enum(EMOTES).nullable(),
      viewerInference: v.string({ min: 1, max: 160 }),
      approxDuration: v.number({ min: 0.4, max: 4 }),
      causeBeatId: v.string({ pattern: /^b\d{2}$/ }).nullable(),
      resultBeatId: v.string({ pattern: /^b\d{2}$/ }).nullable(),
      shotHint: v.enum(CAMERA_PRESETS).nullable(),
    }), { min: 7, max: 12 }),
  });
}
export type VisualBeatPlan = SchemaT<ReturnType<typeof beatPlanSchema>>;
export type PlanBeat = VisualBeatPlan['beats'][number];

export const PATCH_FIELDS = ['shotHint', 'action', 'target', 'expressionAfter', 'expressionBefore', 'emote', 'approxDuration', 'reactor', 'causeBeatId', 'resultBeatId', 'propEffect', 'actor'] as const;
export const RepairResponseSchema = v.object({
  patches: v.array(v.discriminated<unknown>('op', {
    set: v.object({ op: v.literal('set'), beatId: v.string({ pattern: /^b\d{2}$/ }), field: v.enum(PATCH_FIELDS), value: v.union<unknown>(v.string({ max: 80 }), v.number(), v.looseObject({}), v.literal(true).nullable()) }),
    remove_beat: v.object({ op: v.literal('remove_beat'), beatId: v.string({ pattern: /^b\d{2}$/ }) }),
    set_role: v.object({ op: v.literal('set_role'), role: v.enum(['victim'] as const), value: v.string({ max: 40 }) }),
    set_plan: v.object({ op: v.literal('set_plan'), field: v.enum(['stagingVariant'] as const), value: v.int({ min: 0, max: 2 }) }),
  }), { max: 24 }),
  notes: v.string({ max: 400 }),
});
export type RepairResponse = SchemaT<typeof RepairResponseSchema>;
export type Patch = { op: 'set'; beatId: string; field: (typeof PATCH_FIELDS)[number]; value: unknown } | { op: 'remove_beat'; beatId: string } | { op: 'set_role'; role: 'victim'; value: string } | { op: 'set_plan'; field: 'stagingVariant'; value: number };

/** Structured repair constraint produced from validator / gate failures. */
export interface RepairConstraint {
  code: string;
  message: string;
  beatId: string | null;
  field: string | null;
  /** allowed replacement values when known (closed list) */
  allowed?: unknown[];
  /** values that must not be used */
  disallow?: unknown[];
  source: 'schema' | 'compatibility' | 'compiler' | 'validator' | 'analysis' | 'story_gate';
}
