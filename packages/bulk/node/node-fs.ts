// Node adapter for the bulk store's BulkFs port. Lives outside packages/bulk/src because the web typecheck has no Node
// types (same convention as apps/render-worker). Every path is resolved under `root` and must stay inside it.
//
// writeAtomic: write `<file>.tmp-<pid>-<n>` → fsync(file) → rename over target → fsync(dir). A crash at any point leaves
// the previous file intact plus, at worst, an orphan temp file that BulkStore.recover() removes.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { BulkFs } from '../src/store.ts';
import { assertSafeRelativePath } from '../src/paths.ts';

let seq = 0;

export class NodeBulkFs implements BulkFs {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); mkdirSync(this.root, { recursive: true }); }

  private abs(p: string): string {
    const rel = assertSafeRelativePath(p);
    const full = resolve(this.root, rel);
    const back = relative(this.root, full);
    if (back.startsWith('..') || isAbsolute(back)) throw new Error(`NodeBulkFs: ${p} escapes store root`);
    return full;
  }

  readText(p: string): string | null {
    try { return readFileSync(this.abs(p), 'utf8'); } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
  }

  writeAtomic(p: string, text: string): void {
    const target = this.abs(p);
    const tmp = `${target}.tmp-${process.pid}-${++seq}`;
    const fd = openSync(tmp, 'w', 0o644);
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, target);
    fsyncDir(dirname(target));
  }

  createExclusive(p: string, text: string): boolean {
    let fd: number;
    try { fd = openSync(this.abs(p), 'wx', 0o644); } catch (e: any) { if (e?.code === 'EEXIST') return false; throw e; }
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    return true;
  }

  remove(p: string): void { rmSync(this.abs(p), { force: true }); }

  list(dir: string): string[] {
    try { return readdirSync(this.abs(dir)).sort(); } catch (e: any) { if (e?.code === 'ENOENT') return []; throw e; }
  }

  mkdirp(dir: string): void { mkdirSync(this.abs(dir), { recursive: true }); }
}

function fsyncDir(dir: string): void {
  // directory fsync makes the rename durable on POSIX; not supported everywhere (e.g. Windows) — best effort
  let fd: number | undefined;
  try { fd = openSync(dir, 'r'); fsyncSync(fd); } catch { /* best effort */ } finally { if (fd !== undefined) closeSync(fd); }
}
