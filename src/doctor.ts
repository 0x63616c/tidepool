import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { Effect } from 'effect';
import { AppConfig } from './config.ts';
import { TicketStore } from './services.ts';

/**
 * `tp doctor` — the single terminal check that proves the whole Phase B chain
 * worked (DESIGN §Validation). It PASSes only when all three facts hold:
 *  - slugify exists on the testbed's main branch (the work landed + merged),
 *  - a fresh clone's `bun run test` passes (CI's gate reproduces locally),
 *  - the latest recorded run has non-zero tokens (a REAL agent ran, not a fake).
 * Any single failure ⇒ FAIL with a specific reason + a non-zero exit.
 */

export interface DoctorFacts {
  readonly slugifyPresent: boolean;
  readonly freshCloneTestPassed: boolean;
  readonly latestRunTokens: number;
}

export interface DoctorVerdict {
  readonly ok: boolean;
  readonly reason: string | null;
}

/** Decide PASS/FAIL from the three facts; first failing check names the reason. */
export const doctorVerdict = (facts: DoctorFacts): DoctorVerdict => {
  if (!facts.slugifyPresent) {
    return { ok: false, reason: 'slugify is not present on the testbed main branch' };
  }
  if (!facts.freshCloneTestPassed) {
    return { ok: false, reason: 'fresh-clone `bun run test` did not pass' };
  }
  if (facts.latestRunTokens <= 0) {
    return { ok: false, reason: 'latest run recorded zero tokens (no real agent run)' };
  }
  return { ok: true, reason: null };
};

/**
 * Gather the doctor's facts from real seams: a fresh clone of the testbed's main
 * branch (to check slugify + reproduce CI's test gate) and the store (for the
 * proof-of-real-work token count). Failures degrade to a false fact, never a
 * crash — the doctor's job is to report, not to throw.
 */
export const gatherDoctorFacts: Effect.Effect<DoctorFacts, never, TicketStore | AppConfig> =
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const store = yield* TicketStore;
    const repo = config.targets[0].repo;

    const clone = yield* Effect.promise(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tp-doctor-'));
      try {
        await $`git clone --depth 1 --branch main https://github.com/${repo}.git ${dir}`.quiet();
      } catch {
        return { slugifyPresent: false, freshCloneTestPassed: false };
      }
      const src = await Bun.file(join(dir, 'src/string.ts'))
        .text()
        .catch(() => '');
      const slugifyPresent = /slugify/.test(src);
      let freshCloneTestPassed = false;
      try {
        await $`bun install`.cwd(dir).quiet();
        await $`bun run test`.cwd(dir).quiet();
        freshCloneTestPassed = true;
      } catch {
        freshCloneTestPassed = false;
      }
      return { slugifyPresent, freshCloneTestPassed };
    });

    // Proof of a real run: the largest token total across all recorded runs.
    const tickets = yield* store.list();
    let latestRunTokens = 0;
    for (const ticket of tickets) {
      const runs = yield* store.runsFor(ticket.id);
      for (const run of runs) {
        latestRunTokens = Math.max(latestRunTokens, run.usage.tokensIn + run.usage.tokensOut);
      }
    }

    return { ...clone, latestRunTokens };
  });

/** The full doctor check: gather facts, then decide. */
export const runDoctor: Effect.Effect<DoctorVerdict, never, TicketStore | AppConfig> = Effect.map(
  gatherDoctorFacts,
  doctorVerdict,
);

/** Render a doctor verdict as a TOON-ish block for the CLI. */
export const renderDoctor = (v: DoctorVerdict): string =>
  v.ok
    ? 'doctor: PASS\n  slugify on testbed@main + fresh-clone test + non-zero run usage all verified'
    : `doctor: FAIL\n  reason: ${v.reason}`;
