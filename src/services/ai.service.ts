import { createHash } from 'crypto';
import OpenAI from 'openai';
import { logger } from '../lib/logger';
import {
  AI_UNTRUSTED_INPUT_POLICY,
  wrapUntrustedPromptContent,
} from '../utils/input-security.util';

type ChatRole = 'system' | 'user' | 'assistant';
type AIReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface AIRequestMetadata {
  requestId: string;
  route: string;
  userId?: string;
}

interface ChatCompletionOptions {
  maxTokens?: number;
  metadata: AIRequestMetadata;
  reasoningEffort?: AIReasoningEffort;
  temperature?: number;
  timeoutMs?: number;
}

interface AIUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

interface AIServiceErrorOptions {
  code: string;
  providerRequestId?: string;
  retryAfterSeconds?: number;
  statusCode: number;
  userMessage: string;
}

export class AIServiceError extends Error {
  readonly code: string;
  readonly providerRequestId?: string;
  readonly retryAfterSeconds?: number;
  readonly statusCode: number;
  readonly userMessage: string;

  constructor(message: string, options: AIServiceErrorOptions) {
    super(message);
    this.name = 'AIServiceError';
    this.code = options.code;
    this.providerRequestId = options.providerRequestId;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.statusCode = options.statusCode;
    this.userMessage = options.userMessage;
  }
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

function summarizeUsage(usage: any): AIUsageSummary | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  return {
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
    reasoningTokens:
      typeof usage.output_tokens_details?.reasoning_tokens === 'number'
        ? usage.output_tokens_details.reasoning_tokens
        : undefined,
    totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
  };
}

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

class AIService {
  private readonly apiKey: string;
  private readonly client: OpenAI | null;
  private readonly defaultMaxTokens: number;
  private readonly defaultTimeoutMs: number;
  private readonly modelName: string;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || process.env.AI_API_KEY || '';
    this.client = this.apiKey
      ? new OpenAI({
          apiKey: this.apiKey,
          maxRetries: 2,
          timeout: Number(process.env.AI_TIMEOUT_MS || 20000),
        })
      : null;
    this.defaultMaxTokens = Number(process.env.AI_MAX_OUTPUT_TOKENS || 260);
    this.defaultTimeoutMs = Number(process.env.AI_TIMEOUT_MS || 20000);
    this.modelName = process.env.AI_MODEL || 'gpt-5.4-mini';

    if (!this.apiKey) {
      logger.warn({
        event: 'ai.provider.degraded',
        reason: 'missing_openai_api_key',
      });
    }
  }

  isConfigured(): boolean {
    return Boolean(this.client);
  }

  private buildSafetyIdentifier(userId?: string): string | undefined {
    if (!userId) {
      return undefined;
    }

    return createHash('sha256').update(userId).digest('hex').slice(0, 64);
  }

  async complete(messages: ChatMessage[], options: ChatCompletionOptions): Promise<string> {
    if (!this.client) {
      throw new AIServiceError('AI service is not configured.', {
        code: 'ai_not_configured',
        statusCode: 503,
        userMessage:
          process.env.NODE_ENV === 'development'
            ? 'AI is not configured on the backend. Add OPENAI_API_KEY to vormex-backend/.env and restart the backend.'
            : 'AI is temporarily unavailable right now.',
      });
    }

    const startedAt = Date.now();
    const systemMessage = messages.find((message) => message.role === 'system');
    const conversationMessages = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role,
        content: message.role === 'user'
          ? wrapUntrustedPromptContent('user_message', message.content)
          : wrapUntrustedPromptContent('assistant_message', message.content),
        type: 'message' as const,
      }));
    const reasoningEffort = options.reasoningEffort || 'none';
    const timeoutMs = options.timeoutMs || this.defaultTimeoutMs;

    logger.info({
      event: 'ai.request.start',
      requestId: options.metadata.requestId,
      route: options.metadata.route,
      userId: options.metadata.userId,
      model: this.modelName,
      reasoningEffort,
      messageCount: conversationMessages.length,
      promptChars: messages.reduce((sum, message) => sum + message.content.length, 0),
      maxTokens: options.maxTokens || this.defaultMaxTokens,
    });

    try {
      const requestBody: any = {
        input: conversationMessages,
        instructions: [AI_UNTRUSTED_INPUT_POLICY, systemMessage?.content].filter(Boolean).join('\n\n'),
        max_output_tokens: options.maxTokens || this.defaultMaxTokens,
        metadata: {
          route: options.metadata.route,
          requestId: options.metadata.requestId,
        },
        model: this.modelName,
        reasoning: {
          effort: reasoningEffort,
        },
        safety_identifier: this.buildSafetyIdentifier(options.metadata.userId),
        store: false,
      };

      if (reasoningEffort === 'none') {
        requestBody.temperature = options.temperature ?? 0.7;
      }

      const response = await this.client.responses.create(requestBody, {
        timeout: timeoutMs,
      });
      const text = extractOutputText(response);

      if (!text) {
        throw new AIServiceError('OpenAI returned an empty response.', {
          code: 'ai_empty_response',
          providerRequestId: response._request_id,
          statusCode: 503,
          userMessage: 'AI is temporarily unavailable right now.',
        });
      }

      logger.info({
        event: 'ai.request.success',
        requestId: options.metadata.requestId,
        route: options.metadata.route,
        userId: options.metadata.userId,
        model: this.modelName,
        latencyMs: Date.now() - startedAt,
        openaiRequestId: response._request_id,
        outputChars: text.length,
        usage: summarizeUsage((response as any).usage),
      });

      return text;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;

      if (error instanceof AIServiceError) {
        logger.error({
          event: 'ai.request.failure',
          requestId: options.metadata.requestId,
          route: options.metadata.route,
          userId: options.metadata.userId,
          model: this.modelName,
          latencyMs,
          code: error.code,
          message: error.message,
          providerRequestId: error.providerRequestId,
        });
        throw error;
      }

      if (error instanceof OpenAI.APIError) {
        const providerRequestId = error.requestID || error.headers?.['x-request-id'];
        const retryAfterSeconds = parseRetryAfterSeconds(error.headers?.['retry-after']);
        const isProviderUnavailable =
          error.status === 401 ||
          error.status === 403 ||
          error.status === 429 ||
          error.status === 408 ||
          error.status === 409 ||
          (typeof error.status === 'number' && error.status >= 500);

        const mappedError = new AIServiceError(error.message, {
          code: isProviderUnavailable ? 'ai_provider_unavailable' : 'ai_invalid_request',
          providerRequestId,
          retryAfterSeconds,
          statusCode: isProviderUnavailable ? 503 : 400,
          userMessage: isProviderUnavailable
            ? 'AI is temporarily busy. Please try again shortly.'
            : 'AI request failed due to invalid input.',
        });

        logger[isProviderUnavailable ? 'warn' : 'error']({
          event: isProviderUnavailable ? 'ai.provider.degraded' : 'ai.request.failure',
          requestId: options.metadata.requestId,
          route: options.metadata.route,
          userId: options.metadata.userId,
          model: this.modelName,
          latencyMs,
          status: error.status,
          code: mappedError.code,
          message: error.message,
          providerRequestId,
        });

        throw mappedError;
      }

      const genericError = error as Error;
      logger.error({
        event: 'ai.request.failure',
        requestId: options.metadata.requestId,
        route: options.metadata.route,
        userId: options.metadata.userId,
        model: this.modelName,
        latencyMs,
        code: 'ai_internal_error',
        message: genericError.message,
      });

      throw new AIServiceError(genericError.message || 'AI request failed.', {
        code: 'ai_internal_error',
        statusCode: 503,
        userMessage: 'AI is temporarily busy. Please try again shortly.',
      });
    }
  }
}

export const aiService = new AIService();
