import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { removeUserProximityPresence } from './proximity-privacy.service';

const EIGHT_HOURS_MS = 8 * 60 * 60_000;

export async function startProximitySession(input: {
  userId: string; authSessionId?: string; installId?: string; clientStartId: string; radiusM: number;
}) {
  const now = new Date();
  const existing = await prisma.proximity_sessions.findUnique({
    where: { userId_clientStartId: { userId: input.userId, clientStartId: input.clientStartId } },
  });
  if (existing) {
    if (existing.status === 'active' && existing.expiresAt <= now) {
      const expired = await prisma.proximity_sessions.update({ where: { id: existing.id },
        data: { status: 'expired', endedAt: now, endReason: 'server_timeout' } });
      return { session: expired, isNew: false };
    }
    return { session: existing, isNew: false };
  }
  const active = await prisma.proximity_sessions.findFirst({ where: { userId: input.userId, status: 'active', expiresAt: { gt: now } } });
  if (active) return { session: active, isNew: false };
  await prisma.proximity_sessions.updateMany({
    where: { userId: input.userId, status: 'active', expiresAt: { lte: now } },
    data: { status: 'expired', endedAt: now, endReason: 'server_timeout' },
  });
  const startedAt = new Date();
  try {
    const session = await prisma.proximity_sessions.create({ data: {
      userId: input.userId,
      authSessionId: input.authSessionId || null,
      deviceInstallHash: input.installId ? createHash('sha256').update(input.installId).digest('hex') : null,
      clientStartId: input.clientStartId,
      radiusM: input.radiusM,
      startedAt,
      expiresAt: new Date(startedAt.getTime() + EIGHT_HOURS_MS),
    }});
    return { session, isNew: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const won = await prisma.proximity_sessions.findFirst({ where: { userId: input.userId, status: 'active' } });
      if (won) return { session: won, isNew: false };
    }
    throw error;
  }
}

export async function getCurrentProximitySession(userId: string) {
  const now = new Date();
  await prisma.proximity_sessions.updateMany({
    where: { userId, status: 'active', expiresAt: { lte: now } },
    data: { status: 'expired', endedAt: now, endReason: 'server_timeout' },
  });
  return prisma.proximity_sessions.findFirst({ where: { userId, status: 'active', expiresAt: { gt: now } }, orderBy: { startedAt: 'desc' } });
}

export async function resumeProximitySession(userId: string, sessionId: string) {
  const session = await prisma.proximity_sessions.findFirst({ where: { id: sessionId, userId } });
  if (!session || session.status !== 'active' || session.expiresAt <= new Date()) throw new Error('PROXIMITY_SESSION_EXPIRED');
  await removeUserProximityPresence(userId);
  return prisma.proximity_sessions.update({ where: { id: sessionId }, data: { generation: { increment: 1 }, lastHeartbeatAt: null } });
}

export async function stopProximitySession(userId: string, sessionId: string, reason = 'user_stopped') {
  const session = await prisma.proximity_sessions.findFirst({ where: { id: sessionId, userId } });
  if (!session) return null;
  if (session.status === 'active') {
    await prisma.proximity_sessions.update({ where: { id: session.id }, data: {
      status: session.expiresAt <= new Date() ? 'expired' : 'stopped', endedAt: new Date(), endReason: reason,
    }});
  }
  await removeUserProximityPresence(userId);
  return prisma.proximity_sessions.findUnique({ where: { id: session.id } });
}
