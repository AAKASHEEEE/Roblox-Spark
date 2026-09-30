// Typed errors: every failure the bulk core raises carries a stable machine-readable code.

export const BULK_ERROR_CODES = [
  'SCHEMA_INVALID', 'ILLEGAL_TRANSITION', 'NOT_FOUND', 'ALREADY_EXISTS', 'STORE_CORRUPT', 'STORE_LOCKED',
  'LEASE_LOST', 'LEASE_HELD', 'RETRY_NOT_ALLOWED', 'UNSAFE_PATH', 'VALIDATION_FAILED', 'STORYBOARD_FAILED',
  'APPROVAL_REJECTED', 'RENDER_FAILED', 'OUTPUT_INVALID', 'TIMEOUT', 'HANDLER_ERROR', 'CANCELLED',
] as const;
export type BulkErrorCode = (typeof BULK_ERROR_CODES)[number];

export class BulkError extends Error {
  readonly code: BulkErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;
  constructor(code: BulkErrorCode, message: string, opts: { retryable?: boolean; details?: unknown } = {}) {
    super(`${code}: ${message}`);
    this.name = 'BulkError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

export const isBulkError = (e: unknown, code?: BulkErrorCode): e is BulkError =>
  e instanceof BulkError && (code === undefined || e.code === code);
