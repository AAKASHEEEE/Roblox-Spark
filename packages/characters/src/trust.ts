// Trust boundary. The package NEVER vouches for evidence itself: byte verification and human attestation are
// facts only the calling, authenticated ingest/approval workflow can establish. This module defines that interface
// and the actor-identity rules; it contains no implementation that could approve or attest on anyone's behalf.
import { err, type Finding, type Reference } from './schema.ts';

export type VerificationStatus = 'verified' | 'mismatch' | 'unknown';
export interface ReferenceVerification {
  /** the stored bytes behind storageRef were re-hashed and match contentHash, byteSize and mimeType */
  bytes: VerificationStatus;
  /** this exact attestation (actor, time, statement, reference hash) was recorded by an authenticated human session */
  attestation: VerificationStatus;
}
/** implemented by the trusted server-side workflow (storage + auth); there is deliberately no default implementation */
export interface TrustedWorkflow {
  verifyReference(ref: Readonly<Reference>): ReferenceVerification;
  /** true only for an authenticated human account id */
  isAuthenticatedActor(actorId: string): boolean;
}

/** namespaced account id, e.g. "github:octo-dev" — bare names like "owner" or "reviewer" are not identities */
export const ACTOR_ID = /^[a-z][a-z0-9-]{1,31}:[A-Za-z0-9][A-Za-z0-9._@-]{2,127}$/;
const PLACEHOLDER_ACTORS = new Set([
  'user', 'users', 'admin', 'administrator', 'owner', 'studioowner', 'reviewer', 'approver', 'system', 'bot', 'test', 'tester', 'unknown',
  'anonymous', 'anon', 'na', 'none', 'null', 'nil', 'undefined', 'tbd', 'todo', 'placeholder', 'example', 'sample', 'demo',
  'someone', 'somebody', 'me', 'myself', 'human', 'person', 'team', 'studio', 'inhouse', 'default', 'dev', 'developer', 'root',
  'foo', 'bar', 'baz', 'johndoe', 'janedoe', 'xxx', 'abc', 'author', 'creator', 'artist', 'uploader', 'agent', 'ai', 'assistant',
]);
const PLACEHOLDER_PATTERN = /(example|placeholder|dummy|fake|sample|lorem|changeme|redacted|your[-_.]?name|xxx)/i;

/** structural + placeholder check for a human actor id (authentication itself is the TrustedWorkflow's job) */
export function checkActorId(id: string | undefined, path: string): Finding[] {
  if (id === undefined || !id.trim()) return [err('ACTOR_MISSING', path, 'an explicit human actor id is required')];
  if (!ACTOR_ID.test(id)) return [err('ACTOR_ID_INVALID', path, `"${id}" is not a namespaced account id (e.g. "github:<login>")`)];
  const [ns, subject] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  const bare = subject.toLowerCase().replace(/[^a-z]/g, '');
  if (PLACEHOLDER_ACTORS.has(bare) || PLACEHOLDER_ACTORS.has(ns.replace(/-/g, '')) || PLACEHOLDER_PATTERN.test(id) || /^(.)\1*$/.test(subject.toLowerCase()) || bare.length === 0)
    return [err('ACTOR_PLACEHOLDER', path, `"${id}" is a generic or placeholder identity`)];
  return [];
}

/** actor id must be well-formed, non-placeholder AND authenticated by the trusted workflow */
export function checkAuthenticatedActor(id: string | undefined, path: string, trust: TrustedWorkflow | undefined): Finding[] {
  const f = checkActorId(id, path);
  if (f.length) return f;
  if (!trust || !trust.isAuthenticatedActor(id as string)) return [err('ACTOR_UNAUTHENTICATED', path, `"${id}" is not an authenticated human account in the trusted workflow`)];
  return [];
}
