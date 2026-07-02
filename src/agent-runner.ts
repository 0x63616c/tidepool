import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpencodeClient, createOpencodeServer } from '@opencode-ai/sdk';
import { $ } from 'bun';
import { Effect } from 'effect';
import { AgentFailed, RateCapped, type ReviewVerdict, type Ticket, type Usage } from './domain.ts';
import { parseRepo } from './forge.ts';
import type { ReviewResult, WorkerCredentials, WorkResult } from './services.ts';

/**
 * The local opencode driver, behind the `AgentWorker` seam (not a `Context.Tag`
 * itself). `LocalAgentWorker` calls this to run an agent on this machine. (The old
 * SSH remote-work path — for the retired Hetzner box model — was removed in PR-7;
 * remote execution now lives entirely in `K8sAgentWorker`.)
 */
export interface OpencodeWorkInput {
  readonly ticket: Ticket;
  readonly repo: string;
  readonly base: string;
  readonly branch: string;
  readonly model: string;
}
export interface OpencodeReviewInput {
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
const MAX_HEADER_LENGTH = 100;

const normalizedSubject = (title: string): string => {
  const trimmed = title.trim().replace(/\s+/g, ' ');
  const subject = trimmed.length === 0 ? 'update' : trimmed;
  return subject.charAt(0).toLowerCase() + subject.slice(1);
};

const truncateSubject = (subject: string, maxLength: number): string => {
  if (subject.length <= maxLength) return subject;
  if (maxLength <= 3) return subject.slice(0, maxLength);
  return `${subject.slice(0, maxLength - 3).trimEnd()}...`;
};

const boundedHeader = (prefix: string, title: string, suffix = ''): string => {
  const maxSubjectLength = MAX_HEADER_LENGTH - prefix.length - suffix.length;
  return `${prefix}${truncateSubject(normalizedSubject(title), maxSubjectLength)}${suffix}`;
};

export const commitMessage = (ticket: { readonly id: string; readonly title: string }): string =>
  boundedHeader(`#${ticket.id} feat: `, ticket.title);

// ── opencode orchestration ───────────────────────────────────────────────────

/** PR title/body are derived from the ticket so they're deterministic. */
export const workTitle = (ticket: { readonly id: string; readonly title: string }): string =>
  boundedHeader('feat: ', ticket.title, ` (${ticket.id})`);
export const workBody = (ticket: Ticket): string => ticket.goal;

/** Split a `provider/model` config string into the SDK's `{providerID, modelID}`. */
const splitModel = (model: string): { providerID: string; modelID: string } => {
  const i = model.indexOf('/');
  return i < 0
    ? { providerID: 'openai', modelID: model }
    : { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
};

const STANDARDS =
  'Follow the repo conventions. Make the smallest change that satisfies the goal and add/keep tests green. Do not touch CI or unrelated files.';

export const workPrompt = (ticket: Ticket): string =>
  [
    `You are the work agent for ticket ${ticket.id}.`,
    `Goal: ${ticket.goal}`,
    STANDARDS,
    'Implement the goal directly in this repository. Do not commit or push — the harness handles git.',
  ].join('\n\n');

export const reviewPrompt = (ticket: Ticket, diff: string): string =>
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
 * `githubToken` clones/pushes/fetches diffs; the embedded opencode server uses the
 * ambient opencode auth on this machine (`opencodeAuth` is consumed by the
 * `K8sAgentWorker` path, which injects it into the Job). Creds arrive from the
 * `CredentialBroker` at dispatch — the runner never reads sops/disk itself (tenet 9).
 */
export const makeOpencodeAgentRunner = (creds: WorkerCredentials): OpencodeRunner => {
  const { githubToken: token } = creds;
  const cloneUrl = (repo: string) => `https://x-access-token:${token}@github.com/${repo}.git`;
  return {
    work: (input) =>
      Effect.tryPromise({
        try: async (): Promise<WorkResult> => {
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
