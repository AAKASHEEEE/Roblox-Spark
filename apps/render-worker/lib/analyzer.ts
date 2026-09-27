// Warm headless-browser analysis session: runs the SAME deterministic engine as the renderer (no pixels encoded)
// and returns per-frame camera/collision issues + motion metrics. One browser serves many episodes.
import { launchBrowser } from './browser.ts';
import { startServer } from './server.ts';
import { ensureWebBuild } from '../render.ts';
import type { Analyzer } from '../../../packages/story/src/pipeline.ts';
import type { Episode } from '../../../packages/schema/src/episode.ts';

export interface AnalyzerMetrics { footSlipMedian: number; footSlipP95: number; handContactErrorCm: number; teleports: number; frames: number; [k: string]: number }

export class BrowserAnalyzer implements Analyzer {
  private page: any = null;
  private browser: any = null;
  private closeServer: (() => void) | null = null;
  private lib: unknown;
  constructor(lib: unknown) { this.lib = lib; }

  async start(): Promise<void> {
    if (this.page) return;
    ensureWebBuild(() => {});
    const { server, url } = await startServer(0);
    this.closeServer = () => server.close();
    this.browser = await launchBrowser();
    this.page = await this.browser.newPage();
    await this.page.goto(`${url}/apps/studio/render.html`);
    await this.page.waitForFunction(() => (window as any).__spark?.ready);
  }
  async close(): Promise<void> { await this.browser?.close(); this.closeServer?.(); this.page = null; }

  async analyze(ep: Episode) {
    await this.start();
    const p = this.page;
    const info = await p.evaluate(([e, l]: any) => (window as any).__spark.load(e, l, 270, 480), [ep, this.lib]);
    const fps = ep.episode.fps, N = Math.round(ep.episode.duration * fps);
    const times = Array.from({ length: N }, (_, i) => i / fps);
    const probes: any[] = [];
    for (let a = 0; a < N; a += 90) probes.push(...(await p.evaluate((ts: number[]) => (window as any).__spark.probe(ts), times.slice(a, a + 90))));
    const aT = times.filter((_, i) => i % 3 === 0).concat([(N - 1) / fps]);
    const ids = ['button', ...ep.cast.map((c) => c.id)];
    const frames: any[] = [];
    for (let a = 0; a < aT.length; a += 90) frames.push(...(await p.evaluate(([ts, ids]: [number[], string[]]) => (window as any).__spark.analyze(ts, { body: true, screen: ids, occlusion: [['button', 'press_surface']] }), [aT.slice(a, a + 90), ids])));
    const contacts = await p.evaluate((ts: number[]) => (window as any).__spark.analyze(ts, { occlusion: [['button', 'press_surface']] }), info.contacts.map((c: any) => c.t));
    for (const c of contacts) for (const i of c.issues) if (i.code === 'PROP_OCCLUDED') frames.push({ t: c.t, shot: c.shot, issues: [{ ...i, code: 'PROP_OCCLUDED', message: `at press contact: ${i.message}` }], cam: c.cam });
    const issues = frames.flatMap((f: any) => f.issues.map((i: any) => ({ ...i, t: f.t, shot: f.shot })));
    // metrics (same definitions as quality gates G09/G10/G21)
    const slips: number[] = [];
    for (let i = 2; i < probes.length; i++) for (const id of Object.keys(probes[i].actors)) {
      const z = probes[i - 2].actors[id], a = probes[i - 1].actors[id], b = probes[i].actors[id];
      if (!a.stance || a.stance !== b.stance || z.stance !== a.stance) continue;
      const s = b.stance === 'l' ? 'soleL' : 'soleR';
      if (Math.hypot(b.root[0] - a.root[0], b.root[2] - a.root[2]) * fps <= 0.3 || b[s][1] >= 0.02 || a[s][1] >= 0.02) continue;
      slips.push(Math.hypot(b[s][0] - a[s][0], b[s][2] - a[s][2]) * fps);
    }
    slips.sort((x, y) => x - y);
    let teleports = 0;
    for (let i = 1; i < probes.length; i++) for (const id of Object.keys(probes[i].actors)) if (Math.hypot(probes[i].actors[id].root[0] - probes[i - 1].actors[id].root[0], probes[i].actors[id].root[2] - probes[i - 1].actors[id].root[2]) * fps > 7) teleports++;
    const handErr = Math.max(0, ...contacts.map((c: any, k: number) => (c.handErrors[info.contacts[k].actor] ?? 1) * 100));
    const metrics: AnalyzerMetrics = { footSlipMedian: slips.length ? slips[Math.floor(slips.length / 2)] : 0, footSlipP95: slips.length ? slips[Math.floor(slips.length * 0.95)] : 0, handContactErrorCm: info.contacts.length ? handErr : 0, teleports, frames: frames.length };
    if (teleports) issues.push({ t: 0, shot: 's01', code: 'ACTOR_OVERLAP', message: `${teleports} teleport-speed frames` });
    return { analysis: { frames: frames.map((f: any) => ({ t: f.t, shot: f.shot, issues: f.issues, cam: f.cam, screen: f.screen })), probes: probes.map((x: any) => ({ t: x.t, actors: Object.fromEntries(Object.entries(x.actors).map(([k, v]: any) => [k, { root: v.root, head: v.head }])), props: x.props })) }, issues, metrics };
  }
}
