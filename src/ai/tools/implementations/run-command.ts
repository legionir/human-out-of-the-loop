import { tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { resolvePathInWorkspace } from './path-security.js';
import { getAgentRunContext } from '../../runtime/agent-run-context.js';
import { isCommandAllowed, loadCommandPolicy } from '../command-allowlist.js';
import { spawnArgv } from '../spawn-argv.js';

function relativeCwd(projectRoot: string, requested?: string): Promise<{ ok: true; cwd: string } | { ok: false; error: string; code: string }> {
  if (!requested || requested === '.' || requested === '') {
    return Promise.resolve({ ok: true, cwd: projectRoot });
  }
  return resolvePathInWorkspace(requested, [projectRoot]).then((check) => {
    if (!check.safe) {
      return { ok: false as const, error: check.reason ?? 'cwd outside project', code: 'PATH_TRAVERSAL_BLOCKED' };
    }
    return { ok: true as const, cwd: check.resolvedPath };
  });
}

export function createRunCommandTool(projectRoot: string) {
  return tool({
    description:
      'Run an allowlisted command as argv (no shell). The first argument must be on the project allowlist. Output is capped; a timeout kills the process group.',
    inputSchema: z.object({
      argv: z.array(z.string().min(1)).min(1).describe('Command and arguments, no shell'),
      cwd: z.string().optional().describe('Working directory relative to the project root'),
    }),
    execute: async ({ argv, cwd: requestedCwd }, options) => {
      if (options?.abortSignal?.aborted) {
        return { success: false as const, error: 'Aborted', code: 'ABORTED' };
      }
      const policy = loadCommandPolicy(projectRoot);
      const bin = argv[0]!;
      if (!isCommandAllowed(bin, policy.allow)) {
        return {
          success: false as const,
          error: `Command "${path.basename(bin)}" is not on the allowlist (${policy.allow.join(', ') || 'empty'}).`,
          code: 'NOT_ALLOWED',
        };
      }
      const cwd = await relativeCwd(projectRoot, requestedCwd);
      if (!cwd.ok) return { success: false as const, error: cwd.error, code: cwd.code };
      const result = await spawnArgv(argv, {
        cwd: cwd.cwd,
        timeoutMs: policy.timeoutMs,
        maxBytes: policy.maxOutputBytes,
        abortSignal: options?.abortSignal ?? getAgentRunContext()?.abortSignal,
      });
      return {
        success: result.ok,
        code: result.timedOut ? 'TIMEOUT' : result.truncated ? 'TRUNCATED' : result.ok ? undefined : 'EXIT',
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        ...(result.error ? { error: result.error } : {}),
      };
    },
  });
}

export function createRunTestsTool(projectRoot: string) {
  return tool({
    description:
      'Run the project test command from .ai-runtime/commands.json (or HOTL_TEST_COMMAND). No shell; output is capped; timeout kills the process group.',
    inputSchema: z.object({}),
    execute: async (_input, options) => {
      if (options?.abortSignal?.aborted) {
        return { success: false as const, error: 'Aborted', code: 'ABORTED' };
      }
      return runProjectTests(projectRoot, options?.abortSignal);
    },
  });
}

/** Shared by the tool and the post-coder self-verify loop (J-02). */
export async function runProjectTests(
  projectRoot: string,
  abortSignal?: AbortSignal,
): Promise<{
  success: boolean;
  code?: string;
  error?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  argv?: string[];
}> {
  const policy = loadCommandPolicy(projectRoot);
  if (policy.testCommand.length === 0) {
    return {
      success: false,
      code: 'NO_TEST_COMMAND',
      error: 'No test command configured (set .ai-runtime/commands.json testCommand or HOTL_TEST_COMMAND).',
      exitCode: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: 0,
    };
  }
  const bin = policy.testCommand[0]!;
  if (!isCommandAllowed(bin, policy.allow.length > 0 ? policy.allow : [bin])) {
    return {
      success: false,
      code: 'NOT_ALLOWED',
      error: `Test command "${path.basename(bin)}" is not on the allowlist.`,
      exitCode: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: 0,
      argv: policy.testCommand,
    };
  }
  const result = await spawnArgv(policy.testCommand, {
    cwd: projectRoot,
    timeoutMs: policy.timeoutMs,
    maxBytes: policy.maxOutputBytes,
    abortSignal,
  });
  return {
    success: result.ok,
    code: result.timedOut ? 'TIMEOUT' : result.truncated ? 'TRUNCATED' : result.ok ? undefined : 'EXIT',
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    argv: policy.testCommand,
    ...(result.error ? { error: result.error } : {}),
  };
}
