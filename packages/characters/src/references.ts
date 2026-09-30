// Reference-file METADATA validation. References are never opened, decoded or executed here; we validate what the
// uploader declared (type, MIME, hash, dimensions, provenance) and reject anything that could smuggle a path, an
// executable or an archive into the pipeline. Storage is by opaque content-addressed key only.
import { STORAGE_REF, err, warn, type Finding, type Reference, type ReferenceType } from './schema.ts';

const IMAGE = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** MIME allowlist per reference type */
export const ALLOWED_MIME: Record<ReferenceType, readonly string[]> = {
  front_image: IMAGE, side_image: IMAGE, back_image: IMAGE, expression_sheet: IMAGE, palette_image: IMAGE,
  owned_glb: ['model/gltf-binary'],
  owned_texture: [...IMAGE, 'image/ktx2'],
  written_details: ['text/plain', 'text/markdown'],
};
const EXT_FOR_MIME: Record<string, readonly string[]> = {
  'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'], 'image/ktx2': ['ktx2'],
  'model/gltf-binary': ['glb'], 'text/plain': ['txt'], 'text/markdown': ['md'],
};
const NEEDS_DIMENSIONS: readonly ReferenceType[] = ['front_image', 'side_image', 'back_image', 'expression_sheet', 'palette_image', 'owned_texture'];

export const EXECUTABLE_EXT = ['exe', 'dll', 'so', 'dylib', 'bin', 'elf', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'com', 'ps1', 'psm1', 'vbs', 'js', 'mjs', 'cjs', 'ts', 'py', 'rb', 'pl', 'php', 'jar', 'class', 'msi', 'app', 'apk', 'scr', 'lnk', 'wasm', 'lua', 'rbxm', 'rbxl', 'rbxmx', 'rbxlx', 'html', 'htm', 'svg'];
export const ARCHIVE_EXT = ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'cab', 'iso', 'dmg'];
const EXECUTABLE_MIME = /^(application\/(x-msdownload|x-dosexec|x-executable|x-elf|x-mach-binary|x-sh|x-shellscript|x-bat|java-archive|javascript|x-httpd-php|wasm|vnd\.microsoft\.portable-executable)|text\/(javascript|x-python|x-shellscript|html)|image\/svg\+xml)$/;
const ARCHIVE_MIME = /^application\/(zip|x-zip-compressed|x-rar-compressed|vnd\.rar|x-7z-compressed|x-tar|gzip|x-gzip|x-bzip2|x-xz|zstd)$/;
/** display names are shown to users only: plain name + extension, no separators, no traversal, no control chars */
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9 _().-]{0,119}$/;
const TRAVERSAL = /(\.\.|[\\/]|%2e|%2f|%5c|^~|\0|[\x00-\x1f])/i;
const STORAGE_TRAVERSAL = /(\.\.|\\|%|\/\/.*\/\/|[\x00-\x1f]|^(\/|~|file:|[a-z]:[\\/]))/i;

export function validateReference(ref: Reference, path: string): Finding[] {
  const out: Finding[] = [];
  const name = ref.displayFilename;
  // --- paths / traversal: the only storage handle is the opaque CAS key; no filename is ever joined into a path
  if (STORAGE_TRAVERSAL.test(ref.storageRef)) out.push(err('REFERENCE_PATH_TRAVERSAL', `${path}.storageRef`, 'storage references may not contain traversal, absolute paths or encoded characters'));
  if (TRAVERSAL.test(name)) out.push(err('REFERENCE_PATH_TRAVERSAL', `${path}.displayFilename`, 'display filenames may not contain path separators, traversal or control characters'));
  else if (!SAFE_FILENAME.test(name)) out.push(err('REFERENCE_FILENAME_INVALID', `${path}.displayFilename`, `display filename "${name}" has unsupported characters`));
  if (!STORAGE_REF.test(ref.storageRef)) out.push(err('REFERENCE_STORAGE_INVALID', `${path}.storageRef`, 'storageRef must be an opaque cas://references/sha256/<hex> key (no paths or URLs)'));
  else if (ref.storageRef.slice(-64) !== ref.contentHash.slice(-64)) out.push(err('REFERENCE_HASH_MISMATCH', `${path}.storageRef`, 'storageRef is not addressed by the declared contentHash'));

  // --- executables / archives: every dot segment counts ("sheet.png.exe", "a.tar.gz")
  const segs = name.toLowerCase().split('.').slice(1);
  const mime = ref.mimeType.toLowerCase();
  if (segs.some((s) => EXECUTABLE_EXT.includes(s)) || EXECUTABLE_MIME.test(mime)) out.push(err('REFERENCE_EXECUTABLE_REJECTED', path, 'executable or script content is never accepted as a reference'));
  else if (segs.some((s) => ARCHIVE_EXT.includes(s)) || ARCHIVE_MIME.test(mime)) out.push(err('REFERENCE_ARCHIVE_REJECTED', path, `archives are not an expected input for "${ref.type}"`));
  else if (!ALLOWED_MIME[ref.type].includes(mime)) out.push(err('REFERENCE_MIME_UNSUPPORTED', `${path}.mimeType`, `"${ref.mimeType}" is not allowed for ${ref.type} (allowed: ${ALLOWED_MIME[ref.type].join(', ')})`));
  else {
    const ext = segs[segs.length - 1];
    if (segs.length !== 1 || !EXT_FOR_MIME[mime].includes(ext ?? '')) out.push(err('REFERENCE_EXTENSION_MISMATCH', `${path}.displayFilename`, `filename extension does not match ${mime}`));
  }

  // --- shape-by-type
  if (NEEDS_DIMENSIONS.includes(ref.type) && !ref.dimensions) out.push(err('REFERENCE_DIMENSIONS_REQUIRED', `${path}.dimensions`, `${ref.type} requires pixel dimensions`));
  if (!NEEDS_DIMENSIONS.includes(ref.type) && ref.dimensions) out.push(err('REFERENCE_DIMENSIONS_UNEXPECTED', `${path}.dimensions`, `${ref.type} has no pixel dimensions`));
  if ((ref.type === 'written_details') !== (ref.details !== undefined)) out.push(err('REFERENCE_DETAILS_MISMATCH', `${path}.details`, 'details text is required for, and only allowed on, written_details'));
  if (ref.type === 'owned_glb' || ref.type === 'owned_texture') out.push(warn('REFERENCE_NOT_IMPORTED', path, 'owned 3D/texture files are recorded for provenance only; they are not converted into registered components in this phase'));

  // --- provenance & attestation (always required, independent of lock state)
  const p = ref.provenance;
  if (!ref.userAttestation.attested) out.push(err('REFERENCE_ATTESTATION_MISSING', `${path}.userAttestation`, 'the uploader must attest they have the right to use this reference'));
  if (p.source === 'licensed' && !p.licenseName) out.push(err('LICENSE_NAME_MISSING', `${path}.provenance.licenseName`, 'licensed references must name the license'));
  if (ref.redistributable && !p.allowsRedistribution) out.push(err('LICENSE_REDISTRIBUTION_FORBIDDEN', `${path}.redistributable`, 'reference is marked redistributable but its license does not allow redistribution'));
  if (ref.mayAppearInOutput && !p.allowsOutput) out.push(err('LICENSE_OUTPUT_FORBIDDEN', `${path}.mayAppearInOutput`, 'reference may not appear in output under its license'));
  return out;
}
