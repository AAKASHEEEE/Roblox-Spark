import test from 'node:test';
import assert from 'node:assert/strict';
import { ExactFrameLease } from '../src/preview/frame-lease.ts';

test('exact-time frame leases reject out-of-order reuse after a later pose', () => {
  const leases = new ExactFrameLease();
  const first = leases.issue(1);
  leases.assertCurrent(first);
  const second = leases.issue(2);
  leases.assertCurrent(second);
  assert.throws(() => leases.assertCurrent(first), /stale frame context at 1/);
});
