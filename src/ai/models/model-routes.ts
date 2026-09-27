/**
 * Route cheap vs strong work onto different models (J-06).
 */
export type ModelRole = 'classify' | 'judge' | 'review' | 'plan' | 'code';

export type ModelRoutes = Partial<Record<ModelRole, string>>;

export function resolveModelForRole(role: ModelRole, routes: ModelRoutes | undefined, fallback: string): string {
  const id = routes?.[role]?.trim();
  return id || fallback;
}

export function roleForPersona(personaId: string): ModelRole {
  if (personaId === 'planner') return 'plan';
  if (personaId === 'judge') return 'judge';
  if (personaId === 'reviewer') return 'review';
  if (personaId === 'chat') return 'classify';
  return 'code';
}
