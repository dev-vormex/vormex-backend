import { prismaRead } from '../config/prisma';
import { TtlMemo } from '../infrastructure/cache/ttl-memo';

export type ConversationParticipants = {
  participant1Id: string;
  participant2Id: string;
};

// DM participants are immutable for a conversation's lifetime, so a generous
// TTL is safe. Deletions are covered by invalidateConversationParticipants and
// by FK integrity on write paths.
const PARTICIPANTS_TTL_MS = 5 * 60 * 1000;
const participantsMemo = new TtlMemo<ConversationParticipants | null>(PARTICIPANTS_TTL_MS, 20000);

export async function getConversationParticipants(
  conversationId: string
): Promise<ConversationParticipants | null> {
  if (!conversationId) {
    return null;
  }

  const participants = await participantsMemo.get(conversationId, async () => {
    const conversation = await prismaRead.conversations.findUnique({
      where: { id: conversationId },
      select: { participant1Id: true, participant2Id: true },
    });
    return conversation ?? null;
  });

  // Never cache "missing" — a conversation created milliseconds ago must be
  // visible to the very next send/typing event.
  if (!participants) {
    participantsMemo.delete(conversationId);
  }

  return participants;
}

/**
 * Membership check + peer resolution in one cached lookup. Returns null when
 * the conversation doesn't exist or the user is not a participant.
 */
export async function getConversationPeerIdCached(
  conversationId: string,
  userId: string
): Promise<string | null> {
  if (!conversationId || !userId) {
    return null;
  }

  const participants = await getConversationParticipants(conversationId);
  if (!participants) {
    return null;
  }
  if (participants.participant1Id === userId) {
    return participants.participant2Id;
  }
  if (participants.participant2Id === userId) {
    return participants.participant1Id;
  }
  return null;
}

export function invalidateConversationParticipants(conversationId: string): void {
  participantsMemo.delete(conversationId);
}
