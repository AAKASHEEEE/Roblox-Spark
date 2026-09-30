// Compatibility entry: the face implementation lives in ./faces/ (S3). build.ts imports faceTexture from here, and
// faceTexture routes a locked manifest state to face set v1 and a library expression to face set v2.
export { faceTexture } from './faces/index.ts';
