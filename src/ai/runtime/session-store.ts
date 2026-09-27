import fs from 'node:fs';
import path from 'node:path';
import {
  SessionSchema,
  type Session,
  type SessionInteraction,
  createSession,
  createInteraction,
} from '../schemas/session.js';
import {
  SESSION_LABEL_MAX_CHARS,
  SESSION_REVIEW_SUMMARY_MAX_CHARS,
  SESSION_USER_REQUEST_MAX_CHARS,
  clipSessionText,
} from './session-limits.js';
import { hashedStoreFileName } from './plan-store.js';
import { atomicWriteFileSync } from './atomic-write.js';
import { lockPathFor, withFileLockSync } from './file-lock.js';

// ─── Interface ────────────────────────────────────────────────────

export interface SessionStore {
  /** C-11: drop files older than `days`. Optional on memory stores. */
  pruneOlderThan?(days: number): number;
  /** Create a new session and return its id */
  createSession(label?: string): string;
  /**
   * Set (or clear with empty string) a session's label.
   * C3: `sessions label <id> <label>` / `run --label`.
   * Returns the updated session, or undefined when the id is unknown.
   */
  setLabel(sessionId: string, label: string): Session | undefined;
  /** Load a session by id */
  getSession(sessionId: string): Session | undefined;
  /** Save (overwrite) a session */
  saveSession(session: Session): void;
  /** List all session ids */
  listSessions(): string[];
  /** Delete a session */
  deleteSession(sessionId: string): void;

  /** Add an interaction to a session */
  addInteraction(sessionId: string, userRequest: string): SessionInteraction | undefined;
  /** Update an interaction's outcome and summary */
  updateInteraction(
    sessionId: string,
    interactionId: string,
    updates: Partial<Pick<SessionInteraction, 'outcome' | 'reviewSummary' | 'planIds' | 'completedAt'>>
  ): void;
  /** Get the most recent completed interaction's summary */
  getLatestPlanSummary(sessionId: string): string | undefined;
}

// ─── File-based implementation ────────────────────────────────────

/**
 * File-based SessionStore.  Each session is a JSON file.
 * Sufficient for single-process use; upgradeable to a database.
 */
export class FileSessionStore implements SessionStore {
  private readonly dir: string;
  /**
   * Phase 27 (PERF-06): filename → session id index — `listSessions()`
   * no longer re-reads and re-parses every file on every call (the
   * filename is `sha256(id)`, so the mapping is stable).
   */
  private readonly idByFile = new Map<string, string>();
  /** B-03: last list/get skipped files. */
  readonly loadWarnings: Array<{ file: string; error: string }> = [];

  constructor(dir: string) {
    this.dir = dir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private filePath(sessionId: string): string {
    // Phase 22 (STORE-01): hash-based filename — same collision/traversal
    // fix as FilePlanStore.  The hash is a pure function of the id, so
    // no separate id→filename map is required.
    return path.join(this.dir, hashedStoreFileName(sessionId));
  }

  private warn(file: string, error: string): void {
    this.loadWarnings.push({ file, error });
  }

  private readSessionFromFile(fp: string): Session | undefined {
    if (!fs.existsSync(fp)) return undefined;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      const parsed = SessionSchema.safeParse(raw);
      if (!parsed.success) {
        this.warn(
          path.basename(fp),
          parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
        );
        return undefined;
      }
      return parsed.data;
    } catch (err) {
      this.warn(path.basename(fp), err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  createSession(label?: string): string {
    const session = createSession(label);
    this.saveSession(session);
    return session.id;
  }

  setLabel(sessionId: string, label: string): Session | undefined {
    return this.withSessionLock(sessionId, () => {
      const session = this.getSession(sessionId);
      if (!session) return undefined;
      if (label) {
        session.label = clipSessionText(label, SESSION_LABEL_MAX_CHARS) ?? label;
      } else {
        delete session.label;
      }
      this.saveSession(session);
      return session;
    });
  }

  getSession(sessionId: string): Session | undefined {
    const hashed = this.readSessionFromFile(this.filePath(sessionId));
    if (hashed) return hashed;
    if (!fs.existsSync(this.dir)) return undefined;
    const HASH_JSON = /^[0-9a-f]{16}\.json$/;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json') || HASH_JSON.test(f)) continue;
      const session = this.readSessionFromFile(path.join(this.dir, f));
      if (session?.id === sessionId) {
        this.migrateSessionFile(path.join(this.dir, f), session);
        return this.readSessionFromFile(this.filePath(sessionId));
      }
    }
    return undefined;
  }

  private migrateSessionFile(oldPath: string, session: Session): void {
    const dest = this.filePath(session.id);
    if (path.resolve(oldPath) === path.resolve(dest)) return;
    withFileLockSync(lockPathFor(dest), () => {
      if (!fs.existsSync(dest)) {
        atomicWriteFileSync(dest, JSON.stringify(session));
      }
      try {
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      } catch {
        // hashed copy is canonical
      }
    });
    this.idByFile.delete(path.basename(oldPath));
    this.idByFile.set(path.basename(dest), session.id);
  }

  saveSession(session: Session): void {
    // Phase 19 (PERS-02): do NOT mutate the caller's object — operate on
    // a clone, and (PERS-01) write atomically.
    const snapshot: Session = structuredClone(session);
    snapshot.lastActiveAt = Date.now();
    const filePath = this.filePath(session.id);
    // Phase 27 (PERS-04): cross-process lock.  Re-entrant, so the
    // read-modify-write helpers below can hold it around read + write.
    withFileLockSync(lockPathFor(filePath), () => {
      atomicWriteFileSync(filePath, JSON.stringify(snapshot));
    });
    // Phase 27 (PERF-06): keep the list index warm for our own writes.
    if (session.id) this.idByFile.set(path.basename(filePath), session.id);
  }

  /**
   * Phase 27 (PERS-04): run a read-modify-write section under the
   * session's lock so two processes cannot lose each other's update.
   */
  private withSessionLock<T>(sessionId: string, fn: () => T): T {
    return withFileLockSync(lockPathFor(this.filePath(sessionId)), fn);
  }

  listSessions(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    // Phase 22: filenames are hashes — the real id lives inside each
    // file's JSON.  Corrupt/unreadable files are skipped, not fatal.
    // Phase 27 (PERF-06): cached ids are reused; only NEW files are parsed.
    const ids: string[] = [];
    const seen = new Set<string>();
    const HASH_JSON = /^[0-9a-f]{16}\.json$/;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      seen.add(f);
      const cachedId = this.idByFile.get(f);
      if (cachedId !== undefined) {
        ids.push(cachedId);
        continue;
      }
      const fp = path.join(this.dir, f);
      const session = this.readSessionFromFile(fp);
      if (!session?.id) continue;
      if (!HASH_JSON.test(f)) {
        this.migrateSessionFile(fp, session);
        seen.delete(f);
        seen.add(hashedStoreFileName(session.id));
      }
      this.idByFile.set(hashedStoreFileName(session.id), session.id);
      ids.push(session.id);
    }
    // Drop index entries for files that disappeared (deleted elsewhere).
    if (this.idByFile.size > seen.size) {
      for (const f of [...this.idByFile.keys()]) {
        if (!seen.has(f)) this.idByFile.delete(f);
      }
    }
    return ids;
  }

  deleteSession(sessionId: string): void {
    const fp = this.filePath(sessionId);
    withFileLockSync(lockPathFor(fp), () => {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    });
    // Phase 27 (PERF-06): a deleted session must leave the index at once.
    this.idByFile.delete(path.basename(fp));
  }

  pruneOlderThan(days: number): number {
    if (days <= 0 || !fs.existsSync(this.dir)) return 0;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(this.dir, f);
      try {
        if (fs.statSync(fp).mtimeMs >= cutoff) continue;
        fs.unlinkSync(fp);
        this.idByFile.delete(f);
        removed++;
      } catch {
        // ignore
      }
    }
    return removed;
  }

  addInteraction(sessionId: string, userRequest: string): SessionInteraction | undefined {
    return this.withSessionLock(sessionId, () => {
      const session = this.getSession(sessionId);
      if (!session) return undefined;

      const interaction = createInteraction(
        clipSessionText(userRequest, SESSION_USER_REQUEST_MAX_CHARS) ?? userRequest,
      );
      session.interactions.push(interaction);
      this.saveSession(session);
      return interaction;
    });
  }

  updateInteraction(
    sessionId: string,
    interactionId: string,
    updates: Partial<Pick<SessionInteraction, 'outcome' | 'reviewSummary' | 'planIds' | 'completedAt'>>
  ): void {
    this.withSessionLock(sessionId, () => {
      const session = this.getSession(sessionId);
      if (!session) return;

      const interaction = session.interactions.find((i) => i.id === interactionId);
      if (!interaction) return;

      const next = { ...updates };
      if (next.reviewSummary !== undefined) {
        next.reviewSummary = clipSessionText(next.reviewSummary, SESSION_REVIEW_SUMMARY_MAX_CHARS);
      }
      Object.assign(interaction, next);
      this.saveSession(session);
    });
  }

  getLatestPlanSummary(sessionId: string): string | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;

    // Walk backwards to find the most recent completed interaction
    for (let i = session.interactions.length - 1; i >= 0; i--) {
      const interaction = session.interactions[i];
      if (interaction.outcome !== 'pending' && interaction.reviewSummary) {
        return interaction.reviewSummary;
      }
    }
    return undefined;
  }
}

// ─── In-memory implementation (for tests) ────────────────────────

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  createSession(label?: string): string {
    const session = createSession(label);
    // Phase 19 (PERS-03): structuredClone instead of JSON round-trip
    this.sessions.set(session.id, structuredClone(session));
    return session.id;
  }

  setLabel(sessionId: string, label: string): Session | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    if (label) {
      session.label = clipSessionText(label, SESSION_LABEL_MAX_CHARS) ?? label;
    } else {
      delete session.label;
    }
    this.saveSession(session);
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    const s = this.sessions.get(sessionId);
    return s ? structuredClone(s) : undefined;
  }

  saveSession(session: Session): void {
    // Phase 19 (PERS-02): no input mutation
    const snapshot: Session = structuredClone(session);
    snapshot.lastActiveAt = Date.now();
    this.sessions.set(session.id, snapshot);
  }

  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  addInteraction(sessionId: string, userRequest: string): SessionInteraction | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;

    const interaction = createInteraction(
      clipSessionText(userRequest, SESSION_USER_REQUEST_MAX_CHARS) ?? userRequest,
    );
    session.interactions.push(interaction);
    this.saveSession(session);
    return interaction;
  }

  updateInteraction(
    sessionId: string,
    interactionId: string,
    updates: Partial<Pick<SessionInteraction, 'outcome' | 'reviewSummary' | 'planIds' | 'completedAt'>>
  ): void {
    const session = this.getSession(sessionId);
    if (!session) return;

    const interaction = session.interactions.find((i) => i.id === interactionId);
    if (!interaction) return;

    const next = { ...updates };
    if (next.reviewSummary !== undefined) {
      next.reviewSummary = clipSessionText(next.reviewSummary, SESSION_REVIEW_SUMMARY_MAX_CHARS);
    }
    Object.assign(interaction, next);
    this.saveSession(session);
  }

  getLatestPlanSummary(sessionId: string): string | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;

    for (let i = session.interactions.length - 1; i >= 0; i--) {
      const interaction = session.interactions[i];
      if (interaction.outcome !== 'pending' && interaction.reviewSummary) {
        return interaction.reviewSummary;
      }
    }
    return undefined;
  }
}
