// Strict, deterministic semantic authorization sidecar for Director-produced BeatSheets.
// Browser-safe: render entry points authenticate the containing JSON bytes separately.
import { type BeatSheet } from './beat-sheet.ts';
import { LIBRARY, type Library, type LibraryEntry, type SetEntry } from '../../library/src/ids.ts';

export const SEMANTIC_REQUIREMENTS_SCHEMA = 'blockspark.director-semantic-requirements/1' as const;
export const SEMANTIC_CATEGORIES = ['set', 'character', 'prop', 'action', 'expression', 'nonvisual', 'unknown-content'] as const;
export const SEMANTIC_DISPOSITIONS = ['available', 'approved_substitution', 'nonvisual', 'authorization_blocker'] as const;
export type SemanticCategory = typeof SEMANTIC_CATEGORIES[number];
export type SemanticDisposition = typeof SEMANTIC_DISPOSITIONS[number];

export interface SemanticRequirement {
  term: string;
  category: SemanticCategory;
  disposition: SemanticDisposition;
  /** Half-open indexes into the normalized whitespace-delimited beat words. */
  words: [start: number, end: number];
  catalogId: string | null;
  /** Exact available ID replacing catalogId; non-null only for approved substitutions. */
  substituteId: string | null;
}
export interface BeatSemanticRequirements {
  phraseId: string;
  text: string;
  start: number;
  end: number;
  terms: SemanticRequirement[];
}
export interface SemanticRequirements {
  schema: typeof SEMANTIC_REQUIREMENTS_SCHEMA;
  sheetId: string;
  sheetSchemaVersion: string;
  sourceNarrated: string;
  sourceNarratedId: string;
  beats: BeatSemanticRequirements[];
}

type SemanticKind = 'sets' | 'characters' | 'props' | 'actions' | 'expressions';
interface Hit { kind: SemanticKind; entry: LibraryEntry | SetEntry; start: number; end: number; term: string }
const BARE = (ref: string): string => ref.split('@')[0];
const rawWords = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);
const canonicalWords = (text: string): string[] => text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9']+/g) ?? [];
const canonical = (text: string): string => canonicalWords(text).join(' ');

// These tokens carry syntax, discourse, degree, or timing rather than a new visible/action requirement. The list is
// deliberately closed: every other unmatched token becomes an authorization blocker.
const NONVISUAL = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'another', 'his', 'her', 'their', 'our', 'my', 'your',
  'he', 'she', 'they', 'him', 'them', 'it', 'who', 'his', 'hers', 'himself', 'herself', 'themselves',
  'and', 'or', 'but', 'then', 'while', 'when', 'before', 'after', 'so', 'yet', 'until', 'meanwhile',
  'at', 'in', 'inside', 'to', 'from', 'with', 'without', 'of', 'for', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'can', 'could', 'will', 'would', 'should', 'must', 'may', 'might',
  'not', 'very', 'quietly', 'quickly', 'slowly', 'suddenly', 'later', 'finally', 'again', 'often', 'well', 'today',
  'tomorrow', 'yesterday', 'now', 'here', 'there', 'away', 'together', 'apart', 'downstairs', 'upstairs', 'indoors', 'outdoors',
]);

const categoryFor = (kind: SemanticKind): SemanticCategory => kind === 'sets' ? 'set' : kind === 'characters' ? 'character' : kind === 'props' ? 'prop' : kind === 'actions' ? 'action' : 'expression';
const entriesFor = (kind: SemanticKind, lib: Library): Array<LibraryEntry | SetEntry> => lib[kind] as Array<LibraryEntry | SetEntry>;
const representedIds = (beat: BeatSheet['beats'][number]): Record<SemanticKind, Set<string>> => ({
  sets: new Set([BARE(beat.setId)]),
  characters: new Set(beat.cast.map((member) => BARE(member.characterId))),
  props: new Set(beat.props.map((prop) => BARE(prop.propId))),
  actions: new Set(beat.cast.map((member) => member.actionId)),
  expressions: new Set(beat.cast.map((member) => member.expressionId)),
});

function literalHits(kind: SemanticKind, text: string, lib: Library): Hit[] {
  const source = rawWords(text);
  const indexed = source.flatMap((raw, word) => canonicalWords(raw).map((value) => ({ value, word })));
  const hits: Hit[] = [];
  for (const entry of [...entriesFor(kind, lib)].sort((a, b) => a.id.localeCompare(b.id))) {
    const tags = [...new Set([entry.id.replace(/_/g, ' '), ...entry.tags].map(canonical).filter(Boolean))];
    for (const tag of tags) {
      const needle = tag.split(' ');
      for (let i = 0; i <= indexed.length - needle.length; i++) {
        if (needle.every((part, offset) => indexed[i + offset].value === part)) {
          const start = indexed[i].word, end = indexed[i + needle.length - 1].word + 1;
          hits.push({ kind, entry, start, end, term: source.slice(start, end).join(' ') });
        }
      }
      // Narrow phrasal-verb support: the authored "puts down" action may contain its object pronoun in the middle.
      if (kind === 'actions' && tag === 'puts down') for (let i = 0; i <= indexed.length - 3; i++) {
        if (indexed[i].value === 'puts' && indexed[i + 1].value === 'it' && indexed[i + 2].value === 'down') {
          const start = indexed[i].word, end = indexed[i + 2].word + 1;
          hits.push({ kind, entry, start, end, term: source.slice(start, end).join(' ') });
        }
      }
    }
  }
  const unique = new Map<string, Hit>();
  for (const hit of hits) unique.set(`${hit.entry.id}:${hit.start}:${hit.end}`, hit);
  return [...unique.values()];
}

function selectedHits(kind: SemanticKind, text: string, represented: Set<string>, lib: Library): Hit[] {
  const candidates = literalHits(kind, text, lib).sort((a, b) =>
    a.start - b.start || (b.end - b.start) - (a.end - a.start)
    || Number(represented.has(b.entry.id)) - Number(represented.has(a.entry.id))
    || Number(b.entry.status === 'available') - Number(a.entry.status === 'available')
    || a.entry.id.localeCompare(b.entry.id));
  const selected: Hit[] = [];
  for (const hit of candidates) {
    if (selected.some((existing) => existing.start < hit.end && hit.start < existing.end)) continue;
    selected.push(hit);
  }
  return selected;
}

const APPROVED_SET_SUBSTITUTIONS: Readonly<Record<string, readonly string[]>> = {
  home_kitchen: ['classroom'],
  home_living_room: ['classroom'],
};

function knownRequirement(hit: Hit, represented: Record<SemanticKind, Set<string>>, selectedSet: string, lib: Library): SemanticRequirement {
  let disposition: SemanticDisposition = 'authorization_blocker';
  let substituteId: string | null = null;
  if (hit.entry.status === 'available' && represented[hit.kind].has(hit.entry.id)) disposition = 'available';
  else if (hit.kind === 'sets' && hit.entry.status === 'planned' && APPROVED_SET_SUBSTITUTIONS[hit.entry.id]?.includes(selectedSet)) {
    const substitute = lib.sets.find((entry) => entry.id === selectedSet && entry.status === 'available');
    if (substitute) { disposition = 'approved_substitution'; substituteId = substitute.id; }
  }
  return {
    term: canonical(hit.term), category: categoryFor(hit.kind), disposition, words: [hit.start, hit.end],
    catalogId: hit.entry.id, substituteId,
  };
}

export function buildSemanticRequirements(sheet: BeatSheet, lib: Library = LIBRARY): SemanticRequirements {
  return {
    schema: SEMANTIC_REQUIREMENTS_SCHEMA,
    sheetId: sheet.id,
    sheetSchemaVersion: sheet.schemaVersion,
    sourceNarrated: sheet.source.narrated,
    sourceNarratedId: sheet.source.narratedId,
    beats: sheet.beats.map((beat) => {
      const represented = representedIds(beat), covered = new Set<number>();
      const priority: Record<SemanticCategory, number> = { character: 0, action: 1, expression: 2, prop: 3, set: 4, nonvisual: 5, 'unknown-content': 6 };
      const candidates = (['sets', 'characters', 'props', 'actions', 'expressions'] as const)
        .flatMap((kind) => selectedHits(kind, beat.text, represented[kind], lib).map((hit) => knownRequirement(hit, represented, BARE(beat.setId), lib)))
        .sort((a, b) => a.words[0] - b.words[0] || (b.words[1] - b.words[0]) - (a.words[1] - a.words[0])
          || Number(b.disposition !== 'authorization_blocker') - Number(a.disposition !== 'authorization_blocker')
          || priority[a.category] - priority[b.category] || a.term.localeCompare(b.term));
      const known: SemanticRequirement[] = [];
      for (const requirement of candidates) {
        if (known.some((selected) => selected.words[0] < requirement.words[1] && requirement.words[0] < selected.words[1])) continue;
        known.push(requirement);
      }
      for (const requirement of known) for (let word = requirement.words[0]; word < requirement.words[1]; word++) covered.add(word);
      const source = rawWords(beat.text), residual: SemanticRequirement[] = [];
      for (let index = 0; index < source.length; index++) {
        if (covered.has(index)) continue;
        const term = canonical(source[index]) || source[index].normalize('NFKC').toLowerCase();
        const nonvisual = NONVISUAL.has(term);
        residual.push({
          term, category: nonvisual ? 'nonvisual' : 'unknown-content',
          disposition: nonvisual ? 'nonvisual' : 'authorization_blocker', words: [index, index + 1],
          catalogId: null, substituteId: null,
        });
      }
      const terms = [...known, ...residual].sort((a, b) => a.words[0] - b.words[0] || a.words[1] - b.words[1]
        || SEMANTIC_CATEGORIES.indexOf(a.category) - SEMANTIC_CATEGORIES.indexOf(b.category) || a.term.localeCompare(b.term));
      return { phraseId: beat.phraseId, text: beat.text, start: beat.start, end: beat.end, terms };
    }),
  };
}

function exactObject(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join('\0') !== [...keys].sort().join('\0')) throw new Error(`${label} keys must be exactly ${[...keys].sort().join(', ')}`);
  return object;
}
function strictString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  return value;
}
function strictNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 600) throw new Error(`${label} must be a finite number from 0 to 600`);
  return value;
}
function strictNullableId(value: unknown, label: string): string | null {
  if (value === null) return null;
  const result = strictString(value, label, 64);
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(result)) throw new Error(`${label} is not a canonical library ID`);
  return result;
}

export function parseSemanticRequirements(value: unknown): SemanticRequirements {
  const root = exactObject(value, 'semanticRequirements', ['schema', 'sheetId', 'sheetSchemaVersion', 'sourceNarrated', 'sourceNarratedId', 'beats']);
  if (root.schema !== SEMANTIC_REQUIREMENTS_SCHEMA) throw new Error(`unsupported semanticRequirements schema '${String(root.schema)}'`);
  if (!Array.isArray(root.beats) || root.beats.length < 1 || root.beats.length > 200) throw new Error('semanticRequirements.beats must contain 1 to 200 beats');
  const beats = root.beats.map((rawBeat, beatIndex): BeatSemanticRequirements => {
    const beat = exactObject(rawBeat, `semanticRequirements.beats[${beatIndex}]`, ['phraseId', 'text', 'start', 'end', 'terms']);
    if (!Array.isArray(beat.terms) || beat.terms.length > 4000) throw new Error(`semanticRequirements.beats[${beatIndex}].terms must be an array of at most 4000 terms`);
    const terms = beat.terms.map((rawTerm, termIndex): SemanticRequirement => {
      const label = `semanticRequirements.beats[${beatIndex}].terms[${termIndex}]`;
      const term = exactObject(rawTerm, label, ['term', 'category', 'disposition', 'words', 'catalogId', 'substituteId']);
      if (!SEMANTIC_CATEGORIES.includes(term.category as SemanticCategory)) throw new Error(`${label}.category is invalid`);
      if (!SEMANTIC_DISPOSITIONS.includes(term.disposition as SemanticDisposition)) throw new Error(`${label}.disposition is invalid`);
      if (!Array.isArray(term.words) || term.words.length !== 2 || !term.words.every(Number.isSafeInteger)
        || Number(term.words[0]) < 0 || Number(term.words[1]) <= Number(term.words[0]) || Number(term.words[1]) > 400) throw new Error(`${label}.words is invalid`);
      const catalogId = strictNullableId(term.catalogId, `${label}.catalogId`), substituteId = strictNullableId(term.substituteId, `${label}.substituteId`);
      if ((term.disposition === 'approved_substitution') !== (substituteId !== null)) throw new Error(`${label}.substituteId must be present exactly for approved_substitution`);
      if ((term.category === 'nonvisual' || term.category === 'unknown-content') && catalogId !== null) throw new Error(`${label}.catalogId must be null for residual terms`);
      return {
        term: strictString(term.term, `${label}.term`, 400), category: term.category as SemanticCategory,
        disposition: term.disposition as SemanticDisposition, words: [Number(term.words[0]), Number(term.words[1])], catalogId, substituteId,
      };
    });
    return {
      phraseId: strictString(beat.phraseId, `semanticRequirements.beats[${beatIndex}].phraseId`, 16),
      text: strictString(beat.text, `semanticRequirements.beats[${beatIndex}].text`, 400),
      start: strictNumber(beat.start, `semanticRequirements.beats[${beatIndex}].start`),
      end: strictNumber(beat.end, `semanticRequirements.beats[${beatIndex}].end`), terms,
    };
  });
  return {
    schema: SEMANTIC_REQUIREMENTS_SCHEMA,
    sheetId: strictString(root.sheetId, 'semanticRequirements.sheetId', 64),
    sheetSchemaVersion: strictString(root.sheetSchemaVersion, 'semanticRequirements.sheetSchemaVersion', 16),
    sourceNarrated: strictString(root.sourceNarrated, 'semanticRequirements.sourceNarrated', 200),
    sourceNarratedId: strictString(root.sourceNarratedId, 'semanticRequirements.sourceNarratedId', 64), beats,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export function semanticRequirementsFromSidecar(sidecar: unknown): SemanticRequirements {
  if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) throw new Error('Director semantic sidecar must be an object');
  const object = sidecar as Record<string, unknown>;
  return parseSemanticRequirements(object.schema === SEMANTIC_REQUIREMENTS_SCHEMA ? object : object.semanticRequirements);
}

export function verifySemanticRequirementsBinding(sheet: BeatSheet, sidecar: unknown, lib: Library = LIBRARY): SemanticRequirements {
  const provided = semanticRequirementsFromSidecar(sidecar);
  const expected = buildSemanticRequirements(sheet, lib);
  if (canonicalJson(provided) !== canonicalJson(expected)) throw new Error('Director semantic requirements do not exactly match the BeatSheet and current library');
  return provided;
}

export function verifySemanticAuthorization(sheet: BeatSheet, sidecar: unknown, lib: Library = LIBRARY): SemanticRequirements {
  const provided = verifySemanticRequirementsBinding(sheet, sidecar, lib);
  const blockers = provided.beats.flatMap((beat) => beat.terms.filter((term) => term.disposition === 'authorization_blocker').map((term) => `${beat.phraseId}:${term.category}:${term.term}`));
  if (blockers.length) throw new Error(`Director semantic authorization blocked: ${blockers.slice(0, 12).join(', ')}${blockers.length > 12 ? ` (+${blockers.length - 12} more)` : ''}`);
  return provided;
}
