// Planned body actions (S5): full-body acting with comedic anticipation, overshoot and squash.
// Joint conventions (see actions.ts): Euler degrees; spine/neck x + = forward/down; shoulder x - = arm forward/up,
// shoulder_l z + / shoulder_r z - = arm out to the side; elbow x - = bend; hip x - = thigh forward; knee x + = bend.
import { K, type JointPose } from '../pose.ts';
import { ACTION_DEFS, IDLE_POSE, type ActionCtx } from '../actions.ts';
/** the engine's distance-driven gait (analytic foot planting) */
const locomotion = (c: ActionCtx) => ACTION_DEFS.walk.pose(c);
import { ACTING, acting, hop, landingSquash, loopEnvelope, seedPhase, settle, squashStretch, strike } from '../comedy.ts';
import type { Vec3 } from '../../math.ts';
import { bodyOf, chestPoint, eyePoint, flag, frac, mix, num, plus, ramp, sideways, ss, window } from './util.ts';
import type { LibActionDef } from './types.ts';

type Def = Omit<LibActionDef, 'id' | 'version' | 'kind'>;

// ---------------------------------------------------------------- sit / stand_up

/** seated: thighs level, shins down, hands resting on the knees */
export const SEATED_POSE: JointPose = {
  hips: [0, 0, 0], spine: [4, 0, 0], neck: [-2, 0, 0],
  hip_l: [-90, 0, 4], knee_l: [90, 0, 0], hip_r: [-90, 0, -4], knee_r: [90, 0, 0],
  shoulder_l: [-38, 0, 8], elbow_l: [-34, 0, 0], shoulder_r: [-38, 0, -8], elbow_r: [-34, 0, 0],
};
/** extra height when the seat is higher than the natural knee height (feet dangle) */
function seatLift(c: ActionCtx): number {
  const h = num(c, 'seatHeight', NaN);
  if (!Number.isFinite(h)) return 0;
  const b = bodyOf(c);
  return Math.max(0, h - (b.legLen / 2 - 0.1));
}
/** sit: glance down at the seat, drop with an overshoot, plop (squash) and settle; holds */
const sit: Def = {
  holds: true, blendIn: 0.2, defaultDuration: 1.0, needs: ['seat'], contactU: 0.62,
  pose: (c) => {
    const x = Math.min(1, c.lt / Math.min(c.d, 1.0));
    const pre = ramp(x, 0, 0.25);
    const drop = x < 0.25 ? 0 : acting((x - 0.25) / 0.75, { anticipation: 0, antAt: 0.01, strikeAt: 0.5, overshoot: 0.06, wobble: 2 });
    const land = landingSquash((x - 0.62) / 0.38, 0.14);
    const stand: JointPose = { ...IDLE_POSE, spine: [-4 * pre, 0, 0], neck: [12 * pre, 0, 0], hip_l: [-10 * pre, 0, 2], knee_l: [16 * pre, 0, 0], hip_r: [-10 * pre, 0, -2], knee_r: [16 * pre, 0, 0] };
    const j = mix(stand, SEATED_POSE, drop);
    // counterbalance: the chest pitches forward while the hips go back and down
    j.spine = [(j.spine?.[0] ?? 0) + 12 * Math.sin(Math.PI * Math.min(1, drop)), 0, 0];
    j.neck = [(j.neck?.[0] ?? 0) - 8 * Math.sin(Math.PI * Math.min(1, drop)), 0, 0]; // keep the face up while dropping
    return { joints: j, lift: seatLift(c) * ss(drop), scale: squashStretch(land), still: x > 0.9 };
  },
};
/** stand_up: lean forward (anticipation), push up past upright (overshoot, slight rise), settle */
const stand_up: Def = {
  holds: false, blendIn: 0.15, defaultDuration: 0.9,
  pose: (c) => {
    const u = c.u;
    const lean = K(u, [[0, 0], [0.3, 1], [0.62, 0.2], [1, 0]]);
    const rise = u < 0.25 ? 0 : acting((u - 0.25) / 0.75, { anticipation: 0, antAt: 0.01, strikeAt: 0.45, overshoot: 0.08, wobble: 2 });
    const j = mix(SEATED_POSE, IDLE_POSE, Math.min(1, rise));
    // overshoot past upright reads as a proud chest-out before settling
    j.spine = [(j.spine?.[0] ?? 0) + 32 * lean - 80 * Math.max(0, rise - 1), 0, 0];
    j.neck = [(j.neck?.[0] ?? 0) - 14 * lean, 0, 0];
    return { joints: j, lift: seatLift(c) * (1 - ss(rise)) + 0.03 * Math.max(0, Math.sin(Math.PI * clampU((u - 0.5) / 0.35))), scale: squashStretch(1 + 0.05 * Math.max(0, Math.sin(Math.PI * clampU((u - 0.45) / 0.4)))) };
  },
};
const clampU = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------------------------------------------------------------- celebrate

/** celebrate: crouch, jump with arms thrown up in a V, squash on landing, fist pumps; mouth "yay" */
const celebrate: Def = {
  holds: false, blendIn: 0.1, defaultDuration: 1.6, contactU: 0.55,
  pose: (c) => {
    const u = c.u, h = hop(u / 0.8, { takeoff: 0.3, land: 0.7, height: num(c, 'height', 0.38), squash: 0.24, stretch: 0.12 });
    const up = ramp(u, 0.18, 0.3) * (1 - ramp(u, 0.9, 1));
    const pump = u > 0.58 ? Math.max(0, Math.sin((u - 0.58) * c.d * 2 * Math.PI * 3.2)) * (1 - ramp(u, 0.88, 0.98)) : 0;
    const back = window(u, 0.05, 0.2, 0.08); // anticipation: arms swing down and back
    const legs = h.crouch * 1 + h.tuck * 0.6;
    return {
      joints: {
        spine: [16 * h.crouch - 8 * up, 0, 0], neck: [6 * h.crouch - 16 * up, 0, 0],
        shoulder_l: [30 * back - 20 * up + 10 * pump, 0, 6 + 144 * up], shoulder_r: [30 * back - 20 * up + 10 * pump, 0, -6 - 144 * up],
        elbow_l: [-8 - 20 * up - 55 * pump, 0, 0], elbow_r: [-8 - 20 * up - 55 * pump, 0, 0],
        hip_l: [-48 * legs, 0, 4 + 6 * h.tuck], knee_l: [88 * legs, 0, 0], hip_r: [-48 * legs, 0, -4 - 6 * h.tuck], knee_r: [88 * legs, 0, 0],
      },
      lift: h.lift, scale: h.scale, still: true,
    };
  },
  face: (c) => (c.u > 0.28 && c.u < 0.92 ? { mouth: { shape: 'wide', open: 0.85 * window(c.u, 0.3, 0.88, 0.04) } } : undefined),
};

// ---------------------------------------------------------------- dance

type Move = (b: number, down: number) => JointPose;
const MOVES: Move[] = [
  // bounce: knees on the beat, arms swinging
  (b, down) => ({ spine: [4, 8 * Math.sin(Math.PI * b), 0], neck: [4 * down, 0, 0], hips: [0, 0, 6 * Math.sin(Math.PI * b)], shoulder_l: [30 * Math.sin(Math.PI * b), 0, 12], shoulder_r: [-30 * Math.sin(Math.PI * b), 0, -12], elbow_l: [-70, 0, 0], elbow_r: [-70, 0, 0] }),
  // raise the roof
  (_b, down) => ({ spine: [-4, 0, 0], neck: [-10 + 12 * down, 0, 0], shoulder_l: [-150 + 22 * down, 0, 20], shoulder_r: [-150 + 22 * down, 0, -20], elbow_l: [-70 + 30 * down, 0, 0], elbow_r: [-70 + 30 * down, 0, 0] }),
  // disco point: right arm up-across, down-out on alternate beats
  (b) => { const s = Math.sin((Math.PI / 2) * b); return { spine: [0, -12 * s, 6 * s], neck: [-8 * s, -20 * s, 0], hips: [0, 0, -8 * s], shoulder_r: [-90 - 70 * s, 0, -30 + 10 * s], elbow_r: [-6, 0, 0], shoulder_l: [-20, 0, 30], elbow_l: [-90, 0, 0] }; },
  // wiggle: arms out, chicken-wing elbows, side-to-side
  (b) => ({ spine: [2, 0, 12 * Math.sin(Math.PI * b)], neck: [0, 0, -10 * Math.sin(Math.PI * b)], hips: [0, 0, -8 * Math.sin(Math.PI * b)], shoulder_l: [-10, 0, 60 + 20 * Math.sin(2 * Math.PI * b)], shoulder_r: [-10, 0, -60 - 20 * Math.sin(2 * Math.PI * b)], elbow_l: [-100, 0, 0], elbow_r: [-100, 0, 0] }),
];
/** dance: loops seed-ordered moves on the beat (params.bpm), knees bob on every beat, cross-fades between moves */
const dance: Def = {
  holds: false, blendIn: 0.2, defaultDuration: 3.0,
  pose: (c) => {
    const bpm = num(c, 'bpm', 116), beat = (c.lt * bpm) / 60;
    const down = (1 + Math.cos(2 * Math.PI * beat)) / 2; // 1 on the beat
    const env = loopEnvelope(c.lt, c.d, 0.2, 0.25);
    const start = Math.floor(seedPhase(c.seed, 11) * MOVES.length);
    const bar = Math.floor(beat / 4), inBar = beat - bar * 4;
    const cur = MOVES[(start + bar) % MOVES.length](beat, down), next = MOVES[(start + bar + 1) % MOVES.length](beat, down);
    const upper = mix(cur, next, ramp(inBar, 3.6, 4));
    const legs: JointPose = { hip_l: [-14 * down, 0, 5], knee_l: [26 * down, 0, 0], hip_r: [-14 * down, 0, -5], knee_r: [26 * down, 0, 0] };
    return { joints: mix(IDLE_POSE, { ...IDLE_POSE, ...upper, ...legs }, env), scale: squashStretch(1 - 0.05 * env * down ** 4), still: true };
  },
};

// ---------------------------------------------------------------- cry / scream

/** one sob per cycle: quick (but not instant) heave, slow exponential release */
const sobShape = (x: number): number => (x < 0.1 ? ss(x / 0.1) : Math.exp(-6 * (x - 0.1)));
/** cry: hands to the eyes, shoulders heave on sobs, periodic wail with the head thrown back */
const cry: Def = {
  holds: false, blendIn: 0.25, defaultDuration: 2.4,
  pose: (c) => {
    const env = loopEnvelope(c.lt, c.d, 0.35, 0.3), ph = seedPhase(c.seed, 3);
    const sob = sobShape(frac(c.lt * 1.7 + ph)) * env;
    const wail = window(frac(c.lt / 2.4 + ph), 0.55, 0.85, 0.08) * env;
    const sx = 12 + 7 * sob - 20 * wail, nx = 18 - 38 * wail;
    const hands = env * (1 - 0.7 * wail);
    return {
      joints: { ...IDLE_POSE, spine: [sx, 0, 0], neck: [nx, 0, 0], hip_l: [-6, 0, 3], knee_l: [10, 0, 0], hip_r: [-6, 0, -3], knee_r: [10, 0, 0], shoulder_l: [-40, 0, 18 + 30 * wail], shoulder_r: [-40, 0, -18 - 30 * wail], elbow_l: [-110, 0, 0], elbow_r: [-110, 0, 0] },
      ik: [
        { arm: 'l', target: eyePoint(c, sx, nx, 0.09), weight: hands, pole: [-1, -0.6, -0.2], local: true },
        { arm: 'r', target: eyePoint(c, sx, nx, -0.09), weight: hands, pole: [-1, -0.6, -0.2], local: true },
      ],
      tremble: 1.1 * env + 1.5 * sob, still: true, lift: 0.015 * sob,
    };
  },
  face: (c) => {
    const ph = seedPhase(c.seed, 3), wail = window(frac(c.lt / 2.4 + ph), 0.55, 0.85, 0.08) * loopEnvelope(c.lt, c.d, 0.35, 0.3);
    return { expression: 'crying', mouth: wail > 0.1 ? { shape: 'round', open: 0.9 * wail } : { shape: 'small', open: 0.2 } };
  },
};

/** scream: inhale (rise, stretch), lean back with arms flung out and a trembling stretch, release */
const scream: Def = {
  holds: false, blendIn: 0.08, defaultDuration: 1.4,
  pose: (c) => {
    const u = c.u, inhale = window(u, 0.02, 0.18, 0.08) * (1 - ramp(u, 0.18, 0.24));
    const s = u < 0.18 ? 0 : acting(clampU((u - 0.18) / 0.55), ACTING.broad) * (1 - ramp(u, 0.85, 1));
    const vib = s > 0.5 ? Math.sin(c.lt * 2 * Math.PI * 9) : 0;
    return {
      joints: {
        spine: [6 * inhale - 16 * s, 0, 0], neck: [-6 * inhale - 20 * s, 0, 0],
        shoulder_l: [-20 * inhale - 40 * s, 0, 6 + 10 * inhale + 74 * s], shoulder_r: [-20 * inhale - 40 * s, 0, -6 - 10 * inhale - 74 * s],
        elbow_l: [-8 - 40 * inhale + 20 * s, 0, 0], elbow_r: [-8 - 40 * inhale + 20 * s, 0, 0],
        hip_l: [-4 * s, 0, 1.5 + 10 * s], knee_l: [2 + 6 * s, 0, 0], hip_r: [-4 * s, 0, -1.5 - 10 * s], knee_r: [2 + 6 * s, 0, 0],
      },
      lift: 0.03 * inhale, scale: squashStretch(1 + 0.04 * inhale + 0.07 * s + 0.012 * vib * s), tremble: 2.6 * Math.max(0, Math.min(1, s)), still: true,
    };
  },
  face: (c) => {
    const u = c.u;
    if (u < 0.18) return { mouth: { shape: 'round', open: 0.4 * window(u, 0.04, 0.16, 0.04) } };
    const s = clampU((u - 0.18) / 0.08) * (1 - ramp(u, 0.85, 0.97));
    return { expression: 'scream', mouth: { shape: s > 0.35 ? 'wide' : 'open', open: s } };
  },
};

// ---------------------------------------------------------------- tug / push

/** tug: both hands grip the target, lean back and heave in pulls (the last one a big yank), feet braced */
const tug: Def = {
  holds: false, blendIn: 0.15, defaultDuration: 2.0, needs: ['target'], targetRole: 'contact', contactU: 0.18,
  pose: (c) => {
    const pulls = Math.max(1, Math.round(num(c, 'pulls', 3)));
    const grip = ramp(c.u, 0.05, 0.18) * (1 - ramp(c.u, 0.9, 1));
    const p = clampU((c.u - 0.18) / 0.72) * pulls, k = Math.min(pulls - 1, Math.floor(p)), x = p - k;
    const last = k === pulls - 1 ? 1.5 : 1;
    const heave = (c.u < 0.18 || c.u > 0.9 ? 0 : Math.sin(Math.PI * x) ** 2) * last;
    const tg = c.target;
    return {
      joints: {
        ...IDLE_POSE, spine: [-6 - 16 * heave * grip, 0, 0], neck: [10 + 6 * heave, 0, 0],
        hip_l: [-30 * grip, 0, 6], knee_l: [26 * grip + 10 * heave, 0, 0], hip_r: [8 * grip, 0, -6], knee_r: [14 * grip + 12 * heave, 0, 0],
        shoulder_l: [-70, 0, 10], shoulder_r: [-70, 0, -10], elbow_l: [-20, 0, 0], elbow_r: [-20, 0, 0],
      },
      ik: tg ? [
        { arm: 'l', target: sideways(c, tg, 0.06), weight: grip, pole: [-0.6, -0.8, -0.3] },
        { arm: 'r', target: sideways(c, tg, -0.06), weight: grip, pole: [-0.6, -0.8, -0.3] },
      ] : [],
      tremble: 1.6 * heave * grip, still: true, lookAt: tg, lookWeight: 0.6 * grip,
    };
  },
};

/** push: wind back, shove with both arms (lunge, overshoot forward), recover */
const push: Def = {
  holds: false, blendIn: 0.12, defaultDuration: 1.1, needs: ['target'], targetRole: 'contact', contactU: 0.42,
  pose: (c) => {
    const u = c.u, back = window(u, 0.05, 0.28, 0.12) * (1 - ramp(u, 0.28, 0.36));
    const shove = u < 0.28 ? 0 : acting(clampU((u - 0.28) / 0.72), { anticipation: 0, antAt: 0.01, strikeAt: 0.2, overshoot: 0.25, wobble: 1 }) * (1 - ramp(u, 0.7, 1));
    const reach = ramp(u, 0.3, 0.42) * (1 - ramp(u, 0.55, 0.72));
    const tg = c.target;
    return {
      joints: {
        ...IDLE_POSE, spine: [-10 * back + 24 * shove, 0, 0], neck: [4 * back - 10 * shove, 0, 0],
        shoulder_l: [-40 * back - 80 * shove, 0, 12], shoulder_r: [-40 * back - 80 * shove, 0, -12], elbow_l: [-110 * back - 10 * shove, 0, 0], elbow_r: [-110 * back - 10 * shove, 0, 0],
        hip_l: [-34 * shove, 0, 4], knee_l: [8 * back + 34 * shove, 0, 0], hip_r: [16 * shove, 0, -4], knee_r: [6 * back + 8 * shove, 0, 0],
      },
      ik: tg ? [
        { arm: 'l', target: sideways(c, tg, 0.14), weight: reach, pole: [-0.4, -1, -0.2] },
        { arm: 'r', target: sideways(c, tg, -0.14), weight: reach, pole: [-0.4, -1, -0.2] },
      ] : [],
      lookAt: tg, lookWeight: 0.7,
    };
  },
};

// ---------------------------------------------------------------- sleep / flattened

/** sleep: standing, nods off (head droops, jerks awake with an overshoot, droops again); params.lying: on the back */
const sleep: Def = {
  holds: true, blendIn: 0.3, defaultDuration: 3.0,
  pose: (c) => {
    const breath = Math.sin((c.lt * 2 * Math.PI) / 3.2);
    if (flag(c, 'lying')) {
      const x = clampU(c.lt / 0.9);
      return {
        joints: { spine: [-2 + 1.5 * breath, 0, 0], neck: [K(x, [[0, 0], [0.5, 20], [1, 6]]), 0, 0], shoulder_l: [-6, 0, 14], shoulder_r: [-6, 0, -14], elbow_l: [-10, 0, 0], elbow_r: [-10, 0, 0], hip_l: [0, 0, 4], hip_r: [0, 0, -4], knee_l: [4, 0, 0], knee_r: [4, 0, 0] },
        pitch: -90 * ss(x), ground: x > 0.3 ? 'all' : 'feet', still: true, lift: 0.1 * Math.sin(Math.PI * x),
      };
    }
    const nod = nodAt(c);
    return {
      joints: { ...IDLE_POSE, spine: [6 + 6 * nod + 1.5 * breath, 0, 0], neck: [48 * nod - 8 * jerkAt(c), 0, 8 * nod], shoulder_l: [2, 0, 4], shoulder_r: [2, 0, -4], elbow_l: [-4, 0, 0], elbow_r: [-4, 0, 0], knee_l: [8, 0, 0], knee_r: [8, 0, 0], hip_l: [-4, 0, 1.5], hip_r: [-4, 0, -1.5] },
      still: true, lift: 0.01 * jerkAt(c),
    };
  },
  face: (c) => {
    const awake = flag(c, 'lying') ? 0 : jerkAt(c);
    const snore = 0.5 + 0.5 * Math.sin((c.lt * 2 * Math.PI) / 3.2);
    return { eyesClosed: ramp(c.lt, 0.2, 0.6) * (1 - awake), mouth: awake > 0.3 ? { shape: 'round', open: 0.3 * awake } : { shape: snore > 0.6 ? 'small' : 'closed', open: 0.2 * snore } };
  },
};
/** nodding-off cycle (period 2.8 s): head droops slowly, snaps up at the start of each cycle */
const NOD = 2.8;
function nodAt(c: ActionCtx): number {
  const ph = frac(c.lt / NOD + seedPhase(c.seed, 5) * 0.2);
  return ramp(c.lt, 0.1, 1.2) * (ph < 0.12 ? K(ph / 0.12, [[0, 1], [0.35, -0.12], [1, 0.05]]) : 0.05 + 0.95 * ss((ph - 0.12) / 0.8));
}
/** 1 right after the snap awake (eyes pop open), 0 otherwise */
function jerkAt(c: ActionCtx): number {
  if (c.lt < 1.2) return 0;
  const ph = frac(c.lt / NOD + seedPhase(c.seed, 5) * 0.2);
  return window(ph, 0.02, 0.14, 0.04);
}

/** flattened: splat onto the back as a pancake (impact squash with a wobble), limbs splayed, a foot twitches; holds */
const flattened: Def = {
  holds: true, blendIn: 0.04, defaultDuration: 2.0, contactU: 0,
  pose: (c) => {
    const x = clampU(c.lt / 0.14), w = clampU(c.lt / 0.6);
    const thick = 0.3 + settle(w, -0.12, 3) * (w > 0 ? 1 : 0);
    const twitch = window(frac(c.lt / 1.7 + seedPhase(c.seed, 9)), 0.1, 0.16, 0.03) * ramp(c.lt, 0.6, 0.8);
    const sc: Vec3 = [1 + 0.28 * x, 1 + 0.06 * x, 1 - (1 - thick) * x];
    return {
      joints: { spine: [0, 0, 0], neck: [0, 0, 0], shoulder_l: [-10, 0, 10 + 60 * x], shoulder_r: [-10, 0, -10 - 60 * x], elbow_l: [-6, 0, 0], elbow_r: [-6, 0, 0], hip_l: [0, 0, 4 + 16 * x], hip_r: [0, 0, -4 - 16 * x], knee_l: [2 + 20 * twitch, 0, 0], knee_r: [2, 0, 0] },
      pitch: -90 * x, ground: c.lt > 0.04 ? 'all' : 'feet', scale: sc, still: true,
    };
  },
  face: (c) => ({ expression: 'shock', mouth: { shape: 'small', open: 0.25 * ramp(c.lt, 0.3, 0.6) } }),
};

// ---------------------------------------------------------------- look_around / shrug / wave / clap

/** look_around: hunched, nervous scan left and right with holds, then a snap double-take */
const look_around: Def = {
  holds: false, blendIn: 0.15, defaultDuration: 1.8,
  pose: (c) => {
    const s = seedPhase(c.seed, 7) < 0.5 ? 1 : -1, u = c.u;
    const yaw = s * K(u, [[0, 0], [0.12, 58], [0.3, 52], [0.42, -60], [0.6, -55], [0.66, 20], [0.7, 64], [0.8, 58], [0.92, 0], [1, 0]]);
    const hunch = window(u, 0.06, 0.9, 0.08);
    return {
      joints: { ...IDLE_POSE, spine: [10 * hunch, yaw * 0.3, 0], neck: [4 * hunch, yaw * 0.7, 0], shoulder_l: [-10 * hunch, 0, 4], shoulder_r: [-10 * hunch, 0, -4], elbow_l: [-40 * hunch, 0, 0], elbow_r: [-40 * hunch, 0, 0], hip_l: [-10 * hunch, 0, 2], knee_l: [16 * hunch, 0, 0], hip_r: [-10 * hunch, 0, -2], knee_r: [16 * hunch, 0, 0] },
      tremble: 0.5 * hunch,
    };
  },
};

/** shrug: dip, pop shoulders up with palms out and head tilt (overshoot), hold, drop */
const shrug: Def = {
  holds: false, blendIn: 0.1, defaultDuration: 1.0,
  pose: (c) => {
    const u = c.u, s = u < 0.7 ? acting(u / 0.7, ACTING.light) : 1 - ss((u - 0.7) / 0.3);
    return {
      joints: {
        ...IDLE_POSE, spine: [-3 * s, 0, 0], neck: [-4 * s, 0, 12 * s],
        shoulder_l: [-24 * s, 0, 6 + 36 * s], shoulder_r: [-24 * s, 0, -6 - 36 * s], elbow_l: [-8 - 84 * s, 0, 0], elbow_r: [-8 - 84 * s, 0, 0],
      },
      lift: 0.02 * Math.max(0, s), scale: squashStretch(1 + 0.03 * s),
    };
  },
};

const WAVE_POP = { anticipation: 0.08, antAt: 0.25, strikeAt: 0.6, overshoot: 0.1, wobble: 2 };
/** wave: arm pops up (overshoot), big side-to-side wave with body sway, lowers */
const wave: Def = {
  holds: false, blendIn: 0.1, defaultDuration: 1.4,
  pose: (c) => {
    // the arm pops up over the first 0.5 s (seconds, so a long wave does not slow the pop down)
    const u = c.u, up = c.lt < 0.5 ? strike(c.lt / 0.5, 0, 1, WAVE_POP) : 1 - ss((u - 0.85) / 0.15);
    const w = Math.sin(c.lt * 2 * Math.PI * 2.6) * window(u, 0.2, 0.85, 0.05);
    return {
      joints: { ...IDLE_POSE, spine: [0, 0, 5 * w], neck: [0, 0, -4 * w], shoulder_r: [-20 * up, 0, -6 - 144 * up + 18 * w], elbow_r: [-8 - 34 * up - 18 * w, 0, 0], shoulder_l: [0, 0, 8], elbow_l: [-10, 0, 0] },
      lookAt: c.target, lookWeight: 0.8,
    };
  },
};

/** clap: hands meet in front of the chest on a rhythm (params.rate Hz), small forward bob on every clap */
const clap: Def = {
  holds: false, blendIn: 0.12, defaultDuration: 1.6,
  pose: (c) => {
    const rate = num(c, 'rate', 3.2), env = loopEnvelope(c.lt, c.d, 0.2, 0.2);
    const p = frac(c.lt * rate), hit = (1 + Math.cos(2 * Math.PI * p)) / 2; // 1 at contact
    const sep = 0.07 + 0.2 * (1 - hit), sx = 4 + 4 * hit ** 6;
    return {
      joints: { ...IDLE_POSE, spine: [sx, 0, 0], shoulder_l: [-60, 0, 20], shoulder_r: [-60, 0, -20], elbow_l: [-80, 0, 0], elbow_r: [-80, 0, 0] },
      ik: [
        { arm: 'l', target: chestPoint(c, sx, sep, 0.3), weight: env, pole: [-1, -0.5, -0.2], local: true },
        { arm: 'r', target: chestPoint(c, sx, -sep, 0.3), weight: env, pole: [-1, -0.5, -0.2], local: true },
      ],
    };
  },
};

// ---------------------------------------------------------------- sneak

/** sneak: crouched cartoon tiptoe gait (high knees on the swing, paws up at the chest, body leaning in) */
const sneak: Def = {
  holds: false, blendIn: 0.2, defaultDuration: 2.4, locomotion: true,
  pose: (c) => {
    const g = locomotion(c);
    const j = { ...g.joints };
    const crouch = 1;
    for (const side of ['l', 'r'] as const) {
      const kn = j[`knee_${side}`] ?? [0, 0, 0], hp = j[`hip_${side}`] ?? [0, 0, 0];
      const swing = Math.max(0, kn[0] - 3); // gait knee flex beyond stance = swing
      j[`knee_${side}`] = [kn[0] + 22 * crouch + 0.5 * swing, kn[1], kn[2]];
      j[`hip_${side}`] = [hp[0] - 11 * crouch - 0.35 * swing, hp[1], hp[2]];
    }
    const sway = Math.sin(c.lt * 2 * Math.PI * 1.6);
    return {
      ...g,
      joints: plus(j, { spine: [18, 0, 3 * sway], neck: [-14, 0, 0], shoulder_l: [-58 - (j.shoulder_l?.[0] ?? 0) * 0.8, 0, 2], shoulder_r: [-58 - (j.shoulder_r?.[0] ?? 0) * 0.8, 0, -2], elbow_l: [-96 - (j.elbow_l?.[0] ?? 0), 0, 0], elbow_r: [-96 - (j.elbow_r?.[0] ?? 0), 0, 0] }),
      still: true,
    };
  },
};

export const BODY_ACTIONS: Record<string, Def> = { sit, stand_up, celebrate, dance, cry, scream, tug, push, sleep, flattened, look_around, shrug, wave, clap, sneak };
