# Decision matrix

Scores run 1–5, where 5 is best for the project. For "complexity" and "risk" rows, 5 means easy or low-risk.

**Evidence basis:**
- **Option B** is scored from measurements in this repository (see `VALIDATION_REPORT.md`).
- **Options A, C and D** are scored from documented platform behaviour and engineering judgement.
  - Roblox Studio could not be run here: it is a desktop GUI app with no Linux/headless build.
  - Blender could not be installed: the sandbox has no network access.
  - Their scores are therefore **not measured**, and should be re-checked if the decision is ever close.

| Criterion | Weight | A Roblox Studio kit | B Web-native engine | C Web + Blender backend | D Hybrid web preview + Blender final |
|---|---|---|---|---|---|
| Level of automation | 15 | 1 | 5 | 4 | 4 |
| Render consistency / determinism | 12 | 2 | 5 | 4 | 3 |
| Animation quality | 12 | 4 | 3 | 4 | 4 |
| Visual continuity | 10 | 3 | 5 | 4 | 4 |
| Development complexity (5 = easy) | 8 | 3 | 3 | 2 | 1 |
| Hosting complexity (5 = easy) | 6 | 1 | 4 | 2 | 2 |
| Render cost per 20 s episode | 6 | 3 | 5 | 2 | 3 |
| Render time | 6 | 3 | 3 | 1 | 2 |
| Asset pipeline complexity (5 = easy) | 5 | 3 | 4 | 3 | 2 |
| Story change ease | 5 | 3 | 5 | 3 | 4 |
| Licensing / IP risk (5 = low) | 5 | 1 | 5 | 5 | 5 |
| Ability to scale | 4 | 1 | 5 | 3 | 3 |
| Long-term maintainability | 3 | 2 | 4 | 3 | 2 |
| Solo-creator suitability | 3 | 3 | 4 | 2 | 2 |
| **Weighted total (max 500)** | 100 | **237** | **431** | **324** | **313** |

## Why each option scored as it did

### A — Roblox Studio kit
**Strengths:**
- The animation editor and R15 rigs are good.
- Physics and a large tooling ecosystem come for free.

**Weaknesses:**
- **Automation (score 1):** Studio has no supported headless or offline frame renderer. The final picture would have to be screen- or window-recorded in real time on a desktop with a GPU. That is the exact step the brief says to eliminate.
- **Consistency:**
  - Real-time capture can drop frames.
  - The physics is not fixed-step deterministic across runs.
  - Recordings include varying timing jitter.
- **Hosting:** each render needs one Windows or macOS desktop session, which is hard to scale.

**Legal:**
- Content created with Studio is subject to the Roblox Terms of Use.
- The platform's default avatars, UI and look are exactly the trade dress to avoid.
- Marketplace assets have their own licences.
- Anything branded as Roblox needs to go through their brand guidelines.

### B — Web-native engine (chosen)
**Proven here:**
- Fully automatic MP4 output.
- Byte-identical re-renders.
- Locked assets.
- Schema-constrained episodes.
- The browser preview uses the same engine as the final render.

**Weakest criterion is animation quality (score 3):**
- Procedural motion plus authored keyframe tables produces clean, readable, weighted-looking comedy motion.
- It does not reach motion-capture or hand-keyed feature quality for complex acting.

**Render time is middling on CPU:** about 13× slower than real time with SwiftShader. A GPU is expected to be much faster, but that is unmeasured.

### C — Web control panel + Blender backend
**Advantages:**
- Better lighting: Cycles or Eevee global illumination, soft shadows, ambient occlusion and motion blur.
- A better animation toolchain (NLA editor, graph editor, retargeting add-ons).

**Costs:**
- Cycles takes seconds to minutes per 1080×1920 frame, which makes it the most expensive option.
- Eevee needs a GPU or EGL on the server.
- The preview in the browser would **not** match the final render.

**Does Blender give substantially better output for this art style?**
- For lighting, yes, moderately.
- For animation, only if hand-authored clips exist. The clips themselves are the real bottleneck, not the renderer.
- A flat, matte, blocky look deliberately avoids glossy global illumination, which narrows the lighting gap.

### D — Hybrid (web preview + Blender final)
**Advantage:** it has the best theoretical ceiling.

**Problems:**
- It needs two renderers and two material and lighting systems.
- Keeping preview and final render identical becomes a permanent tax on every change.
- The creator approves a preview that is not what ships. Visual continuity suffers because of this.

## Result
The leading hypothesis is **confirmed: Option B wins, 431 to 324** over the runner-up.

The one criterion where B loses (animation quality) is not fixed by switching renderers. It is fixed by adding authored clips (GLB) into B's existing clip slots. That upgrade path stays inside B.

Blender remains an optional future final renderer. It should only be added if a side-by-side test shows a quality gain worth about 10–50× the render cost.
