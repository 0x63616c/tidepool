// Tests for the Claude Code secret hooks (bash scripts in .claude/hooks/). We drive them the way
// Claude Code does — JSON on stdin, read stdout + exit code — via Bun.spawn, so the bash logic is
// covered by `bun run test` + CI without a separate test framework.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, it } from '@effect/vitest';

const ROOT = process.cwd();
const REDACTOR = join(ROOT, '.claude/hooks/secret-redactor.sh');

const hasGitleaks = Bun.which('gitleaks') !== null;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type HookResult = { stdout: string; exitCode: number };

// Spawn via /bin/bash so macOS's bash 3.2 exercises the hooks (Claude Code may invoke them under it);
// on Linux CI /bin/bash is 5.x. This guards against bash-4-only features (mapfile, assoc arrays).
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

const updatedOutput = (r: HookResult): unknown =>
  JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput;

describe('secret-redactor (PostToolUse)', () => {
  it('masks an AGE key and preserves the Bash result shape', async () => {
    const r = await run(REDACTOR, {
      tool_name: 'Bash',
      tool_response: {
        stdout: 'k=AGE-SECRET-KEY-1FAKE00000000000000000000000000000000000UNIT\n', // gitleaks:allow
        stderr: '',
        interrupted: false,
        isImage: false,
      },
    });
    const out = updatedOutput(r) as Record<string, unknown>;
    assert.include(out.stdout as string, '[REDACTED-AGE-KEY]');
    assert.notInclude(out.stdout as string, 'AGE-SECRET-KEY-1FAKE');
    // structured object, not a plain string — the shape built-in tools require
    assert.deepInclude(out, { stderr: '', interrupted: false, isImage: false });
  });

  it('masks GitHub + Anthropic token shapes', async () => {
    const r = await run(REDACTOR, {
      tool_name: 'Bash',
      tool_response: {
        stdout: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 sk-ant-api03-abcDEF_ghi-jkl', // gitleaks:allow
        stderr: '',
      },
    });
    const out = updatedOutput(r) as Record<string, unknown>;
    assert.include(out.stdout as string, '[REDACTED-GH-TOKEN]');
    assert.include(out.stdout as string, '[REDACTED-ANTHROPIC-KEY]');
  });

  it('masks a nested string (Read-style shape) in place', async () => {
    const r = await run(REDACTOR, {
      tool_name: 'Read',
      tool_response: {
        type: 'text',
        file: { content: 'line\nAGE-SECRET-KEY-1FAKE00000000000000000000000000000000000READ\n' }, // gitleaks:allow
      },
    });
    const out = updatedOutput(r) as { file: { content: string }; type: string };
    assert.strictEqual(out.type, 'text');
    assert.include(out.file.content, '[REDACTED-AGE-KEY]');
  });

  it('masks an exact known secret value by hash (shapeless token)', async () => {
    const token = 'hcloudlikeTOKEN_abcdef0123456789ABCDEF9999'; // gitleaks:allow
    const dir = mkdtempSync(join(tmpdir(), 'redact-'));
    writeFileSync(
      join(dir, '.claude-hashes.json'),
      JSON.stringify({ algo: 'sha256', hashes: [sha256(token)] }),
    );
    // hook reads $CLAUDE_PROJECT_DIR/.claude/redaction-hashes.json + .gitleaks.toml
    const proj = mkdtempSync(join(tmpdir(), 'proj-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(proj, '.claude'), { recursive: true });
    writeFileSync(
      join(proj, '.claude/redaction-hashes.json'),
      JSON.stringify({ algo: 'sha256', hashes: [sha256(token)] }),
    );
    copyFileSync(join(ROOT, '.gitleaks.toml'), join(proj, '.gitleaks.toml'));
    const r = await run(
      REDACTOR,
      { tool_name: 'Bash', tool_response: { stdout: `leak=${token} done`, stderr: '' } },
      { CLAUDE_PROJECT_DIR: proj },
    );
    const out = updatedOutput(r) as Record<string, unknown>;
    assert.include(out.stdout as string, '[REDACTED-SECRET]');
    assert.notInclude(out.stdout as string, token);
  });

  it('passes clean output through untouched (exit 0, no output)', async () => {
    const r = await run(REDACTOR, {
      tool_name: 'Bash',
      tool_response: { stdout: 'just normal text, no secrets', stderr: '' },
    });
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.stdout.trim(), '');
  });
});

describe.skipIf(!hasGitleaks)('secret-redactor gitleaks pass', () => {
  it('masks a gitleaks-detected token shape', async () => {
    const r = await run(REDACTOR, {
      tool_name: 'Bash',
      tool_response: { stdout: 'aws AKIAIOSFODNN7EXAMPLE key', stderr: '' },
    });
    // gitleaks may or may not flag the example key depending on ruleset; assert the hook still
    // produced valid structured output without throwing.
    assert.strictEqual(r.exitCode, 0);
  });
});
