// Prop interactions (S5): grab, throw, use_phone, type_laptop, eat, drink. Hands reach world targets resolved from
// S4 anchor roles (anchors.ts) or actor-local points on the body; every action also returns a PropCue so staging can
// attach the prop to the hand (attach.ts) and hand it to S4's applyState.
import { IDLE_POSE, type ActionCtx } from '../actions.ts';
import { ACTING, acting, overshootOut, seedPhase, squashStretch } from '../comedy.ts';
import type { JointPose } from '../pose.ts';
import { bodyOf, chestPoint, frac, mix, mouthPoint, num, ramp, sideways, window } from './util.ts';
import type { LibActionCtx, LibActionDef } from './types.ts';

type Def = Omit<LibActionDef, 'id' | 'version' | 'kind'>;
const clampU = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** holding a small prop in the right hand in front of the belly (matches the engine's `hold`) */
export const HOLD_POSE: JointPose = { ...IDLE_POSE, shoulder_r: [-42, 0, -8], elbow_r: [-72, 0, 0] };

// ---------------------------------------------------------------- grab

/** grab: cock the hand back, snatch (fast reach, lean overshoot), yank the prop to the chest; ends holding */
const grab: Def = {
  holds: true, blendIn: 0.1, defaultDuration: 0.9, contactU: 0.4, needs: ['target'], targetRole: 'grip',
  pose: (c) => {
    const u = c.u, cock = window(u, 0.04, 0.2, 0.1) * (1 - ramp(u, 0.2, 0.28));
    const reach = ramp(u, 0.2, 0.4) * (1 - ramp(u, 0.44, 0.62));
    const lean = u < 0.2 ? -0.3 * cock : acting(clampU((u - 0.2) / 0.8), { anticipation: 0, antAt: 0.01, strikeAt: 0.25, overshoot: 0.3, wobble: 2 });
    const back = ramp(u, 0.45, 0.7);
    const j = mix(IDLE_POSE, HOLD_POSE, back);
    j.spine = [11 * lean * (1 - back) - 6 * Math.sin(Math.PI * clampU((u - 0.5) / 0.4)), 0, 0];
    j.shoulder_r = [(j.shoulder_r?.[0] ?? 0) + 24 * cock - 50 * reach, 0, j.shoulder_r?.[2] ?? -6];
    j.elbow_r = [(j.elbow_r?.[0] ?? -8) - 60 * cock, 0, 0];
    j.hip_l = [-14 * reach, 0, 3]; j.knee_l = [16 * reach, 0, 0];
    return {
      joints: j,
      ik: c.target ? [{ arm: 'r', target: c.target, weight: reach, pole: [-0.6, -0.5, -1] }] : [],
      lookAt: c.target, lookWeight: 0.55 * (1 - back * 0.6),
    };
  },
  props: (c) => ({ hand: 'r', grip: 'grip', attach: ramp(c.u, 0.39, 0.42) }),
};

// ---------------------------------------------------------------- throw

/** throw: pitcher wind-up (arm back overhead, front knee up, twist), whip with overshoot, follow-through; release 0.52 */
const THROW_RELEASE = 0.52;
const throwDef: Def = {
  holds: false, blendIn: 0.12, defaultDuration: 1.3, contactU: THROW_RELEASE, needs: ['target', 'prop_in_hand'],
  pose: (c) => {
    const u = c.u;
    const wind = ramp(u, 0.05, 0.4) * (1 - ramp(u, 0.4, 0.5));
    const whip = u < 0.4 ? 0 : acting(clampU((u - 0.4) / 0.6), { anticipation: 0, antAt: 0.01, strikeAt: 0.3, overshoot: 0.35, wobble: 2 }) * (1 - ramp(u, 0.75, 1));
    return {
      joints: {
        ...HOLD_POSE,
        spine: [-12 * wind + 26 * whip, -34 * wind + 26 * whip, 0], neck: [6 * wind - 12 * whip, 20 * wind - 18 * whip, 0],
        shoulder_r: [-42 * (1 - wind - whip) - 168 * wind - 70 * whip, 0, -8 - 20 * wind + 10 * whip], elbow_r: [-72 * (1 - wind - whip) - 95 * wind - 8 * whip, 0, 0],
        shoulder_l: [-70 * wind + 30 * whip, 0, 12 + 20 * wind], elbow_l: [-20 - 20 * wind, 0, 0],
        hip_l: [-44 * wind - 26 * whip, 0, 4], knee_l: [58 * wind + 18 * whip, 0, 0], hip_r: [10 * whip, 0, -3], knee_r: [6 * wind + 10 * whip, 0, 0],
      },
      lookAt: c.target, lookWeight: 0.8, scale: squashStretch(1 - 0.05 * wind + 0.06 * Math.max(0, Math.min(1, whip)) * (1 - ramp(u, 0.55, 0.7))),
    };
  },
  props: (c) => ({ hand: 'r', grip: 'grip', attach: c.u < THROW_RELEASE ? 1 : 0, releaseU: THROW_RELEASE }),
  face: (c) => (c.u > 0.42 && c.u < 0.62 ? { mouth: { shape: 'open', open: 0.6 * window(c.u, 0.46, 0.58, 0.04) } } : undefined),
};

// ---------------------------------------------------------------- drink / eat

/** drink: cup up to the lips, head tilts back over gulps, lowers with a satisfied "ahh" lean-back; cup in the right hand */
const drink: Def = {
  holds: false, blendIn: 0.15, defaultDuration: 2.0, contactU: 0.25, needs: ['prop_in_hand'],
  pose: (c) => {
    const u = c.u, up = ramp(u, 0, 0.25) * (1 - ramp(u, 0.72, 0.84));
    const tilt = ramp(u, 0.25, 0.68) * (1 - ramp(u, 0.72, 0.82));
    const gulp = Math.max(0, Math.sin(c.lt * 2 * Math.PI * 2.4)) ** 3 * window(u, 0.28, 0.7, 0.04);
    const ahh = window(u, 0.8, 0.9, 0.06);
    const sx = -4 * tilt - 10 * ahh, nx = -10 * up - 26 * tilt + 4 * gulp - 10 * ahh;
    return {
      joints: { ...mix(HOLD_POSE, { ...HOLD_POSE, shoulder_r: [-100, 20, -10], elbow_r: [-120, 0, 0] }, up), spine: [sx, 0, 0], neck: [nx, 0, 0] },
      ik: [{ arm: 'r', target: mouthPoint(c, sx, nx, 0.08), weight: up, pole: [-1, -0.6, -0.4], local: true }],
      lift: 0.015 * ahh,
    };
  },
  props: (c) => ({ hand: 'r', grip: 'grip', attach: 1, state: { name: 'tilt', u: ramp(c.u, 0.25, 0.68) * (1 - ramp(c.u, 0.72, 0.82)) } }),
  face: (c) => {
    const ahh = window(c.u, 0.8, 0.92, 0.04);
    return ahh > 0.05 ? { mouth: { shape: 'wide', open: 0.8 * ahh } } : c.u > 0.24 && c.u < 0.72 ? { mouth: { shape: 'small', open: 0.2 } } : undefined;
  },
};

/** eat: mouth opens wide (anticipation), big bite with a head lunge (overshoot), chews, swallows; food in the right hand */
const EAT_BITE = 0.3;
const eat: Def = {
  holds: false, blendIn: 0.15, defaultDuration: 2.0, contactU: EAT_BITE, needs: ['prop_in_hand'],
  pose: (c) => {
    const u = c.u, up = ramp(u, 0, 0.24) * (1 - ramp(u, 0.36, 0.5));
    const lunge = u < 0.22 ? 0 : acting(clampU((u - 0.22) / 0.3), { anticipation: 0.2, antAt: 0.2, strikeAt: 0.35, overshoot: 0.3, wobble: 2 }) * (1 - ramp(u, 0.45, 0.6));
    const chew = Math.sin(c.lt * 2 * Math.PI * 3) * window(u, 0.42, 0.88, 0.05);
    const swallow = window(u, 0.9, 0.95, 0.03);
    const sx = 6 * lunge, nx = -6 * up + 14 * lunge + 3 * chew + 8 * swallow;
    return {
      joints: { ...mix(HOLD_POSE, { ...HOLD_POSE, shoulder_r: [-95, 18, -10], elbow_r: [-125, 0, 0] }, up), spine: [sx, 0, 0], neck: [nx, 0, 0] },
      ik: [{ arm: 'r', target: mouthPoint(c, sx, nx, 0.1 - 0.05 * lunge), weight: up, pole: [-1, -0.6, -0.4], local: true }],
      scale: squashStretch(1 - 0.02 * Math.abs(chew)),
    };
  },
  props: (c) => ({ hand: 'r', grip: 'grip', attach: 1, state: { name: 'bitten', u: ramp(c.u, EAT_BITE - 0.01, EAT_BITE + 0.01) } }),
  face: (c) => {
    const u = c.u;
    if (u < EAT_BITE) return { mouth: { shape: 'wide', open: ramp(u, 0.12, 0.26) } };
    if (u < 0.42) return { mouth: { shape: 'closed', open: 0 } };
    const ch = (1 + Math.sin(c.lt * 2 * Math.PI * 3)) / 2 * window(u, 0.42, 0.88, 0.05);
    return { mouth: { shape: ch > 0.35 ? 'small' : 'closed', open: 0.4 * ch } };
  },
};

// ---------------------------------------------------------------- phone / laptop

/** use_phone: phone up in front of the chest, head down, the other hand taps; params.takeAt (u) adds a double-take */
const use_phone: Def = {
  holds: true, blendIn: 0.2, defaultDuration: 2.0, contactU: 0.25, needs: ['prop_in_hand'], targetRole: 'screen',
  pose: (c) => {
    const up = ramp(c.lt, 0, Math.min(0.5, c.d * 0.25));
    const takeAt = num(c, 'takeAt', -1);
    const take = takeAt >= 0 && c.u >= takeAt ? K1(clampU((c.u - takeAt) / 0.25)) : 0;
    const sx = 6 * up, nx = 30 * up - 44 * take;
    const phone = chestPoint(c, sx, -0.05, 0.3, 0.78);
    const slot = Math.floor(c.lt * 3.6), p = frac(c.lt * 3.6);
    const tap = seedPhase(c.seed, slot) < 0.7 ? Math.sin(Math.PI * p) ** 2 : 0;
    const scroll = seedPhase(c.seed, slot + 1000) < 0.25 ? Math.sin(Math.PI * p) : 0;
    const tapT: [number, number, number] = [phone[0] + 0.04, phone[1] + 0.02 + 0.03 * tap - 0.05 * scroll, phone[2] - 0.02 + 0.04 * tap];
    return {
      joints: { ...IDLE_POSE, spine: [sx, 0, 0], neck: [nx, 0, 0], shoulder_r: [-60, 0, -8], elbow_r: [-100, 0, 0], shoulder_l: [-60, 0, 8], elbow_l: [-100, 0, 0] },
      ik: [
        { arm: 'r', target: phone, weight: up * (1 - 0.3 * take), pole: [-1, -0.6, -0.3], local: true },
        { arm: 'l', target: tapT, weight: up * (1 - take), pole: [-1, -0.6, -0.3], local: true },
      ],
      still: true,
    };
  },
  props: () => ({ hand: 'r', grip: 'grip', attach: 1, state: { name: 'screen_on', u: 1 } }),
  face: (c) => {
    const takeAt = num(c, 'takeAt', -1);
    if (takeAt >= 0 && c.u >= takeAt) return { expression: 'shocked', mouth: { shape: 'round', open: 0.7 * K1(clampU((c.u - takeAt) / 0.25)) } };
    return undefined;
  },
};
/** double-take curve: snap up past the peak, settle at a held look (0 -> ~1.2 -> 1) */
const K1 = (x: number) => overshootOut(x, 0.25);

/** type_laptop: hunched over the keyboard, fast alternating key hits (irregular by seed), a big "enter" slam at the end */
const type_laptop: Def = {
  holds: false, blendIn: 0.2, defaultDuration: 2.0, needs: ['target'], targetRole: 'keyboard',
  pose: (c) => {
    const intensity = num(c, 'intensity', 0.5), rate = 7 + 6 * intensity;
    const w = ramp(c.u, 0, 0.12) * (1 - ramp(c.u, 0.93, 1));
    const enter = num(c, 'enter', 1) > 0 ? window(c.u, 0.8, 0.9, 0.03) : 0;
    const slam = enter > 0 ? acting(clampU((c.u - 0.77) / 0.13), ACTING.snappy) : 0;
    const slot = Math.floor(c.lt * rate), p = frac(c.lt * rate);
    const hitL = slot % 2 === 0 && seedPhase(c.seed, slot) < 0.85 ? Math.sin(Math.PI * p) ** 2 : 0;
    const hitR = slot % 2 === 1 && seedPhase(c.seed, slot) < 0.85 ? Math.sin(Math.PI * p) ** 2 : 0;
    const sx = 10 + 6 * intensity + 3 * Math.sin(c.lt * 2 * Math.PI * 1.3) * intensity, nx = 6;
    const kb = c.target ?? sideways(c, [(c as LibActionCtx).root?.pos[0] ?? 0, 0, (c as LibActionCtx).root?.pos[2] ?? 0], 0, bodyOf(c).legLen - 0.04, 0.4);
    const typeR = sideways(c, kb, -0.09, 0.03 * (1 - hitR) + 0.02, 0);
    const slamY = enter > 0 ? 0.25 * Math.max(0, 1 - slam) * enter : 0;
    return {
      joints: { ...IDLE_POSE, spine: [sx * w, 0, 0], neck: [nx * w, 0, 0], shoulder_l: [-55, 0, 10], shoulder_r: [-55 - 60 * slamY, 0, -10], elbow_l: [-70, 0, 0], elbow_r: [-70, 0, 0], hip_l: [-4, 0, 2], hip_r: [-4, 0, -2] },
      ik: [
        { arm: 'l', target: sideways(c, kb, 0.09, 0.03 * (1 - hitL) + 0.02, 0), weight: w, pole: [-1, -0.8, -0.2] },
        { arm: 'r', target: [typeR[0], typeR[1] + slamY, typeR[2]], weight: w, pole: [-1, -0.8, -0.2] },
      ],
      scale: squashStretch(1 - 0.04 * enter * ramp(c.u, 0.86, 0.88) * (1 - ramp(c.u, 0.88, 0.95))),
      still: true, lookAt: c.target, lookWeight: 0.3 * w,
    };
  },
  // the laptop stays on its surface (attach 0); it only needs to be open
  props: () => ({ hand: 'r', grip: 'keyboard', attach: 0, state: { name: 'open', u: 1 } }),
};

export const PROP_ACTIONS: Record<string, Def> = { grab, throw: throwDef, drink, eat, use_phone, type_laptop };
