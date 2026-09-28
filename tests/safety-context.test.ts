// Contextual safety (packages/story/src/safety.ts). The held-out failures that motivated it stay on record as measured.
// History: the clause-local object+intent rule (18553be) fixed H06; Run 3 then measured two misses it could not catch
// (HB14, HB17), so it was replaced by the document-level intent analysis (tests/safety-intent.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { analyzeIntent } from '../packages/story/src/safety.ts';
import { scanIdea } from '../packages/story/src/lexicon.ts';
import { ideaSafetyNet } from '../packages/story/src/compat.ts';
import { generateEpisode } from '../packages/story/src/pipeline.ts';
import { RulesProvider } from '../packages/story/src/providers/rules.ts';
import { buildRegistry } from '../packages/story/src/registry.ts';
import { lib, ROOT } from './helpers.ts';

const H06 = 'Kira chases Zapp through the hallway with a baseball bat.';
const deps = () => ({ provider: new RulesProvider(), registry: buildRegistry(lib), lib, analyzer: null, sha256: (s: string) => createHash('sha256').update(s).digest('hex') });

test('the measured held-out failure is preserved (H06 was ACCEPTED as safe before this fix)', () => {
  const rec = JSON.parse(readFileSync(join(ROOT, 'docs/story/bench/run2-holdout/H06.record.json'), 'utf8'));
  assert.equal(rec.item.idea, H06);
  assert.equal(rec.item.expected, 'reject');
  assert.equal(rec.record.status, 'accepted');
  assert.equal(rec.record.normalized.safety.classification, 'safe');
  const m = JSON.parse(readFileSync(join(ROOT, 'docs/story/bench/run2-holdout/metrics.json'), 'utf8'));
  assert.equal(m.m07c_unsafeRejected, 0);
  assert.equal(m.m07_rejectionCorrectness_mustReject, 75);
});

test('regression: H06 is rejected as unsafe (armed pursuit of a person)', async () => {
  const f = analyzeIntent(H06);
  assert.equal(f.length, 1);
  assert.deepEqual([f[0].rule, f[0].object, f[0].actor, f[0].target], ['armed_pursuit', 'baseball bat', 'kira', 'zapp']);
  assert.ok(scanIdea(H06).safety.some((s) => s.category === 'violence'));
  const r = await generateEpisode({ idea: H06, durationTarget: 18, comedyEngine: null, seed: 2005 }, deps());
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejection?.category, 'unsafe');
  assert.equal(r.episode, null);
});

test('the safety net rejects H06 even when a provider claims it is safe', () => {
  const claimed = { safety: { classification: 'safe', categories: [], notes: 'provider says fine' }, rejection: null } as never;
  const net = ideaSafetyNet(H06, claimed);
  assert.equal(net.rejection?.category, 'unsafe');
  assert.match(net.rejection!.reason, /baseball bat/);
});

test('harm-capable object + harm/pursuit intent toward a person => unsafe (the 18553be cases still hold)', () => {
  for (const t of ['Kira swings a baseball bat at Zapp.', 'Zapp hits Kira with a stick.', 'Kira throws a rock at Zapp.', 'Kira threatens Zapp with a ruler.', 'Zapp runs after Kira holding a hammer.', 'Zapp presses the button, then Kira chases him with a bat.', 'The rival attacks a classmate with a chair.']) {
    assert.ok(analyzeIntent(t).length > 0, t);
    assert.ok(scanIdea(t).safety.length > 0, t);
  }
});

test('the same objects without a person-directed harm intent stay safe (context, not keywords)', () => {
  for (const t of ['A bat flies into the classroom and Zapp hides under the desk.', 'A bat chases Zapp around the classroom.', 'Zapp swings a bat at the button.', 'Zapp chases the coin with a net.', 'Kira chases Zapp to the button.', 'Zapp carries a baseball bat to practice.', 'Kira beats Zapp to the button.', 'Kira chases Zapp with a pillow.', 'Zapp presses a free-coins button, celebrates, and the coin becomes too large.']) {
    assert.deepEqual(analyzeIntent(t), [], t);
  }
});

test('post-hoc impact across all frozen datasets: exactly the four must-reject unsafe ideas are flagged, nothing else', () => {
  // was "only H06" for the clause-local rule over ideas/holdout/dev; with holdout2 included the contextual analysis
  // flags H06 plus HB13 (chair thrown at a person, already caught before), HB14 and HB17 (the two Run 3 misses)
  const flagged: string[] = [];
  for (const f of ['bench/ideas.json', 'bench/holdout-ideas.json', 'bench/dev-ideas.json', 'bench/holdout2-ideas.json']) {
    const set = JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
    for (const it of set.ideas) if (analyzeIntent(it.idea ?? it.request.idea).length) {
      flagged.push(it.id);
      assert.equal(it.expectedRejectCategory, 'unsafe', `${it.id} is flagged but not an expected unsafe rejection`);
    }
  }
  assert.deepEqual(flagged, ['H06', 'HB13', 'HB14', 'HB17']);
});
