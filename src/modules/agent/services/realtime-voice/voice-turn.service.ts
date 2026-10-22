import { OpenAIRealtimeWebSocket } from "openai/realtime/websocket";
import { getAgentAccessDeniedMessage, getPremiumAccessSnapshot } from "../../../premium/services/premium-access.service";
import { agentSessionService } from "../session.service";
import { getAgentCurrentUserContext } from "../../utils/tools";
import { pendingActionsService } from "../pending-actions.service";
import { agentGoalsService } from "../goals.service";
import { mergeSessionMetadataWithInlineResults } from "../../utils/inline-results";
import { emitAgentEvent, serializeAgentAction, serializeGoal, serializePendingAction } from "../../utils/socket-events";
import { AgentVoiceTurnResponse } from "../../types";
import { applyAutonomyPolicyToSession, resolveAgentAutonomyPolicy } from "../action-policy.service";
import { resolveAgentSurfaceFromUiIntents } from "../../utils/surface-utils";
import { containsPromptInjection, wrapUntrustedPromptContent } from "../../../../shared/utils/input-security.util";
import { executeWithCircuitBreaker } from "../../../../infrastructure/http/http-client-with-breaker.util";
import { dedupeUiIntents, buildMemorySummary, extractLikelyGoals, RealtimeVoiceSocketState, ensureRealtimeWebSocketGlobal, waitForRealtimeSocketOpen, mergeGoals, createTurnAccumulator, mapRealtimeProviderError, createPromptedAudioResponseEvent } from "./voice-helpers.util";
import type { AgentRealtimeVoiceServiceContext } from "./voice-session.service";

export async function finalizeTurnOperation(this: AgentRealtimeVoiceServiceContext, state: RealtimeVoiceSocketState, responseId?: string | null): Promise<void> {
    const transcript = state.turn.userTranscript.trim();
    const executedActions = [...state.turn.executedActions];
    const suggestedActions = [...state.turn.suggestedActions, ...state.turn.blockedActions];
    const uiIntents = dedupeUiIntents(state.turn.uiIntents);
    const resolvedSurface = resolveAgentSurfaceFromUiIntents(state.surface, uiIntents);
    const assistantMessage =
      state.turn.assistantTranscript.trim() ||
      (executedActions.length > 0
        ? executedActions.map((action) => action.summary).join(' ')
        : suggestedActions.length > 0
          ? suggestedActions.map((action) => action.summary).join(' ')
          : 'I’m here and ready for the next step.');

    if (!transcript && !assistantMessage && executedActions.length === 0 && suggestedActions.length === 0) {
      this.resetTurn(state);
      return;
    }

    if (transcript) {
      await agentSessionService.appendMessage({
        sessionId: state.sessionId,
        userId: state.userId,
        role: 'user',
        content: transcript,
        metadata: {
          surface: state.surface,
          surfaceContext: state.surfaceContext,
          allowAutonomousActions: state.autonomyPolicy.allowAutonomousActions,
          requestedAutonomyMode: state.autonomyPolicy.requestedAutonomyMode,
          effectiveAutonomyMode: state.autonomyPolicy.effectiveAutonomyMode,
          powerModeEligible: state.autonomyPolicy.powerModeEligible,
          voice: true,
        },
      });
    }

    await agentSessionService.appendMessage({
      sessionId: state.sessionId,
      userId: state.userId,
      role: 'assistant',
      content: assistantMessage,
      metadata: {
        model: state.model,
        voice: true,
        responseId: responseId || null,
        executedActions: executedActions.length,
        suggestedActions: suggestedActions.length,
      },
    });
    const accessSnapshot = await getPremiumAccessSnapshot(state.userId);

    const memorySummary = buildMemorySummary({
      previousSummary: state.session.memorySummary,
      latestInput: transcript || state.turn.liveUserTranscript || 'voice turn',
      surface: resolvedSurface,
      executedActions,
      assistantMessage,
    });
    const sessionMetadata = mergeSessionMetadataWithInlineResults(
      state.session.metadata,
      uiIntents
    );

    const sessionState = await agentSessionService.updateSession(state.sessionId, {
      currentSurface: resolvedSurface,
      lastResponseId: responseId || null,
      memorySummary,
      metadata: sessionMetadata,
      allowAutonomousActions: state.autonomyPolicy.allowAutonomousActions,
      title: state.session.title || transcript.slice(0, 72) || state.session.title,
    });
    const sessionStateWithPolicy = applyAutonomyPolicyToSession(sessionState, state.autonomyPolicy);

    state.session = {
      ...state.session,
      currentSurface: sessionStateWithPolicy.currentSurface,
      lastResponseId: sessionStateWithPolicy.lastResponseId,
      memorySummary: sessionStateWithPolicy.memorySummary,
      metadata: sessionMetadata,
      allowAutonomousActions: sessionStateWithPolicy.allowAutonomousActions,
      title: state.session.title || transcript.slice(0, 72) || state.session.title,
    };

    await agentSessionService.upsertUserPreferences(state.userId, {
      goals: extractLikelyGoals(transcript, state.activeGoals),
      preferredOutreachStyle: state.preferences?.preferredOutreachStyle || 'warm and concise',
      memorySummary,
      lastSessionId: state.sessionId,
    });

    const pendingActions = (await pendingActionsService.getPending(state.userId)).map(serializePendingAction);
    const goals = (await agentGoalsService.getGoals(state.userId)).map(serializeGoal);

    const voiceTurnResponse: AgentVoiceTurnResponse = {
      assistantMessage,
      executedActions,
      suggestedActions,
      uiIntents,
      pendingActions,
      goals,
      memorySummary,
      sessionState: sessionStateWithPolicy,
      transcript,
      audioBase64: null,
      audioMimeType: null,
    };

    this.emitToSocket(state.socketId, 'agent:voice_turn_final', voiceTurnResponse as any);
    emitAgentEvent(
      state.userId,
      'agent:turn_completed',
      {
        sessionId: state.sessionId,
        surface: resolvedSurface,
        assistantMessage,
        transcript,
        executedActions: executedActions.map(serializeAgentAction),
        suggestedActions: suggestedActions.map(serializeAgentAction),
        uiIntents,
        pendingActions,
        goals,
        memorySummary,
        sessionState: sessionStateWithPolicy,
      },
      state.sessionId
    );

    this.resetTurn(state);

    if (accessSnapshot.agentLimitReached) {
      this.emitToSocket(state.socketId, 'agent:voice_error', {
        sessionId: state.sessionId,
        error: getAgentAccessDeniedMessage(accessSnapshot),
      });
      this.stopSession(state.socketId);
    }
  }

export async function startSessionOperation(this: AgentRealtimeVoiceServiceContext, params: {
    socketId: string;
    userId: string;
    sessionId: string;
    surface?: string;
    surfaceContext?: Record<string, unknown>;
    allowAutonomousActions?: boolean;
    autonomyMode?: string;
  }): Promise<void> {
    const existing = this.sessions.get(params.socketId);
    if (existing) {
      this.closeSocketState(existing, {
        code: 1000,
        reason: 'Starting a new realtime voice session',
        emitStopped: false,
      });
    }

    const client = this.getClient();
    ensureRealtimeWebSocketGlobal();
    const session = await agentSessionService.requireSession(params.sessionId, params.userId);
    const preferencesPromise = agentSessionService.getUserPreferences(params.userId);
    const goalsPromise = agentGoalsService.getGoals(params.userId);
    const currentUserContextPromise = getAgentCurrentUserContext(params.userId);
    const accessSnapshotPromise = getPremiumAccessSnapshot(params.userId);
    const model = process.env.AGENT_REALTIME_MODEL || 'gpt-realtime-mini';

    let rt: OpenAIRealtimeWebSocket | null = null;
    try {
      const realtimeSocketPromise = executeWithCircuitBreaker(
        'openai_realtime',
        'voice_session_start',
        async () => {
          const socket = await OpenAIRealtimeWebSocket.create(client, { model });
          await waitForRealtimeSocketOpen(socket);
          return socket;
        },
        {
          connectTimeoutMs: 5_000,
          requestTimeoutMs: 15_000,
        }
      );

      const [preferences, explicitGoals, currentUserContext, accessSnapshot, realtimeSocket] = await Promise.all([
        preferencesPromise,
        goalsPromise,
        currentUserContextPromise,
        accessSnapshotPromise,
        realtimeSocketPromise,
      ]);
      const autonomyPolicy = resolveAgentAutonomyPolicy({
        requestedAutonomyMode: params.autonomyMode,
        allowAutonomousActions: params.allowAutonomousActions,
        fallbackMode: session.allowAutonomousActions ? 'power' : 'approval',
        isPremium: accessSnapshot.isPremium,
      });
      rt = realtimeSocket;
      const mergedGoals = mergeGoals(
        explicitGoals.map((goal) => goal.goal),
        preferences?.goals || []
      );
      const state: RealtimeVoiceSocketState = {
        socketId: params.socketId,
        userId: params.userId,
        sessionId: params.sessionId,
        surface: String(params.surface || session.currentSurface || 'global'),
        surfaceContext:
          params.surfaceContext && typeof params.surfaceContext === 'object'
            ? params.surfaceContext
            : {},
        allowAutonomousActions: autonomyPolicy.allowAutonomousActions,
        autonomyPolicy,
        model,
        client,
        rt,
        session,
        preferences,
        activeGoals: mergedGoals,
        currentUserPromptContext: currentUserContext?.promptContext || null,
        ready: false,
        closing: false,
        assistantSpeaking: false,
        currentResponseId: null,
        turn: createTurnAccumulator(),
      };

      this.sessions.set(params.socketId, state);
      this.attachRealtimeHandlers(state);
      this.emitVoiceState(state, 'connecting');

      await this.pushRealtimeInstructions(state);
    } catch (error) {
      if (params.socketId) {
        this.sessions.delete(params.socketId);
      }
      try {
        rt?.close({
          code: 1011,
          reason: 'Failed to initialize realtime voice',
        });
      } catch (_closeError) {
      }
      throw mapRealtimeProviderError(error);
    }
  }

export function appendAudioChunkOperation(this: AgentRealtimeVoiceServiceContext, socketId: string, audioBase64: string): void {
    const state = this.sessions.get(socketId);
    if (!state || state.closing || !state.ready || !audioBase64) {
      return;
    }

    state.rt.send({
      type: 'input_audio_buffer.append',
      audio: audioBase64,
    } as any);
  }

export async function updateSurfaceOperation(this: AgentRealtimeVoiceServiceContext, params: {
    socketId: string;
    sessionId?: string;
    surface?: string;
    surfaceContext?: Record<string, unknown>;
    allowAutonomousActions?: boolean;
    autonomyMode?: string;
  }): Promise<void> {
    const state = this.sessions.get(params.socketId);
    if (!state || state.closing) {
      return;
    }

    const nextSurface = String(params.surface || state.surface || 'global').trim() || 'global';
    state.surface = nextSurface;
    state.surfaceContext =
      params.surfaceContext && typeof params.surfaceContext === 'object'
        ? params.surfaceContext
        : state.surfaceContext;
    if (typeof params.allowAutonomousActions === 'boolean' || typeof params.autonomyMode === 'string') {
      const accessSnapshot = await getPremiumAccessSnapshot(state.userId);
      state.autonomyPolicy = resolveAgentAutonomyPolicy({
        requestedAutonomyMode: params.autonomyMode,
        allowAutonomousActions: params.allowAutonomousActions,
        fallbackMode: state.autonomyPolicy.effectiveAutonomyMode,
        isPremium: accessSnapshot.isPremium,
      });
      state.allowAutonomousActions = state.autonomyPolicy.allowAutonomousActions;
    }

    const updatedSession = await agentSessionService.updateSession(state.sessionId, {
      currentSurface: nextSurface,
      allowAutonomousActions: state.autonomyPolicy.allowAutonomousActions,
    });
    state.session = {
      ...state.session,
      currentSurface: updatedSession.currentSurface,
      allowAutonomousActions: state.autonomyPolicy.allowAutonomousActions,
    };

    if (state.ready) {
      await this.pushRealtimeInstructions(state);
    }
  }

export function interruptOperation(this: AgentRealtimeVoiceServiceContext, socketId: string): void {
    const state = this.sessions.get(socketId);
    if (!state || state.closing) {
      return;
    }

    if (!state.assistantSpeaking && !state.currentResponseId) {
      return;
    }

    try {
      state.rt.send({
        type: 'response.cancel',
      } as any);
    } catch (_error) {
    }
  }

export function promptOperation(this: AgentRealtimeVoiceServiceContext, socketId: string, instructions: string): void {
    const state = this.sessions.get(socketId);
    const trimmedInstructions = String(instructions || '').trim();
    if (!state || state.closing || !state.ready || !trimmedInstructions) {
      return;
    }

    if (containsPromptInjection(trimmedInstructions)) {
      return;
    }

    if (state.assistantSpeaking || state.currentResponseId) {
      return;
    }

    state.turn.assistantTranscript = '';
    state.rt.send(createPromptedAudioResponseEvent(wrapUntrustedPromptContent('voice_prompt', trimmedInstructions)));
  }

export function stopSessionOperation(this: AgentRealtimeVoiceServiceContext, socketId: string): void {
    const state = this.sessions.get(socketId);
    if (!state) {
      return;
    }

    this.closeSocketState(state, {
      code: 1000,
      reason: 'User stopped realtime voice',
      emitStopped: true,
    });
  }

export function cleanupSocketOperation(this: AgentRealtimeVoiceServiceContext, socketId: string): void {
    const state = this.sessions.get(socketId);
    if (!state) {
      return;
    }

    this.closeSocketState(state, {
      code: 1001,
      reason: 'Socket disconnected',
      emitStopped: false,
    });
  }
