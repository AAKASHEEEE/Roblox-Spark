// Deterministic test doubles: a scripted provider, and a fault-injecting wrapper that reproduces typical LLM
// structured-output failure modes at seeded, documented rates (used for the synthetic robustness run).
import { rng, hashSeed } from '../../../engine/src/math.ts';
import { ProviderError, type CallMeta, type NormalizeInput, type PlanInput, type RepairInput, type StoryModelProvider } from './types.ts';

export type Scripted = unknown | { __error: 'timeout' | 'http' | 'network'; status?: number } | { __delayMs: number; value: unknown };

/** Returns scripted responses per stage in order; the last entry repeats. */
export class MockProvider implements StoryModelProvider {
  readonly name = 'mock';
  readonly model = 'mock-scripted';
  private script: Record<'normalize' | 'plan' | 'repair', Scripted[]>;
  private idx = { normalize: 0, plan: 0, repair: 0 };
  private meta: CallMeta | null = null;
  calls: string[] = [];
  constructor(script: Partial<Record<'normalize' | 'plan' | 'repair', Scripted[]>>) { this.script = { normalize: [], plan: [], repair: [], ...script }; }
  lastCall() { return this.meta; }
  private async next(stage: 'normalize' | 'plan' | 'repair', fallback: () => Promise<unknown>): Promise<unknown> {
    this.calls.push(stage);
    const list = this.script[stage];
    const t0 = performance.now();
    const item = list.length ? list[Math.min(this.idx[stage]++, list.length - 1)] : undefined;
    this.meta = { stage, ms: 0, tokensIn: 0, tokensOut: 0, ok: true, model: this.model, attempts: 1 };
    if (item === undefined) return fallback();
    if (item && typeof item === 'object' && '__error' in (item as object)) { const e = item as { __error: 'timeout' | 'http' | 'network'; status?: number }; this.meta.ok = false; throw new ProviderError(e.__error, `scripted ${e.__error}`, e.status); }
    if (item && typeof item === 'object' && '__delayMs' in (item as object)) { const d = item as { __delayMs: number; value: unknown }; await new Promise((r) => setTimeout(r, d.__delayMs)); this.meta.ms = performance.now() - t0; return d.value; }
    return typeof item === 'function' ? (item as () => unknown)() : JSON.parse(JSON.stringify(item));
  }
  base: StoryModelProvider | null = null;
  normalizeIdea(i: NormalizeInput) { return this.next('normalize', () => this.base ? this.base.normalizeIdea(i) : Promise.reject(new ProviderError('config', 'no scripted normalize response'))); }
  planBeats(i: PlanInput) { return this.next('plan', () => this.base ? this.base.planBeats(i) : Promise.reject(new ProviderError('config', 'no scripted plan response'))); }
  repairPlan(i: RepairInput) { return this.next('repair', () => this.base ? this.base.repairPlan(i) : Promise.resolve({ patches: [], notes: 'no-op' })); }
}

export const FAULT_KINDS = ['invented_action', 'invented_prop', 'missing_field', 'prose_instead_of_json', 'out_of_range_duration', 'wrong_expression', 'broken_cause_link', 'wrong_slot_order'] as const;

/** Wraps a provider and corrupts a seeded fraction of beat plans (and some repairs) in LLM-like ways. */
export class FaultyProvider implements StoryModelProvider {
  readonly name: string;
  readonly model: string;
  private base: StoryModelProvider;
  private rate: number;
  private seed: number;
  injected: Array<{ stage: string; kind: string }> = [];
  constructor(base: StoryModelProvider, rate: number, seed: number) { this.base = base; this.rate = rate; this.seed = seed; this.name = `faulty(${base.name},${rate})`; this.model = base.model; }
  lastCall() { return this.base.lastCall(); }
  normalizeIdea(i: NormalizeInput) { return this.base.normalizeIdea(i); }
  private r(i: { request: { idea: string; seed: number } }, salt: string) { return rng((hashSeed(i.request.idea + salt) ^ this.seed ^ i.request.seed) >>> 0); }
  async planBeats(i: PlanInput) {
    const out = (await this.base.planBeats(i)) as any;
    const r = this.r(i, `plan:${i.constraints.length}`);
    if (i.constraints.length === 0 && r() < this.rate) return this.corrupt(out, FAULT_KINDS[Math.floor(r() * FAULT_KINDS.length)], 'plan');
    return out;
  }
  async repairPlan(i: RepairInput) {
    const out = (await this.base.repairPlan(i)) as any;
    const r = this.r(i, `repair:${i.attempt}`);
    if (r() < this.rate / 2) { this.injected.push({ stage: 'repair', kind: 'unrequested_patch' }); out.patches = [...out.patches, { op: 'set', beatId: 'b01', field: 'action', value: 'dance' }]; }
    return out;
  }
  private corrupt(p: any, kind: (typeof FAULT_KINDS)[number], stage: string): unknown {
    this.injected.push({ stage, kind });
    const b = p.beats.find((x: any) => x.actor !== 'none') ?? p.beats[1];
    switch (kind) {
      case 'invented_action': b.action = 'dance'; break;
      case 'invented_prop': { const e = p.beats.find((x: any) => x.propEffect); if (e) e.propEffect.prop = 'pizza'; else b.target = 'pizza'; break; }
      case 'missing_field': delete b.viewerInference; break;
      case 'prose_instead_of_json': return 'Sure! Here is a funny story where Zapp presses the button and the coin grows...';
      case 'out_of_range_duration': b.approxDuration = 9; break;
      case 'wrong_expression': b.expressionAfter = b.actor === 'kira' ? 'regret' : 'laughing'; break;
      case 'broken_cause_link': { const x = p.beats.find((y: any) => y.causeBeatId); if (x) x.causeBeatId = 'b99'; break; }
      case 'wrong_slot_order': { const i1 = p.beats.findIndex((x: any) => x.slot === 'celebrate'), i2 = p.beats.findIndex((x: any) => x.slot === 'press_reward'); if (i1 > 0 && i2 > 0) { const s = p.beats[i1].slot; p.beats[i1].slot = p.beats[i2].slot; p.beats[i2].slot = s; } break; }
    }
    return p;
  }
}
