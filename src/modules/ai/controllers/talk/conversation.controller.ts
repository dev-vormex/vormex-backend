import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { getRequestId, getRequestLogger } from "../../../../infrastructure/logging/logger";
import { randomUUID } from "crypto";
import { TalkTurnResponse, normalizeText, sanitizeHistory, getCurrentUserContext, TalkMode, getAIResponse, fallbackAnswer, fallbackFollowUps } from "./support.controller";
import { shouldSearchPeople, extractSearchTerms, findRecommendedPeople } from "./people-search.controller";

export const runTalkTurn = async (
  req: AuthenticatedRequest,
  res: Response<TalkTurnResponse | ErrorResponse>
): Promise<void> => {
  const requestId = getRequestId(req) || randomUUID();
  const log = getRequestLogger(req);
  const userId = req.user?.userId ? String(req.user.userId) : null;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const message = normalizeText(req.body?.message, 1200);
  if (!message) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  try {
    const history = sanitizeHistory(req.body?.history);
    const currentUser = await getCurrentUserContext(userId);
    const mode: TalkMode = shouldSearchPeople(message) ? 'people_discovery' : 'general';
    const terms = extractSearchTerms(message);
    const people = mode === 'people_discovery'
      ? await findRecommendedPeople(userId, terms, currentUser)
      : [];

    let aiAnswer: {
      answer: string;
      followUpQuestions: string[];
      peopleReasonsById?: Map<string, string>;
      peopleTitle?: string;
    };

    try {
      aiAnswer = await getAIResponse({
        currentUser,
        history,
        message,
        mode,
        people,
        requestId,
        terms,
        userId,
      });
    } catch (error) {
      const fallbackError = error as Error;
      log.warn({
        event: 'talk.ai.fallback',
        requestId,
        userId,
        message: fallbackError.message,
      });
      aiAnswer = {
        answer: fallbackAnswer(message, mode, people, terms),
        followUpQuestions: fallbackFollowUps(mode, people.length > 0),
      };
    }

    const followUpQuestions = aiAnswer.followUpQuestions.length > 0
      ? aiAnswer.followUpQuestions.slice(0, 3)
      : fallbackFollowUps(mode, people.length > 0);
    const peopleWithConnectReasons = people.map((person) => ({
      ...person,
      connectReason: aiAnswer.peopleReasonsById?.get(person.id) || person.connectReason,
    }));

    res.status(200).json({
      answer: aiAnswer.answer,
      costMode: 'retrieval_first',
      followUpQuestions,
      mode,
      people: peopleWithConnectReasons,
      peopleTitle: aiAnswer.peopleTitle || (peopleWithConnectReasons.length > 0 ? 'Recommended people' : undefined),
    });
  } catch (error) {
    const err = error as Error;
    log.error({
      event: 'talk.turn.failure',
      requestId,
      userId,
      message: err.message,
    });
    res.status(500).json({ error: 'Talk with Vormex is unavailable right now' });
  }
};
