import { afterEach, assert, describe, it } from '@effect/vitest';
import {
  dbDriver,
  dbPath,
  workerBackend,
  workerDeadlineSeconds,
  workerTtlSeconds,
} from './runtime.ts';

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

/**
 * Ticket D (the prod blocker): real opencode sessions run ~6-9 minutes but the
 * old 8-min session timeout killed them mid-work. The session timeout is now
 * 60 minutes, so the Job's `activeDeadlineSeconds` must exceed it (65 min —
 * 60-min session + ~5 min slack for the post-session git commit/push) or k8s
 * kills the pod mid-push. `ttlSecondsAfterFinished` is widened to 24h so
 * finished/failed agent pods stay listed in `kubectl get pods` for post-mortem.
 */
describe('workerDeadlineSeconds', () => {
  const original = process.env.TIDEPOOL_WORKER_DEADLINE_SEC;
  afterEach(() => {
    if (original === undefined) delete process.env.TIDEPOOL_WORKER_DEADLINE_SEC;
    else process.env.TIDEPOOL_WORKER_DEADLINE_SEC = original;
  });

  it('defaults to 3900s (65 min — exceeds the 60-min session timeout)', () => {
    delete process.env.TIDEPOOL_WORKER_DEADLINE_SEC;
    assert.strictEqual(workerDeadlineSeconds(), 3900);
  });

  it('honors the TIDEPOOL_WORKER_DEADLINE_SEC override', () => {
    process.env.TIDEPOOL_WORKER_DEADLINE_SEC = '7200';
    assert.strictEqual(workerDeadlineSeconds(), 7200);
  });
});

describe('workerTtlSeconds', () => {
  const original = process.env.TIDEPOOL_WORKER_TTL_SEC;
  afterEach(() => {
    if (original === undefined) delete process.env.TIDEPOOL_WORKER_TTL_SEC;
    else process.env.TIDEPOOL_WORKER_TTL_SEC = original;
  });

  it('defaults to 86400s (24h — keeps finished pods around for post-mortem)', () => {
    delete process.env.TIDEPOOL_WORKER_TTL_SEC;
    assert.strictEqual(workerTtlSeconds(), 86400);
  });

  it('honors the TIDEPOOL_WORKER_TTL_SEC override', () => {
    process.env.TIDEPOOL_WORKER_TTL_SEC = '1200';
    assert.strictEqual(workerTtlSeconds(), 1200);
  });
});
