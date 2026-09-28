// Frozen benchmark evidence must never change: every file listed in a FROZEN manifest must still hash to the recorded
// value, and the Run 3 failures must still be present (not overwritten, relabelled or excluded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from './helpers.ts';

const sha = (p: string) => createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex');
const manifests = () => readdirSync(join(ROOT, 'docs/story/bench')).filter((f) => /-FROZEN\.sha256\.json$/.test(f));

test('every frozen benchmark file is byte-identical to its manifest hash', () => {
  const ms = manifests();
  assert.ok(ms.includes('run3-FROZEN.sha256.json'));
  assert.ok(ms.includes('run4-FROZEN.sha256.json'));
  for (const m of ms) {
    const man = JSON.parse(readFileSync(join(ROOT, 'docs/story/bench', m), 'utf8'));
    assert.ok(Object.keys(man.files).length > 0, m);
    for (const [p, h] of Object.entries(man.files as Record<string, string>)) {
      assert.ok(existsSync(join(ROOT, p)), `${m}: ${p} missing`);
      assert.equal(sha(p), h, `${m}: ${p} was modified`);
    }
  }
});

test('Run 3 failures are still recorded as measured', () => {
  const rec = (d: string, id: string) => JSON.parse(readFileSync(join(ROOT, 'docs/story/bench', d, 'records', `${id}.json`), 'utf8')).record;
  for (const id of ['A04', 'A05', 'A14', 'B03', 'B11', 'C05', 'C11', 'D02', 'D09']) assert.equal(rec('run3-rules-posthoc', id).status, 'failed', id);
  for (const id of ['HB02', 'HB03', 'HB10', 'HB11', 'HB12']) assert.equal(rec('run3-holdout2', id).status, 'failed', id);
  assert.equal(rec('run3-holdout2', 'HB17').status, 'accepted', 'HB17 false accept must stay recorded');
  assert.equal(rec('run3-holdout2', 'HB14').rejection.category, 'unavailable', 'HB14 was rejected for the wrong reason');
  const m = JSON.parse(readFileSync(join(ROOT, 'docs/story/bench/run3-holdout2/metrics.json'), 'utf8'));
  assert.equal(m.m05_acceptanceAfterRepair_compatible, 58.3);
  assert.equal(m.m07c_unsafeRejected, 66.7);
});

test('Run 4 results are still recorded as measured (ran once; must not be rerun as a held-out measurement)', () => {
  const rec = (d: string, id: string) => JSON.parse(readFileSync(join(ROOT, 'docs/story/bench/run4', d, 'records', `${id}.json`), 'utf8')).record;
  for (const d of ['holdout3', 'holdout3-legacy']) {
    for (const id of ['HC42', 'HC44', 'HC47', 'HC50', 'HC51', 'HC55']) assert.equal(rec(d, id).status, 'accepted', `${d} ${id}: false accept stays recorded`);
    assert.equal(rec(d, 'HC45').rejection.category, 'unavailable', `${d} HC45: rejected for the wrong reason`);
  }
  const m = JSON.parse(readFileSync(join(ROOT, 'docs/story/bench/run4/holdout3/metrics.json'), 'utf8'));
  assert.equal(m.m07c_unsafeRejected, 54.5);
  assert.equal(m.m07_rejectionCorrectness_mustReject, 66.7);
  assert.equal(m.m05_acceptanceAfterRepair_compatible, 100);
  const diag = JSON.parse(readFileSync(join(ROOT, 'docs/story/bench/run4/renders-diag/summary.json'), 'utf8'));
  assert.deepEqual(diag.results.filter((r: { failed: string[] }) => r.failed.length).map((r: { id: string; failed: string[] }) => `${r.id}:${r.failed.join(',')}`), ['HC38:G13']);
});
