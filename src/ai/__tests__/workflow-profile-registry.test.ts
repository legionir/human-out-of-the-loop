import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('counts non-ASCII UTF-8 bytes at the exact file-size boundary', () => {
    const dir = tempDir();
    const file = path.join(dir, 'unicode-boundary.json');
    const profile = JSON.parse(sourceProfile('unicode-boundary')) as Record<string, any>;
    profile.profile['x-byte-boundary'] = 'é'.repeat(512);
    const encoded = Buffer.from(JSON.stringify(profile), 'utf8');
    expect(encoded.byteLength).toBeLessThan(MAX_WORKFLOW_PROFILE_BYTES);
    fs.writeFileSync(file, Buffer.concat([encoded, Buffer.alloc(MAX_WORKFLOW_PROFILE_BYTES - encoded.byteLength, 0x20)]));
    expect(loadWorkflowProfileFile(file, 'builtin').profile.profile.id).toBe('unicode-boundary');

    fs.appendFileSync(file, ' ');
    try {
      loadWorkflowProfileFile(file, 'builtin');
      throw new Error('expected UTF-8 byte cap + 1 to fail');
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

  it('fails closed on the same profile ID appearing in different scopes', () => {
    const builtInDir = tempDir();
    const projectDir = tempDir();
    fs.writeFileSync(path.join(builtInDir, 'base.json'), sourceProfile('shared-id'));
    fs.writeFileSync(path.join(projectDir, 'project.json'), sourceProfile('shared-id'));
    const builtIn = loadWorkflowProfilesFromDirectory({ directory: builtInDir, scope: 'builtin' }).list()[0]!;
    const project = loadWorkflowProfilesFromDirectory({ directory: projectDir, scope: 'project', projectOptIn: true }).list()[0]!;
    const registry = new WorkflowProfileRegistry();
    registry.register(builtIn);
    expect(() => registry.register(project)).toThrow(/duplicate workflow profile id/i);
  });

  it('revalidates and copies profiles registered through the public registry boundary', () => {
    const dir = tempDir();
    const file = path.join(dir, 'valid.json');
    fs.writeFileSync(file, sourceProfile('direct-registration'));
    const loaded = loadWorkflowProfileFile(file, 'builtin');
    const callerOwned = structuredClone(loaded.profile);
    const registry = new WorkflowProfileRegistry();
    registry.register({ ...loaded, profile: callerOwned });
    expect(Object.isFrozen(registry.get('direct-registration')?.profile)).toBe(true);
    expect(Object.isFrozen(callerOwned)).toBe(false);
    callerOwned.profile.name = 'mutated after register';
    expect(registry.get('direct-registration')?.profile.profile.name).not.toBe('mutated after register');

    const invalid = structuredClone(loaded.profile) as any;
    invalid.workflow.startNode = 'missing-node';
    expect(() => new WorkflowProfileRegistry().register({ ...loaded, profile: invalid })).toThrow(/invalid workflow profile/i);
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
    expect(() => selectWorkflowProfile(registry, { projectOptIn: true, projectDefaultProfileId: 'user-choice', builtInDefaultProfileId: 'built-in-default' })).toThrow(/not project-scoped/i);
  });

  it('rejects semantically invalid files at the direct loader boundary', () => {
    const dir = tempDir();
    const file = path.join(dir, 'semantic-invalid.json');
    const profile = JSON.parse(sourceProfile('semantic-invalid')) as Record<string, any>;
    profile.workflow.startNode = 'not-present';
    fs.writeFileSync(file, JSON.stringify(profile));
    try {
      loadWorkflowProfileFile(file, 'builtin');
      throw new Error('expected semantic validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowProfileLoadError);
      expect((error as WorkflowProfileLoadError).diagnostics.map((item) => item.code)).toContain('workflow.start-missing');
    }
  });

  it('rejects unsupported schema versions through the direct loader boundary', () => {
    const dir = tempDir();
    const file = path.join(dir, 'unsupported-version.json');
    const profile = JSON.parse(sourceProfile('unsupported-version')) as Record<string, any>;
    profile.schemaVersion = '2.0.0';
    fs.writeFileSync(file, JSON.stringify(profile));
    try {
      loadWorkflowProfileFile(file, 'builtin');
      throw new Error('expected unsupported schema version to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowProfileLoadError);
      expect((error as WorkflowProfileLoadError).diagnostics[0]?.code).toBe('schema-version.unsupported');
    }
  });

  it('rejects forged scope values at loader, directory and registry boundaries', () => {
    const dir = tempDir();
    const file = path.join(dir, 'scope.json');
    fs.writeFileSync(file, sourceProfile('scope-check'));
    const invalidScope = expect.objectContaining({ diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'scope.invalid' })]) });
    expect(() => loadWorkflowProfileFile(file, 'bypass' as any)).toThrow(invalidScope);
    const loaded = loadWorkflowProfileFile(file, 'builtin');
    expect(() => new WorkflowProfileRegistry().register({ ...loaded, scope: 'bypass' as any })).toThrow(invalidScope);
    expect(() => loadWorkflowProfilesFromDirectory({ directory: dir, scope: 'bypass' as any })).toThrow(invalidScope);
  });

  it('rejects a path replacement race between lstat and open', () => {
    const dir = tempDir();
    const file = path.join(dir, 'race.json');
    const backup = path.join(dir, 'race-original.json');
    const target = path.join(dir, 'untrusted-target.json');
    fs.writeFileSync(file, sourceProfile('race-original'));
    fs.writeFileSync(target, sourceProfile('race-target'));
    const realOpenSync = fs.openSync.bind(fs);
    let swapped = false;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((pathArg: fs.PathLike, flags: string | number, mode?: number) => {
      if (!swapped && path.resolve(String(pathArg)) === path.resolve(file)) {
        swapped = true;
        fs.renameSync(file, backup);
        fs.copyFileSync(target, file);
        const descriptor = realOpenSync(pathArg, flags as any, mode);
        fs.unlinkSync(file);
        fs.renameSync(backup, file);
        return descriptor;
      }
      return realOpenSync(pathArg, flags as any, mode);
    }) as typeof fs.openSync);
    try {
      expect(() => loadWorkflowProfileFile(file, 'builtin')).toThrow(WorkflowProfileLoadError);
      expect(swapped).toBe(true);
    } finally {
      openSpy.mockRestore();
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file);
      if (fs.existsSync(backup)) fs.renameSync(backup, file);
    }
  });

  it('reports missing paths and non-regular files as read-stage diagnostics', () => {
    const dir = tempDir();
    const missing = path.join(dir, 'missing.json');
    try {
      loadWorkflowProfileFile(missing, 'builtin');
      throw new Error('expected missing file to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowProfileLoadError);
      expect((error as WorkflowProfileLoadError).diagnostics[0]?.code).toBe('file.unreadable');
    }

    const nestedDirectory = path.join(dir, 'directory.json');
    fs.mkdirSync(nestedDirectory);
    try {
      loadWorkflowProfileFile(nestedDirectory, 'builtin');
      throw new Error('expected non-regular path to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowProfileLoadError);
      expect((error as WorkflowProfileLoadError).diagnostics[0]?.code).toBe('file.not-regular');
    }
  });

  it.skipIf(process.platform === 'win32')('rejects symbolic links instead of following them', () => {
    const dir = tempDir();
    const target = path.join(dir, 'target.json');
    const link = path.join(dir, 'linked.json');
    fs.writeFileSync(target, sourceProfile('symlink-target'));
    fs.symlinkSync(target, link, 'file');
    try {
      loadWorkflowProfileFile(link, 'builtin');
      throw new Error('expected symbolic link to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowProfileLoadError);
      expect((error as WorkflowProfileLoadError).diagnostics[0]?.code).toBe('file.not-regular');
    }
  });
});
