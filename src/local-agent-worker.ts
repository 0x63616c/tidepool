import { Effect, Layer, Ref } from 'effect';
import { makeOpencodeAgentRunner, type OpencodeRunner } from './agent-runner.ts';
import { makeWorkHandle, type WorkHandle } from './domain.ts';
import {
  AgentWorker,
  CredentialBroker,
  DispatchOutcome,
  type WorkerCredentials,
  WorkStatus,
} from './services.ts';

/**
 * `LocalAgentWorker` — the live `AgentWorker` until k8s lands (PR-4/6). It runs
 * the opencode agent on THIS machine, synchronously, inside `dispatch`: the work
 * happens, its outcome is stored under a fresh `WorkHandle`, and `poll` replays
 * it as `Succeeded` on the next tick. This preserves today's local behavior
 * (the old `LocalBoxMaker` + in-process `AgentRunner`) behind the async seam —
 * a synchronous failure surfaces from `dispatch` (caught by the reconciler
 * before the ticket reaches `running`), so the `Failed` poll branch is reserved
 * for the real out-of-band k8s worker.
 *
 * Creds are resolved from the `CredentialBroker` at dispatch, keyed on the job —
 * never read inline — so this path never touches sops (tenet 9) and App-token /
 * rotation becomes a one-module swap (tenet 4).
 */

const LOCAL_BOX = { ip: '127.0.0.1' } as const;

/**
 * `LocalAgentWorker` factory. `makeRunner` is injected (defaulting to the real
 * opencode runner) so tests can drive `dispatch` with a scripted runner and
 * assert creds flowed broker → dispatch → runner without running an agent.
 */
export const makeLocalAgentWorker = (
  makeRunner: (creds: WorkerCredentials) => OpencodeRunner = makeOpencodeAgentRunner,
): Layer.Layer<AgentWorker, never, CredentialBroker> =>
  Layer.effect(
    AgentWorker,
    Effect.gen(function* () {
      const broker = yield* CredentialBroker;
      const outcomes = yield* Ref.make(new Map<WorkHandle, DispatchOutcome>());
      const counter = yield* Ref.make(0);
      return {
        dispatch: (input) =>
          Effect.gen(function* () {
            // The dispatch path's only cred source. A missing cred is a config
            // defect (as the old inline `githubToken.orDie` was), not a retryable
            // agent failure — so `orDie` keeps `dispatch`'s error channel intact.
            const creds = yield* broker
              .credsFor({ kind: input.kind, repo: input.repo, ticketId: input.ticket.id })
              .pipe(Effect.orDie);
            const runner = makeRunner(creds);
            const outcome: DispatchOutcome =
              input.kind === 'work'
                ? DispatchOutcome.Work({
                    result: yield* runner.work({
                      box: LOCAL_BOX,
                      ticket: input.ticket,
                      repo: input.repo,
                      base: input.base,
                      branch: input.branch,
                      model: input.model,
                    }),
                  })
                : DispatchOutcome.Review({
                    result: yield* runner.review({
                      box: LOCAL_BOX,
                      ticket: input.ticket,
                      repo: input.repo,
                      prNumber: input.prNumber,
                      model: input.model,
                    }),
                  });
            const n = yield* Ref.updateAndGet(counter, (c) => c + 1);
            const handle = makeWorkHandle(`wh_local_${input.kind}_${n}`);
            yield* Ref.update(outcomes, (m) => new Map(m).set(handle, outcome));
            return handle;
          }),
        poll: (handle) =>
          Effect.map(Ref.get(outcomes), (m) => {
            const outcome = m.get(handle);
            return outcome === undefined
              ? WorkStatus.Failed({ reason: `unknown handle ${handle}` })
              : WorkStatus.Succeeded({ outcome });
          }),
        cancel: (handle) =>
          Ref.update(outcomes, (m) => new Map([...m].filter(([h]) => h !== handle))),
        reap: () => Effect.succeed({ cancelled: [] }),
      };
    }),
  );

/** The live local worker, wired to the real opencode runner. */
export const LocalAgentWorker: Layer.Layer<AgentWorker, never, CredentialBroker> =
  makeLocalAgentWorker();
