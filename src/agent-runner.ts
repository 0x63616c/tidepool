import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpencodeClient, createOpencodeServer } from '@opencode-ai/sdk';
import { $ } from 'bun';
import { Effect, Schema } from 'effect';
import { AgentFailed, RateCapped, type ReviewVerdict, type Ticket, type Usage } from './domain.ts';
import { parseRepo } from './forge.ts';
import type { ReviewResult, WorkerCredentials, WorkResult } from './services.ts';

/**
 * The local opencode driver, behind the `AgentWorker` seam (not a `Context.Tag`
 * itself). `LocalAgentWorker` calls this to run an agent on this machine; the
 * dead SSH remote-work path (`box.ip !== '127.0.0.1'`) is retired in PR-7.
 */
export interface OpencodeWorkInput {
  readonly box: { readonly ip: string };
  readonly ticket: Ticket;
  readonly repo: string;
  readonly base: string;
  readonly branch: string;
  readonly model: string;
}
export interface OpencodeReviewInput {
  readonly box: { readonly ip: string };
  readonly ticket: Ticket;
  readonly repo: string;
  readonly prNumber: number;
  readonly model: string;
}
export interface OpencodeRunner {
  readonly work: (input: OpencodeWorkInput) => Effect.Effect<WorkResult, AgentFailed | RateCapped>;
  readonly review: (
    input: OpencodeReviewInput,
  ) => Effect.Effect<ReviewResult, AgentFailed | RateCapped>;
}

import { ReviewRunnerResult, RunnerResult } from './worker/protocol.ts';
import { preCommitCommands } from './worker/runner-core.ts';
import { parseUsage } from './worker/usage.ts';

// Usage parsing lives in the worker module so the in-process runner and the
// bun-built remote runner share one typed rollup (no hand-copied JS duplicate).
// Re-exported so existing callers/tests keep importing it from this module.
export { parseUsage };

/**
 * Extract the review verdict from the agent's free text. Fail-closed: anything
 * ambiguous — no marker, or both signals present — is `request_changes`, so a
 * murky review can never auto-merge. `request_changes` is checked first for that
 * reason.
 */
export const parseVerdict = (text: string): ReviewVerdict => {
  const upper = text.toUpperCase();
  if (/REQUEST[\s_-]?CHANGES/.test(upper)) return 'request_changes';
  if (/\bAPPROVED?\b/.test(upper)) return 'approve';
  return 'request_changes';
};

/**
 * The commit the runner writes after the agent edits files. The runner owns the
 * message (not the agent) so the graded standard — ticket id first, then a
 * conventional subject — holds mechanically every time.
 */
export const commitMessage = (ticket: { readonly id: string; readonly title: string }): string =>
  `#${ticket.id} feat: ${ticket.title}`;

// ── opencode orchestration ───────────────────────────────────────────────────

/** PR title/body are derived from the ticket so they're deterministic. */
const workTitle = (ticket: Ticket): string => `feat: ${ticket.title} (${ticket.id})`;
const workBody = (ticket: Ticket): string => ticket.goal;

/** Split a `provider/model` config string into the SDK's `{providerID, modelID}`. */
const splitModel = (model: string): { providerID: string; modelID: string } => {
  const i = model.indexOf('/');
  return i < 0
    ? { providerID: 'openai', modelID: model }
    : { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
};

const STANDARDS =
  'Follow the repo conventions. Make the smallest change that satisfies the goal and add/keep tests green. Do not touch CI or unrelated files.';

const workPrompt = (ticket: Ticket): string =>
  [
    `You are the work agent for ticket ${ticket.id}.`,
    `Goal: ${ticket.goal}`,
    STANDARDS,
    'Implement the goal directly in this repository. Do not commit or push — the harness handles git.',
  ].join('\n\n');

const reviewPrompt = (ticket: Ticket, diff: string): string =>
  [
    `You are the review agent for ticket ${ticket.id}.`,
    `Goal: ${ticket.goal}`,
    'Grade the diff below against the goal. Reply with a short justification, then a final line exactly "VERDICT: APPROVE" or "VERDICT: REQUEST_CHANGES".',
    '--- DIFF ---',
    diff,
  ].join('\n\n');

/**
 * The slice of `fetch` the diff fetch needs. Narrowing it (vs the full `fetch`
 * type) keeps the port trivially fakeable in tests without `as` casts.
 */
type HttpGet = (
  url: string,
  init: { readonly headers: Record<string, string> },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
}>;

/**
 * Fetch a PR's unified diff with the runner's OWN token over the REST diff media
 * type. Deliberately NOT `gh pr diff`: `gh` authenticates through its GraphQL
 * path and rejects the installation token that git-clone + REST accept, so on the
 * control box review died with `HTTP 401 → ShellError exit 1` while work (git
 * clone, same token) succeeded. This routes review through the same token +
 * REST transport the forge already uses, so it has no `gh`/keyring/cwd
 * dependency. Throws on non-2xx; the caller maps it onto `AgentFailed`.
 */
export const fetchPrDiff = async (
  input: { readonly token: string; readonly repo: string; readonly prNumber: number },
  http: HttpGet = (url, init) => fetch(url, init),
): Promise<string> => {
  const { owner, name } = parseRepo(input.repo);
  const res = await http(`https://api.github.com/repos/${owner}/${name}/pulls/${input.prNumber}`, {
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: 'application/vnd.github.diff',
      'User-Agent': 'tidepool',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`fetch PR diff ${input.repo}#${input.prNumber}: HTTP ${res.status} ${body}`);
  }
  return res.text();
};

/** Map an opencode/git failure onto the runner's typed errors (rate-cap aware). */
const mapAgentError = (e: unknown): AgentFailed | RateCapped => {
  const reason = String(e);
  return /rate.?limit|429|quota|too many requests/i.test(reason)
    ? new RateCapped({})
    : new AgentFailed({ reason });
};

const isIdleFor = (ev: unknown, sessionId: string): boolean =>
  typeof ev === 'object' &&
  ev !== null &&
  'type' in ev &&
  ev.type === 'session.idle' &&
  'properties' in ev &&
  typeof ev.properties === 'object' &&
  ev.properties !== null &&
  'sessionID' in ev.properties &&
  ev.properties.sessionID === sessionId;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── SSH helpers for Hetzner worker execution ─────────────────────────────────

const SSH_KEY = join(homedir(), '.tidepool/bootstrap/ssh-tidepool');
const SSH_OPTS = [
  '-i',
  SSH_KEY,
  // Workers are ephemeral cattle and Hetzner recycles public IPs, so a pinned
  // host key for a recycled IP trips "HOST IDENTIFICATION CHANGED" and fails
  // every connect. Don't persist or verify host keys for these throwaway boxes.
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'UserKnownHostsFile=/dev/null',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=15',
] as const;

/**
 * Build the exact `ssh` argv for running `cmd` on `root@ip`. The command is the
 * SINGLE trailing arg — ssh re-joins trailing argv with spaces, so wrapping it in
 * `sh -c` would mangle quoting (`test -f x` → bare `test`). sshd already runs the
 * string via the remote login shell. Pure so both helpers share one source of
 * truth and the host-key + single-arg invariants stay regression-locked.
 */
export const sshArgv = (ip: string, cmd: string): readonly string[] => [
  'ssh',
  ...SSH_OPTS,
  `root@${ip}`,
  cmd,
];

/** Run a shell command on the worker. Returns stdout. Throws on non-zero exit. */
const sshRun = async (ip: string, cmd: string): Promise<string> => {
  const proc = Bun.spawn([...sshArgv(ip, cmd)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`ssh[${ip}] exit ${code}: ${err.trim().slice(0, 300)}`);
  return out;
};

/** Pipe a string into stdin of a remote command. */
const sshPipe = async (ip: string, cmd: string, stdin: string): Promise<void> => {
  const proc = Bun.spawn([...sshArgv(ip, cmd)], {
    stdin: new TextEncoder().encode(stdin),
    stderr: 'pipe',
  });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`ssh-pipe[${ip}] exit ${code}: ${err.trim().slice(0, 300)}`);
};

/**
 * Block until cloud-init on the worker touches /tmp/.tp-ready (max 5 min).
 * SSH is available earlier; the sentinel proves opencode + bun installs finished.
 */
const waitForReady = async (ip: string): Promise<void> => {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try {
      await sshRun(ip, 'test -f /tmp/.tp-ready');
      return;
    } catch {
      await delay(10_000);
    }
  }
  throw new Error(`cloud-init on ${ip} did not complete within 5 min`);
};

/**
 * Build the worker runner (`src/worker/runner.ts`) into one self-contained
 * bundle: the opencode SDK + Effect are inlined; Bun's `$` and node builtins
 * stay external (the box has its own bun runtime). This is the single artifact
 * uploaded to the worker as `runner.js`, replacing the old stringified script +
 * on-box `bun install`. Memoized — the bundle is identical across tickets, so
 * the Bun.build cost is paid once per process.
 */
/** Bundle one worker entrypoint (`runner.ts` / `review-runner.ts`) into one artifact. */
const bundleWorkerEntry = async (entry: string): Promise<string> => {
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL(entry, import.meta.url))],
    target: 'bun',
    external: ['bun'],
  });
  if (!built.success) {
    throw new Error(`${entry} bundle build failed: ${built.logs.map(String).join('; ')}`);
  }
  const [artifact] = built.outputs;
  if (artifact === undefined) throw new Error(`${entry} bundle produced no output`);
  return artifact.text();
};

let runnerBundle: Promise<string> | undefined;
export const buildRunnerBundle = (): Promise<string> => {
  runnerBundle ??= bundleWorkerEntry('./worker/runner.ts');
  return runnerBundle;
};

/**
 * Build the review runner (`src/worker/review-runner.ts`) into one self-contained
 * bundle uploaded to a leased worker as `runner.js` (FIX 1). Memoized like the
 * work bundle — identical across tickets, so the Bun.build cost is paid once.
 */
let reviewRunnerBundle: Promise<string> | undefined;
export const buildReviewRunnerBundle = (): Promise<string> => {
  reviewRunnerBundle ??= bundleWorkerEntry('./worker/review-runner.ts');
  return reviewRunnerBundle;
};

type RemoteWorkInput = {
  readonly box: { readonly ip: string };
  readonly ticket: { readonly id: string; readonly title: string; readonly goal: string };
  readonly repo: string;
  readonly base: string;
  readonly branch: string;
  readonly model: string;
};

/**
 * Run the work agent on a real Hetzner worker over SSH.
 * Flow: wait for cloud-init → inject auth.json → upload bundled runner + config →
 * `bun run runner.js` → decode the single RunnerResult line.
 *
 * The runner is a single pre-bundled `runner.js` (sdk + Effect inlined), so the
 * box needs no `bun install` and no `package.json` — it just runs the artifact.
 */
const remoteWork = async (
  input: RemoteWorkInput,
  token: string,
  opencodeAuth: string,
): Promise<WorkResult> => {
  const { ip } = input.box;
  const runDir = `/tmp/tp-${input.ticket.id}`;
  const workDir = `/tmp/tp-work-${input.ticket.id}`;

  await waitForReady(ip);

  // Deliver auth.json JIT over SSH into the standard opencode path (never on disk unencrypted).
  // The blob comes from the CredentialBroker at dispatch — the runner never reads sops itself.
  const authJson = opencodeAuth;
  await sshPipe(
    ip,
    'mkdir -p /root/.local/share/opencode && cat > /root/.local/share/opencode/auth.json && chmod 600 /root/.local/share/opencode/auth.json',
    authJson,
  );

  // Upload the single bundled runner — no on-box install, no package.json
  await sshRun(ip, `mkdir -p ${runDir}`);
  await sshPipe(ip, `cat > ${runDir}/runner.js`, await buildRunnerBundle());

  // Write config as JSON — decoded by the runner through the shared RunnerConfig schema
  const config = JSON.stringify({
    cloneUrl: `https://x-access-token:${token}@github.com/${input.repo}.git`,
    base: input.base,
    branch: input.branch,
    dir: workDir,
    model: input.model,
    prompt: workPrompt(input.ticket as Parameters<typeof workPrompt>[0]),
    commitMsg: commitMessage(input.ticket),
  });
  await sshPipe(ip, `cat > ${runDir}/config.json && chmod 600 ${runDir}/config.json`, config);

  // Execute runner; stdout = one encoded RunnerResult line; stderr = debug logs
  const raw = await sshRun(ip, `cd ${runDir} && /root/.bun/bin/bun run runner.js`);

  const jsonLine = raw.split('\n').findLast((l) => l.trim().startsWith('{'));
  if (!jsonLine) throw new Error(`remote runner produced no result line. tail: ${raw.slice(-300)}`);
  const { commitSha, usage } = Schema.decodeSync(Schema.parseJson(RunnerResult))(jsonLine);

  return {
    title: workTitle(input.ticket as Parameters<typeof workTitle>[0]),
    body: workBody(input.ticket as Parameters<typeof workBody>[0]),
    commitSha,
    usage,
  };
};

type RemoteReviewInput = {
  readonly box: { readonly ip: string };
  readonly ticket: Ticket;
  readonly repo: string;
  readonly prNumber: number;
  readonly model: string;
};

/**
 * Run the review agent on a real Hetzner worker over SSH (FIX 1), mirroring
 * `remoteWork`: wait for cloud-init → inject auth.json → upload the bundled review
 * runner + config → `bun run runner.js` → decode the single `ReviewRunnerResult`
 * line → parse the verdict locally. The PR diff is fetched on the control box
 * (REST + the runner's own token) and embedded in the prompt, so the worker needs
 * no clone and no `gh`. The control box never runs opencode or holds its auth.
 */
const remoteReview = async (
  input: RemoteReviewInput,
  token: string,
  opencodeAuth: string,
): Promise<{ readonly verdict: ReviewVerdict; readonly usage: Usage }> => {
  const { ip } = input.box;
  const runDir = `/tmp/tp-review-${input.ticket.id}`;
  const workDir = `/tmp/tp-review-work-${input.ticket.id}`;

  await waitForReady(ip);

  // Deliver auth.json JIT over SSH into the standard opencode path (never on disk unencrypted).
  // The blob comes from the CredentialBroker at dispatch — the runner never reads sops itself.
  const authJson = opencodeAuth;
  await sshPipe(
    ip,
    'mkdir -p /root/.local/share/opencode && cat > /root/.local/share/opencode/auth.json && chmod 600 /root/.local/share/opencode/auth.json',
    authJson,
  );

  // Fetch the PR diff with the runner's own token (REST diff media type), same as
  // the in-process path — no `gh`/keyring/cwd dependency.
  const diff = await fetchPrDiff({ token, repo: input.repo, prNumber: input.prNumber });

  // Upload the single bundled review runner — no on-box install, no package.json
  await sshRun(ip, `mkdir -p ${runDir}`);
  await sshPipe(ip, `cat > ${runDir}/runner.js`, await buildReviewRunnerBundle());

  const config = JSON.stringify({
    dir: workDir,
    model: input.model,
    prompt: reviewPrompt(input.ticket, diff),
  });
  await sshPipe(ip, `cat > ${runDir}/config.json && chmod 600 ${runDir}/config.json`, config);

  const raw = await sshRun(ip, `cd ${runDir} && /root/.bun/bin/bun run runner.js`);

  const jsonLine = raw.split('\n').findLast((l) => l.trim().startsWith('{'));
  if (!jsonLine) throw new Error(`remote review produced no result line. tail: ${raw.slice(-300)}`);
  const { text, usage } = Schema.decodeSync(Schema.parseJson(ReviewRunnerResult))(jsonLine);

  return { verdict: parseVerdict(text), usage };
};

/** One agent turn: spin an embedded opencode server, prompt, collect usage+text. */
const runAgent = async (params: {
  readonly directory: string;
  readonly model: string;
  readonly prompt: string;
}): Promise<{ readonly usage: Usage; readonly text: string }> => {
  const { providerID, modelID } = splitModel(params.model);
  const server = await createOpencodeServer({ hostname: '127.0.0.1', port: 0 });
  try {
    const client = createOpencodeClient({ baseUrl: server.url, directory: params.directory });
    const created = await client.session.create({ query: { directory: params.directory } });
    const sessionId = created.data?.id;
    if (sessionId === undefined)
      throw new Error(`session.create failed: ${JSON.stringify(created.error)}`);

    const events: unknown[] = [];
    const sub = await client.event.subscribe();
    const collecting = (async () => {
      for await (const ev of sub.stream) {
        events.push(ev);
        if (isIdleFor(ev, sessionId)) return;
      }
    })();

    const res = await client.session.prompt({
      path: { id: sessionId },
      query: { directory: params.directory },
      body: { model: { providerID, modelID }, parts: [{ type: 'text', text: params.prompt }] },
    });
    const info = res.data?.info;
    if (info === undefined) throw new Error(`session.prompt failed: ${JSON.stringify(res.error)}`);

    await Promise.race([collecting, delay(2000)]);

    const parts = res.data?.parts ?? [];
    const text = parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
    const usage = parseUsage([...events, { type: 'message.updated', properties: { info } }]);
    return { usage, text };
  } finally {
    server.close();
  }
};

/**
 * Build the local opencode `OpencodeRunner` over broker-provided creds. The
 * `githubToken` clones/pushes/fetches diffs; `opencodeAuth` is injected into the
 * remote worker's opencode path. Creds arrive from the `CredentialBroker` at
 * dispatch — the runner never reads sops/disk itself (tenet 9).
 */
export const makeOpencodeAgentRunner = (creds: WorkerCredentials): OpencodeRunner => {
  const { githubToken: token, opencodeAuth } = creds;
  const cloneUrl = (repo: string) => `https://x-access-token:${token}@github.com/${repo}.git`;
  return {
    work: (input) =>
      Effect.tryPromise({
        try: async (): Promise<WorkResult> => {
          // Phase C: run on real Hetzner worker; Phase B fallback: run locally
          if (input.box.ip !== '127.0.0.1') {
            return remoteWork(input, token, opencodeAuth);
          }

          const dir = await mkdtemp(join(tmpdir(), 'tp-work-'));
          await $`git clone --depth 1 --branch ${input.base} ${cloneUrl(input.repo)} ${dir}`.quiet();
          await $`git -C ${dir} checkout -b ${input.branch}`.quiet();
          await $`git -C ${dir} config user.email agent@tidepool.local`.quiet();
          await $`git -C ${dir} config user.name tidepool-agent`.quiet();

          const { usage } = await runAgent({
            directory: dir,
            model: input.model,
            prompt: workPrompt(input.ticket),
          });

          const dirty = (await $`git -C ${dir} status --porcelain`.text()).trim();
          if (dirty === '') throw new Error('work agent produced no changes');

          // Reformat generated code (FORMAT only, never a lint-gate) before
          // committing, so the PR is more likely to pass the target repo's CI.
          // Best-effort: a format step that exits non-zero is logged and skipped,
          // never aborting the commit — formatting helps CI pass, it is not a gate.
          const hasFormatScript = (() => {
            try {
              const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
                scripts?: Record<string, unknown>;
              };
              return typeof pkg.scripts?.format === 'string';
            } catch {
              return false;
            }
          })();
          for (const command of preCommitCommands({ hasFormatScript })) {
            const res = await $`${{ raw: command }}`.cwd(dir).nothrow().quiet();
            if (res.exitCode !== 0) {
              console.warn(`[runner] pre-commit format step failed (continuing): ${command}`);
            }
          }

          await $`git -C ${dir} add -A`.quiet();
          await $`git -C ${dir} commit -m ${commitMessage(input.ticket)}`.quiet();
          const commitSha = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
          await $`git -C ${dir} push -u origin ${input.branch}`.quiet();

          return { title: workTitle(input.ticket), body: workBody(input.ticket), commitSha, usage };
        },
        catch: mapAgentError,
      }),
    review: (input) =>
      Effect.tryPromise({
        try: async () => {
          // Phase C: run review on the leased Hetzner worker (FIX 1); Phase B
          // fallback: run locally (only when the box is the loopback stand-in).
          if (input.box.ip !== '127.0.0.1') {
            return remoteReview(input, token, opencodeAuth);
          }

          const diff = await fetchPrDiff({ token, repo: input.repo, prNumber: input.prNumber });
          const dir = await mkdtemp(join(tmpdir(), 'tp-review-'));
          const { usage, text } = await runAgent({
            directory: dir,
            model: input.model,
            prompt: reviewPrompt(input.ticket, diff),
          });
          return { verdict: parseVerdict(text), usage };
        },
        catch: mapAgentError,
      }),
  };
};
