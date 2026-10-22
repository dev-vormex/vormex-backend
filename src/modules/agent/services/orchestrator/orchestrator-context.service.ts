import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { logger } from "../../../../infrastructure/logging/logger";
import { AIServiceError } from "../../../ai/services/ai.service";
import { executeWithCircuitBreaker, isThirdPartyHttpError } from "../../../../infrastructure/http/http-client-with-breaker.util";
import { getAgentToolDefinitions } from "../../utils/tools";
import { AgentTurnRequest, AgentTurnResponse, AgentVoiceTurnResponse } from "../../types";
import { AgentAutonomyPolicy } from "../action-policy.service";
import { trimmedEnv, buildOpenAIClient, toGeminiFunctionDeclarations, intEnv, parseRetryAfterSeconds } from "./provider-helpers.util";
import { runFallbackTurnOperation, buildSystemPromptOperation } from "./fallback-turn.service";
import { runTurnOperation } from "./conversation-turn.service";
import { transcribeAudioOperation, synthesizeSpeechOperation, runVoiceTurnOperation } from "./voice-turn.service";

export class AgentOrchestratorService {
  private readonly client: OpenAI | null;
  private readonly geminiClient: GoogleGenAI | null;
  private readonly geminiModel: string;
  private readonly geminiMaxOutputTokens: number;
  private readonly geminiTimeoutMs: number;
  private readonly toolDefinitions: any[];
  private readonly geminiToolDeclarations: any[];
  private readonly executionContext: AgentOrchestratorServiceContext = (() => {
    const owner = this;
    return {
      get client() { return owner.client; },
      get geminiClient() { return owner.geminiClient; },
      get geminiModel() { return owner.geminiModel; },
      get geminiMaxOutputTokens() { return owner.geminiMaxOutputTokens; },
      get geminiTimeoutMs() { return owner.geminiTimeoutMs; },
      get toolDefinitions() { return owner.toolDefinitions; },
      get geminiToolDeclarations() { return owner.geminiToolDeclarations; },
      get getClient() { return owner.getClient.bind(owner); },
      get getGeminiClient() { return owner.getGeminiClient.bind(owner); },
      get mapProviderError() { return owner.mapProviderError.bind(owner); },
      get callProvider() { return owner.callProvider.bind(owner); },
      get shouldUseFallbackMode() { return owner.shouldUseFallbackMode.bind(owner); },
      get buildFallbackPreamble() { return owner.buildFallbackPreamble.bind(owner); },
      get runFallbackTurn() { return owner.runFallbackTurn.bind(owner); },
      get buildSystemPrompt() { return owner.buildSystemPrompt.bind(owner); },
      get runTurn() { return owner.runTurn.bind(owner); },
      get transcribeAudio() { return owner.transcribeAudio.bind(owner); },
      get synthesizeSpeech() { return owner.synthesizeSpeech.bind(owner); },
      get runVoiceTurn() { return owner.runVoiceTurn.bind(owner); },
    };
  })();


  constructor() {
    const apiKey = process.env.OPENAI_API_KEY || process.env.AI_API_KEY || '';
    const openaiBaseURL = trimmedEnv('OPENAI_BASE_URL') || trimmedEnv('AI_BASE_URL');
    this.client = apiKey ? buildOpenAIClient(apiKey, openaiBaseURL || undefined) : null;

    this.toolDefinitions = getAgentToolDefinitions();
    this.geminiToolDeclarations = toGeminiFunctionDeclarations(this.toolDefinitions);
    const geminiApiKey = trimmedEnv('GEMINI_API_KEY');
    this.geminiClient = geminiApiKey
      ? new GoogleGenAI({
          apiKey: geminiApiKey,
          httpOptions: {
            timeout: intEnv(
              'AGENT_GEMINI_TIMEOUT_MS',
              intEnv('AGENT_AI_TIMEOUT_MS', intEnv('AI_TIMEOUT_MS', 45000))
            ),
          },
        } as any)
      : null;
    this.geminiModel = trimmedEnv('AGENT_GEMINI_MODEL') || trimmedEnv('GEMINI_MODEL') || 'gemini-2.5-flash';
    this.geminiMaxOutputTokens = intEnv('AGENT_GEMINI_MAX_OUTPUT_TOKENS', 700);
    this.geminiTimeoutMs = intEnv(
      'AGENT_GEMINI_TIMEOUT_MS',
      intEnv('AGENT_AI_TIMEOUT_MS', intEnv('AI_TIMEOUT_MS', 45000))
    );
  }

  private getClient(): OpenAI { return getClientOperation.call(this.executionContext); }

  private getGeminiClient(): GoogleGenAI { return getGeminiClientOperation.call(this.executionContext); }

  private mapProviderError(error: unknown, params: {
    route: string;
    requestId?: string;
    userId?: string;
    sessionId?: string;
    model?: string;
    provider?: string;
  }): never { return mapProviderErrorOperation.call(this.executionContext, error, params) as never; }

  private async callProvider<T>(
    operation: () => Promise<T>,
    params: {
      route: string;
      requestId?: string;
      userId?: string;
      sessionId?: string;
      model?: string;
      provider?: string;
    }
  ): Promise<T> { return callProviderOperation.call(this.executionContext, operation, params) as Promise<T>; }

  private shouldUseFallbackMode(error: unknown): error is AIServiceError { return shouldUseFallbackModeOperation.call(this.executionContext, error); }

  private buildFallbackPreamble(error: AIServiceError): string { return buildFallbackPreambleOperation.call(this.executionContext, error); }

  private async runFallbackTurn(params: {
    error: AIServiceError;
    userId: string;
    session: any;
    sessionId: string;
    inputText: string;
    surface: string;
    surfaceContext: Record<string, unknown>;
    autonomyPolicy: AgentAutonomyPolicy;
    requestId?: string;
    preferences: any;
    explicitGoalTexts: string[];
  }): Promise<AgentTurnResponse> { return runFallbackTurnOperation.call(this.executionContext, params); }

  private buildSystemPrompt(params: {
    session: any;
    preferences: any;
    activeGoals: string[];
    surface: string;
    surfaceContext: Record<string, unknown>;
    autonomyPolicy: AgentAutonomyPolicy;
    currentUserPromptContext?: string | null;
  }): string { return buildSystemPromptOperation.call(this.executionContext, params); }

  async runTurn(
    userId: string,
    sessionId: string,
    turn: AgentTurnRequest,
    requestId?: string
  ): Promise<AgentTurnResponse> { return runTurnOperation.call(this.executionContext, userId, sessionId, turn, requestId); }

  async transcribeAudio(params: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  }): Promise<string> { return transcribeAudioOperation.call(this.executionContext, params); }

  async synthesizeSpeech(text: string): Promise<{ audioBase64: string; audioMimeType: string } | null> { return synthesizeSpeechOperation.call(this.executionContext, text); }

  async runVoiceTurn(params: {
    userId: string;
    sessionId: string;
    turn: AgentTurnRequest;
    audioBuffer: Buffer;
    fileName: string;
    mimeType: string;
    synthesizeAudio?: boolean;
    requestId?: string;
  }): Promise<AgentVoiceTurnResponse> { return runVoiceTurnOperation.call(this.executionContext, params); }
}

export const agentOrchestratorService = new AgentOrchestratorService();

function getClientOperation(this: AgentOrchestratorServiceContext): OpenAI {
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

function getGeminiClientOperation(this: AgentOrchestratorServiceContext): GoogleGenAI {
    if (!this.geminiClient) {
      throw new AIServiceError('Gemini Agent AI is not configured.', {
        code: 'ai_not_configured',
        statusCode: 503,
        userMessage:
          process.env.NODE_ENV === 'development'
            ? 'Agent AI is not configured on the backend. Add GEMINI_API_KEY to vormex-backend/.env and restart the backend.'
            : 'Agent AI is temporarily unavailable right now.',
      });
    }

    return this.geminiClient;
  }

function mapProviderErrorOperation(this: AgentOrchestratorServiceContext, error: unknown, params: {
    route: string;
    requestId?: string;
    userId?: string;
    sessionId?: string;
    model?: string;
    provider?: string;
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
        provider: params.provider,
        model: params.model,
        status: error.status,
        code: mappedError.code,
        message: error.message,
        providerRequestId,
      });

      throw mappedError;
    }

    if (isThirdPartyHttpError(error)) {
      logger.warn({
        event: 'agent.provider.degraded',
        requestId: params.requestId,
        route: params.route,
        userId: params.userId,
        sessionId: params.sessionId,
        model: params.model,
        provider: error.provider,
        operation: error.operation,
        code: error.code,
        message: error.message,
      });

      throw new AIServiceError(error.message, {
        code: 'ai_provider_unavailable',
        statusCode: 503,
        userMessage: 'Agent AI is temporarily busy. Please try again shortly.',
      });
    }

    const rawError: any = error || {};
    const genericError = error instanceof Error ? error : new Error(String(error));
    const status = Number(rawError.status || rawError.statusCode || rawError.code);
    const retryAfterSeconds = parseRetryAfterSeconds(
      rawError.headers?.['retry-after'] || rawError.response?.headers?.['retry-after']
    );
    const isQuotaError =
      status === 429 ||
      /quota|rate limit|resource exhausted/i.test(genericError.message || '');
    const isProviderUnavailable =
      isQuotaError ||
      status === 401 ||
      status === 403 ||
      status === 408 ||
      status === 409 ||
      (Number.isFinite(status) && status >= 500);

    logger[isProviderUnavailable ? 'warn' : 'error']({
      event: 'agent.ai.request.failure',
      route: params.route,
      requestId: params.requestId,
      userId: params.userId,
      sessionId: params.sessionId,
      provider: params.provider,
      model: params.model,
      status: Number.isFinite(status) ? status : undefined,
      code: isQuotaError
        ? 'ai_provider_quota_exhausted'
        : isProviderUnavailable
          ? 'ai_provider_unavailable'
          : 'ai_internal_error',
      message: genericError.message,
      stack: genericError.stack,
    });

    throw new AIServiceError(genericError.message || 'Agent AI request failed.', {
      code: isQuotaError
        ? 'ai_provider_quota_exhausted'
        : isProviderUnavailable
          ? 'ai_provider_unavailable'
          : 'ai_internal_error',
      retryAfterSeconds,
      statusCode: isProviderUnavailable ? 503 : 500,
      userMessage: isQuotaError
        ? (
            process.env.NODE_ENV === 'development'
              ? 'Agent AI quota is exhausted on the backend Gemini project. Add billing/credits or replace GEMINI_API_KEY with a funded key, then restart vormex-backend.'
              : 'Agent AI is temporarily unavailable right now.'
          )
        : 'Agent AI is temporarily busy. Please try again shortly.',
    });
  }

async function callProviderOperation<T>(this: AgentOrchestratorServiceContext, operation: () => Promise<T>, params: {
      route: string;
      requestId?: string;
      userId?: string;
      sessionId?: string;
      model?: string;
      provider?: string;
    }): Promise<T> {
    try {
      return await executeWithCircuitBreaker(
        params.provider || 'openai',
        params.route,
        operation,
        {
          connectTimeoutMs: 5_000,
          requestTimeoutMs: this.geminiTimeoutMs,
        }
      );
    } catch (error) {
      this.mapProviderError(error, params);
    }
  }

function shouldUseFallbackModeOperation(this: AgentOrchestratorServiceContext, error: unknown): error is AIServiceError {
    return (
      error instanceof AIServiceError &&
      ['ai_provider_quota_exhausted', 'ai_provider_unavailable', 'ai_not_configured'].includes(
        error.code
      )
    );
  }

function buildFallbackPreambleOperation(this: AgentOrchestratorServiceContext, error: AIServiceError): string {
    switch (error.code) {
      case 'ai_provider_quota_exhausted':
        return 'Full AI mode is temporarily unavailable because the backend Gemini quota is exhausted. I switched to limited fallback mode.';
      case 'ai_not_configured':
        return 'Full AI mode is not configured on the backend right now. I switched to limited fallback mode.';
      default:
        return 'Full AI mode is temporarily busy right now. I switched to limited fallback mode.';
    }
  }

/** Internal execution contract; the service retains ownership of state and lifecycle. */
export interface AgentOrchestratorServiceContext {
client: OpenAI | null;
geminiClient: GoogleGenAI | null;
geminiModel: string;
geminiMaxOutputTokens: number;
geminiTimeoutMs: number;
toolDefinitions: any[];
geminiToolDeclarations: any[];
getClient(): OpenAI;
getGeminiClient(): GoogleGenAI;
mapProviderError(error: unknown, params: {
    route: string;
    requestId?: string;
    userId?: string;
    sessionId?: string;
    model?: string;
    provider?: string;
  }): never;
callProvider<T>(operation: () => Promise<T>, params: {
      route: string;
      requestId?: string;
      userId?: string;
      sessionId?: string;
      model?: string;
      provider?: string;
    }): Promise<T>;
shouldUseFallbackMode(error: unknown): error is AIServiceError;
buildFallbackPreamble(error: AIServiceError): string;
runFallbackTurn(params: {
    error: AIServiceError;
    userId: string;
    session: any;
    sessionId: string;
    inputText: string;
    surface: string;
    surfaceContext: Record<string, unknown>;
    autonomyPolicy: AgentAutonomyPolicy;
    requestId?: string;
    preferences: any;
    explicitGoalTexts: string[];
  }): Promise<AgentTurnResponse>;
buildSystemPrompt(params: {
    session: any;
    preferences: any;
    activeGoals: string[];
    surface: string;
    surfaceContext: Record<string, unknown>;
    autonomyPolicy: AgentAutonomyPolicy;
    currentUserPromptContext?: string | null;
  }): string;
runTurn(userId: string, sessionId: string, turn: AgentTurnRequest, requestId?: string): Promise<AgentTurnResponse>;
transcribeAudio(params: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  }): Promise<string>;
synthesizeSpeech(text: string): Promise<{ audioBase64: string; audioMimeType: string } | null>;
runVoiceTurn(params: {
    userId: string;
    sessionId: string;
    turn: AgentTurnRequest;
    audioBuffer: Buffer;
    fileName: string;
    mimeType: string;
    synthesizeAudio?: boolean;
    requestId?: string;
  }): Promise<AgentVoiceTurnResponse>;
}
