import { Response } from "express";
import { getRewardCardsForUser, REWARD_CARD_ACTIONS, type RewardCardAction, REWARD_CARD_TYPES, type RewardCardType, logRewardCardEvent } from "../../services/reward-cards.service";
import { ensureString } from "../../../../shared/utils/request.util";
import { AuthRequest } from "./support.controller";

// ======================
// APP OPEN REWARD CARDS
// ======================
export const getRewardCards = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const response = await getRewardCardsForUser(String(userId));
    res.json(response);
  } catch (error) {
    console.error('getRewardCards error:', error);
    if (error instanceof Error && error.message === 'User not found') {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.status(500).json({ error: 'Failed to fetch reward cards' });
  }
};

export const postRewardEvent = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const sessionId = ensureString(req.body?.sessionId);
    const cardId = ensureString(req.body?.cardId);
    const cardTypeRaw = (ensureString(req.body?.cardType) || '').toLowerCase();
    const actionRaw = (ensureString(req.body?.action) || '').toLowerCase();

    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    if (!REWARD_CARD_ACTIONS.includes(actionRaw as RewardCardAction)) {
      res.status(400).json({ error: 'Invalid reward event action' });
      return;
    }

    const action = actionRaw as RewardCardAction;
    if (action !== 'dismissed_all') {
      if (!cardId) {
        res.status(400).json({ error: 'cardId is required for this action' });
        return;
      }
      if (!REWARD_CARD_TYPES.includes(cardTypeRaw as RewardCardType)) {
        res.status(400).json({ error: 'Invalid reward card type' });
        return;
      }
    }

    await logRewardCardEvent({
      userId: String(userId),
      sessionId,
      cardId: cardId || null,
      cardType: action === 'dismissed_all' ? null : (cardTypeRaw as RewardCardType),
      action,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('postRewardEvent error:', error);
    if (error instanceof Error && error.message.includes('required')) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to record reward event' });
  }
};
