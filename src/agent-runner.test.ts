import { assert, describe, it } from '@effect/vitest';
import {
  commitMessage,
  fetchPrDiff,
  parseUsage,
  parseVerdict,
  reviewPrompt,
  workPrompt,
} from './agent-runner.ts';
import type { Ticket } from './domain.ts';
import { newTicketId } from './ids.ts';

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: newTicketId(),
  title: 'Add slugify',
  body: '# Acceptance Criteria\n- slugify(s) lowercases and trims',
  target: 't/repo',
  state: 'running',
  phase: 'working',
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
  ...over,
});

/**
 * Usage parsing is the proof-of-real-work signal (`tp doctor` asserts non-zero
 * tokens), so it's a pure unit tested against the opencode SDK's real event
 * shape: `message.updated` events whose `properties.info` is an AssistantMessage
 * carrying `tokens.{input,output}`, `modelID`, `providerID`, and `time`.
 */

const assistantEvent = (over: Record<string, unknown> = {}) => ({
  type: 'message.updated',
  properties: {
    info: {
      id: 'msg_1',
      sessionID: 'ses_1',
      role: 'assistant',
      time: { created: 1000, completed: 3500 },
      modelID: 'gpt-5.4-mini',
      providerID: 'openai',
      cost: 0.012,
      tokens: { input: 1200, output: 340, reasoning: 0, cache: { read: 0, write: 0 } },
      ...over,
    },
  },
});

describe('parseUsage', () => {
  it('reads tokens, model (provider/model), and wall time from one assistant message', () => {
    const usage = parseUsage([assistantEvent()]);
    assert.strictEqual(usage.tokensIn, 1200);
    assert.strictEqual(usage.tokensOut, 340);
    assert.strictEqual(usage.model, 'openai/gpt-5.4-mini');
    assert.strictEqual(usage.wallTimeSec, 2.5);
  });

  it('keeps the LAST cumulative update per message id (does not double-count)', () => {
    const usage = parseUsage([
      assistantEvent({
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      assistantEvent({
        tokens: { input: 1200, output: 340, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ]);
    assert.strictEqual(usage.tokensIn, 1200);
    assert.strictEqual(usage.tokensOut, 340);
  });

  it('sums tokens across distinct messages', () => {
    const usage = parseUsage([
      assistantEvent({ id: 'msg_1' }),
      assistantEvent({
        id: 'msg_2',
        tokens: { input: 800, output: 60, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ]);
    assert.strictEqual(usage.tokensIn, 2000);
    assert.strictEqual(usage.tokensOut, 400);
  });

  it('ignores non-assistant and non-message.updated events', () => {
    const usage = parseUsage([
      { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      { type: 'message.updated', properties: { info: { role: 'user', id: 'u1' } } },
      assistantEvent(),
    ]);
    assert.strictEqual(usage.tokensIn, 1200);
    assert.strictEqual(usage.tokensOut, 340);
  });
});

describe('parseVerdict', () => {
  it('reads an explicit APPROVE marker', () => {
    assert.strictEqual(parseVerdict('Looks good.\nVERDICT: APPROVE'), 'approve');
  });

  it('reads an explicit REQUEST_CHANGES marker', () => {
    assert.strictEqual(parseVerdict('Needs work.\nVERDICT: REQUEST_CHANGES'), 'request_changes');
  });

  it('accepts loose spelling like "request changes"', () => {
    assert.strictEqual(parseVerdict('I would request changes here'), 'request_changes');
  });

  it('fails closed: request_changes when no verdict is present', () => {
    assert.strictEqual(parseVerdict('hmm, not sure'), 'request_changes');
  });

  it('fails closed: request_changes when both appear', () => {
    assert.strictEqual(
      parseVerdict('I would approve but actually REQUEST CHANGES'),
      'request_changes',
    );
  });
});

describe('commitMessage', () => {
  it('leads with the ticket id then a conventional subject (the graded standard)', () => {
    const msg = commitMessage({ id: 'tckt_001', title: 'add slugify' });
    assert.strictEqual(msg, '#tckt_001 feat: add slugify');
    // Must satisfy the repo's commit header pattern.
    assert.match(msg, /^#(tckt_[0-9a-z]+) (\w+)(?:\(([^)]+)\))?: (.+)$/);
  });

  // commitlint.config.mjs extends @commitlint/config-conventional, which sets
  // header-max-length: [2, 'always', 100]. A ticket title copied verbatim from a
  // long human-written title blew past that (tckt_59qqc9ah8h, PR #91), rejecting
  // the auto-generated commit and blocking every ticket with a long title.
  it('truncates an overlong title so the header respects commitlint’s 100-char max', () => {
    const longTitle =
      'Fix wrong CLI help: suggests bare tp logs/transcript, real cmds are tp ticket logs/transcript';
    const msg = commitMessage({ id: 'tckt_52d1ao2ab0', title: longTitle });
    assert.isAtMost(msg.length, 100);
    assert.match(msg, /^#(tckt_[0-9a-z]+) (\w+)(?:\(([^)]+)\))?: (.+)$/);
  });

  // config-conventional's subject-case rule is [2, 'never', ['sentence-case',
  // 'start-case', 'pascal-case', 'upper-case']]. Ticket titles are written by
  // humans (sentence case), so a verbatim subject was always rejected.
  it('lower-cases a sentence-case ticket title so subject-case passes', () => {
    const msg = commitMessage({ id: 'tckt_52d1ao2ab0', title: 'Fix wrong CLI help' });
    const subject = msg.replace(/^#tckt_[0-9a-z]+ \w+: /, '');
    assert.strictEqual(subject, subject.toLowerCase());
  });

  // Every generated header must always start with the ticket-prefix commitlint
  // checks for ("#tckt_<id> "), regardless of title casing/length.
  it('always leads with "#<ticket-id> " (the ticket-prefix rule)', () => {
    const msg = commitMessage({ id: 'tckt_52d1ao2ab0', title: 'Some Title' });
    assert.match(msg, /^#tckt_[0-9a-z]+ /);
  });
});

/**
 * The review path must fetch the PR diff with the runner's OWN token over the
 * REST diff media type — never via `gh pr diff`. On the control box `gh`
 * authenticates through its GraphQL path and rejects the installation token that
 * git-clone + REST accept, so review died with `HTTP 401 / ShellError exit 1`
 * while work (git clone, same token) succeeded. These lock review onto the same
 * token + transport as work, with no `gh` dependency.
 */
describe('fetchPrDiff', () => {
  type Captured = { url: string; headers: Record<string, string> };

  it('GETs the REST diff endpoint with a bearer token and diff media type', async () => {
    const seen: Captured[] = [];
    const diff = await fetchPrDiff(
      { token: 'ghs_tok', repo: '0x63616c/tidepool-testbed', prNumber: 7 },
      (url, init) => {
        seen.push({ url, headers: init.headers });
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('--- DIFF BODY ---'),
        });
      },
    );

    assert.strictEqual(diff, '--- DIFF BODY ---');
    assert.strictEqual(seen.length, 1);
    const [req] = seen;
    assert.strictEqual(req?.url, 'https://api.github.com/repos/0x63616c/tidepool-testbed/pulls/7');
    assert.strictEqual(req?.headers.Authorization, 'Bearer ghs_tok');
    assert.strictEqual(req?.headers.Accept, 'application/vnd.github.diff');
  });

  it('throws (→ AgentFailed) carrying the HTTP status on a non-2xx response', async () => {
    const err = await fetchPrDiff({ token: 'bad', repo: 'o/n', prNumber: 1 }, () =>
      Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve('Bad credentials') }),
    ).then(
      () => undefined,
      (e: unknown) => String(e),
    );
    assert.isDefined(err);
    assert.match(err ?? '', /401/);
  });
});

describe('workPrompt / reviewPrompt', () => {
  it('wraps the ticket body in an <ticket> block and names it markdown', () => {
    const id = newTicketId();
    const t = ticket({ id, body: '# Acceptance Criteria\n- do the thing' });
    const p = workPrompt(t);
    assert.include(p, `<ticket id="${id}">`);
    assert.include(p, '</ticket>');
    assert.include(p, '# Acceptance Criteria\n- do the thing');
    // the body sits inside the tag, not bare after a "Goal:" label
    assert.notInclude(p, 'Goal:');
  });

  it('tells the work agent the body may be stale and criteria are authoritative', () => {
    const p = workPrompt(ticket());
    assert.include(p, '# Acceptance Criteria');
    assert.match(p, /stale/i);
  });

  it('prepends stored review feedback on rework prompts', () => {
    const feedback =
      'Missing verification proof and secret-hooks coverage.\nVERDICT: REQUEST_CHANGES';
    const p = workPrompt(
      ticket({
        state: 'in_progress',
        prNumber: 7,
        workedAttempt: 0,
        attempts: 1,
        reason: feedback,
      }),
    );
    assert.include(
      p,
      `A previous review requested changes: ${feedback}. Address them before resubmitting.`,
    );
    assert.isTrue(p.startsWith('A previous review requested changes:'));
  });

  it('reviewPrompt grades the diff against the acceptance criteria and embeds both', () => {
    const id = newTicketId();
    const t = ticket({ id, body: '# Acceptance Criteria\n- returns a slug' });
    const p = reviewPrompt(t, 'diff --git a b');
    assert.include(p, `<ticket id="${id}">`);
    assert.include(p, '# Acceptance Criteria');
    assert.include(p, 'diff --git a b');
    assert.match(p, /VERDICT: APPROVE/);
    assert.notInclude(p, 'Goal:');
  });
});
