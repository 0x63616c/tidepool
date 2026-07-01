import { defineConfig } from './src/config.ts';

/**
 * The live config. Testbed work uses a cheap model (we're testing plumbing, not
 * code quality); real targets would use the strong model via a `targets[].models`
 * override. Secrets live in sops, runtime state in sqlite — never here.
 */
export default defineConfig({
  targets: [
    {
      repo: '0x63616c/tidepool-testbed',
      base: 'main',
      models: { work: 'openai/gpt-5.4-mini', review: 'openai/gpt-5.4-mini' },
    },
  ],
  models: { work: 'openai/gpt-5.5', review: 'openai/gpt-5.5' },
  workers: { max: 1, idleTimeoutSec: 300, maxTtlSec: 3600 },
  retries: 2,
});
