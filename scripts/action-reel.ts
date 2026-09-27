// Action test reel: exercises EVERY implemented semantic action on the correct actor with a diagnostic camera,
// runs collision / foot-slip / contact / completion checks, renders grouped debug videos (labels burned in, debug
// only) and writes a per-action report + contact sheet.   node scripts/action-reel.ts [--no-video] [--scale 0.5]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { launchBrowser } from '../apps/render-worker/lib/browser.ts';
import { startServer, ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';
import { contactSheet } from '../apps/render-worker/lib/sheet.ts';
import { renderEpisode, ensureWebBuild } from '../apps/render-worker/render.ts';
import { ACTIONS, EpisodeSchema } from '../packages/schema/src/episode.ts';
import { ACTION_DEFS } from '../packages/engine/src/animation/actions.ts';
import { ACTION_CAPS } from '../packages/story/src/registry.ts';
import { LOOK_LIMITS } from '../packages/engine/src/animation/animator.ts';
import { CURRENT_RENDERER_VERSION, DEFAULT_MOTION_PROFILE, EPISODE_SCHEMA_VERSION, type MotionProfileId } from '../packages/schema/src/render-compat.ts';
import { validateEpisode } from '../packages/pipeline/src/validate.ts';

// validator codes that concern the ACTIONS themselves (story-structure findings such as LOOP / NO_REVERSAL do not apply to a reel)
const ACTION_CODES = new Set(['INVALID_ACTION', 'MISSING_TARGET', 'IMPOSSIBLE_ACTION', 'TIMELINE_OVERLAP', 'TIMELINE_OVERFLOW', 'UNKNOWN_MARK', 'UNKNOWN_ANCHOR', 'UNRESOLVED_REFERENCE', 'UNKNOWN_ACTOR']);

type Seg = { action: string; actor: string; target?: string; to?: string; dur: number; expect: string; params?: Record<string, number> };
const SEG = 2.0, GAP = 0.5;
export const REELS: Array<{ name: string; start: Record<string, string>; coinVisible?: boolean; segs: Seg[] }> = [
  // order matters: curious_lean / point / press have no body turn (look-at clamps at +-75 deg), so they run while the
  // actor still faces the desk; turn_toward then turns to kira and the remaining reactions are aimed at her
  // kira watches from watch_right (behind-right): at observe_safe she stood between the diagnostic camera and zapp's face
  { name: 'reel1-gestures-at-desk', start: { zapp: 'press_spot', kira: 'watch_right' }, segs: [
    { action: 'idle', actor: 'zapp', dur: SEG, expect: 'breathing only; stays in place' },
    { action: 'curious_lean', actor: 'zapp', target: 'button', dur: SEG, expect: 'leans, hand to chin, gaze toward the button' },
    { action: 'point', actor: 'zapp', target: 'button', dur: SEG, expect: 'arm extends toward the button' },
    { action: 'press_button', actor: 'zapp', target: 'button.press_surface', dur: 1.2, expect: 'hand lands on the button (contact < 2 cm)' },
    { action: 'shock_recoil', actor: 'zapp', target: 'button', dur: SEG, expect: 'recoils, arms up, tremble' },
    { action: 'cower', actor: 'zapp', dur: SEG, expect: 'crouches, arms over head' },
    { action: 'turn_toward', actor: 'zapp', target: 'kira', dur: SEG, expect: 'body turns to face kira (listed later in the cast)' },
  ] },
  { name: 'reel2-emotes-open-floor', start: { zapp: 'center_stage', kira: 'observe_safe' }, segs: [
    { action: 'victory_pose', actor: 'zapp', dur: SEG, expect: 'hop + arms up' },
    { action: 'laugh', actor: 'kira', dur: SEG, expect: 'laughing bob' },
    { action: 'facepalm', actor: 'zapp', target: 'zapp.face', dur: SEG, expect: 'hand meets face (< 12 cm)' },
    { action: 'regret_freeze', actor: 'zapp', dur: SEG, expect: 'still, head drops' },
    { action: 'angry_stomp', actor: 'zapp', dur: SEG, expect: 'alternating stomps' },
    { action: 'arms_crossed', actor: 'kira', target: 'zapp', dur: SEG, expect: 'forearms cross in front of the chest' },
    { action: 'head_shake', actor: 'kira', dur: SEG, expect: 'head yaw oscillation (layer)' },
    { action: 'jump', actor: 'zapp', dur: SEG, expect: 'leaves the ground >= 15 cm and lands' },
  ] },
  { name: 'reel3-locomotion', start: { zapp: 'center_stage', kira: 'foil_safe' }, segs: [
    { action: 'walk', actor: 'zapp', to: 'wp_front_left', dur: SEG, expect: 'arrives at mark, feet planted' },
    { action: 'run', actor: 'zapp', to: 'wp_front_right', dur: SEG, expect: 'arrives at mark' },
    { action: 'chase', actor: 'zapp', to: 'center_stage', dur: SEG, expect: 'arrives at mark' },
    { action: 'enter_frame', actor: 'zapp', to: 'observe_safe', dur: SEG, expect: 'arrives at mark' },
    { action: 'exit_frame', actor: 'zapp', to: 'center_stage', dur: SEG, expect: 'arrives at mark' },
    { action: 'dive_prone', actor: 'zapp', to: 'wp_front_left', dur: SEG, expect: 'leaps and ends prone, head raised', params: { diveAt: 0.3 } },
  ] },
  { name: 'reel4-object-actions-and-fall', start: { zapp: 'press_spot', kira: 'observe_safe' }, coinVisible: true, segs: [
    // observer gaze with a large head turn (~55 deg) AND a downward look (~28 deg): the case where legacy-head-v1's
    // rotation order loses most of the pitch (how generated episodes use look_at)
    { action: 'look_at', actor: 'kira', target: 'coin', dur: SEG, expect: 'observer head turns ~55 deg and looks down at the coin on the desk' },
    { action: 'pick_up', actor: 'zapp', target: 'coin', dur: SEG, expect: 'bends, hand reaches the coin; object SHOULD follow the hand' },
    { action: 'hold', actor: 'zapp', dur: SEG, expect: 'holding pose; object SHOULD be in the hand' },
    { action: 'put_down', actor: 'zapp', target: 'coin', dur: SEG, expect: 'hand returns to the coin' },
    { action: 'throw', actor: 'zapp', target: 'kira', dur: SEG, expect: 'throw swing; object SHOULD leave the hand' },
    { action: 'drink', actor: 'zapp', dur: SEG, expect: 'hand to mouth; needs a bottle prop' },
    { action: 'fall', actor: 'kira', dur: SEG, expect: 'falls backward, ends supine' },
  ] },
];

// frame the actor and (for non-locomotion) the prop/actor it targets, so the diagnostic wide shows both ends of the action
function frameSubjects(s: Seg): string[] {
  const b = s.target?.split('.')[0];
  return !s.to && b && b !== s.actor && ['button', 'coin', 'desk', 'zapp', 'kira'].includes(b) ? [s.actor, b] : [s.actor];
}

function reelEpisode(r: (typeof REELS)[number], profile: MotionProfileId = DEFAULT_MOTION_PROFILE): { ep: any; overlay: Array<{ from: number; to: number; text: string }>; spans: Array<Seg & { start: number; end: number; n: number }> } {
  let t = 0.6; const spans: Array<Seg & { start: number; end: number; n: number }> = [];
  const total = ACTIONS.filter((a) => ACTION_DEFS[a]).length;
  for (const s of r.segs) { spans.push({ ...s, start: +t.toFixed(3), end: +(t + Math.max(s.dur, 1.2) + GAP).toFixed(3), n: 0 }); t += Math.max(s.dur, 1.2) + GAP; }
  const D = Math.max(14, +(t + 0.2).toFixed(3));
  for (const x of spans) x.n = ACTIONS.indexOf(x.action as never) + 1;
  const actions = spans.map((s) => ({ actor: s.actor, action: s.action, start: s.start, duration: s.dur, ...(s.target ? { target: s.target } : {}), ...(s.to ? { to: s.to } : {}), ...(s.params ? { params: s.params } : {}) }));
  // diagnostic camera: locked wide on the actor; locomotion segments follow the actor (the camera can only frame actors/props, not marks)
  const shots = spans.map((s, i) => ({ id: `s${String(i + 1).padStart(2, '0')}`, start: i === 0 ? 0 : s.start, end: i === spans.length - 1 ? D : spans[i + 1].start, preset: 'wide_environment', subjects: frameSubjects(s), purpose: `diagnostic: ${s.action}`, params: s.to ? { follow: true, margin: 1.4, elev: 0.2, fov: 40, push: 0 } : { solveAt: s.start + 0.05, margin: 0.9, elev: 0.18, fov: 40, push: 0 } }));
  const ep = {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    render: { rendererVersion: CURRENT_RENDERER_VERSION, motionProfile: profile },
    episode: { id: `diag-${r.name}`, title: `Action reel ${r.name}`, logline: 'Diagnostic action reel (debug overlay, not a story)', duration: D, format: 'vertical', resolution: [1080, 1920], fps: 30, seed: 7, comedyEngine: 'escalation_backfire' },
    environment: { id: 'classroom', version: '1.1.0', lighting: 'morning' },
    cast: [{ id: 'zapp', version: '1.0.0', role: 'protagonist', startMark: r.start.zapp, startExpression: 'neutral' }, { id: 'kira', version: '1.1.0', role: 'foil', startMark: r.start.kira, startExpression: 'smug' }],
    props: [
      { instance: 'desk', id: 'student_desk', version: '1.0.0', anchor: 'hero_desk_spot', hero: false, visible: true, scale: 1 },
      { instance: 'button', id: 'suspicious_button', version: '1.0.0', anchor: 'button_spot', parent: 'desk', hero: true, visible: !r.coinVisible, scale: 1 },
      // reel4: the coin replaces the (hidden) button on the desk top: the same reach press_button is validated on; other reels keep the hidden floor coin
      r.coinVisible ? { instance: 'coin', id: 'spark_coin', version: '1.0.0', anchor: 'button_spot', parent: 'desk', hero: false, visible: true, scale: 1.5 } : { instance: 'coin', id: 'spark_coin', version: '1.0.0', anchor: 'coin_floor', hero: false, visible: false, scale: 1 },
    ],
    beats: spans.map((s, i) => ({ id: `b${String(i + 1).padStart(2, '0')}`, start: i === 0 ? 0 : s.start, end: i === spans.length - 1 ? D : spans[i + 1].start, intent: 'setup', summary: `${s.actor} ${s.action}`, informationChange: false })),
    actions, expressions: [], propEvents: [], shots, vfx: [],
    audio: { cues: [], ambience: { id: 'amb_classroom', gainDb: -34 }, loudnessLufs: -20, duckingDb: 0 },
    loop: { mode: 'continuous', firstShot: 's01', lastShot: shots[shots.length - 1].id, matchWindow: 0 },
    export: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', videoBitrateKbps: 8000, audioBitrateKbps: 160 },
    safety: { familySafe: true, usesThirdPartyBrands: false, realMoneyOrGiveawayClaims: false, notes: 'diagnostic reel' },
  };
  return { ep, overlay: spans.map((s) => ({ from: s.start - 0.3, to: s.end, text: `${String(s.n).padStart(2, '0')}/${total} ${s.action} (${s.actor})` })), spans };
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function judge(s: Seg & { start: number; end: number }, pose: any[], issues: any[], marks: Record<string, { pos: number[] }>, contactErr: number | null): { status: 'PASS' | 'PARTIAL' | 'FAIL'; checks: Record<string, unknown>; notes: string[] } {
  const seg = pose.filter((p) => p.t >= s.start && p.t <= s.end);
  const p0 = seg[0], pe = seg[seg.length - 1];
  const rel = (p: any, k: string) => [p[k][0] - p.root[0], p[k][1] - p.root[1], p[k][2] - p.root[2]];
  const motion = Math.max(...seg.map((p) => Math.max(dist(rel(p, 'handL'), rel(p0, 'handL')), dist(rel(p, 'handR'), rel(p0, 'handR')), dist(rel(p, 'head'), rel(p0, 'head')))), ...seg.map((p) => dist(p.root, p0.root)));
  const mine = issues.filter((i) => i.t >= s.start && i.t <= s.end && (i.subject === s.actor || String(i.message).startsWith(s.actor)) && ['HAND_PENETRATION', 'BODY_PROP_INTERSECTION', 'CAMERA_IN_PROP'].includes(i.code));
  const slips: number[] = [];
  // G21 definition (feet = sole x,z + lowest toe/heel height): stance held >= 2 frames, both frames on the floor, root > 0.3 m/s
  for (let i = 2; i < seg.length; i++) { const z = seg[i - 2], a = seg[i - 1], b = seg[i]; if (!a.stance || a.stance !== b.stance || z.stance !== a.stance) continue; const k = b.stance === 'l' ? 'footL' : 'footR'; if (Math.hypot(b.root[0] - a.root[0], b.root[2] - a.root[2]) * 30 > 0.3 && b[k][1] < 0.02 && a[k][1] < 0.02) slips.push(Math.hypot(b[k][0] - a[k][0], b[k][2] - a[k][2]) * 30); }
  slips.sort((x, y) => x - y);
  const checks: Record<string, unknown> = { started: motion > (s.action === 'idle' ? 0.002 : 0.03), motionM: +motion.toFixed(3), collisions: mine.length, collisionSample: mine[0]?.message ?? null };
  const notes: string[] = [];
  let ok = (checks.started as boolean) && mine.length === 0;
  let partial = false;
  if (slips.length) { checks.footSlipMedian = +slips[Math.floor(slips.length / 2)].toFixed(3); checks.footSlipP95 = +slips[Math.floor(slips.length * 0.95)].toFixed(3); ok = ok && (checks.footSlipMedian as number) < 0.05 && (checks.footSlipP95 as number) < 0.5; }
  if (s.to) { const m = marks[s.to].pos; const d = Math.hypot(pe.root[0] - m[0], pe.root[2] - m[2]); checks.arrivalErrorM = +d.toFixed(3); ok = ok && d < (s.action === 'dive_prone' ? 0.25 : 0.06); }
  // locomotion onset: planted (stance) foot speed in the first 0.5 s while the root moves at all (> 0.05 m/s). No frames are
  // skipped except the touchdown frame of a stance switch; frames before the gait reports a stance count as unplanted and
  // are covered by the grounded-foot measure below.
  {
    if (s.to) {
      let onsetMax = 0, onsetN = 0;
      for (let i = 1; i < seg.length; i++) {
        const a = seg[i - 1], b = seg[i];
        if (b.t > s.start + 0.5 || !a.stance || a.stance !== b.stance) continue;
        const k = b.stance === 'l' ? 'footL' : 'footR';
        if (Math.hypot(b.root[0] - a.root[0], b.root[2] - a.root[2]) * 30 <= 0.05 || b[k][1] >= 0.02 || a[k][1] >= 0.02) continue;
        onsetN++; onsetMax = Math.max(onsetMax, Math.hypot(b[k][0] - a[k][0], b[k][2] - a[k][2]) * 30);
      }
      checks.onsetPlantedSamples = onsetN; checks.onsetPlantedMaxSlip = +onsetMax.toFixed(3);
      ok = ok && onsetN > 0 && onsetMax < 0.1;
      if (!onsetN) notes.push('onset: no planted stance-foot frame reported during the first 0.5 s');
    }
  }
  // grounded-foot skating (either foot, whole window): lowest toe/heel point ON the floor surface (|y| < 1 cm) in two
  // consecutive frames while it moves horizontally; and floor clipping (lowest point below -0.5 cm). Both are reported for
  // every action and are NOT part of PASS/FAIL: they are gait/pose-blend limitations present in BOTH motion profiles
  // (in-place turns rotate about the root centre; lift-off tilts the shoe below the floor for 1-2 frames without an ankle).
  let skate = 0, skateAt = 0, clip = 0, clipAt = 0;
  for (let i = 1; i < seg.length; i++) for (const k of ['footL', 'footR']) {
    const a = seg[i - 1], b = seg[i];
    if (-b[k][1] > clip) { clip = -b[k][1]; clipAt = b.t; }
    if (Math.abs(a[k][1]) >= 0.01 || Math.abs(b[k][1]) >= 0.01) continue;
    const v = Math.hypot(b[k][0] - a[k][0], b[k][2] - a[k][2]) * 30;
    if (v > skate) { skate = v; skateAt = b.t; }
  }
  checks.groundedFootSkateMax = +skate.toFixed(3); checks.footBelowFloorMaxCm = +(clip * 100).toFixed(1);
  if (skate > 0.1) notes.push(`a foot on the floor slides up to ${skate.toFixed(2)} m/s at t=${skateAt.toFixed(2)} (${s.action === 'turn_toward' ? 'in-place turn rotates about the root centre' : s.to ? 'stance hand-off / post-stop settle' : 'pose change with both feet down'}) — limitation in both profiles`);
  if (clip > 0.005) notes.push(`shoe dips ${(clip * 100).toFixed(1)} cm below the floor at t=${clipAt.toFixed(2)} (no ankle joint) — limitation in both profiles`);
  if (s.action === 'dive_prone' || s.action === 'fall') { checks.endHeadHeightM = +pe.head[1].toFixed(3); ok = ok && pe.head[1] < 0.75; }
  if (s.action === 'jump' || s.action === 'victory_pose') { const lift = Math.max(...seg.map((p) => Math.min(p.soleL[1], p.soleR[1]))); checks.maxLiftM = +lift.toFixed(3); checks.landed = Math.min(pe.soleL[1], pe.soleR[1]) < 0.02; ok = ok && (s.action !== 'jump' || lift >= 0.15) && (checks.landed as boolean); }
  if (s.action === 'turn_toward' && s.target) { const tgt = marks[s.target]?.pos ?? null; void tgt; checks.yawChangeDeg = +Math.abs(pe.yaw - p0.yaw).toFixed(1); ok = ok && (checks.yawChangeDeg as number) > 20; }
  if (s.action === 'press_button' || s.action === 'facepalm' || s.action === 'pick_up' || s.action === 'put_down') { checks.contactErrorCm = contactErr === null ? null : +(contactErr * 100).toFixed(1); ok = ok && contactErr !== null && contactErr < (s.action === 'facepalm' ? 0.12 : s.action === 'press_button' ? 0.02 : 0.06); }
  if (s.action === 'arms_crossed') { const crossed = seg.slice(-5).every((p) => { const yaw = p.yaw * Math.PI / 180; const lx = (h: number[]) => (h[0] - p.root[0]) * Math.cos(yaw) - (h[2] - p.root[2]) * Math.sin(yaw); return lx(p.handR) > lx(p.handL); }); checks.handsCrossed = crossed; ok = ok && crossed; }
  // head-yaw layer: face yaw relative to the body must oscillate (>= 2 direction changes, amplitude >= 8 deg)
  const wrap = (d: number) => ((d + 540) % 360) - 180;
  if (s.action === 'head_shake') {
    const rel = seg.map((p) => wrap(p.faceYaw - p.yaw)); const amp = (Math.max(...rel) - Math.min(...rel)) / 2;
    let flips = 0; for (let i = 2; i < rel.length; i++) if (Math.sign(rel[i] - rel[i - 1]) !== Math.sign(rel[i - 1] - rel[i - 2]) && Math.abs(rel[i] - rel[i - 1]) > 0.2) flips++;
    checks.headYawAmplitudeDeg = +amp.toFixed(1); checks.headYawReversals = flips; ok = ok && amp >= 8 && flips >= 2;
  }
  // gaze (at 60 % of the action, from the neck pivot the look-at solver uses):
  //  * yaw: horizontal face direction vs the target direction; curious_lean (look weight 0.6) must cover >= 45 % of the turn
  //  * pitch: must reach min(needed, LOOK_LIMITS.pitchDown) * weight - 10 deg; beyond the neck limit the residual is by design
  //    (a spine bend would be needed) and is reported, not hidden. gazeErrorDeg = raw 3D error for information.
  if ((s.action === 'look_at' || s.action === 'curious_lean' || s.action === 'turn_toward') && s.target) {
    const mid = seg.find((p) => p.t >= s.start + s.dur * 0.6) ?? pe;
    if (mid.target) {
      const w = s.action === 'curious_lean' ? 0.6 : 1;
      const o = mid.gazeFrom, d = [mid.target[0] - o[0], mid.target[1] - o[1], mid.target[2] - o[2]], f = mid.faceFwd;
      const hd = Math.hypot(d[0], d[2]), deg = 180 / Math.PI;
      const wantYaw = Math.atan2(d[0], d[2]) * deg, faceYaw = Math.atan2(f[0], f[2]) * deg;
      const wantPitch = Math.atan2(-d[1], hd) * deg, facePitch = Math.asin(-f[1] / Math.hypot(f[0], f[1], f[2])) * deg;
      checks.gazeErrorDeg = +(Math.acos(Math.max(-1, Math.min(1, (d[0] * f[0] + d[1] * f[1] + d[2] * f[2]) / (Math.hypot(d[0], d[1], d[2]) * Math.hypot(f[0], f[1], f[2]))))) * deg).toFixed(1);
      const need = wrap(wantYaw - mid.yaw), got = wrap(faceYaw - mid.yaw);
      checks.gazeYawErrorDeg = +Math.abs(wrap(faceYaw - wantYaw)).toFixed(1);
      checks.wantPitchDownDeg = +wantPitch.toFixed(1); checks.facePitchDownDeg = +facePitch.toFixed(1);
      const yawOk = hd < 0.15 || (w === 1 ? (checks.gazeYawErrorDeg as number) < 25 : Math.abs(need) < 10 || (Math.sign(got) === Math.sign(need) && Math.abs(got) >= 0.45 * Math.min(Math.abs(need), LOOK_LIMITS.yaw)));
      const pitchOk = wantPitch < 15 || facePitch >= Math.min(wantPitch, LOOK_LIMITS.pitchDown) * w - 10;
      if (wantPitch > LOOK_LIMITS.pitchDown + 5) notes.push(`target is ${wantPitch.toFixed(0)} deg below the head; neck look-at is limited to ${LOOK_LIMITS.pitchDown} deg, so ~${(wantPitch - LOOK_LIMITS.pitchDown).toFixed(0)} deg residual is a rig limit (no spine bend in look_at)`);
      ok = ok && yawOk && pitchOk;
    }
  }
  // completion: the action ran its full scheduled duration (no overlap truncation) and the actor has SETTLED at the end of
  // the window (root < 0.1 m/s, hands < 0.6 m/s relative to the root over the last 0.2 s) — looping layers excluded
  const tail = seg.filter((p) => p.t >= s.end - 0.2);
  const sp = (k: string) => Math.max(0, ...tail.slice(1).map((p, i) => dist(rel(p, k), rel(tail[i], k)) / Math.max(1e-6, p.t - tail[i].t)));
  const rootV = Math.max(0, ...tail.slice(1).map((p, i) => dist(p.root, tail[i].root) / Math.max(1e-6, p.t - tail[i].t)));
  checks.endRootSpeed = +rootV.toFixed(3); checks.endHandSpeed = +Math.max(sp('handL'), sp('handR')).toFixed(3);
  const looping = ['idle', 'laugh', 'head_shake', 'angry_stomp', 'cower', 'shock_recoil'].includes(s.action);
  checks.completed = pe.t >= s.end - 0.05 && (looping || (rootV < 0.1 && (checks.endHandSpeed as number) < 0.6));
  ok = ok && (checks.completed as boolean);
  if (['pick_up', 'hold', 'put_down', 'throw', 'drink'].includes(s.action)) { partial = true; notes.push('pose/reach works, but engine v1 has NO prop attachment: the object does not move with the hand, so the action cannot be used with a prop (storyUse=false)'); }
  return { status: !ok ? 'FAIL' : partial ? 'PARTIAL' : 'PASS', checks, notes };
}

async function analyseReels(page: any, lib: any, profile: MotionProfileId, outDir: string, withStills: boolean): Promise<{ results: any[]; stills: string[]; labels: string[] }> {
  const env = lib.environments['classroom@1.1.0'];
  const results: any[] = []; const stills: string[] = []; const labels: string[] = [];
  for (const r of REELS) {
    const { ep, spans } = reelEpisode(r, profile);
    const sv = EpisodeSchema.parse(ep); if (!sv.ok) throw new Error(`${r.name}: ${JSON.stringify(sv.issues.slice(0, 3))}`);
    if (profile === DEFAULT_MOTION_PROFILE) writeFileSync(join(outDir, `${r.name}.json`), JSON.stringify(ep, null, 2));
    const vr = validateEpisode(ep, lib as any, { repair: false, profile: 'action-reel' });
    const vf = vr.findings.filter((f: any) => f.severity === 'error' && ACTION_CODES.has(f.code));
    if (!vr.ok) throw new Error(`${r.name}: action-reel validation failed: ${JSON.stringify(vr.findings.filter((f: any) => f.severity === 'error').slice(0, 4))}`);
    const info = await page.evaluate(([e, l]: any) => (window as any).__spark.load(e, l, 270, 480), [ep, lib]);
    const times = Array.from({ length: Math.round(ep.episode.duration * 30) }, (_, i) => i / 30);
    const issues = (await page.evaluate((ts: number[]) => (window as any).__spark.analyze(ts, { body: true }), times.filter((_, i) => i % 2 === 0))).flatMap((f: any) => f.issues.map((i: any) => ({ ...i, t: f.t })));
    const contacts = await page.evaluate((ts: number[]) => (window as any).__spark.analyze(ts), info.contacts.map((c: any) => c.t));
    const segs = await page.evaluate((a: string) => (window as any).__spark.segments(a), 'zapp');
    for (const s of spans) {
      const pose = await page.evaluate(([ts, a, tg]: [number[], string, string | undefined]) => (window as any).__spark.pose(ts, a, tg), [times.filter((t) => t >= s.start - 0.05 && t <= s.end + 0.05), s.actor, s.target] as [number[], string, string | undefined]);
      const ci = info.contacts.findIndex((c: any) => c.actor === s.actor && c.action === s.action);
      const res = judge(s, pose, issues, env.marks as any, ci >= 0 ? contacts[ci].handErrors[s.actor] ?? null : null);
      const mineV = vf.filter((f: any) => String(f.message).includes(`${s.actor} ${s.action}@${s.start}`) || String(f.message).includes(`${s.action}@${s.start}`));
      if (mineV.length) { res.status = 'FAIL'; res.notes.push(...mineV.map((f: any) => `validator ${f.code}: ${f.message}`)); }
      const sg = s.actor === 'zapp' ? segs.find((x: any) => x.action === s.action && Math.abs(x.start - s.start) < 1e-6) : null;
      if (sg?.onsetSkip) res.notes.push(`synchronised onset not applied: ${sg.onsetSkip}`);
      results.push({ n: s.n, action: s.action, actor: s.actor, reel: r.name, window: [s.start, s.end], expectation: s.expect, storyUse: ACTION_CAPS[s.action]?.storyUse ?? false, ...res });
      if (withStills) {
        const key = ci >= 0 ? info.contacts[ci].t : s.start + Math.min(s.dur, 2.0) * 0.6;
        stills.push(await page.evaluate((t: number) => (window as any).__spark.still(t), key)); labels.push(`${s.n} ${s.action} ${res.status}`);
      }
    }
  }
  const allImpl = ACTIONS.filter((a) => ACTION_DEFS[a]);
  for (const a of allImpl) if (!results.some((x) => x.action === a)) results.push({ n: ACTIONS.indexOf(a) + 1, action: a, actor: '-', status: 'SKIPPED', checks: {}, notes: [a === 'hover' ? 'only valid for floating rigs (BZTT not built); no built character is allowed to hover' : 'not exercised'], storyUse: ACTION_CAPS[a]?.storyUse ?? false });
  results.sort((x, y) => x.n - y.n);
  return { results, stills, labels };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const noVideo = process.argv.includes('--no-video');
  const scale = Number(process.argv[process.argv.indexOf('--scale') + 1] || 0.5) || 0.5;
  const outDir = join(ROOT, 'out', 'action-reel'); mkdirSync(outDir, { recursive: true });
  const lib = loadLibrary(); ensureWebBuild(() => {});
  const { server, url } = await startServer(0); const browser = await launchBrowser(); const page = await browser.newPage();
  await page.goto(`${url}/apps/studio/render.html`); await page.waitForFunction(() => (window as any).__spark?.ready);
  const main = await analyseReels(page, lib, DEFAULT_MOTION_PROFILE, outDir, true);
  const legacy = await analyseReels(page, lib, 'legacy-head-v1', outDir, false);
  const sheet = await contactSheet(page, main.stills, main.labels, 6, 180);
  writeFileSync(join(outDir, 'contact-sheet.png'), Buffer.from(sheet.split(',')[1], 'base64'));
  await browser.close(); server.close();
  const results = main.results;
  const videos: Array<{ reel: string; mp4: string; gates: string; failed: string[]; notApplicable: string[] }> = [];
  if (!noVideo) for (const r of REELS) {
    const { ep, overlay } = reelEpisode(r);
    const res = await renderEpisode({ episode: `out/action-reel/${r.name}.json`, episodeObject: ep, out: `out/action-reel/${r.name}`, scale, validationProfile: 'action-reel', overlay, verify: true });
    if (res.mp4) videos.push({ reel: r.name, mp4: relative(ROOT, res.mp4), gates: res.report ? `${res.report.summary.passed}/${res.report.summary.total}` : 'n/a', failed: res.report?.summary.failed ?? ['render failed'], notApplicable: res.report?.summary.notApplicable ?? [] });
  }
  const count = (rs: any[], st: string) => rs.filter((x) => x.status === st).length;
  const differs = results.filter((x) => { const l = legacy.results.find((y) => y.n === x.n); return l && l.status !== x.status; }).map((x) => ({ action: x.action, [DEFAULT_MOTION_PROFILE]: x.status, 'legacy-head-v1': legacy.results.find((y) => y.n === x.n)!.status, legacyChecks: legacy.results.find((y) => y.n === x.n)!.checks }));
  const report = {
    motionProfile: DEFAULT_MOTION_PROFILE, rendererVersion: CURRENT_RENDERER_VERSION, validationProfile: 'action-reel',
    implemented: ACTIONS.filter((a) => ACTION_DEFS[a]).length, exercised: results.filter((x) => x.status !== 'SKIPPED').length,
    pass: count(results, 'PASS'), partial: count(results, 'PARTIAL'), fail: count(results, 'FAIL'), skipped: count(results, 'SKIPPED'),
    legacyComparison: { pass: count(legacy.results, 'PASS'), partial: count(legacy.results, 'PARTIAL'), fail: count(legacy.results, 'FAIL'), differs },
    videos, results, legacyResults: legacy.results,
  };
  writeFileSync(join(outDir, 'action-report.json'), JSON.stringify(report, null, 2));
  const md = [
    '# Action reel report', '',
    `Renderer ${report.rendererVersion}, motion profile \`${report.motionProfile}\` (default for new episodes), validation profile \`action-reel\` (story-only gates not applicable).`, '',
    `Implemented actions: ${report.implemented}; exercised: ${report.exercised}; PASS ${report.pass}, PARTIAL ${report.partial}, FAIL ${report.fail}, SKIPPED ${report.skipped}.`, '',
    `Same reels under \`legacy-head-v1\`: PASS ${report.legacyComparison.pass}, PARTIAL ${report.legacyComparison.partial}, FAIL ${report.legacyComparison.fail}. Actions whose verdict differs: ${differs.map((d) => `${d.action} (${d['legacy-head-v1']} -> ${d[DEFAULT_MOTION_PROFILE]})`).join(', ') || 'none'}.`, '',
    ...(videos.length ? ['| reel | video | applicable gates | failed | n/a |', '|---|---|---|---|---|', ...videos.map((v) => `| ${v.reel} | \`${v.mp4}\` | ${v.gates} | ${v.failed.join(', ') || '-'} | ${v.notApplicable.join(', ')} |`), ''] : []),
    '| # | action | actor | status | legacy | story use | checks | notes |', '|---|---|---|---|---|---|---|---|',
    ...results.map((x) => `| ${x.n} | ${x.action} | ${x.actor} | **${x.status}** | ${legacy.results.find((y) => y.n === x.n)?.status ?? '-'} | ${x.storyUse ? 'yes' : 'no'} | ${JSON.stringify(x.checks).replace(/\|/g, '/')} | ${(x.notes ?? []).join('; ')} |`),
  ].join('\n');
  writeFileSync(join(outDir, 'action-report.md'), md + '\n');
  console.log(JSON.stringify({ implemented: report.implemented, exercised: report.exercised, pass: report.pass, partial: report.partial, fail: report.fail, skipped: report.skipped, legacy: report.legacyComparison, videos }));
  for (const x of results) console.log(String(x.n).padStart(2), x.action.padEnd(14), x.status.padEnd(8), JSON.stringify(x.checks).slice(0, 150));
}
