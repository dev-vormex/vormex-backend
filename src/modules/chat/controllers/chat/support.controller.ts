
import { decodeKeysetCursor, encodeKeysetCursor } from "../../../../shared/utils/keyset-pagination.util";
import { Response } from "express";
import { getBlockedUserIds, assertUsersCanInteract, SafetyActionError, safetyErrorResponse, trustLevelRank, publicTrustFields } from "../../../safety/services/trust-safety.service";
import { prismaRead } from "../../../../config/prisma";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { type PremiumVisibilityState, getPremiumVisibilityByUserIds } from "../../../premium/services/premium-visibility.service";
import { getReadReceiptVisibilityCached } from "../../services/chat-message.service";
import { maskReadReceiptForViewer } from "../../services/chat-read-receipts.service";

export type ChatSyncSourceCursor = { t: string; id: string };

export type ChatSyncCursorState = {
  messages: ChatSyncSourceCursor;
  conversations: ChatSyncSourceCursor;
};

export const CHAT_SYNC_SCOPE = 'chat.sync';

export const CHAT_SYNC_PAGE_SIZE = 200;

export function parseChatSyncState(cursor: ReturnType<typeof decodeKeysetCursor>): ChatSyncCursorState | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor.id) as Partial<ChatSyncCursorState>;
    const isSourceCursor = (value: unknown): value is ChatSyncSourceCursor => {
      if (!value || typeof value !== 'object') return false;
      const candidate = value as Partial<ChatSyncSourceCursor>;
      return typeof candidate.t === 'string' && !Number.isNaN(new Date(candidate.t).getTime()) &&
        typeof candidate.id === 'string';
    };
    if (!isSourceCursor(parsed.messages) || !isSourceCursor(parsed.conversations)) return null;
    return { messages: parsed.messages, conversations: parsed.conversations };
  } catch {
    return null;
  }
}

export function encodeChatSyncState(state: ChatSyncCursorState): string {
  const latestTimestamp = [state.messages.t, state.conversations.t]
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  return encodeKeysetCursor({
    scope: CHAT_SYNC_SCOPE,
    t: latestTimestamp,
    id: JSON.stringify(state),
  });
}

export type { AuthenticatedRequest as AuthRequest } from "../../../../shared/types/authenticated-request";

export const unavailableConversationIdsForUser = async (userId: string): Promise<string[]> => {
  const blockedUserIds = await getBlockedUserIds(userId);
  if (blockedUserIds.length === 0) return [];
  const rows = await prismaRead.conversations.findMany({
    where: {
      OR: [
        { participant1Id: userId, participant2Id: { in: blockedUserIds } },
        { participant1Id: { in: blockedUserIds }, participant2Id: userId },
      ],
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
};

export const blockedPeerIdsForUser = async (userId: string): Promise<string[]> => getBlockedUserIds(userId);

export const assertConversationReadAvailable = async (
  conversation: { participant1Id: string; participant2Id: string },
  viewerId: string
): Promise<void> => {
  const peerId = conversation.participant1Id === viewerId
    ? conversation.participant2Id
    : conversation.participant1Id;
  try {
    await assertUsersCanInteract(viewerId, peerId, 'conversation');
  } catch (error) {
    if (error instanceof SafetyActionError && error.code === 'user_blocked') {
      throw new SafetyActionError('This resource is unavailable.', 'resource_unavailable', 404, undefined, false);
    }
    throw error;
  }
};

export const sendControllerError = (res: Response, error: unknown, fallback: string): void => {
  const safety = safetyErrorResponse(error);
  if (safety) {
    res.status(safety.statusCode).json(safety.body);
    return;
  }
  console.error(`${fallback}:`, error);
  res.status(500).json({ error: fallback });
};

export const userSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  isOnline: true,
  lastActiveAt: true,
  isVerified: true,
  profileBadgeStyle: true,
  identityTrustLevel: true,
};

export const uniqueTags = (tags: string[]): string[] => Array.from(new Set(tags.filter(Boolean)));

export const chatUserCacheTags = (...userIds: Array<string | null | undefined>): string[] =>
  uniqueTags(userIds.filter(Boolean).map((userId) => `chat:user:${userId}`));

export const notificationCacheTags = (...userIds: Array<string | null | undefined>): string[] =>
  uniqueTags(userIds.filter(Boolean).map((userId) => `notifications:${userId}`));

export const conversationCacheTags = (
  conversationId: string,
  ...participantIds: Array<string | null | undefined>
): string[] =>
  uniqueTags([
    `conversation:${conversationId}`,
    ...chatUserCacheTags(...participantIds),
    ...notificationCacheTags(...participantIds),
  ]);

export const messageCacheTags = (message: {
  conversationId: string;
  senderId: string;
  receiverId: string;
}): string[] => conversationCacheTags(message.conversationId, message.senderId, message.receiverId);

export const invalidateChatCaches = async (tags: string[]): Promise<void> => {
  const dedupedTags = uniqueTags(tags);
  if (dedupedTags.length === 0) {
    return;
  }

  try {
    await cacheService.invalidateTags(...dedupedTags);
  } catch (error) {
    console.error('chat cache invalidation failed:', error);
  }
};

export const buildFallbackChatUser = (userId: string) => ({
  id: userId,
  username: '',
  name: '',
  profileImage: null,
  isOnline: false,
  lastActiveAt: null,
  isVerified: false,
  profileBadgeStyle: null,
  identityTrustLevel: 'BASIC',
  verificationBadges: [],
  isPremium: false,
});

export function buildChatUserIdentity<T extends { id?: string | null; profileBadgeStyle?: string | null; identityTrustLevel?: string | null }>(
  user: T,
  premiumVisibilityByUser: Map<string, Pick<PremiumVisibilityState, 'isPremium'>>
): T & { profileBadgeStyle: string | null; isPremium: boolean; identityTrustLevel: string; verificationBadges: string[] } {
  const userId = String(user?.id || '');
  const isPremium = Boolean(userId && premiumVisibilityByUser.get(userId)?.isPremium);
  const earnedStudentBadge =
    user.profileBadgeStyle?.toLowerCase() === 'student' &&
    trustLevelRank(user.identityTrustLevel) >= trustLevelRank('STUDENT_VERIFIED');
  return {
    ...user,
    profileBadgeStyle: isPremium || earnedStudentBadge ? user.profileBadgeStyle ?? null : null,
    isPremium,
    ...publicTrustFields(user.identityTrustLevel),
  };
}

export const getChatPremiumVisibilityByUserIds = async (
  userIds: string[]
): Promise<Map<string, PremiumVisibilityState>> => {
  try {
    return await getPremiumVisibilityByUserIds(userIds);
  } catch (error) {
    console.error('chat premium visibility lookup failed:', error);
    return new Map();
  }
};

export const toIsoString = (value: unknown): string | undefined => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return undefined;
};

export type StoryMessageReference = {
  storyId: string;
  mediaUrl: string | null;
  mediaType: string | null;
  thumbnailUrl: string | null;
  textContent: string | null;
  backgroundColor: string | null;
  expiresAt: string;
};

export const parseStoryMessageReference = (value: unknown): StoryMessageReference | null => {
  if (typeof value !== 'string' || !value.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoryMessageReference>;
    if (!parsed.storyId || !parsed.expiresAt || Number.isNaN(Date.parse(parsed.expiresAt))) return null;
    return {
      storyId: parsed.storyId,
      mediaUrl: parsed.mediaUrl ?? null,
      mediaType: parsed.mediaType ?? null,
      thumbnailUrl: parsed.thumbnailUrl ?? null,
      textContent: parsed.textContent ?? null,
      backgroundColor: parsed.backgroundColor ?? null,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
};

export // Memoized in chat-message.service: this check fans out into several queries
// and runs on every conversation/messages list request.
const getReadReceiptVisibility = getReadReceiptVisibilityCached;

export const maskLastMessagePayload = (
  message: any,
  viewerUserId: string,
  viewerCanUseReadReceipts: boolean
) => {
  if (!message) return null;
  return maskReadReceiptForViewer(message, viewerUserId, viewerCanUseReadReceipts);
};

export const mapMessagePayload = (
  message: any,
  sender: any,
  reactions: { id: string; userId: string; emoji: string }[] = [],
  options: { viewerUserId?: string; viewerCanUseReadReceipts?: boolean } = {}
) => {
  const visibleMessage = maskReadReceiptForViewer(
    message,
    options.viewerUserId,
    Boolean(options.viewerCanUseReadReceipts)
  );
  const isStoryMessage = visibleMessage.contentType === 'story_reply' || visibleMessage.contentType === 'story_reaction';
  const storyMetadata = isStoryMessage ? parseStoryMessageReference(visibleMessage.fileName) : null;
  const storyReference = isStoryMessage
    ? storyMetadata
      ? {
          id: storyMetadata.storyId,
          mediaUrl: storyMetadata.mediaUrl,
          mediaType: storyMetadata.mediaType,
          thumbnailUrl: storyMetadata.thumbnailUrl,
          textContent: storyMetadata.textContent,
          backgroundColor: storyMetadata.backgroundColor,
          expiresAt: storyMetadata.expiresAt,
          available: Date.parse(storyMetadata.expiresAt) > Date.now(),
        }
      : {
          id: null,
          mediaUrl: null,
          mediaType: null,
          thumbnailUrl: null,
          textContent: null,
          backgroundColor: null,
          expiresAt: null,
          available: false,
        }
    : undefined;

  return {
    id: visibleMessage.id,
    clientMessageId: visibleMessage.clientMessageId || undefined,
    conversationId: visibleMessage.conversationId,
    senderId: visibleMessage.senderId,
    receiverId: visibleMessage.receiverId,
    content: visibleMessage.content,
    contentType: visibleMessage.contentType,
    mediaUrl: visibleMessage.mediaUrl,
    mediaType: visibleMessage.mediaType,
    fileName: visibleMessage.fileName,
    fileSize: visibleMessage.fileSize,
    status: visibleMessage.status,
    deliveredAt: toIsoString(visibleMessage.deliveredAt),
    readAt: toIsoString(visibleMessage.readAt),
    editedAt: toIsoString(visibleMessage.editedAt),
    isEdited: Boolean(visibleMessage.editedAt),
    isDeleted: visibleMessage.isDeleted,
    replyToId: visibleMessage.replyToId,
    replyTo: (visibleMessage as typeof visibleMessage & { messages: unknown }).messages,
    story: storyReference,
    sender: sender || buildFallbackChatUser(visibleMessage.senderId),
    reactions: reactions.map((reaction) => ({
      id: reaction.id,
      userId: reaction.userId,
      emoji: reaction.emoji,
      user: { id: reaction.userId, username: '', name: '' },
    })),
    createdAt: visibleMessage.createdAt.toISOString(),
    updatedAt: visibleMessage.updatedAt.toISOString(),
  };
};

export const getChatUserLookup = async (userIds: string[]): Promise<Map<string, any>> => {
  const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
  if (uniqueUserIds.length === 0) {
    return new Map();
  }

  const users = await prismaRead.user.findMany({
    where: { id: { in: uniqueUserIds } },
    select: userSelect,
  });
  const premiumVisibilityByUser = await getChatPremiumVisibilityByUserIds(uniqueUserIds);

  return new Map(
    users.map((user) => [
      user.id,
      buildChatUserIdentity(user, premiumVisibilityByUser),
    ])
  );
};
