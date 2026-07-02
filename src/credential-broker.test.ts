import { assert, describe, it } from '@effect/vitest';
import { Cause, Effect, Exit, Layer, Option } from 'effect';
import type { OpencodeRunner } from './agent-runner.ts';
import type { Ticket } from './domain.ts';
import { fakeCredentialBroker } from './fakes.ts';
import { newTicketId } from './ids.ts';
import { makeLocalAgentWorker } from './local-agent-worker.ts';
import {
  AgentWorker,
  CredentialBroker,
  type CredentialRequest,
  type WorkerCredentials,
} from './services.ts';

/**
 * PR-2 CredentialBroker (passthrough). Two guarantees:
 *  1. the seam hands back the `{ opencodeAuth, githubToken }` shape the dispatch
 *     path needs (the front the future App-token/rotation swap keeps stable);
 *  2. the `AgentWorker` dispatch path resolves creds *via the broker* — keyed on
 *     the job, never read inline — and hands exactly those creds to the runner
 *     (tenet 4/9: callers/agent-workers never touch sops directly).
 */

const testTicket = (): Ticket => ({
  id: newTicketId(),
  title: 'Add slugify',
  body: 'add slugify(s)',
  target: 'o/r',
  state: 'in_progress',
  phase: 'working',
  conditions: [],
  branch: 'tp/x',
  prNumber: null,
  prId: null,
  mergeSha: null,
  attempts: 0,
  workedAttempt: null,
  reason: null,
  workHandle: null,
  dispatchedAt: null,
});

/** A runner spy: records the creds it was built with, returns canned results. */
const spyRunner =
  (sink: { creds?: WorkerCredentials }) =>
  (creds: WorkerCredentials): OpencodeRunner => {
    sink.creds = creds;
    return {
      work: () =>
        Effect.succeed({
          title: 't',
          body: 'b',
          commitSha: 'sha',
          usage: { model: 'm', tokensIn: 1, tokensOut: 1, wallTimeSec: 1 },
        }),
      review: () =>
        Effect.succeed({
          verdict: 'approve',
          reason: 'VERDICT: APPROVE',
          usage: { model: 'm', tokensIn: 1, tokensOut: 1, wallTimeSec: 1 },
        }),
    };
  };

describe('fakeCredentialBroker', () => {
  it.effect('credsFor returns the { opencodeAuth, githubToken } shape', () =>
    Effect.gen(function* () {
      const broker = yield* CredentialBroker;
      const creds = yield* broker.credsFor({ kind: 'work', repo: 'o/r', ticketId: newTicketId() });
      assert.deepStrictEqual(creds, {
        opencodeAuth: 'fake-opencode-auth',
        githubToken: 'fake-gh-token',
      });
    }).pipe(Effect.provide(fakeCredentialBroker())),
  );
});

describe('LocalAgentWorker dispatch routes creds through the broker', () => {
  it.effect('work: credsFor is keyed on the job and its creds reach the runner', () => {
    const calls: CredentialRequest[] = [];
    const sink: { creds?: WorkerCredentials } = {};
    const ticket = testTicket();
    const broker = fakeCredentialBroker({
      opencodeAuth: 'oc',
      githubToken: 'gh',
      onCall: (c) => calls.push(c),
    });
    const worker = makeLocalAgentWorker(spyRunner(sink)).pipe(Layer.provide(broker));

    return Effect.gen(function* () {
      const agent = yield* AgentWorker;
      const handle = yield* agent.dispatch({
        kind: 'work',
        ticket,
        repo: 'o/r',
        base: 'main',
        branch: 'tp/x',
        model: 'm',
      });

      // creds were fetched from the broker, keyed on THIS job (not read inline)…
      assert.deepStrictEqual(calls, [{ kind: 'work', repo: 'o/r', ticketId: ticket.id }]);
      // …and exactly those broker creds were handed to the runner.
      assert.deepStrictEqual(sink.creds, { opencodeAuth: 'oc', githubToken: 'gh' });

      const status = yield* agent.poll(handle);
      assert.strictEqual(status._tag, 'Succeeded');
      if (status._tag !== 'Succeeded') return;
      assert.strictEqual(status.outcome._tag, 'Work');
      if (status.outcome._tag !== 'Work') return;
      assert.strictEqual(status.outcome.result.commitSha, 'sha');
    }).pipe(Effect.provide(worker));
  });

  it.effect('review: credsFor is keyed on the review job', () => {
    const calls: CredentialRequest[] = [];
    const sink: { creds?: WorkerCredentials } = {};
    const ticket = testTicket();
    const broker = fakeCredentialBroker({
      opencodeAuth: 'oc',
      githubToken: 'gh',
      onCall: (c) => calls.push(c),
    });
    const worker = makeLocalAgentWorker(spyRunner(sink)).pipe(Layer.provide(broker));

    return Effect.gen(function* () {
      const agent = yield* AgentWorker;
      const handle = yield* agent.dispatch({
        kind: 'review',
        ticket,
        repo: 'o/r',
        prNumber: 7,
        model: 'm',
      });

      assert.deepStrictEqual(calls, [{ kind: 'review', repo: 'o/r', ticketId: ticket.id }]);
      assert.deepStrictEqual(sink.creds, { opencodeAuth: 'oc', githubToken: 'gh' });

      const status = yield* agent.poll(handle);
      assert.strictEqual(status._tag, 'Succeeded');
      if (status._tag !== 'Succeeded') return;
      assert.strictEqual(status.outcome._tag, 'Review');
    }).pipe(Effect.provide(worker));
  });

  it.effect('a credsFor failure dies (orDie) — a missing cred is a config defect', () => {
    const broker = fakeCredentialBroker({ fail: 'no creds' });
    const worker = makeLocalAgentWorker(spyRunner({})).pipe(Layer.provide(broker));

    return Effect.gen(function* () {
      const agent = yield* AgentWorker;
      const exit = yield* Effect.exit(
        agent.dispatch({
          kind: 'work',
          ticket: testTicket(),
          repo: 'o/r',
          base: 'main',
          branch: 'tp/x',
          model: 'm',
        }),
      );
      // orDie turns the CredentialError into a defect, not a typed failure — so
      // `dispatch`'s error channel stays `AgentFailed | RateCapped` and a missing
      // cred crashes loudly (config defect) rather than looking like a retry.
      assert.strictEqual(Exit.isFailure(exit), true);
      if (!Exit.isFailure(exit)) return;
      const die = Cause.dieOption(exit.cause);
      assert.strictEqual(Option.isSome(die), true);
      if (Option.isSome(die)) {
        assert.strictEqual((die.value as { readonly _tag: string })._tag, 'CredentialError');
      }
    }).pipe(Effect.provide(worker));
  });
});
