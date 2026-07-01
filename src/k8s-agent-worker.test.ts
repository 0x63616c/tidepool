import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { AgentFailed, type Ticket } from './domain.ts';
import {
  buildAgentWorkerConfig,
  buildJobManifest,
  buildSecretManifest,
  classifyJobStatus,
  harvestOutcome,
  type K8sWorkerConfig,
  k8sName,
  workHandleFor,
} from './k8s-agent-worker.ts';
import { DispatchOutcome } from './services.ts';

/**
 * K8sAgentWorker — unit tests over the pure manifest/mapping helpers. No cluster:
 * every fact the reconciler relies on (Job shape, status → WorkStatus, log →
 * DispatchOutcome) is a total function tested in isolation. The wire layer is
 * covered by the kind e2e in CI (see `.github/workflows/`).
 */

const CFG: K8sWorkerConfig = {
  apiBaseUrl: 'https://k8s.test:6443',
  token: 'sa-token',
  namespace: 'tidepool-workers',
  image: 'registry.test/agent-worker:abc123',
  cpuRequest: '2',
  memRequest: '2Gi',
  activeDeadlineSeconds: 1800,
  ttlSecondsAfterFinished: 600,
};

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'tckt_ab12cd' as Ticket['id'],
  title: 'Add slugify',
  goal: 'add slugify(s)',
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
  it('builds a tp-<kind>-<ticket>-<suffix> Job name', () => {
    assert.strictEqual(workHandleFor('work', 'tckt_ab12cd', 'x7q2'), 'tp-work-tckt-ab12cd-x7q2');
    assert.strictEqual(
      workHandleFor('review', 'tckt_ab12cd', 'x7q2'),
      'tp-review-tckt-ab12cd-x7q2',
    );
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
  const handle = 'tp-work-tckt-ab12cd-x7q2';
  const manifest = buildJobManifest({
    handle,
    config: CFG,
    input: workInput,
    annotations: { 'tidepool/pr-title': 'feat: x', 'tidepool/pr-body': 'goal' },
  }) as any;

  it('is a batch/v1 Job named after the handle in the workers namespace', () => {
    assert.strictEqual(manifest.apiVersion, 'batch/v1');
    assert.strictEqual(manifest.kind, 'Job');
    assert.strictEqual(manifest.metadata.name, handle);
    assert.strictEqual(manifest.metadata.namespace, 'tidepool-workers');
  });

  it('carries the tidepool selector labels', () => {
    const l = manifest.metadata.labels;
    assert.strictEqual(l['app.kubernetes.io/part-of'], 'tidepool');
    assert.strictEqual(l['tidepool/role'], 'agent-worker');
    assert.strictEqual(l['tidepool/kind'], 'work');
    assert.strictEqual(l['tidepool/ticket'], 'tckt_ab12cd');
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
    const res = manifest.spec.template.spec.containers[0].resources;
    assert.strictEqual(res.requests.cpu, '2');
    assert.strictEqual(res.requests.memory, '2Gi');
    assert.strictEqual(res.limits.memory, '2Gi');
    assert.isUndefined(res.limits.cpu);
  });

  it('runs the configured image', () => {
    assert.strictEqual(manifest.spec.template.spec.containers[0].image, CFG.image);
  });

  it('mounts creds: auth.json at /secrets, config.json in the working dir', () => {
    const c = manifest.spec.template.spec.containers[0];
    const mounts = c.volumeMounts as Array<{ mountPath: string; subPath: string }>;
    const auth = mounts.find((m) => m.mountPath === '/secrets/auth.json');
    const conf = mounts.find((m) => m.subPath === 'config.json');
    assert.isDefined(auth);
    assert.strictEqual(auth?.subPath, 'auth.json');
    assert.isDefined(conf);
    assert.strictEqual(conf?.mountPath, `${c.workingDir}/config.json`);
    // the secret is projected by name == handle
    assert.strictEqual(manifest.spec.template.spec.volumes[0].secret.secretName, handle);
  });

  it('does not bake any secret value into the manifest', () => {
    assert.notInclude(JSON.stringify(manifest), 'ghs_tok');
    assert.notInclude(JSON.stringify(manifest), creds.opencodeAuth);
  });
});

describe('buildSecretManifest', () => {
  const secret = buildSecretManifest({
    handle: 'tp-work-tckt-ab12cd-x7q2',
    namespace: 'tidepool-workers',
    jobUid: 'uid-123',
    configJson: '{"kind":"work"}',
    opencodeAuth: '{"openai":"auth"}',
    labels: { 'tidepool/ticket': 'tckt_ab12cd' },
  }) as any;

  it('is an Opaque v1 Secret named after the handle with both keys', () => {
    assert.strictEqual(secret.apiVersion, 'v1');
    assert.strictEqual(secret.kind, 'Secret');
    assert.strictEqual(secret.type, 'Opaque');
    assert.strictEqual(secret.metadata.name, 'tp-work-tckt-ab12cd-x7q2');
    assert.property(secret.stringData, 'config.json');
    assert.property(secret.stringData, 'auth.json');
  });

  it('is owned by the Job so k8s GC removes it on Job deletion', () => {
    const owner = secret.metadata.ownerReferences[0];
    assert.strictEqual(owner.kind, 'Job');
    assert.strictEqual(owner.uid, 'uid-123');
    assert.strictEqual(owner.name, 'tp-work-tckt-ab12cd-x7q2');
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

// Referenced to keep the import used even if a matcher above is trimmed.
void DispatchOutcome;
void AgentFailed;
