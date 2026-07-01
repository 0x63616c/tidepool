import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { CredentialError } from './domain.ts';
import { githubToken } from './forge.ts';
import { CredentialBroker, type WorkerCredentials } from './services.ts';

/**
 * `LocalCredentialBroker` — the passthrough broker (PR-2). It resolves the creds
 * an agent-worker needs from their *existing* homes and hands them to the
 * dispatch path, hiding those homes behind the `CredentialBroker` seam so the
 * dispatch path never reads a secret directly (tenet 9). No behavior change yet:
 * today it reads, tomorrow (App tokens / rotation) it mints — the one module that
 * swaps, callers unchanged (tenet 4).
 */

/** The opencode `auth.json` blob lives with the other bootstrap secrets. */
const OPENCODE_AUTH_PATH = join(homedir(), '.tidepool/bootstrap/opencode-auth.json');

const readOpencodeAuth: Effect.Effect<string, CredentialError> = Effect.try({
  try: () => readFileSync(OPENCODE_AUTH_PATH, 'utf8'),
  catch: (e) => new CredentialError({ reason: `opencode auth: ${String(e)}` }),
});

export const LocalCredentialBroker: Layer.Layer<CredentialBroker> = Layer.succeed(
  CredentialBroker,
  {
    // The job is unused under passthrough — the rotation swap keys creds on it.
    credsFor: (): Effect.Effect<WorkerCredentials, CredentialError> =>
      Effect.gen(function* () {
        const gh = yield* githubToken.pipe(
          Effect.mapError((e) => new CredentialError({ reason: `github token: ${e.reason}` })),
        );
        const opencodeAuth = yield* readOpencodeAuth;
        return { opencodeAuth, githubToken: gh };
      }),
  },
);
