import { randomUUID } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import type { PersonaRegistry } from '../../registries/persona-registry.js';
import { personaAllowsTool } from '../../schemas/persona.js';
import type { SkillRegistry } from '../../registries/skill-registry.js';
import type { ToolRegistry } from '../../registries/tool-registry.js';
import type { ModelRegistry } from '../../registries/model-registry.js';
import type { AgentDefinition } from '../../schemas/agent-definition.js';
import { createAgent, type ResolvedAgent } from '../../agents/agent-factory.js';
import type { DelegationGuard } from '../../runtime/delegation-guard.js';
import { getAgentRunContext } from '../../runtime/agent-run-context.js';
import type { Task } from '../../schemas/task.js';

const StaticDelegation = z.object({
  mode: z.literal('static').default('static'),
  agentId: z.string().min(1),
  prompt: z.string().min(1),
  context: z.string().optional(),
});

const DynamicDelegation = z.object({
  mode: z.literal('dynamic'),
  persona: z.string().min(1),
  skills: z.array(z.string().min(1)).default([]),
  tools: z.array(z.string().min(1)).default([]),
  model: z.string().min(1),
  prompt: z.string().min(1),
  context: z.string().optional(),
});

const DelegateTaskInput = z.discriminatedUnion('mode', [
  StaticDelegation,
  DynamicDelegation,
]);

export interface AuthorizationResult {
  authorized: boolean;
  deniedTools: string[];
  allowedTools: string[];
}

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

export interface DelegateTaskDeps {
  personaRegistry: PersonaRegistry;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  modelRegistry: ModelRegistry;
  onTaskCreated: (
    resolved: ResolvedAgent,
    prompt: string,
    meta?: { planId?: string; parentTaskId?: string }
  ) => string | Promise<string>;
  resolveAgentId?: (agentId: string) => AgentDefinition | undefined;
  delegationGuard?: DelegationGuard;
  currentDelegationDepth?: number;
  waitForTask?: (taskId: string) => Promise<Task | undefined>;
}

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
        const runCtx = getAgentRunContext();
        const callerDepth = runCtx?.delegationDepth ?? deps.currentDelegationDepth ?? 0;
        const callerPersona = runCtx?.personaId;
        let agentDef: AgentDefinition;

        if (input.mode === 'dynamic' && deps.delegationGuard) {
          const check = deps.delegationGuard.canDelegate(
            callerPersona ?? input.persona,
            callerDepth
          );
          if (!check.allowed) {
            return {
              success: false as const,
              error: check.reason!,
              code: 'DELEGATION_DENIED',
            };
          }
        }

        if (input.mode === 'static') {
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
              availableAgents: [],
            };
          }
          agentDef = def;

          if (deps.delegationGuard) {
            const check = deps.delegationGuard.canDelegate(
              callerPersona ?? agentDef.personaId,
              callerDepth
            );
            if (!check.allowed) {
              return {
                success: false as const,
                error: check.reason!,
                code: 'DELEGATION_DENIED',
              };
            }
          }
        } else {
          if (!deps.personaRegistry.has(input.persona)) {
            return {
              success: false as const,
              error: `Persona "${input.persona}" does not exist.`,
              code: 'PERSONA_NOT_FOUND',
            };
          }

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

          if (!deps.modelRegistry.hasConfig(input.model)) {
            return {
              success: false as const,
              error: `Model "${input.model}" does not exist.`,
              code: 'MODEL_NOT_FOUND',
            };
          }

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

          agentDef = {
            id: `dynamic_${input.persona}_${randomUUID()}`,
            name: `Dynamic ${input.persona}`,
            personaId: input.persona,
            skillIds: input.skills,
            modelId: input.model,
          };
        }

        const resolved = createAgent({
          agentDefinition: agentDef,
          refs: {
            personaRegistry: deps.personaRegistry,
            skillRegistry: deps.skillRegistry,
            toolRegistry: deps.toolRegistry,
            modelRegistry: deps.modelRegistry,
          },
          delegationDepth: callerDepth + 1,
          delegationGuard: deps.delegationGuard,
        });

        const fullPrompt = input.context
          ? `${input.prompt}\n\n--- Context ---\n${input.context}`
          : input.prompt;

        const taskId = await deps.onTaskCreated(resolved, fullPrompt, {
          ...(runCtx?.planId ? { planId: runCtx.planId } : {}),
          ...(runCtx?.taskId ? { parentTaskId: runCtx.taskId } : {}),
        });

        const child = deps.waitForTask ? await deps.waitForTask(taskId) : undefined;

        return {
          success: true as const,
          taskId,
          agentId: resolved.agentId,
          persona: resolved.persona.id,
          skillsUsed: resolved.skills.map((s) => s.id),
          toolsGranted: Object.keys(resolved.tools),
          toolsDenied: resolved.toolWarnings.map((w) => w.toolId),
          contextBudgetExceeded: resolved.contextBudgetExceeded,
          ...(child
            ? {
                status: child.status,
                result: child.result,
                summary: child.summary,
                usage: child.usage,
              }
            : {}),
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
