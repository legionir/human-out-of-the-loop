import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const SRC_AI = path.resolve(__dirname, '../');
const REGISTRY = path.resolve(__dirname, '../../../registry');

// ─── Architect perspective ───────────────────────────────────────

describe('Architecture Quality Gate', () => {
  it('Registry layer is decoupled from Runtime layer', () => {
    const registryFiles = fs.readdirSync(path.join(SRC_AI, 'registries'));
    for (const file of registryFiles) {
      if (!file.endsWith('.ts')) continue;
      const content = fs.readFileSync(path.join(SRC_AI, 'registries', file), 'utf-8');
      expect(content).not.toContain("from '../runtime/");
      expect(content).not.toContain("from '../agents/agent-factory");
    }
  });

  it('Agents do not directly import tool implementations', () => {
    const agentsDir = path.join(SRC_AI, 'agents');
    if (fs.existsSync(agentsDir)) {
      const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.ts'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(agentsDir, file), 'utf-8');
        expect(content).not.toContain("from '../tools/implementations/read-file");
        expect(content).not.toContain("from '../tools/implementations/write-file");
        expect(content).not.toContain("from '../tools/implementations/search-code");
        expect(content).not.toContain("from '../tools/implementations/git-status");
      }
    }
  });

  it('Persona/Skill/Tool separation is maintained', () => {
    const personasDir = path.join(REGISTRY, 'personas');
    if (fs.existsSync(personasDir)) {
      const files = fs.readdirSync(personasDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const data = JSON.parse(fs.readFileSync(path.join(personasDir, file), 'utf-8'));
        expect(data).not.toHaveProperty('modulePath');
        expect(data).not.toHaveProperty('execute');
      }
    }
  });
});

// ─── QA perspective ──────────────────────────────────────────────

describe('QA Quality Gate', () => {
  it('all schema files export Zod schemas', () => {
    const schemasDir = path.join(SRC_AI, 'schemas');
    const schemaFiles = fs.readdirSync(schemasDir).filter(
      (f) => f.endsWith('.ts') && f !== 'index.ts'
    );

    expect(schemaFiles.length).toBeGreaterThanOrEqual(7);

    for (const file of schemaFiles) {
      const content = fs.readFileSync(path.join(schemasDir, file), 'utf-8');
      // Allow both z.object( and z\n  .object( forms
      expect(content).toMatch(/z\s*\n?\s*\.?\s*object\s*\(/);
    }
  });

  it('test files exist for all major phases', () => {
    const testDir = path.join(SRC_AI, '__tests__');
    const testFiles = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.ts'));

    expect(testFiles.length).toBeGreaterThanOrEqual(15);
  });
});

// ─── Security perspective ────────────────────────────────────────

describe('Security Quality Gate', () => {
  it('path-security module exists and exports validation functions', () => {
    const securityFile = path.join(SRC_AI, 'tools/implementations/path-security.ts');
    expect(fs.existsSync(securityFile)).toBe(true);

    const content = fs.readFileSync(securityFile, 'utf-8');
    expect(content).toContain('isPathWithinWorkspace');
    expect(content).toContain('validateWorkspacePath');
  });

  it('no hardcoded API keys in registry files', () => {
    const registryFiles = getAllFiles(REGISTRY, '.json');
    for (const file of registryFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      expect(content).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
      expect(content).not.toMatch(/ANTHROPIC_API_KEY.*=.*\"[^\"]+\"/);
    }
  });

  it('MCP server configs reference env vars, not inline credentials', () => {
    const mcpDir = path.join(REGISTRY, 'mcp-servers');
    if (fs.existsSync(mcpDir)) {
      const files = fs.readdirSync(mcpDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(mcpDir, file), 'utf-8');
        expect(content).not.toMatch(/\"token\"\s*:\s*\"[^\"]{10,}\"/);
        expect(content).not.toMatch(/\"apiKey\"\s*:\s*\"[^\"]{10,}\"/);
      }
    }
  });
});

// ─── DevOps perspective ──────────────────────────────────────────

describe('DevOps Quality Gate', () => {
  it('all provider factories check for env vars', () => {
    const providersDir = path.join(SRC_AI, 'models/providers');
    const providerFiles = fs.readdirSync(providersDir).filter(
      (f) => f.endsWith('.ts') && f !== 'index.ts'
    );

    for (const file of providerFiles) {
      const content = fs.readFileSync(path.join(providersDir, file), 'utf-8');
      if (content.includes('create(')) {
        expect(content).toMatch(/process\.env\./);
      }
    }
  });

  it('configurable ceilings are documented in code', () => {
    const planRuntime = fs.readFileSync(
      path.join(SRC_AI, 'runtime/plan-runtime.ts'),
      'utf-8'
    );
    expect(planRuntime).toContain('maxReplanningAttempts');

    const taskRuntime = fs.readFileSync(
      path.join(SRC_AI, 'runtime/task-runtime.ts'),
      'utf-8'
    );
    expect(taskRuntime).toContain('maxConcurrentTasks');

    const rateLimiter = fs.readFileSync(
      path.join(SRC_AI, 'runtime/rate-limiter.ts'),
      'utf-8'
    );
    expect(rateLimiter).toContain('maxConcurrentPerProvider');
    expect(rateLimiter).toContain('maxRetries');
  });
});

// ─── Law 17 (Human-Out-Of-Loop) verification ────────────────────

describe('Law 17: Human-Out-Of-Loop compliance', () => {
  it('PlanRuntime has no stdin/readline/prompt calls', () => {
    const planRuntime = fs.readFileSync(
      path.join(SRC_AI, 'runtime/plan-runtime.ts'),
      'utf-8'
    );
    expect(planRuntime).not.toContain('readline');
    expect(planRuntime).not.toContain('process.stdin');
    expect(planRuntime).not.toContain('prompt(');
    expect(planRuntime).not.toContain('inquirer');
  });

  it('AcceptanceChecker has no human interaction', () => {
    const checker = fs.readFileSync(
      path.join(SRC_AI, 'runtime/acceptance-checker.ts'),
      'utf-8'
    );
    expect(checker).not.toContain('readline');
    expect(checker).not.toContain('process.stdin');
    expect(checker).not.toContain('prompt(');
  });

  it('FinalReviewer has no human interaction', () => {
    const reviewer = fs.readFileSync(
      path.join(SRC_AI, 'runtime/final-reviewer.ts'),
      'utf-8'
    );
    expect(reviewer).not.toContain('readline');
    expect(reviewer).not.toContain('process.stdin');
    expect(reviewer).not.toContain('prompt(');
  });
});

function getAllFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllFiles(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}
