// Contextual intent analysis (document level) for person-directed harm.
//
// An object is not unsafe by itself (a cricket bat, a hammer, a rock are ordinary things) and a chase, a hiding place or
// a push are the stuff of slapstick. An idea is unsafe when the WHOLE TEXT implies that a person is being struck,
// threatened, pursued or ambushed with a harm-capable object, or pushed/thrown into danger. The analysis therefore works
// across clauses and sentences:
//   - actors: every clause gets a subject (named person, generic person, pronoun, or a thing). Verb-initial clauses and
//     fragments inherit the previous subject; subject pronouns resolve CONSERVATIVELY to every person mentioned so far.
//   - possession: "with/holding/grabs/picks up/uses/... <object>" registers the object for the clause's actor, and stays
//     with that actor in later sentences ("Kira grabs a bat. Later she waits behind the door.").
//   - targets: explicit person, object pronoun (him/her/them; "her" + noun = possessive = a thing), a thing, or omitted.
//     An omitted target is IMPLIED when another person is present in the same or previous sentence, or reacts (ducks...).
//   - contexts: sport (ball, practice, match...) and ordinary tool use (fix, sweep, measure...) keep an object harmless
//     when nothing person-directed happens with it; they never excuse an explicit person target.
// Rules (all category 'violence'): strike_person, threat, armed_pursuit, armed_ambush (ambiguous weapon + ambush or
// concealment is rejected, never guessed), concealed_instrument, implied_strike, person_harm (push/throw/trip a person into
// danger, restrain or lock in). Explicit weapons stay unconditional (lexicon.ts).
//
// Deterministic and provider-independent: runs inside scanIdea(), which feeds the rules provider AND the safety net
// applied to every provider. Replaces the clause-local object+intent check (commit 18553be) after Run 3 measured two
// misses (HB14 "waits behind the door with a cricket bat for Zapp", HB17 "pushes Kira down the stairs"); both records
// stay frozen as measured.

/** harm-capable everyday objects (instrument sense). Multi-word names are joined with '_' before tokenising. */
export const HARM_CAPABLE_OBJECTS = [
  'baseball_bat', 'cricket_bat', 'softball_bat', 'golf_club', 'hockey_stick', 'lacrosse_stick', 'tennis_racket', 'frying_pan', 'metal_pipe', 'brass_knuckles',
  'bat', 'bats', 'club', 'stick', 'sticks', 'pole', 'pipe', 'crowbar', 'hammer', 'mallet', 'wrench', 'spanner', 'brick', 'bricks', 'rock', 'rocks', 'stone', 'stones',
  'bottle', 'chair', 'stool', 'scissors', 'compass', 'pencil', 'rope', 'belt', 'whip', 'pan', 'shovel', 'spade', 'ruler', 'broom', 'mop', 'umbrella', 'plank',
  'board', 'screwdriver', 'saw', 'rake', 'branch', 'racket', 'racquet', 'skateboard',
] as const;
/** soft play objects: striking or throwing them at someone is play (pillow fight), not harm */
export const SOFT_OBJECTS = ['pillow', 'pillows', 'cushion', 'cushions', 'balloon', 'balloons', 'water_balloon', 'water_balloons', 'pool_noodle', 'noodle', 'feather', 'feathers', 'plush', 'teddy_bear', 'stuffed_animal', 'marshmallow', 'marshmallows', 'confetti', 'bubble', 'bubbles', 'paper_airplane', 'snowball', 'snowballs', 'sponge', 'foam'] as const;

const MULTI = ['baseball bat', 'cricket bat', 'softball bat', 'golf club', 'hockey stick', 'lacrosse stick', 'tennis racket', 'frying pan', 'metal pipe', 'brass knuckles', 'water balloons', 'water balloon', 'pool noodle', 'teddy bear', 'stuffed animal', 'paper airplane', 'ms. byte', 'ms byte', 'miss byte', 'each other', 'one another', 'home run'];
const HARM = new Set<string>(HARM_CAPABLE_OBJECTS), SOFT = new Set<string>(SOFT_OBJECTS);
const PERSON = new Set(['zapp', 'kira', 'max', 'ms_byte', 'miss_byte', 'teacher', 'principal', 'friend', 'friends', 'classmate', 'classmates', 'rival', 'bestie', 'buddy', 'student', 'students', 'kid', 'kids', 'boy', 'boys', 'girl', 'girls', 'someone', 'somebody', 'anyone', 'anybody', 'everyone', 'everybody', 'people', 'noob', 'genius', 'stranger', 'man', 'woman', 'guy', 'sister', 'brother', 'mom', 'dad', 'janitor', 'coach', 'player', 'opponent', 'victim', 'each_other', 'one_another', 'nerd', 'bully']);
const SUBJ_PRON = new Set(['he', 'she', 'they']);
const OBJ_PRON = new Set(['him', 'them', 'me', 'us', 'you', 'himself', 'herself', 'themselves']);
const THING_PRON = new Set(['it', 'this', 'that', 'these', 'those', 'something']);
const DET = new Set(['a', 'an', 'the', 'his', 'her', 'their', 'its', 'my', 'your', 'our', 'this', 'that', 'some', 'two', 'three', 'another', 'other', 'every', 'each', 'any']);
const ADJ = new Set(['big', 'huge', 'giant', 'little', 'small', 'tiny', 'wooden', 'metal', 'heavy', 'long', 'sharp', 'pointy', 'old', 'new', 'school', 'toy', 'plastic', 'poor', 'unsuspecting', 'innocent', 'sleeping', 'best', 'rusty', 'shiny', 'favorite', 'favourite', 'lucky', 'spare', 'broken', 'red', 'blue', 'green', 'yellow', 'gold', 'golden', 'silver', 'black', 'white', 'brown']);
/** tokens that end a noun phrase: after a verb they mean the target is omitted */
const STOP = new Set(['with', 'again', 'hard', 'repeatedly', 'twice', 'around', 'wildly', 'back', 'away', 'up', 'down', 'out', 'off', 'into', 'from', 'behind', 'until', 'till', 'when', 'while', 'then', 'and', 'but', 'so', 'because', 'as', 'before', 'after', 'at', 'in', 'on', 'over', 'near', 'by', 'to', 'for', 'toward', 'towards', 'through', 'across', 'like', 'quickly', 'suddenly', 'angrily', 'menacingly', 'threateningly', 'silently', 'quietly', 'first', 'too', 'instead', 'anyway', 'everywhere', 'nearby', 'there', 'here']);
const LEAD = new Set(['then', 'suddenly', 'later', 'finally', 'meanwhile', 'next', 'soon', 'now', 'immediately', 'instantly', 'quickly', 'slowly', 'secretly', 'quietly', 'silently', 'so', 'also', 'still', 'just', 'first', 'afterwards', 'afterward', 'and', 'but', 'when', 'whenever', 'while', 'until', 'till', 'once', 'before', 'after', 'because', 'if', 'or', 'even', 'only', 'soon', 'eventually', 'angrily', 'sneakily']);
const PREP = new Set(['at', 'in', 'on', 'during', 'inside', 'outside', 'behind', 'near', 'by', 'after', 'before', 'from', 'with', 'without', 'across', 'under', 'at_the']);
const BE = new Set(['is', 'was', 'gets', 'got', 'get', 'being', 'been', 'be', 'are', 'were']);

const STRIKE = new Set(['hit', 'hits', 'hitting', 'strike', 'strikes', 'striking', 'smack', 'smacks', 'smacking', 'whack', 'whacks', 'whacking', 'bash', 'bashes', 'bashing', 'clobber', 'clobbers', 'bonk', 'bonks', 'bonking', 'thwack', 'thwacks', 'wallop', 'wallops', 'punch', 'punches', 'punching', 'slap', 'slaps', 'slapping', 'kick', 'kicks', 'kicking', 'jab', 'jabs', 'attack', 'attacks', 'attacking', 'attacked', 'bop', 'bops', 'conk', 'conks', 'pummel', 'pummels', 'bludgeon', 'bludgeons', 'swat', 'swats', 'shoot', 'shoots', 'shooting']);
const SWING = new Set(['swing', 'swings', 'swinging', 'swung']);
const THROW = new Set(['throw', 'throws', 'throwing', 'threw', 'hurl', 'hurls', 'hurling', 'toss', 'tosses', 'tossing', 'fling', 'flings', 'flinging', 'lob', 'lobs', 'chuck', 'chucks', 'pelt', 'pelts', 'launch', 'launches']);
const THREAT = new Set(['threaten', 'threatens', 'threatening', 'threatened', 'menace', 'menaces', 'menacing']);
const BRANDISH = new Set(['brandish', 'brandishes', 'brandishing', 'wave', 'waves', 'waving', 'point', 'points', 'pointing', 'raise', 'raises', 'raising', 'lift', 'lifts', 'lifting', 'shake', 'shakes', 'shaking', 'hold', 'holds', 'holding']);
const MENACE_ADV = new Set(['menacingly', 'threateningly']);
const HARM_VERB_INF = new Set(['hit', 'hurt', 'beat', 'whack', 'smash', 'crush', 'clobber', 'bonk', 'kick', 'punch', 'attack', 'get', 'smack', 'bash', 'harm', 'injure', 'squash', 'flatten']);
const PURSUE_1 = new Set(['chase', 'chases', 'chased', 'chasing', 'hunt', 'hunts', 'hunting', 'corner', 'corners', 'cornering', 'cornered', 'stalk', 'stalks', 'stalking', 'pursue', 'pursues', 'pursuing', 'pursued', 'follow', 'follows', 'following', 'followed']);
const PURSUE_2: Array<[string[], string[]]> = [[['run', 'runs', 'ran', 'running', 'go', 'goes', 'went', 'going', 'come', 'comes', 'came', 'coming'], ['after']], [['charge', 'charges', 'charging', 'lunge', 'lunges', 'lunging', 'rush', 'rushes', 'rushing'], ['at', 'toward', 'towards']], [['track', 'tracks', 'hunt', 'hunts'], ['down']]];
const AMBUSH_1 = new Set(['ambush', 'ambushes', 'ambushing', 'ambushed', 'lurk', 'lurks', 'lurking', 'pounce', 'pounces', 'pouncing']);
const AMBUSH_2: Array<[string[], string[]]> = [[['sneak', 'sneaks', 'sneaking', 'creep', 'creeps', 'creeping', 'tiptoe', 'tiptoes'], ['up']], [['jump', 'jumps', 'jumping', 'leap', 'leaps', 'leaping', 'spring', 'springs', 'springing', 'pop', 'pops', 'popping'], ['out']], [['lie', 'lies', 'lying', 'lay'], ['in']]];
const WAIT = new Set(['wait', 'waits', 'waiting', 'waited', 'crouch', 'crouches', 'crouching', 'stand', 'stands', 'standing', 'hide', 'hides', 'hiding', 'hid', 'lie', 'lies', 'lying']);
const HIDE_PLACE = new Set(['behind', 'around', 'outside', 'beside', 'inside', 'under', 'beneath', 'in', 'near', 'by', 'for', 'until', 'till']);
const CONCEAL = new Set(['hide', 'hides', 'hiding', 'hid', 'conceal', 'conceals', 'concealing', 'tuck', 'tucks', 'tucking', 'keep', 'keeps', 'keeping', 'stash', 'stashes', 'slip', 'slips']);
const POSSESS = new Set(['with', 'using', 'uses', 'use', 'used', 'wielding', 'wields', 'holding', 'holds', 'hold', 'held', 'carrying', 'carries', 'carry', 'carried', 'brandishing', 'brandishes', 'grabs', 'grab', 'grabbing', 'grabbed', 'takes', 'take', 'took', 'taking', 'has', 'have', 'had', 'gets', 'get', 'got', 'finds', 'find', 'found', 'raises', 'raising', 'lifts', 'lifting', 'clutching', 'clutches', 'swinging', 'swings', 'waving', 'waves', 'brings', 'bring', 'brought', 'bringing', 'armed', 'keeps', 'hides', 'hiding', 'conceals', 'tucks']);
const POSSESS_2: Array<[string[], string[]]> = [[['picks', 'pick', 'picked', 'picking'], ['up']], [['pulls', 'pull', 'pulled', 'takes', 'took'], ['out']], [['grabs', 'grab'], ['hold']]];
const PUSH = new Set(['push', 'pushes', 'pushed', 'pushing', 'shove', 'shoves', 'shoved', 'shoving', 'knock', 'knocks', 'knocked', 'knocking', 'drop', 'drops', 'dropped', 'trip', 'trips', 'tripped', 'tripping', 'drag', 'drags', 'dragged', 'pull', 'pulls', 'pulled', 'yank', 'yanks', 'kick', 'kicks', 'kicked', 'tie', 'ties', 'tied', 'tying', 'lock', 'locks', 'locked', 'trap', 'traps', 'trapped', ...THROW]);
const DANGER = new Set(['stairs', 'staircase', 'stairway', 'steps', 'roof', 'rooftop', 'ledge', 'balcony', 'window', 'cliff', 'railing', 'rail', 'bridge', 'edge', 'pool', 'river', 'lake', 'sea', 'ocean', 'wall', 'walls', 'lockers', 'locker', 'floor', 'ground', 'traffic', 'street', 'road', 'stage', 'slide', 'tree', 'hole', 'pit', 'trash', 'dumpster', 'fence', 'glass', 'desk', 'table', 'chair', 'closet', 'cupboard', 'fire', 'oven', 'door', 'whiteboard', 'chalkboard', 'board']);
const JOSTLE = new Set(['aside', 'away', 'past', 'forward', 'along']);
const EVADE = new Set(['ducks', 'duck', 'dodges', 'dodge', 'flinches', 'flinch', 'cowers', 'cower', 'flees', 'flee', 'screams', 'scream', 'yelps', 'shrieks', 'winces']);
const SPORT = new Set(['ball', 'balls', 'baseball', 'cricket', 'softball', 'golf', 'hockey', 'tennis', 'lacrosse', 'practice', 'practise', 'practices', 'practicing', 'game', 'match', 'pitch', 'pitches', 'pitcher', 'home_run', 'homerun', 'wicket', 'innings', 'inning', 'batting', 'team', 'teammate', 'field', 'court', 'puck', 'goal', 'tee', 'serve', 'serves', 'serving', 'training', 'coach', 'score', 'scores', 'tournament', 'league', 'hoop', 'hoops', 'basket', 'rally', 'swing_practice']);
const TOOL = new Set(['fix', 'fixes', 'fixing', 'repair', 'repairs', 'repairing', 'build', 'builds', 'building', 'sweep', 'sweeps', 'sweeping', 'mop', 'mops', 'mopping', 'measure', 'measures', 'measuring', 'draw', 'draws', 'drawing', 'write', 'writes', 'writing', 'cut', 'cuts', 'cutting', 'dig', 'digs', 'digging', 'rake', 'rakes', 'raking', 'tighten', 'tightens', 'loosen', 'loosens', 'unscrew', 'unscrews', 'screw', 'screws', 'nail', 'nails', 'hammers', 'hammering', 'paint', 'paints', 'painting', 'stir', 'stirs', 'cook', 'cooks', 'cooking', 'flip', 'flips', 'shovel', 'shovels', 'shoveling', 'clean', 'cleans', 'cleaning', 'open', 'opens', 'prop', 'props', 'reach', 'reaches', 'knock_down', 'tidy', 'tidies', 'dust', 'dusts', 'polish', 'polishes', 'plant', 'plants', 'trim', 'trims', 'sharpen', 'sharpens']);

/** scene things: as the word before a strike verb they are its agent ("the coin hits Zapp" = the slapstick reversal) */
const SCENE = new Set(['coin', 'coins', 'button', 'buttons', 'ball', 'balls', 'desk', 'token', 'tokens', 'prize', 'reward', 'trophy', 'medal', 'gem', 'treasure', 'jackpot', 'door', 'machine', 'lever', 'switch', 'buzzer', 'box', 'prop', 'thing', 'pile', 'wave', 'shadow', 'light', 'wind']);
const BODY = new Set(['arm', 'arms', 'head', 'face', 'nose', 'back', 'leg', 'legs', 'stomach', 'belly', 'tummy', 'shoulder', 'shoulders', 'hand', 'hands', 'knee', 'knees', 'foot', 'feet', 'chin', 'ear', 'ears', 'eye', 'eyes', 'neck', 'hair', 'butt', 'shin', 'shins', 'toe', 'toes', 'jaw', 'mouth', 'chest', 'ribs', 'side']);
const ARRIVE = /\b(walks|comes|steps|runs|wanders|sneaks|strolls|bursts|rushes) (in|into|by|past|around|through|closer|over)\b|\b(enters|arrives|appears|approaches|shows up|turns the corner|opens the door|turns around|gets close|comes near|leans in|bends down|looks away)\b/;
const ON_BODY = new Set(['back', 'coat', 'jacket', 'shirt', 'hoodie', 'sweater', 'sleeve', 'sleeves', 'pocket', 'pockets', 'cape', 'cloak', 'robe', 'vest']);
const POSS_PRON = new Set(['his', 'her', 'their']);
export type IntentRule = 'strike_person' | 'threat' | 'armed_pursuit' | 'armed_ambush' | 'concealed_instrument' | 'implied_strike' | 'person_harm';
export interface IntentFinding {
  category: 'violence';
  rule: IntentRule;
  /** resolved actor(s) of the intent ('?' = unresolved) */
  actor: string;
  /** the intent verb phrase as written */
  intent: string;
  /** person target, 'omitted', or 'implied:<person>' */
  target: string;
  /** instrument (null = none: striking/pushing a person needs no object) */
  object: string | null;
  sentence: number;
  evidence: string;
  /** short summary for reasons and logs */
  term: string;
}

interface Holding { obj: string; sentence: number; clause: number; context: 'neutral' | 'sport' | 'tool' }
interface Subject { kind: 'person' | 'thing' | 'none'; ids: string[] }
const norm = (s: string) => s.replace(/_/g, ' ');

function normalize(text: string): string {
  let t = ` ${text.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"')} `;
  for (const m of MULTI) t = t.replace(new RegExp(`(^|[^a-z])${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^a-z]|$)`, 'g'), (_x, a) => `${a}${m.replace(/\.?\s+/g, '_').replace(/\./g, '')}`);
  return t.replace(/\s+/g, ' ').trim();
}
const tokens = (s: string) => s.replace(/[^a-z0-9_' ]+/g, ' ').split(' ').filter(Boolean);
/** clause boundaries: commas and connectives (the connective itself is dropped; coordinated clauses inherit the subject) */
function splitClauses(sentence: string): string[] {
  const parts = sentence.split(/,|\b(?:and then|and|then|but|while|whenever|when|until|till|as soon as|once|because|so that|so|or|who|which)\b/).map((c) => c.trim()).filter(Boolean);
  const out: string[] = [];
  for (const c of parts) {
    const t = tokens(c);
    const fragment = t.length > 0 && (PERSON.has(t[0]) || OBJ_PRON.has(t[0])) && (t.length === 1 || ['with', 'holding', 'carrying', 'wielding'].includes(t[1]));
    if (fragment && out.length) out[out.length - 1] += ' and ' + c; else out.push(c);
  }
  return out;
}

export function analyzeIntent(text: string): IntentFinding[] {
  const out: IntentFinding[] = [];
  const sentences = normalize(text).split(/[.!?;:]+/).map((s) => s.trim()).filter(Boolean);
  const mentioned: string[] = [];
  const holds = new Map<string, Holding[]>();
  let last: Subject = { kind: 'none', ids: [] };
  const sentToks = sentences.map(tokens);
  const personsIn = (toks: string[]) => toks.filter((t) => PERSON.has(t));
  const evasionIn = (toks: string[]) => toks.some((t) => EVADE.has(t)) || /\bruns away\b|\bjumps back\b|\bcovers (his|her|their) head\b/.test(toks.join(' '));
  const push = (f: Omit<IntentFinding, 'category' | 'term'>) => {
    if (out.some((x) => x.rule === f.rule && x.sentence === f.sentence)) return;
    if (f.object) f.object = norm(f.object);
    f.target = norm(f.target); f.actor = norm(f.actor);
    const what = { strike_person: 'strikes a person', threat: 'threatens', armed_pursuit: 'pursues with a harm-capable object', armed_ambush: 'lies in wait / hides with a harm-capable object (ambiguous weapon + ambush)', concealed_instrument: 'conceals a harm-capable object near a person', implied_strike: 'swings/strikes with a harm-capable object at an implied person', person_harm: 'pushes/throws/traps a person into danger' }[f.rule];
    void what;
    out.push({ category: 'violence', ...f, term: `${f.rule}: ${f.actor} "${norm(f.intent)}"${f.object ? ` + ${f.object}` : ''} -> ${f.target}`.slice(0, 110) });
  };

  sentences.forEach((sentence, si) => {
    const sToks = sentToks[si];
    const sport = sToks.some((t) => SPORT.has(t));
    let clauseIdx = 0;
    for (const clause of splitClauses(sentence)) {
      const ci = clauseIdx++;
      const toks = tokens(clause);
      if (!toks.length) continue;
      // ---- subject ----
      const subj = subjectOf(toks, last, mentioned);
      for (const t of toks) if (PERSON.has(t) && !mentioned.includes(t)) mentioned.push(t);
      if (subj.kind !== 'none') last = subj; else Object.assign(subj, last);
      const actorIds = subj.kind === 'person' ? subj.ids : [];
      const tool = toks.some((t) => TOOL.has(t));
      const context: Holding['context'] = sport ? 'sport' : tool ? 'tool' : 'neutral';
      // ---- possession (registered before intents: "chases Zapp with a bat") ----
      const clauseObjs: string[] = [];
      for (let k = 0; k < toks.length; k++) {
        let lead = POSSESS.has(toks[k]) ? 1 : 0;
        for (const [a, b] of POSSESS_2) if (a.includes(toks[k]) && b.includes(toks[k + 1] ?? '')) lead = 2;
        if (toks[k] === 'armed' && toks[k + 1] === 'with') lead = 2;
        if (!lead) continue;
        const o = objectAt(toks, k + lead);
        if (o && (HARM.has(o.w) || SOFT.has(o.w))) {
          clauseObjs.push(o.w);
          if (HARM.has(o.w)) for (const id of actorIds) { const h = holds.get(id) ?? []; h.push({ obj: o.w, sentence: si, clause: ci, context }); holds.set(id, h); }
        }
      }
      // instrument mentioned later in the same sentence ("chases Zapp and Max with a bat", "waits, holding a bat")
      const sentenceObjs = sToks.filter((t, k) => (HARM.has(t) || SOFT.has(t)) && k > 0 && (POSSESS.has(sToks[k - 1]) || DET.has(sToks[k - 1]) || ADJ.has(sToks[k - 1])) && sToks.slice(Math.max(0, k - 4), k).some((x) => POSSESS.has(x)));
      const heldBy = (ids: string[], opts: { any?: boolean } = {}) => { for (const id of ids) for (const h of holds.get(id) ?? []) if (h.sentence <= si && (opts.any || h.context === 'neutral' || (h.sentence === si && h.clause === ci))) return h.obj; return null; };
      const inst = (ids: string[], opts: { any?: boolean } = {}) => clauseObjs.find((o) => HARM.has(o)) ?? sentenceObjs.find((o) => HARM.has(o)) ?? heldBy(ids, opts);
      const softOnly = () => (clauseObjs.length > 0 && clauseObjs.every((o) => SOFT.has(o))) || (!clauseObjs.length && sentenceObjs.length > 0 && sentenceObjs.every((o) => SOFT.has(o)));
      // other people in this or the previous sentence; an ambiguous pronoun actor (several candidates) still has someone
      // else nearby whenever two or more people are in that window
      const others = (ids: string[]) => {
        const ctx = [...new Set([...personsIn(sToks), ...(si > 0 ? personsIn(sentToks[si - 1]) : [])])];
        const rest = ctx.filter((p) => !ids.includes(p));
        return rest.length ? rest : ids.length > 1 && ctx.length >= 2 ? ctx : [];
      };
      const actorName = actorIds.join('|') || '?';
      for (let k = 0; k < toks.length; k++) {
        const w = toks[k];
        // passive: "Zapp gets chased by Kira", "Zapp is hit by the coin"
        let actor = actorIds, passiveTarget: string | null = null, actorKind = subj.kind;
        const byAt = toks.indexOf('by', k + 1);
        if (k > 0 && BE.has(toks[k - 1]) && byAt > k && byAt <= k + 3) {
          const a = toks[byAt + 1] === 'the' || DET.has(toks[byAt + 1] ?? '') ? toks[byAt + 2] : toks[byAt + 1];
          actorKind = a && PERSON.has(a) ? 'person' : a && SUBJ_PRON.has(a) ? 'person' : 'thing';
          actor = a && PERSON.has(a) ? [a] : [];
          passiveTarget = subj.kind === 'person' ? subj.ids.join('|') : null;
        }
        const aName = actor.join('|') || actorName;
        // ---- strike / shoot / swing / throw ----
        if (STRIKE.has(w) || SWING.has(w) || THROW.has(w)) {
          if (k > 0 && (DET.has(toks[k - 1]) || ADJ.has(toks[k - 1]) || SPORT.has(toks[k - 1]))) continue; // noun: "a kick", "her golf swing"
          if ((w === 'kick' || w === 'kicks') && toks[k + 1] === 'off') continue;
          if (k > 0 && BE.has(toks[k - 1]) && !passiveTarget && !w.endsWith('ing')) continue; // "Zapp gets hit" (passive, no agent): not the subject's intent; "is hitting" stays active
          // the word before the verb is a thing -> that thing is the agent ("the coin hits Kira"); a HARM object with a
          // possessor ("his bat hits Kira") -> the possessor strikes with it
          let viaObject: string | null = null;
          const pv = toks[k - 1] ?? '';
          if (!passiveTarget && (SCENE.has(pv) || HARM.has(pv) || SOFT.has(pv))) {
            const pp = toks[k - 2] ?? '';
            const owner = POSS_PRON.has(pp) || (/'s$/.test(pp) && PERSON.has(pp.slice(0, -2)));
            if (!(owner && HARM.has(pv))) continue;
            viaObject = pv;
          }
          if (actorKind !== 'person') continue; // a thing (the coin, a bat) hitting someone is the slapstick reversal, not intent
          let j = k + 1;
          let instrument: string | null = null;
          const d = objectAt(toks, j);
          if ((SWING.has(w) || THROW.has(w)) && d && !PERSON.has(d.w) && !OBJ_PRON.has(d.w) && d.w !== 'her') { instrument = d.w === 'it' ? inst(actor, { any: true }) : d.w; j = d.next; }
          if (viaObject) instrument = viaObject;
          if (toks[j] === 'at' || toks[j] === 'toward' || toks[j] === 'towards' || (SWING.has(w) && toks[j] === 'on')) j++;
          const tg = passiveTarget ? { kind: 'person' as const, name: passiveTarget, next: j } : targetAt(toks, j);
          const withObj = toks.slice(j).includes('with') ? objectAt(toks, toks.indexOf('with', j) + 1)?.w ?? null : null;
          instrument ??= withObj && withObj !== 'it' ? withObj : withObj === 'it' ? inst(actor, { any: true }) : null;
          const soft = instrument ? SOFT.has(instrument) : softOnly();
          // "throws Kira the coin" (ditransitive: Kira receives something) is not an attack on Kira
          if (THROW.has(w) && tg.kind === 'person' && !instrument && objectAt(toks, tg.next) && !STOP.has(toks[tg.next] ?? '')) continue;
          if (THROW.has(w) && tg.kind === 'person' && !instrument && !toks.slice(k, j).includes('at')) {
            push({ rule: 'person_harm', actor: aName, intent: toks.slice(k, Math.min(toks.length, j + 3)).join(' '), target: tg.name, object: null, sentence: si, evidence: clause }); continue; // throws Kira (a person)
          }
          if (tg.kind === 'person') {
            if (soft) continue;
            if ((w === 'shoot' || w === 'shoots' || w === 'shooting') && !instrument && sport) continue;
            if (THROW.has(w) && !instrument) continue;
            push({ rule: 'strike_person', actor: aName, intent: toks.slice(k, Math.min(toks.length, j + 1)).join(' '), target: tg.name, object: instrument ?? inst(actor), sentence: si, evidence: clause });
          } else if (tg.kind === 'omitted') {
            // implied target: someone reacts (ducks, dodges...) or arrives/approaches right then; an explicit non-harm
            // object ("throws his hands up") never falls back to a held one
            const o = instrument ? (HARM.has(instrument) ? instrument : null) : inst(actor);
            if (!o || soft) continue;
            const evade = evasionIn(sToks) || (si + 1 < sentences.length && evasionIn(sentToks[si + 1]));
            const arrive = ARRIVE.test(sentence) || (si > 0 && ARRIVE.test(sentences[si - 1]));
            if ((sport || tool) && !evade) continue;
            const imp = others(actor);
            if ((imp.length && (evade || arrive)) || evade) push({ rule: 'implied_strike', actor: aName, intent: toks.slice(k, Math.min(toks.length, j + 1)).join(' '), target: `implied:${imp[0] ?? 'someone reacting'}`, object: o, sentence: si, evidence: clause });
          }
          continue;
        }
        // ---- threats ----
        const menaceAdv = toks.some((t) => MENACE_ADV.has(t));
        if (THREAT.has(w) || (BRANDISH.has(w) && (menaceAdv || ['at', 'over', 'above'].includes(toks[(objectAt(toks, k + 1)?.next ?? -1)] ?? '')))) {
          if (actorKind !== 'person') continue;
          const d = BRANDISH.has(w) ? objectAt(toks, k + 1) : null;
          const brandished = d && HARM.has(d.w) ? d.w : null;
          if (BRANDISH.has(w) && !brandished) continue;
          let j = d ? d.next : k + 1;
          if (['at', 'over', 'above', 'toward', 'towards'].includes(toks[j])) j++;
          const tg = targetAt(toks, j);
          if (tg.kind === 'thing') continue;
          const toHarm = toks[j] === 'to' && HARM_VERB_INF.has(toks[j + 1] ?? '') || (toks[tg.next] === 'to' && HARM_VERB_INF.has(toks[tg.next + 1] ?? ''));
          const withW: string | null = toks.includes('with') ? (objectAt(toks, toks.indexOf('with') + 1)?.w ?? null) : null;
          const withObj = withW === 'it' || withW === 'them' ? inst(actor, { any: true }) : withW;
          const o = brandished ?? withObj ?? inst(actor);
          // a threat aimed at a person needs no object ("threatens Kira so she hands over the coin"), unless it is a threat
          // to do something harmless ("threatens to tell the teacher")
          const benignTo = toks[tg.next] === 'to' && !HARM_VERB_INF.has(toks[tg.next + 1] ?? '');
          const personThreat = THREAT.has(w) && tg.kind === 'person' && !benignTo;
          if ((o && !SOFT.has(o)) || toHarm || personThreat) push({ rule: 'threat', actor: aName, intent: toks.slice(k, Math.min(toks.length, j + 2)).join(' '), target: tg.kind === 'person' ? tg.name : 'omitted', object: o && !SOFT.has(o) ? o : null, sentence: si, evidence: clause });
          continue;
        }
        if (menaceAdv && actorKind === 'person' && inst(actor)) { push({ rule: 'threat', actor: aName, intent: toks.filter((t) => MENACE_ADV.has(t))[0], target: 'omitted', object: inst(actor), sentence: si, evidence: clause }); continue; }
        // ---- pursuit ----
        let pLen = PURSUE_1.has(w) ? 1 : 0;
        for (const [a, b] of PURSUE_2) if (a.includes(w) && b.includes(toks[k + 1] ?? '')) pLen = 2;
        if (pLen) {
          if (actorKind !== 'person') continue;
          const tg = passiveTarget ? { kind: 'person' as const, name: passiveTarget, next: k + pLen } : targetAt(toks, k + pLen);
          if (tg.kind === 'thing') continue;
          const o = inst(actor);
          if (!o) continue;
          const target = tg.kind === 'person' ? tg.name : others(actor)[0] ? `implied:${others(actor)[0]}` : 'omitted';
          push({ rule: 'armed_pursuit', actor: aName, intent: toks.slice(k, Math.min(toks.length, k + pLen + 1)).join(' '), target, object: o, sentence: si, evidence: clause });
          continue;
        }
        // ---- ambush / concealment (the actor hides or waits; ambiguous with any held harm-capable object) ----
        let aLen = AMBUSH_1.has(w) ? 1 : 0;
        for (const [a, b] of AMBUSH_2) if (a.includes(w) && b.includes(toks[k + 1] ?? '')) aLen = 2;
        if (!aLen && WAIT.has(w)) {
          // "waits behind the door", "hides behind the lockers", "waits for Zapp" (not "waits for the coin"), "lies in wait"
          const nx = toks[k + 1] ?? '';
          const forPerson = (nx === 'for' || nx === 'until' || nx === 'till') && ['person'].includes(targetAt(toks, k + 2).kind);
          const hideVerb = /^(hide|hides|hiding|hid)$/.test(w);
          const covert = ['behind', 'around', 'outside'].includes(nx) || (hideVerb && (HIDE_PLACE.has(nx) || nx === '' || nx === 'with' || nx === 'quietly'));
          if (covert) aLen = 1;
          else if (forPerson) aLen = -1; // waiting for a person, no concealment
        }
        if (aLen) {
          if (actorKind !== 'person') continue;
          const o = aLen < 0 ? inst(actor) : inst(actor, { any: true });
          if (!o) continue;
          if (aLen < 0 && (sport || tool)) continue;
          aLen = Math.abs(aLen);
          const rest = toks.slice(k + aLen);
          const tIdx = rest.findIndex((t) => PERSON.has(t) || OBJ_PRON.has(t));
          const target = tIdx >= 0 ? rest[tIdx] : others(actor)[0] ? `implied:${others(actor)[0]}` : 'omitted';
          push({ rule: 'armed_ambush', actor: aName, intent: toks.slice(k, Math.min(toks.length, k + aLen + 2)).join(' '), target, object: o, sentence: si, evidence: clause });
          continue;
        }
        // ---- concealed instrument ("hides a hammer behind her back") ----
        if (CONCEAL.has(w)) {
          const d = objectAt(toks, k + 1);
          const loc = toks.slice(d?.next ?? k, (d?.next ?? k) + 3);
          const onBody = ['behind', 'under', 'in', 'inside', 'beneath', 'up'].includes(loc[0] ?? '') && POSS_PRON.has(loc[1] ?? '') && ON_BODY.has(loc[2] ?? '');
          if (d && HARM.has(d.w) && actorKind === 'person' && onBody) {
            const near = [...others(actor), ...(si + 1 < sentences.length ? personsIn(sentToks[si + 1]).filter((p) => !actor.includes(p)) : [])];
            if (near.length) push({ rule: 'concealed_instrument', actor: aName, intent: toks.slice(k, Math.min(toks.length, d.next + 3)).join(' '), target: `implied:${near[0]}`, object: d.w, sentence: si, evidence: clause });
          }
          continue;
        }
        // ---- person into danger: push / shove / knock / trip / drag / throw / tie up / lock in ----
        if (PUSH.has(w) && actorKind === 'person') {
          let j = k + 1;
          if ((w.startsWith('tie') || w === 'tying') && toks[j] === 'up') j++;
          const tg = targetAt(toks, j);
          if (tg.kind !== 'person') continue;
          const rest = toks.slice(tg.next, tg.next + 6);
          const danger = rest.some((t) => DANGER.has(t)) && rest.slice(0, 4).some((t) => ['down', 'off', 'out', 'into', 'over', 'onto', 'from', 'through', 'against', 'in', 'inside', 'under', 'to', 'toward', 'towards'].includes(t));
          const jostle = rest.slice(0, 2).some((t) => JOSTLE.has(t)) || rest.slice(0, 4).join(' ').startsWith('out of the way');
          const trip = /^trip/.test(w);
          const knock = /^knock/.test(w) && ['out', 'over', 'down', 'unconscious'].includes(rest[0] ?? '');
          const downOnly = /^(push|shove)/.test(w) && rest[0] === 'down';
          const tied = /^(tie|tying)/.test(w) && (toks[k + 1] === 'up' || rest[0] === 'up');
          const locked = /^(lock|trap)/.test(w) && ['in', 'inside', 'into'].includes(rest[0] ?? '');
          const thrown = THROW.has(w);
          if (danger || trip || knock || downOnly || tied || locked || (thrown && !jostle)) {
            if (jostle && !danger) continue;
            push({ rule: 'person_harm', actor: aName, intent: toks.slice(k, Math.min(toks.length, tg.next + 4)).join(' '), target: tg.name, object: null, sentence: si, evidence: clause });
          }
        }
      }
    }
  });
  return out;
}

/** first noun of the noun phrase starting at k (skipping determiners/adjectives); null when none */
function objectAt(toks: string[], k: number): { w: string; next: number } | null {
  let j = k;
  while (j < toks.length && (DET.has(toks[j]) || ADJ.has(toks[j]))) j++;
  if (j >= toks.length || STOP.has(toks[j])) return null;
  // compound: "a toy bat", "a wooden baseball_bat" -> the head noun (last of up to 2 nouns)
  const nx = toks[j + 1];
  if (nx && (HARM.has(nx) || SOFT.has(nx)) && !HARM.has(toks[j]) && !PERSON.has(toks[j])) return { w: nx, next: j + 2 };
  return { w: toks[j], next: j + 1 };
}
/** what an intent verb is aimed at, starting at token k */
function targetAt(toks: string[], k: number): { kind: 'person' | 'thing' | 'omitted'; name: string; next: number } {
  let j = k;
  if (j >= toks.length) return { kind: 'omitted', name: 'omitted', next: j };
  const t = toks[j];
  if (PERSON.has(t)) return { kind: 'person', name: t, next: j + 1 };
  if (OBJ_PRON.has(t) || SUBJ_PRON.has(t)) return { kind: 'person', name: t, next: j + 1 };
  if (t === 'her' || t === 'his' || t === 'their') {
    const nx = toks[j + 1];
    if (t === 'her' && (!nx || STOP.has(nx) || PERSON.has(nx))) return { kind: 'person', name: 'her', next: j + 1 };
    if (nx && BODY.has(nx)) return { kind: 'person', name: `${t} ${nx}`, next: j + 2 };
    return { kind: 'thing', name: `${t} ${nx ?? ''}`, next: j + 2 };
  }
  if (/'s$/.test(t) && PERSON.has(t.slice(0, -2))) {
    const nx = toks[j + 1];
    if (nx && BODY.has(nx)) return { kind: 'person', name: `${t} ${nx}`, next: j + 2 };
    return { kind: 'thing', name: `${t} ${nx ?? ''}`, next: j + 2 };
  }
  if (THING_PRON.has(t)) return { kind: 'thing', name: t, next: j + 1 };
  if (STOP.has(t)) return { kind: 'omitted', name: 'omitted', next: j };
  while (j < toks.length && (DET.has(toks[j]) || ADJ.has(toks[j]))) j++;
  const h = toks[j];
  if (!h) return { kind: 'omitted', name: 'omitted', next: j };
  if (PERSON.has(h)) return { kind: 'person', name: h, next: j + 1 };
  return { kind: 'thing', name: h, next: j + 1 };
}
/** grammatical subject of a clause: a person (named, generic, pronoun), a thing, or none (verb-initial: inherits) */
function subjectOf(toks: string[], last: Subject, mentioned: string[]): Subject {
  let i = 0;
  while (i < toks.length && LEAD.has(toks[i])) i++;
  if (PREP.has(toks[i] ?? '')) {
    const j = toks.findIndex((t, k) => k > i && k <= i + 5 && (PERSON.has(t) || SUBJ_PRON.has(t)));
    if (j < 0) return { kind: 'none', ids: [] };
    i = j;
  }
  const t = toks[i];
  if (!t) return { kind: 'none', ids: [] };
  if (PERSON.has(t)) {
    // "Zapp and Kira ..." / "Kira and her friend": every coordinated person is a subject
    const ids = [t];
    for (let k = i + 1; k < Math.min(toks.length, i + 5); k++) { if (PERSON.has(toks[k])) ids.push(toks[k]); else if (!['and', 'her', 'his', 'their', 'the', 'a', 'best'].includes(toks[k])) break; }
    return { kind: 'person', ids: [...new Set(ids)] };
  }
  if (t === 'both' || t === 'all') return { kind: 'person', ids: mentioned.length ? [...mentioned] : ['?'] };
  if (SUBJ_PRON.has(t)) return { kind: 'person', ids: mentioned.length ? [...mentioned] : ['?'] }; // conservative: any person mentioned so far
  if (THING_PRON.has(t)) return { kind: 'thing', ids: [t] };
  if (DET.has(t) || ADJ.has(t)) {
    let j = i;
    while (j < toks.length && (DET.has(toks[j]) || ADJ.has(toks[j]))) j++;
    const h = toks[j] ?? '';
    if (PERSON.has(h)) return { kind: 'person', ids: [h] };
    return { kind: 'thing', ids: [h] };
  }
  if (/'s$/.test(t)) return { kind: 'thing', ids: [toks[i + 1] ?? t] }; // "Zapp's cat knocks ..."
  // verb-initial / participle / fragment: inherit the previous clause's subject
  void last;
  return { kind: 'none', ids: [] };
}

/** @deprecated clause-local API kept for callers of commit 18553be; returns the contextual findings */
export const classifyObjectIntent = (text: string) => analyzeIntent(text);
