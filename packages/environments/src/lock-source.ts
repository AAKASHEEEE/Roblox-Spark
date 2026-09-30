// Strict reader/writer for the generated ENVIRONMENT_LOCK block in lock.ts. This is deliberately NOT a TypeScript
// editor: the block between the markers must be exactly what renderLockBlock emits (one entry per line, fixed
// layout). Anything else — hand edits, extra lines, duplicate keys, CRLF — is refused rather than guessed at.
import { canonicalJson } from './lock.ts';

export const LOCK_BLOCK_BEGIN = '// BEGIN GENERATED ENVIRONMENT_LOCK (append-only; maintained by scripts/environment-lock.ts)';
export const LOCK_BLOCK_END = '// END GENERATED ENVIRONMENT_LOCK';
const HEAD = 'export const ENVIRONMENT_LOCK: EnvironmentLock = Object.freeze({';
const TAIL = '});';
const ENTRY = /^  '([a-z][a-z0-9_]*(?:-[a-z0-9_]+)*@\d+\.\d+\.\d+)': '([0-9a-f]{64})',$/;

/** the exact generated text for a lock (entries in the given order) */
export function renderLockBlock(lock: Readonly<Record<string, string>>): string {
  const lines = Object.keys(lock).map((k) => `  '${k}': '${lock[k]}',`);
  for (const l of lines) if (!ENTRY.test(l)) throw new Error(`renderLockBlock: refusing to emit malformed entry ${l.trim()}`);
  return [LOCK_BLOCK_BEGIN, HEAD, ...lines, TAIL, LOCK_BLOCK_END].join('\n');
}

export type LockBlockParse = { ok: true; lock: Record<string, string>; start: number; end: number } | { ok: false; error: string };

/** parse the generated block out of lock.ts source; fails closed on any deviation from the generated form */
export function parseLockBlock(source: string): LockBlockParse {
  const lines = source.split('\n');
  const b = lines.flatMap((l, i) => (l === LOCK_BLOCK_BEGIN ? [i] : [])), e = lines.flatMap((l, i) => (l === LOCK_BLOCK_END ? [i] : []));
  if (b.length !== 1 || e.length !== 1 || b[0] >= e[0]) return { ok: false, error: 'expected exactly one BEGIN/END GENERATED ENVIRONMENT_LOCK marker pair' };
  const body = lines.slice(b[0] + 1, e[0]);
  if (body.length < 2 || body[0] !== HEAD || body[body.length - 1] !== TAIL) return { ok: false, error: 'generated lock block header/footer is not in generated form' };
  const lock: Record<string, string> = {};
  for (let i = 1; i < body.length - 1; i++) {
    const m = ENTRY.exec(body[i]);
    if (!m) return { ok: false, error: `line ${b[0] + 2 + i} of the generated lock block is not a generated entry` };
    if (Object.hasOwn(lock, m[1])) return { ok: false, error: `duplicate lock entry ${m[1]} in the generated block` };
    lock[m[1]] = m[2];
  }
  if (renderLockBlock(lock) !== lines.slice(b[0], e[0] + 1).join('\n')) return { ok: false, error: 'generated lock block does not round-trip' };
  return { ok: true, lock, start: b[0], end: e[0] };
}

/** replace the generated block with `next`; every existing entry must be carried over unchanged, in order */
export function replaceLockBlock(source: string, next: Readonly<Record<string, string>>): string {
  const cur = parseLockBlock(source);
  if (!cur.ok) throw new Error(cur.error);
  const nextKeys = Object.keys(next);
  Object.keys(cur.lock).forEach((k, i) => {
    if (nextKeys[i] !== k || next[k] !== cur.lock[k]) throw new Error(`replaceLockBlock: refusing to reorder, rewrite or remove locked entry ${k}`);
  });
  const lines = source.split('\n');
  const out = [...lines.slice(0, cur.start), renderLockBlock(next), ...lines.slice(cur.end + 1)].join('\n');
  const check = parseLockBlock(out);
  if (!check.ok || canonicalJson(check.lock) !== canonicalJson(next)) throw new Error('replaceLockBlock: output failed re-parse verification');
  return out;
}
