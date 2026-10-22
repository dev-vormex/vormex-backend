import { pushNotificationService } from "../push-notification.service";
import { NotificationService } from "./service.service";

export async function notifyIdentityVerificationApprovedOperation(this: NotificationService, userId: string, verificationId: string, trustLevel: string): Promise<void> {
    const title = 'Student verification approved';
    const body = 'Your Vormex student verification is successful. Claim your green student badge from Vormex.';

    await this.createNotification({
      userId,
      type: 'identity_verification_approved',
      title,
      body,
      data: {
        branding: 'vormex',
        senderType: 'vormex',
        verificationId,
        trustLevel,
        badge: 'verified',
      },
    });
    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'identity_verification_approved',
        branding: 'vormex',
        senderType: 'vormex',
        verificationId,
        trustLevel,
        badge: 'verified',
      },
    }).catch(() => undefined);
  }

export async function notifyIdentityVerificationResubmitRequestedOperation(this: NotificationService, userId: string, verificationId: string, reason: string): Promise<void> {
    const title = 'Student verification needs resubmission';
    const body = reason
      ? `Vormex could not verify this submission. Comment: ${reason}`
      : 'Vormex could not verify this submission. Please resubmit your proof.';

    await this.createNotification({
      userId,
      type: 'identity_verification_resubmit_requested',
      title,
      body,
      data: {
        branding: 'vormex',
        senderType: 'vormex',
        verificationId,
        reason,
      },
    });
    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'identity_verification_resubmit_requested',
        branding: 'vormex',
        senderType: 'vormex',
        verificationId,
        reason,
      },
    }).catch(() => undefined);
  }
