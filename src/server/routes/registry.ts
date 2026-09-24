/**
 * U2 (UI completion plan): registry introspection routes — the server
 * parity of the CLI commands `models` / `personas` / `skills` / `tools`
 * / `mcp list` / `mcp test` (Phase 23).
 *
 *   GET  /api/models        → [{id, provider, model, description}]
 *   GET  /api/personas      → [{id, name, allowedTools, description}]
 *   GET  /api/skills        → [{id, name, version, tools}]
 *   GET  /api/tools         → [{id, name, source, category, description}]
 *   GET  /api/mcp           → {servers: [{id, name, transport, endpoint, auth}],
 *                              errors: [string]}
 *   POST /api/mcp/:id/test  → {ok: true, toolIds} | {ok: false, error}
 *
 * Data source: the orchestrator's IN-MEMORY registries (loaded from the
 * project's `registry/` dir during the shared initialization that the
 * lazy-init middleware in server.ts guarantees before any route runs).
 *
 * MCP test: same logic as the CLI — a FRESH ToolRegistry is used so a
 * probe never mutates the live registry.
 */
import path from 'node:path';
import { Router } from 'express';
import { McpConnector } from '../../ai/tools/mcp-connector.js';
import { loadMcpServerConfigs } from '../../ai/tools/mcp-bootstrap.js';
import { ToolRegistry } from '../../ai/registries/tool-registry.js';
import type { ServerContext } from '../types.js';

export function registryRouter(ctx: ServerContext): Router {
  const router = Router();

  router.get('/api/models', (req, res) => {
    res.json(
      ctx.orchestrator.modelRegistry
        .listConfigs()
        .map((m) => ({
          id: m.id,
          provider: m.provider,
          model: m.model,
          description: m.description ?? '',
        })),
    );
  });

  router.get('/api/personas', (req, res) => {
    res.json(
      ctx.orchestrator.personaRegistry
        .list()
        .map((p) => ({
          id: p.id,
          name: p.name,
          allowedTools: p.allowedTools,
          description: p.description ?? '',
        })),
    );
  });

  router.get('/api/skills', (req, res) => {
    res.json(
      ctx.orchestrator.skillRegistry
        .list()
        .map((s) => ({
          id: s.id,
          name: s.name,
          version: s.version,
          tools: s.resolvedTools,
        })),
    );
  });

  router.get('/api/tools', (req, res) => {
    res.json(
      ctx.orchestrator.toolRegistry
        .listDefinitions()
        .map((t) => ({
          id: t.id,
          name: t.name,
          source: t.source,
          category: t.category ?? '',
          description: t.description,
        })),
    );
  });

  router.get('/api/mcp', (req, res) => {
    const dir = path.join(ctx.projectRoot, 'registry', 'mcp-servers');
    const { configs, errors } = loadMcpServerConfigs(dir);
    res.json({
      servers: configs.map((c) => ({
        id: c.id,
        name: c.name,
        transport: c.transport,
        endpoint: c.url ?? (c.command ? `${c.command} ${c.args.join(' ')}`.trim() : '-'),
        auth: c.auth.type === 'none' ? 'none' : c.auth.type,
      })),
      errors,
    });
  });

  router.post('/api/mcp/:id/test', async (req, res) => {
    const dir = path.join(ctx.projectRoot, 'registry', 'mcp-servers');
    const { configs } = loadMcpServerConfigs(dir);
    const config = configs.find((c) => c.id === req.params.id);
    if (!config) {
      res.status(404).json({ ok: false, error: `MCP server "${req.params.id}" not found in registry/mcp-servers.` });
      return;
    }
    try {
      // fresh registry — a probe must not touch the live tool registry
      const probe = new ToolRegistry();
      const connector = new McpConnector({ toolRegistry: probe });
      const ok = await connector.connectServer(config);
      const state = connector.getServerState(config.id);
      if (ok) {
        res.json({ ok: true, toolIds: state?.toolIds ?? [] });
      } else {
        res.json({ ok: false, error: state?.lastError ?? 'connection failed' });
      }
    } catch (e) {
      res.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  return router;
}
