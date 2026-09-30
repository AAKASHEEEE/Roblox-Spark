// S5 FaceTrack -> S3 face renderer adapter. Narration is intentionally not a mouth source: callers pass only explicit
// character speech drivers or action FaceCues into FaceTrack.
import type { Rig } from '../build.ts';
import type { FaceFrame } from '../animation/face-track.ts';
import type { MouthFrame, MouthShape as S5MouthShape } from '../animation/talking.ts';
import { setFace, type MouthShape as S3MouthShape } from './index.ts';

export interface S3MouthFrame { shape: S3MouthShape; amount: number }

export const S5_TO_S3_MOUTH: Readonly<Record<S5MouthShape, S3MouthShape>> = {
  closed: 'closed',
  small: 'open',
  open: 'open',
  wide: 'wide',
  round: 'o',
};

export function s3MouthFrame(mouth: MouthFrame): S3MouthFrame {
  return { shape: S5_TO_S3_MOUTH[mouth.shape], amount: Math.max(0, Math.min(1, mouth.open)) };
}

/** Apply one S5 FaceFrame with S3's real expression/talking renderer. */
export function applyS3FaceFrame(rig: Rig, frame: FaceFrame): void {
  const mouth = s3MouthFrame(frame.mouth);
  setFace(rig, frame.expression, frame.blink, mouth.shape, mouth.amount);
}
