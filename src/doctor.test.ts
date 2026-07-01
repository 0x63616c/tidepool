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
  latestWorkRunBoxProvider: 'hetzner',
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

  it('null box provider (a k8s worker run) → ok (a real remote run, not a local fake)', () => {
    assert.deepStrictEqual(doctorVerdict({ ...pass, latestWorkRunBoxProvider: null }), {
      ok: true,
      reason: null,
    });
  });

  it('hetzner box provider (legacy real worker) → ok', () => {
    assert.deepStrictEqual(doctorVerdict({ ...pass, latestWorkRunBoxProvider: 'hetzner' }), {
      ok: true,
      reason: null,
    });
  });

  it('local box provider → fail naming local (LocalBoxMaker is not a real remote worker)', () => {
    const v = doctorVerdict({ ...pass, latestWorkRunBoxProvider: 'local' });
    assert.isFalse(v.ok);
    assert.match(v.reason ?? '', /local/i);
  });
});
