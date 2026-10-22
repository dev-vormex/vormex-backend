import type { Request } from "express";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../../../config/prisma";
import { encryptToken } from "../../../../infrastructure/security/encryption.util";
import { getDeviceSignalFromRequest, db, chooseHigherTrustLevel, identityTrustLevelMemo, IdentityTrustLevel, hashSafetyValue, SafetyActionError, maskPhone, maskEmail } from "./safety-action-error.service";
import { invalidateMessageInteractionCache } from "./invalidate-message-interaction-cache.service";

export async function recordUserDeviceFromRequest(
  req: Request,
  userId: string | number,
  options: { lastLogin?: boolean } = { lastLogin: true }
): Promise<void> {
  const signal = getDeviceSignalFromRequest(req);
  if (!signal) return;

  const now = new Date();
  const normalizedUserId = String(userId);
  await prisma.user_devices.upsert({
    where: {
      userId_installHash: {
        userId: normalizedUserId,
        installHash: signal.installHash,
      },
    },
    create: {
      userId: normalizedUserId,
      installHash: signal.installHash,
      platform: signal.platform,
      userAgentHash: signal.userAgentHash,
      ipHash: signal.ipHash,
      firstSeenAt: now,
      lastSeenAt: now,
      lastLoginAt: options.lastLogin === false ? null : now,
    },
    update: {
      platform: signal.platform,
      userAgentHash: signal.userAgentHash,
      ipHash: signal.ipHash,
      lastSeenAt: now,
      ...(options.lastLogin === false ? {} : { lastLoginAt: now }),
    },
  });

  const existingBlocks = await prisma.user_blocks.findMany({
    where: { blockedId: normalizedUserId },
    select: { id: true, blockerId: true },
  });

  await Promise.all(
    existingBlocks.map((block) =>
      prisma.user_block_device_scopes.upsert({
        where: {
          blockId_installHash: {
            blockId: block.id,
            installHash: signal.installHash,
          },
        },
        create: {
          blockId: block.id,
          blockerId: block.blockerId,
          installHash: signal.installHash,
          platform: signal.platform,
        },
        update: {
          platform: signal.platform,
        },
      })
    )
  );
  existingBlocks.forEach((block) => {
    invalidateMessageInteractionCache(block.blockerId, normalizedUserId);
  });
}

export async function recordSafetyEvent(params: {
  actorId?: string | null;
  targetUserId?: string | null;
  eventType: string;
  entityType?: string | null;
  entityId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  tx?: PrismaClient | any;
}): Promise<void> {
  try {
    await db(params.tx).safety_events.create({
      data: {
        actorId: params.actorId || null,
        targetUserId: params.targetUserId || null,
        eventType: params.eventType,
        entityType: params.entityType || null,
        entityId: params.entityId || null,
        reason: params.reason || null,
        metadata: params.metadata || undefined,
      },
    });
  } catch (error) {
    console.error('recordSafetyEvent failed:', error);
  }
}

export async function recomputeIdentityTrustLevel(userId: string, tx?: PrismaClient | any): Promise<IdentityTrustLevel> {
  const client = db(tx);
  const [user, verifications] = await Promise.all([
    client.user.findUnique({
      where: { id: userId },
      select: { isVerified: true, phoneVerifiedAt: true },
    }),
    client.identity_verifications.findMany({
      where: { userId, status: 'VERIFIED' },
      select: { type: true },
    }),
  ]);

  let level: IdentityTrustLevel = 'BASIC';
  if (user?.isVerified) level = 'EMAIL_VERIFIED';
  if (user?.phoneVerifiedAt) level = chooseHigherTrustLevel(level, 'PHONE_VERIFIED');
  if (verifications.some((item: { type: string }) => item.type === 'STUDENT_EMAIL')) {
    level = chooseHigherTrustLevel(level, 'STUDENT_VERIFIED');
  }
  if (verifications.some((item: { type: string }) => item.type === 'ID_DOCUMENT')) {
    level = chooseHigherTrustLevel(level, 'ID_VERIFIED');
  }

  await client.user.update({
    where: { id: userId },
    data: { identityTrustLevel: level },
  });
  identityTrustLevelMemo.delete(userId);
  return level;
}

export async function setVerifiedPhone(userId: string, phoneE164: string): Promise<void> {
  const phoneHash = hashSafetyValue(`phone:${phoneE164}`);
  const phoneLast4 = phoneE164.replace(/\D/g, '').slice(-4);
  const existing = await prisma.user.findFirst({
    where: { phoneHash, id: { not: userId } },
    select: { id: true },
  });
  if (existing) {
    throw new SafetyActionError('This phone number is already linked to another account.', 'phone_already_verified', 409);
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        phoneEncrypted: encryptToken(phoneE164),
        phoneHash,
        phoneLast4,
        phoneVerifiedAt: new Date(),
      },
    });
    await tx.identity_verifications.create({
      data: {
        userId,
        type: 'PHONE',
        status: 'VERIFIED',
        valueHash: phoneHash,
        valueMasked: maskPhone(phoneE164),
        verifiedAt: new Date(),
      },
    });
    await recordSafetyEvent({
      actorId: userId,
      targetUserId: userId,
      eventType: 'IDENTITY_PHONE_VERIFIED',
      entityType: 'identity_verification',
      reason: 'Firebase phone token verified',
      tx,
    });
    await recomputeIdentityTrustLevel(userId, tx);
  });
}

export async function getIdentitySummary(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      isVerified: true,
      phoneLast4: true,
      phoneVerifiedAt: true,
      identityTrustLevel: true,
      safetyRestrictedUntil: true,
      safetyRestrictionReason: true,
      safetySuspendedUntil: true,
    },
  });
  if (!user) return null;

  const verifications = await prisma.identity_verifications.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      type: true,
      status: true,
      valueMasked: true,
      requestedAt: true,
      verifiedAt: true,
      expiresAt: true,
      reviewedById: true,
      evidenceDeletedAt: true,
      evidenceFileName: true,
      evidenceMimeType: true,
      evidenceSize: true,
      evidenceStorageKey: true,
      rejectionReason: true,
      reviewNotes: true,
      createdAt: true,
      updatedAt: true,
    },
  }).catch(async () => prisma.identity_verifications.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  }));

  return {
    trustLevel: user.identityTrustLevel,
    email: {
      verified: Boolean(user.isVerified),
      masked: maskEmail(user.email),
    },
    phone: {
      verified: Boolean(user.phoneVerifiedAt),
      masked: user.phoneLast4 ? `•••• ${user.phoneLast4}` : null,
      verifiedAt: user.phoneVerifiedAt?.toISOString?.() || null,
    },
    safety: {
      restrictedUntil: user.safetyRestrictedUntil?.toISOString?.() || null,
      restrictionReason: user.safetyRestrictionReason || null,
      suspendedUntil: user.safetySuspendedUntil?.toISOString?.() || null,
    },
    verifications: verifications.map((verification: any) => ({
      id: verification.id,
      type: verification.type,
      status: verification.status,
      valueMasked: verification.valueMasked,
      requestedAt: verification.requestedAt?.toISOString?.() || verification.requestedAt,
      verifiedAt: verification.verifiedAt?.toISOString?.() || null,
      expiresAt: verification.expiresAt?.toISOString?.() || null,
      reviewedById: verification.reviewedById || null,
      evidenceDeletedAt: verification.evidenceDeletedAt?.toISOString?.() || null,
      evidenceFileName: verification.evidenceFileName || null,
      evidenceMimeType: verification.evidenceMimeType || null,
      evidenceSize: verification.evidenceSize || null,
      evidenceHasFile: Boolean(verification.evidenceStorageKey && verification.evidenceFileName && !verification.evidenceDeletedAt),
      rejectionReason: verification.rejectionReason || null,
      reviewNotes: verification.reviewNotes || null,
      createdAt: verification.createdAt?.toISOString?.() || verification.createdAt,
      updatedAt: verification.updatedAt?.toISOString?.() || verification.updatedAt,
    })),
  };
}

export async function getUserInstallHashes(userId: string, tx?: PrismaClient | any): Promise<string[]> {
  if (!userId) return [];
  const rows = await db(tx).user_devices.findMany({
    where: { userId },
    select: { installHash: true },
    distinct: ['installHash'],
  });
  return rows.map((row: any) => row.installHash).filter(Boolean);
}
