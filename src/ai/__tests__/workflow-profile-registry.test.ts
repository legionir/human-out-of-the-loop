import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_WORKFLOW_PROFILE_BYTES,
  WorkflowProfileLoadError,
  WorkflowProfileRegistry,
  loadWorkflowProfileFile,
  loadWorkflowProfilesFromDirectory,
  selectWorkflowProfile,
} from '../workflow-profiles/profile-registry.js';

const fixturePath = path.resolve(process.cwd(), 'docs/workflow-profiles/default-workflow-profile.example.json');
const tempRoots: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hootl-profile-'));
  tempRoots.push(dir);
  return dir;
}
function sourceProfile(id: string): string {
  const profile = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Record<string, any>;
  profile.profile.id = id;
  return JSON.stringify(profile);
}
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Workflow Profile loader and registry', () => {
  it('accepts a valid file at exactly 1 MiB and rejects cap + 1 before JSON parsing', () => {
    const dir = tempDir();
    const file = path.join(dir, 'profile.json');
    const json = sourceProfile('size-boundary');
    const encoded = Buffer.from(json, 'utf8');
    expect(encoded.byteLength).toBeLessThan(MAX_WORKFLOW_PROFILE_BYTES);
    fs.writeFileSync(file, Buffer.concat([encoded, Buffer.alloc(MAX_WORKFLOW_PROFILE_BYTES - encoded.byteLength, 0x20)]));
    expect(loadWorkflowProfileFile(file, 'builtin').profile.profile.id).toBe('size-boundary');

    fs.writeFileSync(file, Buffer.concat([encoded, Buffer.alloc(MAX_WORKFLOW_PROFILE_BYTES + 1 - encoded.byteLength, 0x20)]));
    try {
      loadWorkflowProfileFile(file, 'builtin');
      throw new Error('expected oversize file to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowProfileLoadError);
      expect((error as WorkflowProfileLoadError).diagnostics[0]?.code).toBe('file.too-large');
    }
  });

  it('rejects invalid UTF-8 and malformed JSON distinctly', () => {
    const dir = tempDir();
    const invalidUtf8 = path.join(dir, 'utf8.json');
    fs.writeFileSync(invalidUtf8, Buffer.from([0xc3, 0x28]));
    expect(() => loadWorkflowProfileFile(invalidUtf8, 'builtin')).toThrow(/UTF-8/i);
    const malformed = path.join(dir, 'bad.json');
    fs.writeFileSync(malformed, '{nope');
    try { loadWorkflowProfileFile(malformed, 'builtin'); } catch (error) {
      expect((error as WorkflowProfileLoadError).diagnostics[0]?.stage).toBe('parse');
    }
  });

  it('loads only explicit directories and requires opt-in before reading a project scope', () => {
    const project = tempDir();
    fs.writeFileSync(path.join(project, 'one.json'), sourceProfile('project-one'));
    expect(() => loadWorkflowProfilesFromDirectory({ directory: project, scope: 'project' })).toThrow(/opt-in/i);
    const registry = loadWorkflowProfilesFromDirectory({ directory: project, scope: 'project', projectOptIn: true });
    expect(registry.get('project-one')?.scope).toBe('project');
    expect(registry.size).toBe(1);
  });

  it('fails closed for the whole directory on malformed, inaccessible, or duplicate profile entries', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'a.json'), sourceProfile('same'));
    fs.writeFileSync(path.join(dir, 'b.json'), sourceProfile('same'));
    expect(() => loadWorkflowProfilesFromDirectory({ directory: dir, scope: 'builtin' })).toThrow(/failed/i);

    fs.rmSync(path.join(dir, 'b.json'));
    fs.writeFileSync(path.join(dir, 'b.json'), '{');
    expect(() => loadWorkflowProfilesFromDirectory({ directory: dir, scope: 'builtin' })).toThrow(/failed/i);
  });

  it('freezes nested profile content and exposes only read-only registry listings', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'one.json'), sourceProfile('immutable'));
    const registry = loadWorkflowProfilesFromDirectory({ directory: dir, scope: 'builtin' });
    const loaded = registry.get('immutable')!;
    expect(Object.isFrozen(loaded.profile)).toBe(true);
    expect(Object.isFrozen(loaded.profile.workflow.nodes)).toBe(true);
    expect(() => { (loaded.profile.profile as any).name = 'mutated'; }).toThrow();
    expect(Object.isFrozen(registry.list())).toBe(true);
  });

  it('selects exactly one profile by explicit request, opted-in project fallback, then built-in default', () => {
    const builtInDir = tempDir();
    const projectDir = tempDir();
    const selectedDir = tempDir();
    fs.writeFileSync(path.join(builtInDir, 'base.json'), sourceProfile('built-in-default'));
    fs.writeFileSync(path.join(projectDir, 'project.json'), sourceProfile('project-default'));
    fs.writeFileSync(path.join(selectedDir, 'selected.json'), sourceProfile('user-choice'));
    const registry = new WorkflowProfileRegistry();
    for (const entry of loadWorkflowProfilesFromDirectory({ directory: builtInDir, scope: 'builtin' }).list()) registry.register(entry);
    for (const entry of loadWorkflowProfilesFromDirectory({ directory: projectDir, scope: 'project', projectOptIn: true }).list()) registry.register(entry);
    for (const entry of loadWorkflowProfilesFromDirectory({ directory: selectedDir, scope: 'user-selected' }).list()) registry.register(entry);

    expect(selectWorkflowProfile(registry, { requestedProfileId: 'user-choice', projectOptIn: true, projectDefaultProfileId: 'project-default', builtInDefaultProfileId: 'built-in-default' }).profile.profile.id).toBe('user-choice');
    expect(selectWorkflowProfile(registry, { projectOptIn: true, projectDefaultProfileId: 'project-default', builtInDefaultProfileId: 'built-in-default' }).profile.profile.id).toBe('project-default');
    expect(selectWorkflowProfile(registry, { builtInDefaultProfileId: 'built-in-default' }).profile.profile.id).toBe('built-in-default');
    expect(() => selectWorkflowProfile(registry, { requestedProfileId: 'project-default', projectOptIn: false, builtInDefaultProfileId: 'built-in-default' })).toThrow(/opt-in/i);
    expect(() => selectWorkflowProfile(registry, { requestedProfileId: '', builtInDefaultProfileId: 'built-in-default' })).toThrow(/not discovered/i);
    expect(() => selectWorkflowProfile(registry, { projectOptIn: true, projectDefaultProfileId: '', builtInDefaultProfileId: 'built-in-default' })).toThrow(/not discovered/i);
  });
});
