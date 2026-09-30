// world_text_3d (S7): extruded lettering that stands in the set (signs, labels, "FREE COINS!").
// Built from engine primitives: a lit front face textured with the lettering, plus N back layers carrying a darker
// silhouette of the same glyphs, stepped along -Z so the text reads as a solid 3D block from any camera angle within
// +/-60 degrees. The glyph texture is drawn once per (text, colour) and cached. Animation is closed-form in lt.
import { plane } from '../../engine/src/gl/geometry.ts';
import { Node, hex, type TextureSource } from '../../engine/src/gl/scene.ts';
import { qAxisAngle, type Vec3 } from '../../engine/src/math.ts';
import { TEXT_STYLE_DEFS, fontCss } from './styles.ts';

export interface WorldTextOpts {
  /** letter height in metres (cap height of one line); default 0.22 */
  height?: number;
  /** face colour (sRGB hex); default the style fill */
  color?: string;
  /** extrusion depth in metres; default 0.06 */
  depth?: number;
  /** yaw in degrees (0 = faces +Z, the classroom camera side) */
  yawDeg?: number;
}
export interface WorldText { root: Node; widthM: number; heightM: number; update(lt: number, d: number): void }

const TEX_PX = 160; // glyph size in the texture
const shade = (h: string, k: number) => { const v = parseInt(h.slice(1), 16); const c = (s: number) => Math.round(((v >> s) & 255) * k).toString(16).padStart(2, '0'); return `#${c(16)}${c(8)}${c(0)}`; };
const cache = new Map<string, { front: TextureSource; back: TextureSource; aspect: number; hRatio: number }>();

function textures(text: string, color: string): { front: TextureSource; back: TextureSource; aspect: number; hRatio: number } {
  const key = `${text}|${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const st = TEXT_STYLE_DEFS.world_text_3d, up = text.toUpperCase();
  const mk = (w: number, h: number) => Object.assign(document.createElement('canvas'), { width: w, height: h });
  const probe = mk(4, 4).getContext('2d')!; probe.font = fontCss(st, TEX_PX);
  const pad = TEX_PX * 0.3, w = Math.ceil(probe.measureText(up).width + pad * 2), h = Math.ceil(TEX_PX * 1.25 + pad);
  const draw = (fill: string, edge: string, highlight: boolean) => {
    const c = mk(w, h), g = c.getContext('2d')!;
    g.font = fontCss(st, TEX_PX); g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    g.lineWidth = TEX_PX * st.strokeEm * 2; g.strokeStyle = edge; g.strokeText(up, w / 2, h / 2);
    g.fillStyle = fill; g.fillText(up, w / 2, h / 2);
    if (highlight) { // top-lit bevel: lighter band on the upper half of every glyph
      g.globalCompositeOperation = 'source-atop';
      const gr = g.createLinearGradient(0, h / 2 - TEX_PX * 0.5, 0, h / 2 + TEX_PX * 0.5);
      gr.addColorStop(0, 'rgba(255,255,255,0.35)'); gr.addColorStop(0.45, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.12)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    }
    return c;
  };
  const ink = st.stroke!.color;
  const out = { front: { key: `s7_wt_f:${key}`, canvas: draw(color, ink, true) }, back: { key: `s7_wt_b:${key}`, canvas: draw(shade(color, 0.55), ink, false) }, aspect: w / h, hRatio: h / TEX_PX };
  cache.set(key, out);
  return out;
}

/** Build a world_text_3d node. Place `root.pos` at the anchor (base centre of the text); call update(lt, d) per frame. */
export function buildWorldText(text: string, opts: WorldTextOpts = {}): WorldText {
  const st = TEXT_STYLE_DEFS.world_text_3d;
  const color = opts.color ?? st.fill, H = opts.height ?? 0.22, depth = opts.depth ?? 0.06;
  const tx = textures(text, color);
  const heightM = H * tx.hRatio, widthM = heightM * tx.aspect;
  const root = new Node(`s7:world_text:${text}`);
  const pivot = new Node('s7:world_text:pivot');
  root.add(pivot);
  const layers = 7;
  for (let k = layers; k >= 1; k--) {
    const n = new Node(`s7:world_text:back${k}`, plane(widthM, heightM), { color: [1, 1, 1], alphaTest: 0.5, texture: tx.back, sheen: 0.1 });
    n.pos = [0, heightM / 2, (-depth * k) / layers]; n.castShadow = true;
    pivot.add(n);
  }
  const lin = hex(color);
  const front = new Node('s7:world_text:front', plane(widthM, heightM), { color: [1, 1, 1], emissive: [lin[0] * 0.18, lin[1] * 0.18, lin[2] * 0.18], alphaTest: 0.5, texture: tx.front, sheen: 0.6 });
  front.pos = [0, heightM / 2, 0.001]; front.castShadow = true;
  pivot.add(front);
  root.rot = qAxisAngle([0, 1, 0], ((opts.yawDeg ?? 0) * Math.PI) / 180);
  const update = (lt: number, d: number) => {
    const visible = lt >= 0 && lt <= d;
    root.visible = visible;
    if (!visible) return;
    const inS = lt < st.inSec ? (() => { const u = lt / st.inSec - 1; return Math.max(0, 1 + 2.7 * u ** 3 + 1.7 * u ** 2); })() : 1;
    const outS = lt > d - st.outSec ? Math.max(0, (d - lt) / st.outSec) : 1;
    const s = Math.max(0.001, inS * outS);
    pivot.scl = [s, s, s];
    pivot.pos = [0, 0.02 * Math.sin(lt * 2.4), 0];
    pivot.rot = qAxisAngle([0, 1, 0], 0.06 * Math.sin(lt * 1.3));
  };
  update(0, 1);
  return { root, widthM, heightM, update };
}

/** manages world_text_3d graphics for a list of text-graphic events: one node per event, created lazily */
export class WorldTextLayer {
  readonly root = new Node('s7:world_text_layer');
  private nodes = new Map<number, WorldText>();
  /** anchor(target) -> world base point for the text (e.g. above a prop); events without target use `fallback` */
  update(events: ReadonlyArray<{ textStyleId: string; at: number; duration: number; text: string; target?: string }>, t: number, anchor: (target: string) => Vec3 | undefined, fallback: Vec3 = [0, 1.6, 0]): void {
    // Hide nodes from prior random-access frames first. Without this, a world graphic survives when the next frame has
    // no graphics array (stills and seeked renders do not necessarily arrive in chronological order).
    for (const n of this.nodes.values()) n.root.visible = false;
    events.forEach((e, i) => {
      if (e.textStyleId !== 'world_text_3d') return;
      const lt = t - e.at;
      let n = this.nodes.get(i);
      if (lt < 0 || lt > e.duration) { if (n) n.root.visible = false; return; }
      if (!n) { n = buildWorldText(e.text); this.nodes.set(i, n); this.root.add(n.root); }
      const resolved = e.target ? anchor(e.target) : undefined;
      if (e.target && !resolved) { n.root.visible = false; return; }
      const p = resolved ?? fallback;
      n.root.pos = [p[0], p[1], p[2]];
      n.update(lt, e.duration);
    });
  }
}
