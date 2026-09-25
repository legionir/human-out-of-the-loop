import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { ensureRepo, failureResult, isFailure, runGit } from '../git/git-runner.js';
import { parseRemotes, type RemoteInfo } from '../git/parse.js';

/**
 * Phase 41 — `git_remote_list`.
 *
 * A small tool with a real job before anything is pushed (phase 42): *where
 * would this go?* It lists the configured remotes with both URLs — fetch and
 * push, which differ more often than people expect — and the raw `git remote -v`
 * text, so a mismatch between what the model assumes and what is configured
 * surfaces before it matters.
 *
 * Nothing here contacts the network: `git remote -v` reads config only.
 */

const inputSchema = z.object({
  directory: z
    .string()
    .default('.')
    .describe('Directory inside the workspace; a repository is required.'),
  verbose: z.boolean().default(true).describe('Include the fetch/push URLs (git remote -v).'),
});

export interface GitRemoteListOutcome {
  success: boolean;
  directory?: string;
  repository?: string;
  remotes?: RemoteInfo[];
  names?: string[];
  count?: number;
  output?: string;
  warnings?: string;
  error?: string;
  code?: string;
}

type GitRemoteListInput = { directory: string; verbose: boolean };

export function createGitRemoteListTool(projectRoot: string) {
  const remoteTool: Tool<GitRemoteListInput, GitRemoteListOutcome> & {
    execute: (input: Partial<GitRemoteListInput>) => Promise<GitRemoteListOutcome>;
  } = {
    description:
      'Lists the configured git remotes with their fetch and push URLs (git remote -v) — where a push ' +
      'would go. Reads configuration only; it never contacts the network. Requires a repository inside ' +
      'the workspace.',
    inputSchema,
    execute: async (input) => {
      const directory = input.directory ?? '.';
      const verbose = input.verbose ?? true;

      const repo = await ensureRepo(directory, projectRoot);
      if (isFailure(repo)) return failureResult(repo) as GitRemoteListOutcome;

      const args = verbose ? ['remote', '-v'] : ['remote'];
      const result = await runGit(repo.directory, args);
      if (!result.ok) {
        return {
          ...(failureResult(result) as GitRemoteListOutcome),
          directory: repo.display,
          repository: repo.root,
        };
      }

      const remotes: RemoteInfo[] = verbose
        ? parseRemotes(result.stdout)
        : result.stdout
            .split('\n')
            .map((name) => name.trim())
            .filter(Boolean)
            .map((name): RemoteInfo => ({ name }));

      // One remote is often configured with only a fetch URL: report the push
      // URL as the fetch URL then, because that is what git would use.
      const normalized = remotes.map((remote) => ({
        ...remote,
        ...(remote.pushUrl === undefined && remote.fetchUrl !== undefined
          ? { pushUrl: remote.fetchUrl }
          : {}),
      }));

      return {
        success: true,
        directory: repo.display,
        repository: repo.root,
        remotes: normalized,
        names: normalized.map((remote) => remote.name),
        count: normalized.length,
        output: result.stdout.trimEnd(),
        warnings: result.stderr.trim() || undefined,
      };
    },
  };

  return tool(remoteTool);
}
