// Semantic action library. Each action is an authored keyframe clip (data tables in degrees)
// combined with procedural layers (locomotion phase, IK contact, look-at, tremble).
import type { ActionName } from '../../../schema/src/episode.ts';
import { noise1, type Vec3 } from '../math.ts';
import { K, KV, type ActionPose, type JointPose } from './pose.ts';

export interface ActionCtx {
  /** local time since action start (s) */
  lt: number;
  /** action duration (s) */
  d: number;
  /** normalized progress 0..1 */
  u: number;
  /** absolute time */
  t: number;
  seed: number;
  target?: Vec3; // resolved world target (prop anchor, actor head, mark)
  params: Record<string, number | string | boolean>;
  /** locomotion state supplied by the track compiler */
  loco?: { dist: number; speed: number; run: boolean; legLen: number; total: number; /** gait phase at dist 0 (default 0.25 = left mid-stance) */ phase0?: number; /** whole stances over total (default: rounded from total) */ stances?: number };
}

export interface ActionDef {
  /** true: final pose persists after the action ends until another action starts */
  holds: boolean;
  blendIn: number;
  /** additive layer (neck/head only) that plays on top of the current body action */
  layer?: boolean;
  /** normalized contact time (for sync of SFX/VFX, IK validation), if any */
  contactU?: number;
  pose(c: ActionCtx): ActionPose;
}

const idleArms: JointPose = { shoulder_l: [0, 0, 6], shoulder_r: [0, 0, -6], elbow_l: [-8, 0, 0], elbow_r: [-8, 0, 0] };
export const IDLE_POSE: JointPose = { ...idleArms, hips: [0, 0, 0], spine: [0, 0, 0], neck: [0, 0, 0], hip_l: [0, 0, 1.5], hip_r: [0, 0, -1.5], knee_l: [2, 0, 0], knee_r: [2, 0, 0] };

/** Idle breathing/weight shift — additive, deterministic, always on unless pose.still. */
export function idleLayer(t: number, seed: number, amount = 1): JointPose {
  const b = Math.sin(t * 2 * Math.PI / 3.1 + seed) * amount;
  const sway = noise1(t * 0.35, seed) * amount;
  return {
    spine: [1.2 * b, 1.5 * sway, 0.8 * sway], neck: [-0.8 * b, 2.5 * noise1(t * 0.5, seed + 3) * amount, 0],
    shoulder_l: [0, 0, 1.2 * b], shoulder_r: [0, 0, -1.2 * b],
  };
}

/**
 * Locomotion with analytic foot planting: during stance the foot's position relative to the hip
 * moves exactly opposite to root travel, so the planted foot does not slide.
 */
function locomotion(c: ActionCtx): ActionPose {
  const L = c.loco?.legLen ?? 0.8;
  const run = !!c.loco?.run;
  const total = c.loco?.total ?? 0;
  let S = run ? 0.62 : 0.4; // foot travel per stance (m)
  // stride fitting: arrive at mid-stance (feet under the body) so the stop needs no foot correction
  // start and finish at mid-stance (planted foot under the hip): whole number of stances over the path
  if (total > 0.05) { const n = c.loco?.stances ?? Math.max(1, Math.round(total / S)); S = total / n; }
  const dist = c.loco?.dist ?? 0;
  const speed = c.loco?.speed ?? 0;
  // phase is driven purely by distance travelled; when speed -> 0 the legs freeze in place (no snap)
  const moving = total > 0.05 ? 1 : 0; // legs: distance-driven, never faded (feet stay planted)
  const amp = Math.min(1, speed / (run ? 1.2 : 0.7)); // upper body: settles as the character decelerates
  const cyc = (c.loco?.phase0 ?? 0.25) + dist / (2 * S);
  const leg = (p: number): { hip: number; knee: number } => {
    const f = p - Math.floor(p);
    let z: number, knee: number;
    if (f < 0.5) { z = S / 2 - S * (f / 0.5); knee = 4; }
    else { const s = (f - 0.5) / 0.5; const e = -4 * s * s * s + 6 * s * s - s; /* Hermite: lift-off and touch-down at world velocity 0 */ z = -S / 2 + S * e; knee = Math.pow(Math.sin(Math.PI * s), 0.55) * (run ? 105 : 78); }
    const hip = (Math.asin(Math.max(-0.95, Math.min(0.95, -z / L))) * 180) / Math.PI - (f >= 0.5 ? Math.sin(Math.PI * ((f - 0.5) / 0.5)) * (run ? 32 : 22) : 0);
    return { hip: hip * moving, knee: knee * moving + 3 };
  };
  const l = leg(cyc), r = leg(cyc + 0.5);
  const armAmp = run ? 55 : 28;
  const armL = -Math.sin(2 * Math.PI * (cyc + 0.5)) * armAmp * amp, armR = -Math.sin(2 * Math.PI * cyc) * armAmp * amp;
  const lean = (run ? 14 : 4) * amp;
  // flight phase around foot exchange, grounded at mid-stance
  const bounce = run ? Math.cos(2 * Math.PI * cyc) ** 2 * 0.045 * moving : 0;
  return {
    joints: {
      hips: [0, 0, 0],
      spine: [lean, -10 * Math.sin(2 * Math.PI * cyc) * amp, 0], neck: [-lean * 0.6, 6 * Math.sin(2 * Math.PI * cyc) * amp, 0],
      hip_l: [l.hip, 0, 1.5], knee_l: [l.knee, 0, 0], hip_r: [r.hip, 0, -1.5], knee_r: [r.knee, 0, 0],
      shoulder_l: [armL, 0, 8], shoulder_r: [armR, 0, -8],
      elbow_l: [run ? -85 * amp - 18 * (1 - amp) : -18 - Math.max(0, -armL) * 0.4, 0, 0], elbow_r: [run ? -85 * amp - 18 * (1 - amp) : -18 - Math.max(0, -armR) * 0.4, 0, 0],
    },
    lift: bounce, still: moving > 0.5,
    stance: moving > 0.05 ? (cyc - Math.floor(cyc) < 0.5 ? 'l' : 'r') : undefined,
  };
}

const D: Partial<Record<ActionName, ActionDef>> = {};

D.idle = { holds: false, blendIn: 0.25, pose: () => ({ joints: IDLE_POSE }) };

D.walk = { holds: false, blendIn: 0.18, pose: locomotion };
D.run = { holds: false, blendIn: 0.14, pose: locomotion };
D.chase = { holds: false, blendIn: 0.14, pose: locomotion };
D.enter_frame = { holds: false, blendIn: 0.1, pose: locomotion };
D.exit_frame = { holds: false, blendIn: 0.14, pose: locomotion };

D.turn_toward = { holds: false, blendIn: 0.15, pose: (c) => ({ joints: { ...IDLE_POSE, spine: [0, K(c.u, [[0, -8], [0.5, 4], [1, 0]]), 0] }, lookAt: c.target, lookWeight: 1 }) };
D.look_at = { holds: true, blendIn: 0.2, pose: (c) => ({ joints: IDLE_POSE, lookAt: c.target, lookWeight: 1 }) };

D.curious_lean = {
  holds: true, blendIn: 0.3,
  pose: (c) => {
    const u = Math.min(1, c.lt / 0.5);
    return {
      joints: {
        ...IDLE_POSE,
        spine: [K(u, [[0, 0], [1, 12]]), 0, K(u, [[0, 0], [1, -6]])],
        neck: [K(u, [[0, 0], [1, 6]]), 0, K(u, [[0, 0], [1, -14]])],
        shoulder_r: [K(u, [[0, 0], [1, -62]]), K(u, [[0, 0], [1, 26]]), -10], elbow_r: [K(u, [[0, -8], [1, -120]]), 0, 0],
        shoulder_l: [0, 0, 8], elbow_l: [-10, 0, 0],
        hip_l: [-4, 0, 3], knee_l: [8, 0, 0],
      },
      lookAt: c.target, lookWeight: 0.6,
    };
  },
};

D.point = {
  holds: false, blendIn: 0.15,
  pose: (c) => ({
    joints: { ...IDLE_POSE, shoulder_r: [K(c.u, [[0, 0], [0.2, -85], [0.85, -85], [1, 0]]), 0, K(c.u, [[0, -6], [0.2, 12], [1, -6]])], elbow_r: [K(c.u, [[0, -8], [0.2, -5], [1, -8]]), 0, 0], spine: [4, 0, 0] },
    lookAt: c.target, lookWeight: 0.8,
  }),
};

// press_button: reach (IK), contact at u = 0.42, hold, withdraw. Right hand (Zapp's wristband hand).
D.press_button = {
  holds: false, blendIn: 0.12, contactU: 0.42,
  pose: (c) => {
    const tg = c.target ?? [0, 1, 0];
    const hover: Vec3 = [tg[0], tg[1] + 0.12, tg[2]];
    const u = c.u;
    const down = K(u, [[0.3, 0.12], [0.42, 0.0], [0.62, 0.0], [0.8, 0.14]]);
    const w = K(u, [[0, 0], [0.28, 1], [0.78, 1], [1, 0]]);
    const tgt: Vec3 = [hover[0], tg[1] + down, hover[2]];
    return {
      joints: {
        ...IDLE_POSE,
        spine: [K(u, [[0, 0], [0.3, 16], [0.62, 18], [1, 2]]), K(u, [[0, 0], [0.3, -10], [1, 0]]), 0],
        neck: [K(u, [[0, 0], [0.3, 14], [1, 0]]), 0, 0],
        shoulder_l: [K(u, [[0, 0], [0.4, 20], [1, 0]]), 0, 14], elbow_l: [-30, 0, 0],
        hip_l: [-6, 0, 2], knee_l: [10, 0, 0], hip_r: [4, 0, -2],
        shoulder_r: [-40, 0, -8], elbow_r: [-40, 0, 0],
      },
      ik: [{ arm: 'r', target: tgt, weight: w, pole: [-0.6, -0.4, -1] }],
      lookAt: tg, lookWeight: 1,
    };
  },
};

D.shock_recoil = {
  holds: true, blendIn: 0.06,
  pose: (c) => {
    const u = Math.min(1, c.lt / 0.35);
    const settle = Math.min(1, Math.max(0, (c.lt - 0.35) / 0.4));
    return {
      joints: {
        spine: [K(u, [[0, 0], [0.4, -18], [1, -10]]) + settle * 2, 0, 0], neck: [K(u, [[0, 0], [0.4, -16], [1, -6]]), 0, 0],
        shoulder_l: [K(u, [[0, 0], [0.5, -70], [1, -55]]), 0, K(u, [[0, 6], [0.5, 60], [1, 48]])],
        shoulder_r: [K(u, [[0, 0], [0.5, -70], [1, -55]]), 0, K(u, [[0, -6], [0.5, -60], [1, -48]])],
        elbow_l: [K(u, [[0, -8], [0.5, -80], [1, -95]]), 0, 0], elbow_r: [K(u, [[0, -8], [0.5, -80], [1, -95]]), 0, 0],
        hip_l: [K(u, [[0, 0], [0.4, -20], [1, -6]]), 0, 6], knee_l: [K(u, [[0, 0], [0.4, 30], [1, 10]]), 0, 0],
        hip_r: [K(u, [[0, 0], [0.4, 8], [1, 2]]), 0, -6], knee_r: [K(u, [[0, 0], [0.4, 12], [1, 6]]), 0, 0],
      },
      lift: K(u, [[0, 0], [0.35, 0.1], [0.7, 0]]),
      tremble: 1.6 * settle, still: true, lookAt: c.target, lookWeight: 0.7,
    };
  },
};

D.cower = {
  holds: true, blendIn: 0.12,
  pose: (c) => {
    const u = Math.min(1, c.lt / 0.3);
    return {
      joints: {
        spine: [K(u, [[0, 0], [1, 28]]), 0, 0], neck: [K(u, [[0, 0], [1, 10]]), 0, 0],
        shoulder_l: [K(u, [[0, 0], [1, -150]]), 0, K(u, [[0, 6], [1, 30]])], elbow_l: [K(u, [[0, -8], [1, -95]]), 0, 0],
        shoulder_r: [K(u, [[0, 0], [1, -150]]), 0, K(u, [[0, -6], [1, -30]])], elbow_r: [K(u, [[0, -8], [1, -95]]), 0, 0],
        hip_l: [K(u, [[0, 0], [1, -62]]), 0, 10], knee_l: [K(u, [[0, 0], [1, 105]]), 0, 0],
        hip_r: [K(u, [[0, 0], [1, -62]]), 0, -10], knee_r: [K(u, [[0, 0], [1, 105]]), 0, 0],
      },
      tremble: 2.4 * u, still: true,
    };
  },
};

D.victory_pose = {
  holds: false, blendIn: 0.1,
  pose: (c) => {
    const u = c.u;
    const pump = c.lt > 0.55 ? Math.sin((c.lt - 0.55) * 2 * Math.PI * 3) : 0;
    return {
      joints: {
        spine: [K(u, [[0, 0], [0.15, 10], [0.35, -10], [0.9, -6], [1, 0]]), 0, 0], neck: [K(u, [[0, 0], [0.35, -12], [1, 0]]), 0, 0],
        shoulder_l: [K(u, [[0, 0], [0.15, 10], [0.35, -20], [0.9, -20], [1, 0]]), 0, K(u, [[0, 6], [0.15, 30], [0.35, 150], [0.9, 150], [1, 6]])],
        shoulder_r: [K(u, [[0, 0], [0.15, 10], [0.35, -20], [0.9, -20], [1, 0]]) + pump * 10, 0, K(u, [[0, -6], [0.15, -30], [0.35, -150], [0.9, -150], [1, -6]])],
        elbow_l: [K(u, [[0, -8], [0.35, -25], [1, -8]]), 0, 0], elbow_r: [K(u, [[0, -8], [0.35, -25], [1, -8]]) - Math.abs(pump) * 25, 0, 0],
        hip_l: [K(u, [[0, 0], [0.15, -38], [0.3, 0]]), 0, 4], knee_l: [K(u, [[0, 0], [0.15, 70], [0.3, 6]]), 0, 0],
        hip_r: [K(u, [[0, 0], [0.15, -38], [0.3, -10], [0.45, 0]]), 0, -4], knee_r: [K(u, [[0, 0], [0.15, 70], [0.3, 30], [0.45, 4]]), 0, 0],
      },
      lift: K(u, [[0, 0], [0.15, 0], [0.3, 0.28], [0.45, 0], [1, 0]]),
    };
  },
};

D.laugh = {
  holds: true, blendIn: 0.15,
  pose: (c) => {
    const bob = Math.abs(Math.sin(c.lt * Math.PI * 5.2));
    return {
      joints: {
        spine: [8 + bob * 10, 0, 4], neck: [-22 + bob * 8, 0, -6],
        shoulder_l: [-38, 0, 30], elbow_l: [-100, 0, 0],
        shoulder_r: [-45 + bob * 8, -30, -20], elbow_r: [-95, 0, 0],
        hip_l: [-10, 0, 4], knee_l: [16 + bob * 4, 0, 0], hip_r: [-4, 0, -4], knee_r: [8 + bob * 4, 0, 0],
      },
      still: true,
    };
  },
};

D.facepalm = {
  holds: true, blendIn: 0.15, contactU: 0.35,
  pose: (c) => ({
    joints: { ...IDLE_POSE, spine: [K(c.u, [[0, 0], [0.35, 10], [1, 12]]), 0, 0], neck: [K(c.u, [[0, 0], [0.35, 22], [1, 26]]), 0, 0], shoulder_r: [-110, 25, 0], elbow_r: [-120, 0, 0] },
    ik: c.target ? [{ arm: 'r', target: c.target, weight: K(c.u, [[0, 0], [0.35, 1], [1, 1]]) }] : [],
  }),
};

D.regret_freeze = {
  holds: true, blendIn: 0.1,
  pose: (c) => ({
    joints: { ...IDLE_POSE, spine: [-2, 0, 0], neck: [K(Math.min(1, c.lt / 0.6), [[0, 0], [1, 8]]), 0, 0], shoulder_l: [0, 0, 16], shoulder_r: [0, 0, -16], elbow_l: [-4, 0, 0], elbow_r: [-4, 0, 0] },
    still: true,
  }),
};

D.arms_crossed = {
  holds: true, blendIn: 0.25,
  // Each hand tucks under the OPPOSITE upper arm; right forearm stacked above/in front of the left. Solved with IK
  // in actor-local space so it fits any locked body proportions. Elbows point out and slightly down.
  pose: (c) => {
    const chest = (c.loco?.legLen ?? 0.78) + 0.36;
    return {
      joints: { ...IDLE_POSE, spine: [-4, 0, 0], neck: [-4, 0, 6], hip_l: [0, 0, 5], hip_r: [0, 0, -3] },
      ik: [
        { arm: 'l', target: [-0.13, chest - 0.03, 0.215], weight: 1, pole: [-1, -0.35, -0.15], local: true },
        { arm: 'r', target: [0.13, chest + 0.035, 0.265], weight: 1, pole: [-1, -0.35, -0.15], local: true },
      ],
      lookAt: c.target, lookWeight: 0.8,
    };
  },
};

D.head_shake = {
  holds: false, blendIn: 0.05, layer: true,
  pose: (c) => ({ joints: { neck: [3 * Math.sin(Math.PI * c.u), Math.sin(c.u * Math.PI * 2 * 2.5) * 22 * Math.sin(Math.PI * Math.min(1, c.u * 1.2)), 0] } }),
};

D.angry_stomp = {
  holds: false, blendIn: 0.1,
  pose: (c) => {
    const s = c.lt * 3.2; const f = s - Math.floor(s); const leftUp = Math.floor(s) % 2 === 0;
    const lift = Math.sin(Math.PI * f);
    return {
      joints: {
        ...IDLE_POSE, spine: [10, 0, 0], neck: [-6, 0, 0],
        shoulder_l: [-20, 0, 24], elbow_l: [-80, 0, 0], shoulder_r: [-20, 0, -24], elbow_r: [-80, 0, 0],
        hip_l: [leftUp ? -55 * lift : 0, 0, 4], knee_l: [leftUp ? 80 * lift : 4, 0, 0],
        hip_r: [!leftUp ? -55 * lift : 0, 0, -4], knee_r: [!leftUp ? 80 * lift : 4, 0, 0],
      },
    };
  },
};

D.jump = {
  holds: false, blendIn: 0.1,
  pose: (c) => {
    const u = c.u; const h = Number(c.params.height ?? 0.45);
    const air = u > 0.25 && u < 0.8 ? Math.sin(Math.PI * ((u - 0.25) / 0.55)) : 0;
    const crouch = K(u, [[0, 0], [0.22, 1], [0.3, 0], [0.8, 0], [0.88, 0.8], [1, 0]]);
    return {
      joints: {
        ...IDLE_POSE, spine: [12 * crouch, 0, 0],
        hip_l: [-50 * crouch - 10 * air, 0, 3], knee_l: [90 * crouch + 25 * air, 0, 0],
        hip_r: [-50 * crouch - 10 * air, 0, -3], knee_r: [90 * crouch + 25 * air, 0, 0],
        shoulder_l: [30 * crouch - 140 * air, 0, 10 + 20 * air], shoulder_r: [30 * crouch - 140 * air, 0, -10 - 20 * air],
        elbow_l: [-20, 0, 0], elbow_r: [-20, 0, 0],
      },
      lift: air * h,
    };
  },
};

// fall: backward onto the back (supine). dive_prone handles forward falls.
D.fall = {
  holds: true, blendIn: 0.05,
  pose: (c) => {
    const u = Math.min(1, c.lt / 0.45);
    return {
      joints: {
        spine: [K(u, [[0, 0], [1, -6]]), 0, 0], neck: [K(u, [[0, 0], [0.6, 25], [1, 10]]), 0, 0],
        shoulder_l: [K(u, [[0, 0], [0.5, -110], [1, -20]]), 0, K(u, [[0, 6], [1, 70]])], shoulder_r: [K(u, [[0, 0], [0.5, -110], [1, -20]]), 0, K(u, [[0, -6], [1, -70]])],
        elbow_l: [-20, 0, 0], elbow_r: [-20, 0, 0],
        hip_l: [K(u, [[0, 0], [0.5, -50], [1, -12]]), 0, 6], knee_l: [K(u, [[0, 0], [0.5, 40], [1, 10]]), 0, 0],
        hip_r: [K(u, [[0, 0], [0.5, -30], [1, -6]]), 0, -6], knee_r: [K(u, [[0, 0], [0.5, 20], [1, 6]]), 0, 0],
      },
      pitch: -K(u, [[0, 0], [1, 90]]), ground: u > 0.3 ? 'all' : 'feet', still: true, lift: K(u, [[0, 0], [0.3, 0.12], [1, 0]]),
    };
  },
};

// dive_prone: last stretch of a flee — leap forward and land on the belly, head up (face stays readable).
D.dive_prone = {
  holds: true, blendIn: 0.08,
  pose: (c) => {
    const diveStart = Number(c.params.diveAt ?? 0.55);
    if (c.u < diveStart) return locomotion(c);
    const u = Math.min(1, (c.u - diveStart) / (1 - diveStart));
    return {
      joints: {
        spine: [K(u, [[0, 10], [1, -8]]), 0, 0], neck: [K(u, [[0, 0], [0.6, -70], [1, -78]]), 0, 0],
        shoulder_l: [K(u, [[0, -60], [0.5, -170], [1, -160]]), 0, K(u, [[0, 10], [1, 26]])], shoulder_r: [K(u, [[0, -60], [0.5, -170], [1, -160]]), 0, K(u, [[0, -10], [1, -26]])],
        elbow_l: [K(u, [[0, -40], [1, -30]]), 0, 0], elbow_r: [K(u, [[0, -40], [1, -30]]), 0, 0],
        hip_l: [K(u, [[0, -20], [0.5, 10], [1, 4]]), 0, 6], knee_l: [K(u, [[0, 30], [0.5, 10], [1, 20]]), 0, 0],
        hip_r: [K(u, [[0, 10], [0.5, 10], [1, 4]]), 0, -6], knee_r: [K(u, [[0, 20], [0.5, 10], [1, 30]]), 0, 0],
      },
      pitch: K(u, [[0, 15], [0.6, 88], [1, 90]]), ground: u > 0.35 ? 'all' : 'feet',
      lift: K(u, [[0, 0.1], [0.35, 0.35], [0.7, 0.05], [1, 0]]), still: true,
    };
  },
};

D.pick_up = {
  holds: false, blendIn: 0.15, contactU: 0.45,
  pose: (c) => ({
    joints: { ...IDLE_POSE, spine: [K(c.u, [[0, 0], [0.45, 35], [1, 4]]), 0, 0], hip_l: [K(c.u, [[0, 0], [0.45, -40], [1, 0]]), 0, 4], knee_l: [K(c.u, [[0, 0], [0.45, 60], [1, 4]]), 0, 0], hip_r: [K(c.u, [[0, 0], [0.45, -30], [1, 0]]), 0, -4], knee_r: [K(c.u, [[0, 0], [0.45, 50], [1, 4]]), 0, 0], shoulder_r: [-60, 0, -6], elbow_r: [-40, 0, 0] },
    ik: c.target ? [{ arm: 'r', target: c.target, weight: K(c.u, [[0, 0], [0.4, 1], [0.5, 1], [0.8, 0]]) }] : [],
    lookAt: c.target, lookWeight: 0.8,
  }),
};
D.hold = { holds: true, blendIn: 0.2, pose: () => ({ joints: { ...IDLE_POSE, shoulder_r: [-42, 0, -8], elbow_r: [-72, 0, 0] } }) };
D.put_down = {
  holds: false, blendIn: 0.15, contactU: 0.5,
  pose: (c) => ({
    joints: { ...IDLE_POSE, spine: [K(c.u, [[0, 0], [0.5, 25], [1, 0]]), 0, 0], shoulder_r: [K(c.u, [[0, -42], [0.5, -50], [1, 0]]), 0, -8], elbow_r: [K(c.u, [[0, -72], [0.5, -30], [1, -8]]), 0, 0], hip_l: [K(c.u, [[0, 0], [0.5, -20], [1, 0]]), 0, 4], knee_l: [K(c.u, [[0, 0], [0.5, 30], [1, 4]]), 0, 0] },
    ik: c.target ? [{ arm: 'r', target: c.target, weight: K(c.u, [[0, 0], [0.45, 1], [0.55, 1], [0.8, 0]]) }] : [],
  }),
};
D.throw = {
  holds: false, blendIn: 0.12, contactU: 0.55, // release
  pose: (c) => ({
    joints: {
      ...IDLE_POSE,
      spine: [K(c.u, [[0, 0], [0.4, -12], [0.6, 20], [1, 4]]), K(c.u, [[0, 0], [0.4, -30], [0.6, 20], [1, 0]]), 0],
      shoulder_r: [K(c.u, [[0, -42], [0.4, -170], [0.6, -80], [1, -10]]), 0, -10], elbow_r: [K(c.u, [[0, -72], [0.4, -90], [0.6, -5], [1, -10]]), 0, 0],
      shoulder_l: [K(c.u, [[0, 0], [0.4, -60], [0.6, 20], [1, 0]]), 0, 12],
      hip_l: [K(c.u, [[0, 0], [0.4, -30], [0.6, -10], [1, 0]]), 0, 4], knee_l: [K(c.u, [[0, 0], [0.4, 20], [1, 4]]), 0, 0],
    },
    lookAt: c.target, lookWeight: 0.6,
  }),
};
D.drink = {
  holds: false, blendIn: 0.15,
  pose: (c) => ({ joints: { ...IDLE_POSE, shoulder_r: [K(c.u, [[0, -42], [0.3, -100], [0.8, -100], [1, -42]]), 20, -10], elbow_r: [K(c.u, [[0, -72], [0.3, -120], [0.8, -120], [1, -72]]), 0, 0], neck: [K(c.u, [[0, 0], [0.35, -25], [0.8, -25], [1, 0]]), 0, 0] } }),
};
D.hover = { holds: true, blendIn: 0.1, pose: (c) => ({ joints: {}, lift: 0.08 * Math.sin(c.lt * 6) }) };

export const ACTION_DEFS = D as Record<ActionName, ActionDef>;

/**
 * Engine features some actions need before they are USABLE in stories (their poses exist either way and are exercised by
 * the action reel). Flip a feature to true only when it is implemented and tested; availability follows automatically.
 */
export const ENGINE_FEATURES = { handAttachment: false, floatingRig: false } as const;
export type EngineFeature = keyof typeof ENGINE_FEATURES;
const HAND = 'the held object must follow the hand; engine 1.0 has no prop-to-hand attachment, so the object would stay behind';
export const ACTION_REQUIREMENTS: Partial<Record<ActionName, { features: EngineFeature[]; reason: string }>> = {
  pick_up: { features: ['handAttachment'], reason: HAND },
  hold: { features: ['handAttachment'], reason: HAND },
  put_down: { features: ['handAttachment'], reason: HAND },
  throw: { features: ['handAttachment'], reason: `${HAND}; a thrown object also needs release + flight` },
  drink: { features: ['handAttachment'], reason: `${HAND}; no drinkable prop exists either` },
  hover: { features: ['floatingRig'], reason: 'only floating rigs can hover and none is built (BZTT is unbuilt)' },
};
/** features an action still needs (empty = available) */
export function unmetRequirements(action: ActionName, features: Record<EngineFeature, boolean> = ENGINE_FEATURES): EngineFeature[] {
  return (ACTION_REQUIREMENTS[action]?.features ?? []).filter((f) => !features[f]);
}
export const IMPLEMENTED_ACTIONS = Object.keys(D) as ActionName[];
