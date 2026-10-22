import OpenAI from "openai";
import { getIO } from "../../../../realtime/socket-registry";
import { AIServiceError } from "../../../ai/services/ai.service";
import { normalizeRealtimeTools, RealtimeVoiceSocketState, createTurnAccumulator, buildVoiceSystemPrompt } from "./voice-helpers.util";
import { attachRealtimeHandlersOperation, handleFunctionCallOperation } from "./voice-events.service";
import { finalizeTurnOperation, startSessionOperation, appendAudioChunkOperation, updateSurfaceOperation, interruptOperation, promptOperation, stopSessionOperation, cleanupSocketOperation } from "./voice-turn.service";

export class AgentRealtimeVoiceService {
  private readonly client: OpenAI | null;
  private readonly toolDefinitions: any[];
  private readonly sessions = new Map<string, RealtimeVoiceSocketState>();
  private readonly executionContext: AgentRealtimeVoiceServiceContext = (() => {
    const owner = this;
    return {
      get client() { return owner.client; },
      get toolDefinitions() { return owner.toolDefinitions; },
      get sessions() { return owner.sessions; },
      get getClient() { return owner.getClient.bind(owner); },
      get emitToSocket() { return owner.emitToSocket.bind(owner); },
      get emitVoiceState() { return owner.emitVoiceState.bind(owner); },
      get resetTurn() { return owner.resetTurn.bind(owner); },
      get pushRealtimeInstructions() { return owner.pushRealtimeInstructions.bind(owner); },
      get closeSocketState() { return owner.closeSocketState.bind(owner); },
      get attachRealtimeHandlers() { return owner.attachRealtimeHandlers.bind(owner); },
      get handleFunctionCall() { return owner.handleFunctionCall.bind(owner); },
      get finalizeTurn() { return owner.finalizeTurn.bind(owner); },
      get startSession() { return owner.startSession.bind(owner); },
      get appendAudioChunk() { return owner.appendAudioChunk.bind(owner); },
      get updateSurface() { return owner.updateSurface.bind(owner); },
      get interrupt() { return owner.interrupt.bind(owner); },
      get prompt() { return owner.prompt.bind(owner); },
      get stopSession() { return owner.stopSession.bind(owner); },
      get cleanupSocket() { return owner.cleanupSocket.bind(owner); },
    };
  })();


  constructor() {
    const apiKey = process.env.OPENAI_API_KEY || process.env.AI_API_KEY || '';
    this.client = apiKey
      ? new OpenAI({
          apiKey,
          maxRetries: 2,
          timeout: Number(process.env.AGENT_AI_TIMEOUT_MS || process.env.AI_TIMEOUT_MS || 45000),
        })
      : null;
    this.toolDefinitions = normalizeRealtimeTools();
  }

  private getClient(): OpenAI { return getClientOperation.call(this.executionContext); }

  private emitToSocket(socketId: string, event: string, payload: Record<string, unknown>): void { return emitToSocketOperation.call(this.executionContext, socketId, event, payload); }

  private emitVoiceState(
    state: RealtimeVoiceSocketState,
    voiceState: string,
    extra: Record<string, unknown> = {}
  ): void { return emitVoiceStateOperation.call(this.executionContext, state, voiceState, extra); }

  private resetTurn(state: RealtimeVoiceSocketState): void { return resetTurnOperation.call(this.executionContext, state); }

  private async pushRealtimeInstructions(state: RealtimeVoiceSocketState): Promise<void> { return pushRealtimeInstructionsOperation.call(this.executionContext, state); }

  private closeSocketState(
    state: RealtimeVoiceSocketState,
    params: {
      code?: number;
      reason?: string;
      emitStopped?: boolean;
    } = {}
  ): void { return closeSocketStateOperation.call(this.executionContext, state, params); }

  private attachRealtimeHandlers(state: RealtimeVoiceSocketState): void { return attachRealtimeHandlersOperation.call(this.executionContext, state); }

  private async handleFunctionCall(state: RealtimeVoiceSocketState, event: any): Promise<void> { return handleFunctionCallOperation.call(this.executionContext, state, event); }

  private async finalizeTurn(
    state: RealtimeVoiceSocketState,
    responseId?: string | null
  ): Promise<void> { return finalizeTurnOperation.call(this.executionContext, state, responseId); }

  async startSession(params: {
    socketId: string;
    userId: string;
    sessionId: string;
    surface?: string;
    surfaceContext?: Record<string, unknown>;
    allowAutonomousActions?: boolean;
    autonomyMode?: string;
  }): Promise<void> { return startSessionOperation.call(this.executionContext, params); }

  appendAudioChunk(socketId: string, audioBase64: string): void { return appendAudioChunkOperation.call(this.executionContext, socketId, audioBase64); }

  async updateSurface(params: {
    socketId: string;
    sessionId?: string;
    surface?: string;
    surfaceContext?: Record<string, unknown>;
    allowAutonomousActions?: boolean;
    autonomyMode?: string;
  }): Promise<void> { return updateSurfaceOperation.call(this.executionContext, params); }

  interrupt(socketId: string): void { return interruptOperation.call(this.executionContext, socketId); }

  prompt(socketId: string, instructions: string): void { return promptOperation.call(this.executionContext, socketId, instructions); }

  stopSession(socketId: string): void { return stopSessionOperation.call(this.executionContext, socketId); }

  cleanupSocket(socketId: string): void { return cleanupSocketOperation.call(this.executionContext, socketId); }
}

export const agentRealtimeVoiceService = new AgentRealtimeVoiceService();

function getClientOperation(this: AgentRealtimeVoiceServiceContext): OpenAI {
    if (!this.client) {
      throw new AIServiceError('Realtime voice is not configured.', {
        code: 'ai_not_configured',
        statusCode: 503,
        userMessage:
          process.env.NODE_ENV === 'development'
            ? 'Realtime voice is not configured on the backend. Add OPENAI_API_KEY to vormex-backend/.env and restart the backend.'
            : 'Realtime voice is temporarily unavailable right now.',
      });
    }

    return this.client;
  }

function emitToSocketOperation(this: AgentRealtimeVoiceServiceContext, socketId: string, event: string, payload: Record<string, unknown>): void {
    const io = getIO();
    if (!io) return;
    io.to(socketId).emit(event, payload);
  }

function emitVoiceStateOperation(this: AgentRealtimeVoiceServiceContext, state: RealtimeVoiceSocketState, voiceState: string, extra: Record<string, unknown> = {}): void {
    this.emitToSocket(state.socketId, 'agent:voice_state', {
      sessionId: state.sessionId,
      state: voiceState,
      responseId: state.currentResponseId,
      ...extra,
    });
  }

function resetTurnOperation(this: AgentRealtimeVoiceServiceContext, state: RealtimeVoiceSocketState): void {
    state.turn = createTurnAccumulator();
  }

async function pushRealtimeInstructionsOperation(this: AgentRealtimeVoiceServiceContext, state: RealtimeVoiceSocketState): Promise<void> {
    state.rt.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: buildVoiceSystemPrompt({
          session: state.session,
          preferences: state.preferences,
          activeGoals: state.activeGoals,
          surface: state.surface,
          surfaceContext: state.surfaceContext,
          autonomyPolicy: state.autonomyPolicy,
          currentUserPromptContext: state.currentUserPromptContext,
        }),
        audio: {
          input: {
            format: {
              type: 'audio/pcm',
              rate: 24000,
            },
            transcription: {
              model: process.env.AGENT_REALTIME_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
              ...(process.env.AGENT_REALTIME_TRANSCRIBE_LANGUAGE
                ? {
                    language: process.env.AGENT_REALTIME_TRANSCRIBE_LANGUAGE,
                  }
                : {}),
            },
            turn_detection: {
              type: 'server_vad',
              create_response: true,
              interrupt_response: true,
              prefix_padding_ms: Number(process.env.AGENT_REALTIME_PREFIX_PADDING_MS || 200),
              silence_duration_ms: Number(process.env.AGENT_REALTIME_SILENCE_MS || 320),
              threshold: Number(process.env.AGENT_REALTIME_VAD_THRESHOLD || 0.5),
            },
          },
          output: {
            format: {
              type: 'audio/pcm',
              rate: 24000,
            },
            voice: process.env.AGENT_REALTIME_VOICE || 'shimmer',
          },
        },
        output_modalities: ['audio'],
        max_output_tokens: Number(process.env.AGENT_REALTIME_MAX_OUTPUT_TOKENS || 420),
        tools: this.toolDefinitions,
        tool_choice: 'auto',
      },
    } as any);
  }

function closeSocketStateOperation(this: AgentRealtimeVoiceServiceContext, state: RealtimeVoiceSocketState, params: {
      code?: number;
      reason?: string;
      emitStopped?: boolean;
    } = {}): void {
    if (state.closing) {
      return;
    }

    state.closing = true;
    this.sessions.delete(state.socketId);

    try {
      state.rt.close({
        code: params.code || 1000,
        reason: params.reason || 'OK',
      });
    } catch (_error) {
    }

    if (params.emitStopped !== false) {
      this.emitVoiceState(state, 'stopped');
      this.emitToSocket(state.socketId, 'agent:voice_audio_done', {
        sessionId: state.sessionId,
      });
    }
  }

/** Internal execution contract; the service retains ownership of state and lifecycle. */
export interface AgentRealtimeVoiceServiceContext {
client: OpenAI | null;
toolDefinitions: any[];
sessions: Map<string, RealtimeVoiceSocketState>;
getClient(): OpenAI;
emitToSocket(socketId: string, event: string, payload: Record<string, unknown>): void;
emitVoiceState(state: RealtimeVoiceSocketState, voiceState: string, extra?: Record<string, unknown>): void;
resetTurn(state: RealtimeVoiceSocketState): void;
pushRealtimeInstructions(state: RealtimeVoiceSocketState): Promise<void>;
closeSocketState(state: RealtimeVoiceSocketState, params?: {
      code?: number;
      reason?: string;
      emitStopped?: boolean;
    }): void;
attachRealtimeHandlers(state: RealtimeVoiceSocketState): void;
handleFunctionCall(state: RealtimeVoiceSocketState, event: any): Promise<void>;
finalizeTurn(state: RealtimeVoiceSocketState, responseId?: string | null): Promise<void>;
startSession(params: {
    socketId: string;
    userId: string;
    sessionId: string;
    surface?: string;
    surfaceContext?: Record<string, unknown>;
    allowAutonomousActions?: boolean;
    autonomyMode?: string;
  }): Promise<void>;
appendAudioChunk(socketId: string, audioBase64: string): void;
updateSurface(params: {
    socketId: string;
    sessionId?: string;
    surface?: string;
    surfaceContext?: Record<string, unknown>;
    allowAutonomousActions?: boolean;
    autonomyMode?: string;
  }): Promise<void>;
interrupt(socketId: string): void;
prompt(socketId: string, instructions: string): void;
stopSession(socketId: string): void;
cleanupSocket(socketId: string): void;
}
