// Loads + validates the locked asset library from disk and enforces the manifest hash lock.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from './server.ts';
import { CharacterManifestSchema, PropManifestSchema, EnvironmentManifestSchema, AudioManifestSchema, type AudioManifest } from '../../../packages/schema/src/assets.ts';
import type { Library } from '../../../packages/engine/src/production.ts';

export const LOCK_FILE = join(ROOT, 'assets', 'asset-lock.json');

/** canonical JSON (sorted keys) so hashes don't depend on formatting */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const sha256 = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

export interface LoadedLibrary extends Library { audio: Record<string, AudioManifest>; hashes: Record<string, string>; errors: string[] }

const DIRS: Array<[string, 'characters' | 'props' | 'environments' | 'audio', any]> = [
  ['characters', 'characters', CharacterManifestSchema], ['props', 'props', PropManifestSchema],
  ['environments', 'environments', EnvironmentManifestSchema], ['audio', 'audio', AudioManifestSchema],
];

export function loadLibrary(opts: { enforceLock?: boolean; root?: string } = {}): LoadedLibrary {
  const lib: LoadedLibrary = { characters: {}, props: {}, environments: {}, audio: {}, hashes: {}, errors: [] };
  const root = opts.root ?? ROOT;
  const lockFile = join(root, 'assets', 'asset-lock.json');
  for (const [dir, key, schema] of DIRS) {
    const d = join(root, 'assets', dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((f) => f.endsWith('.json')).sort()) {
      const raw = JSON.parse(readFileSync(join(d, f), 'utf8'));
      const r = schema.parse(raw);
      if (!r.ok) { lib.errors.push(...r.issues.map((i: any) => `${dir}/${f} ${i.path}: ${i.message}`)); continue; }
      const k = `${raw.id}@${raw.version}`;
      if (f !== `${k}.json`) lib.errors.push(`${dir}/${f}: file name must be ${k}.json`);
      (lib[key] as Record<string, unknown>)[k] = raw;
      lib.hashes[`${dir}/${k}`] = sha256(canonical(raw));
    }
  }
  if (opts.enforceLock !== false) {
    if (!existsSync(lockFile)) lib.errors.push('asset-lock.json missing: run `npm run assets:lock`');
    else {
      const lock = JSON.parse(readFileSync(lockFile, 'utf8')) as { assets: Record<string, string> };
      for (const [k, h] of Object.entries(lib.hashes)) {
        if (!lock.assets[k]) lib.errors.push(`LOCK: ${k} is not in asset-lock.json (new assets must be registered with a new version)`);
        else if (lock.assets[k] !== h) lib.errors.push(`LOCK: ${k} content changed without a version bump (expected ${lock.assets[k].slice(0, 12)}, got ${h.slice(0, 12)}). Locked assets are immutable: create ${k.split('@')[0]}@<next-version>.json instead.`);
      }
      for (const k of Object.keys(lock.assets)) if (!lib.hashes[k]) lib.errors.push(`LOCK: ${k} is locked but the manifest file is missing`);
    }
  }
  return lib;
}
