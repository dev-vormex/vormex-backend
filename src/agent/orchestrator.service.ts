import OpenAI from 'openai';
import { logger } from '../lib/logger';
import { AIServiceError } from '../services/ai.service';
import { agentSessionService } from './session.service';
import { evaluateAgentUserInputSafety } from './safety.service';
import {
  executeAgentTool,
  getAgentCurrentUserContext,
  getAgentToolDefinitions,
} from './tools';
import { pendingActionsService } from './pending-actions.service';
import { agentGoalsService } from './goals.service';
import {
  buildInlineResultsPromptContext,
  mergeSessionMetadataWithInlineResults,
  resolveInlineReferencedUserId,
} from './inline-results';
import {
  describeNavigationPreview,
  resolveAgentSurfaceFromUiIntents,
} from './surface-utils';
import {
  emitAgentEvent,
  serializeAgentAction,
  serializeGoal,
  serializePendingAction,
} from './socket-events';
import {
  AgentActionRecord,
  AgentTurnRequest,
  AgentTurnResponse,
  AgentUiIntent,
  AgentVoiceTurnResponse,
} from './types';

function extractOutputText(response: any): string {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const output = Array.isArray(response?.output) ? response.output : [];
  const textParts: string[] = [];

  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) {
      continue;
    }

    for (const contentPart of item.content) {
      if (contentPart?.type === 'output_text' && typeof contentPart.text === 'string') {
        textParts.push(contentPart.text);
      }
    }
  }

  return textParts.join('').trim();
}

function parseRetryAfterSeconds(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    return parseRetryAfterSeconds(value[0]);
  }

  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.ceil(value);
  }

  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.ceil(numeric);
  }

  const dateValue = Date.parse(value);
  if (Number.isFinite(dateValue)) {
    return Math.max(1, Math.ceil((dateValue - Date.now()) / 1000));
  }

  return undefined;
}

function dedupeUiIntents(uiIntents: AgentUiIntent[]): AgentUiIntent[] {
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

function mergeGoals(primary: string[] = [], secondary: string[] = []): string[] {
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

function pickModel(params: {
  inputText: string;
  surface: string;
  allowAutonomousActions: boolean;
}): string {
  const defaultModel = process.env.AGENT_DEFAULT_MODEL || process.env.AI_MODEL || 'gpt-5.4-mini';
  const plannerModel = process.env.AGENT_PLANNER_MODEL || defaultModel;
  const complexSignals =
    params.inputText.length > 280 ||
    /plan|strategy|rank|compare|like-minded|mentor|mentee|multi-step|end-to-end|across/i.test(
      params.inputText
    ) ||
    params.surface === 'global' ||
    params.surface === 'growth_hub' ||
    params.allowAutonomousActions;

  return complexSignals ? plannerModel : defaultModel;
}

function extractLikelyGoals(inputText: string, existingGoals: string[] = []): string[] {
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

function buildMemorySummary(params: {
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

function compactFallbackQuery(inputText: string): string | null {
  const cleaned = inputText
    .replace(
      /\b(please|could you|can you|help|agent|vormex|show|find|search|open|get|me|my|for|with|the|a|an|to|in|on|at|from|some|people|person|users|user|profiles|profile|peers|peer)\b/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return null;
  }

  const words = cleaned.split(' ').filter(Boolean).slice(0, 8);
  return words.length > 0 ? words.join(' ') : null;
}

class AgentOrchestratorService {
  private readonly client: OpenAI | null;
  private readonly toolDefinitions: any[];

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY || process.env.AI_API_KEY || '';
    this.client = apiKey
      ? new OpenAI({
          apiKey,
          maxRetries: 2,
          timeout: Number(process.env.AGENT_AI_TIMEOUT_MS || process.env.AI_TIMEOUT_MS || 45000),
        })
      : null;
    this.toolDefinitions = getAgentToolDefinitions();
  }

  private getClient(): OpenAI {
    if (!this.client) {
      throw new AIServiceError('Agent AI is not configured.', {
        code: 'ai_not_configured',
        statusCode: 503,
        userMessage:
          process.env.NODE_ENV === 'development'
            ? 'Agent AI is not configured on the backend. Add OPENAI_API_KEY to vormex-backend/.env and restart the backend.'
            : 'Agent AI is temporarily unavailable right now.',
      });
    }

    return this.client;
  }

  private mapProviderError(error: unknown, params: {
    route: string;
    requestId?: string;
    userId?: string;
    sessionId?: string;
    model?: string;
  }): never {
    if (error instanceof AIServiceError) {
      throw error;
    }

    if (error instanceof OpenAI.APIError) {
      const providerRequestId = error.requestID || (error.headers as any)?.['x-request-id'];
      const retryAfterSeconds = parseRetryAfterSeconds((error.headers as any)?.['retry-after']);
      const isQuotaError =
        error.code === 'insufficient_quota' ||
        error.type === 'insufficient_quota' ||
        /quota/i.test(error.message || '');
      const isProviderUnavailable =
        isQuotaError ||
        error.status === 401 ||
        error.status === 403 ||
        error.status === 429 ||
        error.status === 408 ||
        error.status === 409 ||
        (typeof error.status === 'number' && error.status >= 500);

      const mappedError = new AIServiceError(error.message, {
        code: isQuotaError
          ? 'ai_provider_quota_exhausted'
          : isProviderUnavailable
            ? 'ai_provider_unavailable'
            : 'ai_invalid_request',
        providerRequestId,
        retryAfterSeconds,
        statusCode: isProviderUnavailable ? 503 : 400,
        userMessage: isQuotaError
          ? (
              process.env.NODE_ENV === 'development'
                ? 'Agent AI quota is exhausted on the backend OpenAI project. Add billing/credits or replace OPENAI_API_KEY with a funded key, then restart vormex-backend.'
                : 'Agent AI is temporarily unavailable right now.'
            )
          : isProviderUnavailable
            ? 'Agent AI is temporarily busy. Please try again shortly.'
            : 'Agent AI request failed due to invalid input.',
      });

      logger[isProviderUnavailable ? 'warn' : 'error']({
        event: isProviderUnavailable ? 'agent.ai.provider.degraded' : 'agent.ai.request.failure',
        route: params.route,
        requestId: params.requestId,
        userId: params.userId,
        sessionId: params.sessionId,
        model: params.model,
        status: error.status,
        code: mappedError.code,
        message: error.message,
        providerRequestId,
      });

      throw mappedError;
    }

    const genericError = error instanceof Error ? error : new Error(String(error));
    logger.error({
      event: 'agent.ai.request.failure',
      route: params.route,
      requestId: params.requestId,
      userId: params.userId,
      sessionId: params.sessionId,
      model: params.model,
      code: 'ai_internal_error',
      message: genericError.message,
      stack: genericError.stack,
    });

    throw new AIServiceError(genericError.message || 'Agent AI request failed.', {
      code: 'ai_internal_error',
      statusCode: 503,
      userMessage: 'Agent AI is temporarily busy. Please try again shortly.',
    });
  }

  private async callProvider<T>(
    operation: () => Promise<T>,
    params: {
      route: string;
      requestId?: string;
      userId?: string;
      sessionId?: string;
      model?: string;
    }
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.mapProviderError(error, params);
    }
  }

  private shouldUseFallbackMode(error: unknown): error is AIServiceError {
    return (
      error instanceof AIServiceError &&
      ['ai_provider_quota_exhausted', 'ai_provider_unavailable', 'ai_not_configured'].includes(
        error.code
      )
    );
  }

  private buildFallbackPreamble(error: AIServiceError): string {
    switch (error.code) {
      case 'ai_provider_quota_exhausted':
        return 'Full AI mode is temporarily unavailable because the backend OpenAI quota is exhausted. I switched to limited fallback mode.';
      case 'ai_not_configured':
        return 'Full AI mode is not configured on the backend right now. I switched to limited fallback mode.';
      default:
        return 'Full AI mode is temporarily busy right now. I switched to limited fallback mode.';
    }
  }

  private async runFallbackTurn(params: {
    error: AIServiceError;
    userId: string;
    session: any;
    sessionId: string;
    inputText: string;
    surface: string;
    surfaceContext: Record<string, unknown>;
    allowAutonomousActions: boolean;
    requestId?: string;
    preferences: any;
    explicitGoalTexts: string[];
  }): Promise<AgentTurnResponse> {
    const executedActions: AgentActionRecord[] = [];
    const suggestedActions: AgentActionRecord[] = [];
    const uiIntents: AgentUiIntent[] = [];
    const normalized = params.inputText.toLowerCase();
    const query = compactFallbackQuery(params.inputText);
    const explicitPeopleRequest =
      /\b(people|person|users|user|profiles|profile|peers|peer|developers|engineers|students|founders|mentors|mentees|networkers)\b/.test(
        normalized
      ) ||
      /\b(my|our|same)\s+(campus|college)\b|\bfrom\s+(my|our)\s+(campus|college)\b/.test(
        normalized
      ) ||
      /\b(who knows|who know|interested in|into|skilled in|good at|working on|working with)\b/.test(
        normalized
      );
    const explicitGroupRequest =
      (/\b(group|groups|community|communities|club|clubs)\b/.test(normalized) ||
        /\b(join|discover|find|show|open)\b.*\b(group|groups|community|communities|club|clubs)\b/.test(
          normalized
        )) &&
      !explicitPeopleRequest;
    const referencedInlineUserId = resolveInlineReferencedUserId(
      params.inputText,
      params.session.metadata,
      params.surfaceContext
    );
    const requestedTargetUserId =
      typeof params.surfaceContext.openChatWithUserId === 'string'
        ? params.surfaceContext.openChatWithUserId
        : typeof params.surfaceContext.viewingProfileUserId === 'string'
          ? params.surfaceContext.viewingProfileUserId
          : referencedInlineUserId;

    let toolName: string | null = null;
    let toolArgs: Record<string, unknown> = {};

    if (/(mark|clear).*(notification|inbox)|notification.*read/.test(normalized)) {
      toolName = 'notifications_mark_all_read';
    } else if (/notification|inbox|alert/.test(normalized)) {
      toolName = 'notifications_get_summary';
      toolArgs = { unreadOnly: true, limit: 8 };
    } else if (/growth|plan|improve|next step|next move|snapshot/.test(normalized)) {
      toolName = 'growth_get_snapshot';
    } else if (/\bmy profile\b|\babout me\b|^\s*profile\s*$/.test(normalized)) {
      toolName = 'profile_get_me';
    } else if (/(show all|browse|take me to|open).*(find|people|matches|network)/.test(normalized)) {
      toolName = 'ui_navigate';
      toolArgs = { target: 'find', tab: null, userId: null, conversationId: null, groupId: null, note: null };
    } else if (/open.*(chat|message)|chat with|message /.test(normalized) && requestedTargetUserId) {
      toolName = 'chat_open_conversation';
      toolArgs = { userId: requestedTargetUserId };
    } else if (/(connect|send.*connection|request.*connection|add.*connection)/.test(normalized) && requestedTargetUserId) {
      toolName = 'connections_send_request';
      toolArgs = { userId: requestedTargetUserId, note: null };
    } else if (/(open|view|show).*(their )?profile/.test(normalized) && requestedTargetUserId) {
      toolName = 'profile_get_user';
      toolArgs = { userId: requestedTargetUserId };
    } else if (/like.?minded|aligned|peer|network|mentor|mentee|people like me/.test(normalized)) {
      toolName = 'matching_find_like_minded_peers';
      toolArgs = { focus: query, limit: 8 };
    } else if (explicitPeopleRequest || /people|person|search/.test(normalized)) {
      toolName = 'people_search';
      toolArgs = { query, limit: 8, nearbyOnly: false };
    } else if (explicitGroupRequest) {
      toolName = 'groups_discover';
      toolArgs = { query, tag: null, limit: 5 };
    } else if (/open.*group/.test(normalized)) {
      toolName = 'ui_navigate';
      toolArgs = { target: 'groups', tab: null, userId: null, conversationId: null, groupId: null, note: null };
    } else if (/open.*notification/.test(normalized)) {
      toolName = 'ui_navigate';
      toolArgs = { target: 'notifications', tab: null, userId: null, conversationId: null, groupId: null, note: null };
    } else if (/open.*growth/.test(normalized)) {
      toolName = 'ui_navigate';
      toolArgs = { target: 'growth', tab: null, userId: null, conversationId: null, groupId: null, note: null };
    }

    let fallbackDetail =
      'I can still help with people discovery, groups, profile summaries, notifications, growth snapshots, and basic navigation while quota is being restored.';

    if (toolName) {
      const toolResult = await executeAgentTool(toolName, toolArgs, {
        userId: params.userId,
        sessionId: params.sessionId,
        surface: params.surface,
        surfaceContext: params.surfaceContext,
        allowAutonomousActions: params.allowAutonomousActions,
      });

      if (toolResult.executedAction) {
        executedActions.push(toolResult.executedAction);
      }
      if (toolResult.suggestedAction) {
        suggestedActions.push(toolResult.suggestedAction);
      }
      if (toolResult.blockedAction) {
        suggestedActions.push(toolResult.blockedAction);
      }
      if (toolResult.uiIntents?.length) {
        uiIntents.push(...toolResult.uiIntents);
      }

      const actionToLog =
        toolResult.executedAction || toolResult.suggestedAction || toolResult.blockedAction;
      if (actionToLog) {
        await agentSessionService.logAction({
          sessionId: params.sessionId,
          userId: params.userId,
          action: actionToLog,
          input: toolArgs,
          output: toolResult.output,
          uiIntents: toolResult.uiIntents || [],
        });
      }

      fallbackDetail = toolResult.summary;
    }

    const assistantMessage = `${this.buildFallbackPreamble(params.error)} ${fallbackDetail}`.trim();
    const dedupedUiIntents = dedupeUiIntents(uiIntents);
    const resolvedSurface = resolveAgentSurfaceFromUiIntents(params.surface, dedupedUiIntents);

    await agentSessionService.appendMessage({
      sessionId: params.sessionId,
      userId: params.userId,
      role: 'assistant',
      content: assistantMessage,
      metadata: {
        fallbackMode: true,
        fallbackCode: params.error.code,
        providerRequestId: params.error.providerRequestId || null,
      },
    });

    const memorySummary = buildMemorySummary({
      previousSummary: params.session.memorySummary,
      latestInput: params.inputText,
      surface: resolvedSurface,
      executedActions,
      assistantMessage,
    });
    const sessionMetadata = mergeSessionMetadataWithInlineResults(
      params.session.metadata,
      dedupedUiIntents
    );

    const sessionState = await agentSessionService.updateSession(params.sessionId, {
      currentSurface: resolvedSurface,
      memorySummary,
      metadata: sessionMetadata,
      allowAutonomousActions: params.allowAutonomousActions,
      title: params.session.title || params.inputText.slice(0, 72),
    });

    await agentSessionService.upsertUserPreferences(params.userId, {
      goals: extractLikelyGoals(params.inputText, params.explicitGoalTexts),
      preferredOutreachStyle: params.preferences?.preferredOutreachStyle || 'warm and concise',
      memorySummary,
      lastSessionId: params.sessionId,
    });

    const pendingActions = (await pendingActionsService.getPending(params.userId)).map(serializePendingAction);
    const goals = (await agentGoalsService.getGoals(params.userId)).map(serializeGoal);

    const fallbackResponse = {
      assistantMessage,
      executedActions,
      suggestedActions,
      uiIntents: dedupedUiIntents,
      pendingActions,
      goals,
      memorySummary,
      sessionState,
    };

    emitAgentEvent(
      params.userId,
      'agent:turn_completed',
      {
        sessionId: params.sessionId,
        surface: resolvedSurface,
        fallbackMode: true,
        ...fallbackResponse,
      },
      params.sessionId
    );

    return fallbackResponse;
  }

  private buildSystemPrompt(params: {
    session: any;
    preferences: any;
    activeGoals: string[];
    surface: string;
    surfaceContext: Record<string, unknown>;
    allowAutonomousActions: boolean;
    currentUserPromptContext?: string | null;
  }): string {
    const memorySummary = params.session.memorySummary || params.preferences?.memorySummary || 'none';
    const preferredOutreachStyle = params.preferences?.preferredOutreachStyle || 'warm and concise';
    const inlineResultsContext = buildInlineResultsPromptContext(
      params.session?.metadata,
      params.surfaceContext
    );

    return [
      'You are Vormex Agent, a voice-and-text agent inside the Vormex Android app.',
      'Help users find like-minded peers, rank matches, send or revive DMs, send or accept connection requests, join relevant groups, summarize notifications, and guide growth actions.',
      'Use tools for facts, IDs, and in-app actions. Do not invent user IDs, group IDs, conversation IDs, or notification counts.',
      'If the user asks for people with a topic, skill, interest, or background such as "python people", "React developers", "AI students", or "people interested in machine learning", treat that as people discovery and prefer people_search or matching_find_like_minded_peers.',
      'When the user says "my campus", "our campus", "same campus", or "my college", treat that as people discovery filtered to the current user college from the user profile context.',
      'Only use groups_discover when the user explicitly asks for groups, communities, clubs, or joining a group.',
      'If you want the Android app to navigate somewhere, call ui_navigate so the backend can return structured ui_intents.',
      'When a people or peer-search tool returns a strong small set, keep the user on the current surface and talk about the inline result cards instead of telling them to open Find.',
      'Only navigate to Find when the user explicitly asks to browse or open all results, or when no strong inline results are available.',
      'Keep responses concise, practical, and friendly.',
      'Never perform destructive actions, moderation actions, or billing actions.',
      `Autonomous actions enabled: ${params.allowAutonomousActions ? 'yes' : 'no'}.`,
      `Current surface: ${params.surface}.`,
      `Surface context: ${JSON.stringify(params.surfaceContext || {})}.`,
      params.currentUserPromptContext ? `Current user profile context:\n${params.currentUserPromptContext}` : null,
      inlineResultsContext,
      `Memory summary: ${memorySummary}.`,
      `Active goals: ${params.activeGoals.length > 0 ? params.activeGoals.join(', ') : 'none'}.`,
      `Preferred outreach style: ${preferredOutreachStyle}.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  async runTurn(
    userId: string,
    sessionId: string,
    turn: AgentTurnRequest,
    requestId?: string
  ): Promise<AgentTurnResponse> {
    const session = await agentSessionService.requireSession(sessionId, userId);
    const inputText = String(turn.inputText || '').trim();
    const surface = String(turn.surface || session.currentSurface || 'global');
    const surfaceContext =
      turn.surfaceContext && typeof turn.surfaceContext === 'object' ? turn.surfaceContext : {};
    const allowAutonomousActions = turn.allowAutonomousActions ?? session.allowAutonomousActions ?? true;

    await agentSessionService.appendMessage({
      sessionId,
      userId,
      role: 'user',
      content: inputText,
      metadata: {
        surface,
        surfaceContext,
        allowAutonomousActions,
      },
    });

    const safety = evaluateAgentUserInputSafety(inputText);
    const explicitGoals = await agentGoalsService.getGoals(userId);
    const explicitGoalTexts = explicitGoals.map((goal) => goal.goal);
    if (!safety.allowed) {
      const assistantMessage =
        safety.refusalMessage ||
        'That action is blocked in this phase, but I can still help with discovery, messaging, and growth guidance.';
      await agentSessionService.appendMessage({
        sessionId,
        userId,
        role: 'assistant',
        content: assistantMessage,
        metadata: {
          blockedBySafety: true,
        },
      });

      const sessionState = await agentSessionService.updateSession(sessionId, {
        currentSurface: surface,
        memorySummary: buildMemorySummary({
          previousSummary: session.memorySummary,
          latestInput: inputText,
          surface,
          executedActions: [],
          assistantMessage,
        }),
        allowAutonomousActions,
      });

      await agentSessionService.upsertUserPreferences(userId, {
        goals: extractLikelyGoals(inputText, explicitGoalTexts),
        memorySummary: sessionState.memorySummary || null,
        lastSessionId: sessionId,
      });

      const pendingActions = (await pendingActionsService.getPending(userId)).map(serializePendingAction);
      const goals = explicitGoals.map(serializeGoal);

      const turnResponse = {
        assistantMessage,
        executedActions: [],
        suggestedActions: safety.suggestedActions,
        uiIntents: [],
        pendingActions,
        goals,
        memorySummary: sessionState.memorySummary,
        sessionState,
      };

      emitAgentEvent(
        userId,
        'agent:turn_completed',
        {
          sessionId,
          surface,
          ...turnResponse,
        },
        sessionId
      );

      return turnResponse;
    }

    const preferences = await agentSessionService.getUserPreferences(userId);
    const activeGoals = mergeGoals(explicitGoalTexts, preferences?.goals || []);
    const currentUserContext = await getAgentCurrentUserContext(userId);
    const model = pickModel({
      inputText,
      surface,
      allowAutonomousActions,
    });

    const executedActions: AgentActionRecord[] = [];
    const suggestedActions: AgentActionRecord[] = [];
    const blockedActions: AgentActionRecord[] = [];
    const uiIntents: AgentUiIntent[] = [];

    let response;
    try {
      const client = this.getClient();
      response = await this.callProvider(
        () =>
          client.responses.create({
            model,
            store: true,
            previous_response_id: session.lastResponseId || undefined,
            parallel_tool_calls: false,
            max_output_tokens: 700,
            instructions: this.buildSystemPrompt({
              session,
              preferences,
              activeGoals,
              surface,
              surfaceContext,
              allowAutonomousActions,
              currentUserPromptContext: currentUserContext?.promptContext,
            }),
            input: [
              {
                type: 'message',
                role: 'user',
                content: inputText,
              },
            ],
            metadata: {
              requestId: requestId || 'agent-turn',
              route: 'agent-turn',
              sessionId,
              surface,
            },
            reasoning: {
              effort: model.includes('mini') ? 'low' : 'medium',
            },
            tools: this.toolDefinitions,
          } as any),
        {
          route: 'agent-turn',
          requestId,
          userId,
          sessionId,
          model,
        }
      );

      for (let iteration = 0; iteration < 6; iteration++) {
        const functionCalls: any[] = Array.isArray(response.output)
          ? response.output.filter((item: any) => item?.type === 'function_call')
          : [];

        if (functionCalls.length === 0) {
          break;
        }

        const toolOutputs = [];
        for (const call of functionCalls) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = call.arguments ? JSON.parse(call.arguments) : {};
          } catch {
            parsedArgs = {};
          }

          let toolResult = await executeAgentTool(call.name, parsedArgs, {
            userId,
            sessionId,
            surface,
            surfaceContext,
            allowAutonomousActions,
          });

          if (
            toolResult.suggestedAction &&
            toolResult.output?.reason === 'autonomous_actions_disabled'
          ) {
            const pendingAction = await pendingActionsService.createPending({
              sessionId,
              userId,
              toolName: call.name,
              actionType: toolResult.suggestedAction.type,
              title: toolResult.suggestedAction.title,
              summary: toolResult.suggestedAction.summary,
              input: parsedArgs,
              context: {
                surface,
                surfaceContext,
                uiIntents: toolResult.uiIntents || [],
              },
            });

            toolResult = {
              ...toolResult,
              summary: `${toolResult.suggestedAction.summary} I saved it in approvals so you can approve or reject it.`,
              output: {
                ...toolResult.output,
                status: 'pending_approval',
                pendingActionId: pendingAction.id,
                expiresAt: pendingAction.expiresAt.toISOString(),
              },
              suggestedAction: {
                ...toolResult.suggestedAction,
                pendingActionId: pendingAction.id,
                payload: {
                  ...(toolResult.suggestedAction.payload || {}),
                  pendingActionId: pendingAction.id,
                  expiresAt: pendingAction.expiresAt.toISOString(),
                },
              },
            };
          }

          if (toolResult.executedAction) {
            executedActions.push(toolResult.executedAction);
          }
          if (toolResult.suggestedAction) {
            suggestedActions.push(toolResult.suggestedAction);
          }
          if (toolResult.blockedAction) {
            blockedActions.push(toolResult.blockedAction);
          }
          if (toolResult.uiIntents && toolResult.uiIntents.length > 0) {
            uiIntents.push(...toolResult.uiIntents);
            emitAgentEvent(
              userId,
              'agent:navigation_preview',
              {
                sessionId,
                surface: resolveAgentSurfaceFromUiIntents(surface, toolResult.uiIntents),
                message: describeNavigationPreview(toolResult.uiIntents),
              },
              sessionId
            );
          }

          const actionToLog =
            toolResult.executedAction || toolResult.suggestedAction || toolResult.blockedAction;
          if (actionToLog) {
            await agentSessionService.logAction({
              sessionId,
              userId,
              action: actionToLog,
              input: parsedArgs,
              output: toolResult.output,
              uiIntents: toolResult.uiIntents || [],
            });
          }

          toolOutputs.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify(toolResult.output),
          });
        }

        response = await this.callProvider(
          () =>
            client.responses.create({
              model,
              store: true,
              previous_response_id: response.id,
              parallel_tool_calls: false,
              max_output_tokens: 700,
              input: toolOutputs,
              metadata: {
                requestId: requestId || 'agent-turn',
                route: 'agent-turn-tools',
                sessionId,
                surface,
              },
            } as any),
          {
            route: 'agent-turn-tools',
            requestId,
            userId,
            sessionId,
            model,
          }
        );
      }
    } catch (error) {
      if (this.shouldUseFallbackMode(error)) {
        return await this.runFallbackTurn({
          error,
          userId,
          session,
          sessionId,
          inputText,
          surface,
          surfaceContext,
          allowAutonomousActions,
          requestId,
          preferences,
          explicitGoalTexts,
        });
      }
      throw error;
    }

    const assistantMessage =
      extractOutputText(response) ||
      (executedActions.length > 0
        ? executedActions.map((action) => action.summary).join(' ')
        : 'I’m ready to help with the next step.');

    await agentSessionService.appendMessage({
      sessionId,
      userId,
      role: 'assistant',
      content: assistantMessage,
      metadata: {
        model,
        executedActions: executedActions.length,
        suggestedActions: suggestedActions.length,
      },
    });

    const dedupedUiIntents = dedupeUiIntents(uiIntents);
    const resolvedSurface = resolveAgentSurfaceFromUiIntents(surface, dedupedUiIntents);
    const memorySummary = buildMemorySummary({
      previousSummary: session.memorySummary,
      latestInput: inputText,
      surface: resolvedSurface,
      executedActions,
      assistantMessage,
    });
    const sessionMetadata = mergeSessionMetadataWithInlineResults(
      session.metadata,
      dedupedUiIntents
    );

    const sessionState = await agentSessionService.updateSession(sessionId, {
      currentSurface: resolvedSurface,
      lastResponseId: response.id,
      memorySummary,
      metadata: sessionMetadata,
      allowAutonomousActions,
      title: session.title || inputText.slice(0, 72),
    });

    await agentSessionService.upsertUserPreferences(userId, {
      goals: extractLikelyGoals(inputText, activeGoals),
      preferredOutreachStyle: preferences?.preferredOutreachStyle || 'warm and concise',
      memorySummary,
      lastSessionId: sessionId,
    });

    const pendingActions = (await pendingActionsService.getPending(userId)).map(serializePendingAction);
    const goals = (await agentGoalsService.getGoals(userId)).map(serializeGoal);

    const turnResponse = {
      assistantMessage,
      executedActions,
      suggestedActions: [...suggestedActions, ...blockedActions],
      uiIntents: dedupedUiIntents,
      pendingActions,
      goals,
      memorySummary,
      sessionState,
    };

    emitAgentEvent(
      userId,
      'agent:turn_completed',
      {
        sessionId,
        surface: resolvedSurface,
        assistantMessage,
        executedActions: executedActions.map(serializeAgentAction),
        suggestedActions: [...suggestedActions, ...blockedActions].map(serializeAgentAction),
        uiIntents: dedupedUiIntents,
        pendingActions,
        goals,
        memorySummary,
        sessionState,
      },
      sessionId
    );

    return turnResponse;
  }

  async transcribeAudio(params: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  }): Promise<string> {
    const client = this.getClient();
    const file = await OpenAI.toFile(params.buffer, params.fileName || 'agent-audio.m4a', {
      type: params.mimeType || 'audio/mp4',
    });
    const model = process.env.AGENT_TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
    const transcription = await this.callProvider(
      () =>
        client.audio.transcriptions.create({
          file,
          model,
        }),
      {
        route: 'agent-voice-transcribe',
        model,
      }
    );
    return String((transcription as any).text || '').trim();
  }

  async synthesizeSpeech(text: string): Promise<{ audioBase64: string; audioMimeType: string } | null> {
    if (!text.trim()) {
      return null;
    }

    const client = this.getClient();
    const model = process.env.AGENT_TTS_MODEL || 'gpt-4o-mini-tts';
    const response = await this.callProvider(
      () =>
        client.audio.speech.create({
          input: text.slice(0, 1500),
          model,
          voice: process.env.AGENT_TTS_VOICE || 'alloy',
          response_format: 'mp3',
        } as any),
      {
        route: 'agent-voice-tts',
        model,
      }
    );
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      audioBase64: buffer.toString('base64'),
      audioMimeType: 'audio/mpeg',
    };
  }

  async runVoiceTurn(params: {
    userId: string;
    sessionId: string;
    turn: AgentTurnRequest;
    audioBuffer: Buffer;
    fileName: string;
    mimeType: string;
    synthesizeAudio?: boolean;
    requestId?: string;
  }): Promise<AgentVoiceTurnResponse> {
    const transcript = await this.transcribeAudio({
      buffer: params.audioBuffer,
      fileName: params.fileName,
      mimeType: params.mimeType,
    });

    const turnResponse = await this.runTurn(
      params.userId,
      params.sessionId,
      {
        ...params.turn,
        inputText: transcript,
      },
      params.requestId
    );

    const audio =
      params.synthesizeAudio === false
        ? null
        : await this.synthesizeSpeech(turnResponse.assistantMessage);

    return {
      ...turnResponse,
      transcript,
      audioBase64: audio?.audioBase64 || null,
      audioMimeType: audio?.audioMimeType || null,
    };
  }
}

export const agentOrchestratorService = new AgentOrchestratorService();
