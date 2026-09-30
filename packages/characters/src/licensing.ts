// IP / licensing gate. References may INSPIRE original modular choices; they never authorize copying another
// creator's avatar, a platform's proprietary asset, or a protected third-party character.
import { err, warn, type CharacterProfile, type Finding, type ProvenanceInfo } from './schema.ts';

/** provenance values allowed for a locked production profile or any of its references */
export const PRODUCTION_PROVENANCE = ['original', 'commissioned', 'owned', 'licensed', 'public_domain'] as const;

/**
 * Well-known protected characters / proprietary avatar identities. Matching is on normalized words, so this is a
 * conservative tripwire, not a legal determination — a human reviewer still approves every profile.
 */
export const PROTECTED_NAMES = [
  'mario', 'luigi', 'sonic the hedgehog', 'pikachu', 'mickey mouse', 'spongebob', 'spider man', 'spiderman', 'batman',
  'superman', 'elsa', 'shrek', 'master chief', 'steve from minecraft', 'minecraft steve', 'fortnite', 'peely', 'jonesy',
  'among us', 'huggy wuggy', 'skibidi', 'roblox noob', 'bacon hair', 'builderman', 'guest 666', 'doge', 'hello kitty',
  'kirby', 'link from zelda', 'goku', 'naruto', 'pac man', 'optimus prime', 'bluey', 'peppa pig',
];
/** intent to reproduce rather than be inspired by */
const COPY_INTENT = /\b(exact(ly)?|copy|copied|clone|replica|identical|same as|duplicate|rip(ped)?|trace[ds]?|1:1|recreate|lookalike|look alike|avatar of|skin of)\b/;

const norm = (s: string) => ' ' + s.toLowerCase().replace(/[^a-z0-9:]+/g, ' ').trim() + ' ';

/** every free-text field a user controls */
function textFields(p: CharacterProfile): [string, string][] {
  const t: [string, string][] = [['$.displayName', p.displayName], ['$.characterId', p.characterId.replace(/[_-]/g, ' ')], ['$.role.personality', p.role.personality], ['$.license.notes', p.license.notes ?? '']];
  (p.identityRules ?? []).forEach((r, i) => t.push([`$.identityRules[${i}]`, r]));
  if (p.voice?.notes) t.push(['$.voice.notes', p.voice.notes]);
  p.references.forEach((r, i) => {
    t.push([`$.references[${i}].displayFilename`, r.displayFilename.replace(/\.[a-z0-9]+$/i, '')]);
    t.push([`$.references[${i}].userAttestation.statement`, r.userAttestation.statement]);
    if (r.details) t.push([`$.references[${i}].details`, r.details]);
    if (r.provenance.notes) t.push([`$.references[${i}].provenance.notes`, r.provenance.notes]);
  });
  return t;
}

export function checkProtectedCopy(p: CharacterProfile): Finding[] {
  const out: Finding[] = [];
  const nameHit = PROTECTED_NAMES.find((n) => norm(p.displayName) === norm(n) || norm(p.characterId.replace(/[_-]/g, ' ')) === norm(n));
  if (nameHit) out.push(err('PROTECTED_CHARACTER_REQUEST', '$.displayName', `"${p.displayName}" names a protected third-party character; create an original character instead`));
  for (const [path, s] of textFields(p)) {
    const n = norm(s);
    const hit = PROTECTED_NAMES.find((x) => n.includes(norm(x)));
    if (!hit) continue;
    if (COPY_INTENT.test(n)) out.push(err('PROTECTED_CHARACTER_REQUEST', path, `requests a copy of protected character "${hit}"; references may inspire original choices only`));
    else if (!nameHit) out.push(warn('PROTECTED_NAME_MENTIONED', path, `mentions "${hit}"; the profile must stay clearly original`));
  }
  return out;
}

function provenanceGate(pv: ProvenanceInfo, path: string, subject: string): Finding[] {
  const out: Finding[] = [];
  if (pv.source === 'unknown') out.push(err('LICENSE_PROVENANCE_UNKNOWN', `${path}.source`, `${subject} has unknown provenance; locked production use is blocked`));
  if (pv.source === 'prohibited') out.push(err('LICENSE_PROHIBITED', `${path}.source`, `${subject} is marked prohibited`));
  if (pv.attributionRequired && !pv.attributionText) out.push(err('LICENSE_ATTRIBUTION_MISSING', `${path}.attributionText`, `${subject} requires attribution text`));
  return out;
}

/** blocking checks for validation / approval / locking */
export function checkLicensing(p: CharacterProfile): Finding[] {
  const out: Finding[] = [...provenanceGate(p.license, '$.license', 'the character design')];
  if (p.license.source === 'licensed' && !p.license.licenseName) out.push(err('LICENSE_NAME_MISSING', '$.license.licenseName', 'licensed characters must name the license'));
  if (!p.license.allowsDerivative) out.push(err('LICENSE_DERIVATIVE_FORBIDDEN', '$.license.allowsDerivative', 'the character license must allow creating episode output from it'));
  if (!p.license.allowsOutput) out.push(err('LICENSE_OUTPUT_FORBIDDEN', '$.license.allowsOutput', 'the character license must allow appearing in final output'));
  p.references.forEach((r, i) => {
    const path = `$.references[${i}]`;
    out.push(...provenanceGate(r.provenance, `${path}.provenance`, `reference ${r.referenceId}`));
    // a reference whose license forbids derivatives cannot inform a character at all
    if (!r.provenance.allowsDerivative) out.push(err('LICENSE_DERIVATIVE_FORBIDDEN', `${path}.provenance.allowsDerivative`, `reference ${r.referenceId} forbids derivative use`));
  });
  out.push(...checkProtectedCopy(p));
  return out;
}
