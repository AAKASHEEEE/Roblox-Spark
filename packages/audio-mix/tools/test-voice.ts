// Stand-in voice-over for mix tests (S7 tooling, not a product feature). The approved narration audio is not stored in
// the repo, so the mix test speaks the aligned phrases with a small deterministic formant synthesiser: glottal pulses
// with a falling phrase pitch, per-syllable vowel formants from the spelling, fricative/plosive onsets, word gaps and
// comma pauses. It sounds robotic, but has speech-like level dynamics and spectrum, which is what the mix needs.
// Pass a real voice-over to tools/mix-test.ts with --vo <file.wav> instead.
const SR = 48000;
const VOWELS: Record<string, [number, number, number]> = { a: [730, 1090, 2440], e: [530, 1840, 2480], i: [300, 2200, 3000], o: [570, 840, 2410], u: [320, 900, 2240], y: [300, 2200, 3000] };
const FRIC = /^(s|z|c|f|v|sh|th|ch|j|x|h)/, STOP_C = /^(p|t|k|b|d|g|q)/;

interface Syl { t0: number; t1: number; f: [number, number, number]; onset: 'fric' | 'stop' | 'nasal' | 'none'; accent: number }

function syllables(word: string): Array<{ vowel: string; onset: string }> {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  const out: Array<{ vowel: string; onset: string }> = [];
  const re = /([^aeiouy]*)([aeiouy]+)/g; let m: RegExpExecArray | null;
  while ((m = re.exec(w))) out.push({ onset: m[1], vowel: m[2] });
  if (out.length > 1 && /e$/.test(w) && !/[aeiouy]e$/.test(w)) out.pop(); // silent final e
  return out.length ? out : [{ onset: w, vowel: 'a' }];
}

/** mono 48 kHz speech-like signal speaking `phrases` at their aligned times, `dur` seconds long */
export function synthVoice(phrases: ReadonlyArray<{ start: number; end: number; text: string }>, dur: number, seed = 7): Float32Array {
  const N = Math.round(dur * SR), out = new Float32Array(N);
  let rs = seed >>> 0; const rnd = () => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; };
  const syls: Syl[] = [];
  for (const p of phrases) {
    if (p.start >= dur) continue;
    const words = p.text.split(/\s+/).filter(Boolean);
    const plan = words.map((w) => ({ w, s: syllables(w), pause: /[,;:]$/.test(w) ? 0.16 : /[.!?]$/.test(w) ? 0.1 : 0.035 }));
    const nSyl = plan.reduce((a, x) => a + x.s.length, 0), pauses = plan.reduce((a, x) => a + x.pause, 0);
    const sd = Math.max(0.07, (p.end - p.start - pauses - 0.1) / nSyl);
    let t = p.start;
    plan.forEach(({ w, s, pause }, wi) => {
      const content = w.replace(/[^a-z]/gi, '').length > 3;
      s.forEach((x, k) => {
        const len = sd * (0.8 + 0.4 * rnd()) * (k === 0 && content ? 1.15 : 1);
        syls.push({ t0: t, t1: t + len, f: VOWELS[x.vowel[0]] ?? VOWELS.a, onset: FRIC.test(x.onset) ? 'fric' : STOP_C.test(x.onset) ? 'stop' : x.onset ? 'nasal' : 'none', accent: k === 0 && content ? 1 : wi === 0 ? 0.6 : 0.3 });
        t += len;
      });
      t += pause;
    });
  }
  // per-sample synthesis: glottal source -> 3 formant resonators; noise for fricatives/bursts
  const res = [0, 1, 2].map(() => ({ y1: 0, y2: 0 }));
  const bw = [90, 110, 170];
  let ph = 0, si = 0, fCur: [number, number, number] = [500, 1500, 2500];
  const phraseAt = (t: number) => phrases.find((p) => t >= p.start && t < p.end + 0.2);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    while (si < syls.length - 1 && t >= syls[si].t1) si++;
    const s = syls[si];
    const inSyl = s && t >= s.t0 && t < s.t1;
    const p = phraseAt(t);
    const u = p ? (t - p.start) / Math.max(0.1, p.end - p.start) : 0;
    const f0 = (178 - 42 * u + (inSyl ? 18 * s.accent * Math.sin(Math.PI * (t - s.t0) / (s.t1 - s.t0)) : 0)) * (1 + 0.004 * Math.sin(t * 31));
    if (inSyl) for (let k = 0; k < 3; k++) fCur[k] += (s.f[k] - fCur[k]) * 0.004;
    ph += f0 / SR; if (ph >= 1) ph -= 1;
    const glottal = ph < 0.4 ? 0.5 - 0.5 * Math.cos((Math.PI * ph) / 0.4) : ph < 0.55 ? Math.cos((Math.PI * (ph - 0.4)) / 0.3) : 0;
    let src = 0, noise = 0;
    if (inSyl) {
      const lt = t - s.t0, len = s.t1 - s.t0;
      const onsetLen = s.onset === 'fric' ? Math.min(0.07, len * 0.4) : s.onset === 'stop' ? 0.02 : s.onset === 'nasal' ? 0.035 : 0;
      const voiced = lt >= onsetLen ? Math.min(1, (lt - onsetLen) / 0.018) * Math.min(1, (len - lt) / 0.035) : s.onset === 'nasal' ? 0.35 : 0;
      src = (glottal - 0.3) * voiced * (0.75 + 0.25 * s.accent);
      if (lt < onsetLen && s.onset === 'fric') noise = 0.22 * (rnd() * 2 - 1) * Math.sin(Math.PI * lt / onsetLen);
      if (lt < onsetLen && s.onset === 'stop') noise = 0.5 * (rnd() * 2 - 1) * Math.exp(-lt / 0.006);
    }
    let y = 0;
    for (let k = 0; k < 3; k++) {
      const r = Math.exp((-Math.PI * bw[k]) / SR), c = 2 * r * Math.cos((2 * Math.PI * fCur[k]) / SR), q = res[k];
      const v = (1 - r) * src + c * q.y1 - r * r * q.y2; q.y2 = q.y1; q.y1 = v;
      y += v * [1, 0.55, 0.3][k];
    }
    out[i] = y * 6 + noise * 0.35;
  }
  // a touch of high-pass (no DC / rumble) and a soft room: two short early reflections
  let px = 0, py = 0; const k = Math.exp((-2 * Math.PI * 80) / SR);
  for (let i = 0; i < N; i++) { const yy = k * (py + out[i] - px); px = out[i]; py = yy; out[i] = yy; }
  const d1 = Math.round(0.013 * SR), d2 = Math.round(0.029 * SR);
  for (let i = N - 1; i >= d2; i--) out[i] += 0.12 * out[i - d1] + 0.07 * out[i - d2];
  return out;
}
