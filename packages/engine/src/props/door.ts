// Door helpers for sets (S2) and staging (S6). A set declares a SetDoor { position, facingDeg, propId: 'door', ... };
// these helpers place the door prop in it, cut the wall around it and give the floor marks characters use.
//
// Frame of reference: the door prop's origin is the threshold centre on the floor; its front (+z) is the swing side.
// doorPlacement() yaws the prop so +z points along SetDoor.facingDeg (the way an entering character faces), i.e. the
// leaf swings INTO the room, the usual arrangement for a classroom/bedroom door.
import type { SetDoor } from '../../../library/src/types.ts';
import { DEG, type Vec3 } from '../math.ts';
import { DOOR_DIMS } from './catalog-home.ts';
import { RIGS } from './rigs.ts';
import { anchorLocal, type RiggedProp } from './rig.ts';

export const DOOR = {
  ...DOOR_DIMS,
  /** radius of the leaf's swing arc from the hinge (keep this floor area free of set pieces on the +z side) */
  swingRadius: 1.1,
  /** leaf yaw per state (deg; negative = toward +z) */
  angles: Object.fromEntries(Object.entries(RIGS.door.states).map(([k, s]) => [k, s.pose.pivots?.hinge?.rot?.[1] ?? 0])) as Record<'closed' | 'ajar' | 'open', number>,
  /** walls up to this thickness fit inside the frame depth (thicker walls: add reveal pieces) */
  maxWallThickness: DOOR_DIMS.frameD,
} as const;

/** Root transform for a door prop standing in a SetDoor. */
export function doorPlacement(d: Pick<SetDoor, 'position' | 'facingDeg'>): { pos: Vec3; yawDeg: number } {
  return { pos: [d.position[0], 0, d.position[2]], yawDeg: d.facingDeg };
}
const toWorld = (d: Pick<SetDoor, 'position' | 'facingDeg'>, p: Vec3): Vec3 => {
  const y = d.facingDeg * DEG, c = Math.cos(y), s = Math.sin(y);
  return [d.position[0] + p[0] * c + p[2] * s, p[1], d.position[2] - p[0] * s + p[2] * c];
};

export type DoorMark = 'threshold' | 'use_front' | 'use_back' | 'enter_front' | 'enter_back' | 'hinge_axis';
/**
 * World-space floor marks of a placed door. "front" is the room side (+z of the prop):
 * - enter_back -> threshold -> enter_front is the walk-in path (exit: reverse);
 * - use_front stands beside the handle outside the swing arc (pull side), use_back is the push side.
 */
export function doorMarks(d: Pick<SetDoor, 'position' | 'facingDeg'>, manifestAnchors: Record<string, number[]>): Record<DoorMark, Vec3> {
  const out = {} as Record<DoorMark, Vec3>;
  for (const k of ['threshold', 'use_front', 'use_back', 'enter_front', 'enter_back', 'hinge_axis'] as const) out[k] = toWorld(d, manifestAnchors[k] as Vec3);
  return out;
}
/** World-space position of the handle on either side for the door's CURRENT pose (follows the leaf). */
export function doorHandle(d: Pick<SetDoor, 'position' | 'facingDeg'>, rig: RiggedProp, side: 'front' | 'back'): Vec3 {
  return toWorld(d, anchorLocal(rig, side === 'front' ? 'grip' : 'grip_back'));
}
/** Whether a character fits through at this leaf yaw (deg; DOOR.angles gives the per-state values). */
export const doorPassable = (leafYawDeg: number): boolean => Math.abs(leafYawDeg) >= 70;

export interface WallPiece { id: string; size: Vec3; pos: Vec3; color: string; collide: boolean }
/**
 * Wall with a doorway, in WALL-LOCAL coordinates: the wall runs along x from -length/2 to +length/2, centred on z = 0,
 * room side +z; the door threshold is at (doorX, 0, 0). Returns environment `pieces` (left, right, lintel) that leave
 * exactly the door frame's outer size open. Rotate/translate with the same transform as doorPlacement().
 */
export function doorwayWall(o: { length: number; height: number; thickness: number; doorX: number; color: string; id?: string }): WallPiece[] {
  const id = o.id ?? 'wall', fw = DOOR.frameW, fh = DOOR.frameH;
  if (o.thickness > DOOR.maxWallThickness + 1e-6) throw new Error(`doorwayWall: thickness ${o.thickness} exceeds door frame depth ${DOOR.maxWallThickness}`);
  if (o.height < fh) throw new Error(`doorwayWall: wall height ${o.height} is lower than the door frame (${fh})`);
  const x0 = -o.length / 2, x1 = o.length / 2, dl = o.doorX - fw / 2, dr = o.doorX + fw / 2;
  if (dl < x0 || dr > x1) throw new Error('doorwayWall: door does not fit in the wall');
  const out: WallPiece[] = [];
  if (dl - x0 > 1e-3) out.push({ id: `${id}_l`, size: [dl - x0, o.height, o.thickness], pos: [(x0 + dl) / 2, o.height / 2, 0], color: o.color, collide: true });
  if (x1 - dr > 1e-3) out.push({ id: `${id}_r`, size: [x1 - dr, o.height, o.thickness], pos: [(dr + x1) / 2, o.height / 2, 0], color: o.color, collide: true });
  if (o.height - fh > 1e-3) out.push({ id: `${id}_top`, size: [fw, o.height - fh, o.thickness], pos: [o.doorX, (fh + o.height) / 2, 0], color: o.color, collide: true });
  return out;
}
