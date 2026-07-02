import { FetchHttpClient } from '@effect/platform';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Layer, Logger } from 'effect';
import type { Ticket } from './domain.ts';
import {
  buildAgentWorkerConfig,
  buildJobManifest,
  buildSecretManifest,
  classifyJobStatus,
  harvestOutcome,
  type K8sWorkerConfig,
  k8sName,
  k8sWorkerConfigLayer,
  makeK8sAgentWorker,
  workHandleFor,
} from './k8s-agent-worker.ts';
import { AgentWorker, type AgentWorkerApi, CredentialBroker } from './services.ts';

/**
 * K8sAgentWorker — unit tests over the pure manifest/mapping helpers. No cluster:
 * every fact the reconciler relies on (Job shape, status → WorkStatus, log →
 * DispatchOutcome) is a total function tested in isolation. The wire layer is
 * covered by the kind e2e in CI (see `.github/workflows/`).
 */

const CFG: K8sWorkerConfig = {
  apiBaseUrl: 'https://k8s.test:6443',
  token: 'sa-token',
  namespace: 'agents',
  image: 'registry.test/agent-worker:abc123',
  command: ['bun', 'run', '/app/src/worker/agent-worker.ts'],
  cpuRequest: '2',
  memRequest: '2Gi',
  activeDeadlineSeconds: 1800,
  ttlSecondsAfterFinished: 600,
  gitSha: 'bcf78e0a1b2c3d4e5f60718293a4b5c6d7e8f901',
};

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'tckt_ab12cd' as Ticket['id'],
  title: 'Add slugify',
  body: 'add slugify(s)',
  target: 'octo/repo',
  state: 'backlog',
  branch: null,
  prNumber: null,
  prId: null,
  mergeSha: null,
  attempts: 0,
  workedAttempt: null,
  reason: null,
  workHandle: null,
  dispatchedAt: null,
  ...over,
});

const creds = { opencodeAuth: '{"openai":"auth"}', githubToken: 'ghs_tok' };

/** First element or throw — narrows away `T | undefined` from indexed access. */
const first = <T>(arr: ReadonlyArray<T>): T => {
  const [x] = arr;
  if (x === undefined) throw new Error('expected a non-empty array');
  return x;
};

const workInput = {
  kind: 'work' as const,
  ticket: ticket(),
  repo: 'octo/repo',
  base: 'main',
  branch: 'tp/tckt_ab12cd-add-slugify',
  model: 'openai/gpt-5',
};

const reviewInput = {
  kind: 'review' as const,
  ticket: ticket(),
  repo: 'octo/repo',
  prNumber: 7,
  model: 'openai/gpt-5',
};

describe('k8sName', () => {
  it('replaces sops-style underscores with dashes (DNS-1123)', () => {
    assert.strictEqual(k8sName('tckt_ab12cd'), 'tckt-ab12cd');
  });

  it('lowercases and strips invalid characters', () => {
    assert.strictEqual(k8sName('Tckt_AB.12/cd'), 'tckt-ab-12-cd');
  });

  it('output matches the DNS-1123 label charset', () => {
    assert.match(k8sName('tckt_ZZ_99'), /^[a-z0-9-]+$/);
  });
});

describe('workHandleFor', () => {
  it('builds a <kind>-<ticket>-<suffix> Job name', () => {
    assert.strictEqual(workHandleFor('work', 'tckt_ab12cd', 'x7q2'), 'work-tckt-ab12cd-x7q2');
    assert.strictEqual(workHandleFor('review', 'tckt_ab12cd', 'x7q2'), 'review-tckt-ab12cd-x7q2');
  });

  it('is a valid DNS-1123 label (<=63 chars, [a-z0-9-])', () => {
    const name = workHandleFor('review', 'tckt_verylongidentifier00', 'suffx1');
    assert.isAtMost(name.length, 63);
    assert.match(name, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });
});

describe('buildAgentWorkerConfig (config.json payload)', () => {
  it('builds a work config with a token-bearing clone URL and no bare token elsewhere', () => {
    const cfg = buildAgentWorkerConfig(workInput, creds);
    assert.strictEqual(cfg.kind, 'work');
    if (cfg.kind !== 'work') return;
    assert.strictEqual(cfg.cloneUrl, 'https://x-access-token:ghs_tok@github.com/octo/repo.git');
    assert.strictEqual(cfg.base, 'main');
    assert.strictEqual(cfg.branch, 'tp/tckt_ab12cd-add-slugify');
    assert.strictEqual(cfg.model, 'openai/gpt-5');
    assert.include(cfg.prompt, 'tckt_ab12cd');
    assert.include(cfg.commitMsg, 'tckt_ab12cd');
    assert.isString(cfg.dir);
  });

  it('builds a review config that embeds the diff in the prompt (no clone/token)', () => {
    const cfg = buildAgentWorkerConfig(reviewInput, creds, 'diff --git a b');
    assert.strictEqual(cfg.kind, 'review');
    if (cfg.kind !== 'review') return;
    assert.strictEqual(cfg.model, 'openai/gpt-5');
    assert.include(cfg.prompt, 'diff --git a b');
    assert.notInclude(JSON.stringify(cfg), 'ghs_tok');
  });
});

describe('buildJobManifest', () => {
  const handle = 'work-tckt-ab12cd-x7q2';
  const manifest = buildJobManifest({
    handle,
    config: CFG,
    input: workInput,
    annotations: { 'tidepool/pr-title': 'feat: x', 'tidepool/pr-body': 'goal' },
  });

  it('is a batch/v1 Job named after the handle in the agents namespace', () => {
    assert.strictEqual(manifest.apiVersion, 'batch/v1');
    assert.strictEqual(manifest.kind, 'Job');
    assert.strictEqual(manifest.metadata.name, handle);
    assert.strictEqual(manifest.metadata.namespace, 'agents');
  });

  it('carries the tidepool selector labels', () => {
    const l = manifest.metadata.labels;
    assert.strictEqual(l['app.kubernetes.io/part-of'], 'tidepool');
    assert.strictEqual(l['tidepool/role'], 'agent');
    assert.strictEqual(l['tidepool/kind'], 'work');
    assert.strictEqual(l['tidepool/ticket'], 'tckt_ab12cd');
  });

  it('stamps the reconciler git sha on the Job AND its pod template (kubectl -L)', () => {
    // The reconciler threads its own TIDEPOOL_GIT_SHA into K8sWorkerConfig so every
    // worker pod is greppable back to the commit that dispatched it.
    assert.strictEqual(manifest.metadata.labels['tidepool/git-sha'], CFG.gitSha);
    assert.strictEqual(manifest.spec.template.metadata.labels['tidepool/git-sha'], CFG.gitSha);
  });

  it('surfaces title/body as annotations (restart-safe harvest, no new stdout channel)', () => {
    assert.strictEqual(manifest.metadata.annotations['tidepool/pr-title'], 'feat: x');
    assert.strictEqual(manifest.metadata.annotations['tidepool/pr-body'], 'goal');
  });

  it('never retries: backoffLimit 0, restartPolicy Never', () => {
    assert.strictEqual(manifest.spec.backoffLimit, 0);
    assert.strictEqual(manifest.spec.template.spec.restartPolicy, 'Never');
  });

  it('bounds runtime and cleans up: activeDeadlineSeconds + ttlSecondsAfterFinished', () => {
    assert.strictEqual(manifest.spec.activeDeadlineSeconds, 1800);
    assert.strictEqual(manifest.spec.ttlSecondsAfterFinished, 600);
  });

  it('requests CPU with NO cpu limit; memory request == limit (OOM cap)', () => {
    const res = first(manifest.spec.template.spec.containers).resources;
    assert.strictEqual(res.requests.cpu, '2');
    assert.strictEqual(res.requests.memory, '2Gi');
    assert.strictEqual(res.limits.memory, '2Gi');
    assert.isUndefined(res.limits.cpu);
  });

  it('runs the configured image', () => {
    assert.strictEqual(first(manifest.spec.template.spec.containers).image, CFG.image);
  });

  it('mounts creds: auth.json at /secrets, config.json in the working dir', () => {
    const c = first(manifest.spec.template.spec.containers);
    const mounts = c.volumeMounts;
    const auth = mounts.find((m) => m.mountPath === '/secrets/auth.json');
    const conf = mounts.find((m) => m.subPath === 'config.json');
    assert.isDefined(auth);
    assert.strictEqual(auth?.subPath, 'auth.json');
    assert.isDefined(conf);
    assert.strictEqual(conf?.mountPath, `${c.workingDir}/config.json`);
    // the secret is projected by name == handle
    assert.strictEqual(first(manifest.spec.template.spec.volumes).secret.secretName, handle);
  });

  it('does not bake any secret value into the manifest', () => {
    assert.notInclude(JSON.stringify(manifest), 'ghs_tok');
    assert.notInclude(JSON.stringify(manifest), creds.opencodeAuth);
  });

  it('pins the configured command, ABSOLUTE, robust to the workingDir override', () => {
    // The image ENTRYPOINT is relative (`bun run src/worker/agent-worker.ts`) but
    // the Job overrides workingDir to the /work workspace (where the repo is cloned
    // and config.json is mounted). A relative entrypoint then resolves to
    // /work/src/... which does not exist → `Module not found` and silent dispatch
    // death. So prod config supplies an absolute command that ignores cwd.
    const c = first(manifest.spec.template.spec.containers);
    assert.deepStrictEqual(c.command, CFG.command);
    // The command must NOT live under the working dir it would be resolved against.
    assert.isFalse(c.command?.[2]?.startsWith(c.workingDir));
  });

  it('omits command when config has none, so the image ENTRYPOINT runs (kind-e2e stub)', () => {
    const stub = buildJobManifest({
      handle: 'work-tckt-abc-sfx1',
      config: { ...CFG, command: undefined },
      input: workInput,
      annotations: {},
    });
    assert.isUndefined(first(stub.spec.template.spec.containers).command);
  });
});

describe('buildSecretManifest', () => {
  const secret = buildSecretManifest({
    handle: 'work-tckt-ab12cd-x7q2',
    namespace: 'agents',
    jobUid: 'uid-123',
    configJson: '{"kind":"work"}',
    opencodeAuth: '{"openai":"auth"}',
    labels: { 'tidepool/ticket': 'tckt_ab12cd' },
  });

  it('is an Opaque v1 Secret named after the handle with both keys', () => {
    assert.strictEqual(secret.apiVersion, 'v1');
    assert.strictEqual(secret.kind, 'Secret');
    assert.strictEqual(secret.type, 'Opaque');
    assert.strictEqual(secret.metadata.name, 'work-tckt-ab12cd-x7q2');
    assert.property(secret.stringData, 'config.json');
    assert.property(secret.stringData, 'auth.json');
  });

  it('is owned by the Job so k8s GC removes it on Job deletion', () => {
    const owner = first(secret.metadata.ownerReferences);
    assert.strictEqual(owner.kind, 'Job');
    assert.strictEqual(owner.uid, 'uid-123');
    assert.strictEqual(owner.name, 'work-tckt-ab12cd-x7q2');
    assert.strictEqual(owner.blockOwnerDeletion, true);
  });
});

describe('classifyJobStatus', () => {
  it('running while active with no terminal count', () => {
    assert.strictEqual(classifyJobStatus({ active: 1 }).phase, 'running');
    assert.strictEqual(classifyJobStatus({}).phase, 'running');
  });

  it('succeeded when succeeded >= 1', () => {
    assert.strictEqual(classifyJobStatus({ succeeded: 1 }).phase, 'succeeded');
  });

  it('failed when failed >= 1, surfacing the condition reason', () => {
    const c = classifyJobStatus({
      failed: 1,
      conditions: [
        { type: 'Failed', status: 'True', reason: 'DeadlineExceeded', message: 'too slow' },
      ],
    });
    assert.strictEqual(c.phase, 'failed');
    assert.include(c.reason, 'DeadlineExceeded');
  });
});

describe('harvestOutcome', () => {
  const runnerLine = JSON.stringify({
    commitSha: 'deadbeef',
    usage: { model: 'openai/gpt-5', tokensIn: 10, tokensOut: 20, wallTimeSec: 3 },
  });
  const reviewLine = JSON.stringify({
    text: 'looks good\nVERDICT: APPROVE',
    usage: { model: 'openai/gpt-5', tokensIn: 5, tokensOut: 6, wallTimeSec: 1 },
  });

  it('maps a work RunnerResult line + annotations to DispatchOutcome.Work', () => {
    const logs = `starting\nnoise\n${runnerLine}\n`;
    const outcome = Effect.runSync(
      harvestOutcome({
        kind: 'work',
        logs,
        annotations: { 'tidepool/pr-title': 'feat: Add slugify', 'tidepool/pr-body': 'the goal' },
      }),
    );
    assert.strictEqual(outcome._tag, 'Work');
    if (outcome._tag !== 'Work') return;
    assert.strictEqual(outcome.result.commitSha, 'deadbeef');
    assert.strictEqual(outcome.result.title, 'feat: Add slugify');
    assert.strictEqual(outcome.result.body, 'the goal');
    assert.strictEqual(outcome.result.usage.tokensIn, 10);
  });

  it('maps a review ReviewRunnerResult line to DispatchOutcome.Review with a parsed verdict', () => {
    const outcome = Effect.runSync(
      harvestOutcome({ kind: 'review', logs: `hello\n${reviewLine}`, annotations: {} }),
    );
    assert.strictEqual(outcome._tag, 'Review');
    if (outcome._tag !== 'Review') return;
    assert.strictEqual(outcome.result.verdict, 'approve');
  });

  it('takes the LAST json line (result is the final stdout line)', () => {
    const stale = JSON.stringify({ commitSha: 'stale', usage: runnerLineUsage() });
    const logs = `${stale}\n${runnerLine}`;
    const outcome = Effect.runSync(
      harvestOutcome({
        kind: 'work',
        logs,
        annotations: { 'tidepool/pr-title': 't', 'tidepool/pr-body': 'b' },
      }),
    );
    assert.strictEqual(outcome._tag === 'Work' && outcome.result.commitSha, 'deadbeef');
  });

  it('skips a trailing invalid-JSON line and uses the last VALID result line', () => {
    // A later log line can also start with `{` but not be a RunnerResult; the
    // newest VALID decode wins, not merely the newest `{`-prefixed line.
    const logs = `${runnerLine}\n{ not valid json`;
    const outcome = Effect.runSync(
      harvestOutcome({
        kind: 'work',
        logs,
        annotations: { 'tidepool/pr-title': 't', 'tidepool/pr-body': 'b' },
      }),
    );
    assert.strictEqual(outcome._tag === 'Work' && outcome.result.commitSha, 'deadbeef');
  });

  it('fails with AgentFailed when no result line is present', () => {
    const exit = Effect.runSyncExit(
      harvestOutcome({ kind: 'work', logs: 'no json here\njust logs', annotations: {} }),
    );
    assert.isTrue(Exit.isFailure(exit));
  });
});

function runnerLineUsage() {
  return { model: 'm', tokensIn: 1, tokensOut: 1, wallTimeSec: 1 };
}

/**
 * Wire tests over the real `@effect/platform` Fetch client with `globalThis.fetch`
 * stubbed per-test — exercises the dispatch/poll/cancel error paths without a cluster.
 */
describe('K8sAgentWorker (wire)', () => {
  const wireCfg: K8sWorkerConfig = { ...CFG, apiBaseUrl: 'https://k8s.test' };
  const fakeBroker = Layer.succeed(CredentialBroker, {
    credsFor: () => Effect.succeed({ opencodeAuth: '{"a":1}', githubToken: 'ghs_tok' }),
  });
  const workerLayer = makeK8sAgentWorker({ genSuffix: () => 'sfx1' }).pipe(
    Layer.provide(Layer.mergeAll(FetchHttpClient.layer, fakeBroker, k8sWorkerConfigLayer(wireCfg))),
  );
  const runWorker = <A, E>(f: (w: AgentWorkerApi) => Effect.Effect<A, E>) =>
    AgentWorker.pipe(Effect.flatMap(f), Effect.provide(workerLayer), Effect.runPromiseExit);
  // Capture logs so cancel's "log, don't swallow" behavior is assertable.
  const runWorkerCapturing = <A, E>(f: (w: AgentWorkerApi) => Effect.Effect<A, E>) => {
    const logs: string[] = [];
    const capture = Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ message }) => {
        logs.push(String(message));
      }),
    );
    return AgentWorker.pipe(
      Effect.flatMap(f),
      Effect.provide(workerLayer),
      Effect.provide(capture),
      Effect.runPromiseExit,
    ).then((exit) => ({ exit, logs }));
  };

  const HANDLE = 'work-tckt-ab12cd-sfx1';
  const method = (init?: { method?: string }) => init?.method ?? 'GET';

  const stub = (
    handler: (url: string, m: string) => Response,
    calls: string[],
  ): typeof globalThis.fetch =>
    ((url: string | URL, init?: RequestInit) => {
      const m = method(init as { method?: string });
      calls.push(`${m} ${String(url)}`);
      return Promise.resolve(handler(String(url), m));
    }) as typeof fetch;

  it('dispatch fails hard AND deletes the Job when the created Job has no uid', async () => {
    const orig = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = stub((_url, m) => {
      if (m === 'POST') return new Response(JSON.stringify({ metadata: {} }), { status: 201 });
      return new Response('{}', { status: 200 });
    }, calls);
    const exit = await runWorker((w) => w.dispatch(workInput));
    globalThis.fetch = orig;

    assert.isTrue(Exit.isFailure(exit));
    // No Secret was created; the orphan Job was deleted.
    assert.isFalse(calls.some((c) => c.includes('/secrets')));
    assert.isTrue(calls.some((c) => c.startsWith(`DELETE https://k8s.test`) && c.includes(HANDLE)));
  });

  it('dispatch deletes the orphan Job when the Secret create fails', async () => {
    const orig = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = stub((url, m) => {
      if (m === 'POST' && url.includes('/jobs'))
        return new Response(JSON.stringify({ metadata: { uid: 'u1' } }), { status: 201 });
      if (m === 'POST' && url.includes('/secrets'))
        return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
      return new Response('{}', { status: 200 });
    }, calls);
    const exit = await runWorker((w) => w.dispatch(workInput));
    globalThis.fetch = orig;

    assert.isTrue(Exit.isFailure(exit));
    assert.isTrue(calls.some((c) => c.startsWith('DELETE') && c.includes(HANDLE)));
  });

  it('dispatch returns the handle when Job + Secret both create', async () => {
    const orig = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = stub((url, m) => {
      if (m === 'POST' && url.includes('/jobs'))
        return new Response(JSON.stringify({ metadata: { uid: 'u1' } }), { status: 201 });
      return new Response('{}', { status: 201 });
    }, calls);
    const exit = await runWorker((w) => w.dispatch(workInput));
    globalThis.fetch = orig;

    assert.isTrue(Exit.isSuccess(exit));
    if (Exit.isSuccess(exit)) assert.strictEqual(exit.value, HANDLE);
  });

  it('poll maps a 404 Job to terminal Failed (ttl-reap race), not AgentFailed', async () => {
    const orig = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = stub(() => new Response('{}', { status: 404 }), calls);
    const exit = await runWorker((w) =>
      w.poll(workHandleFor('work', 'tckt_ab12cd', 'sfx1') as never),
    );
    globalThis.fetch = orig;

    assert.isTrue(Exit.isSuccess(exit));
    if (Exit.isSuccess(exit)) {
      assert.strictEqual(exit.value._tag, 'Failed');
      if (exit.value._tag === 'Failed') assert.include(exit.value.reason, 'not found');
    }
  });

  it('dispatch names the Job deterministically by ticket attempt: a same-attempt re-dispatch reuses the exact same Job name (crash-window idempotency)', async () => {
    const orig = globalThis.fetch;
    const bodies: string[] = [];
    globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
      const m = method(init as { method?: string });
      if (m === 'POST' && String(url).includes('/jobs') && typeof init?.body === 'string') {
        bodies.push(init.body);
        return Promise.resolve(
          new Response(JSON.stringify({ metadata: { uid: 'u1' } }), { status: 201 }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 201 }));
    }) as typeof fetch;

    // Deliberately NOT overriding genSuffix — exercises the real default, keyed on
    // `ticket.attempts` rather than `Math.random()`.
    const defaultSuffixLayer = makeK8sAgentWorker().pipe(
      Layer.provide(
        Layer.mergeAll(FetchHttpClient.layer, fakeBroker, k8sWorkerConfigLayer(wireCfg)),
      ),
    );
    const run = <A, E>(f: (w: AgentWorkerApi) => Effect.Effect<A, E>) =>
      AgentWorker.pipe(
        Effect.flatMap(f),
        Effect.provide(defaultSuffixLayer),
        Effect.runPromiseExit,
      );

    await run((w) => w.dispatch(workInput));
    await run((w) => w.dispatch(workInput));
    globalThis.fetch = orig;

    assert.strictEqual(bodies.length, 2);
    const name1 = (JSON.parse(bodies[0] as string) as { metadata: { name: string } }).metadata.name;
    const name2 = (JSON.parse(bodies[1] as string) as { metadata: { name: string } }).metadata.name;
    assert.strictEqual(name1, name2, 'same ticket + same attempt must produce the same Job name');
  });

  it('dispatch treats a 409 Job create as idempotent: GETs the existing Job and proceeds to the Secret', async () => {
    const orig = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = stub((url, m) => {
      if (m === 'POST' && url.includes('/jobs'))
        return new Response(JSON.stringify({ message: 'already exists' }), { status: 409 });
      if (m === 'GET' && url.includes('/jobs/') && url.includes(HANDLE))
        return new Response(JSON.stringify({ metadata: { uid: 'u1' } }), { status: 200 });
      if (m === 'POST' && url.includes('/secrets')) return new Response('{}', { status: 201 });
      return new Response('{}', { status: 200 });
    }, calls);
    const exit = await runWorker((w) => w.dispatch(workInput));
    globalThis.fetch = orig;

    assert.isTrue(Exit.isSuccess(exit));
    if (Exit.isSuccess(exit)) assert.strictEqual(exit.value, HANDLE);
    assert.isTrue(calls.some((c) => c.startsWith('GET') && c.includes(HANDLE)));
  });

  it('dispatch treats a 409 Secret create as idempotent success (crash-retry already created it), with no orphan delete', async () => {
    const orig = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = stub((url, m) => {
      if (m === 'POST' && url.includes('/jobs'))
        return new Response(JSON.stringify({ metadata: { uid: 'u1' } }), { status: 201 });
      if (m === 'POST' && url.includes('/secrets'))
        return new Response(JSON.stringify({ message: 'already exists' }), { status: 409 });
      return new Response('{}', { status: 200 });
    }, calls);
    const exit = await runWorker((w) => w.dispatch(workInput));
    globalThis.fetch = orig;

    assert.isTrue(Exit.isSuccess(exit));
    if (Exit.isSuccess(exit)) assert.strictEqual(exit.value, HANDLE);
    assert.isFalse(calls.some((c) => c.startsWith('DELETE')));
  });

  it('cancel: void-success on both 404 and 500, but a 500 is LOGGED (not silently swallowed)', async () => {
    const orig = globalThis.fetch;

    globalThis.fetch = stub(() => new Response('{}', { status: 404 }), []);
    const gone = await runWorkerCapturing((w) => w.cancel(HANDLE as never));

    globalThis.fetch = stub(() => new Response('{}', { status: 500 }), []);
    const failed = await runWorkerCapturing((w) => w.cancel(HANDLE as never));
    globalThis.fetch = orig;

    // Both are void-success (the seam has no error channel for cancel)...
    assert.isTrue(Exit.isSuccess(gone.exit));
    assert.isTrue(Exit.isSuccess(failed.exit));
    // ...but a gone Job (404) is silent while a real failure (500) is surfaced.
    assert.isFalse(gone.logs.some((l) => l.includes(HANDLE)));
    assert.isTrue(failed.logs.some((l) => l.includes(HANDLE)));
  });
});
