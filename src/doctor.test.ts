import { assert, describe, it } from '@effect/vitest';
import { type DoctorFacts, doctorVerdict } from './doctor.ts';

/**
 * The doctor's decision core, tested against the four facts it consumes (the
 * gathering of those facts — clone, test, store query — is a thin seam above
 * this). PASS requires all four; each failure names its own reason.
 */

const pass: DoctorFacts = {
  slugifyPresent: true,
  freshCloneTestPassed: true,
  latestRunTokens: 150,
  latestWorkRunBoxId: 'box_abc123',
};

describe('doctorVerdict', () => {
  it('all four facts hold → ok', () => {
    assert.deepStrictEqual(doctorVerdict(pass), { ok: true, reason: null });
  });

  it('slugify missing → fail naming slugify', () => {
    const v = doctorVerdict({ ...pass, slugifyPresent: false });
    assert.isFalse(v.ok);
    assert.match(v.reason ?? '', /slugify/i);
  });

  it('fresh-clone test failed → fail naming the test', () => {
    const v = doctorVerdict({ ...pass, freshCloneTestPassed: false });
    assert.isFalse(v.ok);
    assert.match(v.reason ?? '', /test/i);
  });

  it('zero run tokens → fail naming tokens (proof of a real run)', () => {
    const v = doctorVerdict({ ...pass, latestRunTokens: 0 });
    assert.isFalse(v.ok);
    assert.match(v.reason ?? '', /token/i);
  });

  it('null box_id → fail naming box_id (Phase C proof)', () => {
    const v = doctorVerdict({ ...pass, latestWorkRunBoxId: null });
    assert.isFalse(v.ok);
    assert.match(v.reason ?? '', /box_id/i);
  });
});
