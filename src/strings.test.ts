import { assert, describe, it } from '@effect/vitest';
import { isBlank } from './strings.ts';

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
