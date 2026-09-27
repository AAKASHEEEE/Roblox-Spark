// Registers new asset manifests in assets/asset-lock.json. Append-only: changing a locked manifest is refused —
// publish a new version file instead. This is what keeps the cast from drifting between episodes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadLibrary, LOCK_FILE } from '../apps/render-worker/lib/library.ts';

const lib = loadLibrary({ enforceLock: false });
if (lib.errors.length) { console.error('manifest errors:\n  ' + lib.errors.join('\n  ')); process.exit(1); }
const lock = existsSync(LOCK_FILE) ? JSON.parse(readFileSync(LOCK_FILE, 'utf8')) : { lockVersion: 1, note: 'sha256 of canonical manifest JSON. Append-only.', assets: {} };
const changed: string[] = [], added: string[] = [];
for (const [k, h] of Object.entries(lib.hashes)) {
  if (!lock.assets[k]) { lock.assets[k] = h; added.push(k); }
  else if (lock.assets[k] !== h) changed.push(k);
}
if (changed.length) { console.error('REFUSED: locked assets were modified (bump the version instead):\n  ' + changed.join('\n  ')); process.exit(1); }
lock.assets = Object.fromEntries(Object.entries(lock.assets).sort());
writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2) + '\n');
console.log(`asset-lock: ${added.length} added, ${Object.keys(lock.assets).length} locked`);
