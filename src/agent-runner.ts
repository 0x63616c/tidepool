import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
