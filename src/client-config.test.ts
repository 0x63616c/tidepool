import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunContext } from '@effect/platform-bun';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
  type ClientConfig,
  type ClientContext,
  contextNames,
  deleteContext,
  describeContext,
  isSerializableValue,
  isValidContextName,
  parseClientConfig,
  resolveBaseUrl,
  resolveContext,
  serializeClientConfig,
  setCurrentContext,
  upsertContext,
} from './client-config.ts';

const SAMPLE = `
current-context = "prod"

[contexts.prod]
kind = "http"
url = "http://127.0.0.1:8080"
namespace = "core"
service = "reconciler"
remote-port = 8080

[contexts.local]
kind = "sqlite"
`;

describe('parseClientConfig', () => {
  it('parses current-context, named contexts, and a port-forward block', () => {
    const cfg = parseClientConfig(SAMPLE);
    expect(cfg.currentContext).toBe('prod');
    expect(cfg.contexts.local?.kind).toBe('sqlite');
    const prod = cfg.contexts.prod;
    expect(prod?.kind).toBe('http');
    if (prod?.kind === 'http') {
      expect(prod.url).toBe('http://127.0.0.1:8080');
      expect(prod.portForward?.service).toBe('reconciler');
      expect(prod.portForward?.remotePort).toBe(8080);
    }
  });
});

describe('resolveContext precedence: flag > env > file > default', () => {
  const cfg: ClientConfig = parseClientConfig(SAMPLE);
  let saved: { url?: string; ctx?: string };

  beforeEach(() => {
    saved = { url: process.env.TIDEPOOL_API_URL, ctx: process.env.TIDEPOOL_CONTEXT };
    process.env.TIDEPOOL_API_URL = undefined;
    process.env.TIDEPOOL_CONTEXT = undefined;
  });
  afterEach(() => {
    if (saved.url === undefined) process.env.TIDEPOOL_API_URL = undefined;
    else process.env.TIDEPOOL_API_URL = saved.url;
    if (saved.ctx === undefined) process.env.TIDEPOOL_CONTEXT = undefined;
    else process.env.TIDEPOOL_CONTEXT = saved.ctx;
  });

  it.effect('flag wins over file current-context', () =>
    Effect.gen(function* () {
      const ctx = yield* resolveContext(cfg, { flag: 'local' });
      expect(ctx.name).toBe('local');
      expect(ctx.kind).toBe('sqlite');
    }),
  );

  it.effect('TIDEPOOL_API_URL env synthesises an http context when no flag', () =>
    Effect.gen(function* () {
      process.env.TIDEPOOL_API_URL = 'http://example:9000';
      const ctx = yield* resolveContext(cfg, { flag: null });
      expect(ctx.kind).toBe('http');
      if (ctx.kind === 'http') expect(ctx.url).toBe('http://example:9000');
    }),
  );

  it.effect('falls back to file current-context (prod) with no flag/env', () =>
    Effect.gen(function* () {
      const ctx = yield* resolveContext(cfg, { flag: null });
      expect(ctx.name).toBe('prod');
    }),
  );

  it.effect('defaults to built-in local when nothing is set', () =>
    Effect.gen(function* () {
      const ctx = yield* resolveContext({ currentContext: null, contexts: {} }, { flag: null });
      expect(ctx.name).toBe('local');
      expect(ctx.kind).toBe('sqlite');
    }),
  );
});

describe('config management (CRUD + serialize round-trip)', () => {
  const base: ClientConfig = parseClientConfig(SAMPLE);

  it('serialize → parse round-trips a config with a port-forward context', () => {
    // Identity: writing then re-reading yields the same model (incl. port-forward).
    expect(parseClientConfig(serializeClientConfig(base))).toEqual(base);
    expect(base.contexts.prod?.kind).toBe('http');
    const prod = base.contexts.prod;
    if (prod?.kind === 'http') expect(prod.portForward).toBeDefined();
  });

  it('upsert adds then edits a context by name', () => {
    const added = upsertContext(base, { name: 'staging', kind: 'http', url: 'http://s:1' });
    expect(added.contexts.staging?.kind).toBe('http');
    const edited = upsertContext(added, { name: 'staging', kind: 'http', url: 'http://s:2' });
    const s = edited.contexts.staging;
    expect(s?.kind === 'http' && s.url).toBe('http://s:2');
  });

  it('deleting the current context clears the default (no dangling pointer)', () => {
    const after = deleteContext(base, 'prod');
    expect(after.contexts.prod).toBeUndefined();
    expect(after.currentContext).toBeNull();
  });

  it('deleting a non-current context leaves the default intact', () => {
    const after = deleteContext(base, 'local');
    expect(after.contexts.local).toBeUndefined();
    expect(after.currentContext).toBe('prod');
  });

  it('contextNames always includes the built-in local, sorted', () => {
    expect(contextNames({ currentContext: null, contexts: {} })).toEqual(['local']);
    expect(contextNames(base)).toEqual(['local', 'prod']);
  });

  it('setCurrentContext sets the default', () => {
    expect(setCurrentContext(base, 'local').currentContext).toBe('local');
  });
});

describe('describeContext', () => {
  it('names the backend target for each kind', () => {
    expect(describeContext({ name: 'local', kind: 'sqlite' })).toContain('sqlite');
    expect(describeContext({ name: 's', kind: 'http', url: 'http://h:1' })).toBe(
      'http → http://h:1',
    );
    expect(
      describeContext({
        name: 'p',
        kind: 'http',
        url: 'http://127.0.0.1:8080',
        portForward: {
          namespace: 'core',
          service: 'reconciler',
          remotePort: 8080,
        },
      }),
    ).toBe('http → port-forward core/reconciler:8080');
  });
});

describe('config write-path hardening (review fixes)', () => {
  it('a # inside a quoted url is not treated as a comment (round-trips)', () => {
    const cfg = parseClientConfig('[contexts.x]\nkind = "http"\nurl = "http://h/p#frag"\n');
    const x = cfg.contexts.x;
    expect(x?.kind === 'http' && x.url).toBe('http://h/p#frag');
  });

  it('a full-line comment is still stripped', () => {
    const cfg = parseClientConfig('# a comment\ncurrent-context = "local"\n');
    expect(cfg.currentContext).toBe('local');
  });

  it('rejects context names that would not round-trip', () => {
    expect(isValidContextName('prod')).toBe(true);
    expect(isValidContextName('my_prod-2')).toBe(true);
    expect(isValidContextName('my.prod')).toBe(false);
    expect(isValidContextName('has space')).toBe(false);
  });

  it('rejects values that cannot be serialized safely', () => {
    expect(isSerializableValue('http://h:8080')).toBe(true);
    expect(isSerializableValue('http://a"b')).toBe(false);
    expect(isSerializableValue('line\nbreak')).toBe(false);
  });
});

describe('resolveBaseUrl (ephemeral local port, tckt_39af8lic1l)', () => {
  // A fake `kubectl` on PATH stands in for the real binary: it prints the same
  // "Forwarding from 127.0.0.1:NNNNN -> <remote>" readiness line real kubectl
  // does, picking NNNNN from its own pid (so two concurrent fakes never agree
  // on a port — a stand-in for the OS assigning a free ephemeral port), then
  // idles until killed (mirrors a real tunnel's lifetime).
  let binDir: string;
  let origPath: string | undefined;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'fake-kubectl-'));
    const script = `#!/usr/bin/env bash
last="\${@: -1}"
remote="\${last##*:}"
port=$(( ($$ % 20000) + 20000 ))
echo "Forwarding from 127.0.0.1:\${port} -> \${remote}"
trap 'exit 0' TERM INT
while true; do sleep 1; done
`;
    writeFileSync(join(binDir, 'kubectl'), script, { mode: 0o755 });
    chmodSync(join(binDir, 'kubectl'), 0o755);
    origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = origPath;
    rmSync(binDir, { recursive: true, force: true });
  });

  const ctxOf = (name: string): Extract<ClientContext, { kind: 'http' }> => ({
    name,
    kind: 'http',
    url: 'http://127.0.0.1:8080',
    portForward: { namespace: 'core', service: 'reconciler', remotePort: 8080 },
  });

  it.effect('parses the actual bound port out of the forward, not a fixed value', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const url = yield* resolveBaseUrl(ctxOf('a'));
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        // The fake never binds 8080 itself — proves we read kubectl's own
        // stdout rather than echoing back the (now-removed) fixed config port.
        expect(url).not.toBe('http://127.0.0.1:8080');
      }),
    ).pipe(Effect.provide(BunContext.layer)),
  );

  it.effect('two concurrent resolves bind different local ports (no orphan collision)', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const [a, b] = yield* Effect.all([resolveBaseUrl(ctxOf('a')), resolveBaseUrl(ctxOf('b'))], {
          concurrency: 'unbounded',
        });
        expect(a).not.toBe(b);
      }),
    ).pipe(Effect.provide(BunContext.layer)),
  );
});
