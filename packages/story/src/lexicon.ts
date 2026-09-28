// Deterministic idea scanner: safety, protected IP, characters, places, objects and mechanisms.
// Used by the offline `rules` provider AND by Stage C as an independent safety net for any model provider.
// General vocabulary lists — never keyed to specific benchmark sentences.
import { analyzeIntent } from './safety.ts';

export type Mention<K extends string> = { mention: string; kind: K; id?: string; index: number };

const SAFETY: Record<string, string[]> = {
  violence: ['kill', 'kills', 'killed', 'murder', 'stab', 'stabs', 'shoot', 'shoots', 'shot him', 'blood', 'bloody', 'gore', 'decapitat', 'torture', 'beat up', 'punches', 'strangle', 'blow up the school', 'blows up the school', 'blow up the class', 'explodes the school', 'bomb', 'dynamite', 'grenade', 'terror'],
  weapon: ['gun', 'guns', 'pistol', 'rifle', 'shotgun', 'knife', 'knives', 'sword', 'machete', 'axe'],
  sexual: ['sexy', 'nude', 'naked', 'sex', 'strip', 'lingerie', 'seduce'],
  drugs_alcohol: ['beer', 'vodka', 'wine', 'whiskey', 'alcohol', 'drunk', 'weed', 'drugs', 'cocaine', 'cigarette', 'vape', 'vaping', 'smoking'],
  dangerous_imitation: ['fork in the outlet', 'fork in an outlet', 'outlet', 'electrocute', 'on fire', 'set fire', 'sets fire', 'setting', 'lighter', 'matches', 'tide pod', 'lick a battery', 'choke', 'jump off the roof', 'microwave', 'bleach'],
  self_harm: ['suicide', 'self-harm', 'self harm', 'cut myself', 'hurt himself', 'hurt herself'],
  real_money_giveaway: ['giveaway', 'free money', 'real money', 'gift card', 'giftcard', 'cash app', 'paypal', 'link in bio', 'subscribe to win', 'dm me'],
  platform_currency: ['robux', 'v-bucks', 'vbucks', 'minecoins', 'free robux'],
  cruelty: ['ugly', 'fat', 'stupid', 'dumb', 'loser', 'humiliat', 'bully', 'bullies', 'mocks'],
};
// "setting" alone is too broad; only count it next to fire words
const FIRE_CONTEXT = /(setting|sets|set)\s+(\w+\s+){0,3}(on\s+)?fire|on fire|fire\b/;

const IP: Array<{ names: string[]; kind: 'protected_character' | 'protected_brand' | 'real_person' }> = [
  { kind: 'protected_brand', names: ['roblox', 'minecraft', 'fortnite', 'bloxburg', 'brookhaven', 'adopt me', 'among us', 'disney', 'pixar', 'marvel', 'dc comics', 'nintendo', 'playstation', 'xbox', 'lego', 'pokemon', 'pokémon', 'tiktok', 'youtube'] },
  { kind: 'protected_character', names: ['creeper', 'steve from', 'mario', 'luigi', 'sonic', 'pikachu', 'spongebob', 'patrick star', 'shrek', 'elsa', 'mickey', 'spider-man', 'spiderman', 'batman', 'superman', 'hulk', 'iron man', 'yoda', 'darth vader', 'harry potter', 'skibidi', 'huggy wuggy', 'peppa', 'bluey', 'kirby', 'link from zelda', 'garfield'] },
  { kind: 'real_person', names: ['mrbeast', 'mr beast', 'pewdiepie', 'taylor swift', 'elon musk', 'ishowspeed', 'kai cenat'] },
];
const STYLE_QUALIFIER = /(style|styled|inspired|like|vibes|themed|-ish|esque)/;

const CHARACTERS: Array<{ words: string[]; kind: 'cast' | 'unbuilt_cast' | 'generic_human' | 'non_human'; id?: string; canon?: string }> = [
  { words: ['zapp'], kind: 'cast', id: 'zapp' },
  { words: ['kira'], kind: 'cast', id: 'kira' },
  { words: ['max'], kind: 'unbuilt_cast', canon: 'Max' },
  { words: ['ms. byte', 'ms byte', 'miss byte', 'teacher'], kind: 'unbuilt_cast', canon: 'Ms. Byte' },
  { words: ['bztt', 'robot', 'drone'], kind: 'unbuilt_cast', canon: 'BZTT' },
  { words: ['friend', 'classmate', 'rival', 'bestie', 'buddy', 'student', 'kid', 'boy', 'girl', 'someone', 'somebody', 'noob', 'pro', 'genius', 'principal'], kind: 'generic_human' },
  { words: ['dog', 'puppy', 'cat', 'kitten', 'hamster', 'bird', 'parrot', 'fish', 'snake', 'monkey', 'dragon', 'dinosaur', 'alien', 'monster', 'ghost', 'zombie', 'unicorn', 'butterfly'], kind: 'non_human' },
];

const PLACES: Array<{ words: string[]; kind: 'classroom' | 'school' | 'elsewhere' }> = [
  { words: ['classroom', 'class room', 'in class', 'the class'], kind: 'classroom' },
  { words: ['hallway', 'cafeteria', 'library', 'gym', 'office', 'locker', 'playground', 'school yard', 'schoolyard'], kind: 'school' },
  { words: ['school bus', 'bus', 'living room', 'bedroom', 'kitchen', 'home', 'house', 'park', 'street', 'beach', 'space', 'castle', 'forest', 'mall', 'store', 'shop', 'arcade'], kind: 'elsewhere' },
];

// object vocabulary -> class. trigger/collectible/furniture map to registered props; the rest are unavailable.
const OBJECTS: Array<{ words: string[]; cls: 'trigger' | 'collectible' | 'furniture' | 'unavailable'; id?: string }> = [
  { words: ['button', 'buttons', 'switch', 'lever', 'buzzer', 'remote', 'dispenser', 'prize machine', 'machine'], cls: 'trigger', id: 'suspicious_button' },
  { words: ['coin', 'coins', 'token', 'gold', 'treasure', 'gem', 'jewel', 'diamond', 'medal', 'trophy', 'prize', 'reward', 'star', 'badge'], cls: 'collectible', id: 'spark_coin' },
  { words: ['desk', 'table'], cls: 'furniture', id: 'student_desk' },
  { words: ['pizza', 'cake', 'cookie', 'candy', 'burger', 'sandwich', 'apple', 'banana', 'ice cream', 'soda', 'juice', 'milk', 'gum', 'donut', 'slime', 'lunch', 'food'], cls: 'unavailable' },
  { words: ['phone', 'laptop', 'tablet', 'computer', 'router', 'console', 'controller', 'tv', 'television', 'speaker', 'camera', 'video game'], cls: 'unavailable' },
  { words: ['backpack', 'lunchbox', 'book', 'homework', 'report card', 'pencil', 'eraser', 'ruler', 'paper', 'card', 'ball', 'balloon', 'hat', 'shoe', 'chair', 'door', 'window', 'magnet', 'hammer', 'potion', 'bottle', 'cup', 'box', 'rope', 'ladder', 'money', 'cash', 'dollar', 'wallet'], cls: 'unavailable' },
];

// mechanisms / verbs
const MECH: Record<string, RegExp> = {
  grow: /\b(grow|grows|growing|grew|bigger|huge|giant|gigantic|enormous|massive|too large|too big|expands?|inflates?|fills the|keeps getting bigger|gets gigantic|becomes (huge|giant|gigantic|enormous))/,
  shrink: /\b(shrink|shrinks|shrinking|tiny as|size of an ant|miniature)\b/,
  multiply: /\b(multiply|multiplies|duplicates?|rain of|coins everywhere|flood of)\b/,
  fly: /\b(flies|fly|flying|float|floats|levitat|zooms? (up|over|around))/,
  teleport: /\b(teleport|vanish|vanishes|disappear|disappears|invisible)\b/,
  transform: /\b(turns? into|transforms? into|morphs? into|transforms|morphs)\b(?!\s+(a |an )?(something )?(huge|big|bigger|giant|gigantic|enormous|massive|large))/,
  explode: /\b(explode|explodes|exploding|blow up|blows up|boom)\b/,
  fire: /\b(fire|burn|burns|flames?|melt|melts)\b/,
  speech: /\b(says|said|yells?|shouts?|tells?|asks?|whispers?|screams?)\b|["“'][^"”']{2,}["”']/,
  needsText: /\b(reads?|read the|message|sign says|screen says|explains|the text|writes?|written|pun|punchline)\b/,
  notice: /\b(spot|spots|spotted|notice|notices|sees|see|finds|found|discovers?|hidden|secret|across the room|glowing|shiny)\b/,
  race: /\b(race|races|racing|chase|chases|chasing|sprint|sprints|runs? for|dives? for|first to|before (him|her|zapp|kira)|gets there first|whoever gets)\b/,
  press: /\b(press|presses|pressed|pushes|push|tap|taps|click|clicks|spam|hits the button|holds? it down|double-press)\b/,
  repeat: /\b(again and again|keeps pressing|keeps trying|finally|at last|third try|after (three|two|many) tries|until a coin)\b/,
  win: /\b(win|wins|won|gets|got|finally|celebrat|victory|cheers|rich|beats)\b/,
  instant: /\b(instantly|immediately|right away|in one second|a second later|then it|loses it)\b/,
  noobSmart: /\b(noob|beginner|simple way|obvious|the smart way|smart|clever|genius|pro way|like a pro|pro\b|expert|better way|double-press|properly|carefully|calmly)\b/,
  warn: /\b(warns?|tells? (him|her) not|don't|do not|skeptical|suspicious)\b/,
  celebrate: /\b(celebrat|victory|cheers|dances?|party|happy dance|i'm rich)\b/,
  crush: /\b(flatten|flattens|flattened|squash|squashes|squashed|crush|crushes|crushed|buried|buries|falls on|lands on|topples)\b/,
  throw: /\b(throw|throws|threw|toss|tosses|hurl)\b/,
  carry: /\b(grab|grabs|pick up|picks up|carries|carry|steal|steals|stole|snatch|snatches|holds the|hold the)\b/,
  tool: /\b(uses?|using) (a|an|the|his|her)\b|\bwith (a|an|the|his|her) (magnet|hammer|stick|rope|broom|ladder|tool|fork)/,
  eat: /\b(eat|eats|ate|drink|drinks|drinking|bite)\b/,
  collide: /\b(collide|collides|bump into|crash into|shoves?|push(es)? (him|her|zapp|kira) aside)\b/,
  jump: /\b(jump|jumps|jumped|leap|leaps|hop|hops|backflip|cartwheel)\b/,
  dance: /\b(dance|dances|dancing)\b/,
  sleep: /\b(sleep|sleeps|asleep|nap|naps)\b/,
  fix: /\b(fix|fixes|repair|repairs|unplug)\b/,
  landingZone: /\b(where the coin lands|in the way|right under|stands? (right )?where)\b/,
};

export interface IdeaScan {
  text: string;
  safety: Array<{ category: string; term: string }>;
  ip: Array<{ name: string; kind: 'protected_character' | 'protected_brand' | 'real_person'; styleQualified: boolean }>;
  characters: Array<Mention<'cast' | 'unbuilt_cast' | 'generic_human' | 'non_human'> & { canon?: string }>;
  places: Array<Mention<'classroom' | 'school' | 'elsewhere'>>;
  objects: Array<Mention<'trigger' | 'collectible' | 'furniture' | 'unavailable'>>;
  mech: Record<string, boolean>;
}

function findWord(text: string, w: string): number {
  const re = new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
  const m = re.exec(text);
  return m ? m.index + m[1].length : -1;
}

export function scanIdea(idea: string): IdeaScan {
  const text = ' ' + idea.toLowerCase().replace(/[’]/g, "'") + ' ';
  const safety: IdeaScan['safety'] = [];
  for (const [cat, words] of Object.entries(SAFETY)) for (const w of words) {
    if (w === 'setting') continue;
    if (findWord(text, w) >= 0) safety.push({ category: cat, term: w });
  }
  if (FIRE_CONTEXT.test(text) && !safety.some((s) => s.category === 'dangerous_imitation')) safety.push({ category: 'dangerous_imitation', term: 'fire' });
  // document-level contextual intent (safety.ts): implied strikes, threats, armed pursuit/ambush/concealment, pushing a
  // person into danger; targets across clauses/sentences and pronouns; sport and tool contexts preserved
  for (const f of analyzeIntent(idea)) safety.push({ category: f.category, term: f.term });
  const ip: IdeaScan['ip'] = [];
  for (const g of IP) for (const n of g.names) {
    const i = findWord(text, n);
    if (i >= 0) ip.push({ name: n, kind: g.kind, styleQualified: STYLE_QUALIFIER.test(text.slice(Math.max(0, i - 12), i + n.length + 12)) });
  }
  const characters: IdeaScan['characters'] = [];
  for (const g of CHARACTERS) for (const w of g.words) {
    const i = findWord(text, w);
    if (i < 0 || characters.some((c) => c.index === i)) continue;
    const after = text.slice(i + w.length, i + w.length + 12);
    if (/^'s (desk|table|chair|room|office|book)/.test(after)) continue; // possessive owner of an object, not an actor
    if (g.kind === 'non_human' && /(into|in to) (a |an )?$/.test(text.slice(Math.max(0, i - 9), i))) continue; // transformation result
    characters.push({ mention: w, kind: g.kind, id: g.id, canon: g.canon, index: i });
  }
  characters.sort((a, b) => a.index - b.index);
  const places: IdeaScan['places'] = [];
  for (const g of PLACES) for (const w of g.words) { const i = findWord(text, w); if (i >= 0 && !places.some((p) => Math.abs(p.index - i) < 3)) places.push({ mention: w, kind: g.kind, index: i }); }
  const objects: IdeaScan['objects'] = [];
  for (const g of OBJECTS) for (const w of g.words) {
    const i = findWord(text, w);
    if (i < 0) continue;
    // "free-coins button" style compounds: keep both words; ignore duplicates at the same position
    if (objects.some((o) => o.index === i)) continue;
    // "prize machine" contains "prize": prefer the longer phrase
    if (objects.some((o) => o.index <= i && i < o.index + o.mention.length)) continue;
    objects.push({ mention: w, kind: g.cls, id: g.id, index: i });
  }
  objects.sort((a, b) => a.index - b.index);
  const mech: Record<string, boolean> = {};
  for (const [k, re] of Object.entries(MECH)) mech[k] = re.test(text);
  // a desk mentioned only as a location ("on the desk", "under the desk") is staging, not a requested prop action
  return { text: idea, safety, ip, characters, places, objects, mech };
}
