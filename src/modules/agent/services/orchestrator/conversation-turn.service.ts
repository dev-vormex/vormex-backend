import { FunctionCallingConfigMode } from "@google/genai";
import { AIServiceError } from "../../../ai/services/ai.service";
import { getPremiumAccessSnapshot } from "../../../premium/services/premium-access.service";
import { wrapUntrustedPromptContent } from "../../../../shared/utils/input-security.util";
import { agentSessionService } from "../session.service";
import { evaluateAgentUserInputSafety } from "../safety.service";
import { executeAgentTool, getAgentCurrentUserContext } from "../../utils/tools";
import { pendingActionsService } from "../pending-actions.service";
import { agentGoalsService } from "../goals.service";
import { mergeSessionMetadataWithInlineResults } from "../../utils/inline-results";
import { describeNavigationPreview, resolveAgentSurfaceFromUiIntents } from "../../utils/surface-utils";
import { emitAgentEvent, serializeAgentAction, serializeGoal, serializePendingAction } from "../../utils/socket-events";
import { AgentActionRecord, AgentTurnRequest, AgentTurnResponse, AgentUiIntent } from "../../types";
import { getAgentToolPolicy, resolveAgentAutonomyPolicy } from "../action-policy.service";
import { redactAgentPayload } from "../../utils/data-safety";
import { buildMemorySummary, buildSessionStateWithPolicy, extractLikelyGoals, mergeGoals, extractGeminiOutputText, dedupeUiIntents } from "./provider-helpers.util";
import type { AgentOrchestratorServiceContext } from "./orchestrator-context.service";

export async function runTurnOperation(this: AgentOrchestratorServiceContext, userId: string, sessionId: string, turn: AgentTurnRequest, requestId?: string): Promise<AgentTurnResponse> {
    const session = await agentSessionService.requireSession(sessionId, userId);
    const inputText = String(turn.inputText || '').trim();
    const surface = String(turn.surface || session.currentSurface || 'global');
    const surfaceContext =
      turn.surfaceContext && typeof turn.surfaceContext === 'object' ? turn.surfaceContext : {};
    const accessSnapshot = await getPremiumAccessSnapshot(userId);
    const autonomyPolicy = resolveAgentAutonomyPolicy({
      requestedAutonomyMode: turn.autonomyMode,
      allowAutonomousActions: turn.allowAutonomousActions,
      fallbackMode: session.allowAutonomousActions ? 'power' : 'approval',
      isPremium: accessSnapshot.isPremium,
    });
    const allowAutonomousActions = autonomyPolicy.allowAutonomousActions;

    await agentSessionService.appendMessage({
      sessionId,
      userId,
      role: 'user',
      content: inputText,
      metadata: {
        surface,
        surfaceContext,
        allowAutonomousActions,
        requestedAutonomyMode: autonomyPolicy.requestedAutonomyMode,
        effectiveAutonomyMode: autonomyPolicy.effectiveAutonomyMode,
        powerModeEligible: autonomyPolicy.powerModeEligible,
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
      const sessionStateWithPolicy = buildSessionStateWithPolicy(sessionState, autonomyPolicy);

      await agentSessionService.upsertUserPreferences(userId, {
        goals: extractLikelyGoals(inputText, explicitGoalTexts),
        memorySummary: sessionStateWithPolicy.memorySummary || null,
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
        memorySummary: sessionStateWithPolicy.memorySummary,
        sessionState: sessionStateWithPolicy,
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
    const providerName = 'gemini';
    const model = this.geminiModel;

    const executedActions: AgentActionRecord[] = [];
    const suggestedActions: AgentActionRecord[] = [];
    const blockedActions: AgentActionRecord[] = [];
    const uiIntents: AgentUiIntent[] = [];

    let response;
    try {
      const gemini = this.getGeminiClient();
      const systemInstruction = this.buildSystemPrompt({
        session,
        preferences,
        activeGoals,
        surface,
        surfaceContext,
        autonomyPolicy,
        currentUserPromptContext: currentUserContext?.promptContext,
      });
      const geminiConfig = {
        systemInstruction,
        temperature: 0.35,
        maxOutputTokens: this.geminiMaxOutputTokens,
        httpOptions: {
          timeout: this.geminiTimeoutMs,
        },
        tools:
          this.geminiToolDeclarations.length > 0
            ? [
                {
                  functionDeclarations: this.geminiToolDeclarations,
                },
              ]
            : undefined,
        toolConfig:
          this.geminiToolDeclarations.length > 0
            ? {
                functionCallingConfig: {
                  mode: FunctionCallingConfigMode.AUTO,
                },
              }
            : undefined,
      } as any;
      const contents: any[] = [
        {
          role: 'user',
          parts: [
            {
              text: wrapUntrustedPromptContent('agent_user_message', inputText),
            },
          ],
        },
      ];

      response = await this.callProvider(
        () =>
          gemini.models.generateContent({
            model,
            contents,
            config: geminiConfig,
          } as any),
        {
          route: 'agent-turn',
          requestId,
          userId,
          sessionId,
          provider: providerName,
          model,
        }
      );

      if (!response) {
        throw new AIServiceError('Agent AI did not return a response.', {
          code: 'ai_provider_unavailable',
          statusCode: 503,
          userMessage: 'Agent AI is temporarily busy. Please try again shortly.',
        });
      }

      for (let iteration = 0; iteration < 6; iteration++) {
        const functionCalls: any[] = Array.isArray(response.functionCalls)
          ? response.functionCalls.filter((item: any) => item?.name)
          : [];

        if (functionCalls.length === 0) {
          break;
        }

        const modelContent = response.candidates?.[0]?.content;
        if (modelContent) {
          contents.push(modelContent);
        }

        const toolResponseParts = [];
        for (const call of functionCalls) {
          const callName = String(call.name || '');
          const parsedArgs: Record<string, unknown> =
            call.args && typeof call.args === 'object' && !Array.isArray(call.args)
              ? call.args
              : {};

          let toolResult = await executeAgentTool(callName, parsedArgs, {
            userId,
            sessionId,
            surface,
            surfaceContext,
            allowAutonomousActions,
            autonomyMode: autonomyPolicy.effectiveAutonomyMode,
            requestedAutonomyMode: autonomyPolicy.requestedAutonomyMode,
            effectiveAutonomyMode: autonomyPolicy.effectiveAutonomyMode,
            powerModeEligible: autonomyPolicy.powerModeEligible,
            isPremium: autonomyPolicy.isPremium,
          });

          if (
            toolResult.suggestedAction &&
            (toolResult.output?.status === 'approval_required' ||
              toolResult.output?.status === 'suggested' ||
              toolResult.output?.reason === 'autonomous_actions_disabled')
          ) {
            const toolPolicy = getAgentToolPolicy(callName);
            const pendingAction = await pendingActionsService.createPending({
              sessionId,
              userId,
              toolName: callName,
              actionType: toolResult.suggestedAction.type,
              title: toolResult.suggestedAction.title,
              summary: toolResult.suggestedAction.summary,
              input: parsedArgs,
              context: {
                surface,
                surfaceContext,
                uiIntents: toolResult.uiIntents || [],
                riskLevel: toolPolicy.riskLevel,
                autonomyMode: autonomyPolicy.effectiveAutonomyMode,
                requestedAutonomyMode: autonomyPolicy.requestedAutonomyMode,
                powerModeEligible: autonomyPolicy.powerModeEligible,
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
                autonomyMode: autonomyPolicy.effectiveAutonomyMode,
              },
              suggestedAction: {
                ...toolResult.suggestedAction,
                pendingActionId: pendingAction.id,
                riskLevel: toolPolicy.riskLevel,
                autonomyMode: autonomyPolicy.effectiveAutonomyMode,
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

          toolResponseParts.push({
            functionResponse: {
              id: call.id,
              name: callName,
              response: {
                output: redactAgentPayload(toolResult.output) as Record<string, unknown>,
              },
            },
          });
        }

        contents.push({
          role: 'user',
          parts: toolResponseParts,
        });

        response = await this.callProvider(
          () =>
            gemini.models.generateContent({
              model,
              contents,
              config: geminiConfig,
            } as any),
          {
            route: 'agent-turn-tools',
            requestId,
            userId,
            sessionId,
            provider: providerName,
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
          autonomyPolicy,
          requestId,
          preferences,
          explicitGoalTexts,
        });
      }
      throw error;
    }

    const assistantMessage =
      extractGeminiOutputText(response) ||
      (executedActions.length > 0
        ? executedActions.map((action) => action.summary).join(' ')
        : 'I’m ready to help with the next step.');

    await agentSessionService.appendMessage({
      sessionId,
      userId,
      role: 'assistant',
      content: assistantMessage,
      metadata: {
        provider: providerName,
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
      {
        ...(session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
          ? (session.metadata as Record<string, unknown>)
          : {}),
        lastAiProvider: providerName,
        lastAiModel: model,
      },
      dedupedUiIntents
    );

    const sessionState = await agentSessionService.updateSession(sessionId, {
      currentSurface: resolvedSurface,
      lastResponseId: response?.responseId || undefined,
      memorySummary,
      metadata: sessionMetadata,
      allowAutonomousActions,
      title: session.title || inputText.slice(0, 72),
    });
    const sessionStateWithPolicy = buildSessionStateWithPolicy(sessionState, autonomyPolicy);

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
      sessionState: sessionStateWithPolicy,
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
        sessionState: sessionStateWithPolicy,
      },
      sessionId
    );

    return turnResponse;
  }
