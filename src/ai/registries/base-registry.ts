import { z, ZodError } from 'zod';

// ─── Types ────────────────────────────────────────────────────────
export interface RegistryOptions<T extends { id: string }> {
  /** Zod schema used to validate every entry on register() */
  schema: z.ZodType<T>;
  /** Human-readable label for error messages (e.g. "ToolRegistry") */
  label?: string;
}

export interface RegisterResult<T> {
  success: true;
  entry: T;
}

export interface RegisterError {
  success: false;
  reason: 'duplicate' | 'validation';
  message: string;
  zodError?: ZodError;
}

// ─── Registry class ──────────────────────────────────────────────
export class Registry<T extends { id: string }> {
  private readonly entries = new Map<string, T>();
  private readonly schema: z.ZodType<T>;
  private readonly label: string;

  constructor(options: RegistryOptions<T>) {
    this.schema = options.schema;
    this.label = options.label ?? 'Registry';
  }

  /**
   * Validate and store an entry.
   * Accepts `unknown` so that raw JSON from the loader can be passed directly.
   * Throws on duplicate id or schema violation — callers that need
   * non-throwing behaviour should use `tryRegister()`.
   */
  register(raw: unknown): T {
    // 1. Schema validation
    const parsed = this.schema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`[${this.label}] Validation failed:\n${issues}`);
    }

    const entry = parsed.data;

    // 2. Duplicate check
    if (this.entries.has(entry.id)) {
      throw new Error(
        `[${this.label}] Duplicate id "${entry.id}" — an entry with this id is already registered.`
      );
    }

    this.entries.set(entry.id, entry);
    return entry;
  }

  /**
   * Non-throwing variant — returns a discriminated-union result.
   */
  tryRegister(raw: unknown): RegisterResult<T> | RegisterError {
    try {
      const entry = this.register(raw);
      return { success: true, entry };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Duplicate id')) {
        return { success: false, reason: 'duplicate', message };
      }
      return {
        success: false,
        reason: 'validation',
        message,
        zodError: err instanceof ZodError ? err : undefined,
      };
    }
  }

  get(id: string): T | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): ReadonlyArray<T> {
    return Array.from(this.entries.values());
  }

  get size(): number {
    return this.entries.size;
  }
}

// ─── Factory function ────────────────────────────────────────────
export function createRegistry<T extends { id: string }>(
  options: RegistryOptions<T>
): Registry<T> {
  return new Registry<T>(options);
}
