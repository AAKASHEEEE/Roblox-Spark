// Builds scene nodes from locked manifests. Geometry is cached by shape+size so identical parts share buffers.
import type { CharacterManifest, EnvironmentManifest, PartT, PropManifest } from '../../schema/src/assets.ts';
import { cylinder, plane, roundedBox, sphere, wedge, type Geometry } from './gl/geometry.ts';
import { Node, hex, type Material } from './gl/scene.ts';
import { DEG, qEuler, type Vec3 } from './math.ts';
import { texture } from './textures.ts';
import { faceTexture } from './faces.ts';

const geoCache = new Map<string, Geometry>();
function geo(shape: string, size: number[], bevel = 0): Geometry {
  const key = `${shape}:${size.join(',')}:${bevel}`;
  let g = geoCache.get(key);
  if (!g) {
    switch (shape) {
      case 'box': g = roundedBox(size[0], size[1], size[2], bevel, bevel > 0 ? 3 : 1); break;
      case 'wedge': g = wedge(size[0], size[1], size[2]); break;
      case 'cylinder': g = cylinder(size[0], size[1] || 0.05, 40, bevel); break;
      case 'sphere': g = sphere(size[0]); break;
      case 'plane': g = plane(size[0], size[1]); break;
      default: throw new Error('unknown shape ' + shape);
    }
    geoCache.set(key, g);
  }
  return g;
}

export function partNode(p: { id: string; shape?: string; size: number[]; pos: number[]; rotDeg?: number[]; color: string; bevel?: number; emissive?: string; texture?: string; sheen?: number }): Node {
  const shape = p.shape ?? 'box';
  const mat: Material = { color: hex(p.color), sheen: p.sheen ?? 0.25 };
  if (p.emissive) mat.emissive = hex(p.emissive).map((c) => c * 0.35) as [number, number, number];
  if (p.texture) { mat.texture = texture(p.texture); if (shape === 'plane') mat.alphaTest = 0.5; }
  const n = new Node(p.id, geo(shape, p.size, p.bevel ?? 0), mat);
  n.pos = [p.pos[0], p.pos[1], p.pos[2]];
  if (p.rotDeg) n.rot = qEuler(p.rotDeg[0] * DEG, p.rotDeg[1] * DEG, p.rotDeg[2] * DEG);
  if (shape === 'plane') { n.decal = true; n.castShadow = false; }
  return n;
}

export const JOINTS = ['hips', 'spine', 'neck', 'shoulder_l', 'elbow_l', 'shoulder_r', 'elbow_r', 'hip_l', 'knee_l', 'hip_r', 'knee_r'] as const;
export type Joint = (typeof JOINTS)[number];

export interface Rig {
  manifest: CharacterManifest;
  root: Node; // world placement (position + yaw/pitch)
  joints: Record<Joint, Node>;
  face: Node;
  hand_l: Node; hand_r: Node; // contact points (child of elbow at wrist)
  sole_l: Node; sole_r: Node;
  headTop: Node;
  dims: { legLen: number; torsoH: number; headH: number; upperArm: number; lowerArm: number; upperLeg: number; lowerLeg: number; shoulderX: number; shoulderY: number; hipX: number; height: number };
  /** probes used for grounding and screen-space shot validation */
  probes: Node[];
  meshes: Node[];
  setFace(state: string, blink: number): void;
}

export function buildCharacter(m: CharacterManifest): Rig {
  const b = m.body;
  const legLen = b.upperLeg + b.lowerLeg;
  const [tw, th, td] = b.torso;
  const [hw, hh, hd] = b.headSize;
  const root = new Node(`char:${m.id}`);
  const hips = new Node('hips').at(0, legLen, 0);
  const spine = new Node('spine').at(0, 0, 0);
  const neck = new Node('neck').at(0, th + 0.012, 0);
  root.add(hips); hips.add(spine); spine.add(neck);
  const meshes: Node[] = [];
  const mesh = (parent: Node, n: Node) => { parent.add(n); meshes.push(n); return n; };

  mesh(spine, new Node('torso_mesh', geo('box', [tw, th, td], 0.045), { color: hex(b.torsoColor), sheen: 0.15 }).at(0, th / 2, 0));
  mesh(neck, new Node('head_mesh', geo('box', [hw, hh, hd], b.headBevel), { color: hex(m.body.skin), sheen: 0.12 }).at(0, hh / 2, 0));
  const face = new Node('face', geo('plane', [hw * 0.98, hh * 0.98]), { color: [1, 1, 1], alphaTest: 0.5, texture: faceTexture(m, m.allowedExpressions[0], 0) }).at(0, hh / 2, hd / 2 + 0.002);
  face.decal = true; face.castShadow = false; face.tags.push(`face:${m.id}`);
  neck.add(face);
  const headTop = new Node('head_top').at(0, hh, 0); neck.add(headTop);

  const aw = b.armWidth;
  const shoulderX = tw / 2 + aw / 2 + 0.005, shoulderY = th - aw / 2 - 0.01;
  const arm = (side: 'l' | 'r') => {
    const s = side === 'l' ? 1 : -1;
    const sh = new Node(`shoulder_${side}`).at(s * shoulderX, shoulderY, 0);
    mesh(sh, new Node(`upperarm_${side}_mesh`, geo('box', [aw, b.upperArm + aw * 0.5, aw], 0.035), { color: hex(b.sleeveColor), sheen: 0.15 }).at(0, -b.upperArm / 2 + aw * 0.25, 0));
    const el = new Node(`elbow_${side}`).at(0, -b.upperArm, 0);
    sh.add(el);
    const sleeve = b.lowerArm * 0.7;
    mesh(el, new Node(`forearm_${side}_mesh`, geo('box', [aw * 0.96, sleeve, aw * 0.96], 0.03), { color: hex(b.sleeveColor), sheen: 0.15 }).at(0, -sleeve / 2, 0));
    const handLen = b.lowerArm - sleeve + 0.03;
    mesh(el, new Node(`hand_${side}_mesh`, geo('box', [aw * 0.86, handLen, aw * 0.86], 0.03), { color: hex(b.handColor), sheen: 0.1 }).at(0, -sleeve - handLen / 2 + 0.02, 0));
    const hand = new Node(`hand_${side}`).at(0, -b.lowerArm, 0);
    el.add(hand);
    spine.add(sh);
    return { sh, el, hand };
  };
  const L = arm('l'), R = arm('r');
  const lw = b.legWidth;
  const hipX = lw / 2 + 0.012;
  const leg = (side: 'l' | 'r') => {
    const s = side === 'l' ? 1 : -1;
    const hp = new Node(`hip_${side}`).at(s * hipX, 0, 0);
    mesh(hp, new Node(`upperleg_${side}_mesh`, geo('box', [lw, b.upperLeg + 0.04, lw * 1.05], 0.035), { color: hex(b.legColor), sheen: 0.1 }).at(0, -b.upperLeg / 2 + 0.02, 0));
    const kn = new Node(`knee_${side}`).at(0, -b.upperLeg, 0);
    hp.add(kn);
    const shoeH = 0.11;
    mesh(kn, new Node(`lowerleg_${side}_mesh`, geo('box', [lw * 0.96, b.lowerLeg - shoeH + 0.02, lw], 0.03), { color: hex(b.legColor), sheen: 0.1 }).at(0, -(b.lowerLeg - shoeH) / 2 + 0.01, 0));
    mesh(kn, new Node(`shoe_${side}_mesh`, geo('box', [lw + 0.02, shoeH - 0.025, lw + 0.1], 0.03), { color: hex(b.shoeColor), sheen: 0.3 }).at(0, -b.lowerLeg + shoeH / 2 + 0.012, 0.045));
    mesh(kn, new Node(`sole_${side}_mesh`, geo('box', [lw + 0.03, 0.03, lw + 0.11], 0.01), { color: hex(b.soleColor), sheen: 0.2 }).at(0, -b.lowerLeg + 0.015, 0.045));
    const sole = new Node(`sole_${side}`).at(0, -b.lowerLeg, 0.045);
    kn.add(sole);
    hips.add(hp);
    return { hp, kn, sole };
  };
  const LL = leg('l'), RL = leg('r');

  const joints: Record<Joint, Node> = {
    hips, spine, neck, shoulder_l: L.sh, elbow_l: L.el, shoulder_r: R.sh, elbow_r: R.el, hip_l: LL.hp, knee_l: LL.kn, hip_r: RL.hp, knee_r: RL.kn,
  };
  // manifest parts attach to named bones
  const attachMap: Record<string, Node> = {
    root, hips, torso: spine, head: neck, upperarm_l: L.sh, upperarm_r: R.sh, forearm_l: L.el, forearm_r: R.el,
    upperleg_l: LL.hp, upperleg_r: RL.hp, lowerleg_l: LL.kn, lowerleg_r: RL.kn,
  };
  for (const p of m.parts) {
    const parent = attachMap[p.attach];
    if (!parent) throw new Error(`${m.id}: part ${p.id} attaches to unknown bone ${p.attach}`);
    const n = partNode(p as PartT);
    parent.add(n); meshes.push(n);
  }
  // probes: sole corners, knees, hands, head corners, torso corners (grounding + framing)
  const probes: Node[] = [];
  const probe = (parent: Node, name: string, p: Vec3) => { const n = new Node(`probe:${name}`).at(p[0], p[1], p[2]); parent.add(n); probes.push(n); return n; };
  for (const [side, legN] of [['l', LL], ['r', RL]] as const) {
    probe(legN.kn, `toe_${side}`, [0, -b.lowerLeg, 0.045 + (lw + 0.11) / 2]);
    probe(legN.kn, `heel_${side}`, [0, -b.lowerLeg, 0.045 - (lw + 0.11) / 2]);
    probe(legN.kn, `knee_${side}`, [0, 0, lw / 2]);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    probe(neck, `head_${sx}_${sz}_top`, [sx * hw / 2, hh + 0.06, sz * hd / 2]);
    probe(neck, `head_${sx}_${sz}_bot`, [sx * hw / 2, 0, sz * hd / 2]);
    probe(spine, `torso_${sx}_${sz}_top`, [sx * tw / 2, th, sz * td / 2]);
    probe(spine, `torso_${sx}_${sz}_bot`, [sx * tw / 2, 0, sz * td / 2]);
  }
  probes.push(L.hand, R.hand);
  const height = legLen + th + 0.012 + hh;
  const rig: Rig = {
    manifest: m, root, joints, face, hand_l: L.hand, hand_r: R.hand, sole_l: LL.sole, sole_r: RL.sole, headTop, probes, meshes,
    dims: { legLen, torsoH: th, headH: hh, upperArm: b.upperArm, lowerArm: b.lowerArm, upperLeg: b.upperLeg, lowerLeg: b.lowerLeg, shoulderX, shoulderY, hipX, height },
    setFace(state: string, blink: number) { face.material!.texture = faceTexture(m, state, blink); },
  };
  return rig;
}

export interface PropInstance { manifest: PropManifest; root: Node; parts: Record<string, Node>; anchors: Record<string, Node> }
export function buildProp(m: PropManifest, instance: string): PropInstance {
  const root = new Node(`prop:${instance}`);
  const parts: Record<string, Node> = {};
  for (const p of m.parts) { const n = partNode(p as PartT); parts[p.id] = n; root.add(n); }
  const anchors: Record<string, Node> = {};
  for (const [k, p] of Object.entries({ ...m.anchors, ...m.effectAnchors, ...m.grips })) { const n = new Node(`anchor:${k}`).at(p[0], p[1], p[2]); anchors[k] = n; root.add(n); }
  return { manifest: m, root, parts, anchors };
}

export interface EnvInstance { manifest: EnvironmentManifest; root: Node; colliders: Array<{ id: string; min: Vec3; max: Vec3 }> }
export function buildEnvironment(m: EnvironmentManifest, decorDensity = 1): EnvInstance {
  const root = new Node(`env:${m.id}`);
  const colliders: EnvInstance['colliders'] = [];
  let decorIdx = 0;
  for (const p of m.pieces) {
    if (p.decor) { decorIdx++; if ((decorIdx * 0.618) % 1 > decorDensity) continue; }
    const shape = p.shape ?? 'box';
    const size = shape === 'cylinder' ? [p.size[0], p.size[1]] : shape === 'sphere' ? [p.size[0]] : shape === 'plane' ? [p.size[0], p.size[1]] : p.size;
    const n = partNode({ ...p, shape, size, sheen: 0.12 });
    if (p.id === 'floor') { n.castShadow = false; n.material!.sheen = 0.2; }
    if (p.emissive && p.texture) { n.material!.unlit = true; n.material!.emissive = [0, 0, 0]; n.castShadow = false; }
    if (shape === 'plane') { n.decal = true; }
    root.add(n);
    if (p.collide) {
      const h: Vec3 = [p.size[0] / 2, (shape === 'cylinder' ? p.size[1] : p.size[1]) / 2, p.size[2] / 2];
      if (shape === 'cylinder' || shape === 'sphere') { h[0] = h[2] = p.size[0]; if (shape === 'sphere') h[1] = p.size[0]; }
      colliders.push({ id: p.id, min: [p.pos[0] - h[0], p.pos[1] - h[1], p.pos[2] - h[2]], max: [p.pos[0] + h[0], p.pos[1] + h[1], p.pos[2] + h[2]] });
    }
  }
  return { manifest: m, root, colliders };
}
