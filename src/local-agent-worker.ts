import { Effect, Layer, Ref } from 'effect';
import { makeOpencodeAgentRunner } from './agent-runner.ts';
import { makeWorkHandle, type WorkHandle } from './domain.ts';
import { githubToken } from './forge.ts';
import { AgentWorker, DispatchOutcome, WorkStatus } from './services.ts';

/**
 * `LocalAgentWorker` — the live `AgentWorker` until k8s lands (PR-4/6). It runs
 * the opencode agent on THIS machine, synchronously, inside `dispatch`: the work
 * happens, its outcome is stored under a fresh `WorkHandle`, and `poll` replays
 * it as `Succeeded` on the next tick. This preserves today's local behavior
 * (the old `LocalBoxMaker` + in-process `AgentRunner`) behind the async seam —
 * a synchronous failure surfaces from `dispatch` (caught by the reconciler
 * before the ticket reaches `running`), so the `Failed` poll branch is reserved
 * for the real out-of-band k8s worker.
 */

const LOCAL_BOX = { ip: '127.0.0.1' } as const;

export const LocalAgentWorker: Layer.Layer<AgentWorker> = Layer.effect(
  AgentWorker,
  Effect.gen(function* () {
    const token = yield* githubToken.pipe(Effect.orDie);
    const runner = makeOpencodeAgentRunner(token);
    const outcomes = yield* Ref.make(new Map<WorkHandle, DispatchOutcome>());
    const counter = yield* Ref.make(0);
    return {
      dispatch: (input) =>
        Effect.gen(function* () {
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
