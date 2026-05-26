// @ts-nocheck
import { prisma } from '../config/prisma';
import { notificationService } from './notification.service';

const DIGEST_WINDOW_DAYS = 7;
const MAX_DIGEST_RECIPIENTS = 500;

export async function runHackathonWeeklyDigest(): Promise<{ count: number; sent: number }> {
  const since = new Date(Date.now() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const hackathons = await prisma.hackathons.findMany({
    where: {
      isActive: true,
      createdAt: { gte: since },
      endsAt: { gte: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      skills: true,
      college: true,
    },
    take: 20,
  });

  if (hackathons.length === 0) {
    return { count: 0, sent: 0 };
  }

  const skillHints = Array.from(new Set(hackathons.flatMap((hackathon) => hackathon.skills || []))).slice(0, 20);
  const collegeHints = Array.from(new Set(hackathons.map((hackathon) => hackathon.college).filter(Boolean))).slice(0, 20);
  const recipientOrClauses: any[] = [];
  if (skillHints.length > 0) {
    recipientOrClauses.push(
      {
        skills: {
          some: {
            skill: {
              OR: skillHints.map((skill) => ({
                name: { equals: skill, mode: 'insensitive' },
              })),
            },
          },
        },
      },
      { interests: { hasSome: skillHints } }
    );
  }
  if (collegeHints.length > 0) {
    recipientOrClauses.push({ college: { in: collegeHints } });
  }

  const recipients = await prisma.user.findMany({
    where: {
      isBanned: false,
      ...(recipientOrClauses.length > 0 ? { OR: recipientOrClauses } : {}),
    },
    select: { id: true },
    take: MAX_DIGEST_RECIPIENTS,
  });

  let sent = 0;
  const sampleTitles = hackathons.slice(0, 3).map((hackathon) => hackathon.title);
  for (const recipient of recipients) {
    try {
      await notificationService.notifyHackathonWeeklyDigest(recipient.id, hackathons.length, sampleTitles);
      sent += 1;
    } catch {
      continue;
    }
  }

  return { count: hackathons.length, sent };
}
