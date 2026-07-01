import { defineConfig } from 'vitest/config';

/**
 * Scope test discovery to tracked `src/` sources only. Without this, a leftover
 * git worktree under `.claude/` (gitignored) leaks a stale duplicate suite into
 * local runs — keeping local identical to CI (which only checks out `src/`).
 *
 * `pool: 'forks'` runs each test file in a child process. Under the Bun runtime
 * (the `test` script invokes `bun --bun vitest`) those forks inherit Bun, so
 * `bun:sqlite` — which the real `TicketStore` needs — resolves. Bun's
 * worker_threads pool is unimplemented (stdout/stderr), so forks is required.
 */
export default defineConfig({
  test: {
    // `src/` app suite + the PURE infra guards (guards.ts has no @pulumi import,
    // so it runs here without the cluster's node_modules — tenet 12 red-green).
    include: ['src/**/*.test.ts', 'infra/pulumi/cluster/**/*.test.ts'],
    pool: 'forks',
  },
});
