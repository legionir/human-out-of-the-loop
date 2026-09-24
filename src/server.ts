#!/usr/bin/env node
/**
 * Phase 24 (UI): the web server — Express + SSE + vanilla frontend.
 *
 *   npm run server
 *   → http://localhost:3000  (HOTL_PORT to change)
 *
 * Structure (per plan, step 1):
 *   src/server.ts                — app factory + entry point (this file)
 *   src/server/sse.ts            — per-plan SSE hub
 *   src/server/routes/sessions.ts
 *   src/server/routes/plans.ts   (incl. /api/observability)
 *   src/server/routes/run.ts
 *   src/server/routes/stream.ts
 *   public/index.html / app.js / style.css
 *
 * Security (step 4):
 *   - `projectRoot` comes ONLY from server config (env/arg) — never from
 *     a query param or request body.
 *   - SSE payloads carry tool NAMES, never arguments (Law 14).
 *   - Credentials live in env vars the provider reads server-side; they
 *     are never serialized to the frontend.
 */
import { envDefaultModelId } from './cli/utils/registries.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express, { type Express } from 'express';
import { Orchestrator } from './ai/orchestrator.js';
import { loadDotEnv, loadGlobalConfig } from './cli/utils/config.js';
import { SseHub } from './server/sse.js';
import { sessionsRouter } from './server/routes/sessions.js';
import { plansRouter } from './server/routes/plans.js';
import { runRouter } from './server/routes/run.js';
import { streamRouter } from './server/routes/stream.js';
import { registryRouter } from './server/routes/registry.js';
import { previewRouter } from './server/routes/preview.js';
import { usageRouter } from './server/routes/usage.js';
import { observabilityStreamRouter } from './server/routes/observability-stream.js';
import type { ServerContext } from './server/types.js';

export interface ServerOptions {
  /** Directory that is allowed as the agent workspace (default: cwd). */
  projectRoot?: string;
  /** UI mode keeps its history — default true here (override for tests). */
  persistent?: boolean;
  /**
   * U1 (config parity): server-level default model.
   * Precedence: this option > `HOTL_MODEL` env > global config
   * `defaultModel` > Orchestrator default (`gpt-4o`).
   */
  model?: string;
  /** Extra observability redaction keys (defaults still apply). */
  redactKeys?: string[];
}

export interface CreatedServer {
  app: Express;
  ctx: ServerContext;
  /** Stop the orchestrator (call on server shutdown / in tests). */
  close: () => Promise<void>;
}

export function createApp(options: ServerOptions = {}): CreatedServer {
  // U1 (config parity): the server reads the SAME configuration sources
  // as the CLI — `~/.human-out-of-the-loop/config.json` + `.env` in the
  // project (then cwd).  Precedence: explicit option/env > global config
  // > project env > built-in default.  loadDotEnv never overwrites a
  // variable already present in the real environment.
  const globalCfg = loadGlobalConfig();
  const projectRoot = path.resolve(
    options.projectRoot ??
      process.env.HOTL_PROJECT_ROOT ??
      (globalCfg.projectRoot ? path.resolve(globalCfg.projectRoot) : process.cwd()),
  );
  loadDotEnv([projectRoot, process.cwd()]);
  const model = options.model ?? envDefaultModelId(projectRoot) ?? globalCfg.defaultModel;
  const redactKeys = [
    ...(options.redactKeys ?? []),
    ...(process.env.HOTL_REDACT_KEYS
      ? process.env.HOTL_REDACT_KEYS.split(',').map((s) => s.trim()).filter(Boolean)
      : []),
  ];
  const runtimeDir = path.join(projectRoot, '.ai-runtime');
  const persistent = options.persistent ?? globalCfg.persistent ?? true;

  const orchestrator = new Orchestrator({
    projectRoot,
    persistent,
    defaultModelId: model,
    redactKeys,
  });

  const hub = new SseHub();

  // Progress events → SSE (compact payloads only — see stream.ts).
  // Subscribing to the StreamingManager (post-construction) works
  // identically to the onProgress config hook.
  orchestrator.streamingManager.subscribe((event) => {
    const payload: Record<string, unknown> = {
      planId: event.planId,
      message: event.message,
      timestamp: event.timestamp,
    };
    if (event.stepId !== undefined) payload.stepId = event.stepId;
    if (event.taskId !== undefined) payload.taskId = event.taskId;
    // tool-call events carry only the tool NAME (Law 14) — the
    // ProgressEvent payload itself never contains arguments.
    if (event.type === 'task:tool-call' && event.payload?.toolName !== undefined) {
      payload.toolName = event.payload.toolName;
    }
    hub.emit(event.planId, event.type, payload);
  });

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const ctx: ServerContext = {
    app,
    orchestrator,
    hub,
    runs: new Map(),
    projectRoot,
    runtimeDir,
    logFilePath: path.join(runtimeDir, 'observability.jsonl'),
    ready: orchestrator.initialize().catch((err) => {
      // Surface initialization failures on the first request instead of
      // crashing the process.
      throw err instanceof Error ? err : new Error(String(err));
    }),
  };

  // Lazy init: the first request awaits a single shared initialization.
  app.use((req, res, next) => {
    ctx.ready.then(() => next(), (err) => {
      res.status(500).json({ error: `Server initialization failed: ${err.message}` });
    });
  });

  // API routers
  app.use(sessionsRouter(ctx));
  app.use(plansRouter(ctx));
  app.use(runRouter(ctx));
  app.use(streamRouter(ctx));
  app.use(registryRouter(ctx));
  app.use(previewRouter(ctx));
  app.use(usageRouter(ctx));
  app.use(observabilityStreamRouter(ctx));

  // U1: surface the effective config — never any secret VALUES.
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      projectRoot,
      model: orchestrator.config.defaultModelId,
      persistent,
      redactKeysCount: redactKeys.length,
    });
  });

  // Static frontend — public/ lives at the package root, but this module
  // runs from either src/ (tsx) or dist/src/ (tsc), so walk up until
  // public/index.html is found.
  app.use(express.static(findPublicDir()));

  const close = async (): Promise<void> => {
    // Drain the (possibly still running, possibly failed) initialization
    // before shutting down — otherwise shutdown races initialize's
    // filesystem reads (e.g. SIGINT during startup, or a test removing
    // its temp project while init is in flight).
    await ctx.ready.catch(() => {});
    await orchestrator.shutdown();
  };

  return { app, ctx, close };
}

/** Walk up from this file until public/index.html is found (package root). */
function findPublicDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'public');
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
}

export interface ServeOptions extends ServerOptions {
  port?: number;
  host?: string;
}

export async function startServer(options: ServeOptions = {}): Promise<CreatedServer> {
  const { app, ctx, close } = createApp(options);
  const port = options.port ?? Number(process.env.HOTL_PORT ?? 3000);
  const host = options.host ?? '0.0.0.0';

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, host, () => resolve());
    server.on('error', reject);
  });
  // eslint-disable-next-line no-console
  console.log(`[hotl-ui] http://localhost:${port}  (project root: ${ctx.projectRoot})`);
  return { app, ctx, close };
}

// ─── Entry point ─────────────────────────────────────────────────

/**
 * Phase 30 (P9): a web server must not die because one background promise
 * rejected.
 *
 * Observed failure mode: an MCP client's stream fetch (SSE / streamable
 * HTTP) stalled and undici aborted it with `UND_ERR_BODY_TIMEOUT` long
 * after the request that started it had already answered.  Nothing owned
 * that rejection, so it reached the top level and killed the process —
 * a dead dashboard instead of one failed probe.
 *
 * `unhandledRejection` is caught and reported here; an *uncaught
 * exception* still terminates (after one, the process state is not
 * trustworthy).  The affected request keeps its own error path — this
 * only keeps the server serving the rest.
 */
export function installCrashGuards(
  target: { on: (event: string, listener: (reason: unknown) => void) => unknown } = process,
  onError: (reason: unknown) => void = (reason) => {
    // eslint-disable-next-line no-console
    console.error(
      '[hotl-ui] unhandled rejection (server stays up):',
      reason instanceof Error ? (reason.stack ?? reason.message) : reason
    );
  }
): void {
  target.on('unhandledRejection', (reason) => onError(reason));
}


function isDirectlyInvoked(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

function parseArgs(argv: string[]): Partial<ServeOptions> {
  const options: Partial<ServeOptions> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project-root' && argv[i + 1]) {
      options.projectRoot = argv[++i];
    } else if (arg === '--port' && argv[i + 1]) {
      options.port = Number(argv[++i]);
    } else if (arg === '--host' && argv[i + 1]) {
      options.host = argv[++i];
    }
  }
  return options;
}

if (isDirectlyInvoked()) {
  installCrashGuards();
  const options = parseArgs(process.argv);
  startServer(options)
    .then(({ close }) => {
      const shutdown = async (): Promise<void> => {
        await close();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[hotl-ui] failed to start:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
