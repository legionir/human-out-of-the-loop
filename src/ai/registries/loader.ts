import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Registry } from './base-registry.js';

// ─── Types ────────────────────────────────────────────────────────
export interface LoadResult {
  /** Number of entries successfully loaded and registered */
  loaded: number;
  /** Per-file errors collected during loading */
  errors: Array<{ file: string; error: string }>;
}

export interface LoadDirectoryOptions<T extends { id: string }> {
  /** Absolute or relative path to the directory containing JSON files */
  directory: string;
  /** Target registry instance */
  registry: Registry<T>;
  /** Zod schema for validation (should match the registry's schema) */
  schema: z.ZodType<T>;
  /** File extension to look for (default: ".json") */
  extension?: string;
  /**
   * When true, throws an AggregateError after scanning all files
   * if any errors were encountered. Use at startup to fail fast.
   * Default: false (returns errors in LoadResult).
   */
  strict?: boolean;
  /**
   * Phase 28: when true, a file whose id is already registered REPLACES
   * the existing entry instead of being reported as a duplicate error.
   * Used by the project layer to override packaged defaults.
   */
  override?: boolean;
}

// ─── Loader ──────────────────────────────────────────────────────
/**
 * Reads all matching files from `directory`, parses JSON, validates
 * each against `schema`, and registers into `registry`.
 *
 * Errors are collected per-file so that a single malformed file
 * does not prevent the rest from loading.  In `strict` mode the
 * function throws an AggregateError after the full scan.
 */
export function loadRegistryFromDirectory<T extends { id: string }>(
  options: LoadDirectoryOptions<T>
): LoadResult {
  const { directory, registry, extension = '.json', strict = false, override = false } = options;

  const result: LoadResult = { loaded: 0, errors: [] };

  // 1. Directory existence check
  if (!fs.existsSync(directory)) {
    result.errors.push({
      file: directory,
      error: `Directory does not exist: ${directory}`,
    });
    if (strict) {
      throw new Error(`[loader] Directory does not exist: ${directory}`);
    }
    return result;
  }

  const stat = fs.statSync(directory);
  if (!stat.isDirectory()) {
    result.errors.push({
      file: directory,
      error: `Path is not a directory: ${directory}`,
    });
    if (strict) {
      throw new Error(`[loader] Path is not a directory: ${directory}`);
    }
    return result;
  }

  // 2. Read and filter files
  const files = fs
    .readdirSync(directory)
    .filter((f) => f.endsWith(extension))
    .sort(); // deterministic order

  // 3. Process each file
  for (const file of files) {
    const filePath = path.join(directory, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data: unknown = JSON.parse(raw);
      if (override) {
        registry.replace(data);
      } else {
        registry.register(data);
      }
      result.loaded++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ file: filePath, error: message });
    }
  }

  // 4. Strict mode: throw after full scan
  if (strict && result.errors.length > 0) {
    const summary = result.errors
      .map((e) => `  • ${e.file}: ${e.error}`)
      .join('\n');
    throw new Error(
      `[loader] ${result.errors.length} error(s) while loading "${directory}":\n${summary}`
    );
  }

  return result;
}

/**
 * Convenience: load a single JSON file into a registry.
 */
export function loadSingleFile<T extends { id: string }>(
  filePath: string,
  registry: Registry<T>
): void {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data: unknown = JSON.parse(raw);
  registry.register(data);
}
