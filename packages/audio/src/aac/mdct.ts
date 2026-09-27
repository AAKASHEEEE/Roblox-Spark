// MDCT for AAC long blocks (2M = 2048 inputs -> M = 1024 coefficients), computed as a DCT-IV of the TDAC-folded
// input via one 2M-point complex FFT. Unscaled forward transform: X[k] = sum_n x[n] cos(pi/M (n + 1/2 + M/2)(k + 1/2)),
// which pairs with the ISO 14496-3 synthesis filterbank (2/N scaling) for perfect reconstruction.

export class Fft {
  readonly n: number;
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;
  constructor(n: number) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / n); this.sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  }
  /** in-place forward DFT: X[k] = sum x[n] e^{-2 pi i nk/N} */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step], wi = this.sin[k * step];
          const a = s + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

export class Mdct {
  readonly m: number;
  private fft: Fft;
  private preC: Float64Array; private preS: Float64Array; private postC: Float64Array; private postS: Float64Array;
  private re: Float64Array; private im: Float64Array; private v: Float64Array;
  constructor(m: number) {
    this.m = m;
    this.fft = new Fft(2 * m);
    this.preC = new Float64Array(m); this.preS = new Float64Array(m);
    for (let n = 0; n < m; n++) { this.preC[n] = Math.cos((-Math.PI * n) / (2 * m)); this.preS[n] = Math.sin((-Math.PI * n) / (2 * m)); }
    this.postC = new Float64Array(m); this.postS = new Float64Array(m);
    for (let k = 0; k < m; k++) { const a = (-Math.PI * (2 * k + 1)) / (4 * m); this.postC[k] = Math.cos(a); this.postS[k] = Math.sin(a); }
    this.re = new Float64Array(2 * m); this.im = new Float64Array(2 * m); this.v = new Float64Array(m);
  }
  /** x: 2M (already windowed) samples -> out: M coefficients */
  forward(x: Float64Array, out: Float64Array): void {
    const m = this.m, h = m / 2, v = this.v;
    // TDAC fold: quarters a b c d -> (-c_r - d, a - b_r)
    for (let n = 0; n < h; n++) {
      v[n] = -x[m + h - 1 - n] - x[m + h + n];
      v[h + n] = x[n] - x[m - 1 - n];
    }
    const re = this.re, im = this.im;
    for (let n = 0; n < m; n++) { re[n] = v[n] * this.preC[n]; im[n] = v[n] * this.preS[n]; }
    for (let n = m; n < 2 * m; n++) { re[n] = 0; im[n] = 0; }
    this.fft.transform(re, im);
    for (let k = 0; k < m; k++) out[k] = re[k] * this.postC[k] - im[k] * this.postS[k];
  }
}

/** Reference O(N^2) MDCT (tests only). */
export function mdctDirect(x: ArrayLike<number>, m: number): Float64Array {
  const out = new Float64Array(m);
  for (let k = 0; k < m; k++) { let s = 0; for (let n = 0; n < 2 * m; n++) s += x[n] * Math.cos((Math.PI / m) * (n + 0.5 + m / 2) * (k + 0.5)); out[k] = s; }
  return out;
}
/** Reference ISO synthesis (tests only): y[n] = (2/N) sum_k X[k] cos(2pi/N (n + n0)(k + 1/2)), N = 2M, n0 = (M + 1)/2. */
export function imdctIso(X: ArrayLike<number>, m: number): Float64Array {
  const N = 2 * m, n0 = (m + 1) / 2, y = new Float64Array(N);
  for (let n = 0; n < N; n++) { let s = 0; for (let k = 0; k < m; k++) s += X[k] * Math.cos(((2 * Math.PI) / N) * (n + n0) * (k + 0.5)); y[n] = (2 / N) * s; }
  return y;
}
