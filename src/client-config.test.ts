import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { type ClientConfig, parseClientConfig, resolveContext } from './client-config.ts';

const SAMPLE = `
current-context = "prod"

[contexts.prod]
kind = "http"
url = "http://127.0.0.1:8080"
namespace = "core"
service = "reconciler"
remote-port = 8080
local-port = 8080

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
      expect(prod.portForward?.localPort).toBe(8080);
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
