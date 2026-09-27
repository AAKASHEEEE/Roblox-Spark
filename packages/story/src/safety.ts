// Contextual object-plus-intent safety classification.
//
// An object is not unsafe by itself (a baseball bat, a hammer or a rock are ordinary things); an idea is unsafe when a
// harm-capable object is USED AS AN INSTRUMENT in the same clause as a harm or pursuit/menace intent directed at a
// PERSON. Explicit weapons stay unconditional (lexicon.ts). This module is deterministic and provider-independent: it
// runs inside scanIdea(), which feeds both the rules provider and the independent safety net applied to every provider.
//
// Post-hoc note: added after the held-out benchmark measured H06 ("Kira chases Zapp through the hallway with a baseball
// bat.") as a false ACCEPT. That measurement stays on record (docs/story/bench/README.md); this classifier's
// generalisation has not been measured on a fresh held-out set.

/** harm-capable everyday objects (instrument sense); multi-word phrases first */
export const HARM_CAPABLE_OBJECTS = [
  'baseball bat', 'cricket bat', 'golf club', 'hockey stick', 'frying pan', 'brass knuckles', 'metal pipe',
  'bat', 'club', 'stick', 'pole', 'pipe', 'crowbar', 'hammer', 'wrench', 'brick', 'rock', 'rocks', 'stone', 'stones', 'bottle',
  'chair', 'scissors', 'compass', 'pencil', 'rope', 'belt', 'whip', 'pan', 'shovel', 'ruler', 'broom', 'umbrella', 'plank',
  'screwdriver', 'saw', 'rake',
] as const;

const INSTRUMENT_LEAD = String.raw`(?:with|using|wielding|holding|holds|swinging|carrying|carries|brandishing|brandishes|armed with|grabs|grabbing)`;
const DETERMINERS = String.raw`(?:(?:a|an|the|his|her|their|some|two|big|huge|giant|wooden|metal|heavy|long|sharp|pointy|old|school|toy)\s+)*`;
const HARM_VERBS = String.raw`(?:hit|hits|hitting|strike|strikes|striking|smack|smacks|smacking|whack|whacks|whacking|bash|bashes|bashing|clobber|clobbers|attack|attacks|attacking|attacked|threaten|threatens|threatening|jab|jabs|poke|pokes|beat|beats|beating|bonk|bonks|swing(?:s|ing)?\s+(?:it\s+)?at|swings\s+\w+\s+at|throw(?:s|ing)?\s+\w+(?:\s+\w+)?\s+at|hurl(?:s|ing)?\s+\w+(?:\s+\w+)?\s+at|toss(?:es|ing)?\s+\w+(?:\s+\w+)?\s+at|hurt|hurts|injure|injures)`;
const PURSUIT_VERBS = String.raw`(?:chase|chases|chased|chasing|runs after|ran after|goes after|went after|hunts|hunting|corners|cornering|ambush|ambushes|stalks|stalking|charges at|lunges at)`;
/** people (cast, unbuilt cast, generic humans, pronouns) — the target of the intent */
const PERSON = String.raw`(?:zapp|kira|max|ms\.? byte|miss byte|teacher|principal|friend|classmate|rival|bestie|buddy|student|kid|kids|boy|girl|someone|somebody|everyone|everybody|him|her|them|people|noob|pro)`;

export interface ObjectIntentFinding {
  category: 'violence';
  rule: 'instrument_with_harm_intent' | 'instrument_with_pursuit' | 'thrown_or_swung_at_person';
  object: string;
  intent: string;
  target: string;
  clause: string;
  term: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OBJ = `(${HARM_CAPABLE_OBJECTS.map(esc).join('|')})`;

/** clauses: sentence punctuation and clause-level conjunctions */
export function clauses(text: string): string[] {
  return text.toLowerCase().replace(/[’]/g, "'").split(/[.!?;]+|,\s*(?:and|but|then|while|so)\b|\b(?:but|then|while|after that)\b/).map((c) => c.trim()).filter(Boolean);
}

export function classifyObjectIntent(text: string): ObjectIntentFinding[] {
  const out: ObjectIntentFinding[] = [];
  for (const c of clauses(text)) {
    const s = ` ${c} `;
    // 1. an object thrown or swung AT a person (the verb phrase itself carries the instrument)
    const thrown = new RegExp(String.raw`\b(swings?|swinging|throws?|throwing|hurls?|hurling|tosses|tossing|waves?|waving)\s+${DETERMINERS}${OBJ}\s+(?:at|toward|towards)\s+(?:the\s+)?${PERSON}\b`).exec(s);
    if (thrown) { const target = /(\w+)\s*$/.exec(thrown[0])![1]; out.push({ category: 'violence', rule: 'thrown_or_swung_at_person', object: thrown[2], intent: thrown[1], target, clause: c, term: `"${thrown[2]}" ${thrown[1]} at ${target}` }); continue; }
    // 2. the object held/used as an instrument, plus a harm or pursuit intent aimed at a person (object position)
    const inst = new RegExp(String.raw`\b${INSTRUMENT_LEAD}\s+${DETERMINERS}${OBJ}\b`).exec(s);
    if (!inst) continue;
    // harm verb followed (same clause, within 40 characters) by a person; pursuit verb whose object is a person
    const harm = new RegExp(String.raw`\b(${HARM_VERBS})\b[^,]{0,40}?\b${PERSON}\b`).exec(s);
    const pursuit = new RegExp(String.raw`\b(${PURSUIT_VERBS})\s+(?:after\s+)?(?:the\s+)?${PERSON}\b`).exec(s);
    const hit = harm ?? pursuit;
    if (!hit) continue;
    const target = new RegExp(String.raw`\b${PERSON}\b`).exec(hit[0].slice(hit[1].length))?.[0] ?? '?';
    out.push({ category: 'violence', rule: harm ? 'instrument_with_harm_intent' : 'instrument_with_pursuit', object: inst[1], intent: hit[1], target, clause: c, term: `"${inst[1]}" used as an instrument + "${hit[1]}" aimed at ${target}` });
  }
  return out;
}
