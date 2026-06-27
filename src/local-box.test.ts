import { assert, describe, it } from '@effect/vitest';
import { Effect } from 'effect';
import { LocalBoxMaker } from './local-box.ts';
import { BoxMaker } from './services.ts';

/**
 * Phase B runs the agent on this machine, so the box is degenerate: a localhost
 * "worker" with a no-op teardown. The real Hetzner `BoxMaker` (Phase C) swaps in
 * behind the same tag with zero reconciler change.
 */

const spec = { type: 'cpx22', locations: ['nbg1'], ttlSec: 3600 };

describe('LocalBoxMaker', () => {
  it.effect('leases a localhost worker box', () =>
    Effect.gen(function* () {
      const boxes = yield* BoxMaker;
      const box = yield* Effect.scoped(boxes.lease(spec));
      assert.strictEqual(box.ip, '127.0.0.1');
      assert.strictEqual(box.role, 'worker');
      assert.isTrue(box.id.startsWith('box_'));
    }).pipe(Effect.provide(LocalBoxMaker)),
  );

  it.effect('reap deletes nothing', () =>
    Effect.gen(function* () {
      const boxes = yield* BoxMaker;
      const result = yield* boxes.reap();
      assert.deepStrictEqual(result.deleted, []);
    }).pipe(Effect.provide(LocalBoxMaker)),
  );
});
