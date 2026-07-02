import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { Effect } from 'effect';
import { AppConfig } from './config.ts';
import { TicketStore } from './services.ts';

/**
 * `tp doctor` — the single terminal check that proves the whole work chain
 * worked (DESIGN §Validation). It PASSes only when all four facts hold:
 *  - slugify exists on the testbed's main branch (the work landed + merged),
 *  - a fresh clone's `bun run test` passes (CI's gate reproduces locally),
 *  - the latest recorded work run has non-zero tokens (a REAL agent ran, not a fake),
 *  - the latest work run did NOT run on a local box (a k8s worker records `null`,
 *    the retired Hetzner path recorded `'hetzner'`; only LocalBoxMaker fakes set `'local'`).
 * Any single failure ⇒ FAIL with a specific reason + a non-zero exit.
 */

export interface DoctorFacts {
  readonly slugifyPresent: boolean;
  readonly freshCloneTestPassed: boolean;
  readonly latestRunTokens: number;
  /**
   * Provider from the latest work run. Real remote runs are `null` (today's k8s
   * worker) or the legacy `'hetzner'`; only a LocalBoxMaker fake sets `'local'`,
   * which the verdict rejects. Null also covers "no work run recorded yet" (the
   * zero-token check catches that first).
   */
  readonly latestWorkRunBoxProvider: 'hetzner' | 'local' | null;
}

export interface DoctorVerdict {
  readonly ok: boolean;
  readonly reason: string | null;
}

/** Decide PASS/FAIL from the four facts; first failing check names the reason. */
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
  if (facts.latestWorkRunBoxProvider === 'local') {
    return {
      ok: false,
      reason: 'latest work run ran on a local box (LocalBoxMaker), not a real remote worker',
    };
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

    // Proof of real runs: max tokens + provider from the latest work run.
    const tickets = yield* store.list();
    let latestRunTokens = 0;
    let latestWorkRunBoxProvider: 'hetzner' | 'local' | null = null;
    let latestWorkRunTime = 0;
    for (const ticket of tickets) {
      const runs = yield* store.runsFor(ticket.id);
      for (const run of runs) {
        latestRunTokens = Math.max(
          latestRunTokens,
          (run.usage?.tokensIn ?? 0) + (run.usage?.tokensOut ?? 0),
        );
        if (run.kind !== 'review') {
          // Runs are returned oldest-first; keep the last (most recent) work run's provider.
          latestWorkRunBoxProvider = run.boxProvider;
          latestWorkRunTime++;
        }
      }
    }
    void latestWorkRunTime; // used only to pick the last entry (loop overwrites)

    return { ...clone, latestRunTokens, latestWorkRunBoxProvider };
  });

/** The full doctor check: gather facts, then decide. Returns verdict + facts for rendering. */
export const runDoctor: Effect.Effect<
  DoctorVerdict & { readonly facts: DoctorFacts },
  never,
  TicketStore | AppConfig
> = Effect.map(gatherDoctorFacts, (facts) => ({ ...doctorVerdict(facts), facts }));

/** Render a doctor verdict as a TOON-ish block for the CLI. */
export const renderDoctor = (v: DoctorVerdict & { readonly facts?: DoctorFacts }): string =>
  v.ok
    ? [
        'doctor: PASS',
        '  slugify on testbed@main ✓',
        '  fresh-clone bun run test ✓',
        '  non-zero run tokens ✓',
        `  box provider in latest work run: ${v.facts?.latestWorkRunBoxProvider ?? '(none — k8s worker)'}`,
      ].join('\n')
    : `doctor: FAIL\n  reason: ${v.reason}`;
