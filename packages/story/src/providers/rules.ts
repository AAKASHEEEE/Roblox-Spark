// OFFLINE `rules` provider — a deterministic, seeded, keyword-driven template slot filler.
// It is NOT a language model. It exists so the pipeline (schemas, compiler, validators, repair loop) can be measured
// without network access, and as a dependency-free fallback. Its understanding of free text is shallow by design.
import { hashSeed, rng } from '../../../engine/src/math.ts';
import { scanIdea, type IdeaScan } from '../lexicon.ts';
import { EMOTION_FACE } from '../registry.ts';
import { SLOT_SPECS, TEMPLATES } from '../templates.ts';
import type { Engine, NormalizedIdea, Patch, PlanBeat, RepairConstraint, Slot, VisualBeatPlan } from '../schemas.ts';
import type { CallMeta, NormalizeInput, PlanInput, RepairInput, StoryModelProvider } from './types.ts';
import { rankRejections } from '../schemas.ts';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const NAME: Record<string, string> = { zapp: 'Zapp', kira: 'Kira' };
const face = (actor: string, emotion: string) => EMOTION_FACE[actor]?.[emotion] ?? null;

function pickEngine(scan: IdeaScan): Engine {
  const m = scan.mech;
  if (m.noobSmart) return 'noob_vs_smart';
  if (m.race) return 'visible_secret_chase';
  if (m.repeat || (m.win && m.instant)) return 'apparent_win_instant_loss';
  return 'ordinary_object_extreme';
}

/** clause subjects: split on ; . and "but/then" and find the first cast-like mention in each clause */
function clauseSubjects(scan: IdeaScan): Array<{ clause: string; start: number; subject?: IdeaScan['characters'][number] }> {
  const t = ' ' + scan.text.toLowerCase() + ' ';
  const out: Array<{ clause: string; start: number; subject?: IdeaScan['characters'][number] }> = [];
  let start = 0;
  const re = /[;.]|,? but |,? then /g;
  let m: RegExpExecArray | null;
  const cuts: number[] = [];
  while ((m = re.exec(t))) cuts.push(m.index);
  cuts.push(t.length);
  for (const c of cuts) {
    const clause = t.slice(start, c);
    const subject = scan.characters.find((ch) => ch.index >= start && ch.index < c && ch.kind !== 'non_human');
    if (clause.trim()) out.push({ clause, start, subject });
    start = c + 1;
  }
  return out;
}

export class RulesProvider implements StoryModelProvider {
  readonly name = 'rules';
  readonly model = 'rules-v1 (deterministic keyword slot-filler, not an LLM)';
  private meta: CallMeta | null = null;
  lastCall(): CallMeta | null { return this.meta; }
  private done(stage: string, t0: number): void { this.meta = { stage, ms: performance.now() - t0, tokensIn: 0, tokensOut: 0, ok: true, model: this.model, attempts: 1 }; }

  async normalizeIdea(input: NormalizeInput): Promise<unknown> {
    const t0 = performance.now();
    const out = this.normalize(input);
    this.done('normalize', t0);
    return out;
  }

  private normalize({ request }: NormalizeInput): NormalizedIdea {
    const scan = scanIdea(request.idea);
    const m = scan.mech;
    const subs: NormalizedIdea['substitutions'] = [];
    // every reason is recorded; the PRIMARY category is the first found in this fixed order (safety, IP, cast, mechanisms,
    // objects, text) and is never re-ranked to match an expected label (bench metric m07b is strict, m07f secondary)
    const reasons: Array<{ category: NonNullable<NormalizedIdea['rejection']>['category']; reason: string }> = [];
    const reject = (category: NonNullable<NormalizedIdea['rejection']>['category'], reason: string) => { if (!reasons.some((r) => r.category === category && r.reason === reason)) reasons.push({ category, reason: reason.slice(0, 300) }); };
    // ---- safety + IP ----
    const cats = [...new Set(scan.safety.map((s) => s.category))];
    const centralIp = scan.ip.filter((x) => !x.styleQualified);
    const styleIp = scan.ip.filter((x) => x.styleQualified);
    let classification: NormalizedIdea['safety']['classification'] = 'safe';
    const safetyCats: string[] = [...cats];
    if (cats.length) { classification = 'unsafe'; reject('unsafe', `unsafe content (${scan.safety.map((s) => `${s.category}: "${s.term}"`).join(', ')})`); }
    else if (centralIp.length) { classification = 'protected_ip'; safetyCats.push(...new Set(centralIp.map((x) => x.kind))); reject('protected_ip', `idea depends on protected IP (${centralIp.map((x) => x.name).join(', ')}); original cast only`); }
    else if (styleIp.length) { classification = 'ip_transformed'; safetyCats.push(...new Set(styleIp.map((x) => x.kind))); for (const x of styleIp) subs.push({ requested: `${x.name} reference`, used: 'original BlockSpark style', kind: 'brand', reason: 'protected brand/person used only as a style reference: removed' }); }
    // ---- characters ----
    const humans = scan.characters.filter((c) => c.kind !== 'non_human');
    const nonHuman = scan.characters.filter((c) => c.kind === 'non_human');
    if (scan.characters.some((c) => c.canon === 'BZTT')) reject('unavailable', 'BZTT (floating robot) is not built yet (floating_orb_v1 rig missing) and may never be replaced by a human character (identity lock)');
    if (nonHuman.length) reject('unavailable', `no rig for non-human character(s): ${nonHuman.map((c) => c.mention).join(', ')}`);
    // ---- unsupported mechanisms ----
    if (m.shrink) reject('impossible', 'shrinking a character or prop to nothing is not a registered effect');
    if (m.fly) reject('impossible', 'flight is not supported (no flying rig or flight-path effect)');
    if (m.teleport) reject('impossible', 'vanishing/teleporting is not supported (and violates the no-teleport rule)');
    if (m.transform) reject('impossible', 'transforming one object into another is a forbidden morph');
    if (m.explode || m.fire) reject('impossible', 'explosions/fire are not registered effects');
    if (m.sleep) reject('impossible', 'sleeping is not a registered action');
    // ---- objects ----
    const unavailable = scan.objects.filter((o) => o.kind === 'unavailable');
    const registered = scan.objects.filter((o) => o.kind !== 'unavailable');
    const trigger = registered.find((o) => o.kind === 'trigger');
    const collectible = registered.find((o) => o.kind === 'collectible');
    if (unavailable.length && (!trigger && !collectible || m.carry || m.throw || m.eat || m.tool || m.fix)) {
      reject('unavailable', `requires unregistered prop(s): ${unavailable.map((o) => o.mention).join(', ')} (no safe same-class substitute)`);
    } else for (const u of unavailable) subs.push({ requested: u.mention, used: '(dropped)', kind: 'prop', reason: 'incidental unregistered object removed; causal chain uses registered props' });
    if (m.needsText) reject('requires_text', 'the joke depends on reading text on screen; stories must read without text');
    if (m.speech) subs.push({ requested: 'spoken line', used: 'emote + expression', kind: 'action', reason: 'no dialogue: speech is conveyed with an emote and facial expression' });
    if (trigger && !['button', 'buttons'].includes(trigger.mention)) subs.push({ requested: trigger.mention, used: 'suspicious_button', kind: 'prop', reason: 'same affordance class (trigger device)' });
    if (!trigger) subs.push({ requested: '(no trigger)', used: 'suspicious_button', kind: 'prop', reason: 'structure adaptation: the only loopable reward source is the FREE COINS button' });
    for (const c of registered.filter((o) => o.kind === 'collectible')) if (!['coin', 'coins'].includes(c.mention)) subs.push({ requested: c.mention, used: 'spark_coin', kind: 'prop', reason: 'same affordance class (collectible reward)' });
    if (m.carry) subs.push({ requested: 'carry/steal the object', used: 'reach it first', kind: 'action', reason: 'engine v1 has no prop attachment; carrying is simplified to reaching/pressing' });
    if (m.collide) subs.push({ requested: 'character contact/collision', used: 'arrival order', kind: 'action', reason: 'characters never interpenetrate; contact resolved as who arrives first' });
    if (m.dance) subs.push({ requested: 'dance', used: 'victory_pose', kind: 'action', reason: 'closest registered action' });
    if (/(backflip|cartwheel|onto the desk|on the desk)/.test(scan.text.toLowerCase()) && m.jump) subs.push({ requested: 'jump onto/over furniture', used: 'jump in place', kind: 'action', reason: 'jump is in place only' });
    if (m.multiply) subs.push({ requested: 'multiplying objects', used: 'one growing coin', kind: 'mechanism', reason: 'one escalating prop instance per episode' });
    // ---- places ----
    for (const p of scan.places.filter((p) => p.kind !== 'classroom')) subs.push({ requested: p.mention, used: 'classroom', kind: 'place', reason: p.kind === 'school' ? 'only built environment (same school)' : 'only built environment; location is incidental to the gag' });
    // ---- roles ----
    const engine: Engine = request.comedyEngine ?? pickEngine(scan);
    const cast = humans.map((c) => ({ c, id: c.id }));
    const usedIds = new Set(cast.filter((x) => x.id).map((x) => x.id!));
    const mapUnbuilt = (c: IdeaScan['characters'][number]): string => {
      const free = ['zapp', 'kira'].find((k) => !usedIds.has(k)) ?? 'kira';
      usedIds.add(free);
      if (c.kind === 'unbuilt_cast') subs.push({ requested: c.canon ?? c.mention, used: free, kind: 'character', reason: `${c.canon ?? c.mention} is not built yet; role played by locked character ${free}` });
      return free;
    };
    const idOf = (c?: IdeaScan['characters'][number]): string | undefined => (!c ? undefined : c.id ?? mapUnbuilt(c));
    let protagonist: string | undefined, support: string | undefined;
    const warnM = /(\w+) warns? (\w+)/.exec(scan.text.toLowerCase());
    if (engine === 'noob_vs_smart') {
      const cl = clauseSubjects(scan);
      const smartCue = /(smart|pro\b|genius|clever|twice|double|better|properly|expert|calmly|show)/;
      const smartClause = cl.find((x) => smartCue.test(x.clause) && x.subject);
      const noobClause = cl.find((x) => x.subject && x !== smartClause);
      protagonist = idOf(noobClause?.subject);
      support = idOf(smartClause?.subject);
    } else if (warnM && humans.length >= 2) {
      const a = humans.find((h) => h.mention === warnM[1]), b = humans.find((h) => h.mention === warnM[2]);
      protagonist = idOf(b); support = idOf(a);
    }
    protagonist ??= idOf(humans.find((h) => h.kind !== 'generic_human') ?? humans[0]) ?? 'zapp';
    if (!support || support === protagonist) support = protagonist === 'zapp' ? 'kira' : 'zapp';
    const protagonistMention = humans.find((h) => (h.id ?? '') === protagonist)?.mention ?? (humans[0]?.mention ?? '(default)');
    // victim: template default, unless the idea puts the support character in the landing zone
    let victim: 'protagonist' | 'support' = engine === 'noob_vs_smart' ? 'support' : 'protagonist';
    if (m.landingZone) {
      const t = scan.text.toLowerCase();
      const lz = t.search(/where the coin lands|in the way|right under|stands? (right )?where/);
      const near = humans.filter((h) => h.index < lz).pop();
      if (near && idOf(near) === support) victim = 'support';
    }
    return {
      engine,
      protagonist: { id: protagonist, mention: protagonistMention },
      support: { id: support, mention: humans.find((h) => (h.id ?? '') === support)?.mention ?? '(default)' },
      environment: { id: 'classroom', mention: scan.places[0]?.mention ?? '(default)' },
      causalProp: { id: 'suspicious_button', mention: trigger?.mention ?? '(added)' },
      escalationProp: { id: 'spark_coin', mention: collectible?.mention ?? '(added)' },
      initialSituation: `A suspicious FREE COINS button flashes on a classroom desk; ${NAME[protagonist]} is nearby.`,
      goal: engine === 'noob_vs_smart' ? `${NAME[support]} wants to out-do ${NAME[protagonist]}'s simple win.` : `${NAME[protagonist]} wants the reward.`,
      escalation: 'The reward coin grows far beyond reason.',
      reversal: { kind: 'topple_onto', victim, description: `The giant coin topples onto ${NAME[victim === 'protagonist' ? protagonist : support]}.` },
      loopMechanism: 'button_resets',
      requested: { characters: scan.characters.map((c) => c.mention), props: scan.objects.map((o) => o.mention), places: scan.places.map((p) => p.mention), actions: Object.entries(m).filter(([, v]) => v).map(([k]) => k) },
      substitutions: subs.slice(0, 12),
      requiresDialogue: false,
      requiresReadableText: !!m.needsText,
      safety: { classification, categories: [...new Set(safetyCats)].slice(0, 6) as NormalizedIdea['safety']['categories'], notes: scan.safety.length || scan.ip.length ? `scan: ${[...scan.safety.map((s) => s.term), ...scan.ip.map((x) => x.name)].join(', ')}` : 'no unsafe or protected terms found' },
      // ranked by REJECT_PRECEDENCE (unsafe > protected IP > availability > story), stable within a class
      rejection: reasons.length ? ((rk) => ({ ...rk[0], ...(rk.length > 1 ? { also: rk.slice(1, 9) } : {}) }))(rankRejections(reasons)) : null,
    };
  }

  async planBeats(input: PlanInput): Promise<unknown> {
    const t0 = performance.now();
    const out = this.plan(input);
    this.done('plan', t0);
    return out;
  }

  private plan({ request, idea, template }: PlanInput): VisualBeatPlan {
    const r = rng((hashSeed(request.idea) ^ request.seed) >>> 0);
    const scan = scanIdea(request.idea);
    const P = idea.protagonist.id!, F = idea.support.id!;
    const V = idea.reversal.victim === 'protagonist' ? P : F;
    const O = V === P ? F : P;
    // choose slot sequence from the grammar
    const slots: Slot[] = [];
    for (const [slot, min, max] of template.grammar) {
      let n = min;
      if (max > min) {
        if (slot === 'warn') n = scan.mech.warn || r() < 0.5 ? 1 : 0;
        else if (slot === 'attempt_fail') n = scan.mech.repeat || r() < 0.5 ? 2 : 1;
        else if (slot === 'reward_reveal') n = r() < 0.6 ? 1 : 0;
        else if (slot === 'threat') n = r() < 0.6 ? 1 : 0;
        else n = min;
      }
      for (let i = 0; i < n; i++) slots.push(slot);
    }
    // respect the template beat-count window
    const optional: Slot[] = ['reward_reveal', 'warn', 'threat'];
    while (slots.length > template.beats[1]) { const k = slots.findIndex((s) => optional.includes(s)); if (k < 0) break; slots.splice(k, 1); }
    for (const s of optional) if (slots.length < template.beats[0] && template.grammar.some((g) => g[0] === s) && !slots.includes(s)) {
      const order = template.grammar.map((g) => g[0]); const pos = slots.findIndex((x) => order.indexOf(x) > order.indexOf(s));
      slots.splice(pos < 0 ? slots.length : pos, 0, s);
    }
    const id = (i: number) => `b${String(i + 1).padStart(2, '0')}`;
    const actorOf = (slot: Slot): string => {
      const role = SLOT_SPECS[slot].role;
      return role === 'protagonist' || role === 'noob' ? P : role === 'foil' || role === 'smart' ? F : role === 'victim' ? V : 'none';
    };
    const beats: PlanBeat[] = slots.map((slot, i) => {
      const spec = SLOT_SPECS[slot];
      const actor = actorOf(slot);
      const nm = NAME[actor] ?? '';
      const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
      let action = spec.defaultAction;
      if (slot === 'notice') action = pick(['look_at', 'curious_lean']);
      if (slot === 'celebrate') action = scan.mech.jump ? 'jump' : pick(['victory_pose', 'victory_pose', 'jump']);
      if (slot === 'attempt_fail') action = 'press_button';
      if (slot === 'threat') action = 'run';
      const b: PlanBeat = {
        id: id(i), slot, purpose: '', visibleChange: '', actor, action, target: null, propEffect: null,
        expressionBefore: null, expressionAfter: null, reactor: null, emote: null, viewerInference: '',
        approxDuration: +(spec.duration[0] + (spec.duration[1] - spec.duration[0]) * r()).toFixed(2),
        causeBeatId: null, resultBeatId: null, shotHint: r() < 0.25 && spec.shots.length > 1 ? spec.shots[1] as PlanBeat['shotHint'] : spec.shots[0] as PlanBeat['shotHint'],
      };
      const other = actor === P ? F : P;
      switch (slot) {
        case 'premise': Object.assign(b, { purpose: 'Hook: show the causal prop', visibleChange: 'A FREE COINS button flashes on a desk', propEffect: { prop: 'button', effect: 'flash', magnitude: null }, viewerInference: 'That button looks too good to be true.' }); break;
        case 'notice': Object.assign(b, { purpose: `${nm} notices the button`, visibleChange: `${nm} looks at the button, curious`, target: 'button', expressionBefore: face(actor, 'neutral'), expressionAfter: face(actor, 'curious'), emote: '?', viewerInference: `${nm} is tempted.` }); break;
        case 'foil_notice': Object.assign(b, { purpose: `${nm} spots it too`, visibleChange: `${nm} snaps toward the button`, target: 'button', expressionBefore: face(actor, 'neutral'), expressionAfter: face(actor, 'surprised'), emote: '!', viewerInference: 'Two people want the same thing.' }); break;
        case 'warn': Object.assign(b, { purpose: `${nm} warns against it`, visibleChange: `${nm} crosses arms and shakes head`, target: other, expressionBefore: face(actor, 'smug'), expressionAfter: face(actor, 'skeptical'), emote: '...', viewerInference: 'Pressing it is a bad idea.' }); break;
        case 'race': Object.assign(b, { purpose: 'Race to the button', visibleChange: `${nm} sprints to the desk, ${NAME[other]} chases`, target: 'press_spot', expressionBefore: face(actor, 'curious'), expressionAfter: face(actor, 'determined'), reactor: { actor: other, action: 'chase', expression: face(other, 'determined') }, viewerInference: 'Whoever gets there first wins... or does he?' }); break;
        case 'attempt_fail': Object.assign(b, { purpose: `${nm} presses; nothing comes out`, visibleChange: 'Button clicks, no coin', target: 'button.press_surface', propEffect: { prop: 'button', effect: 'press', magnitude: null }, expressionBefore: face(actor, 'determined'), expressionAfter: face(actor, 'regret'), emote: '...', reactor: { actor: other, action: 'none', expression: face(other, 'smug') }, viewerInference: 'It does not work... yet.' }); break;
        case 'press_reward': Object.assign(b, { purpose: `${nm} presses the button`, visibleChange: 'Hand hits the button; a coin pops out', target: 'button.press_surface', propEffect: { prop: 'coin', effect: 'spawn', magnitude: 'small' }, expressionBefore: face(actor, 'curious'), expressionAfter: face(actor, 'determined'), viewerInference: 'The press caused the coin.' }); break;
        case 'reward_reveal': Object.assign(b, { purpose: 'Exactly one coin', visibleChange: 'A single coin spins on the desk', target: 'coin', propEffect: { prop: 'coin', effect: 'spin', magnitude: 'small' }, expressionBefore: face(actor, 'skeptical'), expressionAfter: face(actor, 'surprised'), viewerInference: 'It actually worked.' }); break;
        case 'celebrate': Object.assign(b, { purpose: `${nm} celebrates`, visibleChange: `${nm} cheers`, expressionBefore: face(actor, 'determined'), expressionAfter: face(actor, 'happy'), reactor: { actor: other, action: 'arms_crossed', expression: face(other, 'smug') }, viewerInference: `${nm} thinks they won.` }); break;
        case 'smart_attempt': Object.assign(b, { purpose: `${nm} tries the "smart" way`, visibleChange: `${nm} takes over and double-presses`, target: 'button.press_surface', propEffect: { prop: 'coin', effect: 'grow', magnitude: 'big' }, expressionBefore: face(actor, 'smug'), expressionAfter: face(actor, 'surprised'), reactor: { actor: other, action: 'look_at', expression: face(other, 'curious') }, viewerInference: `${nm} thinks there is a better way.` }); break;
        case 'escalate': Object.assign(b, { purpose: 'The coin stands and grows', visibleChange: 'Coin stands up and doubles, twice', target: 'coin', propEffect: { prop: 'coin', effect: 'grow', magnitude: 'huge' }, reactor: { actor: V, action: 'shock_recoil', expression: face(V, 'shock') }, emote: '!', viewerInference: 'This is getting out of hand.' }); break;
        case 'leap': Object.assign(b, { purpose: 'It leaps and becomes enormous', visibleChange: 'Coin hops to the floor and fills the room', target: 'coin', propEffect: { prop: 'coin', effect: 'hop', magnitude: 'giant' }, reactor: { actor: O, action: 'run', expression: face(O, 'shock') }, emote: '!', viewerInference: 'Way too big now.' }); break;
        case 'threat': Object.assign(b, { purpose: `${nm} goes for the giant prize`, visibleChange: `${nm} rushes to the looming coin`, target: 'coin', propEffect: { prop: 'coin', effect: 'wobble', magnitude: null }, expressionBefore: face(actor, 'shock'), expressionAfter: face(actor, 'determined'), emote: '!', viewerInference: 'Greed beats common sense.' }); break;
        case 'instant_loss': Object.assign(b, { purpose: 'The prize instantly turns on its winner', visibleChange: 'Coin shoots up to giant size and leaps', target: 'coin', propEffect: { prop: 'coin', effect: 'grow', magnitude: 'giant' }, reactor: { actor: V, action: 'shock_recoil', expression: face(V, 'shock') }, emote: '!', viewerInference: 'That win lasted one second.' }); break;
        case 'reversal': Object.assign(b, { purpose: 'Reversal: the prize flattens its winner', visibleChange: 'Giant coin topples onto the victim', target: 'coin', propEffect: { prop: 'coin', effect: 'tip_over', magnitude: 'giant' }, expressionBefore: face(actor, 'shock'), expressionAfter: face(actor, 'regret'), reactor: { actor: O, action: 'laugh', expression: face(O, 'laugh') }, viewerInference: 'The reward was the trap.' }); break;
        case 'payoff': Object.assign(b, { purpose: 'Payoff: regret under the coin', visibleChange: `${nm}'s face pokes out from under the coin`, expressionBefore: face(actor, 'shock'), expressionAfter: face(actor, 'regret'), viewerInference: `${nm} regrets everything.` }); break;
        case 'loop': Object.assign(b, { purpose: 'Loop: the button resets for the next victim', visibleChange: 'The button flashes FREE COINS again', propEffect: { prop: 'button', effect: 'reset', magnitude: null }, viewerInference: 'It will happen again.' }); break;
      }
      return b;
    });
    // causal links from the template
    for (const [res, cause] of template.causal) {
      const rb = beats.find((b) => b.slot === res), cb = [...beats].reverse().find((b) => b.slot === cause && rb && b.id < rb.id);
      if (rb && cb) { rb.causeBeatId = cb.id; if (!cb.resultBeatId) cb.resultBeatId = rb.id; }
    }
    // scale durations toward the target
    const total = beats.reduce((a, b) => a + b.approxDuration, 0);
    const k = request.durationTarget / total;
    for (const b of beats) { const [lo, hi] = SLOT_SPECS[b.slot].duration; b.approxDuration = +Math.min(4, Math.max(0.4, Math.min(hi * 1.25, Math.max(lo * 0.9, b.approxDuration * k)))).toFixed(2); }
    const title = { ordinary_object_extreme: 'Too Many Coins', visible_secret_chase: 'Race For It', apparent_win_instant_loss: 'Winner Winner', noob_vs_smart: 'The Smart Way' }[template.engine];
    return { engine: template.engine, title, logline: cap(`${idea.goal} ${idea.escalation} ${idea.reversal.description}`).slice(0, 240), roles: { protagonist: P, foil: F, victim: V }, stagingVariant: 0, beats };
  }

  async repairPlan(input: RepairInput): Promise<unknown> {
    const t0 = performance.now();
    const out = { patches: this.repair(input), notes: `rules repair for ${input.constraints.length} constraint(s)` };
    this.done('repair', t0);
    return out;
  }

  /** deterministic repair: only touches fields named by constraints */
  private repair({ plan, constraints, attempt }: RepairInput): Patch[] {
    const patches: Patch[] = [];
    const seen = new Set<string>();
    for (const c of constraints) {
      const key = `${c.beatId}:${c.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const beat = plan.beats.find((b) => b.id === c.beatId);
      if (c.field === 'stagingVariant') { patches.push({ op: 'set_plan', field: 'stagingVariant', value: Math.min(2, plan.stagingVariant + 1) }); continue; }
      if (!beat || !c.field) continue;
      if (c.field === 'shotHint') {
        const cur = beat.shotHint;
        const opts = (c.allowed ?? SLOT_SPECS[beat.slot].shots).filter((x) => x !== cur && !(c.disallow ?? []).includes(x));
        if (opts.length) patches.push({ op: 'set', beatId: beat.id, field: 'shotHint', value: opts[(attempt - 1) % opts.length] });
        else patches.push({ op: 'set_plan', field: 'stagingVariant', value: Math.min(2, plan.stagingVariant + 1) });
        continue;
      }
      if (c.field === 'approxDuration') {
        const want = typeof c.allowed?.[0] === 'number' ? (c.allowed[0] as number) : beat.approxDuration * (c.code === 'STALE_STRETCH' ? 0.8 : 1.25);
        patches.push({ op: 'set', beatId: beat.id, field: 'approxDuration', value: +Math.max(0.4, Math.min(4, want)).toFixed(2) });
        continue;
      }
      if (c.field === 'reactor' && beat.actor !== 'none') {
        const other = beat.actor === plan.roles.protagonist ? plan.roles.foil : plan.roles.protagonist;
        patches.push({ op: 'set', beatId: beat.id, field: 'reactor', value: { actor: other, action: 'none', expression: face(other, 'surprised') } });
        continue;
      }
      if (c.allowed?.length) patches.push({ op: 'set', beatId: beat.id, field: c.field as never, value: c.allowed[0] });
    }
    return patches;
  }
}
