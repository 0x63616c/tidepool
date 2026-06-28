import { Effect, Layer } from 'effect';
import { newBoxId } from './ids.ts';
import { BoxMaker } from './services.ts';

/**
 * Degenerate `BoxMaker` for Phase B: the agent runs on this machine, so a lease
 * is just a localhost "worker" handle and teardown is a no-op. The scope still
 * wraps the lease exactly like Hetzner, so the reconciler's lifecycle is real —
 * only the compute is local. Phase C swaps the real provisioner behind this tag.
 */
export const LocalBoxMaker = Layer.succeed(BoxMaker, {
  lease: () =>
    Effect.acquireRelease(
      Effect.sync(() => ({
        id: newBoxId(),
        ip: '127.0.0.1',
        role: 'worker' as const,
        provider: 'local' as const,
      })),
      () => Effect.void,
    ),
  reap: () => Effect.succeed({ deleted: [] }),
});
