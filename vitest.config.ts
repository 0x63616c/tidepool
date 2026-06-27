import { defineConfig } from 'vitest/config';

/**
 * Scope test discovery to tracked `src/` sources only. Without this, a leftover
 * git worktree under `.claude/` (gitignored) leaks a stale duplicate suite into
 * local runs — keeping local identical to CI (which only checks out `src/`).
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
