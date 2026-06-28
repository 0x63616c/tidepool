import { afterEach, assert, describe, it } from '@effect/vitest';
import { dbPath } from './runtime.ts';

/**
 * The DB_PATH seam (ticket: volume-state). The control-plane sqlite lives at a
 * path resolved from `TIDEPOOL_DB_PATH`, so #14's systemd unit can point it at a
 * Hetzner Volume mount (`/mnt/tidepool/...`) that survives a box rebuild — while
 * local dev keeps the unchanged `.tidepool/tidepool.sqlite` default (tenet 7).
 */

describe('dbPath', () => {
  const original = process.env.TIDEPOOL_DB_PATH;

  afterEach(() => {
    if (original === undefined) delete process.env.TIDEPOOL_DB_PATH;
    else process.env.TIDEPOOL_DB_PATH = original;
  });

  it('honors the TIDEPOOL_DB_PATH override', () => {
    process.env.TIDEPOOL_DB_PATH = '/mnt/tidepool/tidepool.sqlite';
    assert.strictEqual(dbPath(), '/mnt/tidepool/tidepool.sqlite');
  });

  it('defaults to .tidepool/tidepool.sqlite for local dev (unchanged)', () => {
    delete process.env.TIDEPOOL_DB_PATH;
    assert.strictEqual(dbPath(), '.tidepool/tidepool.sqlite');
  });

  it('ignores an empty override (falls back to the default)', () => {
    process.env.TIDEPOOL_DB_PATH = '';
    assert.strictEqual(dbPath(), '.tidepool/tidepool.sqlite');
  });
});
