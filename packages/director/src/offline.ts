// Deterministic, browser-safe script-to-BeatSheet Director.
// Remote intent is advisory only: every final choice is resolved through the local capability library.
import { LIBRARY, type Library, type LibraryEntry, type SetEntry } from '../../library/src/ids.ts';
import { ENVIRONMENT_CATALOG, type EnvironmentProfile } from '../../environments/src/index.ts';
import { validateBeatSheet, type BeatSheet } from './beat-sheet.ts';
import type { DirectorIntent } from './intent.ts';

export const DIRECTOR_EDIT_PLAN_POLICY = {
  version: 'clause-edit-v2',
  coverageVersion: 'realization-coverage-v2',
  minimumSegmentSeconds: 0.6,
  targetAverageSeconds: { min: 1.2, preferred: 1.7, max: 2.2 },
  maximumSubShots: 4,
} as const;
export const DIRECTOR_ALGORITHM_VERSION = 'director-v3-generalized-v1';
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
  entityFramed: boolean;
  actionRealized: boolean;
  propStateRealized: boolean;
  subjectBasis?: 'person' | 'object' | 'pronoun' | 'action';
  composition: number;
  shot: { recipeId: string; subject: string; secondary?: string; source: 'main' | 'local' | 'provider' };
  providerHint: 'none' | 'accepted' | 'rebuilt' | 'not_selected';
}
export interface RealizationCoverage {
  required: number;
  realized: number;
  pct: number;
}
export interface UnresolvedConceptCoverage extends RealizationCoverage {
  unresolved: number;
  diagnosed: number;
}
export interface ConceptDiagnostic {
  term: string;
  category: 'entity' | 'place' | 'prop';
  disposition: 'missing' | 'approved_substitution' | 'authorization_blocker';
  reason: string;
  beat: string;
  substitute?: string;
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
  entityCueClauses: number;
  framedEntityClauses: number;
  actionCueClauses: number;
  realizedActionClauses: number;
  propStateCueClauses: number;
  realizedPropStateClauses: number;
}
export interface DirectorEditPlanReport {
  policy: typeof DIRECTOR_EDIT_PLAN_POLICY;
  coverage: {
    version: typeof DIRECTOR_EDIT_PLAN_POLICY.coverageVersion;
    entityFramingCoverage: RealizationCoverage;
    actionRealizationCoverage: RealizationCoverage;
    propStateRealizationCoverage: RealizationCoverage;
    unresolvedConceptCoverage: UnresolvedConceptCoverage;
  };
  beats: EditPlanBeatReport[];
}
export interface DirectorReport {
  algorithmVersion: string;
  provider: DirectorProviderReport;
  matches: MatchDecision[];
  substitutions: AssetSubstitution[];
  missingAssets: MissingAsset[];
  conceptDiagnostics: ConceptDiagnostic[];
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
  if (!Number.isFinite(input.duration) || input.duration <= 0 || input.duration > 300) throw new DirectorInputError('duration must be greater than 0 and at most 300 seconds');
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
        if (kind === 'actions' && q.source === 'script' && NON_VERBAL_ACTION_TAGS.has(canonical(tag))) continue;
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
const CAST_PRONOUNS = new Set([...PERSON_PRONOUNS, 'his', 'hers', 'himself', 'herself', 'themselves']);
const INTERACTION_ACTIONS = new Set(['chase', 'push', 'grab', 'tug', 'point', 'look_at', 'turn_toward']);
const PROP_STATE_ACTIONS = new Set(['pick_up', 'grab', 'hold', 'put_down', 'throw', 'drink', 'use_phone', 'eat', 'press_button', 'open_door', 'slam_door', 'type_laptop']);
const REQUIRED_PROP_ACTIONS = new Set([...PROP_STATE_ACTIONS].filter((action) => action !== 'grab'));
const MOTION_ACTIONS = new Set(['walk', 'run', 'chase', 'sneak', 'enter_frame', 'exit_frame', 'enter_door', 'exit_door']);
const CONCEPT_DETERMINERS = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'another', 'his', 'her', 'their', 'our', 'my', 'your']);
const PLACE_PREPOSITIONS = new Set(['at', 'in', 'inside', 'into', 'outside', 'near']);
const CONCEPT_FILLERS = new Set(['big', 'small', 'tiny', 'giant', 'new', 'old', 'red', 'blue', 'green', 'flying', 'broken', 'shiny', 'wooden', 'metal', 'toy', 'huge']);
const GRAMMAR_WORDS = new Set([
  ...CONCEPT_DETERMINERS, ...PLACE_PREPOSITIONS, ...CAST_PRONOUNS, ...OBJECT_PRONOUNS, ...CLAUSE_CONJUNCTIONS,
  'to', 'from', 'with', 'without', 'of', 'on', 'under', 'over', 'through', 'across', 'past', 'by', 'for', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'and', 'or', 'not', 'very', 'quietly', 'quickly', 'slowly', 'suddenly', 'later', 'finally', 'again',
]);
/** Broad, deterministic visibility vocabulary supplements syntax-based noun extraction; it is not asset authorization. */
const VISIBLE_CONCEPTS: Readonly<Record<string, ConceptDiagnostic['category']>> = {
  drone: 'prop', microwave: 'prop', skateboard: 'prop', spaceship: 'prop', robot: 'entity', airplane: 'prop', dragon: 'entity',
  bicycle: 'prop', motorcycle: 'prop', scooter: 'prop', helicopter: 'prop', train: 'prop', boat: 'prop', rocket: 'prop',
  dinosaur: 'entity', alien: 'entity', monster: 'entity', dog: 'entity', cat: 'entity', horse: 'entity', bird: 'entity',
  sword: 'prop', shield: 'prop', camera: 'prop', guitar: 'prop', piano: 'prop', toaster: 'prop', blender: 'prop',
  bathroom: 'place', kitchen: 'place', bedroom: 'place', office: 'place', airport: 'place', beach: 'place', forest: 'place',
  castle: 'place', spaceship_interior: 'place', restaurant: 'place', hospital: 'place', garage: 'place', stadium: 'place',
};

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

function selectedEnvironmentProfile(set: SetEntry): EnvironmentProfile {
  const version = set.versions?.at(-1);
  const profile = ENVIRONMENT_CATALOG.profiles.find((candidate) => candidate.id === set.id && candidate.version === version);
  if (!profile) throw new DirectorInputError(`available set ${latestRef(set)} has no actor-safe placement metadata`);
  return profile;
}
function actorSafeMarks(set: SetEntry, profile: EnvironmentProfile): string[] {
  const authored = new Set(set.marks);
  const safe = profile.marks
    .filter((mark) => authored.has(mark.id) && mark.kind === 'actor' && mark.occupancy > 0 && mark.postures.includes('stand') && mark.hazard.kind === 'none')
    .map((mark) => mark.id);
  if (!safe.length) throw new DirectorInputError(`available set ${latestRef(set)} has no non-hazard actor placement marks`);
  return safe;
}
function setDimensions(profile: EnvironmentProfile): { width: number; depth: number; maxCastFraming: number; topDown: boolean } {
  return {
    width: profile.bounds.max[0] - profile.bounds.min[0],
    depth: profile.bounds.max[2] - profile.bounds.min[2],
    maxCastFraming: Math.max(...profile.cameraZones.safeVolumes.map((zone) => zone.maxCastFraming)),
    topDown: profile.cameraZones.safeVolumes.some((zone) => zone.topDownAllowed),
  };
}
function mentionedCharacters(text: string, characters: LibraryEntry[]): LibraryEntry[] {
  const hits = literalHits(characters, words(text));
  return uniqueIds(hits).map((id) => characters.find((character) => character.id === id)!).filter(Boolean);
}
function beatCharacters(text: string, available: LibraryEntry[], previousPerson: LibraryEntry | undefined, actionId: string, maxCast: number): LibraryEntry[] {
  const explicit = mentionedCharacters(text, available);
  const tokens = canonicalWords(text);
  const firstNamedWord = literalHits(available, words(text))[0]?.startWord ?? Number.POSITIVE_INFINITY;
  const firstPronounWord = tokens.findIndex((word) => CAST_PRONOUNS.has(word));
  const pronounLeads = firstPronounWord >= 0 && firstPronounWord < firstNamedWord;
  const selected = pronounLeads && previousPerson ? [previousPerson, ...explicit.filter((character) => character.id !== previousPerson.id)] : [...explicit];
  // A local named antecedent wins over a later possessive/object pronoun ("Kira grabs her phone").
  if (firstPronounWord >= 0 && explicit.length === 0 && previousPerson && !selected.some((character) => character.id === previousPerson.id)) selected.push(previousPerson);
  if (INTERACTION_ACTIONS.has(actionId) && !explicit.length && previousPerson && !selected.some((character) => character.id === previousPerson.id)) selected.push(previousPerson);
  if (!selected.length) selected.push(previousPerson ?? available[0]);
  return selected.slice(0, maxCast);
}

function allConceptEntries(lib: Library): Array<{ kind: 'sets' | 'characters' | 'props'; entry: LibraryEntry | SetEntry }> {
  return (['sets', 'characters', 'props'] as const).flatMap((kind) => (lib[kind] as Array<LibraryEntry | SetEntry>).map((entry) => ({ kind, entry })));
}
function conceptMatch(term: string, lib: Library): { kind: 'sets' | 'characters' | 'props'; entry: LibraryEntry | SetEntry } | undefined {
  return allConceptEntries(lib).find(({ entry }) => [entry.id.replace(/_/g, ' '), ...entry.tags].some((tag) => canonical(tag) === canonical(term)));
}
const DIRECT_OBJECT_VERBS = new Set(['plays', 'play', 'finds', 'find', 'uses', 'use', 'holds', 'hold', 'grabs', 'grab', 'carries', 'carry', 'rides', 'ride', 'opens', 'open']);
const DESTINATION_VERBS = new Set(['enters', 'enter', 'visits', 'visit', 'reaches', 'reach', 'leaves', 'leave']);
function visibleConceptCandidates(text: string, lib: Library): Array<{ term: string; category: ConceptDiagnostic['category'] }> {
  const tokens = canonicalWords(text);
  const found = new Map<string, ConceptDiagnostic['category']>();
  const priority = (category: ConceptDiagnostic['category']) => category === 'place' ? 3 : category === 'entity' ? 2 : 1;
  const availableMeaning = (term: string) => (['sets', 'characters', 'props', 'actions', 'expressions'] as const)
    .some((kind) => availableEntries(kind, lib).some((entry) => [entry.id.replace(/_/g, ' '), ...entry.tags].some((tag) => canonical(tag) === term)));
  const add = (term: string, category: ConceptDiagnostic['category']) => {
    const normalized = canonical(term);
    const matched = conceptMatch(normalized, lib);
    const current = found.get(normalized);
    if (normalized && !GRAMMAR_WORDS.has(normalized) && !CONCEPT_FILLERS.has(normalized) && !availableMeaning(normalized)
      && matched?.entry.status !== 'available' && (!current || priority(category) > priority(current))) found.set(normalized, category);
  };
  for (const token of tokens) if (VISIBLE_CONCEPTS[token]) add(token, VISIBLE_CONCEPTS[token]);
  for (let i = 0; i < tokens.length; i++) {
    if (i < tokens.length - 1 && CONCEPT_DETERMINERS.has(tokens[i])) {
      let at = i + 1;
      while (at < tokens.length - 1 && (CONCEPT_FILLERS.has(tokens[at]) || availableMeaning(tokens[at]))) at++;
      add(tokens[at], PLACE_PREPOSITIONS.has(tokens[Math.max(0, i - 1)]) ? 'place' : 'prop');
    }
    if (PLACE_PREPOSITIONS.has(tokens[i])) {
      let at = i + 1;
      if (CONCEPT_DETERMINERS.has(tokens[at])) at++;
      while (at < tokens.length - 1 && (CONCEPT_FILLERS.has(tokens[at]) || availableMeaning(tokens[at]))) at++;
      if (tokens[at]) add(tokens[at], 'place');
    }
    if ((DIRECT_OBJECT_VERBS.has(tokens[i]) || DESTINATION_VERBS.has(tokens[i])) && tokens[i + 1]) {
      let at = i + 1;
      if (CONCEPT_DETERMINERS.has(tokens[at])) at++;
      while (at < tokens.length - 1 && (CONCEPT_FILLERS.has(tokens[at]) || availableMeaning(tokens[at]))) at++;
      add(tokens[at], DESTINATION_VERBS.has(tokens[i]) ? 'place' : 'prop');
    }
  }
  const actionHits = literalHits(availableEntries('actions', lib), words(text)).sort((a, b) => a.startWord - b.startWord);
  const firstAction = actionHits[0];
  if (firstAction?.startWord) {
    const subject = tokens.slice(0, firstAction.startWord).filter((token) => !GRAMMAR_WORDS.has(token) && !CONCEPT_FILLERS.has(token)).at(-1);
    if (subject) add(subject, 'entity');
  }
  return [...found].map(([term, category]) => ({ term, category }));
}

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
interface RecipeConstraints { castCount: number; motion: boolean; width: number; depth: number; maxCastFraming: number; topDown: boolean }
function recipeCompatible(recipeId: string, subject: string, secondary: string | undefined, objectIds: Set<string>, constraints?: RecipeConstraints): boolean {
  if (PROP_ONLY_RECIPES.has(recipeId) && !objectIds.has(subject)) return false;
  if (PAIR_REQUIRED_RECIPES.has(recipeId) && !(secondary && secondary !== subject)) return false;
  if (!constraints) return true;
  const span = Math.max(constraints.width, constraints.depth);
  if (recipeId === 'chase_cam' && (!constraints.motion || span < 6)) return false;
  if (recipeId === 'whip_pan' && (!(secondary && secondary !== subject) || span < 5)) return false;
  if (['establishing_wide', 'wide_environment', 'two_shot'].includes(recipeId) && constraints.castCount > constraints.maxCastFraming) return false;
  if (['top_down', 'top_down_insert'].includes(recipeId) && !constraints.topDown) return false;
  return true;
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
  constraints: RecipeConstraints,
): { shot: CameraSpec; source: 'local' | 'provider'; providerHint: 'none' | 'accepted' | 'rebuilt' } | null {
  const objectIds = new Set(props.map((prop) => prop.id));
  if (hint) {
    const subject = providerEntity(hint.subject, clause, characters, props);
    const secondary = hint.secondary.trim() ? providerEntity(hint.secondary, clause, characters, props) : undefined;
    const secondaryValid = !hint.secondary.trim() || Boolean(secondary);
    if (subject && secondaryValid && subject !== secondary && availableRecipes.has(hint.recipe) && recipeCompatible(hint.recipe, subject, secondary, objectIds, constraints)) {
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
    if (!recipeCompatible(recipeId, shot.subject, shot.secondary, objectIds, constraints) || nearIdentical(previous, shot)) continue;
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
  characters: LibraryEntry[]; props: LibraryEntry[]; active: LibraryEntry; main: CameraSpec; emittedAction: string; constraints: RecipeConstraints; providerShots?: ProviderShotHint[];
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
    const choice = chooseClauseShot(candidate.clause, previous, hints.get(candidate.clause.index), input.characters, input.props, availableRecipes, input.seed, input.phraseId, input.constraints);
    if (!choice) continue;
    cuts.push({ ...candidate, ...choice }); previous = choice.shot;
  }
  const cutByClause = new Map(cuts.map((cut) => [cut.clause.index, cut]));
  let composition = 0, current = input.main, currentSource: 'main' | 'local' | 'provider' = 'main';
  const clauseReports: EditPlanClauseReport[] = clauses.map((clause) => {
    const cut = cutByClause.get(clause.index);
    if (cut) { composition++; current = cut.shot; currentSource = cut.source; }
    const cueEntities = new Set([...clause.people, ...clause.objects, ...(clause.subject ? [clause.subject] : [])]);
    const hasEntityCue = clause.people.length > 0 || clause.objects.length > 0;
    const framed = new Set(framedEntities(current));
    const entityFramed = hasEntityCue && [...cueEntities].every((entity) => framed.has(entity));
    const actionRealized = clause.actions.includes(input.emittedAction) && clause.subject === input.active.id;
    // BeatSheet prop state is currently "idle"; merely framing a prop must never claim its narrated state change occurred.
    const propStateRequired = clause.objects.length > 0 && clause.actions.some((action) => PROP_STATE_ACTIONS.has(action));
    const propStateRealized = false;
    const providerHint = cut?.providerHint ?? (hints.has(clause.index) ? 'not_selected' : 'none');
    return {
      index: clause.index, text: clause.text, words: clause.words, boundary: clause.boundary,
      cues: { people: clause.people, objects: clause.objects, actions: clause.actions, pronouns: clause.pronouns },
      visual: clause.visual, entityFramed, actionRealized, propStateRealized: propStateRequired && propStateRealized,
      ...(clause.subjectBasis ? { subjectBasis: clause.subjectBasis } : {}), composition,
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
  const entityCueClauses = clauseReports.filter((clause) => clause.cues.people.length || clause.cues.objects.length).length;
  const framedEntityClauses = clauseReports.filter((clause) => clause.entityFramed).length;
  const actionCueClauses = clauseReports.filter((clause) => clause.cues.actions.length).length;
  const realizedActionClauses = clauseReports.filter((clause) => clause.actionRealized).length;
  const propStateCueClauses = clauseReports.filter((clause) => clause.cues.objects.length && clause.cues.actions.some((action) => PROP_STATE_ACTIONS.has(action))).length;
  const realizedPropStateClauses = clauseReports.filter((clause) => clause.propStateRealized).length;
  return {
    subShots: cuts.map((cut) => ({ from: cut.from, ...cut.shot })),
    report: {
      beat: input.phraseId, clauses: clauseReports, segments, candidateCuts: candidates.length, targetSegments,
      actualSegments: cuts.length + 1, averageSegmentSeconds: round6(averageSegmentSeconds), shortestSegmentSeconds: round6(Math.min(...segmentDurations)),
      targetAverageMet: averageSegmentSeconds >= DIRECTOR_EDIT_PLAN_POLICY.targetAverageSeconds.min - 1e-9 && averageSegmentSeconds <= DIRECTOR_EDIT_PLAN_POLICY.targetAverageSeconds.max + 1e-9,
      entityCueClauses, framedEntityClauses, actionCueClauses, realizedActionClauses, propStateCueClauses, realizedPropStateClauses,
    },
  };
}

interface BuildState {
  matches: MatchDecision[];
  substitutions: AssetSubstitution[];
  missingAssets: MissingAsset[];
  conceptDiagnostics: ConceptDiagnostic[];
  conceptRequirements: Set<string>;
  missingKeys: Set<string>;
  conceptKeys: Set<string>;
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
function diagnoseVisibleConcepts(text: string, beat: string, selectedSet: SetEntry, lib: Library, state: BuildState): void {
  for (const concept of visibleConceptCandidates(text, lib)) {
    const key = `${beat}:${concept.term}`;
    state.conceptRequirements.add(key);
    if (state.conceptKeys.has(key)) continue;
    state.conceptKeys.add(key);
    const matched = conceptMatch(concept.term, lib);
    const kind: MatchKind = matched?.kind ?? (concept.category === 'place' ? 'sets' : concept.category === 'entity' ? 'characters' : 'props');
    if (matched?.entry.status === 'planned') {
      const substitute = matched.kind === 'sets' ? selectedSet.id : undefined;
      const diagnostic: ConceptDiagnostic = {
        term: concept.term, category: concept.category, disposition: substitute ? 'approved_substitution' : 'missing', beat,
        reason: substitute ? 'matching catalog concept is planned; deterministic available set substitution recorded' : 'matching catalog concept is planned, not available',
        ...(substitute ? { substitute } : {}),
      };
      state.conceptDiagnostics.push(diagnostic);
      missing(state, { kind, requested: matched.entry.id, beat, reason: 'visible script concept matches a planned, unavailable asset' });
    } else {
      state.conceptDiagnostics.push({ term: concept.term, category: concept.category, disposition: 'missing', beat, reason: 'visible script concept has no authorized available library asset' });
      missing(state, { kind, requested: concept.term, beat, reason: 'unsupported visible script concept; no authorized available library asset or approved substitution' });
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

function pickMark(set: SetEntry, entry: LibraryEntry, used: Set<string>, seed: number, scope: string, allowedMarks: readonly string[] = set.marks, profile?: EnvironmentProfile, requireFree = false): string {
  if (!allowedMarks.length) throw new DirectorInputError(`available set ${set.id} has no eligible placement marks`);
  const free = allowedMarks.filter((mark) => !used.has(mark));
  if (requireFree && !free.length) throw new DirectorInputError(`available set ${set.id} has no conflict-free actor placement remaining for ${entry.id}`);
  const pool = free.length ? free : allowedMarks;
  const qs = [entry.id.replace(/_/g, ' '), ...entry.tags];
  const ranked = pool.map((mark) => ({ mark, score: Math.max(0, ...qs.map((q) => matchTag(mark.replace(/_/g, ' '), q))), tie: hash32(`${seed}:${scope}:${mark}`) }))
    .sort((a, b) => b.score - a.score || a.tie - b.tie || (a.mark < b.mark ? -1 : a.mark > b.mark ? 1 : 0));
  const selected = ranked[0].mark;
  used.add(selected);
  if (profile) {
    const meta = profile.marks.find((mark) => mark.id === selected);
    const canonicalMark = meta?.aliasOf ?? selected;
    for (const mark of profile.marks) {
      const samePhysicalMark = mark.id === canonicalMark || (mark.aliasOf ?? mark.id) === canonicalMark;
      const exclusive = meta?.exclusiveWith.includes(mark.id) || mark.exclusiveWith.includes(selected);
      if (samePhysicalMark || exclusive) used.add(mark.id);
    }
    for (const id of meta?.exclusiveWith ?? []) used.add(id);
  }
  return selected;
}

function chooseMainCamera(input: {
  text: string; beat: string; active: LibraryEntry; characters: LibraryEntry[]; props: LibraryEntry[]; actionId: string;
  dimensions: ReturnType<typeof setDimensions>; lib: Library; seed: number; state: BuildState;
}): CameraSpec {
  const constraints: RecipeConstraints = { castCount: input.characters.length, motion: MOTION_ACTIONS.has(input.actionId), ...input.dimensions };
  const objectIds = new Set(input.props.map((prop) => prop.id));
  const matched = candidates('cameraRecipes', [{ text: input.text, source: 'script' }], input.lib, input.seed, `${input.beat}:cameraRecipes`)
    .filter((candidate) => candidate.entry.status === 'available');
  const fallbacks = [constraints.motion ? 'chase_cam' : '', input.characters.length > 1 ? 'two_shot' : 'medium_single', 'medium_single', 'frontal_medium']
    .filter(Boolean)
    .map((id) => availableEntries('cameraRecipes', input.lib).find((entry) => entry.id === id))
    .filter((entry): entry is LibraryEntry => Boolean(entry));
  const ordered = [...matched.map((candidate) => candidate.entry as LibraryEntry), ...fallbacks]
    .filter((entry, index, list) => list.findIndex((candidate) => candidate.id === entry.id) === index);
  for (const recipe of ordered) {
    const subject = PROP_ONLY_RECIPES.has(recipe.id) ? input.props[0]?.id : input.active.id;
    if (!subject) continue;
    const secondary = input.characters.find((character) => character.id !== subject)?.id;
    if (!recipeCompatible(recipe.id, subject, secondary, objectIds, constraints)) continue;
    const selectedMatch = matched.find((candidate) => candidate.entry.id === recipe.id);
    input.state.matches.push({ kind: 'cameraRecipes', selected: recipe.id, source: selectedMatch?.source ?? 'default', ...(selectedMatch?.tag ? { matchedTag: selectedMatch.tag } : {}), beat: input.beat });
    if (matched[0] && matched[0].entry.id !== recipe.id) input.state.substitutions.push({
      kind: 'cameraRecipes', requested: matched[0].entry.id, used: recipe.id, beat: input.beat,
      reason: 'requested recipe is incompatible with local subject, cast, motion, set dimensions, or required prop',
    });
    return { recipeId: recipe.id, subject, ...(secondary ? { secondary } : {}) };
  }
  throw new DirectorInputError(`no compatible available camera recipe for ${input.beat}`);
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
  const state: BuildState = { matches: [], substitutions: [], missingAssets: [], conceptDiagnostics: [], conceptRequirements: new Set(), missingKeys: new Set(), conceptKeys: new Set() };
  const provider = options.provider ?? { requested: 'offline', used: 'offline', attempts: [] };
  const scriptQuery: Query[] = [{ text: req.lines.join(' '), source: 'script' }];
  if (options.intent?.set) scriptQuery.unshift({ text: options.intent.set, source: 'provider' });
  noteUnknownProviderTerms('sets', options.intent?.set ? [options.intent.set] : [], undefined, lib, state);
  noteUnknownProviderTerms('characters', options.intent?.characters ?? [], undefined, lib, state);

  const set = chooseOne('sets', scriptQuery, 'classroom', undefined, lib, req.seed, state) as SetEntry;
  if (!set.marks.length || !set.lighting.length) throw new DirectorInputError(`available set ${set.id} is missing authored marks or lighting`);
  const environment = selectedEnvironmentProfile(set);
  const safeActorMarks = actorSafeMarks(set, environment);
  const dimensions = setDimensions(environment);
  const characterQueries: Query[] = [
    ...(options.intent?.characters ?? []).map((text): Query => ({ text, source: 'provider' })),
    { text: req.lines.join(' '), source: 'script' },
  ];
  let scriptCharacters = chooseMany('characters', characterQueries, 8, undefined, lib, req.seed, state);
  if (!scriptCharacters.length) {
    const zapp = requiredDefault('characters', 'zapp', lib) as LibraryEntry;
    scriptCharacters = [zapp];
    state.matches.push({ kind: 'characters', selected: zapp.id, source: 'default' });
    state.substitutions.push({ kind: 'characters', requested: 'no matching library tag', used: zapp.id, reason: 'deterministic available fallback' });
  }
  // Global matching may rank/truncate hints, but per-beat literal recognition must retain every available person.
  const characters = [...scriptCharacters, ...availableEntries('characters', lib).filter((candidate) => !scriptCharacters.some((selected) => selected.id === candidate.id))];
  const maxBeatCast = Math.max(1, Math.min(8, environment.cast.max, dimensions.maxCastFraming));

  const phraseWords = req.lines.map(words);
  const totalWords = phraseWords.reduce((n, line) => n + line.length, 0);
  let elapsedWords = 0;
  let previousEntities = new Set<string>();
  let previousPerson: LibraryEntry | undefined;
  let previousProps: LibraryEntry[] = [];
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
    diagnoseVisibleConcepts(req.lines[i], phraseId, set, lib, state);
    const action = chooseOne('actions', lineQueries, 'idle', phraseId, lib, req.seed, state) as LibraryEntry;
    const expression = chooseOne('expressions', [{ text: req.lines[i], source: 'script' }], 'neutral', phraseId, lib, req.seed, state) as LibraryEntry;
    const propQueries: Query[] = [
      ...providerProps.map((text): Query => ({ text, source: 'provider' })),
      { text: req.lines[i], source: 'script' },
    ];
    let props = chooseMany('props', propQueries, 16, phraseId, lib, req.seed, state);
    const hasObjectPronoun = canonicalWords(req.lines[i]).some((word) => OBJECT_PRONOUNS.has(word));
    if (!props.length && hasObjectPronoun) props = previousProps;
    if (props.length) previousProps = props;
    let realizedAction = action;
    if (PROP_STATE_ACTIONS.has(action.id) && !props.length) {
      realizedAction = requiredDefault('actions', 'idle', lib) as LibraryEntry;
      state.substitutions.push({ kind: 'actions', requested: action.id, used: realizedAction.id, beat: phraseId, reason: 'action requires an available local prop; conservative idle substituted' });
      missing(state, { kind: 'props', requested: `prop required by ${action.id}`, beat: phraseId, reason: 'action cannot be safely realized without an available local prop' });
    }

    const explicitCharacters = mentionedCharacters(req.lines[i], characters);
    if (explicitCharacters.length > maxBeatCast) missing(state, {
      kind: 'characters', requested: `${explicitCharacters.length} people in ${phraseId}`, beat: phraseId,
      reason: `set ${set.id} safely supports at most ${maxBeatCast} framed actors; render authorization must remain blocked`,
    });
    const orderedCharacters = beatCharacters(req.lines[i], characters, previousPerson, realizedAction.id, maxBeatCast);
    const active = orderedCharacters[0];
    previousPerson = explicitCharacters.at(-1) ?? active;
    const usedMarks = new Set<string>();
    const cast = orderedCharacters.map((character, ci) => {
      const other = orderedCharacters.find((x) => x.id !== character.id);
      const lookAt = ci === 0 ? (props[0]?.id ?? other?.id ?? 'camera') : active.id;
      return {
        characterId: latestRef(character),
        role: ci === 0 ? 'lead' as const : ci === 1 ? 'foil' as const : 'support' as const,
        placement: pickMark(set, character, usedMarks, req.seed, `${phraseId}:character:${character.id}`, safeActorMarks, environment, true),
        actionId: ci === 0 ? realizedAction.id : 'idle',
        expressionId: ci === 0 ? expression.id : 'neutral',
        lookAt,
      };
    });
    const beatProps = props.map((prop) => ({
      propId: latestRef(prop),
      placement: pickMark(set, prop, usedMarks, req.seed, `${phraseId}:prop:${prop.id}`, set.marks, environment),
      state: 'idle',
    }));
    const mainCamera = chooseMainCamera({
      text: req.lines[i], beat: phraseId, active, characters: orderedCharacters, props, actionId: realizedAction.id,
      dimensions, lib, seed: req.seed, state,
    });
    const { recipeId: cameraRecipeId, subject, secondary } = mainCamera;

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
      characters: orderedCharacters, props, active, emittedAction: realizedAction.id,
      main: mainCamera,
      constraints: { castCount: orderedCharacters.length, motion: MOTION_ACTIONS.has(realizedAction.id), ...dimensions },
      ...(intentBeat?.shots ? { providerShots: intentBeat.shots } : {}),
    });
    editBeats.push(editPlan.report);
    beats.push({
      phraseId, start, end, text: req.lines[i], setId: latestRef(set), lighting: set.lighting[req.seed % set.lighting.length],
      cast, props: beatProps, events: [],
      camera: { recipeId: cameraRecipeId, subject, ...(secondary ? { secondary } : {}), ...(editPlan.subShots.length ? { subShots: editPlan.subShots } : {}) },
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
  const aggregateCoverage = (requiredKey: 'entityCueClauses' | 'actionCueClauses' | 'propStateCueClauses', realizedKey: 'framedEntityClauses' | 'realizedActionClauses' | 'realizedPropStateClauses'): RealizationCoverage => {
    const required = editBeats.reduce((sum, beat) => sum + beat[requiredKey], 0);
    const realized = editBeats.reduce((sum, beat) => sum + beat[realizedKey], 0);
    return { required, realized, pct: required ? realized / required : 1 };
  };
  const unresolved = state.conceptRequirements.size;
  const diagnosed = new Set(state.conceptDiagnostics.map((concept) => `${concept.beat}:${concept.term}`)).size;
  const unresolvedConceptCoverage: UnresolvedConceptCoverage = {
    required: unresolved, realized: diagnosed, pct: unresolved ? diagnosed / unresolved : 1, unresolved, diagnosed,
  };
  const report: DirectorReport = {
    algorithmVersion: DIRECTOR_ALGORITHM_VERSION,
    provider,
    matches: state.matches,
    substitutions: state.substitutions,
    missingAssets: state.missingAssets,
    conceptDiagnostics: state.conceptDiagnostics,
    editPlan: {
      policy: DIRECTOR_EDIT_PLAN_POLICY,
      coverage: {
        version: DIRECTOR_EDIT_PLAN_POLICY.coverageVersion,
        entityFramingCoverage: aggregateCoverage('entityCueClauses', 'framedEntityClauses'),
        actionRealizationCoverage: aggregateCoverage('actionCueClauses', 'realizedActionClauses'),
        propStateRealizationCoverage: aggregateCoverage('propStateCueClauses', 'realizedPropStateClauses'),
        unresolvedConceptCoverage,
      },
      beats: editBeats,
    },
    validation: { ok: validation.ok, issues: validation.issues },
  };
  if (!validation.ok) throw new DirectorInputError(`generated BeatSheet failed validation: ${validation.issues.slice(0, 3).map((x) => `${x.path} ${x.message}`).join('; ')}`);
  return { sheet, report };
}
