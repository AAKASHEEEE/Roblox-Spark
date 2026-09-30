// Narrated Continuity Checkpoint 2 — integration of motion (WorldState adapter), camera safety and caption placement.
// Analysis only: the approved v0.1 fixture is posed headlessly (no GPU, no browser, no FFmpeg, no MP4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const { lib, ROOT } = await import('./helpers.ts');
const { prepareIntegration, draftEpisodeFor } = await import('../apps/studio/narrated-draft.ts');
const I = await import('../apps/render-worker/narrated-integration.ts');
const { evaluateCameraCandidate } = await import('../packages/engine/src/camera-safety.ts');
const { captionBlockTop, CAPTION_DEFAULT_STYLE } = await import('../packages/engine/src/capture.ts');
const { sampleWorld } = await import('../packages/narrated/src/world.ts');
const { validateEpisode } = await import('../packages/pipeline/src/validate.ts');
const { headlessEngine } = await import('../packages/engine/src/headless.ts');

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const TEXT = readFileSync(join(ROOT, 'tests/fixtures/narrated/approved-narrated-v0.1.json'), 'utf8');
const SB = JSON.parse(TEXT);
const RUN = prepareIntegration(SB, sha(TEXT), lib as never);
const A = RUN.analysis, T = RUN.integrated, plan = RUN.plan;
const gate = (id: string) => A.gates.find((g) => g.id === id)!;
const W = 540, H = 960;

/** a fresh adapter-posed scene for spot checks */
function posedAt(t: number) {
  const { prod } = headlessEngine(RUN.episode, lib as never, W, H);
  const ns = new I.NarratedScene(prod, plan);
  const { world, diag } = ns.pose(t, null);
  return { prod, ns, world, diag, geo: I.extractFrameGeo(ns, Math.round(t * 30), world, diag) };
}
const spec = (over: Partial<import('../apps/render-worker/narrated-integration.ts').ShotSpec> = {}) => ({ intent: 'medium' as const, active: 'zapp', subjects: ['zapp', 'kira'], optional: ['kira'], heroProps: [], reason: 'test', requiresHeroProp: false, ...over });
const git = (args: string[]) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };

test('1. the narrated path is driven by the WorldState adapter on every frame', () => {
  assert.equal(A.world.framesApplied, plan.frames);
  assert.ok(A.world.maxRootDeviationM <= 1e-5);
  const p = posedAt(47.0), w = sampleWorld(plan, 47.0);
  for (const id of ['zapp', 'kira']) assert.ok(Math.hypot(p.prod.rigs.get(id)!.root.pos[0] - w.actors[id].pos[0], p.prod.rigs.get(id)!.root.pos[2] - w.actors[id].pos[2]) < 1e-6, `${id} root = world`);
  const entry = readFileSync(join(ROOT, 'apps/studio/src/render-entry.ts'), 'utf8');
  assert.match(entry, /narrated\.scene\.pose\(t/);
  assert.match(entry, /encodeRange: .*drawAt\(i \/ fps\)/);
});

test('2. the Visual Comedy path is unchanged (engine runtime untouched, narrated-only branch)', () => {
  const entry = readFileSync(join(ROOT, 'apps/studio/src/render-entry.ts'), 'utf8');
  assert.match(entry, /if \(!narrated\) \{ prod!\.render\(renderer!, t\); return; \}/);
  for (const f of ['packages/engine/src/production.ts', 'packages/engine/src/camera.ts', 'packages/engine/src/animation/animator.ts', 'packages/engine/src/animation/actions.ts', 'packages/engine/src/props.ts', 'packages/engine/src/build.ts']) {
    const base = git(['show', `4905755:${f}`]);
    if (base === null) continue; // shallow checkout without the base commit
    assert.equal(readFileSync(join(ROOT, f), 'utf8'), base, `${f} changed`);
  }
});

test('3. cameras read the posed scene, not the stale ActorTrack geometry', () => {
  const p = posedAt(52.0); // Zapp stands at zapp_impact (WorldState); the draft episode ActorTrack keeps him at his desk
  const stale = p.prod.tracks.get('zapp')!.rootAt(52.0).pos, posed = p.geo.actors.zapp.root, mark = plan.assets.marks.zapp_impact.pos;
  assert.ok(Math.hypot(posed[0] - mark[0], posed[2] - mark[2]) < 0.02);
  assert.ok(Math.hypot(stale[0] - posed[0], stale[2] - posed[2]) > 1.0, 'the stale track is elsewhere');
  const head = p.geo.obstacles.find((o) => o.entityId === 'zapp' && o.type === 'head')!;
  assert.ok(head.bounds.min[0] < posed[0] + 0.1 && head.bounds.max[0] > posed[0] - 0.1, 'head obstacle follows the posed root');
});

test('4. shot boundaries never reset actor or prop state', () => {
  assert.equal(gate('W03').pass, true, gate('W03').detail);
  assert.ok(A.world.shotResetDeviations.length >= 30);
  assert.ok(A.world.shotResetDeviations.every((r) => r.maxRootDevM === 0 && r.maxPropDevM === 0));
});

test('5. an unsafe camera candidate (lens inside a head) is rejected', () => {
  const p = posedAt(16.0), sc = I.cameraScene(p.geo, spec({ active: 'kira', subjects: ['kira', 'zapp'], optional: ['zapp'] }), W, H, undefined);
  const zh = p.geo.actors.zapp.head, inside: [number, number, number] = [(zh.min[0] + zh.max[0]) / 2, (zh.min[1] + zh.max[1]) / 2, (zh.min[2] + zh.max[2]) / 2];
  const r = evaluateCameraCandidate(sc, { id: 'bad', intent: 'medium', transform: { position: inside }, target: p.geo.actors.kira.face.center, fov: 38, activeSubjectId: 'kira' });
  assert.equal(r.accepted, false);
  assert.ok(r.rejectionReasons.some((x) => /LENS_COLLISION|LENS_TOO_CLOSE/.test(x)), r.rejectionReasons.join('; '));
});

test('6. a tiny two-character medium (heads ~8-10% of frame) is rejected', () => {
  const p = posedAt(2.0), s = spec({ subjects: ['zapp', 'kira'], optional: [] });
  const sc = I.cameraScene(p.geo, s, W, H, undefined);
  const a = p.geo.actors.zapp.face.center, b = p.geo.actors.kira.face.center, m: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 0.3, (a[2] + b[2]) / 2];
  const r = evaluateCameraCandidate(sc, { id: 'tiny', intent: 'medium', transform: { position: [m[0], m[1] + 0.2, m[2] + 11] }, target: m, fov: 38, activeSubjectId: 'zapp', framedSubjectIds: ['zapp', 'kira'] });
  assert.equal(r.accepted, false);
  assert.ok(r.rejectionReasons.some((x) => x.startsWith('SUBJECT_TOO_SMALL_FOR_INTENT')), r.rejectionReasons.join('; '));
  assert.ok(Math.min(...Object.values(r.diagnostics.headScreenHeight)) < 0.14, 'below the 14% two-shot minimum');
});

test('7. a required two-person beat receives safe sequential coverage or blocks (never a silent drop)', () => {
  const warn = SB.script.phrases.find((p: any) => p.semanticAction === 'head_shake');
  const beatShots = T.shots.filter((s) => s.phraseId === warn.id);
  assert.ok(beatShots.length > 0);
  for (const q of T.sequentialCoverage) {
    assert.ok(q.outcome === 'sequential coverage accepted' || q.outcome.startsWith('blocked'), q.outcome);
    if (q.split) {
      const [a, b] = q.split.map((id) => T.shots.find((s) => s.id === id)!);
      const src = RUN.tl.shots.find((s) => s.id === q.sourceShot)!;
      assert.equal(a.start, src.start); assert.equal(b.end, src.end); assert.equal(a.end, b.start);
      assert.notEqual(a.spec.active, b.spec.active, 'speaker then listener');
    }
    if (q.outcome.startsWith('blocked')) assert.equal(gate('C09').pass, false);
  }
  for (const s of beatShots) assert.ok(s.coverage !== 'single' || s.spec.optional.length === 0 || s.spec.subjects.length === 1 || s.spec.active === warn.actor);
});

test('8. an optional supporting actor may be dropped from single-character coverage', () => {
  const s = spec({ intent: 'reaction' }), p = posedAt(7.0);
  const sc = I.cameraScene(p.geo, s, W, H, undefined);
  assert.deepEqual(sc.subjectIds, ['zapp']);
  assert.ok(sc.obstacles.some((o) => o.entityId === 'kira'), 'the dropped actor still occludes / collides');
  const dropped = T.shots.filter((x) => x.camera && x.spec.optional.includes('kira') && x.spec.intent !== 'wide');
  assert.ok(dropped.length > 0);
});

test('9. dynamic caption placement receives real projected bounds', () => {
  const shot = T.shots.find((s) => s.camera && s.spec.intent === 'medium')!;
  const t = (shot.start + shot.end) / 2, p = posedAt(t);
  const cand = { id: shot.camera!.id, intent: shot.camera!.intent, transform: { position: shot.camera!.position }, target: shot.camera!.target, fov: shot.camera!.fovDeg };
  const occ = I.occupiedRegions(p.geo, shot.spec, cand, W, H);
  const face = occ.find((o) => o.type === 'primary_face' && o.entityId === shot.spec.active)!;
  assert.ok(face && face.rect.w > 5 && face.rect.h > 5);
  assert.ok(face.rect.x + face.rect.w > 0 && face.rect.x < W && face.rect.y + face.rect.h > 0 && face.rect.y < H, 'the face projects into the frame');
  assert.ok(occ.some((o) => o.type === 'body'));
  const pl = T.captionPlacements.find((q) => q.chunkId === shot.chunkId)!;
  assert.ok((pl.overlap.frames_sampled ?? 0) > 3 && (pl.overlap.entities ?? 0) >= 2);
});

const fakePlacement = (bad: boolean) => ({ band: 'lower' as const, rect: { x: 0, y: 0, w: 1, h: 1 }, centerY: 0.72, score: bad ? 10000 : 0, overlapMetrics: {}, warnings: bad ? ['CAPTION_PLACEMENT_CONFLICT'] : [], stableForWholeChunk: true, chunkStart: 0, chunkEnd: 1, violations: bad ? ['PRIMARY_FACE' as const] : [], candidates: [] });
test('10. a caption conflict triggers camera reselection', () => {
  const r = I.coordinateChunk([['a1', 'a2'], ['b1', 'b2']], (c) => fakePlacement(c[1] === 'b1'));
  assert.deepEqual(r.chosen, ['a1', 'b2']);
  assert.equal(r.retries, 1);
  assert.equal(r.blocked, null);
});

test('11. an unresolved caption conflict blocks with CAPTION_CAMERA_COMPOSITION_BLOCKED', () => {
  const r = I.coordinateChunk([['a1', 'a2'], ['b1']], () => fakePlacement(true));
  assert.equal(r.chosen, null);
  assert.equal(r.blocked, 'CAPTION_CAMERA_COMPOSITION_BLOCKED');
  assert.equal(r.retries, 2);
  for (const q of T.captionPlacements) if (q.blocked === 'CAPTION_CAMERA_COMPOSITION_BLOCKED') assert.equal(gate('K08').pass, false);
});

test('12. head / face occlusion by another actor blocks the camera', () => {
  const p = posedAt(16.0), s = spec({ active: 'kira', subjects: ['kira', 'zapp'], optional: ['zapp'] });
  const sc = I.cameraScene(p.geo, s, W, H, undefined);
  const k = p.geo.actors.kira.face.center, z = p.geo.actors.zapp.face.center;
  const dir = [z[0] - k[0], 0, z[2] - k[2]], l = Math.hypot(dir[0], dir[2]);
  const behindZapp: [number, number, number] = [z[0] + (dir[0] / l) * 2.2, k[1], z[2] + (dir[2] / l) * 2.2];
  const r = evaluateCameraCandidate(sc, { id: 'occluded', intent: 'medium', transform: { position: behindZapp }, target: k, fov: 38, activeSubjectId: 'kira' });
  assert.equal(r.accepted, false);
  assert.ok(r.rejectionReasons.some((x) => /FACE_VISIBILITY_LOW|ACTIVE_SUBJECT_HIDDEN|FOREGROUND/.test(x)), r.rejectionReasons.join('; '));
  assert.ok((r.diagnostics.faceOccluders.kira ?? []).some((o) => o.endsWith(':zapp')));
});

test('13. the actual posed Zapp/coin clearance is checked against the 0.02 m blocking minimum', () => {
  const c = A.world.coinZappClearance;
  assert.equal(c.thresholdM, 0.02);
  assert.ok(c.minM !== null);
  assert.equal(gate('W12').pass, c.minM! >= 0.02);
  assert.equal(c.headInsideCoin, false);
  assert.ok(c.minM! >= 0.02, `posed clearance ${c.minM} m at t=${c.t} (frame ${c.frame})`);
});

test('14. Kira\'s move to safety is real and covered by a Kira wide', () => {
  assert.equal(gate('W04').pass, true, gate('W04').detail);
  assert.ok(A.world.kira.displacementDeskToSafeM >= 1.0);
  const safeAt = A.world.kira.safeAt!;
  assert.ok(T.shots.some((s) => s.spec.active === 'kira' && s.spec.intent === 'wide' && s.start < safeAt && s.end > safeAt - 2.2));
  assert.equal(gate('W13').pass, true, gate('W13').detail);
});

test('15. the coin/Zapp contact happens once and the fall starts on it', () => {
  assert.equal(A.world.contact.count, 1);
  assert.deepEqual(A.world.contact.fallStart, A.world.contact.times);
  assert.ok(Math.abs(A.world.contact.times[0] - A.world.contact.planned!) <= 1 / 30 + 1e-6);
  assert.equal(gate('W10').pass, true);
});

test('16. Zapp stays prone to the end; the button reset does not stand him up', () => {
  assert.equal(A.world.zapp.finalPosture, 'prone');
  assert.equal(A.world.zapp.nonProneAfter, 0);
  assert.equal(gate('W15').pass, true);
  assert.equal(A.world.coinFinal!.phase, 'resting');
  assert.ok(A.world.coinFinal!.thicknessM! > 0.3, 'the resting coin keeps its thickness');
});

test('17. typed caption placement reaches capture', () => {
  const placed = T.captions.filter((c) => c.placement);
  assert.ok(placed.length > 0);
  const c = placed[0], block = 80;
  assert.equal(captionBlockTop(H, block, CAPTION_DEFAULT_STYLE, c.placement), Math.min(H * c.placement!.centerY - block / 2, H * (1 - CAPTION_DEFAULT_STYLE.bottomSafe) - block));
  const rw = readFileSync(join(ROOT, 'apps/render-worker/render.ts'), 'utf8'), entry = readFileSync(join(ROOT, 'apps/studio/src/render-entry.ts'), 'utf8');
  assert.match(rw, /placement\?: \{ centerY: number \}/);
  assert.match(entry, /placement\?: \{ centerY: number \} \| null/);
  // text, line breaks, emphasis and timing are never modified
  assert.equal(gate('K09').pass, true);
});

test('18. the same approved input produces a byte-identical integrated timeline', () => {
  const again = prepareIntegration(SB, sha(TEXT), lib as never);
  assert.equal(JSON.stringify(again.integrated), JSON.stringify(T));
  assert.equal(JSON.stringify(again.analysis.gates), JSON.stringify(A.gates));
});

test('19. no teacher character is instantiated anywhere', () => {
  assert.equal(gate('S08').pass, true);
  assert.ok(!JSON.stringify(T.shots.map((s) => [s.spec.subjects, s.spec.active])).includes('teacher'));
  const p = posedAt(60.0);
  // only set dressing (the classroom's teacher_desk collider) carries the word; no actor/body/head obstacle does
  assert.ok(p.geo.obstacles.filter((o) => o.type !== 'environment').every((o) => !o.entityId.includes('teacher')));
  assert.deepEqual([...p.prod.rigs.keys()].sort(), ['kira', 'zapp']);
});

test('20. Visual Comedy deterministic fixtures evaluate identically (no narrated code path involved)', () => {
  const ep = JSON.parse(readFileSync(join(ROOT, 'episodes/free-coins-loop-001.json'), 'utf8'));
  const v = validateEpisode(ep, lib as never, { repair: true });
  assert.ok(v.ok && v.episode);
  const run = () => { const { prod } = headlessEngine(v.episode!, lib as never, W, H); return [0, 3.1, 7.7, 12.4].map((t) => { const f = prod.evaluate(t); return [f.shot.id, ...f.cam.pos.map((x) => x.toFixed(6)), ...[...prod.rigs.values()].map((r) => r.root.pos.map((x) => x.toFixed(6)).join(','))].join('|'); }).join('\n'); };
  assert.equal(run(), run());
  // the narrated integration module is not imported by the Visual Comedy runtime
  assert.doesNotMatch(readFileSync(join(ROOT, 'packages/engine/src/production.ts'), 'utf8'), /narrated/);
  assert.ok(draftEpisodeFor); // narrated-only helper lives in the narrated draft module
});
