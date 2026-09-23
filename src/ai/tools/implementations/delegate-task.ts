import { tool } from 'ai';
import { z } from 'zod';
import type { PersonaRegistry } from '../../registries/persona-registry.js';
import { personaAllowsTool } from '../../schemas/persona.js';
import type { SkillRegistry } from '../../registries/skill-registry.js';
import type { ToolRegistry } from '../../registries/tool-registry.js';
import type { ModelRegistry } from '../../registries/model-registry.js';
import type { AgentDefinition } from '../../schemas/agent-definition.js';
import { createAgent, type ResolvedAgent } from '../../agents/agent-factory.js';

// ─── Types ────────────────────────────────────────────────────────

/**
 * Two modes of delegation:
 *   1. Static: provide an `agentId` that exists in AgentRegistry.
 *   2. Dynamic: provide `persona`, `skills`, `tools`, and `model`
 *      to compose an agent on the fly without pre-registration.
 *
 * The discriminated union enforces that exactly one mode is used.
 */
const StaticDelegation = z.object({
  mode: z.literal('static').default('static'),
  /** Pre-registered agent id from AgentRegistry */
  agentId: z.string().min(1),
  /** The task prompt to give the agent */
  prompt: z.string().min(1),
  /** Optional extra context */
  context: z.string().optional(),
});

const DynamicDelegation = z.object({
  mode: z.literal('dynamic'),
  /** Persona id (must exist in PersonaRegistry) */
  persona: z.string().min(1),
  /** Skill ids (must exist in SkillRegistry) */
  skills: z.array(z.string().min(1)).default([]),
  /** Tool ids to grant (must be in persona.allowedTools) */
  tools: z.array(z.string().min(1)).default([]),
  /** Model id (must exist in ModelRegistry) */
  model: z.string().min(1),
  /** The task prompt */
  prompt: z.string().min(1),
  /** Optional extra context */
  context: z.string().optional(),
});

const DelegateTaskInput = z.discriminatedUnion('mode', [
  StaticDelegation,
  DynamicDelegation,
]);

// ─── Authorization Gate ──────────────────────────────────────────

export interface AuthorizationResult {
  authorized: boolean;
  /** Tools that were requested but not in persona.allowedTools */
  deniedTools: string[];
  /** Tools that passed the gate */
  allowedTools: string[];
}

/**
 * Check every requested tool against the persona's allowedTools.
 * Returns a structured result — never throws.
 *
 * Law 18: this gate runs BOTH at agent creation (Phase 5) and
 * here at delegation time for dynamic compositions.
 */
export function checkAuthorization(
  personaId: string,
  requestedToolIds: string[],
  personaRegistry: PersonaRegistry
): AuthorizationResult {
  const persona = personaRegistry.get(personaId);
  if (!persona) {
    return {
      authorized: false,
      deniedTools: requestedToolIds,
      allowedTools: [],
    };
  }

  const denied: string[] = [];
  const allowed: string[] = [];

  for (const toolId of requestedToolIds) {
    if (personaAllowsTool(persona, toolId)) {
      allowed.push(toolId);
    } else {
      denied.push(toolId);
    }
  }

  return {
    authorized: denied.length === 0,
    deniedTools: denied,
    allowedTools: allowed,
  };
}

// ─── Delegate Task Tool Factory ──────────────────────────────────

export interface DelegateTaskDeps {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
  /**
   * Callback invoked when a task is successfully created.
   * In Phase 8 this will be wired to TaskRuntime.createTask.
   * For now it returns a placeholder taskId.
   */
  onTaskCreated: (resolved: ResolvedAgent, prompt: string) => string | Promise<string>;
  /**
   * Callback to resolve a static agentId to an AgentDefinition.
   * In Phase 8 this will query AgentRegistry.
   */
  resolveAgentId?: (agentId: string) => AgentDefinition | undefined;
}

/**
 * Creates the `delegate_task` tool — the ONLY permitted channel
 * for Main Agent → Sub-Agent communication (Law 13).
 *
 * Supports two modes:
 *   - `static`: delegate to a pre-registered agent by id.
 *   - `dynamic`: compose a new agent on the fly from persona +
 *     skills + tools + model, with full authorization checking.
 *
 * On authorization failure, returns a structured error to the
 * caller (Main Agent / Planner) so it can adjust the composition.
 * Never throws — all failures are returned as structured results.
 */
export function createDelegateTaskTool(deps: DelegateTaskDeps) {
  return tool({
    description:
      'Delegates a task to a sub-agent. Two modes: ' +
      '(1) static — provide an agentId from the agent registry; ' +
      '(2) dynamic — provide persona, skills, tools, and model to ' +
      'compose an agent on the fly. ' +
      'All requested tools are checked against the persona\'s allowedTools policy. ' +
      'Returns a taskId on success or a structured error on failure.',
    inputSchema: DelegateTaskInput,
    execute: async (input: z.infer<typeof DelegateTaskInput>) => {
      try {
        let agentDef: AgentDefinition;

        if (input.mode === 'static') {
          // ── Static mode ─────────────────────────────────────
          if (!deps.resolveAgentId) {
            return {
              success: false as const,
              error: 'Static delegation is not available (no AgentRegistry wired).',
              code: 'STATIC_NOT_AVAILABLE',
            };
          }

          const def = deps.resolveAgentId(input.agentId);
          if (!def) {
            return {
              success: false as const,
              error: `Agent "${input.agentId}" not found in AgentRegistry.`,
              code: 'AGENT_NOT_FOUND',
              availableAgents: [], // Populated by caller if needed
            };
          }
          agentDef = def;
        } else {
          // ── Dynamic mode ────────────────────────────────────

          // 1. Validate persona exists
          if (!deps.personaRegistry.has(input.persona)) {
            return {
              success: false as const,
              error: `Persona "${input.persona}" does not exist.`,
              code: 'PERSONA_NOT_FOUND',
            };
          }

          // 2. Validate skills exist
          for (const skillId of input.skills) {
            if (!deps.skillRegistry.has(skillId)) {
              return {
                success: false as const,
                error: `Skill "${skillId}" does not exist.`,
                code: 'SKILL_NOT_FOUND',
                invalidSkill: skillId,
              };
            }
          }

          // 3. Validate model exists
          if (!deps.modelRegistry.hasConfig(input.model)) {
            return {
              success: false as const,
              error: `Model "${input.model}" does not exist.`,
              code: 'MODEL_NOT_FOUND',
            };
          }

          // 4. Validate tools exist in ToolRegistry (before auth, so we report NOT_FOUND not DENIED for unknown tools)
          for (const toolId of input.tools) {
            if (!deps.toolRegistry.hasDefinition(toolId)) {
              return {
                success: false as const,
                error: `Tool "${toolId}" does not exist in ToolRegistry.`,
                code: 'TOOL_NOT_FOUND',
                invalidTool: toolId,
              };
            }
          }

          // 5. Authorization gate (Law 18)
          const authResult = checkAuthorization(
            input.persona,
            input.tools,
            deps.personaRegistry
          );

          if (!authResult.authorized) {
            return {
              success: false as const,
              error:
                `Authorization denied: persona "${input.persona}" is not allowed ` +
                `to use tool(s) [${authResult.deniedTools.join(', ')}]. ` +
                `Allowed tools for this persona: [${deps.personaRegistry.get(input.persona)!.allowedTools.join(', ')}].`,
              code: 'AUTHORIZATION_DENIED',
              deniedTools: authResult.deniedTools,
              allowedTools: authResult.allowedTools,
            };
          }

          // 6. Build temporary AgentDefinition
          agentDef = {
            id: `dynamic_${input.persona}_${Date.now()}`,
            name: `Dynamic ${input.persona}`,
            personaId: input.persona,
            skillIds: input.skills,
            modelId: input.model,
          };
        }

        // ── Create the resolved agent ─────────────────────────
        const resolved = createAgent({
          agentDefinition: agentDef,
          refs: {
            personaRegistry: deps.personaRegistry,
            skillRegistry: deps.skillRegistry,
            toolRegistry: deps.toolRegistry,
            modelRegistry: deps.modelRegistry,
          },
        });

        // Log any tool warnings (tools filtered by allowedTools in static mode)
        if (resolved.toolWarnings.length > 0) {
          // In a real system this goes to the observability log (Phase 14).
          // For now we include it in the response for the caller's awareness.
        }

        // ── Create the task ───────────────────────────────────
        const fullPrompt = input.context
          ? `${input.prompt}\n\n--- Context ---\n${input.context}`
          : input.prompt;

        const taskId = await deps.onTaskCreated(resolved, fullPrompt);

        return {
          success: true as const,
          taskId,
          agentId: resolved.agentId,
          persona: resolved.persona.id,
          skillsUsed: resolved.skills.map((s) => s.id),
          toolsGranted: Object.keys(resolved.tools),
          toolsDenied: resolved.toolWarnings.map((w) => w.toolId),
          contextBudgetExceeded: resolved.contextBudgetExceeded,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false as const,
          error: message,
          code: 'INTERNAL_ERROR',
        };
      }
    },
  });
}
