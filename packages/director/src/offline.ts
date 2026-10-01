// Deterministic, browser-safe script-to-BeatSheet Director.
// Remote intent is advisory only: every final choice is resolved through the local capability library.
import { LIBRARY, type Library, type LibraryEntry, type LibraryKind, type SetEntry } from '../../library/src/ids.ts';
import { validateBeatSheet, type BeatSheet } from './beat-sheet.ts';
import type { DirectorIntent } from './intent.ts';

export const DIRECTOR_ALGORITHM_VERSION = 'director-v1';
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
export interface DirectorReport {
  algorithmVersion: string;
  provider: DirectorProviderReport;
  matches: MatchDecision[];
  substitutions: AssetSubstitution[];
  missingAssets: MissingAsset[];
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
    beats.push({
      phraseId, start, end, text: req.lines[i], setId: latestRef(set), lighting: set.lighting[req.seed % set.lighting.length],
      cast, props: beatProps, events: [], camera: { recipeId: camera.id, subject, ...(secondary ? { secondary } : {}) }, captions, carryOver,
    });
  }

  const id = idFor(req);
  const sheet: BeatSheet = {
    schemaVersion: '1.0', id, title: titleFrom(req.lines[0]), seed: req.seed,
    source: { narrated: 'director:raw-script', narratedId: `dir-${id.slice('directed_'.length)}` },
    music: [], beats,
  };
  const validation = validateBeatSheet(sheet, { library: lib, requireAvailable: true });
  const report: DirectorReport = {
    algorithmVersion: DIRECTOR_ALGORITHM_VERSION,
    provider,
    matches: state.matches,
    substitutions: state.substitutions,
    missingAssets: state.missingAssets,
    validation: { ok: validation.ok, issues: validation.issues },
  };
  if (!validation.ok) throw new DirectorInputError(`generated BeatSheet failed validation: ${validation.issues.slice(0, 3).map((x) => `${x.path} ${x.message}`).join('; ')}`);
  return { sheet, report };
}
