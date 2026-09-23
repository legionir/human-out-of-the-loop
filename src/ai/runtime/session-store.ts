import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  type Session,
  type SessionInteraction,
  createSession,
  createInteraction,
} from '../schemas/session.js';
import { atomicWriteFileSync } from './atomic-write.js';

// ─── Interface ────────────────────────────────────────────────────

export interface SessionStore {
  /** Create a new session and return its id */
  createSession(label?: string): string;
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
    const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
    return path.join(this.dir, `${hash}.json`);
  }

  createSession(label?: string): string {
    const session = createSession(label);
    this.saveSession(session);
    return session.id;
  }

  getSession(sessionId: string): Session | undefined {
    const fp = this.filePath(sessionId);
    if (!fs.existsSync(fp)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8')) as Session;
    } catch {
      return undefined;
    }
  }

  saveSession(session: Session): void {
    // Phase 19 (PERS-02): do NOT mutate the caller's object — operate on
    // a clone, and (PERS-01) write atomically.
    const snapshot: Session = structuredClone(session);
    snapshot.lastActiveAt = Date.now();
    atomicWriteFileSync(
      this.filePath(session.id),
      JSON.stringify(snapshot, null, 2)
    );
  }

  listSessions(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    // Phase 22: filenames are hashes — the real id lives inside each
    // file's JSON.  Corrupt/unreadable files are skipped, not fatal.
    const ids: string[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(this.dir, f), 'utf-8')
        ) as { id?: unknown };
        if (typeof raw.id === 'string') ids.push(raw.id);
      } catch {
        // Skip corrupt file
      }
    }
    return ids;
  }

  deleteSession(sessionId: string): void {
    const fp = this.filePath(sessionId);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  addInteraction(sessionId: string, userRequest: string): SessionInteraction | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;

    const interaction = createInteraction(userRequest);
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

    Object.assign(interaction, updates);
    this.saveSession(session);
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

    const interaction = createInteraction(userRequest);
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

    Object.assign(interaction, updates);
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
