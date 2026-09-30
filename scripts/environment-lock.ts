// Environment lock maintenance. Default = read-only CHECK (exit 1 on any missing/mismatched/deleted/invalid entry).
// `--write` = explicit UPDATE: appends hashes for new valid locked versions only; refuses to rewrite or remove any
// existing entry. Source of truth stays the ENVIRONMENT_LOCK constant in packages/environments/src/lock.ts; hashes
// come only from profileContentHash (canonical JSON + SHA-256).
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENVIRONMENT_CATALOG, ENVIRONMENT_LOCK, canonicalJson, parseLockBlock, planEnvironmentLock, replaceLockBlock,
  type EnvironmentLock, type EnvironmentProfile, type LockMode,
} from '../packages/environments/src/index.ts';

export const LOCK_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '../packages/environments/src/lock.ts');

export interface LockRunResult { code: number; lines: string[]; wrote: boolean }

export function runEnvironmentLock(o: { mode: LockMode; profiles: readonly EnvironmentProfile[]; lockSourcePath: string; runtimeLock?: EnvironmentLock }): LockRunResult {
  const source = readFileSync(o.lockSourcePath, 'utf8');
  const parsed = parseLockBlock(source);
  if (!parsed.ok) return { code: 1, wrote: false, lines: [`environment lock ${o.mode}: REFUSED - ${parsed.error} (${o.lockSourcePath})`] };
  if (o.runtimeLock && (canonicalJson(o.runtimeLock) !== canonicalJson(parsed.lock) || Object.keys(o.runtimeLock).join() !== Object.keys(parsed.lock).join()))
    return { code: 1, wrote: false, lines: [`environment lock ${o.mode}: REFUSED - generated block does not match the ENVIRONMENT_LOCK the module exports`] };
  const plan = planEnvironmentLock({ profiles: o.profiles, lock: parsed.lock }, o.mode);
  const lines = plan.entries.map((e) => `${e.key}  ${e.computed}  ${e.status === 'missing' && o.mode === 'update' ? 'append' : e.status}`);
  lines.push(...plan.issues.map((i) => `  x [${i.code}] ${i.message}`));
  if (!plan.ok) {
    lines.push(`environment lock ${o.mode}: FAILED (${plan.issues.length} issue(s))${o.mode === 'update' ? '; lock not modified' : ''}`);
    return { code: 1, wrote: false, lines };
  }
  if (o.mode === 'check') { lines.push(`environment lock check: OK (${plan.entries.length} locked profile(s))`); return { code: 0, wrote: false, lines }; }
  if (!plan.appended.length) { lines.push('environment lock update: up to date (nothing appended)'); return { code: 0, wrote: false, lines }; }
  const next = replaceLockBlock(source, plan.nextLock!);
  const tmp = `${o.lockSourcePath}.tmp-${process.pid}`;
  writeFileSync(tmp, next);
  renameSync(tmp, o.lockSourcePath);
  const landed = parseLockBlock(readFileSync(o.lockSourcePath, 'utf8'));
  if (!landed.ok || canonicalJson(landed.lock) !== canonicalJson(plan.nextLock)) return { code: 1, wrote: true, lines: [...lines, 'environment lock update: post-write verification FAILED'] };
  lines.push(`environment lock update: appended ${plan.appended.join(', ')}`);
  return { code: 0, wrote: true, lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--write');
  if (unknown.length) { console.error(`usage: node scripts/environment-lock.ts [--write]   (unknown argument: ${unknown.join(' ')})`); process.exit(2); }
  const r = runEnvironmentLock({ mode: args.includes('--write') ? 'update' : 'check', profiles: ENVIRONMENT_CATALOG.profiles, lockSourcePath: LOCK_SOURCE, runtimeLock: ENVIRONMENT_LOCK });
  (r.code ? console.error : console.log)(r.lines.join('\n'));
  process.exit(r.code);
}
