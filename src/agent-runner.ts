import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpencodeClient, createOpencodeServer } from '@opencode-ai/sdk';
import { $ } from 'bun';
import { Effect, Layer } from 'effect';
import { AgentFailed, RateCapped, type ReviewVerdict, type Ticket, type Usage } from './domain.ts';
import { githubToken } from './forge.ts';
import { AgentRunner, type AgentRunnerApi, type WorkResult } from './services.ts';

/**
 * Narrowed view of the one event we care about: a `message.updated` whose info
 * is an AssistantMessage. The opencode SDK's event type is a wide union, so we
 * validate at the boundary (no casts) and keep only the fields usage needs.
 */
interface AssistantInfo {
  readonly id: string;
  readonly modelID: string;
  readonly providerID: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly created: number;
  readonly completed: number | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Decode one event into an `AssistantInfo`, or null if it isn't one. */
const assistantInfo = (ev: unknown): AssistantInfo | null => {
  if (!isRecord(ev) || ev.type !== 'message.updated' || !isRecord(ev.properties)) return null;
  const info = ev.properties.info;
  if (!isRecord(info) || info.role !== 'assistant') return null;
  if (!isRecord(info.tokens) || !isRecord(info.time)) return null;
  const id = str(info.id);
  const modelID = str(info.modelID);
  const providerID = str(info.providerID);
  const tokensIn = num(info.tokens.input);
  const tokensOut = num(info.tokens.output);
  const created = num(info.time.created);
  if (
    id === undefined ||
    modelID === undefined ||
    providerID === undefined ||
    tokensIn === undefined ||
    tokensOut === undefined ||
    created === undefined
  ) {
    return null;
  }
  return {
    id,
    modelID,
    providerID,
    tokensIn,
    tokensOut,
    created,
    completed: num(info.time.completed),
  };
};

/**
 * Roll the opencode event stream into one `Usage`. `message.updated` fires
 * repeatedly per message with cumulative tokens, so we keep the LAST update per
 * message id, then sum across distinct messages. The model is `provider/model`
 * (matching the config strings) and wall time spans first-created to last-
 * completed. Non-zero tokens are the proof a real run happened.
 */
export const parseUsage = (events: ReadonlyArray<unknown>): Usage => {
  const byId = new Map<string, AssistantInfo>();
  for (const ev of events) {
    const info = assistantInfo(ev);
    if (info !== null) byId.set(info.id, info);
  }
  const infos = [...byId.values()];
  const tokensIn = infos.reduce((n, i) => n + i.tokensIn, 0);
  const tokensOut = infos.reduce((n, i) => n + i.tokensOut, 0);
  const last = infos.at(-1);
  const model = last === undefined ? '' : `${last.providerID}/${last.modelID}`;
  const created = infos.map((i) => i.created);
  const completed = infos.flatMap((i) => (i.completed === undefined ? [] : [i.completed]));
  const wallTimeSec =
    created.length > 0 && completed.length > 0
      ? Math.max(0, (Math.max(...completed) - Math.min(...created)) / 1000)
      : 0;
  return { model, tokensIn, tokensOut, wallTimeSec };
};

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

/** Run a shell command on the worker. Returns stdout. Throws on non-zero exit. */
const sshRun = async (ip: string, cmd: string): Promise<string> => {
  // Pass the command as a SINGLE arg — ssh re-joins trailing argv with spaces,
  // so an extra `sh -c` here would mangle quoting (`test -f x` → bare `test`).
  // sshd already runs the string via the remote login shell.
  const proc = Bun.spawn(['ssh', ...SSH_OPTS, `root@${ip}`, cmd], {
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
  // Single-arg command — see sshRun: an extra `sh -c` would mangle quoting.
  const proc = Bun.spawn(['ssh', ...SSH_OPTS, `root@${ip}`, cmd], {
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
 * Self-contained bun script uploaded to the worker that:
 * 1. Clones + branches the target repo
 * 2. Spins an embedded opencode server (spawns the `opencode` binary from PATH)
 * 3. Drives a full agent session
 * 4. Commits + pushes the result
 * 5. Writes one JSON line to stdout: { commitSha, usage }
 *
 * All log output goes to stderr; stdout is the machine-readable result only.
 * Dependencies are installed from the bun global cache (pre-warmed in cloud-init).
 */
// NOTE: $\` and \${} are bun-shell tagged template literals inside the script string.
// The outer TS template literal escapes them so they survive as literals.
const RUNNER_SCRIPT = `import { createOpencodeClient, createOpencodeServer } from '@opencode-ai/sdk';
import { $ } from 'bun';
import { readFile } from 'node:fs/promises';

const log = (msg) => process.stderr.write('[runner] ' + msg + '\\n');

// Ensure opencode binary is findable by createOpencodeServer (cross-spawn uses PATH).
// The installer puts it in /usr/local/bin (-b flag) as primary; fall back to ~/.opencode/bin.
process.env.PATH = [
  '/usr/local/bin',
  '/root/.opencode/bin',
  '/root/.bun/bin',
  process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
].join(':');

const cfg = JSON.parse(await readFile('./config.json', 'utf8'));
const { cloneUrl, base, branch, dir, model, prompt, commitMsg } = cfg;

const slashIdx = model.indexOf('/');
const providerID = slashIdx >= 0 ? model.slice(0, slashIdx) : 'anthropic';
const modelID = slashIdx >= 0 ? model.slice(slashIdx + 1) : model;

log('cloning ' + base + ' ...');
await $\`git clone --depth 1 --branch \${base} \${cloneUrl} \${dir}\`.quiet();
await $\`git -C \${dir} checkout -b \${branch}\`.quiet();
await $\`git -C \${dir} config user.email agent@tidepool.local\`.quiet();
await $\`git -C \${dir} config user.name tidepool-agent\`.quiet();

const isRecord = (v) => typeof v === 'object' && v !== null;
const num = (v) => (typeof v === 'number' ? v : undefined);
const str = (v) => (typeof v === 'string' ? v : undefined);
const assistantInfo = (ev) => {
  if (!isRecord(ev) || ev.type !== 'message.updated' || !isRecord(ev.properties)) return null;
  const info = ev.properties.info;
  if (!isRecord(info) || info.role !== 'assistant') return null;
  if (!isRecord(info.tokens) || !isRecord(info.time)) return null;
  const id = str(info.id), mid = str(info.modelID), pid = str(info.providerID);
  const tin = num(info.tokens.input), tout = num(info.tokens.output);
  const created = num(info.time.created);
  if (!id || !mid || !pid || tin === undefined || tout === undefined || created === undefined) return null;
  return { id, modelID: mid, providerID: pid, tokensIn: tin, tokensOut: tout, created, completed: num(info.time.completed) };
};
const parseUsage = (events) => {
  const byId = new Map();
  for (const ev of events) { const info = assistantInfo(ev); if (info) byId.set(info.id, info); }
  const infos = [...byId.values()];
  const tokensIn = infos.reduce((n, i) => n + i.tokensIn, 0);
  const tokensOut = infos.reduce((n, i) => n + i.tokensOut, 0);
  const last = infos.at(-1);
  const modelStr = last ? last.providerID + '/' + last.modelID : '';
  const created = infos.map((i) => i.created);
  const completed = infos.flatMap((i) => (i.completed !== undefined ? [i.completed] : []));
  const wallTimeSec = created.length > 0 && completed.length > 0
    ? Math.max(0, (Math.max(...completed) - Math.min(...created)) / 1000) : 0;
  return { model: modelStr, tokensIn, tokensOut, wallTimeSec };
};
const isIdleFor = (ev, sessionId) =>
  isRecord(ev) && ev.type === 'session.idle' && isRecord(ev.properties) && ev.properties.sessionID === sessionId;

log('starting opencode...');
const server = await createOpencodeServer({ hostname: '127.0.0.1', port: 0, timeout: 30000 });
log('server: ' + server.url);
try {
  const client = createOpencodeClient({ baseUrl: server.url, directory: dir });
  const createdSess = await client.session.create({ query: { directory: dir } });
  const sessionId = createdSess.data?.id;
  if (!sessionId) throw new Error('session.create failed: ' + JSON.stringify(createdSess.error));

  const events = [];
  let idleResolve = () => {};
  const idlePromise = new Promise((r) => { idleResolve = r; });
  const sub = await client.event.subscribe();
  (async () => {
    try {
      for await (const ev of sub.stream) {
        events.push(ev);
        if (isIdleFor(ev, sessionId)) { idleResolve(); return; }
      }
    } catch { idleResolve(); }
  })();

  log('prompting...');
  const res = await client.session.prompt({
    path: { id: sessionId },
    query: { directory: dir },
    body: { model: { providerID, modelID }, parts: [{ type: 'text', text: prompt }] },
  });
  const info = res.data?.info;
  if (!info) throw new Error('session.prompt failed: ' + JSON.stringify(res.error));
  events.push({ type: 'message.updated', properties: { info } });

  await Promise.race([idlePromise, new Promise((r) => setTimeout(r, 600000))]);
  log('idle');

  const dirty = (await $\`git -C \${dir} status --porcelain\`.text()).trim();
  if (!dirty) throw new Error('work agent produced no changes');
  await $\`git -C \${dir} add -A\`.quiet();
  await $\`git -C \${dir} commit -m \${commitMsg}\`.quiet();
  const commitSha = (await $\`git -C \${dir} rev-parse HEAD\`.text()).trim();
  await $\`git -C \${dir} push -u origin \${branch}\`.quiet();
  log('pushed ' + commitSha);

  await new Promise((resolve) =>
    process.stdout.write(JSON.stringify({ commitSha, usage: parseUsage(events) }) + '\\n', resolve),
  );
} finally {
  server.close();
}
// The embedded opencode server + open event-subscription stream keep Bun's event
// loop alive, so the runner would hang after pushing. Flush the result (above),
// then force a clean exit so the reconciler's sshRun returns and can open the PR.
process.exit(0);
`;

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
 * Flow: wait for cloud-init → inject auth.json → upload runner + config →
 * bun install (uses cache from cloud-init) → bun run → parse JSON result.
 */
const remoteWork = async (input: RemoteWorkInput, token: string): Promise<WorkResult> => {
  const { ip } = input.box;
  const runDir = `/tmp/tp-${input.ticket.id}`;
  const workDir = `/tmp/tp-work-${input.ticket.id}`;

  await waitForReady(ip);

  // Deliver auth.json JIT over SSH into the standard opencode path (never on disk unencrypted)
  const authJson = readFileSync(join(homedir(), '.tidepool/bootstrap/opencode-auth.json'), 'utf8');
  await sshPipe(
    ip,
    'mkdir -p /root/.local/share/opencode && cat > /root/.local/share/opencode/auth.json && chmod 600 /root/.local/share/opencode/auth.json',
    authJson,
  );

  // Set up runner workspace: package.json + SDK install (uses bun global cache) + script
  await sshRun(ip, `mkdir -p ${runDir}`);
  await sshPipe(
    ip,
    `cat > ${runDir}/package.json`,
    JSON.stringify({ type: 'module', dependencies: { '@opencode-ai/sdk': '1.17.11' } }),
  );
  await sshPipe(ip, `cat > ${runDir}/runner.ts`, RUNNER_SCRIPT);
  await sshRun(ip, `cd ${runDir} && /root/.bun/bin/bun install 2>&1`);

  // Write config as JSON — avoids all shell quoting concerns
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

  // Execute runner; stdout = one JSON line; stderr = debug logs (swallowed on success)
  const raw = await sshRun(ip, `cd ${runDir} && /root/.bun/bin/bun run runner.ts`);

  const jsonLine = raw.split('\n').findLast((l) => l.trim().startsWith('{'));
  if (!jsonLine) throw new Error(`remote runner produced no JSON. tail: ${raw.slice(-300)}`);
  const { commitSha, usage } = JSON.parse(jsonLine) as { commitSha: string; usage: Usage };

  return {
    title: workTitle(input.ticket as Parameters<typeof workTitle>[0]),
    body: workBody(input.ticket as Parameters<typeof workBody>[0]),
    commitSha,
    usage,
  };
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

/** Build the `AgentRunnerApi` over a GitHub push token. */
export const makeOpencodeAgentRunner = (token: string): AgentRunnerApi => {
  const cloneUrl = (repo: string) => `https://x-access-token:${token}@github.com/${repo}.git`;
  return {
    work: (input) =>
      Effect.tryPromise({
        try: async (): Promise<WorkResult> => {
          // Phase C: run on real Hetzner worker; Phase B fallback: run locally
          if (input.box.ip !== '127.0.0.1') {
            return remoteWork(input, token);
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
          const diff = await $`gh pr diff ${input.prNumber} --repo ${input.repo}`.text();
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

/** Live `AgentRunner` layer — real opencode + git behind the locked interface. */
export const OpencodeAgentRunnerLive: Layer.Layer<AgentRunner, never> = Layer.effect(
  AgentRunner,
  Effect.map(githubToken.pipe(Effect.orDie), makeOpencodeAgentRunner),
);
