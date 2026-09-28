// Stage C — asset compatibility. Deterministic authority over what may be rendered: every requested element must be
// registered, substituted under the declared policy, or the idea is rejected with a precise reason.
import { scanIdea } from './lexicon.ts';
import type { Registry } from './registry.ts';
import { SLOT_SPECS, TEMPLATES, checkGrammar } from './templates.ts';
import type { NormalizedIdea, RepairConstraint, RejectCategory, VisualBeatPlan } from './schemas.ts';

export interface CompatResult {
  ok: boolean;
  rejection: { category: RejectCategory; reason: string } | null;
  constraints: RepairConstraint[];
  substitutions: NormalizedIdea['substitutions'];
  warnings: string[];
}

/** Safety/IP/availability net applied to the RAW idea, independent of what the provider claimed. */
export function ideaSafetyNet(ideaText: string, idea: NormalizedIdea): { rejection: CompatResult['rejection']; warnings: string[] } {
  const scan = scanIdea(ideaText);
  const warnings: string[] = [];
  // precedence: unsafe > protected_ip > whatever else the provider rejected for (its reasons are kept in `also`)
  const keep = (r: NormalizedIdea['rejection']) => (r ? [{ category: r.category, reason: r.reason }, ...(r.also ?? [])].filter((x) => x.category !== 'unsafe').slice(0, 8) : []);
  if (scan.safety.length && idea.rejection?.category !== 'unsafe') {
    const also = keep(idea.rejection);
    return { rejection: { category: 'unsafe', reason: `independent safety scan: ${scan.safety.map((s) => `${s.category} (${s.term})`).join(', ')} (provider classified "${idea.safety.classification}")`.slice(0, 300), ...(also.length ? { also } : {}) }, warnings };
  }
  const central = scan.ip.filter((x) => !x.styleQualified);
  if (central.length && (!idea.rejection || !['unsafe', 'protected_ip'].includes(idea.rejection.category))) {
    const also = keep(idea.rejection).filter((x) => x.category !== 'protected_ip');
    return { rejection: { category: 'protected_ip', reason: `independent IP scan: ${central.map((x) => x.name).join(', ')}`, ...(also.length ? { also } : {}) }, warnings };
  }
  const style = scan.ip.filter((x) => x.styleQualified);
  if (style.length && !idea.substitutions.some((s) => s.kind === 'brand')) warnings.push(`brand reference(s) ${style.map((x) => x.name).join(', ')} not declared as removed by the provider; removed by the safety net`);
  // unregistered objects the provider silently ignored or mapped
  const declared = new Set(idea.substitutions.map((s) => s.requested.toLowerCase()));
  for (const o of scan.objects.filter((x) => x.kind === 'unavailable')) if (!declared.has(o.mention) && !idea.rejection) warnings.push(`idea mentions unregistered object "${o.mention}" that the provider did not declare (treated as incidental and dropped)`);
  for (const c of scan.characters.filter((x) => x.kind === 'non_human')) if (!idea.rejection) return { rejection: { category: 'unavailable', reason: `no rig for non-human character "${c.mention}"` }, warnings };
  return { rejection: null, warnings };
}

export function checkCompatibility(idea: NormalizedIdea, plan: VisualBeatPlan, reg: Registry): CompatResult {
  const cons: RepairConstraint[] = [];
  const warnings: string[] = [];
  const c = (code: string, message: string, beatId: string | null, field: string | null, extra: Partial<RepairConstraint> = {}) => cons.push({ code, message, beatId, field, source: 'compatibility', ...extra });
  // registry ids
  for (const [role, b] of [['protagonist', idea.protagonist], ['support', idea.support]] as const) if (!b.id || !reg.characters[b.id]) return { ok: false, rejection: { category: 'unavailable', reason: `${role} "${b.mention}" is not a registered character` }, constraints: [], substitutions: idea.substitutions, warnings };
  if (idea.environment.id !== reg.environment.id) return { ok: false, rejection: { category: 'unavailable', reason: `environment "${idea.environment.mention}" not built` }, constraints: [], substitutions: idea.substitutions, warnings };
  if (idea.causalProp.id !== 'suspicious_button' || idea.escalationProp.id !== 'spark_coin') return { ok: false, rejection: { category: 'unavailable', reason: 'causal/escalation props must be registered props (suspicious_button / spark_coin)' }, constraints: [], substitutions: idea.substitutions, warnings };
  if (plan.engine !== idea.engine) c('ENGINE_MISMATCH', `plan engine ${plan.engine} != idea engine ${idea.engine}`, null, null);
  const t = TEMPLATES[plan.engine];
  // roles
  const roles = plan.roles;
  if (roles.protagonist === roles.foil) c('ROLE_CONFLICT', 'protagonist and foil must be different characters', null, null);
  const expectVictim = t.victimRole === 'smart' ? roles.foil : roles.protagonist;
  if (roles.victim !== expectVictim && idea.reversal.victim === (t.victimRole === 'smart' ? 'support' : 'protagonist')) c('ROLE_VICTIM', `template ${t.engine} requires the ${t.victimRole} (${expectVictim}) to be the victim`, null, null);
  // structure
  for (const e of checkGrammar(plan.engine, plan.beats.map((b) => b.slot))) c('TEMPLATE_GRAMMAR', e, null, null);
  const ids = new Set<string>();
  plan.beats.forEach((b, i) => {
    if (b.id !== `b${String(i + 1).padStart(2, '0')}`) c('BEAT_ID_ORDER', `beat ${i + 1} id should be b${String(i + 1).padStart(2, '0')} (got ${b.id})`, b.id, 'id');
    ids.add(b.id);
    const spec = SLOT_SPECS[b.slot];
    // actor
    const wantActor = spec.role === 'none' ? 'none' : spec.role === 'protagonist' || spec.role === 'noob' ? roles.protagonist : spec.role === 'foil' || spec.role === 'smart' ? roles.foil : roles.victim;
    if (b.actor !== wantActor) c('SLOT_ACTOR', `slot ${b.slot} must be performed by ${wantActor} (got ${b.actor})`, b.id, 'actor', { allowed: [wantActor] });
    // action
    if (!spec.allowedActions.includes(b.action)) c('SLOT_ACTION', `action "${b.action}" not allowed in slot ${b.slot}; allowed ${spec.allowedActions.join(', ')}`, b.id, 'action', { allowed: spec.allowedActions });
    if (b.action !== 'none') {
      const cap = reg.actions[b.action];
      if (!cap?.implemented) c('UNKNOWN_ACTION', `action "${b.action}" is not implemented`, b.id, 'action', { allowed: spec.allowedActions });
      else if (cap.availability.status === 'unavailable') c('ACTION_UNAVAILABLE', `action "${b.action}" is unavailable to the generator: ${cap.availability.reason}${cap.availability.requires.length ? ` (requires: ${cap.availability.requires.join(', ')})` : ''}`, b.id, 'action', { allowed: spec.allowedActions.filter((a) => reg.actions[a]?.storyUse) });
      const actor = b.actor !== 'none' ? reg.characters[b.actor] : null;
      if (actor && !actor.allowedActions.includes(b.action as never)) c('ACTION_NOT_ALLOWED', `${b.actor}@${actor.version} is not allowed to ${b.action}`, b.id, 'action', { allowed: spec.allowedActions.filter((a) => actor.allowedActions.includes(a as never)) });
      if (b.action === 'press_button' && b.target !== 'button.press_surface') c('ACTION_TARGET', `press_button must target button.press_surface (got ${b.target})`, b.id, 'target', { allowed: ['button.press_surface'] });
    }
    // expressions
    for (const f of ['expressionBefore', 'expressionAfter'] as const) {
      const e = b[f];
      if (e && b.actor !== 'none' && !reg.characters[b.actor].allowedExpressions.includes(e as never)) c('EXPRESSION_NOT_ALLOWED', `${b.actor} has no "${e}" face (allowed ${reg.characters[b.actor].allowedExpressions.join(', ')})`, b.id, f, { allowed: [...reg.characters[b.actor].allowedExpressions] });
    }
    if (b.reactor) {
      if (!reg.characters[b.reactor.actor]) c('UNKNOWN_ACTOR', `reactor ${b.reactor.actor} not cast`, b.id, 'reactor');
      else {
        if (b.reactor.expression && !reg.characters[b.reactor.actor].allowedExpressions.includes(b.reactor.expression as never)) c('EXPRESSION_NOT_ALLOWED', `reactor ${b.reactor.actor} has no "${b.reactor.expression}" face`, b.id, 'reactor', { allowed: [null] });
        if (b.reactor.action !== 'none' && (!reg.actions[b.reactor.action]?.storyUse || !reg.characters[b.reactor.actor].allowedActions.includes(b.reactor.action as never))) c('REACTOR_ACTION', `reactor action "${b.reactor.action}" not usable by ${b.reactor.actor}`, b.id, 'reactor');
      }
    }
    // prop effects
    if (b.propEffect && b.propEffect.effect !== 'none') {
      if (!spec.effects.includes(b.propEffect.effect)) c('SLOT_EFFECT', `effect "${b.propEffect.effect}" not allowed in slot ${b.slot}; allowed ${spec.effects.join(', ')}`, b.id, 'propEffect');
      const m = b.propEffect.prop === 'button' ? reg.props.button : b.propEffect.prop === 'coin' ? reg.props.coin : reg.props.desk;
      const need: Record<string, string> = { grow: 'uniform_scale', press: 'press_depress', reset: 'press_depress', flash: 'glow', spin: 'spin', hop: 'translate', spawn: 'translate', stand_up: 'rotate', tip_over: 'rotate', wobble: 'rotate' };
      const tr = need[b.propEffect.effect];
      if (tr && !m.allowedTransformations.includes(tr as never)) c('FORBIDDEN_TRANSFORM', `${m.id} does not allow ${tr} (${b.propEffect.effect})`, b.id, 'propEffect');
    }
    // duration window
    const [lo, hi] = spec.duration;
    if (b.approxDuration < lo * 0.8 || b.approxDuration > hi * 1.3) c('BEAT_DURATION', `${b.slot} duration ${b.approxDuration}s outside ${(lo * 0.8).toFixed(2)}-${(hi * 1.3).toFixed(2)}s`, b.id, 'approxDuration', { allowed: [+((lo + hi) / 2).toFixed(2)] });
    // readability without dialogue: reaction slots need a face change
    if (spec.reaction && b.actor !== 'none' && !b.expressionAfter && !b.emote && !b.reactor?.expression) c('NO_REACTION', `reaction slot ${b.slot} has no expression change, emote or reactor face`, b.id, 'reactor');
  });
  // causal links
  plan.beats.forEach((b) => {
    if (b.causeBeatId && (!ids.has(b.causeBeatId) || b.causeBeatId >= b.id)) c('CAUSE_LINK', `${b.id}.causeBeatId ${b.causeBeatId} must reference an earlier beat`, b.id, 'causeBeatId');
    if (b.resultBeatId && (!ids.has(b.resultBeatId) || b.resultBeatId <= b.id)) c('RESULT_LINK', `${b.id}.resultBeatId ${b.resultBeatId} must reference a later beat`, b.id, 'resultBeatId');
  });
  for (const [res, cause] of t.causal) {
    const rb = plan.beats.find((b) => b.slot === res);
    if (!rb) continue;
    const cb = plan.beats.find((b) => b.id === rb.causeBeatId);
    if (!cb || cb.slot !== cause) {
      const want = [...plan.beats].reverse().find((b) => b.slot === cause && b.id < rb.id);
      c('MISSING_CAUSE', `${res} (${rb.id}) must be caused by a ${cause} beat`, rb.id, 'causeBeatId', { allowed: want ? [want.id] : [] });
    }
  }
  if (idea.requiresDialogue) return { ok: false, rejection: { category: 'requires_dialogue', reason: 'story requires dialogue' }, constraints: [], substitutions: idea.substitutions, warnings };
  if (idea.requiresReadableText) return { ok: false, rejection: { category: 'requires_text', reason: 'story requires readable text' }, constraints: [], substitutions: idea.substitutions, warnings };
  return { ok: cons.length === 0, rejection: null, constraints: cons, substitutions: idea.substitutions, warnings };
}
