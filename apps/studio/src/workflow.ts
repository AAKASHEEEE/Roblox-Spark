// Supervised studio workflow state (pure and DOM-free; tests/studio-workflow.test.ts).
// IDEA -> STORYBOARD -> APPROVE -> RENDER -> DOWNLOAD. The approved episode is frozen: form edits and late or new
// storyboard results never change it; only an explicit "discard approval" returns to storyboard generation.
export type Screen = 'create' | 'storyboard' | 'approved' | 'render';
export interface FormState { idea: string; engine: string; duration: number; seed: number }
export interface Limits { durationMin: number; durationMax: number }
export interface GenerationView {
  generationId: string; status: 'accepted' | 'rejected' | 'failed'; blocking: string[];
  rejection: { category: string; title: string; reason: string; detail?: string; also: Array<{ category: string; reason: string }> } | null;
  request: { idea: string; durationTarget: number; comedyEngine: string | null; seed: number };
  summary: Record<string, string | number | string[]> | null;
  safety: { status: string; detail: string }; availability: { status: string; detail: string; substitutions: string[] };
  cards: Array<Record<string, string | number | string[] | null>>; warnings: string[];
  storyGates: { passed: number; total: number } | null; repairs: number; latencyMs: number; episodeSha256: string | null;
}
export interface ApprovalView { approvalId: string; generationId: string; episodeId: string; title: string; seed: number; duration: number; motionProfile: string; sha256: string; approvedAt: string; intact: boolean }
export interface JobView {
  id: string; approvalId: string | null; state: 'queued' | 'running' | 'done' | 'failed'; phase: string; stage: string; detail: string; done: number; total: number;
  error: string | null; outputs: Record<string, string>; media: Record<string, string | number> | null; quality: { passed: number; total: number; failed: string[] } | null;
}
export interface StudioState { screen: Screen; form: FormState; limits: Limits; generation: GenerationView | null; approval: ApprovalView | null; job: JobView | null; busy: boolean; error: string | null }
export type Action =
  | { type: 'form'; patch: Partial<FormState> }
  | { type: 'generating' }
  | { type: 'generated'; generation: GenerationView }
  | { type: 'back-to-idea' }
  | { type: 'approved'; approval: ApprovalView }
  | { type: 'discard-approval' }
  | { type: 'job'; job: JobView }
  | { type: 'restore'; generation: GenerationView | null; approval: ApprovalView | null; job: JobView | null }
  | { type: 'error'; message: string }
  | { type: 'reset'; seed: number };

/** the render worker's actual order (apps/studio/server.ts STAGE) */
export const STAGES = ['Queued', 'Preparing', 'Encoding', 'Rendering', 'Validating', 'Complete'] as const;
export const newSeed = (): number => { const a = new Uint32Array(1); globalThis.crypto.getRandomValues(a); return a[0] % 2147483647; };
const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object') { for (const v of Object.values(o)) deepFreeze(v); Object.freeze(o); } return o; };

export function initialState(seed: number, limits: Limits = { durationMin: 14, durationMax: 22 }): StudioState {
  return { screen: 'create', form: { idea: '', engine: '', duration: 17, seed }, limits, generation: null, approval: null, job: null, busy: false, error: null };
}
export const canGenerate = (s: StudioState): boolean => !s.approval && !s.busy && s.form.idea.trim().length > 0 && Number.isInteger(s.form.seed) && s.form.seed >= 0 && s.form.duration >= s.limits.durationMin && s.form.duration <= s.limits.durationMax;
export const canApprove = (s: StudioState): boolean => s.screen === 'storyboard' && !s.approval && s.generation?.status === 'accepted' && s.generation.blocking.length === 0;
export const canRender = (s: StudioState): boolean => !!s.approval && s.approval.intact && (!s.job || s.job.state === 'done' || s.job.state === 'failed');

export function reduce(s: StudioState, a: Action): StudioState {
  switch (a.type) {
    case 'form': return { ...s, form: { ...s.form, ...a.patch }, error: null };
    case 'generating': return s.approval ? s : { ...s, busy: true, error: null };
    // a late or new storyboard never replaces an approval
    case 'generated': return s.approval ? { ...s, busy: false } : { ...s, busy: false, screen: 'storyboard', generation: a.generation, job: null };
    case 'back-to-idea': return s.approval ? s : { ...s, screen: 'create' };
    case 'approved': return canApprove(s) && a.approval.generationId === s.generation!.generationId ? { ...s, screen: 'approved', approval: deepFreeze(structuredClone(a.approval)), job: null } : s;
    case 'discard-approval': return { ...s, approval: null, job: null, screen: s.generation ? 'storyboard' : 'create' };
    case 'job': return s.approval && a.job.approvalId === s.approval.approvalId ? { ...s, screen: 'render', job: a.job } : s;
    case 'restore': {
      const approval = a.approval ? deepFreeze(structuredClone(a.approval)) : null;
      const job = approval && a.job?.approvalId === approval.approvalId ? a.job : null;
      return { ...s, generation: a.generation, approval, job, screen: job ? 'render' : approval ? 'approved' : a.generation ? 'storyboard' : 'create' };
    }
    case 'error': return { ...s, busy: false, error: a.message };
    case 'reset': return { ...initialState(a.seed, s.limits), form: { idea: '', engine: s.form.engine, duration: s.form.duration, seed: a.seed } };
  }
}
