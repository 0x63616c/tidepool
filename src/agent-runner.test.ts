import { assert, describe, it } from '@effect/vitest';
import { parseUsage, parseVerdict } from './agent-runner.ts';

/**
 * Usage parsing is the proof-of-real-work signal (`tp doctor` asserts non-zero
 * tokens), so it's a pure unit tested against the opencode SDK's real event
 * shape: `message.updated` events whose `properties.info` is an AssistantMessage
 * carrying `tokens.{input,output}`, `modelID`, `providerID`, and `time`.
 */

const assistantEvent = (over: Record<string, unknown> = {}) => ({
  type: 'message.updated',
  properties: {
    info: {
      id: 'msg_1',
      sessionID: 'ses_1',
      role: 'assistant',
      time: { created: 1000, completed: 3500 },
      modelID: 'gpt-5.4-mini',
      providerID: 'openai',
      cost: 0.012,
      tokens: { input: 1200, output: 340, reasoning: 0, cache: { read: 0, write: 0 } },
      ...over,
    },
  },
});

describe('parseUsage', () => {
  it('reads tokens, model (provider/model), and wall time from one assistant message', () => {
    const usage = parseUsage([assistantEvent()]);
    assert.strictEqual(usage.tokensIn, 1200);
    assert.strictEqual(usage.tokensOut, 340);
    assert.strictEqual(usage.model, 'openai/gpt-5.4-mini');
    assert.strictEqual(usage.wallTimeSec, 2.5);
  });

  it('keeps the LAST cumulative update per message id (does not double-count)', () => {
    const usage = parseUsage([
      assistantEvent({
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      assistantEvent({
        tokens: { input: 1200, output: 340, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ]);
    assert.strictEqual(usage.tokensIn, 1200);
    assert.strictEqual(usage.tokensOut, 340);
  });

  it('sums tokens across distinct messages', () => {
    const usage = parseUsage([
      assistantEvent({ id: 'msg_1' }),
      assistantEvent({
        id: 'msg_2',
        tokens: { input: 800, output: 60, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ]);
    assert.strictEqual(usage.tokensIn, 2000);
    assert.strictEqual(usage.tokensOut, 400);
  });

  it('ignores non-assistant and non-message.updated events', () => {
    const usage = parseUsage([
      { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      { type: 'message.updated', properties: { info: { role: 'user', id: 'u1' } } },
      assistantEvent(),
    ]);
    assert.strictEqual(usage.tokensIn, 1200);
    assert.strictEqual(usage.tokensOut, 340);
  });
});

describe('parseVerdict', () => {
  it('reads an explicit APPROVE marker', () => {
    assert.strictEqual(parseVerdict('Looks good.\nVERDICT: APPROVE'), 'approve');
  });

  it('reads an explicit REQUEST_CHANGES marker', () => {
    assert.strictEqual(parseVerdict('Needs work.\nVERDICT: REQUEST_CHANGES'), 'request_changes');
  });

  it('accepts loose spelling like "request changes"', () => {
    assert.strictEqual(parseVerdict('I would request changes here'), 'request_changes');
  });

  it('fails closed: request_changes when no verdict is present', () => {
    assert.strictEqual(parseVerdict('hmm, not sure'), 'request_changes');
  });

  it('fails closed: request_changes when both appear', () => {
    assert.strictEqual(
      parseVerdict('I would approve but actually REQUEST CHANGES'),
      'request_changes',
    );
  });
});
