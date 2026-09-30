// Portable path rules. Every path the bulk core accepts or emits is a POSIX-style path RELATIVE to a configured root:
// no absolute paths, drive letters, backslashes, `.`/`..` segments, control characters or empty segments.
import { BulkError } from './errors.ts';

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,127}$/;

export function unsafePathReason(p: unknown): string | null {
  if (typeof p !== 'string') return 'not a string';
  if (p.length === 0 || p.length > 512) return 'empty or longer than 512 characters';
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'contains control characters';
  if (p.includes('\\')) return 'contains a backslash';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('~')) return 'absolute or home-relative path';
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return 'URL / scheme-prefixed path';
  for (const seg of p.split('/')) {
    if (seg === '' ) return 'empty path segment';
    if (seg === '.' || seg === '..') return `"${seg}" segment`;
    if (!SEGMENT.test(seg)) return `segment "${seg}" has characters outside [A-Za-z0-9_.@-]`;
  }
  return null;
}

export const isSafeRelativePath = (p: unknown): p is string => unsafePathReason(p) === null;

export function assertSafeRelativePath(p: unknown, what = 'path'): string {
  const why = unsafePathReason(p);
  if (why) throw new BulkError('UNSAFE_PATH', `${what} ${JSON.stringify(p)} rejected: ${why}`);
  return p as string;
}

/** True when `child` equals `parent` or lies beneath it (both already safe relative paths). */
export const isWithin = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}/`);

export const joinRel = (...parts: string[]): string => assertSafeRelativePath(parts.join('/'));

/** Heuristic used to keep portable manifests free of machine-specific paths. */
export const looksAbsolute = (s: string): boolean => s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('~/');
