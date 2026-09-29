// Episode render-version tool. Every operation is explicit; nothing is inferred from ids, file names or dates.
//
//   node scripts/episode-version.ts show <episode.json>
//       print the declared renderer version / motion profile, the compatibility verdict and the semantic hash
//   node scripts/episode-version.ts pin <episode.json> --renderer <version> --profile <id>
//       one-time migration of an UNDECLARED schema-1.0 fixture: rewrites the file in place with the caller-chosen
//       declaration (both flags required; no defaults). Refuses files that already declare a render block.
//   node scripts/episode-version.ts upgrade <episode.json> --to <profile> --out <new.json> [--force]
//       copies a DECLARED episode to another motion profile (current renderer). The source file is never written:
//       it is hashed before and after and the command fails if it changed. --out may not be the source path.
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { checkRenderDeclaration, pinEpisode, upgradeEpisode, canonicalJson, semanticContent, MOTION_PROFILE_IDS, type MotionProfileId } from '../packages/schema/src/render-compat.ts';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const semanticSha = (ep: unknown) => sha(canonicalJson(semanticContent(ep)));
const serialize = (ep: unknown) => JSON.stringify(ep, null, 2) + '\n';

export function upgradeFile(src: string, to: MotionProfileId, out: string, opts: { force?: boolean } = {}): { out: string; sourceSha256: string; outSha256: string; semanticSha256: string } {
  const srcAbs = resolve(src), outAbs = resolve(out);
  if (srcAbs === outAbs || (existsSync(outAbs) && realpathSync(outAbs) === realpathSync(srcAbs))) throw new Error('upgrade: --out must be a new file; the source episode is never modified');
  if (existsSync(outAbs) && !opts.force) throw new Error(`upgrade: ${relative(process.cwd(), outAbs)} exists (use --force to replace that COPY)`);
  const before = readFileSync(srcAbs);
  const ep = JSON.parse(before.toString('utf8'));
  const sourceSha256 = sha(before);
  const up = upgradeEpisode(ep, to, { sourceSha256 });
  const text = serialize(up);
  writeFileSync(outAbs, text);
  if (sha(readFileSync(srcAbs)) !== sourceSha256) throw new Error('upgrade: source file changed during upgrade (must never happen)');
  if (semanticSha(up) !== semanticSha(ep)) throw new Error('upgrade: semantic content changed (must never happen)');
  return { out: outAbs, sourceSha256, outSha256: sha(text), semanticSha256: semanticSha(up) };
}

export function pinFile(file: string, rendererVersion: string, motionProfile: string): { before: string; after: string } {
  const abs = resolve(file);
  const before = readFileSync(abs);
  const pinned = pinEpisode(JSON.parse(before.toString('utf8')), { rendererVersion, motionProfile });
  const text = serialize(pinned);
  writeFileSync(abs, text);
  return { before: sha(before), after: sha(text) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, file] = process.argv.slice(2);
  const flag = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  try {
    if (!cmd || !file) throw new Error('usage: episode-version.ts show|pin|upgrade <episode.json> [...]');
    if (cmd === 'show') {
      const ep = JSON.parse(readFileSync(file, 'utf8'));
      const c = checkRenderDeclaration(ep);
      console.log(JSON.stringify({ file, schemaVersion: ep.schemaVersion, render: ep.render ?? null, compatible: c.ok, ...(c.ok ? { renderKey: c.key } : { code: c.code, message: c.message }), semanticSha256: semanticSha(ep) }, null, 2));
      process.exit(c.ok ? 0 : 2);
    } else if (cmd === 'pin') {
      const rv = flag('renderer'), mp = flag('profile');
      if (!rv || !mp) throw new Error('pin requires BOTH --renderer <version> and --profile <id> (no defaults)');
      const r = pinFile(file, rv, mp);
      console.log(`pinned ${file} -> renderer ${rv}, motion profile ${mp} (sha256 ${r.before.slice(0, 12)} -> ${r.after.slice(0, 12)})`);
    } else if (cmd === 'upgrade') {
      const to = flag('to'), out = flag('out');
      if (!to || !out) throw new Error('upgrade requires --to <profile> and --out <new file>');
      if (!(MOTION_PROFILE_IDS as readonly string[]).includes(to)) throw new Error(`unknown motion profile ${to} (known: ${MOTION_PROFILE_IDS.join(', ')})`);
      const r = upgradeFile(file, to as MotionProfileId, out, { force: process.argv.includes('--force') });
      console.log(`upgraded copy written: ${relative(process.cwd(), r.out)} (${to}); source ${file} unchanged (sha256 ${r.sourceSha256.slice(0, 12)}); semantic sha256 ${r.semanticSha256.slice(0, 12)}`);
    } else throw new Error(`unknown command ${cmd}`);
  } catch (e) { console.error(String((e as Error).message ?? e)); process.exit(1); }
}
