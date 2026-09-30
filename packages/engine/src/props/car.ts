// Car wheel controls. States (parked/driving) cover the simple case; staging that actually moves the car should roll
// the wheels by the distance travelled so the tyres never skid, and steer the front pair.
import { CAR_WHEEL, WHEELS } from './catalog-vehicle.ts';
import { setPivot, type RiggedProp } from './rig.ts';

/** wheel spin (deg) after rolling `meters` forward (+z); negative = reversing */
export const wheelSpinDeg = (meters: number): number => (meters / CAR_WHEEL.radius) * (180 / Math.PI);

/** Spin all four wheels for a forward travel distance. */
export function rollWheels(rig: RiggedProp, meters: number): void {
  if (rig.id !== 'car') throw new Error(`rollWheels: ${rig.id} is not a car`);
  const a = wheelSpinDeg(meters) % 360;
  for (const w of WHEELS) setPivot(rig, `wheel_${w}`, [a, 0, 0]);
}
/** Steer the front wheels (deg, + = toward +x / driver side), clamped to +-30. */
export function steer(rig: RiggedProp, deg: number): void {
  if (rig.id !== 'car') throw new Error(`steer: ${rig.id} is not a car`);
  const d = Math.max(-30, Math.min(30, deg));
  setPivot(rig, 'steer_fl', [0, d, 0]); setPivot(rig, 'steer_fr', [0, d, 0]);
}
