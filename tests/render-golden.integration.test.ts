// Golden-hash integration tests (browser): legacy episodes keep their previous pixels, corrected episodes reproduce
// deterministically, the same semantic episode renders differently under different DECLARED motion profiles, and the
// engine refuses missing/unsupported declarations. Uses the fast hash path (render + readPixels + SHA-256) on each
// golden's check subset; `node scripts/golden.ts check --all-frames` verifies every frame.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openRenderPage, hashEpisodeFrames, listGoldens, readFixture, goldenAppliesTo, compareToGolden, semanticSha, type GoldenFile } from '../scripts/golden.ts';
import { renderEpisode } from '../apps/render-worker/render.ts';
import { lib, ROOT } from './helpers.ts';

let page: any, close: () => Promise<void>;
const golden = (fixture: string, key: string): GoldenFile => {
  const g = listGoldens().find((x) => x.fixture === fixture && x.renderKey === key);
  assert.ok(g, `golden missing for ${fixture} ${key}`);
  return g!;
};
const LEGACY = 'episodes/free-coins-loop-001.json';
const CORRECTED = 'tests/fixtures/episodes/free-coins-loop-001.corrected-head-v2.json';
const GENERATED = 'tests/fixtures/episodes/gen-example-free-coins.json';
/** the same idea + seed through the re-tuned generator (profile-aware fit pass): a separate fixture, recorded separately */
const TUNED = 'tests/fixtures/episodes/gen-example-free-coins.tuned.json';
const rendered: Record<string, Array<[number, string]>> = {};

before(async () => { ({ page, close } = await openRenderPage()); });
after(async () => { await close(); });

test('legacy episode retains its previous hashes (1dc7a26 baseline, legacy-head-v1)', { timeout: 240000 }, async () => {
  const g = golden(LEGACY, '1.0.0__legacy-head-v1');
  const base = JSON.parse(readFileSync(join(ROOT, 'docs/poc/frame-hashes-baseline.json'), 'utf8'));
  assert.deepEqual(g.frameHashes, base.frameHashes, 'the legacy golden IS the pre-versioning baseline');
  const ep = readFixture(LEGACY);
  assert.equal(goldenAppliesTo(g, ep), null);
  rendered.legacy = await hashEpisodeFrames(page, ep, lib, g.checkFrames, g.resolution);
  const r = compareToGolden(g, rendered.legacy);
  assert.deepEqual(r.mismatched, [], `legacy frames changed: ${r.mismatched.join(',')}`);
  assert.equal(r.compared, g.checkFrames.length);
});

test('corrected episodes reproduce deterministically (stored golden + fresh re-render)', { timeout: 300000 }, async () => {
  for (const [fixture, key] of [[CORRECTED, '1.0.0__corrected-head-v2'], [GENERATED, '1.0.0__corrected-head-v2'], [TUNED, '1.0.0__corrected-head-v2']] as const) {
    const g = golden(fixture, key);
    const ep = readFixture(fixture);
    assert.equal(goldenAppliesTo(g, ep), null);
    const a = await hashEpisodeFrames(page, ep, lib, g.checkFrames, g.resolution);
    assert.deepEqual(compareToGolden(g, a).mismatched, [], `${fixture}: differs from golden recorded in another process`);
    const b = await hashEpisodeFrames(page, readFixture(fixture), lib, [...g.checkFrames].reverse(), g.resolution); // fresh load, reverse order
    assert.deepEqual(new Map(b), new Map(a), `${fixture}: re-render in reverse order differs`);
    if (fixture === CORRECTED) rendered.corrected = a;
  }
});

test('same semantic episode, different declared motion profiles => intentionally different pixels', { timeout: 60000 }, async () => {
  const lg = golden(LEGACY, '1.0.0__legacy-head-v1'), cg = golden(CORRECTED, '1.0.0__corrected-head-v2');
  const le = readFixture(LEGACY), ce = readFixture(CORRECTED);
  assert.equal(semanticSha(le), semanticSha(ce), 'story content must be identical');
  assert.notEqual(lg.episodeSha256, cg.episodeSha256, 'declarations differ');
  const L = new Map(rendered.legacy ?? lg.frameHashes), C = new Map(rendered.corrected ?? cg.frameHashes);
  const frames = [...L.keys()].filter((i) => C.has(i));
  const differ = frames.filter((i) => L.get(i) !== C.get(i)), same = frames.filter((i) => L.get(i) === C.get(i));
  assert.ok(differ.length > 0, 'profiles must change pixels where the corrected motion differs');
  assert.ok(same.length > 0, 'same renderer: frames without profile-dependent motion stay identical');
  // full goldens: the ending (no look-at, no locomotion onset) is identical, look-at windows are not
  const fl = new Map(lg.frameHashes), fc = new Map(cg.frameHashes);
  assert.equal(fl.get(500), fc.get(500));
  assert.notEqual(fl.get(60), fc.get(60)); // t=2.0 s: Zapp looks at the button, Kira arms-crossed look-at
});

test('engine refuses missing or unsupported declarations (no silent fallback)', { timeout: 60000 }, async () => {
  const load = (e: unknown) => page.evaluate(([x, l]: any) => { try { (window as any).__spark.load(x, l, 270, 480); return 'loaded'; } catch (err) { return String((err as Error).message); } }, [e, lib]);
  const missing = readFixture(LEGACY); delete missing.render;
  const noProfile = readFixture(LEGACY); delete noProfile.render.motionProfile;
  const badProfile = readFixture(LEGACY); badProfile.render.motionProfile = 'corrected-head-v3';
  const badRenderer = readFixture(LEGACY); badRenderer.render.rendererVersion = '2.0.0';
  assert.match(await load(missing), /^RENDER_VERSION_MISSING/);
  assert.match(await load(noProfile), /^MOTION_PROFILE_MISSING/);
  assert.match(await load(badProfile), /^UNSUPPORTED_MOTION_PROFILE/);
  assert.match(await load(badRenderer), /^UNSUPPORTED_RENDERER_VERSION/);
  // render worker: explicit validation failure, nothing rendered
  const r = await renderEpisode({ episode: 'episodes/free-coins-loop-001.json', episodeObject: badProfile, out: 'out/test-compat-refusal', scale: 0.25 });
  assert.equal(r.ok, false);
  assert.equal(r.mp4, undefined);
  const v = JSON.parse(readFileSync(join(ROOT, 'out/test-compat-refusal/validation.json'), 'utf8'));
  assert.deepEqual(v.findings.map((f: any) => f.code), ['UNSUPPORTED_MOTION_PROFILE']);
});
