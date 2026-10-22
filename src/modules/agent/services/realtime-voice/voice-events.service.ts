import { logger } from "../../../../infrastructure/logging/logger";
import { agentSessionService } from "../session.service";
import { executeAgentTool } from "../../utils/tools";
import { pendingActionsService } from "../pending-actions.service";
import { emitAgentEvent } from "../../utils/socket-events";
import { getAgentToolPolicy } from "../action-policy.service";
import { redactAgentPayload } from "../../utils/data-safety";
import { describeNavigationPreview, resolveAgentSurfaceFromUiIntents } from "../../utils/surface-utils";
import { createAudioOnlyResponseEvent, isBenignCancelError, mapRealtimeErrorToUserMessage, RealtimeVoiceSocketState } from "./voice-helpers.util";
import type { AgentRealtimeVoiceServiceContext } from "./voice-session.service";

export function attachRealtimeHandlersOperation(this: AgentRealtimeVoiceServiceContext, state: RealtimeVoiceSocketState): void {
    state.rt.on('session.updated', () => {
      if (state.ready || state.closing) {
        return;
      }
      state.ready = true;
      this.emitToSocket(state.socketId, 'agent:voice_ready', {
        sessionId: state.sessionId,
        model: state.model,
      });
      this.emitVoiceState(state, 'ready');
    });

    state.rt.on('input_audio_buffer.speech_started', () => {
      state.turn.liveUserTranscript = '';
      state.turn.userTranscript = '';
      if (state.assistantSpeaking || state.currentResponseId) {
        try {
          state.rt.send({
            type: 'response.cancel',
          } as any);
        } catch (_error) {
        }
      }
      state.assistantSpeaking = false;
      state.currentResponseId = null;
      this.emitToSocket(state.socketId, 'agent:voice_audio_done', {
        sessionId: state.sessionId,
        responseId: state.currentResponseId,
      });
      this.emitVoiceState(state, 'listening');
    });

    state.rt.on('input_audio_buffer.speech_stopped', () => {
      this.emitVoiceState(state, 'processing');
    });

    state.rt.on('conversation.item.input_audio_transcription.delta', (event: any) => {
      if (typeof event?.delta === 'string' && event.delta) {
        state.turn.liveUserTranscript += event.delta;
        this.emitToSocket(state.socketId, 'agent:voice_user_transcript', {
          sessionId: state.sessionId,
          text: state.turn.liveUserTranscript,
          isFinal: false,
        });
      }
    });

    state.rt.on('conversation.item.input_audio_transcription.completed', (event: any) => {
      state.turn.userTranscript = String(event?.transcript || '').trim();
      state.turn.liveUserTranscript = state.turn.userTranscript;
      this.emitToSocket(state.socketId, 'agent:voice_user_transcript', {
        sessionId: state.sessionId,
        text: state.turn.userTranscript,
        isFinal: true,
      });
    });

    state.rt.on('response.created', (event: any) => {
      state.currentResponseId = event?.response?.id || null;
      state.turn.assistantTranscript = '';
      this.emitVoiceState(state, 'processing');
    });

    state.rt.on('response.output_audio.delta', (event: any) => {
      state.currentResponseId = event?.response_id || state.currentResponseId;
      if (!state.assistantSpeaking) {
        state.assistantSpeaking = true;
        this.emitVoiceState(state, 'speaking');
      }
      if (typeof event?.delta === 'string' && event.delta) {
        this.emitToSocket(state.socketId, 'agent:voice_audio_delta', {
          sessionId: state.sessionId,
          responseId: state.currentResponseId,
          audioBase64: event.delta,
          audioMimeType: 'audio/pcm;rate=24000',
        });
      }
    });

    state.rt.on('response.output_audio.done', () => {
      state.assistantSpeaking = false;
      this.emitToSocket(state.socketId, 'agent:voice_audio_done', {
        sessionId: state.sessionId,
        responseId: state.currentResponseId,
      });
    });

    state.rt.on('response.output_audio_transcript.delta', (event: any) => {
      if (typeof event?.delta === 'string' && event.delta) {
        state.turn.assistantTranscript += event.delta;
        this.emitToSocket(state.socketId, 'agent:voice_assistant_transcript', {
          sessionId: state.sessionId,
          text: state.turn.assistantTranscript,
          isFinal: false,
        });
      }
    });

    state.rt.on('response.output_audio_transcript.done', () => {
      this.emitToSocket(state.socketId, 'agent:voice_assistant_transcript', {
        sessionId: state.sessionId,
        text: state.turn.assistantTranscript,
        isFinal: true,
      });
    });

    state.rt.on('response.function_call_arguments.done', async (event: any) => {
      try {
        await this.handleFunctionCall(state, event);
      } catch (error) {
        logger.error({
          event: 'agent.voice.tool_call.error',
          socketId: state.socketId,
          userId: state.userId,
          sessionId: state.sessionId,
          toolName: event?.name,
          message: error instanceof Error ? error.message : String(error),
        });

        state.rt.send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: event?.call_id,
            output: JSON.stringify({
              status: 'error',
              message: error instanceof Error ? error.message : 'Tool execution failed.',
            }),
          },
        } as any);
        state.rt.send(createAudioOnlyResponseEvent());
      }
    });

    state.rt.on('response.done', async (event: any) => {
      state.assistantSpeaking = false;
      const responseStatus = String(event?.response?.status || '');
      const responseReason =
        String(event?.response?.status_details?.reason || event?.response?.reason || '');

      if (
        responseStatus === 'cancelled' &&
        responseReason === 'turn_detected' &&
        !state.turn.assistantTranscript.trim() &&
        state.turn.executedActions.length === 0 &&
        state.turn.suggestedActions.length === 0 &&
        state.turn.blockedActions.length === 0 &&
        state.turn.uiIntents.length === 0
      ) {
        this.resetTurn(state);
        this.emitVoiceState(state, 'listening');
        return;
      }

      if (responseStatus === 'failed' && !state.turn.assistantTranscript.trim()) {
        this.emitToSocket(state.socketId, 'agent:voice_error', {
          sessionId: state.sessionId,
          error: 'Realtime voice could not finish that reply. Please try again.',
        });
        this.resetTurn(state);
        this.emitVoiceState(state, 'ready');
        return;
      }

      await this.finalizeTurn(state, event?.response?.id || state.currentResponseId);
      state.currentResponseId = null;
      this.emitVoiceState(state, 'ready');
    });

    state.rt.on('error', (error: any) => {
      if (isBenignCancelError(error)) {
        state.assistantSpeaking = false;
        state.currentResponseId = null;
        this.emitToSocket(state.socketId, 'agent:voice_audio_done', {
          sessionId: state.sessionId,
        });
        this.emitVoiceState(state, 'listening');
        return;
      }

      logger.warn({
        event: 'agent.voice.realtime.error',
        socketId: state.socketId,
        userId: state.userId,
        sessionId: state.sessionId,
        message: error?.message || 'unknown realtime error',
        code: error?.error?.code,
        type: error?.error?.type,
      });

      this.emitToSocket(state.socketId, 'agent:voice_error', {
        sessionId: state.sessionId,
        error: mapRealtimeErrorToUserMessage(error),
      });
      this.closeSocketState(state, {
        code: 1011,
        reason: 'Realtime voice error',
        emitStopped: true,
      });
    });
  }

export async function handleFunctionCallOperation(this: AgentRealtimeVoiceServiceContext, state: RealtimeVoiceSocketState, event: any): Promise<void> {
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = event?.arguments ? JSON.parse(event.arguments) : {};
    } catch {
      parsedArgs = {};
    }

    let toolResult = await executeAgentTool(event.name, parsedArgs, {
      userId: state.userId,
      sessionId: state.sessionId,
      surface: state.surface,
      surfaceContext: state.surfaceContext,
      allowAutonomousActions: state.autonomyPolicy.allowAutonomousActions,
      autonomyMode: state.autonomyPolicy.effectiveAutonomyMode,
      requestedAutonomyMode: state.autonomyPolicy.requestedAutonomyMode,
      effectiveAutonomyMode: state.autonomyPolicy.effectiveAutonomyMode,
      powerModeEligible: state.autonomyPolicy.powerModeEligible,
      isPremium: state.autonomyPolicy.isPremium,
    });

    if (
      toolResult.suggestedAction &&
      (toolResult.output?.status === 'approval_required' ||
        toolResult.output?.status === 'suggested' ||
        toolResult.output?.reason === 'autonomous_actions_disabled')
    ) {
      const toolPolicy = getAgentToolPolicy(event.name);
      const pendingAction = await pendingActionsService.createPending({
        sessionId: state.sessionId,
        userId: state.userId,
        toolName: event.name,
        actionType: toolResult.suggestedAction.type,
        title: toolResult.suggestedAction.title,
        summary: toolResult.suggestedAction.summary,
        input: parsedArgs,
        context: {
          surface: state.surface,
          surfaceContext: state.surfaceContext,
          uiIntents: toolResult.uiIntents || [],
          riskLevel: toolPolicy.riskLevel,
          autonomyMode: state.autonomyPolicy.effectiveAutonomyMode,
          requestedAutonomyMode: state.autonomyPolicy.requestedAutonomyMode,
          powerModeEligible: state.autonomyPolicy.powerModeEligible,
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
          riskLevel: toolPolicy.riskLevel,
          autonomyMode: state.autonomyPolicy.effectiveAutonomyMode,
        },
        suggestedAction: {
          ...toolResult.suggestedAction,
          pendingActionId: pendingAction.id,
          riskLevel: toolPolicy.riskLevel,
          autonomyMode: state.autonomyPolicy.effectiveAutonomyMode,
          payload: {
            ...(toolResult.suggestedAction.payload || {}),
            pendingActionId: pendingAction.id,
            expiresAt: pendingAction.expiresAt.toISOString(),
          },
        },
      };
    }

    if (toolResult.executedAction) {
      state.turn.executedActions.push(toolResult.executedAction);
    }
    if (toolResult.suggestedAction) {
      state.turn.suggestedActions.push(toolResult.suggestedAction);
    }
    if (toolResult.blockedAction) {
      state.turn.blockedActions.push(toolResult.blockedAction);
    }
    if (toolResult.uiIntents?.length) {
      state.turn.uiIntents.push(...toolResult.uiIntents);
      emitAgentEvent(
        state.userId,
        'agent:navigation_preview',
        {
          sessionId: state.sessionId,
          surface: resolveAgentSurfaceFromUiIntents(state.surface, toolResult.uiIntents),
          message: describeNavigationPreview(toolResult.uiIntents),
        },
        state.sessionId
      );
    }

    const actionToLog =
      toolResult.executedAction || toolResult.suggestedAction || toolResult.blockedAction;
    if (actionToLog) {
      await agentSessionService.logAction({
        sessionId: state.sessionId,
        userId: state.userId,
        action: actionToLog,
        input: parsedArgs,
        output: toolResult.output,
        uiIntents: toolResult.uiIntents || [],
      });
    }

    state.rt.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: event.call_id,
        output: JSON.stringify(redactAgentPayload(toolResult.output)),
      },
    } as any);
    state.rt.send(createAudioOnlyResponseEvent());
  }
