import { afterEach, assert, describe, it } from '@effect/vitest';
import { dbDriver, dbPath, workerBackend } from './runtime.ts';

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

/**
 * The cutover selectors. Both default to the local backing so `bun run check`
 * (and every laptop) stays on sqlite + the in-process worker — green without a
 * cluster. The prod pod flips each with one env var; only the exact value `pg` /
 * `k8s` flips it (anything else stays local, so a typo fails safe).
 */
describe('dbDriver', () => {
  const original = process.env.TIDEPOOL_DB_DRIVER;
  afterEach(() => {
    if (original === undefined) delete process.env.TIDEPOOL_DB_DRIVER;
    else process.env.TIDEPOOL_DB_DRIVER = original;
  });

  it('defaults to sqlite (no env)', () => {
    delete process.env.TIDEPOOL_DB_DRIVER;
    assert.strictEqual(dbDriver(), 'sqlite');
  });

  it('selects pg when TIDEPOOL_DB_DRIVER=pg', () => {
    process.env.TIDEPOOL_DB_DRIVER = 'pg';
    assert.strictEqual(dbDriver(), 'pg');
  });

  it('fails safe to sqlite on an unrecognized value', () => {
    process.env.TIDEPOOL_DB_DRIVER = 'postgres';
    assert.strictEqual(dbDriver(), 'sqlite');
  });
});

describe('workerBackend', () => {
  const original = process.env.TIDEPOOL_AGENT_WORKER;
  afterEach(() => {
    if (original === undefined) delete process.env.TIDEPOOL_AGENT_WORKER;
    else process.env.TIDEPOOL_AGENT_WORKER = original;
  });

  it('defaults to local (no env)', () => {
    delete process.env.TIDEPOOL_AGENT_WORKER;
    assert.strictEqual(workerBackend(), 'local');
  });

  it('selects k8s when TIDEPOOL_AGENT_WORKER=k8s', () => {
    process.env.TIDEPOOL_AGENT_WORKER = 'k8s';
    assert.strictEqual(workerBackend(), 'k8s');
  });

  it('fails safe to local on an unrecognized value', () => {
    process.env.TIDEPOOL_AGENT_WORKER = 'kubernetes';
    assert.strictEqual(workerBackend(), 'local');
  });
});
