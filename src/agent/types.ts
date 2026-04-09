export type AgentSurface =
  | 'global'
  | 'feed'
  | 'find_people'
  | 'chat'
  | 'groups'
  | 'profile'
  | 'notifications'
  | 'growth_hub';

export interface AgentSessionSummary {
  sessionId: string;
  status: string;
  mode: string;
  currentSurface?: string | null;
  memorySummary?: string | null;
  allowAutonomousActions: boolean;
  lastResponseId?: string | null;
}

export interface AgentSessionBootstrapRequest {
  sessionId?: string;
  mode?: string;
  surface?: string;
  allowAutonomousActions?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AgentTurnRequest {
  inputText: string;
  surface?: string;
  surfaceContext?: Record<string, unknown>;
  allowAutonomousActions?: boolean;
}

export interface AgentUiIntent {
  type: string;
  tab?: string;
  userId?: string;
  conversationId?: string;
  groupId?: string;
  route?: string;
  label?: string;
  prefillText?: string;
  payload?: Record<string, unknown> | null;
}

export interface AgentActionRecord {
  type: string;
  toolName: string;
  status: 'executed' | 'suggested' | 'blocked';
  title: string;
  summary: string;
  pendingActionId?: string | null;
  entityId?: string | null;
  entityType?: string | null;
  uiIntents?: AgentUiIntent[];
  payload?: Record<string, unknown> | null;
}

export interface AgentPendingActionSummary {
  id: string;
  sessionId: string;
  userId: string;
  toolName: string;
  actionType: string;
  title: string;
  summary: string;
  input?: Record<string, unknown> | null;
  status: string;
  context?: Record<string, unknown> | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string | null;
}

export interface AgentGoalSummary {
  id: string;
  userId: string;
  goal: string;
  category?: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTurnResponse {
  assistantMessage: string;
  executedActions: AgentActionRecord[];
  suggestedActions: AgentActionRecord[];
  uiIntents: AgentUiIntent[];
  pendingActions?: AgentPendingActionSummary[];
  goals?: AgentGoalSummary[];
  memorySummary?: string | null;
  sessionState: AgentSessionSummary;
}

export interface AgentVoiceTurnResponse extends AgentTurnResponse {
  transcript: string;
  audioBase64?: string | null;
  audioMimeType?: string | null;
}

export interface AgentToolExecutionContext {
  userId: string;
  sessionId: string;
  surface: string;
  surfaceContext: Record<string, unknown>;
  allowAutonomousActions: boolean;
}

export interface AgentToolResult {
  summary: string;
  output: Record<string, unknown>;
  executedAction?: AgentActionRecord;
  suggestedAction?: AgentActionRecord;
  blockedAction?: AgentActionRecord;
  uiIntents?: AgentUiIntent[];
}
