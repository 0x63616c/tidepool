import { assert, describe, it } from '@effect/vitest';
import { isBlank, truncate } from './strings.ts';

describe('isBlank', () => {
  it('returns true for an empty string', () => {
    assert.isTrue(isBlank(''));
  });

  it('returns true for whitespace-only strings', () => {
    assert.isTrue(isBlank(' \t\n'));
  });

  it('returns false for non-blank strings', () => {
    assert.isFalse(isBlank(' tidepool '));
  });
});

describe('truncate', () => {
  it('returns the string unchanged when at or under the limit', () => {
    assert.strictEqual(truncate('short', 10), 'short');
    assert.strictEqual(truncate('exact', 5), 'exact');
  });

  it('cuts to `max` chars and appends an ellipsis marker when over the limit', () => {
    assert.strictEqual(truncate('this is way too long', 7), 'this is…');
  });

  it('never loses the fact that something was cut — the ellipsis is unconditional', () => {
    const long = 'x'.repeat(500);
    const result = truncate(long, 200);
    assert.strictEqual(result.length, 201);
    assert.isTrue(result.endsWith('…'));
  });
});
