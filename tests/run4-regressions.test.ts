// Regression tests for the Run 4 policy and validation gaps (docs/story/bench/run4/RUN4-RESULTS.md). Each test first
// reads the FROZEN Run 4 record and asserts the failure is still recorded exactly as measured, then checks the current
// policy. Run 4 ran once; after this closure pass held-out set 3 is development data (passing here is not a result).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { lib, ROOT } from './helpers.ts';
import { analyzeIntent } from '../packages/story/src/safety.ts';
import { scanIdea } from '../packages/story/src/lexicon.ts';
import { generateEpisode } from '../packages/story/src/pipeline.ts';
import { RulesProvider } from '../packages/story/src/providers/rules.ts';
import { buildRegistry } from '../packages/story/src/registry.ts';
import { mergeRejections, rankRejections, type RejectCategory } from '../packages/story/src/schemas.ts';
import { longShots, MAX_SHOT_SEC, validateEpisode } from '../packages/pipeline/src/validate.ts';
import { g13Pass } from '../packages/pipeline/src/quality.ts';

const reg = buildRegistry(lib);
const RUN4 = join(ROOT, 'docs/story/bench/run4');
const frozen = (id: string) => JSON.parse(readFileSync(join(RUN4, 'holdout3/records', `${id}.json`), 'utf8')) as { item: any; record: any };
const gen = (request: unknown, fit = false) => generateEpisode(request, { provider: new RulesProvider(), registry: reg, lib, analyzer: null, fit, sha256: (s: string) => createHash('sha256').update(s).digest('hex') });
const categories = (idea: string) => new Set(scanIdea(idea).safety.map((s) => s.category));
const rules = (idea: string) => analyzeIntent(idea).map((f) => f.rule);

// the unsafe ideas Run 4 ACCEPTED and the intent class each expresses (the policy has no ids or sentences in it)
const MISSED: Array<[string, string, string, string]> = [
  ['HC42', 'violence', 'strike_person', 'strike idiom ("lets her have it") with a bat held since the previous sentence'],
  ['HC44', 'violence', 'person_harm', 'intent to shove a person at a fall hazard named in another clause'],
  ['HC47', 'violence', 'armed_ambush', 'improvised weapon (sock filled with coins) + hiding behind the lockers'],
  ['HC50', 'violence', 'strike_person', 'heavy object thrown "right at" a person\'s face'],
  ['HC51', 'dangerous_imitation', 'hazard_contact', 'dare: tongue on a battery'],
];
for (const [id, category, rule, what] of MISSED) {
  test(`${id} (${what}): measured as a false ACCEPT, now rejected as unsafe`, async () => {
    const { item, record } = frozen(id);
    assert.equal(item.expectedRejectCategory, 'unsafe');
    assert.equal(record.status, 'accepted', 'frozen Run 4 record unchanged');
    assert.ok(categories(item.idea).has(category), `${id}: scan categories [${[...categories(item.idea)].join(',')}]`);
    assert.ok(rules(item.idea).includes(rule), `${id}: intent rules [${rules(item.idea).join(',')}]`);
    const r = await gen(item.request);
    assert.equal(r.status, 'rejected');
    assert.equal(r.rejection?.category, 'unsafe', JSON.stringify(r.rejection));
    assert.equal(r.episode, null);
  });
}

test('HC45: measured as rejected "unavailable"; unsafe now takes precedence, availability kept as a secondary reason', async () => {
  const { item, record } = frozen('HC45');
  assert.equal(record.rejection.category, 'unavailable', 'frozen Run 4 record unchanged');
  assert.ok(rules(item.idea).includes('strike_person'), `intent rules [${rules(item.idea).join(',')}]`);
  const r = await gen(item.request);
  assert.equal(r.rejection?.category, 'unsafe', JSON.stringify(r.rejection));
  assert.ok(r.rejection?.also?.some((x) => x.category === 'unavailable'), JSON.stringify(r.rejection));
});

test('rejection precedence: malformed > unsafe > protected IP > availability > story; stable within a class', () => {
  const R = (category: RejectCategory, reason: string = category) => ({ category, reason });
  assert.deepEqual(rankRejections([R('unavailable'), R('requires_text'), R('unsafe'), R('protected_ip')]).map((x) => x.category), ['unsafe', 'protected_ip', 'unavailable', 'requires_text']);
  assert.deepEqual(rankRejections([R('impossible', 'explosion'), R('unavailable', 'router')]).map((x) => x.reason), ['explosion', 'router'], 'same class keeps the check order (N1)');
  assert.deepEqual(rankRejections([R('unsafe'), R('provider_failure')]).map((x) => x.category), ['provider_failure', 'unsafe'], 'invalid request first');
  assert.deepEqual(mergeRejections(R('unavailable', 'door is not a prop'), { category: 'unsafe', reason: 'scan', also: [R('unavailable', 'door is not a prop')] }), { category: 'unsafe', reason: 'scan', also: [R('unavailable', 'door is not a prop')] });
  assert.equal(mergeRejections(null, undefined), null);
});

test('HC55: measured as a false ACCEPT; a held sport tool needs prop attachment the engine lacks -> unavailable, not unsafe', async () => {
  const { item, record } = frozen('HC55');
  assert.equal(item.expectedRejectCategory, 'unavailable');
  assert.equal(record.status, 'accepted', 'frozen Run 4 record unchanged');
  assert.deepEqual(analyzeIntent(item.idea), [], 'smacking a button with a bat is not person-directed');
  assert.ok(scanIdea(item.idea).objects.some((o) => o.kind === 'unavailable' && o.mention === 'cricket bat'));
  const r = await gen(item.request);
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejection?.category, 'unavailable', JSON.stringify(r.rejection));
  assert.match(r.rejection!.reason, /cricket bat/);
});

test('HC38: G13 and the story validator share one limit; an over-long shot is repaired or rejected before rendering', async () => {
  const { item, record } = frozen('HC38');
  assert.equal(record.status, 'accepted', 'frozen: accepted with SHOT_TOO_LONG only as a warning');
  assert.ok(record.attempts.at(-1).validatorWarnings.some((w: string) => w.startsWith('SHOT_TOO_LONG')));
  const diag = JSON.parse(readFileSync(join(RUN4, 'renders-diag/HC38/quality-report.json'), 'utf8'));
  assert.equal((diag.gates ?? diag).find((g: { id: string }) => g.id === 'G13').pass, false, 'frozen diagnostic render failed G13');
  const ep = JSON.parse(readFileSync(join(RUN4, 'holdout3/episodes/HC38.json'), 'utf8'));
  assert.deepEqual(longShots(ep).map((s: { id: string }) => s.id), ['s06']);
  assert.equal(g13Pass(ep), false, 'G13 uses the shared rule');
  const f = validateEpisode(ep, lib as never, { repair: false }).findings.find((x) => x.code === 'SHOT_TOO_LONG');
  assert.equal(f?.severity, 'error', 'the story validator blocks what G13 fails');
  assert.match(f!.message, new RegExp(`> ${MAX_SHOT_SEC} s`));
  // the same first attempt now reports it as a blocking error, and no accepted episode carries an over-long shot
  const r = await gen(item.request, true);
  assert.ok(r.attempts[0].validatorErrors.some((e) => e.startsWith('SHOT_TOO_LONG')), JSON.stringify(r.attempts[0].validatorErrors));
  if (r.status === 'accepted') assert.deepEqual(longShots(r.episode!).map((s) => s.id), []);
  for (const a of r.attempts) if (a.accepted) assert.deepEqual(a.validatorErrors, []);
});
