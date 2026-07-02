import { FetchHttpClient } from '@effect/platform';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import type { Ticket } from './domain.ts';
import { k8sWorkerConfigLayer, makeK8sAgentWorker } from './k8s-agent-worker.ts';
import { AgentWorker, CredentialBroker, type DispatchInput, type WorkStatus } from './services.ts';

/**
 * K8sAgentWorker e2e — exercises the real wire path (dispatch → poll → harvest →
 * cancel) against an EPHEMERAL kind cluster reached via `kubectl proxy`
 * (127.0.0.1:8001, no TLS/token). The worker image is a stub that echoes a canned
 * `RunnerResult` and exits 0 — so there is NO LLM/GitHub spend, only real k8s
 * Job/Secret/pod-log mechanics. Gated on `K8S_E2E=1`; skipped in `bun run test`
 * and only run by the `k8s-e2e` CI job. See `.github/workflows/k8s-e2e.yml`.
 */

const RUN_E2E = process.env.K8S_E2E === '1';
// Non-`:latest` tag → default imagePullPolicy IfNotPresent → the kind-loaded
// local image is used (no registry pull).
const IMAGE = process.env.E2E_IMAGE ?? 'tidepool-e2e-stub:e2e';
const STUB_COMMIT = 'e2ecommit';

const ticket: Ticket = {
  id: 'tckt_e2e001' as Ticket['id'],
  title: 'e2e roundtrip',
  body: 'prove dispatch/poll/cancel',
  target: 'octo/repo',
  state: 'backlog',
  phase: 'queued',
  conditions: [],
  branch: null,
  prNumber: null,
  prId: null,
  mergeSha: null,
  attempts: 0,
  contentionCount: 0,
  workedAttempt: null,
  reason: null,
  workHandle: null,
  dispatchedAt: null,
};

const workInput: DispatchInput = {
  kind: 'work',
  ticket,
  repo: 'octo/repo',
  base: 'main',
  branch: 'tp/tckt_e2e001-roundtrip',
  model: 'stub/model',
};

const fakeBroker = Layer.succeed(CredentialBroker, {
  credsFor: () => Effect.succeed({ opencodeAuth: '{"stub":true}', githubToken: 'stub-token' }),
});

const configLayer = k8sWorkerConfigLayer({
  apiBaseUrl: process.env.K8S_API ?? 'http://127.0.0.1:8001',
  token: '',
  namespace: 'agents',
  image: IMAGE,
  // Small enough to schedule on a single kind node.
  cpuRequest: '100m',
  memRequest: '64Mi',
  activeDeadlineSeconds: 120,
  ttlSecondsAfterFinished: 60,
  gitSha: 'e2e',
});

// Deterministic-ish suffix so re-runs don't collide (Date is fine in app code).
const workerLayer = makeK8sAgentWorker({
  genSuffix: () => Date.now().toString(36).slice(-6),
}).pipe(Layer.provide(Layer.mergeAll(FetchHttpClient.layer, fakeBroker, configLayer)));

// `it.live` (not `it.effect`): this drives a REAL cluster, so it needs the live
// Clock — `it.effect`'s TestClock would freeze the poll `sleep`s (tenet 10: still
// an Effect-native test, just with real time).
describe.skipIf(!RUN_E2E)('K8sAgentWorker (kind e2e)', () => {
  it.live(
    'dispatches a Job, harvests its RunnerResult on success, then cancels',
    () =>
      Effect.gen(function* () {
        const worker = yield* AgentWorker;

        const handle = yield* worker.dispatch(workInput);
        expect(handle).toMatch(/^work-tckt-e2e001-/);

        // Poll until the Job leaves Running (stub finishes in seconds).
        const waitDone = (): Effect.Effect<WorkStatus> =>
          worker.poll(handle).pipe(
            Effect.flatMap((s) =>
              s._tag === 'Running'
                ? Effect.sleep('2 seconds').pipe(Effect.flatMap(() => waitDone()))
                : Effect.succeed(s),
            ),
            Effect.orDie,
          );
        const status = yield* waitDone().pipe(Effect.timeout('120 seconds'));

        expect(status._tag).toBe('Succeeded');
        if (status._tag === 'Succeeded') {
          expect(status.outcome._tag).toBe('Work');
          if (status.outcome._tag === 'Work') {
            expect(status.outcome.result.commitSha).toBe(STUB_COMMIT);
            expect(status.outcome.result.title).toContain('tckt_e2e001');
          }
        }

        // Cancel is idempotent and cascades the owned Secret via ownerReference.
        yield* worker.cancel(handle);
        yield* worker.reap();
        return handle;
      }).pipe(Effect.provide(workerLayer)),
    180_000,
  );
});
