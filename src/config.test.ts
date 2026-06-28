import { assert, describe, it } from '@effect/vitest';
import { baseFor, type Config, defineConfig, modelsFor } from './config.ts';

/**
 * Characterization of config validation + resolution: defineConfig fail-fasts on
 * an invalid literal, and modelsFor/baseFor resolve the per-target override when
 * present and fall back to the global default / `main` otherwise.
 */

const valid = {
  targets: [
    { repo: 'a/repo', base: 'develop', models: { work: 'big', review: 'big' } },
    { repo: 'b/repo' },
  ],
  models: { work: 'small', review: 'small' },
  workers: { max: 1, idleTimeoutSec: 300, maxTtlSec: 3600 },
  box: { type: 'cpx11', locations: ['nbg1'] },
  retries: 2,
};

describe('defineConfig', () => {
  it('accepts a valid config', () => {
    assert.strictEqual(defineConfig(valid).retries, 2);
  });

  it('throws when workers.max is 0', () => {
    assert.throws(() => defineConfig({ ...valid, workers: { ...valid.workers, max: 0 } }));
  });

  it('throws when targets is empty', () => {
    assert.throws(() => defineConfig({ ...valid, targets: [] }));
  });

  it('throws when box.locations is empty', () => {
    assert.throws(() => defineConfig({ ...valid, box: { type: 'cpx11', locations: [] } }));
  });

  it('defaults box.imageId to undefined (stock ubuntu)', () => {
    assert.strictEqual(defineConfig(valid).box.imageId, undefined);
  });

  it('accepts a box.imageId snapshot id', () => {
    const cfg = defineConfig({ ...valid, box: { ...valid.box, imageId: 234_567_890 } });
    assert.strictEqual(cfg.box.imageId, 234_567_890);
  });

  it('defaults state to undefined (no management volume bound yet)', () => {
    assert.strictEqual(defineConfig(valid).state, undefined);
  });

  it('accepts a state.volumeId binding the management-state volume', () => {
    const cfg = defineConfig({ ...valid, state: { volumeId: 4711 } });
    assert.strictEqual(cfg.state?.volumeId, 4711);
  });
});

describe('modelsFor', () => {
  const config: Config = defineConfig(valid);

  it('returns the per-target override when present', () => {
    assert.deepStrictEqual(modelsFor(config, 'a/repo'), { work: 'big', review: 'big' });
  });

  it('falls back to the global models when the target has none', () => {
    assert.deepStrictEqual(modelsFor(config, 'b/repo'), { work: 'small', review: 'small' });
  });

  it('falls back to the global models for an unknown target', () => {
    assert.deepStrictEqual(modelsFor(config, 'unknown/repo'), { work: 'small', review: 'small' });
  });
});

describe('baseFor', () => {
  const config: Config = defineConfig(valid);

  it('returns the per-target base when set', () => {
    assert.strictEqual(baseFor(config, 'a/repo'), 'develop');
  });

  it('defaults to main when the target omits base', () => {
    assert.strictEqual(baseFor(config, 'b/repo'), 'main');
  });

  it('defaults to main for an unknown target', () => {
    assert.strictEqual(baseFor(config, 'unknown/repo'), 'main');
  });
});
