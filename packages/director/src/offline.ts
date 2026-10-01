// Deterministic, browser-safe script-to-BeatSheet Director.
// Remote intent is advisory only: every final choice is resolved through the local capability library.
import { LIBRARY, type Library, type LibraryEntry, type LibraryKind, type SetEntry } from '../../library/src/ids.ts';
import { validateBeatSheet, type BeatSheet } from './beat-sheet.ts';
import type { DirectorIntent } from './intent.ts';

export const DIRECTOR_EDIT_PLAN_POLICY = {
  version: 'clause-edit-v1',
  coverageVersion: 'literal-visual-clauses-v1',
  minimumSegmentSeconds: 0.6,
  targetAverageSeconds: { min: 1.2, preferred: 1.7, max: 2.2 },
  maximumSubShots: 4,
} as const;
export const DIRECTOR_ALGORITHM_VERSION = 'director-v2-clause-edit-v1';
export type DirectorMode = 'offline' | 'openrouter' | 'auto';
export type MatchKind = 'sets' | 'characters' | 'actions' | 'expressions' | 'props' | 'cameraRecipes';

export interface DirectorRequest {
  script: string | string[];
  duration: number;
  seed: number;
}
export interface NormalizedDirectorRequest { lines: string[]; duration: number; seed: number }
export interface ProviderAttempt {
  model: string;
  phase: 'initial' | 'repair';
  outcome: 'ok' | 'invalid' | 'timeout' | 'rate_limited' | 'http' | 'network' | 'malformed';
  detail?: string;
}
export interface DirectorProviderReport {
  requested: DirectorMode;
  used: 'offline' | 'openrouter';
  model?: string;
  attempts: ProviderAttempt[];
  fallback?: { code: string; message: string };
}
export interface MatchDecision {
  kind: MatchKind;
  selected: string;
  matchedTag?: string;
  source: 'script' | 'provider' | 'default';
  beat?: string;
}
export interface AssetSubstitution {
  kind: MatchKind;
  requested: string;
  used: string;
  reason: string;
  beat?: string;
}
export interface MissingAsset {
  kind: MatchKind;
  requested: string;
  reason: string;
  beat?: string;
}
export type ClauseBoundaryReason = 'start' | 'punctuation' | 'conjunction' | 'action_change';
export interface DirectorClause {
  index: number;
  text: string;
  /** Half-open indexes into the normalized whitespace-delimited phrase words. */
  words: [start: number, end: number];
  boundary: ClauseBoundaryReason[];
}
export interface EditPlanClauseReport extends DirectorClause {
  cues: { people: string[]; objects: string[]; actions: string[]; pronouns: string[] };
  visual: boolean;
  covered: boolean;
  subjectBasis?: 'person' | 'object' | 'pronoun' | 'action';
  composition: number;
  shot: { recipeId: string; subject: string; secondary?: string; source: 'main' | 'local' | 'provider' };
  providerHint: 'none' | 'accepted' | 'rebuilt' | 'not_selected';
}
export interface EditPlanSegmentReport {
  index: number;
  start: number;
  end: number;
  duration: number;
  clause: number;
  recipeId: string;
  subject: string;
  secondary?: string;
  source: 'main' | 'local' | 'provider';
}
export interface EditPlanBeatReport {
  beat: string;
  clauses: EditPlanClauseReport[];
  segments: EditPlanSegmentReport[];
  candidateCuts: number;
  targetSegments: number;
  actualSegments: number;
  averageSegmentSeconds: number;
  shortestSegmentSeconds: number;
  targetAverageMet: boolean;
  visualClauses: number;
  coveredVisualClauses: number;
}
export interface DirectorEditPlanReport {
  policy: typeof DIRECTOR_EDIT_PLAN_POLICY;
  coverage: { version: typeof DIRECTOR_EDIT_PLAN_POLICY.coverageVersion; visualClauses: number; coveredVisualClauses: number; pct: number };
  beats: EditPlanBeatReport[];
}
export interface DirectorReport {
  algorithmVersion: string;
  provider: DirectorProviderReport;
  matches: MatchDecision[];
  substitutions: AssetSubstitution[];
  missingAssets: MissingAsset[];
  editPlan: DirectorEditPlanReport;
  validation: { ok: boolean; issues: Array<{ path: string; message: string }> };
}
export interface DirectorResult { sheet: BeatSheet; report: DirectorReport }

export class DirectorInputError extends Error {
  constructor(message: string) { super(message); this.name = 'DirectorInputError'; }
}

const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);
const bare = (ref: string): string => ref.split('@')[0];
const latestRef = (e: LibraryEntry | SetEntry): string => e.versions?.length ? `${e.id}@${e.versions[e.versions.length - 1]}` : e.id;
const hash32 = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
};
const canonicalWords = (s: string): string[] => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9']+/g) ?? [];
const canonical = (s: string): string => canonicalWords(s).join(' ');

export function normalizeDirectorRequest(input: DirectorRequest): NormalizedDirectorRequest {
  if (!Number.isFinite(input.duration) || input.duration <= 0 || input.duration > 600) throw new DirectorInputError('duration must be greater than 0 and at most 600 seconds');
  if (!Number.isInteger(input.seed) || input.seed < 0) throw new DirectorInputError('seed must be a non-negative integer');
  const raw = Array.isArray(input.script) ? input.script.flatMap((line) => line.replace(/\r/g, '').split('\n')) : input.script.replace(/\r/g, '').split('\n');
  const lines = raw.map((line) => words(line).join(' ')).filter(Boolean);
  if (!lines.length) throw new DirectorInputError('script must contain at least one non-empty line');
  if (lines.length > 200) throw new DirectorInputError('script has more than 200 non-empty lines');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 400) throw new DirectorInputError(`line ${i + 1} exceeds the 400-character BeatSheet limit`);
    const chunks = captionGroups(lines[i]);
    if (chunks.length > 12) throw new DirectorInputError(`line ${i + 1} needs ${chunks.length} captions; the BeatSheet limit is 12`);
  }
  return { lines, duration: input.duration, seed: input.seed };
}

/** Greedy contiguous 1-4-word captions; no word is changed, dropped, duplicated, or reordered. */
export function captionGroups(text: string): string[][] {
  const out: string[][] = [];
  for (const word of words(text)) {
    if (word.length > 48) throw new DirectorInputError(`word "${word.slice(0, 24)}…" exceeds the 48-character caption limit`);
    const last = out[out.length - 1];
    if (last && last.length < 4 && [...last, word].join(' ').length <= 48) last.push(word);
    else out.push([word]);
  }
  return out;
}

interface Query { text: string; source: 'script' | 'provider' }
interface Candidate { entry: LibraryEntry | SetEntry; tag: string; source: 'script' | 'provider'; score: number; tie: number }

function matchTag(haystack: string, tag: string): number {
  const h = canonicalWords(haystack), n = canonicalWords(tag);
  if (!n.length) return tag.length && haystack.includes(tag) ? 100 + tag.length : 0;
  outer: for (let i = 0; i <= h.length - n.length; i++) {
    for (let k = 0; k < n.length; k++) if (h[i + k] !== n[k]) continue outer;
    return n.length * 1000 + n.join(' ').length;
  }
  return 0;
}

function candidates(kind: MatchKind, queries: Query[], lib: Library, seed: number, scope: string): Candidate[] {
  const out: Candidate[] = [];
  for (const entry of lib[kind] as Array<LibraryEntry | SetEntry>) {
    let best: Candidate | null = null;
    for (const q of queries) {
      for (const tag of [...entry.tags, entry.id.replace(/_/g, ' ')]) {
        const raw = matchTag(q.text.toLowerCase(), tag.toLowerCase());
        if (!raw) continue;
        const c: Candidate = { entry, tag, source: q.source, score: raw + (q.source === 'provider' ? 100_000 : 0), tie: hash32(`${seed}:${scope}:${entry.id}`) };
        if (!best || c.score > best.score || (c.score === best.score && c.tag < best.tag)) best = c;
      }
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score || a.tie - b.tie || a.entry.id.localeCompare(b.entry.id));
}

function availableEntries(kind: MatchKind, lib: Library): Array<LibraryEntry | SetEntry> {
  return (lib[kind] as Array<LibraryEntry | SetEntry>).filter((e) => e.status === 'available');
}
function requiredDefault(kind: MatchKind, id: string, lib: Library): LibraryEntry | SetEntry {
  const e = availableEntries(kind, lib).find((x) => x.id === id);
  if (!e) throw new DirectorInputError(`director library has no available ${kind} fallback "${id}"`);
  return e;
}

interface LiteralHit { id: string; tag: string; startWord: number; endWord: number }
const CLAUSE_CONJUNCTIONS = new Set(['and', 'but', 'then', 'while', 'when', 'before', 'after', 'so', 'yet', 'until', 'meanwhile']);
const NON_VERBAL_ACTION_TAGS = new Set(['phone', 'party', 'yay', 'no', 'hi', 'bye', 'confident', 'curious', 'regret', 'shocked', 'fast']);
const PERSON_PRONOUNS = new Set(['he', 'she', 'they', 'him', 'her', 'them', 'who']);
const OBJECT_PRONOUNS = new Set(['it', 'this', 'that', 'these', 'those']);

function literalHits(entries: Array<LibraryEntry | SetEntry>, phraseWords: string[]): LiteralHit[] {
  const indexed = phraseWords.flatMap((raw, word) => canonicalWords(raw).map((value) => ({ value, word })));
  const out: LiteralHit[] = [];
  for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
    const tags = [...new Set([...entry.tags, entry.id.replace(/_/g, ' ')].map(canonical).filter(Boolean))];
    for (const tag of tags) {
      const needle = tag.split(' ');
      for (let i = 0; i <= indexed.length - needle.length; i++) {
        if (!needle.every((part, k) => indexed[i + k].value === part)) continue;
        out.push({ id: entry.id, tag, startWord: indexed[i].word, endWord: indexed[i + needle.length - 1].word + 1 });
      }
    }
  }
  const seen = new Set<string>();
  return out.sort((a, b) => a.startWord - b.startWord || b.endWord - a.endWord || a.id.localeCompare(b.id) || a.tag.localeCompare(b.tag))
    .filter((hit) => { const key = `${hit.id}:${hit.startWord}:${hit.endWord}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

function primaryActionHits(phraseWords: string[], lib: Library): LiteralHit[] {
  const hits = literalHits(availableEntries('actions', lib), phraseWords)
    .filter((hit) => !NON_VERBAL_ACTION_TAGS.has(hit.tag));
  const selected: LiteralHit[] = [];
  let cursor = -1;
  for (let i = 0; i < hits.length;) {
    const start = hits[i].startWord;
    const sameStart: LiteralHit[] = [];
    while (i < hits.length && hits[i].startWord === start) sameStart.push(hits[i++]);
    if (start < cursor) continue;
    const best = sameStart.sort((a, b) => (b.endWord - b.startWord) - (a.endWord - a.startWord) || a.id.localeCompare(b.id))[0];
    selected.push(best); cursor = best.endWord;
  }
  return selected;
}

function addBoundary(boundaries: Map<number, Set<ClauseBoundaryReason>>, at: number, reason: ClauseBoundaryReason, wordCount: number): void {
  if (at <= 0 || at >= wordCount) return;
  const reasons = boundaries.get(at) ?? new Set<ClauseBoundaryReason>();
  reasons.add(reason); boundaries.set(at, reasons);
}

/** Deterministic word-indexed clause split shared with the advisory provider prompt. */
export function splitDirectorClauses(text: string, lib: Library = LIBRARY): DirectorClause[] {
  const phraseWords = words(text);
  const boundaries = new Map<number, Set<ClauseBoundaryReason>>();
  for (let i = 0; i < phraseWords.length; i++) {
    const token = phraseWords[i];
    if (/[,.;:!?](?:["')\]]*)$/u.test(token) || token.includes('—') || token.includes('–')) addBoundary(boundaries, i + 1, 'punctuation', phraseWords.length);
    if (i > 0 && CLAUSE_CONJUNCTIONS.has(canonical(token))) addBoundary(boundaries, i, 'conjunction', phraseWords.length);
  }
  const entityHits = literalHits([
    ...availableEntries('characters', lib),
    ...availableEntries('props', lib),
  ], phraseWords);
  const characterIds = new Set(availableEntries('characters', lib).map((entry) => entry.id));
  let previousAction: LiteralHit | undefined;
  for (const hit of primaryActionHits(phraseWords, lib)) {
    const previousStart = previousAction?.startWord;
    const alreadySeparated = previousStart !== undefined && [...boundaries.keys()].some((at) => at > previousStart && at <= hit.startWord);
    if (previousAction && !alreadySeparated && hit.id !== previousAction.id && hit.startWord >= previousAction.endWord) {
      const previousEnd = previousAction.endWord;
      const precedingEntities = entityHits.filter((entity) => entity.startWord >= previousEnd && entity.startWord < hit.startWord);
      const namedActor = precedingEntities.filter((entity) => characterIds.has(entity.id)).at(-1);
      addBoundary(boundaries, (namedActor ?? precedingEntities.at(-1))?.startWord ?? hit.startWord, 'action_change', phraseWords.length);
    }
    previousAction = hit;
  }
  const starts = [0, ...boundaries.keys()].sort((a, b) => a - b);
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? phraseWords.length;
    return { index, text: phraseWords.slice(start, end).join(' '), words: [start, end], boundary: index === 0 ? ['start'] : [...boundaries.get(start)!].sort() };
  });
}

interface ClauseAnalysis extends DirectorClause {
  people: string[];
  objects: string[];
  actions: string[];
  pronouns: string[];
  visual: boolean;
  subject?: string;
  subjectBasis?: 'person' | 'object' | 'pronoun' | 'action';
  secondaryCandidates: string[];
  usefulCut: boolean;
}
interface CameraSpec { recipeId: string; subject: string; secondary?: string }
interface PlannedCut { clause: ClauseAnalysis; from: number; shot: CameraSpec; source: 'local' | 'provider'; providerHint: 'none' | 'accepted' | 'rebuilt' }
type ProviderShotHint = NonNullable<DirectorIntent['beats'][number]['shots']>[number];

function uniqueIds(hits: LiteralHit[]): string[] { return [...new Set(hits.map((hit) => hit.id))]; }
function analyzeClauses(text: string, characters: LibraryEntry[], props: LibraryEntry[], active: LibraryEntry, lib: Library): ClauseAnalysis[] {
  const rawWords = words(text);
  let lastPerson: string | undefined = active.id;
  let lastObject: string | undefined;
  const clauses: ClauseAnalysis[] = splitDirectorClauses(text, lib).map((clause) => {
    const clauseWords = rawWords.slice(clause.words[0], clause.words[1]);
    const personHits = literalHits(characters, clauseWords);
    const objectHits = literalHits(props, clauseWords);
    const actionHits = literalHits(availableEntries('actions', lib), clauseWords);
    const people = uniqueIds(personHits), objects = uniqueIds(objectHits), actions = uniqueIds(actionHits);
    const pronounWords = clauseWords.flatMap(canonicalWords).filter((word) => PERSON_PRONOUNS.has(word) || OBJECT_PRONOUNS.has(word));
    const pronouns = [...new Set(pronounWords)];
    const entities = [
      ...personHits.map((hit) => ({ ...hit, kind: 'person' as const })),
      ...objectHits.map((hit) => ({ ...hit, kind: 'object' as const })),
    ].sort((a, b) => a.startWord - b.startWord || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    let subject: string | undefined, subjectBasis: ClauseAnalysis['subjectBasis'];
    if (entities[0]) { subject = entities[0].id; subjectBasis = entities[0].kind; }
    else if (pronounWords.length) {
      subject = OBJECT_PRONOUNS.has(pronounWords[0]) ? (lastObject ?? lastPerson) : lastPerson;
      if (subject) subjectBasis = 'pronoun';
    } else if (actions.length) { subject = active.id; subjectBasis = 'action'; }
    const secondaryCandidates = [...new Set([...people, ...objects])].filter((id) => id !== subject);
    if (people.length) lastPerson = people.at(-1);
    if (objects.length) lastObject = objects.at(-1);
    return { ...clause, people, objects, actions, pronouns, visual: Boolean(people.length || objects.length || actions.length), ...(subject ? { subject } : {}), ...(subjectBasis ? { subjectBasis } : {}), secondaryCandidates, usefulCut: false };
  });
  let previousSemantic = '';
  for (const clause of clauses) {
    if (!clause.visual || !clause.subject) continue;
    const semantic = `${clause.subject}|${clause.people.join(',')}|${clause.objects.join(',')}|${clause.actions.join(',')}`;
    clause.usefulCut = clause.index > 0 && semantic !== previousSemantic;
    previousSemantic = semantic;
  }
  return clauses;
}

const PAIR_REQUIRED_RECIPES = new Set(['two_shot', 'over_shoulder']);
const PROP_ONLY_RECIPES = new Set(['prop_ecu', 'insert_prop', 'top_down_insert']);
const LOCOMOTION_ACTIONS = new Set(['walk', 'run', 'chase', 'sneak', 'enter_frame', 'exit_frame', 'enter_door', 'exit_door']);
const REACTION_ACTIONS = new Set(['shock_recoil', 'cower', 'laugh', 'facepalm', 'regret_freeze', 'cry', 'scream', 'shrug']);
const OVERHEAD_ACTIONS = new Set(['fall', 'jump', 'flattened', 'dive_prone']);

function framingFamily(recipeId: string): string {
  if (['prop_ecu', 'hook_closeup', 'insert_prop', 'reaction_punch_in'].includes(recipeId)) return 'close';
  if (['establishing_wide', 'wide_environment', 'two_shot', 'top_down', 'top_down_insert'].includes(recipeId)) return 'wide';
  if (['chase_cam', 'whip_pan', 'slow_push_in', 'final_loop'].includes(recipeId)) return 'moving';
  return 'medium';
}
function nearIdentical(a: CameraSpec, b: CameraSpec): boolean {
  return a.recipeId === b.recipeId || (a.subject === b.subject && framingFamily(a.recipeId) === framingFamily(b.recipeId));
}
function recipeCompatible(recipeId: string, subject: string, secondary: string | undefined, objectIds: Set<string>): boolean {
  return (!PROP_ONLY_RECIPES.has(recipeId) || objectIds.has(subject)) && (!PAIR_REQUIRED_RECIPES.has(recipeId) || Boolean(secondary && secondary !== subject));
}
function framedEntities(camera: CameraSpec): string[] {
  const usesSecondary = ['two_shot', 'over_shoulder', 'pov', 'whip_pan', 'establishing_wide', 'wide_environment', 'top_down', 'final_loop'].includes(camera.recipeId);
  return [camera.subject, ...(usesSecondary && camera.secondary ? [camera.secondary] : [])];
}
function entityAliases(id: string, characters: LibraryEntry[], props: LibraryEntry[]): string[] {
  const entry = [...characters, ...props].find((item) => item.id === id);
  return [...new Set([id.replace(/_/g, ' '), ...(entry?.tags ?? [])].map(canonical).filter(Boolean))];
}
function providerEntity(query: string, clause: ClauseAnalysis, characters: LibraryEntry[], props: LibraryEntry[]): string | undefined {
  const normalized = canonical(query);
  if (!normalized) return undefined;
  const allowed = [...new Set([...clause.people, ...clause.objects, ...(clause.subject ? [clause.subject] : []), ...clause.secondaryCandidates])];
  return allowed.find((id) => entityAliases(id, characters, props).includes(normalized));
}
function rankedLocalRecipes(clause: ClauseAnalysis, seed: number, phraseId: string): string[] {
  const tiers: string[][] = [];
  const actionIds = new Set(clause.actions);
  if (clause.subject && clause.objects.includes(clause.subject)) tiers.push(['insert_prop', 'prop_ecu', 'top_down_insert']);
  if ([...actionIds].some((id) => LOCOMOTION_ACTIONS.has(id))) tiers.push(['chase_cam', 'whip_pan']);
  if ([...actionIds].some((id) => REACTION_ACTIONS.has(id))) tiers.push(['reaction_punch_in', 'hook_closeup']);
  if ([...actionIds].some((id) => OVERHEAD_ACTIONS.has(id))) tiers.push(['top_down', 'low_angle_reveal']);
  if (actionIds.has('look_at') || actionIds.has('look_around') || actionIds.has('point')) tiers.push(['pov', 'over_shoulder']);
  if (clause.secondaryCandidates.length) tiers.push(['over_shoulder', 'two_shot', 'whip_pan']);
  tiers.push(['medium_single', 'frontal_medium', 'slow_push_in', 'hook_closeup', 'low_angle_hero', 'wide_environment', 'top_down']);
  const seen = new Set<string>();
  return tiers.flatMap((tier, tierIndex) => [...tier].sort((a, b) => hash32(`${seed}:${phraseId}:${clause.index}:${tierIndex}:${a}`) - hash32(`${seed}:${phraseId}:${clause.index}:${tierIndex}:${b}`)))
    .filter((id) => { if (seen.has(id)) return false; seen.add(id); return true; });
}

function chooseClauseShot(
  clause: ClauseAnalysis,
  previous: CameraSpec,
  hint: ProviderShotHint | undefined,
  characters: LibraryEntry[],
  props: LibraryEntry[],
  availableRecipes: Set<string>,
  seed: number,
  phraseId: string,
): { shot: CameraSpec; source: 'local' | 'provider'; providerHint: 'none' | 'accepted' | 'rebuilt' } | null {
  const objectIds = new Set(props.map((prop) => prop.id));
  if (hint) {
    const subject = providerEntity(hint.subject, clause, characters, props);
    const secondary = hint.secondary.trim() ? providerEntity(hint.secondary, clause, characters, props) : undefined;
    const secondaryValid = !hint.secondary.trim() || Boolean(secondary);
    if (subject && secondaryValid && subject !== secondary && availableRecipes.has(hint.recipe) && recipeCompatible(hint.recipe, subject, secondary, objectIds)) {
      const shot = { recipeId: hint.recipe, subject, ...(secondary ? { secondary } : {}) };
      if (!nearIdentical(previous, shot)) return { shot, source: 'provider', providerHint: 'accepted' };
    }
  }
  if (!clause.subject) return null;
  for (const recipeId of rankedLocalRecipes(clause, seed, phraseId)) {
    if (!availableRecipes.has(recipeId)) continue;
    const secondary = clause.secondaryCandidates[0];
    const includeSecondary = Boolean(secondary && (PAIR_REQUIRED_RECIPES.has(recipeId) || ['pov', 'whip_pan', 'two_shot', 'over_shoulder'].includes(recipeId)));
    const shot = { recipeId, subject: clause.subject, ...(includeSecondary ? { secondary } : {}) };
    if (!recipeCompatible(recipeId, shot.subject, shot.secondary, objectIds) || nearIdentical(previous, shot)) continue;
    return { shot, source: 'local', providerHint: hint ? 'rebuilt' : 'none' };
  }
  return null;
}

interface TimedCandidate { clause: ClauseAnalysis; from: number }
function canCompleteCuts(candidates: TimedCandidate[], after: number, previous: number, remaining: number, end: number): boolean {
  const floor = DIRECTOR_EDIT_PLAN_POLICY.minimumSegmentSeconds;
  if (remaining === 0) return end - previous >= floor - 1e-9;
  for (let i = after; i < candidates.length; i++) {
    if (candidates[i].from - previous < floor - 1e-9) continue;
    if (canCompleteCuts(candidates, i + 1, candidates[i].from, remaining - 1, end)) return true;
  }
  return false;
}
function selectTimedCuts(candidates: TimedCandidate[], start: number, end: number, segmentCount: number, seed: number, phraseId: string): TimedCandidate[] | null {
  const chosen: TimedCandidate[] = [];
  let previous = start, after = 0;
  for (let step = 1; step < segmentCount; step++) {
    const target = start + (end - start) * step / segmentCount;
    const remaining = segmentCount - step - 1;
    const ranked = candidates.map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate, index }) => index >= after && candidate.from - previous >= DIRECTOR_EDIT_PLAN_POLICY.minimumSegmentSeconds - 1e-9 && canCompleteCuts(candidates, index + 1, candidate.from, remaining, end))
      .sort((a, b) => Math.abs(a.candidate.from - target) - Math.abs(b.candidate.from - target) || hash32(`${seed}:${phraseId}:cut:${a.candidate.clause.index}`) - hash32(`${seed}:${phraseId}:cut:${b.candidate.clause.index}`) || a.candidate.clause.index - b.candidate.clause.index);
    if (!ranked.length) return null;
    const next = ranked[0]; chosen.push(next.candidate); previous = next.candidate.from; after = next.index + 1;
  }
  return chosen;
}
function targetSegmentCount(duration: number, maximum: number): number {
  let best = 1, bestScore = Number.POSITIVE_INFINITY;
  for (let segments = 1; segments <= maximum; segments++) {
    const average = duration / segments;
    if (segments > 1 && average < DIRECTOR_EDIT_PLAN_POLICY.targetAverageSeconds.min - 1e-9) continue;
    const outside = average < DIRECTOR_EDIT_PLAN_POLICY.targetAverageSeconds.min ? DIRECTOR_EDIT_PLAN_POLICY.targetAverageSeconds.min - average
      : average > DIRECTOR_EDIT_PLAN_POLICY.targetAverageSeconds.max ? average - DIRECTOR_EDIT_PLAN_POLICY.targetAverageSeconds.max : 0;
    const score = outside * 100 + Math.abs(average - DIRECTOR_EDIT_PLAN_POLICY.targetAverageSeconds.preferred);
    if (score < bestScore - 1e-9) { best = segments; bestScore = score; }
  }
  return best;
}
const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

function planBeatEdits(input: {
  text: string; phraseId: string; start: number; end: number; seed: number; lib: Library;
  characters: LibraryEntry[]; props: LibraryEntry[]; active: LibraryEntry; main: CameraSpec; providerShots?: ProviderShotHint[];
}): { subShots: Array<{ from: number; recipeId: string; subject: string; secondary?: string }>; report: EditPlanBeatReport } {
  const clauses = analyzeClauses(input.text, input.characters, input.props, input.active, input.lib);
  const duration = input.end - input.start, wordCount = words(input.text).length;
  const floor = DIRECTOR_EDIT_PLAN_POLICY.minimumSegmentSeconds;
  const candidates = clauses.filter((clause) => clause.usefulCut && clause.subject).map((clause) => ({ clause, from: input.start + duration * clause.words[0] / wordCount }))
    .filter((candidate) => candidate.from - input.start >= floor - 1e-9 && input.end - candidate.from >= floor - 1e-9);
  const maximumSegments = Math.min(DIRECTOR_EDIT_PLAN_POLICY.maximumSubShots + 1, candidates.length + 1, Math.max(1, Math.floor(duration / floor + 1e-9)));
  const targetSegments = targetSegmentCount(duration, maximumSegments);
  let selected: TimedCandidate[] = [];
  for (let segments = targetSegments; segments >= 2; segments--) {
    const attempt = selectTimedCuts(candidates, input.start, input.end, segments, input.seed, input.phraseId);
    if (attempt) { selected = attempt; break; }
  }
  const hints = new Map((input.providerShots ?? []).map((hint) => [hint.clause, hint]));
  const availableRecipes = new Set(availableEntries('cameraRecipes', input.lib).map((entry) => entry.id));
  const cuts: PlannedCut[] = [];
  let previous = input.main;
  for (const candidate of selected) {
    const choice = chooseClauseShot(candidate.clause, previous, hints.get(candidate.clause.index), input.characters, input.props, availableRecipes, input.seed, input.phraseId);
    if (!choice) continue;
    cuts.push({ ...candidate, ...choice }); previous = choice.shot;
  }
  const cutByClause = new Map(cuts.map((cut) => [cut.clause.index, cut]));
  let composition = 0, current = input.main, currentSource: 'main' | 'local' | 'provider' = 'main';
  const clauseReports: EditPlanClauseReport[] = clauses.map((clause) => {
    const cut = cutByClause.get(clause.index);
    if (cut) { composition++; current = cut.shot; currentSource = cut.source; }
    const cueEntities = new Set([...clause.people, ...clause.objects, ...(clause.subject ? [clause.subject] : [])]);
    const covered = clause.visual && framedEntities(current).some((entity) => cueEntities.has(entity));
    const providerHint = cut?.providerHint ?? (hints.has(clause.index) ? 'not_selected' : 'none');
    return {
      index: clause.index, text: clause.text, words: clause.words, boundary: clause.boundary,
      cues: { people: clause.people, objects: clause.objects, actions: clause.actions, pronouns: clause.pronouns },
      visual: clause.visual, covered, ...(clause.subjectBasis ? { subjectBasis: clause.subjectBasis } : {}), composition,
      shot: { ...current, source: currentSource }, providerHint,
    };
  });
  const times = [input.start, ...cuts.map((cut) => cut.from), input.end];
  const segmentDurations = times.slice(1).map((time, index) => time - times[index]);
  const segmentShots = [
    { clause: 0, shot: input.main, source: 'main' as const },
    ...cuts.map((cut) => ({ clause: cut.clause.index, shot: cut.shot, source: cut.source })),
  ];
  const segments: EditPlanSegmentReport[] = segmentShots.map((segment, index) => ({
    index, start: times[index], end: times[index + 1], duration: round6(segmentDurations[index]), clause: segment.clause,
    ...segment.shot, source: segment.source,
  }));
  const averageSegmentSeconds = duration / (cuts.length + 1);
  const visualClauses = clauseReports.filter((clause) => clause.visual).length;
  const coveredVisualClauses = clauseReports.filter((clause) => clause.visual && clause.covered).length;
  return {
    subShots: cuts.map((cut) => ({ from: cut.from, ...cut.shot })),
    report: {
      beat: input.phraseId, clauses: clauseReports, segments, candidateCuts: candidates.length, targetSegments,
      actualSegments: cuts.length + 1, averageSegmentSeconds: round6(averageSegmentSeconds), shortestSegmentSeconds: round6(Math.min(...segmentDurations)),
      targetAverageMet: averageSegmentSeconds >= DIRECTOR_EDIT_PLAN_POLICY.targetAverageSeconds.min - 1e-9 && averageSegmentSeconds <= DIRECTOR_EDIT_PLAN_POLICY.targetAverageSeconds.max + 1e-9,
      visualClauses, coveredVisualClauses,
    },
  };
}

interface BuildState {
  matches: MatchDecision[];
  substitutions: AssetSubstitution[];
  missingAssets: MissingAsset[];
  missingKeys: Set<string>;
}
function missing(state: BuildState, item: MissingAsset): void {
  const key = `${item.kind}:${item.beat ?? ''}:${item.requested}`;
  if (!state.missingKeys.has(key)) {
    state.missingKeys.add(key);
    state.missingAssets.push({ kind: item.kind, requested: item.requested, reason: item.reason, ...(item.beat ? { beat: item.beat } : {}) });
  }
}
function noteUnknownProviderTerms(kind: MatchKind, terms: string[], beat: string | undefined, lib: Library, state: BuildState): void {
  const hints = terms.map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < hints.length; i++) {
    // Provider text is intentionally never copied into diagnostics: a hostile endpoint could reflect the bearer key.
    if (!candidates(kind, [{ text: hints[i], source: 'provider' }], lib, 0, `hint:${beat ?? 'global'}`).length) {
      missing(state, { kind, requested: `[unmatched provider hint ${i + 1}]`, beat, reason: 'provider intent has no matching library id or tag; raw hint omitted' });
    }
  }
}

function chooseOne(kind: MatchKind, queries: Query[], fallbackId: string, beat: string | undefined, lib: Library, seed: number, state: BuildState): LibraryEntry | SetEntry {
  const all = candidates(kind, queries, lib, seed, `${beat ?? 'global'}:${kind}`);
  const authored = all.filter((c) => c.entry.status === 'available');
  const requested = all[0];
  const chosen = authored[0]?.entry ?? requiredDefault(kind, fallbackId, lib);
  const selected = authored[0];
  if (requested?.entry.status === 'planned' && requested.entry.id !== chosen.id) {
    missing(state, { kind, requested: requested.entry.id, beat, reason: 'matching library asset is planned, not available' });
    state.substitutions.push({ kind, requested: requested.entry.id, used: chosen.id, reason: 'planned assets cannot be emitted by the available-only Director', ...(beat ? { beat } : {}) });
  } else if (!requested) {
    state.substitutions.push({ kind, requested: 'no matching library tag', used: chosen.id, reason: 'deterministic available fallback', ...(beat ? { beat } : {}) });
  }
  state.matches.push({ kind, selected: chosen.id, source: selected?.source ?? 'default', ...(selected?.tag ? { matchedTag: selected.tag } : {}), ...(beat ? { beat } : {}) });
  return chosen;
}

function chooseMany(kind: 'characters' | 'props', queries: Query[], max: number, beat: string | undefined, lib: Library, seed: number, state: BuildState): LibraryEntry[] {
  const all = candidates(kind, queries, lib, seed, `${beat ?? 'global'}:${kind}`);
  for (const c of all.filter((x) => x.entry.status === 'planned')) missing(state, { kind, requested: c.entry.id, beat, reason: 'matching library asset is planned, not available' });
  const chosen: Candidate[] = [];
  const claimed = new Set<string>();
  for (const c of all) {
    if (c.entry.status !== 'available') continue;
    const claim = `${c.source}:${canonical(c.tag)}`;
    if (claimed.has(claim)) continue; // one deterministic winner for ambiguous shared tags such as "friend"
    claimed.add(claim); chosen.push(c);
    if (chosen.length === max) break;
  }
  const availableCount = all.filter((c) => c.entry.status === 'available').length;
  if (availableCount > chosen.length && chosen.length === max) missing(state, { kind, requested: `${availableCount - chosen.length} additional matches`, beat, reason: `BeatSheet capacity is ${max}` });
  for (const c of chosen) state.matches.push({ kind, selected: c.entry.id, matchedTag: c.tag, source: c.source, ...(beat ? { beat } : {}) });
  return chosen.map((c) => c.entry as LibraryEntry);
}

function pickMark(set: SetEntry, entry: LibraryEntry, used: Set<string>, seed: number, scope: string): string {
  if (!set.marks.length) throw new DirectorInputError(`available set ${set.id} has no placement marks`);
  const qs = [entry.id.replace(/_/g, ' '), ...entry.tags];
  const ranked = set.marks.map((mark) => ({ mark, score: Math.max(0, ...qs.map((q) => matchTag(mark.replace(/_/g, ' '), q))), tie: hash32(`${seed}:${scope}:${mark}`) }))
    .sort((a, b) => Number(used.has(a.mark)) - Number(used.has(b.mark)) || b.score - a.score || a.tie - b.tie || a.mark.localeCompare(b.mark));
  used.add(ranked[0].mark);
  return ranked[0].mark;
}

function titleFrom(line: string): string {
  if (line.length <= 120) return line;
  const cut = line.slice(0, 117), space = cut.lastIndexOf(' ');
  return `${cut.slice(0, Math.max(1, space > 98 ? space : 117)).trimEnd()}...`;
}
function idFor(req: NormalizedDirectorRequest): string {
  return `directed_${hash32(`${req.seed}\n${req.duration}\n${req.lines.join('\n')}`).toString(16).padStart(8, '0')}`;
}

export interface OfflineBuildOptions {
  library?: Library;
  intent?: DirectorIntent;
  provider?: DirectorProviderReport;
}

export function generateOfflineBeatSheet(input: DirectorRequest | NormalizedDirectorRequest, options: OfflineBuildOptions = {}): DirectorResult {
  const req = 'lines' in input ? input : normalizeDirectorRequest(input);
  const lib = options.library ?? LIBRARY;
  const state: BuildState = { matches: [], substitutions: [], missingAssets: [], missingKeys: new Set() };
  const provider = options.provider ?? { requested: 'offline', used: 'offline', attempts: [] };
  const scriptQuery: Query[] = [{ text: req.lines.join(' '), source: 'script' }];
  if (options.intent?.set) scriptQuery.unshift({ text: options.intent.set, source: 'provider' });
  noteUnknownProviderTerms('sets', options.intent?.set ? [options.intent.set] : [], undefined, lib, state);
  noteUnknownProviderTerms('characters', options.intent?.characters ?? [], undefined, lib, state);

  const set = chooseOne('sets', scriptQuery, 'classroom', undefined, lib, req.seed, state) as SetEntry;
  if (!set.marks.length || !set.lighting.length) throw new DirectorInputError(`available set ${set.id} is missing authored marks or lighting`);
  const characterQueries: Query[] = [
    ...(options.intent?.characters ?? []).map((text): Query => ({ text, source: 'provider' })),
    { text: req.lines.join(' '), source: 'script' },
  ];
  let characters = chooseMany('characters', characterQueries, 8, undefined, lib, req.seed, state);
  if (!characters.length) {
    const zapp = requiredDefault('characters', 'zapp', lib) as LibraryEntry;
    characters = [zapp];
    state.matches.push({ kind: 'characters', selected: zapp.id, source: 'default' });
    state.substitutions.push({ kind: 'characters', requested: 'no matching library tag', used: zapp.id, reason: 'deterministic available fallback' });
  }

  const phraseWords = req.lines.map(words);
  const totalWords = phraseWords.reduce((n, line) => n + line.length, 0);
  let elapsedWords = 0;
  let previousEntities = new Set<string>();
  const beats: BeatSheet['beats'] = [];
  const editBeats: EditPlanBeatReport[] = [];

  for (let i = 0; i < req.lines.length; i++) {
    const phraseId = `p${String(i + 1).padStart(2, '0')}`;
    const start = req.duration * elapsedWords / totalWords;
    elapsedWords += phraseWords[i].length;
    const end = i === req.lines.length - 1 ? req.duration : req.duration * elapsedWords / totalWords;
    const intentBeat = options.intent?.beats[i];
    const providerAction = intentBeat?.action?.trim() ? [intentBeat.action] : [];
    const providerProps = intentBeat?.props ?? [];
    noteUnknownProviderTerms('actions', providerAction, phraseId, lib, state);
    noteUnknownProviderTerms('props', providerProps, phraseId, lib, state);
    const lineQueries: Query[] = [
      ...providerAction.map((text): Query => ({ text, source: 'provider' })),
      { text: req.lines[i], source: 'script' },
    ];
    const action = chooseOne('actions', lineQueries, 'idle', phraseId, lib, req.seed, state) as LibraryEntry;
    const expression = chooseOne('expressions', [{ text: req.lines[i], source: 'script' }], 'neutral', phraseId, lib, req.seed, state) as LibraryEntry;
    const propQueries: Query[] = [
      ...providerProps.map((text): Query => ({ text, source: 'provider' })),
      { text: req.lines[i], source: 'script' },
    ];
    const props = chooseMany('props', propQueries, 16, phraseId, lib, req.seed, state);

    const mentioned = characters.filter((c) => candidates('characters', [{ text: req.lines[i], source: 'script' }], { ...lib, characters: [c] }, req.seed, phraseId).length);
    const active = mentioned[0] ?? characters[0];
    const orderedCharacters = [active, ...characters.filter((c) => c.id !== active.id)];
    const usedMarks = new Set<string>();
    const cast = orderedCharacters.map((character, ci) => {
      const other = orderedCharacters.find((x) => x.id !== character.id);
      const lookAt = ci === 0 ? (props[0]?.id ?? other?.id ?? 'camera') : active.id;
      return {
        characterId: latestRef(character),
        role: ci === 0 ? 'lead' as const : ci === 1 ? 'foil' as const : 'support' as const,
        placement: pickMark(set, character, usedMarks, req.seed, `${phraseId}:character:${character.id}`),
        actionId: ci === 0 ? action.id : 'idle',
        expressionId: ci === 0 ? expression.id : 'neutral',
        lookAt,
      };
    });
    const beatProps = props.map((prop) => ({
      propId: latestRef(prop),
      placement: pickMark(set, prop, usedMarks, req.seed, `${phraseId}:prop:${prop.id}`),
      state: 'idle',
    }));
    const cameraFallback = orderedCharacters.length > 1 ? 'two_shot' : 'medium_single';
    const camera = chooseOne('cameraRecipes', [{ text: req.lines[i], source: 'script' }], cameraFallback, phraseId, lib, req.seed, state) as LibraryEntry;
    const propSubject = props.length && /prop|insert|close/.test(camera.id) ? props[0].id : undefined;
    const subject = propSubject ?? active.id;
    const secondary = orderedCharacters.map((x) => x.id).find((id) => id !== subject);

    const groups = captionGroups(req.lines[i]);
    let captionWords = 0;
    const captions = groups.map((group, ci) => {
      const captionStart = start + (end - start) * captionWords / phraseWords[i].length;
      captionWords += group.length;
      return { start: captionStart, end: ci === groups.length - 1 ? end : start + (end - start) * captionWords / phraseWords[i].length, text: group.join(' ') };
    });
    const entities = new Set([...orderedCharacters.map((x) => x.id), ...props.map((x) => x.id)]);
    const carryOver = i === 0 ? [] : [...entities].filter((id) => previousEntities.has(id));
    previousEntities = entities;
    const editPlan = planBeatEdits({
      text: req.lines[i], phraseId, start, end, seed: req.seed, lib,
      characters: orderedCharacters, props, active,
      main: { recipeId: camera.id, subject, ...(secondary ? { secondary } : {}) },
      ...(intentBeat?.shots ? { providerShots: intentBeat.shots } : {}),
    });
    editBeats.push(editPlan.report);
    beats.push({
      phraseId, start, end, text: req.lines[i], setId: latestRef(set), lighting: set.lighting[req.seed % set.lighting.length],
      cast, props: beatProps, events: [],
      camera: { recipeId: camera.id, subject, ...(secondary ? { secondary } : {}), ...(editPlan.subShots.length ? { subShots: editPlan.subShots } : {}) },
      captions, carryOver,
    });
  }

  const id = idFor(req);
  const sheet: BeatSheet = {
    schemaVersion: '1.0', id, title: titleFrom(req.lines[0]), seed: req.seed,
    source: { narrated: 'director:raw-script', narratedId: `dir-${id.slice('directed_'.length)}` },
    music: [], beats,
  };
  const validation = validateBeatSheet(sheet, { library: lib, requireAvailable: true });
  const visualClauses = editBeats.reduce((sum, beat) => sum + beat.visualClauses, 0);
  const coveredVisualClauses = editBeats.reduce((sum, beat) => sum + beat.coveredVisualClauses, 0);
  const report: DirectorReport = {
    algorithmVersion: DIRECTOR_ALGORITHM_VERSION,
    provider,
    matches: state.matches,
    substitutions: state.substitutions,
    missingAssets: state.missingAssets,
    editPlan: {
      policy: DIRECTOR_EDIT_PLAN_POLICY,
      coverage: {
        version: DIRECTOR_EDIT_PLAN_POLICY.coverageVersion,
        visualClauses,
        coveredVisualClauses,
        pct: visualClauses ? coveredVisualClauses / visualClauses : 1,
      },
      beats: editBeats,
    },
    validation: { ok: validation.ok, issues: validation.issues },
  };
  if (!validation.ok) throw new DirectorInputError(`generated BeatSheet failed validation: ${validation.issues.slice(0, 3).map((x) => `${x.path} ${x.message}`).join('; ')}`);
  return { sheet, report };
}
