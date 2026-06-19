export type ChatReadReceiptMessage = {
  senderId?: string | null;
  status?: string | null;
  readAt?: Date | string | null;
};

export function canViewerSeeReadReceipt(params: {
  viewerUserId: string | null | undefined;
  messageSenderId: string | null | undefined;
  viewerCanUseReadReceipts: boolean;
}): boolean {
  if (!params.viewerUserId || !params.messageSenderId) {
    return false;
  }

  return params.messageSenderId !== params.viewerUserId || params.viewerCanUseReadReceipts;
}

export function maskReadReceiptForViewer<T extends ChatReadReceiptMessage>(
  message: T,
  viewerUserId: string | null | undefined,
  viewerCanUseReadReceipts: boolean
): T {
  if (
    canViewerSeeReadReceipt({
      viewerUserId,
      messageSenderId: message.senderId,
      viewerCanUseReadReceipts,
    })
  ) {
    return message;
  }

  return {
    ...message,
    status: String(message.status || '').toUpperCase() === 'READ' ? 'SENT' : message.status,
    readAt: null,
  };
}

export function shouldNotifySenderAboutReadReceipt(params: {
  updatedCount: number;
  senderCanUseReadReceipts: boolean;
}): boolean {
  return params.updatedCount > 0 && params.senderCanUseReadReceipts;
}
