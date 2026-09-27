// H.264 avcC + SPS parser (enough to report ffprobe-equivalent profile / level / pix_fmt / coded size).
export interface SpsInfo { profileIdc: number; profile: string; constraintFlags: number; levelIdc: number; level: number; chromaFormatIdc: number; bitDepthLuma: number; bitDepthChroma: number; width: number; height: number; pixFmt: string; frameMbsOnly: boolean }

class Bits {
  private p = 0;
  private b: Uint8Array;
  constructor(b: Uint8Array) { this.b = b; }
  u(n: number): number { let v = 0; for (let i = 0; i < n; i++) { v = v * 2 + ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1); this.p++; } return v; }
  ue(): number { let z = 0; while (this.u(1) === 0) { z++; if (z > 31) throw new Error('bad exp-golomb'); } return 2 ** z - 1 + this.u(z); }
  se(): number { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
}
function rbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i++) { if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue; out.push(nal[i]); }
  return new Uint8Array(out);
}
const PROFILE: Record<number, string> = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4 Predictive' };

export function parseSps(nal: Uint8Array): SpsInfo {
  const r = new Bits(rbsp(nal.subarray(1)));
  const profileIdc = r.u(8), constraintFlags = r.u(8), levelIdc = r.u(8);
  r.ue();
  let chromaFormatIdc = 1, bdl = 8, bdc = 8;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) r.u(1);
    bdl = r.ue() + 8; bdc = r.ue() + 8; r.u(1);
    if (r.u(1)) for (let i = 0; i < (chromaFormatIdc !== 3 ? 8 : 12); i++) if (r.u(1)) { let last = 8, next = 8; for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next !== 0) next = (last + r.se() + 256) % 256; last = next === 0 ? last : next; } }
  }
  r.ue();
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) { r.u(1); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
  r.ue(); r.u(1);
  const wMbs = r.ue() + 1, hMapUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1) === 1;
  if (!frameMbsOnly) r.u(1);
  r.u(1);
  let cl = 0, cr = 0, ct = 0, cb = 0;
  if (r.u(1)) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
  const subW = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1, subH = chromaFormatIdc === 1 ? 2 : 1;
  const cropUnitX = chromaFormatIdc === 0 ? 1 : subW, cropUnitY = (chromaFormatIdc === 0 ? 1 : subH) * (frameMbsOnly ? 1 : 2);
  const width = wMbs * 16 - cropUnitX * (cl + cr);
  const height = hMapUnits * 16 * (frameMbsOnly ? 1 : 2) - cropUnitY * (ct + cb);
  const pixFmt = chromaFormatIdc === 1 && bdl === 8 ? 'yuv420p' : chromaFormatIdc === 1 && bdl === 10 ? 'yuv420p10le' : chromaFormatIdc === 2 ? 'yuv422p' : chromaFormatIdc === 3 ? 'yuv444p' : 'gray';
  let profile = PROFILE[profileIdc] ?? `profile_${profileIdc}`;
  if (profileIdc === 66 && constraintFlags & 0x40) profile = 'Constrained Baseline';
  return { profileIdc, profile, constraintFlags, levelIdc, level: levelIdc / 10, chromaFormatIdc, bitDepthLuma: bdl, bitDepthChroma: bdc, width, height, pixFmt, frameMbsOnly };
}

export function parseAvcC(avcC: Uint8Array): { sps: SpsInfo; nalLengthSize: number } {
  const nalLengthSize = (avcC[4] & 3) + 1;
  const numSps = avcC[5] & 31;
  if (numSps < 1) throw new Error('avcC without SPS');
  const len = (avcC[6] << 8) | avcC[7];
  return { sps: parseSps(avcC.subarray(8, 8 + len)), nalLengthSize };
}
