// Tests for the local-dev Claude Code hooks (bash scripts in .claude/hooks/): main-guard (PreToolUse
// block on `main`) and worktree-gc (SessionStart cleanup of finished worktrees). Driven the way Claude
// Code drives them — JSON on stdin, read stdout + exit code — via Bun.spawn under /bin/bash so macOS's
// bash 3.2 exercises the scripts (no bash-4 features). Covered by `bun run test` + CI.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';

const ROOT = process.cwd();
const MAIN_GUARD = join(ROOT, '.claude/hooks/main-guard.sh');
const WORKTREE_GC = join(ROOT, '.claude/hooks/worktree-gc.sh');

type HookResult = { stdout: string; exitCode: number };

const run = async (
  script: string,
  input: unknown,
  env?: Record<string, string>,
): Promise<HookResult> => {
  const proc = Bun.spawn(['/bin/bash', script], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { stdout, exitCode };
};

// Deterministic, quiet git in throwaway repos.
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

// A fresh single-repo on `main` with one commit.
const initRepo = (): string => {
  const dir = tmp('mg-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'f'), 'x');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
};

const guardInput = (cwd: string, command: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  cwd,
  tool_input: { command },
});

const deny = (r: HookResult): boolean => {
  if (r.stdout.trim() === '') return false;
  try {
    return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision === 'deny';
  } catch {
    return false;
  }
};

describe('main-guard (PreToolUse)', () => {
  it('denies `git commit` while HEAD is main', async () => {
    const dir = initRepo();
    const r = await run(MAIN_GUARD, guardInput(dir, 'git commit -m "wip"'));
    assert.isTrue(deny(r), `expected deny, got: ${r.stdout}`);
  });

  it('denies `git merge` and `git push` on main', async () => {
    const dir = initRepo();
    assert.isTrue(deny(await run(MAIN_GUARD, guardInput(dir, 'git merge feature'))));
    assert.isTrue(deny(await run(MAIN_GUARD, guardInput(dir, 'git push origin main'))));
  });

  it('denies commit with global flags (`git -c user.name=x commit`) on main', async () => {
    const dir = initRepo();
    const r = await run(MAIN_GUARD, guardInput(dir, 'git -c user.name=x commit -m z'));
    assert.isTrue(deny(r), `expected deny, got: ${r.stdout}`);
  });

  it('allows `git commit` on a worktree-* branch', async () => {
    const dir = initRepo();
    git(dir, 'checkout', '-q', '-b', 'worktree-calum+add-slug');
    const r = await run(MAIN_GUARD, guardInput(dir, 'git commit -m "wip"'));
    assert.isFalse(deny(r));
    assert.strictEqual(r.exitCode, 0);
  });

  it('allows a non-git command on main', async () => {
    const dir = initRepo();
    const r = await run(MAIN_GUARD, guardInput(dir, 'ls -la'));
    assert.isFalse(deny(r));
    assert.strictEqual(r.exitCode, 0);
  });

  it('allows read-only git (`git log`) on main', async () => {
    const dir = initRepo();
    const r = await run(MAIN_GUARD, guardInput(dir, 'git log --oneline'));
    assert.isFalse(deny(r));
  });

  it('no-ops (allows) in-cluster when KUBERNETES_SERVICE_HOST is set', async () => {
    const dir = initRepo();
    const r = await run(MAIN_GUARD, guardInput(dir, 'git commit -m x'), {
      KUBERNETES_SERVICE_HOST: '10.0.0.1',
    });
    assert.isFalse(deny(r));
    assert.strictEqual(r.exitCode, 0);
  });
});

// --- worktree-gc ---------------------------------------------------------------------------------

const gcInput = (cwd: string) => ({ hook_event_name: 'SessionStart', source: 'startup', cwd });

// Build a project repo (with a bare origin) plus a helper to add worktrees under .claude/worktrees/.
const initProject = () => {
  const origin = tmp('gc-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const proj = tmp('gc-proj-');
  git(proj, 'clone', '-q', origin, '.');
  git(proj, 'config', 'user.email', 't@t');
  git(proj, 'config', 'user.name', 'T');
  writeFileSync(join(proj, 'f'), 'x');
  git(proj, 'add', '.');
  git(proj, 'commit', '-qm', 'init');
  git(proj, 'push', '-q', '-u', 'origin', 'main');
  const addWorktree = (name: string, branch: string) => {
    const p = join(proj, '.claude/worktrees', name);
    git(proj, 'worktree', 'add', '-q', '-b', branch, p, 'main');
    return p;
  };
  return { origin, proj, addWorktree };
};

const removed = (r: HookResult): string => {
  if (r.stdout.trim() === '') return '';
  try {
    return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? '';
  } catch {
    return '';
  }
};

const exists = (dir: string, p: string): boolean =>
  git(dir, 'worktree', 'list', '--porcelain').includes(p);

describe('worktree-gc (SessionStart)', () => {
  it('removes a merged + clean worktree-* worktree', async () => {
    const { proj, addWorktree } = initProject();
    const wt = addWorktree('m1', 'worktree-calum+merged');
    writeFileSync(join(wt, 'g'), 'y');
    git(wt, 'add', '.');
    git(wt, 'commit', '-qm', 'work');
    git(proj, 'merge', '-q', 'worktree-calum+merged'); // fast-forward into main
    const r = await run(WORKTREE_GC, gcInput(proj));
    assert.strictEqual(r.exitCode, 0);
    assert.isFalse(exists(proj, wt), 'merged worktree should be removed');
  });

  it('removes an upstream-gone + clean worktree (squash-merge case)', async () => {
    const { origin, proj, addWorktree } = initProject();
    const wt = addWorktree('g1', 'worktree-calum+gone');
    writeFileSync(join(wt, 'g'), 'y');
    git(wt, 'add', '.');
    git(wt, 'commit', '-qm', 'work');
    git(wt, 'push', '-q', '-u', 'origin', 'worktree-calum+gone');
    git(origin, 'branch', '-D', 'worktree-calum+gone'); // PR squash-merged, remote branch deleted
    const r = await run(WORKTREE_GC, gcInput(proj));
    assert.strictEqual(r.exitCode, 0);
    assert.isFalse(exists(proj, wt), 'upstream-gone worktree should be removed');
  });

  it('keeps a dirty worktree', async () => {
    const { proj, addWorktree } = initProject();
    const wt = addWorktree('d1', 'worktree-calum+dirty');
    git(proj, 'merge', '-q', 'worktree-calum+dirty');
    writeFileSync(join(wt, 'uncommitted'), 'z'); // dirty tree
    const r = await run(WORKTREE_GC, gcInput(proj));
    assert.isTrue(exists(proj, wt), 'dirty worktree must be kept');
  });

  it('keeps an unmerged + never-pushed worktree (unpushed work)', async () => {
    const { proj, addWorktree } = initProject();
    const wt = addWorktree('u1', 'worktree-calum+unmerged');
    writeFileSync(join(wt, 'g'), 'y');
    git(wt, 'add', '.');
    git(wt, 'commit', '-qm', 'local only'); // not merged, no upstream
    const r = await run(WORKTREE_GC, gcInput(proj));
    assert.isTrue(exists(proj, wt), 'unmerged unpushed worktree must be kept');
  });

  it('keeps a merged + clean worktree on a non-worktree-* branch', async () => {
    const { proj, addWorktree } = initProject();
    const wt = addWorktree('f1', 'feature/x');
    git(proj, 'merge', '-q', 'feature/x');
    const r = await run(WORKTREE_GC, gcInput(proj));
    assert.isTrue(exists(proj, wt), 'non-local-pattern branch must be untouched');
  });

  it('keeps the current session worktree even if merged + clean', async () => {
    const { proj, addWorktree } = initProject();
    const wt = addWorktree('c1', 'worktree-calum+current');
    git(proj, 'merge', '-q', 'worktree-calum+current');
    const r = await run(WORKTREE_GC, gcInput(wt)); // cwd == this worktree
    assert.isTrue(exists(proj, wt), 'the active session worktree must never be removed');
  });

  it('reports what it removed via additionalContext', async () => {
    const { proj, addWorktree } = initProject();
    const wt = addWorktree('r1', 'worktree-calum+report');
    git(proj, 'merge', '-q', 'worktree-calum+report');
    const r = await run(WORKTREE_GC, gcInput(proj));
    assert.include(removed(r), wt);
  });

  it('exits 0 in a repo with no reachable remote', async () => {
    const dir = initRepo(); // no remote at all
    const r = await run(WORKTREE_GC, gcInput(dir));
    assert.strictEqual(r.exitCode, 0);
  });

  it('no-ops in-cluster when KUBERNETES_SERVICE_HOST is set', async () => {
    const { proj, addWorktree } = initProject();
    const wt = addWorktree('k1', 'worktree-calum+incluster');
    git(proj, 'merge', '-q', 'worktree-calum+incluster');
    const r = await run(WORKTREE_GC, gcInput(proj), { KUBERNETES_SERVICE_HOST: '10.0.0.1' });
    assert.strictEqual(r.exitCode, 0);
    assert.isTrue(exists(proj, wt), 'in-cluster run must not remove anything');
  });
});
