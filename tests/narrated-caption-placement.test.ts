// Narrated Checkpoint 2: deterministic per-chunk caption placement. Pure geometry: no rendering, browser or FFmpeg.
// Fixtures are expressed in frame fractions (9:16) and scaled to 540x960 / 1080x1920.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeCaption, withCaptionPlacement, CAPTION_BOTTOM_EXCLUSION, DEFAULT_SAFE_AREA, type CaptionPlacementRequest, type OccupiedType, type CaptionPlacementResult } from '../packages/engine/src/caption-placement.ts';
import { captionBlockTop, captionFontPx, CAPTION_DEFAULT_STYLE, CAPTION_LINE_HEIGHT } from '../packages/engine/src/capture.ts';

type FR = [x0: number, y0: number, x1: number, y1: number]; // fractions of the frame
type Occ = { id: string; type: OccupiedType; r: FR; imp?: number };
const TWO = ['WAIT, IS THAT BUTTON', 'REALLY GIVING FREE COINS?'];
function req(occ: Occ[] | Occ[][], o: { W?: number; H?: number; lines?: string[]; start?: number; end?: number; safe?: Partial<CaptionPlacementRequest['safeArea']> } = {}): CaptionPlacementRequest {
  const W = o.W ?? 540, H = o.H ?? 960, start = o.start ?? 10, end = o.end ?? 12.5;
  const perFrame: Occ[][] = Array.isArray(occ[0]) ? (occ as Occ[][]) : [occ as Occ[]];
  const n = 6; // sampled frames across the chunk; list-of-lists fixtures are spread over them in order
  const frames = Array.from({ length: n }, (_, i) => {
    const set = perFrame[Math.min(perFrame.length - 1, Math.floor((i * perFrame.length) / n))];
    return { time: start + ((end - start) * i) / n, occupied: set.map((s) => ({ entityId: s.id, type: s.type, importance: s.imp ?? 1, rect: { x: s.r[0] * W, y: s.r[1] * H, w: (s.r[2] - s.r[0]) * W, h: (s.r[3] - s.r[1]) * H } })) };
  });
  return { frameWidth: W, frameHeight: H, lines: o.lines ?? TWO, chunkStart: start, chunkEnd: end, frames, safeArea: (o.safe as never) ?? { left: 0.05, right: 0.05, top: 0.08, bottom: 0.16 } };
}

// ── known video failures ─────────────────────────────────────────────────────────────────────────────────────────
const FX: Record<string, { occ: Occ[] | Occ[][]; expect: CaptionPlacementResult['band'] }> = {
  free_coins_button: { expect: 'upper', occ: [
    { id: 'kira', type: 'primary_face', r: [0.30, 0.30, 0.55, 0.42] }, { id: 'kira', type: 'body', r: [0.28, 0.42, 0.58, 0.84] },
    { id: 'suspicious_button', type: 'hero_prop', r: [0.32, 0.64, 0.68, 0.78] }, { id: 'kira_hand_button', type: 'interaction', r: [0.48, 0.66, 0.53, 0.69] }] },
  giant_coin_compete: { expect: 'upper', occ: [
    { id: 'spark_coin', type: 'hero_prop', r: [0.12, 0.40, 0.88, 0.80] }, { id: 'zapp', type: 'primary_face', r: [0.62, 0.30, 0.80, 0.39] },
    { id: 'zapp', type: 'body', r: [0.60, 0.39, 0.84, 0.84], imp: 0.8 }, { id: 'zapp_hand_coin', type: 'interaction', r: [0.58, 0.60, 0.62, 0.63] }] },
  zapp_closeup: { expect: 'upper', occ: [
    { id: 'zapp', type: 'primary_face', r: [0.12, 0.38, 0.88, 0.74] }, { id: 'zapp', type: 'body', r: [0.05, 0.74, 0.95, 1.0] }] },
  kira_closeup: { expect: 'lower', occ: [
    { id: 'kira', type: 'primary_face', r: [0.14, 0.12, 0.86, 0.46] }, { id: 'kira', type: 'body', r: [0.08, 0.46, 0.92, 1.0] }] },
  two_character_medium: { expect: 'upper', occ: [
    { id: 'kira', type: 'primary_face', r: [0.10, 0.60, 0.40, 0.74] }, { id: 'zapp', type: 'supporting_face', r: [0.58, 0.62, 0.88, 0.76] },
    { id: 'kira', type: 'body', r: [0.08, 0.74, 0.42, 1.0] }, { id: 'zapp', type: 'body', r: [0.56, 0.76, 0.90, 1.0], imp: 0.3 }] },
  empty_lower: { expect: 'lower', occ: [
    { id: 'kira', type: 'primary_face', r: [0.35, 0.24, 0.65, 0.38] }, { id: 'kira', type: 'body', r: [0.33, 0.38, 0.67, 0.60] }] },
  giant_coin_side: { expect: 'lower', occ: [
    { id: 'spark_coin', type: 'hero_prop', r: [0.50, 0.30, 1.0, 0.95] }, { id: 'kira', type: 'primary_face', r: [0.10, 0.18, 0.40, 0.30] },
    { id: 'kira', type: 'body', r: [0.08, 0.30, 0.42, 0.62] }] },
  zapp_prone_bottom: { expect: 'middle', occ: [
    { id: 'zapp', type: 'primary_face', r: [0.60, 0.66, 0.82, 0.77] }, { id: 'zapp', type: 'body', r: [0.10, 0.68, 0.62, 0.80] },
    { id: 'kira', type: 'supporting_face', r: [0.30, 0.18, 0.55, 0.30] }, { id: 'kira', type: 'body', r: [0.28, 0.30, 0.57, 0.66], imp: 0.3 }] },
  implied_seated_waist_up: { expect: 'lower', occ: [
    { id: 'kira', type: 'primary_face', r: [0.25, 0.16, 0.75, 0.40] }, { id: 'kira', type: 'body', r: [0.18, 0.40, 0.82, 0.84] },
    { id: 'student_desk', type: 'body', r: [0.0, 0.80, 1.0, 1.0], imp: 0.1 }] },
};
const CONFLICT: Occ[] = [{ id: 'zapp', type: 'primary_face', r: [0.0, 0.05, 1.0, 0.90] }];
const place = (k: string, o?: Parameters<typeof req>[1]) => placeCaption(req(FX[k].occ, o));

test('fixtures: every known video failure selects a sensible alternate band without hard violations', () => {
  for (const [k, f] of Object.entries(FX)) {
    const r = placeCaption(req(f.occ));
    assert.equal(r.band, f.expect, `${k}: ${JSON.stringify(r.candidates)}`);
    assert.deepEqual(r.violations, [], k); assert.ok(!r.warnings.includes('CAPTION_PLACEMENT_CONFLICT'), k);
  }
});
test('1. lower band selected when clear', () => { const r = place('empty_lower'); assert.equal(r.band, 'lower'); assert.equal(r.overlapMetrics.primary_face_max, 0); assert.equal(r.score, 0); });
test('2. lower face overlap moves caption to upper', () => {
  const r = place('zapp_closeup'); assert.equal(r.band, 'upper'); assert.equal(r.overlapMetrics.primary_face_max, 0);
  assert.ok(r.candidates.find((c) => c.band === 'lower')!.violations.includes('PRIMARY_FACE'));
});
test('3. upper face overlap keeps caption lower', () => {
  const r = place('kira_closeup'); assert.equal(r.band, 'lower'); assert.equal(r.overlapMetrics.primary_face_max, 0);
  assert.ok(r.candidates.find((c) => c.band === 'upper')!.violations.includes('PRIMARY_FACE'));
});
test('4. hero-prop overlap is avoided', () => {
  const r = placeCaption(req([{ id: 'spark_coin', type: 'hero_prop', r: [0.2, 0.62, 0.8, 0.80] }]));
  assert.equal(r.band, 'upper'); assert.equal(r.overlapMetrics.hero_prop_max, 0);
  assert.ok(place('free_coins_button').overlapMetrics.hero_prop_max === 0);
});
test('5. interaction-point overlap is strongly avoided (even at the cost of a supporting face)', () => {
  const r = placeCaption(req([{ id: 'hand_button', type: 'interaction', r: [0.49, 0.71, 0.51, 0.73] }, { id: 'zapp', type: 'supporting_face', r: [0.3, 0.18, 0.7, 0.27] }]));
  assert.notEqual(r.band, 'lower'); assert.equal(r.overlapMetrics.interaction_max, 0); assert.equal(r.overlapMetrics.interaction_clearance_hit, 0);
  // interaction just outside the lower rect but within clearance still counts
  const lower = placeCaption(req([])).rect, yNear = (lower.y + lower.h + 6) / 960;
  const n = placeCaption(req([{ id: 'hand', type: 'interaction', r: [0.5, yNear, 0.5, yNear] }]));
  assert.notEqual(n.band, 'lower');
});
test('6. primary face has higher priority than supporting body', () => {
  const r = placeCaption(req([{ id: 'kira', type: 'primary_face', r: [0.40, 0.62, 0.60, 0.70] }, { id: 'zapp', type: 'body', r: [0.0, 0.1, 1.0, 0.6], imp: 0.2 }]));
  assert.notEqual(r.band, 'lower'); assert.equal(r.overlapMetrics.primary_face_max, 0); assert.ok(r.overlapMetrics.body_background_max > 0);
});
test('7. two-character shot avoids both faces', () => {
  const r = place('two_character_medium'); assert.equal(r.overlapMetrics.faces_touched, 0); assert.equal(r.overlapMetrics.faces_present, 2);
  assert.ok(r.candidates.find((c) => c.band === 'lower')!.violations.includes('BOTH_FACES'));
});
test('8. giant coin shot selects a clear band', () => {
  const r = place('giant_coin_compete'); assert.equal(r.overlapMetrics.hero_prop_max, 0); assert.equal(r.overlapMetrics.primary_face_max, 0); assert.equal(r.overlapMetrics.interaction_max, 0);
  const s = place('giant_coin_side'); assert.deepEqual(s.violations, []); assert.equal(s.overlapMetrics.primary_face_max, 0); assert.ok(s.overlapMetrics.hero_prop_max < 0.5);
});
test('9. prone Zapp at bottom avoids lower band', () => { const r = place('zapp_prone_bottom'); assert.notEqual(r.band, 'lower'); assert.equal(r.overlapMetrics.primary_face_max, 0); });
test('10. implied_seated waist-up shot avoids face', () => { const r = place('implied_seated_waist_up'); assert.equal(r.overlapMetrics.primary_face_max, 0); assert.notEqual(r.band, 'upper'); });
test('11. caption placement is one union-based rectangle for the entire chunk', () => {
  // face in the lower band early in the chunk, in the upper band late: per-frame choice would flip; union must not
  // (first half: only Zapp's face low -> upper would be chosen; second half: Kira walks in high -> upper now covers her face)
  const zLow: Occ = { id: 'zapp', type: 'primary_face', r: [0.3, 0.66, 0.7, 0.78] }, kHigh: Occ = { id: 'kira', type: 'supporting_face', r: [0.3, 0.16, 0.7, 0.28] };
  const moving: Occ[][] = [[zLow], [zLow, kHigh]];
  const r = placeCaption(req(moving)); assert.equal(r.band, 'middle'); assert.equal(r.stableForWholeChunk, true); assert.equal(r.overlapMetrics.frames_sampled, 6);
  assert.equal(r.overlapMetrics.primary_face_max, 0); assert.equal(r.overlapMetrics.supporting_face_max, 0);
  assert.equal(placeCaption(req([moving[0]])).band, 'upper');
  // a single entity sweeping through the frame is unioned into one conservative bound (never a per-frame band flip)
  const sweep = placeCaption(req([[zLow], [{ ...zLow, r: [0.3, 0.16, 0.7, 0.28] }]]));
  assert.equal(sweep.overlapMetrics.entities, 1); assert.ok(sweep.warnings.includes('CAPTION_PLACEMENT_CONFLICT'));
  // frames outside [start, end) are ignored
  const q = req(FX.empty_lower.occ); q.frames.push({ time: q.chunkEnd, occupied: [{ entityId: 'x', type: 'primary_face', importance: 1, rect: { x: 0, y: 600, w: 540, h: 200 } }] });
  assert.equal(placeCaption(q).band, 'lower'); assert.equal(placeCaption(q).overlapMetrics.frames_sampled, 6);
});
test('12. bottom 16% is never used (even if the requested safe area is smaller)', () => {
  for (const [W, H] of [[540, 960], [1080, 1920]]) for (const safe of [undefined, { left: 0.05, right: 0.05, top: 0.0, bottom: 0.0 }]) for (const k of [...Object.keys(FX), 'CONFLICT']) for (const lines of [TWO, ['OK']]) {
    const r = placeCaption(req(k === 'CONFLICT' ? CONFLICT : FX[k].occ, { W, H, safe, lines }));
    for (const c of r.candidates) assert.ok(c.rect.y + c.rect.h <= H * (1 - CAPTION_BOTTOM_EXCLUSION) + 1e-6, `${k} ${c.band} ${W}x${H}`);
    assert.equal(r.overlapMetrics.bottom_ui_overlap_px, 0);
  }
});
test('13. horizontal safe margins respected', () => {
  for (const safe of [{ left: 0.05, right: 0.05, top: 0.08, bottom: 0.16 }, { left: 0.12, right: 0.08, top: 0.08, bottom: 0.2 }]) for (const k of Object.keys(FX)) for (const lines of [TWO, ['HI']]) {
    const r = placeCaption(req(FX[k].occ, { safe, lines }));
    for (const c of r.candidates) { assert.ok(c.rect.x >= 540 * safe.left - 1e-6 && c.rect.x + c.rect.w <= 540 * (1 - safe.right) + 1e-6, `${k} ${c.band}`); assert.ok(c.rect.y >= 960 * safe.top - 1e-6); }
    assert.equal(r.overlapMetrics.edge_overflow_px, 0);
  }
});
const validAt = (r: CaptionPlacementResult, W: number, H: number) => {
  const px = captionFontPx(H);
  assert.ok(r.rect.w > 0 && r.rect.h >= px * CAPTION_LINE_HEIGHT * 2, 'rect holds two lines at the existing font size');
  assert.ok(r.rect.x >= 0 && r.rect.y >= 0 && r.rect.x + r.rect.w <= W && r.rect.y + r.rect.h <= H);
  // capture.ts, given this centreY and the nominal two-line block, draws the text inside the rect
  const block = px * CAPTION_LINE_HEIGHT * 2, top = captionBlockTop(H, block, CAPTION_DEFAULT_STYLE, { centerY: r.centerY });
  assert.ok(top >= r.rect.y - 1 && top + block <= r.rect.y + r.rect.h + 1, `text block ${top}..${top + block} inside rect ${JSON.stringify(r.rect)}`);
};
test('14. 540x960 results valid', () => { for (const k of Object.keys(FX)) validAt(place(k), 540, 960); });
test('15. 1080x1920 results valid and match 540x960 bands', () => {
  for (const k of Object.keys(FX)) { const hi = place(k, { W: 1080, H: 1920 }), lo = place(k); validAt(hi, 1080, 1920); assert.equal(hi.band, lo.band, k); assert.ok(Math.abs(hi.centerY - lo.centerY) < 0.01, k); }
});
test('16. all-band conflict emits CAPTION_PLACEMENT_CONFLICT and still places the caption', () => {
  const r = placeCaption(req(CONFLICT));
  assert.ok(r.warnings.includes('CAPTION_PLACEMENT_CONFLICT')); assert.ok(r.violations.length > 0); assert.ok(r.candidates.every((c) => c.violations.length > 0));
  assert.ok(r.rect.w > 0 && r.rect.h > 0); assert.equal(r.stableForWholeChunk, true);
  assert.equal(r.score, Math.min(...r.candidates.map((c) => c.score)), 'least harmful candidate');
});
test('17. all-band conflict remains deterministic', () => {
  const a = JSON.stringify(placeCaption(req(CONFLICT))), b = JSON.stringify(placeCaption(req(CONFLICT)));
  assert.equal(a, b); assert.equal(JSON.parse(a).band, 'lower', 'equal coverage everywhere: preference order lower > upper > middle');
});
test('18. default capture behaviour unchanged without placement', () => {
  assert.deepEqual({ ...CAPTION_DEFAULT_STYLE }, { centerY: 0.72, bottomSafe: 0.16 }); assert.equal(captionFontPx(960), Math.round(960 * 0.036));
  for (const H of [960, 1920]) for (const n of [1, 2]) for (const st of [CAPTION_DEFAULT_STYLE, { centerY: 0.8, bottomSafe: 0.16 }]) {
    const block = Math.round(H * 0.036) * 1.22 * n, legacy = Math.min(H * st.centerY - block / 2, H * (1 - st.bottomSafe) - block);
    assert.equal(captionBlockTop(H, block, st), legacy); assert.equal(captionBlockTop(H, block, st, null), legacy); assert.equal(captionBlockTop(H, block, st, undefined), legacy);
    assert.equal(captionBlockTop(H, block, st, { centerY: NaN }), legacy);
  }
  // explicit placement is still clamped above the bottom UI-safe margin
  assert.equal(captionBlockTop(960, 85, CAPTION_DEFAULT_STYLE, { centerY: 0.95 }), 960 * 0.84 - 85);
});
test('19. same input produces byte-identical placement JSON', () => {
  for (const k of Object.keys(FX)) { const q = req(FX[k].occ); assert.equal(JSON.stringify(placeCaption(q)), JSON.stringify(placeCaption(structuredClone(q))), k); }
  // occupied-entry order within a frame does not change the result
  const q = req(FX.giant_coin_compete.occ), rev = structuredClone(q); rev.frames.forEach((f) => f.occupied.reverse());
  assert.equal(JSON.stringify(placeCaption(q)), JSON.stringify(placeCaption(rev)));
});
test('20. text and timing are never modified', () => {
  const caption = { start: 10, end: 12.5, lines: ['WAIT, IS THAT BUTTON', 'REALLY GIVING FREE COINS?'], emphasisWords: ['FREE', 'COINS'] };
  const q = req(FX.free_coins_button.occ, { lines: caption.lines }), before = JSON.stringify(q), capBefore = JSON.stringify(caption);
  const r = placeCaption(q); assert.equal(JSON.stringify(q), before, 'request not mutated');
  assert.ok(!JSON.stringify(r).includes('BUTTON'), 'result carries no text'); assert.equal(r.chunkStart, 10); assert.equal(r.chunkEnd, 12.5);
  const placed = withCaptionPlacement(caption, r);
  assert.equal(JSON.stringify(caption), capBefore);
  assert.deepEqual({ start: placed.start, end: placed.end, lines: placed.lines, emphasisWords: placed.emphasisWords }, caption);
  assert.deepEqual(placed.placement, { centerY: r.centerY });
  assert.throws(() => withCaptionPlacement({ ...caption, end: 13 }, r), /timing mismatch/);
  // over-long / 3-line input is flagged, not re-chunked
  const w = placeCaption(req([], { lines: ['A', 'B', 'THIS LINE IS DEFINITELY LONGER THAN THIRTY-TWO CHARS'] }));
  assert.ok(w.warnings.includes('CAPTION_TOO_MANY_LINES') && w.warnings.includes('CAPTION_LINE_TOO_LONG'));
  assert.deepEqual(DEFAULT_SAFE_AREA.bottom, 0.16);
});
