// Clause/composition coverage (S6): semantic requirements are judged only where the edit says they occur.
// Coverage remains a whole-video item ratio with a 90% gate; continuity/background entities are diagnostics.
import { VFX_DEFS } from '../../engine/src/vfx/defs.ts';
import type { Vec3 } from '../../engine/src/math.ts';
import { splitDirectorClauses, type DirectorClause } from '../../director/src/offline.ts';
import { LIBRARY, type LibraryEntry } from '../../library/src/ids.ts';
import { ASPECT } from './camera-recipes.ts';
import { compositionAt, poseAt, type CameraComposition } from './camera.ts';
import { frameGeometry, visibilityOf, type FrameGeometry } from './geometry.ts';
import type { VignetteScene } from './scene.ts';
import type { StagePlan, StagedBeat, StagedEvent } from './stage.ts';

export const COVERAGE_THRESHOLD = 0.9;
/** Kept for report compatibility. Semantic windows are sampled at the staged output FPS, not this legacy interval. */
export const COVERAGE_STEP = 1 / 3;

export type CoverageKind = 'cast' | 'prop' | 'event' | 'action' | 'prop_state';
export type CoverageBasis = 'composition-subject' | 'clause-literal' | 'clause-action' | 'clause-prop-state' | 'event' | 'diagnostic';
export interface RealizationCoverage { required: number; realized: number; pct: number }
export interface CoverageItem {
  beat: string; kind: CoverageKind; id: string; label: string; witness: string[]; space: 'world' | 'screen' | 'audio';
  counted: boolean; samples: number; sampleTimes: number[]; seen: number; covered: boolean; reason?: string;
  basis: CoverageBasis; clause: number | null; composition: number | null; window: [start: number, end: number];
}
export interface ClauseCoverage {
  beat: string; index: number; text: string; composition: number; window: [start: number, end: number];
  literals: string[]; actions: string[]; propStates: string[];
  literalCoverage: RealizationCoverage; actionRealization: RealizationCoverage; propStateRealization: RealizationCoverage;
  missing: string[];
}
export interface CoverageBeat { beat: string; recipeId: string; visual: number; covered: number; pct: number; missing: string[] }
export interface CoverageReport {
  threshold: number; step: number; visual: number; covered: number; pct: number; blocking: boolean; audioOnly: number;
  literalCoverage: RealizationCoverage; actionRealization: RealizationCoverage; propStateRealization: RealizationCoverage;
  fullVideoCoverage: RealizationCoverage; clauses: ClauseCoverage[]; beats: CoverageBeat[]; items: CoverageItem[];
}

const PROP_STATE_ACTIONS = new Set(['pick_up', 'grab', 'hold', 'put_down', 'throw', 'drink', 'use_phone', 'eat', 'press_button', 'open_door', 'slam_door', 'type_laptop']);
const IDLE_PROP_STATES = new Set(['', 'idle', 'closed']);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const bare = (ref: string) => ref.split('@')[0];
const canonicalWords = (s: string): string[] => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9']+/g) ?? [];
const ratio = (realized: number, required: number): RealizationCoverage => ({ required, realized, pct: r4(required ? realized / required : 1) });

function entry(id: string, entries: readonly LibraryEntry[]): LibraryEntry | undefined {
  return entries.find((candidate) => candidate.id === bare(id));
}
function aliases(id: string, entries: readonly LibraryEntry[]): string[][] {
  const match = entry(id, entries);
  return [bare(id).replace(/_/g, ' '), ...(match?.tags ?? [])].map(canonicalWords).filter((words) => words.length > 0);
}
function mentionedIds(text: string, ids: readonly string[], entries: readonly LibraryEntry[]): string[] {
  const haystack = canonicalWords(text);
  const candidates = [...new Set(ids.map(bare))].map((id) => {
    const spans: Array<{ start: number; end: number }> = [];
    for (const needle of aliases(id, entries)) for (let start = 0; start <= haystack.length - needle.length; start++) {
      if (needle.every((word, offset) => haystack[start + offset] === word)) spans.push({ start, end: start + needle.length });
    }
    const covered = new Set(spans.flatMap((span) => Array.from({ length: span.end - span.start }, (_, offset) => span.start + offset))).size;
    return { id, spans, covered, longest: Math.max(0, ...spans.map((span) => span.end - span.start)) };
  }).filter((candidate) => candidate.spans.length > 0);
  // Shared aliases (for example "free coins") go to the entity with the strongest complete contextual match.
  const selected: string[] = [];
  for (const candidate of candidates.sort((a, b) => b.covered - a.covered || b.longest - a.longest || (a.id < b.id ? -1 : 1))) {
    const whollyShadowed = candidate.spans.every((span) => candidates.some((other) => other.id !== candidate.id && selected.includes(other.id)
      && other.covered > candidate.covered && other.spans.some((otherSpan) => otherSpan.start <= span.start && otherSpan.end >= span.end)));
    if (!whollyShadowed) selected.push(candidate.id);
  }
  return selected;
}
function metricFromItems(items: readonly CoverageItem[]): RealizationCoverage {
  return ratio(items.filter((item) => item.covered).length, items.length);
}
function overlap(a: readonly [number, number], b: readonly [number, number]): [number, number] | null {
  const start = Math.max(a[0], b[0]), end = Math.min(a[1], b[1]);
  return end > start + 1e-9 ? [start, end] : null;
}
function sampleWindow(window: readonly [number, number], fps: number): number[] {
  const [start, end] = window;
  if (!(end > start) || !Number.isFinite(start) || !Number.isFinite(end) || !(fps > 0)) return [];
  const firstFrame = Math.max(0, Math.ceil(start * fps - 1e-9));
  const endFrame = Math.ceil(end * fps - 1e-9);
  const out: number[] = [];
  for (let frame = firstFrame; frame < endFrame; frame++) {
    const time = frame / fps;
    if (time >= start - 1e-9 && time < end - 1e-9) out.push(time);
  }
  return out;
}
function clauseWindow(beat: StagedBeat, clause: DirectorClause, wordCount: number): [number, number] {
  const duration = beat.end - beat.start;
  return [beat.start + duration * clause.words[0] / wordCount, beat.start + duration * clause.words[1] / wordCount];
}
function eventWindow(beat: StagedBeat, staged: StagedEvent, fps: number): [number, number] {
  const event = staged.event, oneFrame = 1 / Math.max(1, fps);
  let start = event.at, end = event.at + oneFrame;
  if (event.type === 'text_graphic') end = event.at + event.duration;
  else if (event.type === 'vfx') {
    const definition = VFX_DEFS[event.vfxId];
    end = event.at + (event.duration ?? definition?.duration ?? oneFrame) + (definition?.tail ?? 0);
  }
  else if (event.type === 'enter') {
    const actor = beat.cast.find((candidate) => candidate.id === bare(event.characterId));
    start = actor?.enterAt ?? event.at;
    end = actor?.moveT1 && actor.moveT1 > start ? actor.moveT1 : start + oneFrame;
  } else if (event.type === 'exit') {
    const actor = beat.cast.find((candidate) => candidate.id === bare(event.characterId));
    end = (actor?.exitAt ?? event.at) + oneFrame;
    start = actor?.moveT0 !== null && actor?.moveT0 !== undefined ? Math.min(actor.moveT0, event.at) : event.at;
  }
  return [r4(Math.max(beat.start, start)), r4(Math.min(beat.end, Math.max(start + oneFrame, end)))];
}
function labelForEvent(staged: StagedEvent): string {
  const event = staged.event;
  if (event.type === 'sfx') return `sfx ${event.sfxId}@${event.at}`;
  if (event.type === 'vfx') return `vfx ${event.vfxId}@${event.at}${event.target ? `->${event.target}` : ''}`;
  if (event.type === 'text_graphic') return `text ${event.textStyleId}@${event.at}${event.target ? `->${event.target}` : ''}`;
  return `${event.type} ${'characterId' in event ? `${event.characterId} ` : ''}${'doorId' in event ? event.doorId : ''}@${event.at}`;
}
function propStateEvidenceTime(plan: StagePlan, beat: StagedBeat, propId: string, actions: readonly string[], actorId: string | undefined, window: readonly [number, number]): number | null {
  const span = plan.props[propId]?.spans.find((candidate) => candidate.beat === beat.phraseId);
  if (!span) return null;
  const inWindow = (time: number | null) => time !== null && time >= window[0] - 1e-9 && time < window[1] - 1e-9;
  const actorContact = actorId ? plan.world.actors[actorId]?.contacts.some((contact) => contact.with === 'button' && overlap(window, [contact.t0, contact.t1])) : true;
  if (actions.some((action) => ['pick_up', 'grab', 'hold', 'drink', 'use_phone', 'eat', 'type_laptop'].includes(action))) {
    return span.kind === 'held' && (!actorId || span.target === actorId) && !!overlap(window, [span.t0, span.t1]) ? Math.max(window[0], span.t0) : null;
  }
  if (actions.includes('put_down') || actions.includes('throw')) {
    const spans = plan.props[propId]?.spans ?? [], index = spans.indexOf(span), previous = index > 0 ? spans[index - 1] : undefined;
    return previous && previous.kind === 'held' && span.kind !== 'held' && inWindow(span.t0) ? span.t0 : null;
  }
  if (actions.includes('press_button')) return inWindow(plan.world.button.pressT) && actorContact ? plan.world.button.pressT : null;
  if (actions.includes('open_door')) return beat.events.find((event) => event.event.type === 'door_open' && inWindow(event.event.at))?.event.at ?? null;
  if (actions.includes('slam_door')) return beat.events.find((event) => event.event.type === 'door_close' && inWindow(event.event.at))?.event.at ?? null;
  return !IDLE_PROP_STATES.has(span.state) && overlap(window, [span.t0, span.t1]) ? Math.max(window[0], span.t0) : null;
}

export function coverageCheck(scene: VignetteScene, plan: StagePlan, compositions: readonly CameraComposition[]): CoverageReport {
  const items: CoverageItem[] = [], clauses: ClauseCoverage[] = [];
  const cache = new Map<number, FrameGeometry>();
  const geoAt = (t: number) => { const key = r4(t); let geometry = cache.get(key); if (!geometry) { geometry = frameGeometry(scene, scene.pose(t)); cache.set(key, geometry); } return geometry; };
  const doorPts = (beat: StagedBeat, doorId: string): Vec3[] => {
    const door = plan.sets.find((set) => set.id === beat.setId)?.doors[doorId];
    if (!door) return [];
    const angle = door.facingDeg * Math.PI / 180, sx = Math.cos(angle), sz = -Math.sin(angle), points: Vec3[] = [];
    for (const u of [-0.45, 0, 0.45]) for (const y of [0.3, 1.1, 1.9]) points.push([door.threshold[0] + sx * u, y, door.threshold[2] + sz * u]);
    return points;
  };
  const seenWith = (beat: StagedBeat, t: number, witness: string, composition?: CameraComposition): boolean => {
    const active = composition ?? compositionAt(compositions, t);
    if (!active || active.beat !== beat.phraseId || t < active.start - 1e-9 || t >= active.end + 1e-9) return false;
    const geometry = geoAt(t), camera = poseAt(active.shot, active.start, t);
    if (witness.startsWith('door:')) return visibilityOf(geometry, camera, ASPECT, witness, doorPts(beat, witness.slice(5))).ok;
    if (!geometry.actors[witness] && !geometry.props[witness]) {
      const set = plan.sets.find((candidate) => candidate.id === beat.setId), mark = set?.marks[witness];
      if (mark) return visibilityOf(geometry, camera, ASPECT, witness, [[mark.pos[0], 0.5, mark.pos[2]], [mark.pos[0], 1.2, mark.pos[2]]]).ok;
      if (set?.doors[witness]) return visibilityOf(geometry, camera, ASPECT, witness, doorPts(beat, witness)).ok;
      return false;
    }
    return visibilityOf(geometry, camera, ASPECT, witness).ok;
  };
  const addWorld = (input: Omit<CoverageItem, 'space' | 'samples' | 'sampleTimes' | 'seen' | 'covered' | 'window'>, window: [number, number], witness: readonly string[], composition?: CameraComposition, minimumFraction = 0.5, realized = true): CoverageItem => {
    const times = sampleWindow(window, plan.fps), seen = realized ? times.filter((time) => witness.length > 0 && witness.every((id) => seenWith(inputBeat(input.beat), time, id, composition))).length : 0;
    const covered = realized && times.length > 0 && seen / times.length >= minimumFraction;
    const item: CoverageItem = { ...input, witness: [...witness], space: 'world', window: window.map(r4) as [number, number], samples: times.length, sampleTimes: times, seen, covered };
    items.push(item); return item;
  };
  const beatById = new Map(plan.beats.map((beat) => [beat.phraseId, beat] as const));
  const inputBeat = (id: string): StagedBeat => beatById.get(id)!;

  for (const beat of plan.beats) {
    const beatCompositions = compositions.filter((composition) => composition.beat === beat.phraseId);
    const selectedIds = new Set<string>();
    for (const composition of beatCompositions) {
      const subject = composition.subject ?? composition.shot.subjects.active;
      const requiredTargets = [...new Set([subject, ...composition.shot.subjects.required])];
      const optionalTargets = composition.secondary && !requiredTargets.includes(composition.secondary) ? [composition.secondary] : [];
      const targets = [...requiredTargets.map((target) => ({ target, required: true })), ...optionalTargets.map((target) => ({ target, required: false }))];
      for (const [targetIndex, descriptor] of targets.entries()) {
        const { target } = descriptor;
        selectedIds.add(target);
        const requiredTarget = descriptor.required;
        addWorld({
          beat: beat.phraseId, kind: beat.props.includes(target) ? 'prop' : 'cast',
          id: `${beat.phraseId}#composition-${composition.index}:${target}`,
          label: `${target} (composition ${composition.index} ${targetIndex === 0 ? 'subject' : 'secondary'})`, witness: [target], counted: requiredTarget,
          basis: requiredTarget ? 'composition-subject' : 'diagnostic', clause: null, composition: composition.index,
          ...(!requiredTarget ? { reason: 'optional composition context (diagnostic)' } : {}),
        }, [composition.start, composition.end], [target], composition);
      }
    }

    const directorClauses = splitDirectorClauses(beat.text);
    const wordCount = Math.max(1, beat.text.trim().split(/\s+/).filter(Boolean).length);
    const clauseRanges = new Map(directorClauses.map((clause) => [clause.index, clauseWindow(beat, clause, wordCount)] as const));
    const literalIds = new Set<string>(), actionActorIds = new Set<string>();
    for (const clause of directorClauses) {
      const rawWindow = clauseRanges.get(clause.index)!;
      const segments = beatCompositions.map((composition) => ({ composition, window: overlap(rawWindow, [composition.start, composition.end]) }))
        .filter((segment): segment is { composition: CameraComposition; window: [number, number] } => !!segment.window);
      const people = mentionedIds(clause.text, beat.cast.map((cast) => cast.id), LIBRARY.characters);
      const objects = mentionedIds(clause.text, beat.props, LIBRARY.props);
      let actions = mentionedIds(clause.text, LIBRARY.actions.map((action) => action.id), LIBRARY.actions);
      const objectKinds = new Set(objects.map((id) => plan.props[id]?.propId ?? id));
      actions = actions.filter((action) => !['open_door', 'slam_door'].includes(action) || [...objectKinds].some((id) => /door/.test(id)));
      if (/\bwants?\s+to\b/i.test(clause.text)) actions = []; // narrated desire/intent is not an executed transition
      if (!people.length) actions = actions.filter((action) => action !== 'sit'); // descriptive prop "sitting" is not an actor action
      const literalItems: CoverageItem[] = [];
      for (const id of [...people, ...objects]) {
        literalIds.add(id);
        const frameSegments = segments.filter((segment) => sampleWindow(segment.window, plan.fps).length > 0);
        const representing = frameSegments.find((segment) => segment.composition.subject === id || segment.composition.secondary === id)
          ?? [...frameSegments].sort((a, b) => (b.window[1] - b.window[0]) - (a.window[1] - a.window[0]))[0];
        const segment = representing ?? { composition: undefined, window: rawWindow };
        literalItems.push(addWorld({
          beat: beat.phraseId, kind: objects.includes(id) ? 'prop' : 'cast',
          id: `${beat.phraseId}#clause-${clause.index}:literal:${id}`,
          label: `${clause.text} [${id}]`, witness: [id], counted: true, basis: 'clause-literal', clause: clause.index,
          composition: segment.composition?.index ?? -1,
          ...(!segment.composition ? { reason: 'clause window has no emitted-frame composition' } : {}),
        }, segment.window, [id], segment.composition, 0.000001));
      }

      const supportsAction = (cast: StagedBeat['cast'][number], action: string) => bare(cast.actionId) === action
        || (action === 'jump' && cast.play.contract === 'celebrate')
        || (action === 'sit' && cast.play.contract === 'remain_still')
        || (action === 'look_at' && !!cast.lookAt)
        || (action === 'exit_frame' && cast.exitAt !== null)
        || (action === 'enter_frame' && cast.enterAt !== null);
      const matchingActors = beat.cast.filter((cast) => actions.some((action) => supportsAction(cast, action)));
      const firstComposition = segments[0]?.composition;
      const actor = matchingActors.find((cast) => people.includes(cast.id)) ?? matchingActors.find((cast) => cast.id === firstComposition?.subject) ?? matchingActors[0];
      const actionItems: CoverageItem[] = [];
      if (actions.length) {
        if (actor) actionActorIds.add(actor.id);
        let evidenceWindow: [number, number] | null = null;
        if (actor) {
          if (actions.includes('exit_frame') && actor.exitAt !== null) evidenceWindow = overlap(rawWindow, [actor.moveT0 ?? beat.start, actor.exitAt + 1 / plan.fps]);
          else if (actions.includes('enter_frame') && actor.enterAt !== null) evidenceWindow = overlap(rawWindow, [actor.enterAt, actor.moveT1 ?? actor.enterAt + 1 / plan.fps]);
          else if (actions.includes('look_at') && actor.lookAt) evidenceWindow = rawWindow;
          else evidenceWindow = overlap(rawWindow, [actor.actionT0, actor.actionT1]);
        }
        let actionComposition = evidenceWindow ? beatCompositions.find((candidate) => overlap(evidenceWindow!, [candidate.start, candidate.end])) : undefined;
        let ownedWindow = evidenceWindow && actionComposition ? overlap(evidenceWindow, [actionComposition.start, actionComposition.end]) : null;
        // A sub-frame clause owns the first emitted frame at its boundary rather than synthetic non-frame timestamps.
        if (actor && evidenceWindow && (!ownedWindow || sampleWindow(ownedWindow, plan.fps).length === 0)) {
          const frameTime = Math.ceil(rawWindow[0] * plan.fps - 1e-9) / plan.fps;
          const boundaryComposition = compositionAt(beatCompositions, frameTime);
          if (boundaryComposition && frameTime < beat.end) {
            actionComposition = boundaryComposition;
            ownedWindow = [frameTime, Math.min(boundaryComposition.end, frameTime + 1 / plan.fps)];
          }
        }
        const implemented = !!actor && !actor.play.placeholder && !!ownedWindow && actions.every((action) => supportsAction(actor, action));
        actionItems.push(addWorld({
          beat: beat.phraseId, kind: 'action', id: `${beat.phraseId}#clause-${clause.index}:action`,
          label: `${clause.text} [${actions.join(', ')}]`, witness: actor ? [actor.id] : [], counted: true, basis: 'clause-action', clause: clause.index,
          composition: actionComposition?.index ?? -1,
          ...(!implemented ? { reason: actor ? 'staged action does not overlap an emitted frame in its clause/composition' : 'named action was not staged' } : {}),
        }, ownedWindow ?? evidenceWindow ?? rawWindow, actor ? [actor.id] : [], actionComposition, 0.000001, implemented));
      }

      const stateActions = actions.filter((action) => PROP_STATE_ACTIONS.has(action));
      const propStateItems: CoverageItem[] = [];
      if (objects.length && stateActions.length) {
        const evidenceTimes = objects.map((id) => propStateEvidenceTime(plan, beat, id, stateActions, actor?.id, rawWindow));
        const realized = evidenceTimes.every((time) => time !== null);
        const transitionTime = evidenceTimes.find((time): time is number => time !== null);
        const stateFrame = transitionTime !== undefined ? Math.ceil(transitionTime * plan.fps - 1e-9) / plan.fps : undefined;
        const stateComposition = stateFrame !== undefined ? compositionAt(beatCompositions, stateFrame) : undefined;
        const stateWindow: [number, number] = stateFrame !== undefined && stateComposition
          ? [stateFrame, Math.min(stateComposition.end, stateFrame + 1 / plan.fps)]
          : rawWindow;
        propStateItems.push(addWorld({
          beat: beat.phraseId, kind: 'prop_state', id: `${beat.phraseId}#clause-${clause.index}:prop-state`,
          label: `${clause.text} [${objects.join(', ')} -> ${stateActions.join(', ')}]`, witness: objects, counted: true,
          basis: 'clause-prop-state', clause: clause.index, composition: stateComposition?.index ?? -1,
          ...(!realized ? { reason: 'named prop transition was not emitted in the clause window' } : {}),
        }, stateWindow, objects, stateComposition, 0.000001, realized));
      }

      const literalCoverage = metricFromItems(literalItems), actionRealization = metricFromItems(actionItems), propStateRealization = metricFromItems(propStateItems);
      const responsibleComposition = [...literalItems, ...actionItems, ...propStateItems].find((item) => item.composition !== null && item.composition >= 0 && item.sampleTimes.length > 0)?.composition;
      clauses.push({
        beat: beat.phraseId, index: clause.index, text: clause.text, composition: responsibleComposition ?? firstComposition?.index ?? -1,
        window: rawWindow.map(r4) as [number, number], literals: [...people, ...objects], actions,
        propStates: stateActions.length ? objects : [], literalCoverage, actionRealization, propStateRealization,
        missing: [...literalItems, ...actionItems, ...propStateItems].filter((item) => !item.covered).map((item) => item.label),
      });
    }

    for (const staged of beat.events) {
      const event = staged.event, window = eventWindow(beat, staged, plan.fps), composition = compositionAt(beatCompositions, event.at);
      const clauseDefinition = directorClauses.find((candidate) => {
        const range = clauseRanges.get(candidate.index)!;
        return event.at >= range[0] - 1e-9 && event.at < range[1] + 1e-9;
      });
      const clause = clauseDefinition ? clauses.find((candidate) => candidate.beat === beat.phraseId && candidate.index === clauseDefinition.index) : undefined;
      const base = { beat: beat.phraseId, kind: 'event' as const, id: `${beat.phraseId}#event-${staged.index}`, label: labelForEvent(staged), witness: staged.witness, basis: 'event' as const, clause: clause?.index ?? null, composition: composition?.index ?? null, window };
      if (staged.space === 'audio') items.push({ ...base, space: 'audio', counted: false, samples: 0, sampleTimes: [], seen: 0, covered: true, reason: 'audio only' });
      else if (staged.space === 'screen') { const sampleTimes = sampleWindow(window, plan.fps); items.push({ ...base, space: 'screen', counted: true, samples: sampleTimes.length, sampleTimes, seen: sampleTimes.length, covered: sampleTimes.length > 0, reason: 'screen-space' }); }
      else addWorld({ ...base, counted: true }, window, staged.witness, undefined, 0.000001);
    }

    const eventWitnesses = new Set(beat.events.flatMap((event) => event.witness));
    for (const cast of beat.cast) if (!selectedIds.has(cast.id) && !literalIds.has(cast.id) && !actionActorIds.has(cast.id) && !eventWitnesses.has(cast.id)) {
      items.push({ beat: beat.phraseId, kind: 'cast', id: `${beat.phraseId}#diagnostic:${cast.id}`, label: `${cast.id} (${cast.actionId})`, witness: [cast.id], space: 'world', counted: false, samples: 0, sampleTimes: [], seen: 0, covered: false, reason: 'background/continuity cast (diagnostic)', basis: 'diagnostic', clause: null, composition: null, window: [beat.start, beat.end] });
    }
    for (const id of beat.props) if (!selectedIds.has(id) && !literalIds.has(id) && !eventWitnesses.has(id)) {
      const span = plan.props[id]?.spans.find((candidate) => candidate.beat === beat.phraseId);
      items.push({ beat: beat.phraseId, kind: 'prop', id: `${beat.phraseId}#diagnostic:${id}`, label: `${id} (${span?.state ?? ''})`, witness: [id], space: 'world', counted: false, samples: 0, sampleTimes: [], seen: 0, covered: false, reason: 'background/continuity prop (diagnostic)', basis: 'diagnostic', clause: null, composition: null, window: [beat.start, beat.end] });
    }
  }

  const beats: CoverageBeat[] = plan.beats.map((beat) => {
    const required = items.filter((item) => item.beat === beat.phraseId && item.counted), realized = required.filter((item) => item.covered);
    return { beat: beat.phraseId, recipeId: beat.camera.recipeId, visual: required.length, covered: realized.length, pct: r4(required.length ? realized.length / required.length : 1), missing: required.filter((item) => !item.covered).map((item) => item.label) };
  });
  const counted = items.filter((item) => item.counted), covered = counted.filter((item) => item.covered).length;
  const fullVideoCoverage = ratio(covered, counted.length);
  const literalClauses = clauses.filter((clause) => clause.literalCoverage.required > 0);
  const actionClauses = clauses.filter((clause) => clause.actionRealization.required > 0);
  const propStateClauses = clauses.filter((clause) => clause.propStateRealization.required > 0);
  const literalCoverage = ratio(literalClauses.filter((clause) => clause.literalCoverage.pct === 1).length, literalClauses.length);
  const actionRealization = ratio(actionClauses.filter((clause) => clause.actionRealization.pct === 1).length, actionClauses.length);
  const propStateRealization = ratio(propStateClauses.filter((clause) => clause.propStateRealization.pct === 1).length, propStateClauses.length);
  const subjectMiss = counted.some((item) => item.basis === 'composition-subject' && !item.covered);
  return {
    threshold: COVERAGE_THRESHOLD, step: r4(1 / Math.max(1, plan.fps)), visual: counted.length, covered, pct: fullVideoCoverage.pct,
    blocking: fullVideoCoverage.pct < COVERAGE_THRESHOLD || subjectMiss || literalCoverage.pct < COVERAGE_THRESHOLD || actionRealization.pct < 1 || propStateRealization.pct < 1,
    audioOnly: items.filter((item) => item.space === 'audio').length,
    literalCoverage, actionRealization, propStateRealization, fullVideoCoverage, clauses, beats, items,
  };
}
