import crypto from 'crypto';
import type { Request } from 'express';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../config/prisma';
import { evaluateRateLimit } from './rate-limit.service';
import { encryptToken } from '../utils/encryption.util';

export type IdentityTrustLevel =
  | 'BASIC'
  | 'EMAIL_VERIFIED'
  | 'PHONE_VERIFIED'
  | 'STUDENT_VERIFIED'
  | 'ID_VERIFIED';

export type TrustLimitedAction =
  | 'dm'
  | 'connection_request'
  | 'post'
  | 'comment'
  | 'report'
  | 'media';

const TRUST_LEVELS: IdentityTrustLevel[] = [
  'BASIC',
  'EMAIL_VERIFIED',
  'PHONE_VERIFIED',
  'STUDENT_VERIFIED',
  'ID_VERIFIED',
];

const INSTALL_ID_HEADER = 'x-vormex-install-id';
const PLATFORM_HEADER = 'x-vormex-platform';
const INSTALL_ID_PATTERN = /^[a-zA-Z0-9._:-]{16,256}$/;
const PLATFORM_PATTERN = /^[a-z0-9_-]{2,32}$/;

const ACTION_LIMITS: Record<TrustLimitedAction, Record<IdentityTrustLevel, number>> = {
  dm: {
    BASIC: 20,
    EMAIL_VERIFIED: 40,
    PHONE_VERIFIED: 80,
    STUDENT_VERIFIED: 120,
    ID_VERIFIED: 200,
  },
  connection_request: {
    BASIC: 10,
    EMAIL_VERIFIED: 20,
    PHONE_VERIFIED: 40,
    STUDENT_VERIFIED: 60,
    ID_VERIFIED: 100,
  },
  post: {
    BASIC: 8,
    EMAIL_VERIFIED: 15,
    PHONE_VERIFIED: 30,
    STUDENT_VERIFIED: 45,
    ID_VERIFIED: 80,
  },
  comment: {
    BASIC: 30,
    EMAIL_VERIFIED: 60,
    PHONE_VERIFIED: 120,
    STUDENT_VERIFIED: 180,
    ID_VERIFIED: 300,
  },
  report: {
    BASIC: 8,
    EMAIL_VERIFIED: 12,
    PHONE_VERIFIED: 20,
    STUDENT_VERIFIED: 30,
    ID_VERIFIED: 40,
  },
  media: {
    BASIC: 15,
    EMAIL_VERIFIED: 25,
    PHONE_VERIFIED: 40,
    STUDENT_VERIFIED: 60,
    ID_VERIFIED: 90,
  },
};

const ACTION_WINDOW_SECONDS: Record<TrustLimitedAction, number> = {
  dm: 24 * 60 * 60,
  connection_request: 24 * 60 * 60,
  post: 60 * 60,
  comment: 60 * 60,
  report: 60 * 60,
  media: 10 * 60,
};

export class SafetyActionError extends Error {
  statusCode: number;
  code: string;
  retryAfterSeconds?: number;

  constructor(message: string, code: string, statusCode = 403, retryAfterSeconds?: number) {
    super(message);
    this.name = 'SafetyActionError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function db(client?: PrismaClient | any): any {
  return client || prisma;
}

function safetyPepper(): string {
  return process.env.SAFETY_HASH_PEPPER || process.env.AUTH_OTP_PEPPER || process.env.JWT_SECRET || 'vormex-dev-safety-pepper';
}

export function hashSafetyValue(value: string): string {
  return crypto.createHmac('sha256', safetyPepper()).update(value.trim().toLowerCase()).digest('hex');
}

export function normalizePhoneE164(value: string): string | null {
  const normalized = String(value || '').replace(/[^\d+]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

export function maskPhone(value: string): string {
  const last4 = value.replace(/\D/g, '').slice(-4);
  return last4 ? `•••• ${last4}` : 'Verified phone';
}

export function maskEmail(value: string): string {
  const [local, domain] = String(value || '').toLowerCase().split('@');
  if (!local || !domain) return 'verified email';
  const visible = local.length <= 2 ? local[0] || '*' : `${local[0]}${local.slice(-1)}`;
  return `${visible.padEnd(Math.min(local.length, 4), '•')}@${domain}`;
}

export function trustLevelRank(level: string | null | undefined): number {
  const index = TRUST_LEVELS.indexOf((level || 'BASIC') as IdentityTrustLevel);
  return index >= 0 ? index : 0;
}

export function chooseHigherTrustLevel(a: string | null | undefined, b: IdentityTrustLevel): IdentityTrustLevel {
  return trustLevelRank(a) >= trustLevelRank(b) ? (a as IdentityTrustLevel) : b;
}

export function verificationBadgesForTrustLevel(level: string | null | undefined): string[] {
  const rank = trustLevelRank(level);
  const badges: string[] = [];
  if (rank >= trustLevelRank('EMAIL_VERIFIED')) badges.push('email');
  if (rank >= trustLevelRank('PHONE_VERIFIED')) badges.push('phone');
  if (rank >= trustLevelRank('STUDENT_VERIFIED')) badges.push('student');
  if (rank >= trustLevelRank('ID_VERIFIED')) badges.push('id');
  return badges;
}

export function publicTrustFields(level: string | null | undefined) {
  const identityTrustLevel = (TRUST_LEVELS.includes(level as IdentityTrustLevel)
    ? level
    : 'BASIC') as IdentityTrustLevel;
  return {
    identityTrustLevel,
    verificationBadges: verificationBadgesForTrustLevel(identityTrustLevel),
  };
}

function firstHeaderValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

function deviceLinkSecret(): string {
  return (
    process.env.DEVICE_LINK_SECRET ||
    process.env.JWT_SECRET ||
    process.env.AUTH_CSRF_SECRET ||
    'vormex-dev-device-link-secret'
  );
}

export function normalizeDeviceInstallId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!INSTALL_ID_PATTERN.test(value)) return null;
  return value;
}

export function normalizeDevicePlatform(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  const value = raw.trim().toLowerCase();
  return PLATFORM_PATTERN.test(value) ? value : 'unknown';
}

function hmacDeviceValue(kind: string, value: string): string {
  return crypto
    .createHmac('sha256', deviceLinkSecret())
    .update(`${kind}:${value}`)
    .digest('hex');
}

export function hashDeviceInstallCode(installId: string, platform = 'unknown'): string {
  return hmacDeviceValue('install', `${normalizeDevicePlatform(platform)}:${installId}`);
}

function hashOptionalDeviceValue(kind: string, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  return hmacDeviceValue(kind, value.slice(0, 512));
}

export function getDeviceSignalFromRequest(req: Request): {
  installHash: string;
  platform: string;
  userAgentHash: string | null;
  ipHash: string | null;
} | null {
  const installId = normalizeDeviceInstallId(firstHeaderValue(req.headers[INSTALL_ID_HEADER]));
  if (!installId) return null;
  const platform = normalizeDevicePlatform(firstHeaderValue(req.headers[PLATFORM_HEADER]));
  return {
    installHash: hashDeviceInstallCode(installId, platform),
    platform,
    userAgentHash: hashOptionalDeviceValue('ua', firstHeaderValue(req.headers['user-agent'])),
    ipHash: hashOptionalDeviceValue('ip', req.ip || req.socket?.remoteAddress || ''),
  };
}

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

async function getUserInstallHashes(userId: string, tx?: PrismaClient | any): Promise<string[]> {
  if (!userId) return [];
  const rows = await db(tx).user_devices.findMany({
    where: { userId },
    select: { installHash: true },
    distinct: ['installHash'],
  });
  return rows.map((row: any) => row.installHash).filter(Boolean);
}

export async function createUserBlockWithDeviceScope(params: {
  blockerId: string;
  blockedId: string;
  reason?: string | null;
  tx?: PrismaClient | any;
}): Promise<{ block: any; deviceScopeCount: number }> {
  const client = db(params.tx);
  const block = await client.user_blocks.upsert({
    where: {
      blockerId_blockedId: {
        blockerId: params.blockerId,
        blockedId: params.blockedId,
      },
    },
    create: {
      blockerId: params.blockerId,
      blockedId: params.blockedId,
      reason: params.reason || null,
    },
    update: {
      reason: params.reason === undefined ? undefined : params.reason,
    },
  });

  const blockedDevices = await client.user_devices.findMany({
    where: { userId: params.blockedId },
    select: { installHash: true, platform: true },
    distinct: ['installHash'],
  });
  const uniqueDevices = Array.from(
    new Map(blockedDevices.map((device: any) => [device.installHash, device])).values()
  ).filter((device: any) => Boolean(device.installHash));

  await Promise.all(uniqueDevices.map((device: any) => (
    client.user_block_device_scopes.upsert({
      where: {
        blockId_installHash: {
          blockId: block.id,
          installHash: device.installHash,
        },
      },
      create: {
        blockId: block.id,
        blockerId: params.blockerId,
        installHash: device.installHash,
        platform: device.platform || null,
      },
      update: {
        platform: device.platform || null,
      },
    })
  )));

  return { block, deviceScopeCount: uniqueDevices.length };
}

export async function findBlockBetween(userAId: string, userBId: string) {
  const explicit = await prisma.user_blocks.findFirst({
    where: {
      OR: [
        { blockerId: userAId, blockedId: userBId },
        { blockerId: userBId, blockedId: userAId },
      ],
    },
  });
  if (explicit) return explicit;

  const [userAInstallHashes, userBInstallHashes] = await Promise.all([
    getUserInstallHashes(userAId),
    getUserInstallHashes(userBId),
  ]);
  const scopedWhere: any[] = [];
  if (userBInstallHashes.length > 0) {
    scopedWhere.push({
      blockerId: userAId,
      installHash: { in: userBInstallHashes },
    });
  }
  if (userAInstallHashes.length > 0) {
    scopedWhere.push({
      blockerId: userBId,
      installHash: { in: userAInstallHashes },
    });
  }
  if (scopedWhere.length === 0) return null;

  const scoped = await prisma.user_block_device_scopes.findFirst({
    where: { OR: scopedWhere },
    include: { block: true },
  });
  return scoped?.block || null;
}

export async function getBlockedUserIds(userId: string): Promise<string[]> {
  if (!userId) return [];
  const [rows, ownInstallHashes, outgoingDeviceScopes] = await Promise.all([
    prisma.user_blocks.findMany({
      where: {
        OR: [
          { blockerId: userId },
          { blockedId: userId },
        ],
      },
      select: {
        blockerId: true,
        blockedId: true,
      },
    }),
    getUserInstallHashes(userId),
    prisma.user_block_device_scopes.findMany({
      where: { blockerId: userId },
      select: { installHash: true },
      distinct: ['installHash'],
    }),
  ]);
  const blockedIds = new Set(rows.map((row) => (
    row.blockerId === userId ? row.blockedId : row.blockerId
  )));

  const outgoingHashes = outgoingDeviceScopes.map((row: any) => row.installHash).filter(Boolean);
  if (outgoingHashes.length > 0) {
    const linkedUsers = await prisma.user_devices.findMany({
      where: {
        installHash: { in: outgoingHashes },
        userId: { not: userId },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    linkedUsers.forEach((row: any) => blockedIds.add(row.userId));
  }

  if (ownInstallHashes.length > 0) {
    const scopedBlocksAgainstThisDevice = await prisma.user_block_device_scopes.findMany({
      where: { installHash: { in: ownInstallHashes } },
      select: { blockerId: true },
      distinct: ['blockerId'],
    });
    scopedBlocksAgainstThisDevice.forEach((row: any) => {
      if (row.blockerId !== userId) blockedIds.add(row.blockerId);
    });
  }

  return Array.from(blockedIds);
}

export async function areUsersBlocked(userAId: string, userBId: string): Promise<boolean> {
  if (!userAId || !userBId || userAId === userBId) return false;
  return Boolean(await findBlockBetween(userAId, userBId));
}

export async function assertUsersCanInteract(
  actorId: string,
  targetUserId: string,
  action: string
): Promise<void> {
  if (!actorId || !targetUserId || actorId === targetUserId) return;

  const [actor, target, block] = await Promise.all([
    prisma.user.findUnique({
      where: { id: actorId },
      select: { isBanned: true, safetyRestrictedUntil: true, safetySuspendedUntil: true },
    }),
    prisma.user.findUnique({
      where: { id: targetUserId },
      select: { isBanned: true, safetySuspendedUntil: true },
    }),
    findBlockBetween(actorId, targetUserId),
  ]);
  const now = new Date();

  if (actor?.isBanned) {
    throw new SafetyActionError('Your account is banned.', 'account_banned');
  }
  if (actor?.safetySuspendedUntil && actor.safetySuspendedUntil > now) {
    throw new SafetyActionError('Your account is temporarily suspended.', 'account_suspended');
  }
  if (actor?.safetyRestrictedUntil && actor.safetyRestrictedUntil > now) {
    throw new SafetyActionError('This action is temporarily restricted.', 'safety_restricted');
  }
  if (target?.isBanned || (target?.safetySuspendedUntil && target.safetySuspendedUntil > now)) {
    throw new SafetyActionError('This user is not available right now.', 'target_unavailable', 404);
  }
  if (block) {
    throw new SafetyActionError(`This ${action} is blocked by your safety settings.`, 'user_blocked');
  }
}

function trustLimitEnvName(action: TrustLimitedAction, level: IdentityTrustLevel): string {
  return `TRUST_LIMIT_${action.toUpperCase()}_${level}`;
}

export async function enforceTrustTierLimit(
  userId: string,
  action: TrustLimitedAction
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { identityTrustLevel: true },
  });
  const level = (user?.identityTrustLevel || 'BASIC') as IdentityTrustLevel;
  const configured = Number(process.env[trustLimitEnvName(action, level)]);
  const limit = Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : ACTION_LIMITS[action][TRUST_LEVELS.includes(level) ? level : 'BASIC'];
  const result = await evaluateRateLimit(userId, {
    keyPrefix: `rate:user:trust:${action}`,
    limit,
    windowSeconds: ACTION_WINDOW_SECONDS[action],
    code: 'trust_tier_rate_limited',
    message: 'This action is cooling down for your current trust tier.',
  });

  if (!result.allowed) {
    throw new SafetyActionError(
      'This action is cooling down for your current trust tier.',
      'trust_tier_rate_limited',
      429,
      result.retryAfterSeconds
    );
  }
}

export function safetyErrorResponse(error: unknown): {
  statusCode: number;
  body: { error: string; code: string; retryAfterSeconds?: number };
} | null {
  if (!(error instanceof SafetyActionError)) return null;
  return {
    statusCode: error.statusCode,
    body: {
      error: error.message,
      code: error.code,
      retryAfterSeconds: error.retryAfterSeconds,
    },
  };
}
