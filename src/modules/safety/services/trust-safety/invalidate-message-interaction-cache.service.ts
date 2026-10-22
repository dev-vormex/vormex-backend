import { messageInteractionMemo } from "./safety-action-error.service";

export function messageInteractionKey(actorId: string, targetUserId: string): string {
  return `${actorId}:${targetUserId}`;
}

export function invalidateMessageInteractionCache(userAId: string, userBId: string): void {
  messageInteractionMemo.delete(messageInteractionKey(userAId, userBId));
  messageInteractionMemo.delete(messageInteractionKey(userBId, userAId));
}
