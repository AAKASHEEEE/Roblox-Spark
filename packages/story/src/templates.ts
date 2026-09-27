// The four constrained comedy engines. A model fills template SLOTS; it never invents plot structure.
import type { Engine, Slot } from './schemas.ts';

export interface SlotSpec {
  slot: Slot;
  /** which role performs the slot's main action */
  role: 'protagonist' | 'foil' | 'victim' | 'none' | 'noob' | 'smart';
  allowedActions: string[];
  defaultAction: string;
  /** allowed prop effects in this slot */
  effects: string[];
  /** preferred camera presets, best first */
  shots: string[];
  duration: [number, number];
  infoChange: boolean;
  /** this slot is a reaction beat (must show a face change) */
  reaction: boolean;
  intent: 'hook' | 'setup' | 'temptation' | 'cause' | 'effect' | 'celebrate' | 'escalate' | 'climax' | 'reversal' | 'payoff' | 'loop';
}

export const SLOT_SPECS: Record<Slot, SlotSpec> = {
  premise: { slot: 'premise', role: 'none', allowedActions: ['none'], defaultAction: 'none', effects: ['flash'], shots: ['prop_ecu'], duration: [0.9, 1.3], infoChange: true, reaction: false, intent: 'hook' },
  notice: { slot: 'notice', role: 'protagonist', allowedActions: ['look_at', 'curious_lean', 'point', 'turn_toward'], defaultAction: 'look_at', effects: ['none'], shots: ['frontal_medium', 'reaction_punch_in'], duration: [1.0, 1.6], infoChange: true, reaction: true, intent: 'setup' },
  foil_notice: { slot: 'foil_notice', role: 'foil', allowedActions: ['look_at', 'point', 'turn_toward', 'shock_recoil'], defaultAction: 'look_at', effects: ['none'], shots: ['frontal_medium', 'reaction_punch_in'], duration: [0.9, 1.3], infoChange: true, reaction: true, intent: 'setup' },
  warn: { slot: 'warn', role: 'foil', allowedActions: ['arms_crossed', 'head_shake', 'point'], defaultAction: 'arms_crossed', effects: ['none'], shots: ['reaction_punch_in', 'two_shot'], duration: [0.9, 1.3], infoChange: true, reaction: true, intent: 'temptation' },
  race: { slot: 'race', role: 'protagonist', allowedActions: ['run', 'chase'], defaultAction: 'run', effects: ['none'], shots: ['wide_environment'], duration: [1.2, 1.8], infoChange: true, reaction: false, intent: 'setup' },
  attempt_fail: { slot: 'attempt_fail', role: 'protagonist', allowedActions: ['press_button'], defaultAction: 'press_button', effects: ['press'], shots: ['prop_ecu', 'frontal_medium'], duration: [1.3, 1.8], infoChange: true, reaction: true, intent: 'cause' },
  press_reward: { slot: 'press_reward', role: 'protagonist', allowedActions: ['press_button'], defaultAction: 'press_button', effects: ['spawn'], shots: ['prop_ecu'], duration: [1.1, 1.5], infoChange: true, reaction: false, intent: 'cause' },
  reward_reveal: { slot: 'reward_reveal', role: 'foil', allowedActions: ['look_at', 'shock_recoil'], defaultAction: 'look_at', effects: ['spin'], shots: ['top_down_insert'], duration: [0.9, 1.4], infoChange: true, reaction: true, intent: 'effect' },
  celebrate: { slot: 'celebrate', role: 'protagonist', allowedActions: ['victory_pose', 'jump', 'laugh'], defaultAction: 'victory_pose', effects: ['none'], shots: ['two_shot'], duration: [1.1, 1.6], infoChange: true, reaction: true, intent: 'celebrate' },
  smart_attempt: { slot: 'smart_attempt', role: 'smart', allowedActions: ['press_button'], defaultAction: 'press_button', effects: ['grow'], shots: ['prop_ecu', 'reaction_punch_in'], duration: [3.2, 3.8], infoChange: true, reaction: true, intent: 'cause' },
  escalate: { slot: 'escalate', role: 'none', allowedActions: ['none'], defaultAction: 'none', effects: ['grow'], shots: ['low_angle_reveal'], duration: [1.1, 1.6], infoChange: true, reaction: true, intent: 'escalate' },
  leap: { slot: 'leap', role: 'none', allowedActions: ['none'], defaultAction: 'none', effects: ['hop'], shots: ['wide_environment'], duration: [1.3, 1.8], infoChange: true, reaction: true, intent: 'escalate' },
  threat: { slot: 'threat', role: 'victim', allowedActions: ['look_at', 'run', 'cower'], defaultAction: 'run', effects: ['wobble'], shots: ['reaction_punch_in', 'low_angle_reveal'], duration: [2.0, 2.8], infoChange: true, reaction: true, intent: 'climax' },
  instant_loss: { slot: 'instant_loss', role: 'none', allowedActions: ['none'], defaultAction: 'none', effects: ['grow', 'hop'], shots: ['low_angle_reveal', 'wide_environment'], duration: [1.8, 2.4], infoChange: true, reaction: true, intent: 'escalate' },
  reversal: { slot: 'reversal', role: 'victim', allowedActions: ['dive_prone'], defaultAction: 'dive_prone', effects: ['tip_over'], shots: ['wide_environment'], duration: [2.2, 2.4], infoChange: true, reaction: true, intent: 'reversal' },
  payoff: { slot: 'payoff', role: 'victim', allowedActions: ['regret_freeze', 'none'], defaultAction: 'none', effects: ['none'], shots: ['reaction_punch_in'], duration: [0.9, 1.1], infoChange: true, reaction: true, intent: 'payoff' },
  loop: { slot: 'loop', role: 'none', allowedActions: ['none'], defaultAction: 'none', effects: ['reset', 'flash'], shots: ['final_loop'], duration: [1.0, 1.2], infoChange: true, reaction: false, intent: 'loop' },
};

export interface TemplateSpec {
  engine: Engine;
  title: string;
  structure: string;
  /** ordered grammar: [slot, min occurrences, max occurrences] */
  grammar: Array<[Slot, number, number]>;
  beats: [number, number];
  /** required causal links: result slot <- cause slot */
  causal: Array<[Slot, Slot]>;
  /** who ends up under the prop */
  victimRole: 'protagonist' | 'smart';
  requiredRoles: string[];
  reversal: string;
  loop: string;
  compatibleAssets: { characters: string[]; props: string[]; environment: string };
}

const ASSETS = { characters: ['zapp', 'kira'], props: ['suspicious_button', 'spark_coin', 'student_desk'], environment: 'classroom' };

export const TEMPLATES: Record<Engine, TemplateSpec> = {
  ordinary_object_extreme: {
    engine: 'ordinary_object_extreme', title: 'Ordinary object vs extreme result',
    structure: 'familiar object -> small interaction -> impossible escalation -> character briefly thinks they won -> object creates the final reversal',
    grammar: [['premise', 1, 1], ['notice', 1, 1], ['warn', 0, 1], ['press_reward', 1, 1], ['reward_reveal', 0, 1], ['celebrate', 1, 1], ['escalate', 1, 1], ['leap', 1, 1], ['threat', 1, 1], ['reversal', 1, 1], ['payoff', 1, 1], ['loop', 1, 1]],
    beats: [10, 12], causal: [['press_reward', 'notice'], ['celebrate', 'press_reward'], ['escalate', 'press_reward'], ['leap', 'escalate'], ['reversal', 'leap'], ['payoff', 'reversal']],
    victimRole: 'protagonist', requiredRoles: ['protagonist', 'foil'], reversal: 'the grown prop topples onto the protagonist in the final 3 s', loop: 'button resets and flashes; final shot re-frames the opening prop close-up', compatibleAssets: ASSETS,
  },
  visible_secret_chase: {
    engine: 'visible_secret_chase', title: 'Visible secret -> chase -> ironic consequence',
    structure: 'character spots a desirable hidden object -> another character also wants it -> race -> winner reaches the goal -> the goal causes the loss',
    grammar: [['premise', 1, 1], ['notice', 1, 1], ['foil_notice', 1, 1], ['race', 1, 1], ['press_reward', 1, 1], ['celebrate', 1, 1], ['escalate', 1, 1], ['leap', 1, 1], ['threat', 0, 1], ['reversal', 1, 1], ['payoff', 1, 1], ['loop', 1, 1]],
    beats: [11, 12], causal: [['foil_notice', 'notice'], ['race', 'foil_notice'], ['press_reward', 'race'], ['escalate', 'press_reward'], ['leap', 'escalate'], ['reversal', 'leap'], ['payoff', 'reversal']],
    victimRole: 'protagonist', requiredRoles: ['protagonist', 'foil'], reversal: 'the race winner is flattened by the prize', loop: 'button resets for the next racer', compatibleAssets: ASSETS,
  },
  apparent_win_instant_loss: {
    engine: 'apparent_win_instant_loss', title: 'Apparent win -> instant loss',
    structure: 'clear goal -> attempt(s) fail -> attempt succeeds -> apparent victory -> immediate visual reversal -> regret -> loop trigger',
    grammar: [['premise', 1, 1], ['notice', 1, 1], ['warn', 0, 1], ['attempt_fail', 1, 2], ['press_reward', 1, 1], ['celebrate', 1, 1], ['instant_loss', 1, 1], ['reversal', 1, 1], ['payoff', 1, 1], ['loop', 1, 1]],
    beats: [9, 11], causal: [['attempt_fail', 'notice'], ['press_reward', 'attempt_fail'], ['celebrate', 'press_reward'], ['instant_loss', 'celebrate'], ['reversal', 'instant_loss'], ['payoff', 'reversal']],
    victimRole: 'protagonist', requiredRoles: ['protagonist', 'foil'], reversal: 'the prize instantly becomes giant and flattens the winner', loop: 'button resets and flashes', compatibleAssets: ASSETS,
  },
  noob_vs_smart: {
    engine: 'noob_vs_smart', title: 'Noob solution vs smart solution',
    structure: 'same visible problem -> first character uses the obvious approach (small win) -> second character uses the "superior" approach -> superior approach creates the larger failure',
    grammar: [['premise', 1, 1], ['notice', 1, 1], ['press_reward', 1, 1], ['celebrate', 1, 1], ['smart_attempt', 1, 1], ['escalate', 1, 1], ['leap', 1, 1], ['threat', 0, 1], ['reversal', 1, 1], ['payoff', 1, 1], ['loop', 1, 1]],
    beats: [10, 11], causal: [['press_reward', 'notice'], ['celebrate', 'press_reward'], ['smart_attempt', 'celebrate'], ['escalate', 'smart_attempt'], ['leap', 'escalate'], ['reversal', 'leap'], ['payoff', 'reversal']],
    victimRole: 'smart', requiredRoles: ['noob (protagonist)', 'smart (foil)'], reversal: 'the smart approach makes the prop giant and it topples onto the smart character', loop: 'button resets and flashes', compatibleAssets: ASSETS,
  },
};

/** Validate a slot sequence against a template grammar. Returns error messages (empty = ok). */
export function checkGrammar(engine: Engine, slots: Slot[]): string[] {
  const t = TEMPLATES[engine];
  const errs: string[] = [];
  let i = 0;
  for (const [slot, min, max] of t.grammar) {
    let n = 0;
    while (i < slots.length && slots[i] === slot && n < max) { i++; n++; }
    if (n < min) errs.push(`slot "${slot}" required ${min}x at position ${i + 1}, found ${n}`);
  }
  if (i < slots.length) errs.push(`unexpected slot "${slots[i]}" at position ${i + 1} (template order: ${t.grammar.map((g) => g[0]).join(' > ')})`);
  if (slots.length < t.beats[0] || slots.length > t.beats[1]) errs.push(`${slots.length} beats; ${engine} allows ${t.beats[0]}-${t.beats[1]}`);
  return errs;
}
