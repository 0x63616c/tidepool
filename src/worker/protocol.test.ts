import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { RunnerConfig, RunnerResult } from './protocol.ts';

/**
 * The runner protocol is the wire contract between the orchestrator (which
 * writes config.json + reads the result line) and the bun-built runner on the
 * box. Both ends decode/encode through these schemas — never `JSON.parse ... as`
 * — so a shape drift fails loudly at the boundary instead of corrupting a run.
 */

const config = {
  cloneUrl: 'https://x-access-token:tok@github.com/o/r.git',
  base: 'main',
  branch: 'tp/tckt_x-do-thing',
  dir: '/tmp/tp-work-x',
  model: 'openai/gpt-5.4-mini',
  prompt: 'do the thing',
  commitMsg: '#tckt_x feat: do the thing',
};

describe('RunnerConfig', () => {
  it('decodes a config JSON string into the typed config the runner needs', () => {
    const decoded = Effect.runSync(
      Schema.decode(Schema.parseJson(RunnerConfig))(JSON.stringify(config)),
    );
    assert.deepStrictEqual(decoded, config);
  });

  it('rejects a config missing a required field', () => {
    const bad = JSON.stringify({ ...config, prompt: undefined });
    const result = Effect.runSync(
      Schema.decode(Schema.parseJson(RunnerConfig))(bad).pipe(Effect.either),
    );
    assert.strictEqual(result._tag, 'Left');
  });
});

describe('RunnerResult', () => {
  const usage = { model: 'openai/gpt-5.4-mini', tokensIn: 1200, tokensOut: 340, wallTimeSec: 2.5 };
  const result = { commitSha: 'abc123', usage };

  it('round-trips a result through encode → decode (the single stdout line)', () => {
    const line = Effect.runSync(Schema.encode(Schema.parseJson(RunnerResult))(result));
    assert.strictEqual(line.includes('\n'), false);
    const back = Effect.runSync(Schema.decode(Schema.parseJson(RunnerResult))(line));
    assert.deepStrictEqual(back, result);
  });

  it('rejects a result whose usage violates the domain schema (negative tokens)', () => {
    const bad = JSON.stringify({ commitSha: 'abc', usage: { ...usage, tokensIn: -1 } });
    const decoded = Effect.runSync(
      Schema.decode(Schema.parseJson(RunnerResult))(bad).pipe(Effect.either),
    );
    assert.strictEqual(decoded._tag, 'Left');
  });
});
