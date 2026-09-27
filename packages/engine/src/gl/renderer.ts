import { type Mat4, type Vec3, m4Mul, m4NormalMatrix, m4Ortho, m4LookAt, norm } from '../math.ts';
import type { Geometry } from './geometry.ts';
import { Node, type RGB, type TextureSource } from './scene.ts';

export interface PointLight { pos: Vec3; color: RGB; intensity: number; range: number }

export interface Lighting {
  sunDir: Vec3; // direction light travels FROM (points toward the sun)
  sunColor: RGB;
  skyColor: RGB;
  groundColor: RGB;
  points: PointLight[];
  fogColor: RGB;
  fogNear: number;
  fogFar: number;
  exposure: number;
  /** scene-space box the shadow map covers */
  shadowCenter: Vec3;
  shadowRadius: number;
}

export interface CameraState {
  pos: Vec3;
  target: Vec3;
  fovY: number; // radians
  roll?: number;
}

export interface PostFx {
  vignette: number; // 0..1
  flash: number; // 0..1 additive white
  tint?: RGB; // multiply
  darken?: number; // 0..1 (e.g. giant shadow)
}

export interface Particle {
  pos: Vec3;
  size: number;
  color: RGB;
  alpha: number;
  /** 0 = soft dot, 1 = 4-point sparkle, 2 = square confetti, 3 = ring */
  shape: number;
  rot?: number;
}

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec2 aUV;
uniform mat4 uModel, uVP, uLightVP;
uniform mat3 uNM;
out vec3 vW; out vec3 vN; out vec2 vUV; out vec4 vL;
void main(){
  vec4 w = uModel * vec4(aPos,1.0);
  vW = w.xyz; vN = normalize(uNM * aNrm); vUV = aUV; vL = uLightVP * w;
  gl_Position = uVP * w;
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
in vec3 vW; in vec3 vN; in vec2 vUV; in vec4 vL;
uniform vec3 uColor, uEmissive, uCamPos, uSunDir, uSunCol, uSky, uGround, uFog;
uniform vec2 uFogRange; uniform float uExposure, uSheen, uAlphaTest, uOpacity, uUnlit;
uniform int uUseTex; uniform sampler2D uTex; uniform sampler2DShadow uShadow; uniform float uShadowTexel;
uniform int uNumPts; uniform vec3 uPtPos[4]; uniform vec3 uPtCol[4]; uniform vec2 uPtParam[4];
uniform vec2 uViewport; uniform float uVignette, uFlash, uDarken; uniform vec3 uTint;
out vec4 outColor;
float shadowAt(vec4 lp){
  vec3 p = lp.xyz / lp.w * 0.5 + 0.5;
  if (p.x<0.0||p.x>1.0||p.y<0.0||p.y>1.0||p.z>1.0) return 1.0;
  float s = 0.0; float bias = 0.0015;
  for (int x=-1;x<=1;x++) for (int y=-1;y<=1;y++)
    s += texture(uShadow, vec3(p.xy + vec2(x,y)*uShadowTexel, p.z - bias));
  return s/9.0;
}
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
float bayer(vec2 p){ ivec2 i = ivec2(mod(p,4.0)); int m[16] = int[16](0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5); return float(m[i.y*4+i.x])/16.0; }
void main(){
  vec4 tex = uUseTex==1 ? texture(uTex, vUV) : vec4(1.0);
  if (tex.a < uAlphaTest) discard;
  if (uOpacity < 0.999 && uOpacity <= bayer(gl_FragCoord.xy)) discard;
  vec3 base = uColor * tex.rgb;
  vec3 col;
  if (uUnlit > 0.5) { col = base + uEmissive; }
  else {
    vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(uCamPos - vW);
    vec3 L = normalize(uSunDir);
    float wrap = 0.25;
    float nl = max((dot(N,L)+wrap)/(1.0+wrap), 0.0);
    float sh = shadowAt(vL);
    vec3 hemi = mix(uGround, uSky, N.y*0.5+0.5);
    vec3 light = hemi + uSunCol * nl * sh;
    vec3 spec = vec3(0.0);
    for (int i=0;i<4;i++){ if (i>=uNumPts) break;
      vec3 d = uPtPos[i]-vW; float dist = length(d); vec3 pl = d/dist;
      float att = uPtParam[i].x / (1.0 + (dist*dist)/(uPtParam[i].y*uPtParam[i].y));
      light += uPtCol[i] * att * max((dot(N,pl)+0.3)/1.3,0.0);
    }
    vec3 H = normalize(L+V);
    spec = uSunCol * pow(max(dot(N,H),0.0), 48.0) * 0.18 * uSheen * sh;
    float rim = pow(1.0 - max(dot(N,V),0.0), 3.0) * 0.22;
    col = base * light + spec + rim * uSky * base + uEmissive;
  }
  float dist = length(uCamPos - vW);
  col = mix(col, uFog, clamp((dist-uFogRange.x)/(uFogRange.y-uFogRange.x),0.0,1.0)*0.85);
  col *= uExposure * uTint * (1.0 - uDarken);
  col = aces(col);
  vec2 q = gl_FragCoord.xy / uViewport - 0.5;
  col *= 1.0 - uVignette * smoothstep(0.35, 0.85, length(q*vec2(1.0,0.75)));
  col = pow(col, vec3(1.0/2.2));
  col = mix(col, vec3(1.0), uFlash);
  outColor = vec4(col, 1.0);
}`;

const SHADOW_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uModel, uLightVP;
void main(){ gl_Position = uLightVP * uModel * vec4(aPos,1.0); }`;
const SHADOW_FS = `#version 300 es
precision mediump float; out vec4 o; void main(){ o = vec4(1.0); }`;

const P_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUV; layout(location=2) in vec4 aCol; layout(location=3) in float aShape;
uniform mat4 uVP; out vec2 vUV; out vec4 vCol; flat out int vShape;
void main(){ vUV=aUV; vCol=aCol; vShape=int(aShape+0.5); gl_Position = uVP*vec4(aPos,1.0); }`;
const P_FS = `#version 300 es
precision highp float; in vec2 vUV; in vec4 vCol; flat in int vShape; uniform float uFlash; out vec4 o;
void main(){
  vec2 p = vUV*2.0-1.0; float a;
  if (vShape==0) a = smoothstep(1.0,0.2,length(p));
  else if (vShape==1) { float s = max(0.0, 1.0 - abs(p.x*p.y)*14.0 - length(p)*0.55); a = clamp(s*1.6,0.0,1.0); }
  else if (vShape==2) a = 1.0;
  else a = smoothstep(0.15,0.0,abs(length(p)-0.8));
  vec3 c = pow(vCol.rgb, vec3(1.0/2.2));
  c = mix(c, vec3(1.0), uFlash);
  o = vec4(c, vCol.a*a);
  if (o.a < 0.01) discard;
}`;

interface GpuMesh { vao: WebGLVertexArrayObject; count: number }

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly width: number;
  readonly height: number;
  private prog: WebGLProgram;
  private shadowProg: WebGLProgram;
  private partProg: WebGLProgram;
  private meshes = new WeakMap<Geometry, GpuMesh>();
  private textures = new Map<string, { tex: WebGLTexture; rev: number }>();
  private shadowFbo: WebGLFramebuffer;
  private shadowTex: WebGLTexture;
  private shadowSize = 2048;
  private loc = new Map<string, WebGLUniformLocation | null>();
  private partVao: WebGLVertexArrayObject;
  private partBuf: WebGLBuffer;
  stats = { drawCalls: 0, triangles: 0 };

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, width: number, height: number) {
    canvas.width = width; canvas.height = height;
    const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true, alpha: false, powerPreference: 'high-performance' }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl; this.width = width; this.height = height;
    this.prog = this.program(VS, FS);
    this.shadowProg = this.program(SHADOW_VS, SHADOW_FS);
    this.partProg = this.program(P_VS, P_FS);
    // shadow map
    this.shadowTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, this.shadowSize, this.shadowSize);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.shadowFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // particles
    this.partVao = gl.createVertexArray()!;
    this.partBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.partVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.partBuf);
    const stride = 10 * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 36);
    gl.bindVertexArray(null);
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    return p;
  }
  private u(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    const key = (p === this.prog ? 'm:' : p === this.shadowProg ? 's:' : 'p:') + name;
    if (!this.loc.has(key)) this.loc.set(key, this.gl.getUniformLocation(p, name));
    return this.loc.get(key)!;
  }

  private mesh(g: Geometry): GpuMesh {
    let m = this.meshes.get(g);
    if (m) return m;
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = (data: Float32Array, loc: number, size: number) => {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    buf(g.positions, 0, 3); buf(g.normals, 1, 3); buf(g.uvs, 2, 2);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    m = { vao, count: g.indices.length };
    this.meshes.set(g, m);
    return m;
  }

  private texture(src: TextureSource): WebGLTexture {
    const gl = this.gl;
    const rev = src.revision ?? 0;
    let t = this.textures.get(src.key);
    if (t && t.rev === rev) return t.tex;
    const tex = t?.tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, src.canvas as TexImageSource);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(src.key, { tex, rev });
    return tex;
  }

  viewProj(cam: CameraState): { view: Mat4; proj: Mat4; vp: Mat4 } {
    const aspect = this.width / this.height;
    const f = 1 / Math.tan(cam.fovY / 2);
    const near = 0.05, far = 80;
    const proj = new Float32Array(16);
    proj[0] = f / aspect; proj[5] = f; proj[10] = (far + near) / (near - far); proj[11] = -1; proj[14] = (2 * far * near) / (near - far);
    const view = m4LookAt(cam.pos, cam.target, [0, 1, 0], cam.roll ?? 0);
    return { view, proj, vp: m4Mul(proj, view) };
  }

  render(root: Node, cam: CameraState, light: Lighting, post: PostFx, particles: Particle[] = []): void {
    const gl = this.gl;
    this.stats.drawCalls = 0; this.stats.triangles = 0;
    root.updateWorld();
    const { vp } = this.viewProj(cam);
    // billboards face the camera: world matrix = camera basis * scale at node world position
    const vm = m4LookAt(cam.pos, cam.target, [0, 1, 0], cam.roll ?? 0);
    const bR: Vec3 = [vm[0], vm[4], vm[8]], bU: Vec3 = [vm[1], vm[5], vm[9]], bB: Vec3 = [vm[2], vm[6], vm[10]];
    root.traverse((n) => {
      if (!n.billboard) return;
      const wp = n.worldPos(), s = n.scl;
      const w = n.world;
      w[0] = bR[0] * s[0]; w[1] = bR[1] * s[0]; w[2] = bR[2] * s[0];
      w[4] = bU[0] * s[1]; w[5] = bU[1] * s[1]; w[6] = bU[2] * s[1];
      w[8] = bB[0] * s[2]; w[9] = bB[1] * s[2]; w[10] = bB[2] * s[2];
      w[12] = wp[0]; w[13] = wp[1]; w[14] = wp[2];
    });
    const draws: Node[] = [], decals: Node[] = [];
    root.traverse((n) => { if (n.geometry && n.material) (n.decal ? decals : draws).push(n); }, true);

    // ---- shadow pass ----
    const L = norm(light.sunDir);
    const c = light.shadowCenter, r = light.shadowRadius;
    const lview = m4LookAt([c[0] + L[0] * r * 2, c[1] + L[1] * r * 2, c[2] + L[2] * r * 2], c, Math.abs(L[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]);
    const lproj = m4Ortho(-r, r, -r, r, 0.1, r * 4);
    const lvp = m4Mul(lproj, lview);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, this.shadowSize, this.shadowSize);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
    gl.colorMask(false, false, false, false);
    gl.useProgram(this.shadowProg);
    gl.uniformMatrix4fv(this.u(this.shadowProg, 'uLightVP'), false, lvp);
    for (const n of draws) {
      if (!n.castShadow || n.material!.unlit) continue;
      const m = this.mesh(n.geometry!);
      gl.uniformMatrix4fv(this.u(this.shadowProg, 'uModel'), false, n.world);
      gl.bindVertexArray(m.vao); gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
    }
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // ---- main pass ----
    gl.viewport(0, 0, this.width, this.height);
    const fog = light.fogColor;
    gl.clearColor(fog[0], fog[1], fog[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    const p = this.prog;
    gl.useProgram(p);
    gl.uniformMatrix4fv(this.u(p, 'uVP'), false, vp);
    gl.uniformMatrix4fv(this.u(p, 'uLightVP'), false, lvp);
    gl.uniform3fv(this.u(p, 'uCamPos'), cam.pos);
    gl.uniform3fv(this.u(p, 'uSunDir'), L);
    gl.uniform3fv(this.u(p, 'uSunCol'), light.sunColor);
    gl.uniform3fv(this.u(p, 'uSky'), light.skyColor);
    gl.uniform3fv(this.u(p, 'uGround'), light.groundColor);
    gl.uniform3fv(this.u(p, 'uFog'), fog);
    gl.uniform2f(this.u(p, 'uFogRange'), light.fogNear, light.fogFar);
    gl.uniform1f(this.u(p, 'uExposure'), light.exposure);
    gl.uniform2f(this.u(p, 'uViewport'), this.width, this.height);
    gl.uniform1f(this.u(p, 'uVignette'), post.vignette);
    gl.uniform1f(this.u(p, 'uFlash'), post.flash);
    gl.uniform1f(this.u(p, 'uDarken'), post.darken ?? 0);
    gl.uniform3fv(this.u(p, 'uTint'), post.tint ?? [1, 1, 1]);
    gl.uniform1f(this.u(p, 'uShadowTexel'), 1 / this.shadowSize);
    const pts = light.points.slice(0, 4);
    gl.uniform1i(this.u(p, 'uNumPts'), pts.length);
    if (pts.length) {
      gl.uniform3fv(this.u(p, 'uPtPos'), pts.flatMap((q) => q.pos));
      gl.uniform3fv(this.u(p, 'uPtCol'), pts.flatMap((q) => q.color));
      gl.uniform2fv(this.u(p, 'uPtParam'), pts.flatMap((q) => [q.intensity, q.range]));
    }
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.uniform1i(this.u(p, 'uShadow'), 1);
    gl.uniform1i(this.u(p, 'uTex'), 0);
    const drawList = (list: Node[]) => {
      for (const n of list) {
        const mat = n.material!;
        const m = this.mesh(n.geometry!);
        gl.uniformMatrix4fv(this.u(p, 'uModel'), false, n.world);
        gl.uniformMatrix3fv(this.u(p, 'uNM'), false, m4NormalMatrix(n.world));
        gl.uniform3fv(this.u(p, 'uColor'), mat.color);
        gl.uniform3fv(this.u(p, 'uEmissive'), mat.emissive ?? [0, 0, 0]);
        gl.uniform1f(this.u(p, 'uSheen'), mat.sheen ?? 0.3);
        gl.uniform1f(this.u(p, 'uAlphaTest'), mat.alphaTest ?? 0);
        gl.uniform1f(this.u(p, 'uOpacity'), mat.opacity ?? 1);
        gl.uniform1f(this.u(p, 'uUnlit'), mat.unlit ? 1 : 0);
        if (mat.texture) {
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture(mat.texture));
          gl.uniform1i(this.u(p, 'uUseTex'), 1);
        } else gl.uniform1i(this.u(p, 'uUseTex'), 0);
        gl.bindVertexArray(m.vao);
        gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
        this.stats.drawCalls++; this.stats.triangles += m.count / 3;
      }
    };
    drawList(draws);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-2, -4);
    gl.disable(gl.CULL_FACE);
    drawList(decals);
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // ---- particles ----
    if (particles.length) {
      const view = m4LookAt(cam.pos, cam.target, [0, 1, 0], cam.roll ?? 0);
      const right: Vec3 = [view[0], view[4], view[8]], up: Vec3 = [view[1], view[5], view[9]];
      const data = new Float32Array(particles.length * 6 * 10);
      let o = 0;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
      for (const pt of particles) {
        const cr = Math.cos(pt.rot ?? 0), sr = Math.sin(pt.rot ?? 0);
        for (const [cx, cy] of corners) {
          const rx = (cx * cr - cy * sr) * pt.size, ry = (cx * sr + cy * cr) * pt.size;
          data[o++] = pt.pos[0] + right[0] * rx + up[0] * ry;
          data[o++] = pt.pos[1] + right[1] * rx + up[1] * ry;
          data[o++] = pt.pos[2] + right[2] * rx + up[2] * ry;
          data[o++] = (cx + 1) / 2; data[o++] = (cy + 1) / 2;
          data[o++] = pt.color[0]; data[o++] = pt.color[1]; data[o++] = pt.color[2]; data[o++] = pt.alpha;
          data[o++] = pt.shape;
        }
      }
      gl.useProgram(this.partProg);
      gl.uniformMatrix4fv(this.u(this.partProg, 'uVP'), false, vp);
      gl.uniform1f(this.u(this.partProg, 'uFlash'), post.flash);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.bindVertexArray(this.partVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.partBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, particles.length * 6);
      gl.depthMask(true); gl.disable(gl.BLEND);
      this.stats.drawCalls++;
    }
    gl.bindVertexArray(null);
  }

  /** Read back RGBA pixels (bottom-up rows) — used for determinism hashes and QA. */
  readPixels(): Uint8Array {
    const gl = this.gl;
    const px = new Uint8Array(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }
}

