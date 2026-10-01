/** Opaque generation token that prevents an exact-time frame from being used after a later shared-scene pose. */
export interface FrameLease { readonly generation: number; readonly time: number }

export class ExactFrameLease {
  private generation = 0;

  issue(time: number): FrameLease {
    if (!Number.isFinite(time)) throw new Error('frame lease time must be finite');
    return Object.freeze({ generation: ++this.generation, time });
  }

  assertCurrent(lease: FrameLease): void {
    if (lease.generation !== this.generation) throw new Error(`stale frame context at ${lease.time}; a newer scene pose is active`);
  }
}
