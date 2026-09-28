import fs from 'node:fs';
import path from 'node:path';
import { environmentBullets } from './environment.js';

/** Directory entries never worth a model's attention (and often huge). */
const CONTEXT_SKIP = new Set([
  'node_modules', '.git', '.ai-runtime', 'dist', 'build', 'out', 'coverage',
  '.next', '.cache', '.venv', '__pycache__', '.turbo', '.svelte-kit',
]);

/** How many top-level entries the context block lists. */
export const PROJECT_CONTEXT_MAX_ENTRIES = 40;

/** Shallow listing of `projectRoot`: directories first, heavy ones dropped. */
export function projectTopLevelEntries(projectRoot: string, max = PROJECT_CONTEXT_MAX_ENTRIES): string[] {
  try {
    return fs
      .readdirSync(projectRoot, { withFileTypes: true })
      .filter((entry) => !CONTEXT_SKIP.has(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => {
        const dirA = a.endsWith('/');
        const dirB = b.endsWith('/');
        if (dirA !== dirB) return dirA ? -1 : 1;
        return a.localeCompare(b);
      })
      .slice(0, max);
  } catch {
    return [];
  }
}

/** Build the PROJECT CONTEXT block included in planner and chat prompts. */
export function buildProjectContext(projectRoot: string | undefined): string {
  if (!projectRoot) return '';
  const root = path.resolve(projectRoot);
  const entries = projectTopLevelEntries(root);
  const lines = [
    'PROJECT CONTEXT (known — never ask the user for it):',
    `- project root: ${root}`,
    ...environmentBullets(),
    '- every path in the plan is relative to that root; read_file/write_file/search_code work inside it and nowhere else',
    '- the project already exists: questions like "which project?" or "what is the current directory?" are already answered by this block',
  ];
  if (entries.length > 0) lines.push(`- top-level entries: ${entries.join('  ')}`);
  if (fs.existsSync(path.join(root, 'package.json'))) {
    lines.push('- package.json is present (Node.js project)');
  }
  return lines.join('\n');
}
