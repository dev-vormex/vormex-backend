import type { AgentUiIntent, AgentActionRecord } from '../types';
export function dedupeUiIntents(uiIntents: AgentUiIntent[]): AgentUiIntent[] {
  const seen = new Set<string>();
  const results: AgentUiIntent[] = [];

  for (const intent of uiIntents) {
    const key = JSON.stringify(intent);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(intent);
  }

  return results;
}

export function mergeGoals(primary: string[] = [], secondary: string[] = []): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const source of [primary, secondary]) {
    for (const item of source) {
      const normalized = String(item || '').trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(normalized);
    }
  }

  return merged.slice(0, 8);
}

export function extractLikelyGoals(inputText: string, existingGoals: string[] = []): string[] {
  const normalized = inputText.trim();
  if (!normalized) {
    return existingGoals;
  }

  const goals = [...existingGoals];
  const compact = normalized.length > 96 ? `${normalized.slice(0, 95)}…` : normalized;
  if (!goals.some((goal) => goal.toLowerCase() === compact.toLowerCase())) {
    goals.unshift(compact);
  }
  return goals.slice(0, 6);
}

export function buildMemorySummary(params: {
  previousSummary?: string | null;
  latestInput: string;
  surface: string;
  executedActions: AgentActionRecord[];
  assistantMessage: string;
}): string {
  const parts = [
    `Current focus: ${params.latestInput.trim().slice(0, 180)}`,
    params.executedActions.length > 0
      ? `Recent actions: ${params.executedActions.map((action) => action.title).join(', ')}`
      : null,
    params.surface ? `Primary surface: ${params.surface}` : null,
    params.assistantMessage
      ? `Last assistant summary: ${params.assistantMessage.trim().slice(0, 160)}`
      : null,
    params.previousSummary ? `Previous memory: ${params.previousSummary.slice(0, 160)}` : null,
  ].filter(Boolean);

  return parts.join(' | ').slice(0, 700);
}

