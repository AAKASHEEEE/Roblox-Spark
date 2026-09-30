// Library action definition (S5): the S0 ActionDef contract (packages/library/src/types.ts) plus the optional cues
// staging applies alongside the body pose. Cues are pure functions of the same ActionCtx as the pose.
import type { ActionDef as LibraryActionDef } from '../../../../library/src/types.ts';
import type { ActionCtx } from '../actions.ts';
import type { Vec3 } from '../../math.ts';
import type { FaceCue } from '../face-track.ts';
import type { AnchorRole } from './anchors.ts';

/** rig proportions exposed to library poses (subset of Rig.dims plus head depth) */
export interface BodyDims { legLen: number; torsoH: number; headH: number; headD: number; upperArm: number; lowerArm: number; shoulderX: number; shoulderY: number }
/** ActionCtx plus what LibraryTrack supplies: the root (for world-space IK offsets) and the rig proportions */
export interface LibActionCtx extends ActionCtx {
  root?: { pos: Vec3; yaw: number };
  body?: BodyDims;
}

/** what happens to a prop during the action at ctx time */
export interface PropCue {
  /** which hand holds (or reaches for) the prop */
  hand: 'l' | 'r';
  /** anchor role on the prop that sits in the hand (resolved with anchors.ts) */
  grip: AnchorRole;
  /** 0 = prop free where it was, 1 = attached to the hand (blend with attach.ts blendPlacement) */
  attach: number;
  /** normalized time the prop leaves the hand (throw); the flight starts there (attach.ts flightAt) */
  releaseU?: number;
  /** placement-space orientation layered onto the hand attachment (cup tilt is not an S4 rig state) */
  orientation?: { rotDeg: Vec3 };
  /** prop state for S4's PropBuilder.applyState (e.g. pizza 'slice' after a bite) */
  state?: { name: string; u: number };
}

export interface LibActionDef extends LibraryActionDef {
  /** gait runs only inside [u0, u1] of the action (enter/exit through a door peek or glance outside it) */
  travelWindow?: [number, number];
  /** locomotion speed class used by the root compiler (walk tempo when absent) */
  run?: boolean;
  /** anchor role the action's target should resolve to on a prop (staging builds `<prop>.<anchor>` with anchors.ts) */
  targetRole?: AnchorRole;
  /** prop in hand / prop being manipulated */
  props?(c: ActionCtx): PropCue | undefined;
  /** door open fraction (0 closed .. 1 open; may overshoot slightly past 1 for a comic swing, never below 0) */
  door?(c: ActionCtx): number;
  /** face request (mouth / expression / eyelids) */
  face?(c: ActionCtx): FaceCue | undefined;
}
