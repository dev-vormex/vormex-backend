import { randomUUID } from 'crypto';
import { prisma } from '../../../config/prisma';
export async function getOrCreateConversationForUsers(userId: string, otherUserId: string) {
  let conversation = await prisma.conversations.findFirst({
    where: {
      OR: [
        { participant1Id: userId, participant2Id: otherUserId },
        { participant1Id: otherUserId, participant2Id: userId },
      ],
    },
  });

  if (!conversation) {
    conversation = await prisma.conversations.create({
      data: {
        id: randomUUID(),
        participant1Id: userId,
        participant2Id: otherUserId,
      },
    });
  }

  return conversation;
}

