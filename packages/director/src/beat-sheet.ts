// Beat sheet: the director's output and the staging input (S0-owned contract).
// One beat per narration phrase. Strict schema (packages/schema/src/v.ts) + semantic validation against the
// library manifest (packages/library/src/ids.ts): unknown IDs are errors; planned-but-unavailable IDs are listed
// separately (and only fail when requireAvailable is set).
import { v, type Issue, type SchemaT } from '../../schema/src/v.ts';
import { LIBRARY, REF_PATTERN, ID_PATTERN, lookup, type Library, type LibraryKind, type SetEntry } from '../../library/src/ids.ts';

export const BEAT_SHEET_VERSION = '1.0';
/** Smallest legal camera-composition window created by an intra-beat cut. */
export const MIN_SUB_SHOT_DURATION = 0.15;

const ref = () => v.string({ pattern: REF_PATTERN, max: 64 });
const sid = () => v.string({ pattern: ID_PATTERN, max: 64 });
const time = () => v.number({ min: 0, max: 600 });
/** a mark id, or enter:<doorId> / exit:<doorId> */
const PLACEMENT = /^((enter|exit):)?[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
/** prop placement: a mark or door id, held:<characterId> or on:<propInstanceId> */
const PROP_PLACEMENT = /^((held|on):)?[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

export const CAST_ROLES = ['lead', 'foil', 'authority', 'support', 'background'] as const;

export const CastMember = v.object({
  characterId: ref(),
  role: v.enum(CAST_ROLES),
  placement: v.string({ pattern: PLACEMENT, max: 80 }),
  actionId: sid(),
  expressionId: sid(),
  /** entity in this beat (characterId / prop instanceId), a mark, or 'camera' */
  lookAt: sid().optional(),
});
export const BeatProp = v.object({
  propId: ref(),
  /** entity ID for carryOver/lookAt/targets; defaults to the propId without version */
  instanceId: sid().optional(),
  placement: v.string({ pattern: PROP_PLACEMENT, max: 80 }),
  /** prop state name (e.g. closed/open, small/giant, idle/pressed) */
  state: sid(),
});

const at = () => time();
export const BeatEvent = v.discriminated<
  | { type: 'door_open' | 'door_close'; at: number; doorId: string; by?: string }
  | { type: 'enter' | 'exit'; at: number; characterId: string; doorId: string }
  | { type: 'vfx'; at: number; vfxId: string; target?: string; duration?: number }
  | { type: 'text_graphic'; at: number; textStyleId: string; text: string; duration: number; target?: string }
  | { type: 'sfx'; at: number; sfxId: string; gainDb?: number }
>('type', {
  door_open: v.object({ type: v.literal('door_open'), at: at(), doorId: sid(), by: sid().optional() }),
  door_close: v.object({ type: v.literal('door_close'), at: at(), doorId: sid(), by: sid().optional() }),
  enter: v.object({ type: v.literal('enter'), at: at(), characterId: ref(), doorId: sid() }),
  exit: v.object({ type: v.literal('exit'), at: at(), characterId: ref(), doorId: sid() }),
  vfx: v.object({ type: v.literal('vfx'), at: at(), vfxId: sid(), target: sid().optional(), duration: v.number({ min: 0.05, max: 10 }).optional() }),
  text_graphic: v.object({ type: v.literal('text_graphic'), at: at(), textStyleId: sid(), text: v.string({ min: 1, max: 40 }), duration: v.number({ min: 0.1, max: 10 }), target: sid().optional() }),
  sfx: v.object({ type: v.literal('sfx'), at: at(), sfxId: ref(), gainDb: v.number({ min: -40, max: 6 }).optional() }),
});
export const Caption = v.object({
  start: time(),
  end: time(),
  /** 1-4 words */
  text: v.string({ min: 1, max: 48, pattern: /^\S+( \S+){0,3}$/ }),
  highlight: v.string({ min: 1, max: 24 }).optional(),
});
export const Beat = v.object({
  phraseId: v.string({ pattern: /^p\d{2,3}$/ }),
  start: time(),
  end: time(),
  text: v.string({ min: 1, max: 400 }),
  setId: ref(),
  lighting: sid(),
  cast: v.array(CastMember, { max: 8 }),
  props: v.array(BeatProp, { max: 16 }),
  events: v.array(BeatEvent, { max: 32 }),
  camera: v.object({
    recipeId: sid(), subject: sid(), secondary: sid().optional(),
    /** optional intra-beat sub-shots (extra compositions/cuts within the beat). Each starts at absolute time `from`
     *  (which must fall inside the beat and increase); the beat's own `camera` is the first composition. A sub-shot is
     *  a hard camera cut, so a caption re-bands at its boundary (still one caption band per composition). */
    subShots: v.array(v.object({ from: time(), recipeId: sid(), subject: sid(), secondary: sid().optional() }), { max: 6 }).optional(),
  }),
  captions: v.array(Caption, { min: 1, max: 12 }),
  /** entity IDs (characterIds, prop instanceIds) kept from the previous beat */
  carryOver: v.array(sid(), { max: 24 }),
});
export const BeatSheetSchema = v.object({
  schemaVersion: v.literal(BEAT_SHEET_VERSION),
  id: sid(),
  title: v.string({ min: 1, max: 120 }),
  seed: v.int({ min: 0 }),
  /** provenance: the narrated fixture/project the phrases come from */
  source: v.object({ narrated: v.string({ min: 1, max: 200 }), narratedId: v.string({ min: 1, max: 64 }) }),
  music: v.array(v.object({ musicId: ref(), start: time(), end: time(), gainDb: v.number({ min: -40, max: 6 }).optional() }), { max: 8 }),
  beats: v.array(Beat, { min: 1, max: 200 }),
});
export type BeatSheet = SchemaT<typeof BeatSheetSchema>;
export type BeatT = BeatSheet['beats'][number];

export interface IdUse { kind: LibraryKind; id: string; paths: string[] }
export interface BeatSheetResult {
  ok: boolean;
  /** schema + semantic errors (unknown IDs included) */
  issues: Issue[];
  /** IDs not in the library */
  unknown: IdUse[];
  /** IDs in the library with status 'planned' (valid, but not renderable yet) */
  planned: IdUse[];
  value?: BeatSheet;
}

const bare = (r: string) => r.split('@')[0];
const words = (s: string) => s.split(/\s+/).filter(Boolean);
const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '');

/** Validate a beat sheet. `phrases` (optional): the narration phrases it must cover one-to-one. */
export function validateBeatSheet(input: unknown, opts: { library?: Library; requireAvailable?: boolean; phrases?: Array<{ id: string; start: number; end: number; text: string }> } = {}): BeatSheetResult {
  const lib = opts.library ?? LIBRARY;
  const parsed = BeatSheetSchema.parse(input);
  if (!parsed.ok) return { ok: false, issues: parsed.issues, unknown: [], planned: [] };
  const s = parsed.value;
  const issues: Issue[] = [];
  const unknown = new Map<string, IdUse>(), planned = new Map<string, IdUse>();
  const err = (path: string, message: string) => issues.push({ path, message });
  const use = (kind: LibraryKind, r: string, path: string) => {
    const e = lookup(kind, r, lib);
    const key = `${kind}:${bare(r)}`;
    if (!e) {
      const u = unknown.get(key) ?? { kind, id: r, paths: [] }; u.paths.push(path); unknown.set(key, u);
      err(path, `unknown ${kind} id "${r}"`);
      return undefined;
    }
    if (e.status === 'planned') { const p = planned.get(key) ?? { kind, id: e.id, paths: [] }; p.paths.push(path); planned.set(key, p); }
    return e;
  };

  for (const [i, m] of s.music.entries()) { use('music', m.musicId, `$.music[${i}].musicId`); if (m.end <= m.start) err(`$.music[${i}]`, 'end must be after start'); }

  let prevEntities = new Set<string>();
  const seenPhrases = new Set<string>();
  for (const [bi, b] of s.beats.entries()) {
    const P = `$.beats[${bi}]`;
    if (seenPhrases.has(b.phraseId)) err(`${P}.phraseId`, `duplicate phraseId ${b.phraseId}`);
    seenPhrases.add(b.phraseId);
    if (b.end <= b.start) err(P, 'end must be after start');
    if (bi > 0 && b.start < s.beats[bi - 1].end) err(`${P}.start`, `overlaps previous beat (${s.beats[bi - 1].end})`);
    const inBeat = (t: number) => t >= b.start - 1e-6 && t <= b.end + 1e-6;

    const set = use('sets', b.setId, `${P}.setId`) as SetEntry | undefined;
    const marks = new Set(set?.marks ?? []), doors = new Set(set?.doors ?? []);
    const setAuthored = !!set && set.status === 'available';
    if (set && set.lighting.length && !set.lighting.includes(b.lighting)) err(`${P}.lighting`, `lighting "${b.lighting}" not one of [${set.lighting.join(', ')}] for set ${set.id}`);
    const checkMark = (m: string, path: string, allowDoor: boolean) => {
      if (!setAuthored) return; // planned set: marks not authored yet, format-only
      if (marks.has(m) || (allowDoor && doors.has(m))) return;
      err(path, `"${m}" is not a mark${allowDoor ? ' or door' : ''} of set ${set!.id}`);
    };
    const checkDoor = (d: string, path: string) => { if (setAuthored && !doors.has(d)) err(path, `"${d}" is not a door of set ${set!.id}`); };

    const entities = new Set<string>();
    const castIds = new Set<string>();
    for (const [ci, c] of b.cast.entries()) {
      const C = `${P}.cast[${ci}]`;
      use('characters', c.characterId, `${C}.characterId`);
      use('actions', c.actionId, `${C}.actionId`);
      use('expressions', c.expressionId, `${C}.expressionId`);
      const id = bare(c.characterId);
      if (castIds.has(id)) err(`${C}.characterId`, `character ${id} cast twice in one beat`);
      castIds.add(id); entities.add(id);
      const [kind, target] = c.placement.includes(':') ? c.placement.split(':') : ['mark', c.placement];
      if (kind === 'mark') checkMark(target, `${C}.placement`, false);
      else {
        checkDoor(target, `${C}.placement`);
        if (!b.events.some((e) => (e.type === 'enter' || e.type === 'exit') && e.type === kind && bare(e.characterId) === id && e.doorId === target)) err(`${C}.placement`, `placement ${c.placement} needs a matching "${kind}" event for ${id}`);
      }
    }
    for (const [pi, p] of b.props.entries()) {
      const Q = `${P}.props[${pi}]`;
      use('props', p.propId, `${Q}.propId`);
      const id = p.instanceId ?? bare(p.propId);
      if (entities.has(id)) err(`${Q}.instanceId`, `entity id ${id} used twice in one beat`);
      entities.add(id);
      const [kind, target] = p.placement.includes(':') ? p.placement.split(':') : ['mark', p.placement];
      if (kind === 'mark') checkMark(target, `${Q}.placement`, true);
      else if (kind === 'held' && !castIds.has(target)) err(`${Q}.placement`, `held by ${target}, who is not in this beat's cast`);
    }
    for (const [pi, p] of b.props.entries()) {
      const [kind, target] = p.placement.split(':');
      if (kind === 'on' && !entities.has(target)) err(`${P}.props[${pi}].placement`, `on:${target} is not a prop in this beat`);
    }
    const isTarget = (t: string) => entities.has(t) || t === 'camera' || (setAuthored ? marks.has(t) || doors.has(t) : true);
    for (const [ci, c] of b.cast.entries()) if (c.lookAt !== undefined && (!isTarget(c.lookAt) || c.lookAt === bare(c.characterId))) err(`${P}.cast[${ci}].lookAt`, `lookAt "${c.lookAt}" is not another entity, mark or 'camera'`);

    for (const [ei, e] of b.events.entries()) {
      const E = `${P}.events[${ei}]`;
      if (!inBeat(e.at)) err(`${E}.at`, `${e.at} outside beat [${b.start}, ${b.end}]`);
      switch (e.type) {
        case 'door_open': case 'door_close':
          checkDoor(e.doorId, `${E}.doorId`);
          if (e.by !== undefined && !castIds.has(e.by)) err(`${E}.by`, `${e.by} is not in this beat's cast`);
          break;
        case 'enter': case 'exit':
          use('characters', e.characterId, `${E}.characterId`); checkDoor(e.doorId, `${E}.doorId`);
          if (!castIds.has(bare(e.characterId))) err(`${E}.characterId`, `${e.characterId} must be in this beat's cast`);
          break;
        case 'vfx':
          use('vfx', e.vfxId, `${E}.vfxId`);
          if (e.target !== undefined && !isTarget(e.target)) err(`${E}.target`, `target "${e.target}" is not an entity or mark in this beat`);
          break;
        case 'text_graphic':
          use('textStyles', e.textStyleId, `${E}.textStyleId`);
          if (e.target !== undefined && !isTarget(e.target)) err(`${E}.target`, `target "${e.target}" is not an entity or mark in this beat`);
          if (e.at + e.duration > b.end + 1e-6) err(`${E}.duration`, 'text graphic runs past the end of the beat');
          break;
        case 'sfx':
          use('sfx', e.sfxId, `${E}.sfxId`);
          break;
      }
    }
    // door close/open order per door within the beat
    for (const d of new Set(b.events.filter((e) => e.type === 'door_open' || e.type === 'door_close').map((e) => (e as { doorId: string }).doorId))) {
      const seq = b.events.filter((e) => (e.type === 'door_open' || e.type === 'door_close') && e.doorId === d).sort((x, y) => x.at - y.at);
      for (let k = 1; k < seq.length; k++) if (seq[k].type === seq[k - 1].type) err(`${P}.events`, `door ${d}: ${seq[k].type} twice in a row`);
    }

    const cameraEntries = [b.camera, ...(b.camera.subShots ?? [])];
    const cameraCuts = [b.start, ...(b.camera.subShots?.map((s) => s.from) ?? []), b.end];
    for (const [cameraIndex, camera] of cameraEntries.entries()) {
      const C = cameraIndex === 0 ? `${P}.camera` : `${P}.camera.subShots[${cameraIndex - 1}]`;
      use('cameraRecipes', camera.recipeId, `${C}.recipeId`);
      if (!entities.has(camera.subject)) err(`${C}.subject`, `subject "${camera.subject}" is not an entity in this beat`);
      if (camera.secondary !== undefined && (!entities.has(camera.secondary) || camera.secondary === camera.subject)) err(`${C}.secondary`, `secondary "${camera.secondary}" must be another entity in this beat`);
    }
    if (b.camera.subShots) {
      let prevFrom = b.start;
      for (const [si, ss] of b.camera.subShots.entries()) {
        const SS = `${P}.camera.subShots[${si}]`;
        if (ss.from <= prevFrom + 1e-6 || ss.from >= b.end - 1e-6) err(`${SS}.from`, `sub-shot cut ${ss.from} must be strictly inside the beat and after the previous cut (${prevFrom})`);
        prevFrom = ss.from;
      }
      // Every window made by a sub-shot cut (including the leading and trailing windows) must be long enough for
      // meaningful framing and safety evaluation. This also prevents empty/vacuously accepted sample sets.
      for (let ci = 0; ci + 1 < cameraCuts.length; ci++) {
        const duration = cameraCuts[ci + 1] - cameraCuts[ci];
        if (duration + 1e-6 < MIN_SUB_SHOT_DURATION) {
          const path = ci === 0 ? `${P}.camera.subShots[0].from` : `${P}.camera.subShots[${ci - 1}]`;
          err(path, `sub-shot window [${cameraCuts[ci]}, ${cameraCuts[ci + 1]}) is ${Math.max(0, duration).toFixed(3)} s; minimum is ${MIN_SUB_SHOT_DURATION.toFixed(3)} s`);
        }
      }
    }

    // Camera subjects must exist during their own composition, not merely somewhere in the beat roster. Entering
    // actors become present at their enter event; exiting actors cease to be present at their exit event. Props span
    // the beat. Requiring interval overlap permits a motivated entrance/exit wide while rejecting entirely absent or
    // post-exit subjects and secondaries before staging.
    const castById = new Map(b.cast.map((c) => [bare(c.characterId), c] as const));
    const cameraTargetPresent = (id: string, from: number, to: number): boolean => {
      if (b.props.some((p) => (p.instanceId ?? bare(p.propId)) === id)) return true;
      const c = castById.get(id);
      if (!c) return false;
      const [placementKind] = c.placement.includes(':') ? c.placement.split(':') : ['mark'];
      let presentFrom = b.start, presentTo = b.end;
      if (placementKind === 'enter') {
        const enter = b.events.filter((e) => e.type === 'enter' && bare(e.characterId) === id).sort((a, z) => a.at - z.at)[0];
        if (!enter) return false;
        presentFrom = enter.at;
      }
      if (placementKind === 'exit') {
        const exit = b.events.filter((e) => e.type === 'exit' && bare(e.characterId) === id).sort((a, z) => a.at - z.at)[0];
        if (!exit) return false;
        presentTo = exit.at;
      }
      return Math.min(to, presentTo) - Math.max(from, presentFrom) > 1e-6;
    };
    for (const [cameraIndex, camera] of cameraEntries.entries()) {
      const from = cameraCuts[cameraIndex], to = cameraCuts[cameraIndex + 1];
      if (!(to > from + 1e-6)) continue; // ordering diagnostics above are authoritative for malformed cuts
      const C = cameraIndex === 0 ? `${P}.camera` : `${P}.camera.subShots[${cameraIndex - 1}]`;
      if (entities.has(camera.subject) && !cameraTargetPresent(camera.subject, from, to)) err(`${C}.subject`, `subject "${camera.subject}" is not present during camera window [${from}, ${to})`);
      if (camera.secondary !== undefined && entities.has(camera.secondary) && !cameraTargetPresent(camera.secondary, from, to)) err(`${C}.secondary`, `secondary "${camera.secondary}" is not present during camera window [${from}, ${to})`);
    }

    for (const [ki, c] of b.captions.entries()) {
      const K = `${P}.captions[${ki}]`;
      if (c.end <= c.start) err(K, 'end must be after start');
      if (!inBeat(c.start) || !inBeat(c.end)) err(K, `caption outside beat [${b.start}, ${b.end}]`);
      if (ki > 0 && c.start < b.captions[ki - 1].end - 1e-6) err(`${K}.start`, 'overlaps previous caption');
      if (c.highlight !== undefined && !words(c.text).some((w) => norm(w) === norm(c.highlight!))) err(`${K}.highlight`, `highlight "${c.highlight}" is not a word of "${c.text}"`);
    }

    for (const [ki, id] of b.carryOver.entries()) {
      if (bi === 0) { err(`${P}.carryOver[${ki}]`, 'first beat cannot carry over entities'); continue; }
      if (!prevEntities.has(id)) err(`${P}.carryOver[${ki}]`, `${id} was not in the previous beat`);
      if (!entities.has(id)) err(`${P}.carryOver[${ki}]`, `${id} is carried over but not present in this beat`);
    }
    prevEntities = entities;
  }

  if (opts.phrases) {
    const byId = new Map(s.beats.map((b) => [b.phraseId, b]));
    for (const ph of opts.phrases) {
      const b = byId.get(ph.id);
      if (!b) { err('$.beats', `no beat for phrase ${ph.id}`); continue; }
      if (Math.abs(b.start - ph.start) > 1e-3 || Math.abs(b.end - ph.end) > 1e-3) err(`$.beats[${s.beats.indexOf(b)}]`, `timing ${b.start}-${b.end} does not match phrase ${ph.id} ${ph.start}-${ph.end}`);
      if (b.text !== ph.text) err(`$.beats[${s.beats.indexOf(b)}].text`, `text does not match phrase ${ph.id}`);
    }
    const known = new Set(opts.phrases.map((p) => p.id));
    for (const [bi, b] of s.beats.entries()) if (!known.has(b.phraseId)) err(`$.beats[${bi}].phraseId`, `${b.phraseId} is not a narration phrase`);
  }

  const plannedList = [...planned.values()];
  if (opts.requireAvailable) for (const p of plannedList) err(p.paths[0], `${p.kind} id "${p.id}" is planned, not available`);
  return { ok: issues.length === 0, issues, unknown: [...unknown.values()], planned: plannedList, value: s };
}
