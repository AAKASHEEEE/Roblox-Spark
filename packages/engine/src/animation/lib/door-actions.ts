// Door interactions (S5): open_door, slam_door, and entering / leaving through a set door (SetDoor threshold + entry
// mark). The door itself is S4's prop: these actions only return its open fraction over time (LibActionDef.door),
// synchronised with the hand contact, for PropBuilder.applyState(door, 'open', u).
import { ACTION_DEFS, IDLE_POSE, type ActionCtx } from '../actions.ts';
/** the engine's distance-driven gait (analytic foot planting) */
const locomotion = (c: ActionCtx) => ACTION_DEFS.walk.pose(c);
import { ACTING, acting, landingSquash, overshootOut, seedPhase, squashStretch } from '../comedy.ts';
import { K, type ActionPose } from '../pose.ts';
import { easeInCubic } from '../../math.ts';
import { blendPose } from '../pose.ts';
import { ramp, window } from './util.ts';
import type { LibActionDef } from './types.ts';

type Def = Omit<LibActionDef, 'id' | 'version' | 'kind'>;
const clampU = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------------------------------------------------------------- door curves (open fraction; 0 = shut, 1 = open)

export const OPEN_CONTACT = 0.3;
/** open_door: shut until the hand grips, swings open with a comic overshoot past fully open, settles by u = 0.9 */
export function openDoorCurve(u: number): number {
  if (u <= OPEN_CONTACT + 0.02) return 0;
  return overshootOut(clampU((u - OPEN_CONTACT - 0.02) / 0.58), 0.18);
}
export const SLAM_START = 0.36, SLAM_IMPACT = 0.46;
/** slam_door: open until the shove, accelerates shut (ease-in), impact, rattles in the frame (never below 0), shut */
export function slamDoorCurve(u: number): number {
  if (u <= SLAM_START) return 1;
  if (u <= SLAM_IMPACT) return 1 - easeInCubic((u - SLAM_START) / (SLAM_IMPACT - SLAM_START));
  const x = clampU((u - SLAM_IMPACT) / 0.3);
  return 0.07 * (1 - x) ** 2 * Math.abs(Math.sin(Math.PI * 3 * x));
}

// ---------------------------------------------------------------- open / slam

/** open_door: reach for the handle, grip, pull (lean back as it swings), let go and peek through; hand follows the handle */
const open_door: Def = {
  holds: false, blendIn: 0.15, defaultDuration: 1.4, contactU: OPEN_CONTACT, needs: ['door', 'target'], targetRole: 'door_handle',
  pose: (c) => {
    const u = c.u, reach = ramp(u, 0.05, OPEN_CONTACT) * (1 - ramp(u, 0.6, 0.76));
    const pull = window(u, OPEN_CONTACT, 0.62, 0.1), peek = window(u, 0.7, 0.92, 0.08);
    return {
      joints: {
        ...IDLE_POSE, spine: [10 * reach - 12 * pull + 14 * peek, 0, -8 * peek], neck: [4 * reach - 6 * pull + 6 * peek, 20 * peek, 0],
        shoulder_r: [-60 * reach, 0, -8], elbow_r: [-30 * reach, 0, 0],
        hip_l: [-10 * reach + 8 * pull, 0, 3], knee_l: [8 * reach, 0, 0], hip_r: [-4 * pull, 0, -3], knee_r: [10 * pull, 0, 0],
      },
      ik: c.target ? [{ arm: 'r', target: c.target, weight: reach, pole: [-0.6, -0.6, -1] }] : [],
      lookAt: c.target, lookWeight: 0.8 * (1 - peek),
    };
  },
  door: (c) => openDoorCurve(c.u),
  props: (c) => ({ hand: 'r', grip: 'door_handle', attach: 0, state: { name: 'open', u: Math.min(1, openDoorCurve(c.u)) } }),
};

/** slam_door: big wind-up, shove the door shut (overshoot lunge), the impact jolts the body (squash + tremble), proud hold */
const slam_door: Def = {
  holds: true, blendIn: 0.12, defaultDuration: 1.3, contactU: SLAM_IMPACT, needs: ['door', 'target'], targetRole: 'door_handle',
  pose: (c) => {
    const u = c.u;
    const wind = ramp(u, 0.04, SLAM_START) * (1 - ramp(u, SLAM_START, SLAM_START + 0.06));
    const shove = u < SLAM_START - 0.02 ? 0 : acting(clampU((u - SLAM_START + 0.02) / 0.5), { anticipation: 0, antAt: 0.01, strikeAt: 0.22, overshoot: 0.3, wobble: 2 }) * (1 - ramp(u, 0.6, 0.82));
    const reach = ramp(u, SLAM_START - 0.04, SLAM_START + 0.04) * (1 - ramp(u, 0.5, 0.62));
    const jolt = landingSquash(clampU((u - SLAM_IMPACT) / 0.3), 0.12);
    const proud = ramp(u, 0.7, 0.9);
    return {
      joints: {
        ...IDLE_POSE,
        spine: [-12 * wind + 22 * shove - 6 * proud, -22 * wind + 18 * shove, 0], neck: [6 * wind - 8 * shove - 6 * proud, 0, 0],
        shoulder_r: [-30 * wind - 70 * shove, 0, -8 - 30 * wind], elbow_r: [-110 * wind - 10 * shove, 0, 0],
        shoulder_l: [20 * wind, 0, 10 + 6 * proud], elbow_l: [-20, 0, 0],
        hip_l: [-26 * shove, 0, 4], knee_l: [10 * wind + 24 * shove, 0, 0], hip_r: [12 * shove, 0, -4], knee_r: [8 * wind, 0, 0],
      },
      ik: c.target ? [{ arm: 'r', target: c.target, weight: reach, pole: [-0.5, -0.6, -1] }] : [],
      scale: squashStretch(jolt * (1 + 0.03 * proud)), tremble: 1.4 * window(u, SLAM_IMPACT, SLAM_IMPACT + 0.12, 0.05),
      lookAt: c.target, lookWeight: 0.8 * (1 - proud),
    };
  },
  door: (c) => slamDoorCurve(c.u),
  props: (c) => ({ hand: 'r', grip: 'door_handle', attach: 0, state: { name: 'open', u: slamDoorCurve(c.u) } }),
};

// ---------------------------------------------------------------- enter / leave through a door mark

/** gait inside the travel window, a stationary acting pose outside it, cross-faded over `fade` (normalized) */
function windowed(c: ActionCtx, w: [number, number], outside: (c: ActionCtx) => ActionPose, fade: number): ActionPose {
  const g = locomotion(c);
  const inW = ramp(c.u, w[0] - fade * 0.5, w[0] + fade * 0.5) * (1 - ramp(c.u, w[1] - fade * 0.5, w[1] + fade * 0.5));
  if (inW >= 1) return g;
  const o = outside(c);
  if (inW <= 0) return o;
  return { ...g, joints: blendPose(o.joints, g.joints, inW), stance: inW > 0.5 ? g.stance : undefined, still: inW > 0.5 ? g.still : o.still };
}

export const ENTER_WINDOW: [number, number] = [0.24, 1];
/** enter_door: stands in the doorway, leans in and checks both ways ("coast clear?"), then walks to the entry mark */
const enter_door: Def = {
  holds: false, blendIn: 0.1, defaultDuration: 2.6, locomotion: true, travelWindow: ENTER_WINDOW, needs: ['door'],
  pose: (c) => windowed(c, ENTER_WINDOW, (k) => {
    const s = seedPhase(k.seed, 21) < 0.5 ? 1 : -1, x = clampU(k.u / ENTER_WINDOW[0]);
    const lean = window(x, 0.05, 0.8, 0.15);
    const yaw = s * K(x, [[0, 0], [0.2, 40], [0.45, 38], [0.62, -42], [0.82, -40], [1, 0]]);
    return { joints: { ...IDLE_POSE, spine: [14 * lean, 0, -10 * s * lean], neck: [0, yaw, 0], hip_l: [-6 * lean, 0, 2], knee_l: [8 * lean, 0, 0] } };
  }, 0.08),
};

export const EXIT_WINDOW: [number, number] = [0, 0.78];
const GLANCE = { anticipation: 0.1, antAt: 0.2, strikeAt: 0.55, overshoot: 0.12, wobble: 1 };
/** exit_door: walks to the door threshold, stops, glances back over the shoulder (comic pause), then scoots forward */
const exit_door: Def = {
  holds: false, blendIn: 0.14, defaultDuration: 2.4, locomotion: true, travelWindow: EXIT_WINDOW, needs: ['door'],
  pose: (c) => windowed(c, EXIT_WINDOW, (k) => {
    const s = seedPhase(k.seed, 23) < 0.5 ? 1 : -1, x = clampU((k.u - EXIT_WINDOW[1]) / (1 - EXIT_WINDOW[1]));
    // the glance is timed in seconds from the stop (0.5 s), so a short exit never whips the head
    const look = acting(clampU((k.lt - EXIT_WINDOW[1] * k.d) / 0.5), GLANCE) * (1 - ramp(x, 0.7, 0.95));
    const scoot = ramp(x, 0.75, 1);
    return { joints: { ...IDLE_POSE, spine: [12 * scoot, s * 25 * look, 0], neck: [-4 * look, s * 60 * look, 0], shoulder_l: [-10 * scoot, 0, 6], shoulder_r: [-10 * scoot, 0, -6], hip_l: [-14 * scoot, 0, 2], knee_l: [14 * scoot, 0, 0] } };
  }, 0.08),
};

export const DOOR_ACTIONS: Record<string, Def> = { open_door, slam_door, enter_door, exit_door };
