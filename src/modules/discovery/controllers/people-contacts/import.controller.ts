import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { hashEmail, normalizeEmail } from "../../../../shared/utils/email-hash.util";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { evaluateDiscoveryCandidate } from "../../../safety/services/safety-policy";
import { PeopleYouKnowResponse, ContactImportItem, ensureUserEmailHashes, MATCH_STATUS_MATCHED, MATCH_STATUS_UNMATCHED, buildPeopleYouKnowResponse } from "./support.controller";

export const importPeopleYouKnow = async (
  req: AuthenticatedRequest,
  res: Response<PeopleYouKnowResponse | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const source =
      typeof req.body?.source === 'string' && req.body.source.trim()
        ? req.body.source.trim().toLowerCase()
        : 'picker';
    const contacts: ContactImportItem[] = Array.isArray(req.body?.contacts)
      ? req.body.contacts
      : [];

    if (contacts.length === 0) {
      res.status(400).json({ error: 'No people to discover were provided' });
      return;
    }

    await ensureUserEmailHashes();

    const currentUser = await prisma.user.findUnique({
      where: { id: currentUserId },
      select: { email: true, emailHash: true },
    });

    if (!currentUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const currentUserEmailHash =
      currentUser.emailHash ?? hashEmail(currentUser.email);

    if (!currentUser.emailHash && currentUserEmailHash) {
      await prisma.user.update({
        where: { id: currentUserId },
        data: { emailHash: currentUserEmailHash },
      });
    }

    const entriesByEmailHash = new Map<
      string,
      { contactName: string | null; emailHash: string }
    >();

    for (const contact of contacts) {
      const normalizedEmail = normalizeEmail(contact.email);
      if (!normalizedEmail) continue;

      const emailHash = hashEmail(normalizedEmail);
      if (!emailHash || emailHash === currentUserEmailHash) continue;

      const trimmedName =
        typeof contact.name === 'string' && contact.name.trim()
          ? contact.name.trim()
          : null;

      const existing = entriesByEmailHash.get(emailHash);
      if (!existing || (!existing.contactName && trimmedName)) {
        entriesByEmailHash.set(emailHash, {
          contactName: trimmedName,
          emailHash,
        });
      }
    }

    if (entriesByEmailHash.size === 0) {
      res.status(400).json({ error: 'No valid people were found to discover' });
      return;
    }

    const existingUsers = await prisma.user.findMany({
      where: {
        emailHash: { in: Array.from(entriesByEmailHash.keys()) },
      },
      select: {
        id: true,
        emailHash: true,
        isBanned: true,
        safetySuspendedUntil: true,
      },
    });

    // Sync-time policy: existing accounts that are self, banned, suspended or
    // blocked are neither matched nor turned into invites (they do have an account).
    const blockedUserIds = await getBlockedUserIds(currentUserId);
    const discoveredUsers = existingUsers.filter((user) =>
      evaluateDiscoveryCandidate({
        viewerId: currentUserId,
        candidateId: user.id,
        candidate: user,
        blockedUserIds,
      }).allowed
    );
    for (const user of existingUsers) {
      if (user.emailHash && !discoveredUsers.includes(user)) {
        entriesByEmailHash.delete(user.emailHash);
      }
    }

    if (entriesByEmailHash.size === 0) {
      res.status(400).json({ error: 'No valid people were found to discover' });
      return;
    }

    const matchedUserIdByHash = new Map(
      discoveredUsers
        .filter((user) => Boolean(user.emailHash))
        .map((user) => [user.emailHash as string, user.id])
    );

    const sync = await prisma.contactSync.upsert({
      where: { userId: currentUserId },
      create: {
        userId: currentUserId,
        lastSyncedAt: new Date(),
        status: 'ready',
      },
      update: {
        lastSyncedAt: new Date(),
        status: 'ready',
      },
      select: { id: true },
    });

    await prisma.contactSyncEntry.deleteMany({
      where: { syncId: sync.id },
    });

    const entries = Array.from(entriesByEmailHash.values()).map((entry) => {
      const matchedUserId = matchedUserIdByHash.get(entry.emailHash) ?? null;
      return {
        syncId: sync.id,
        contactName: entry.contactName,
        emailHash: entry.emailHash,
        matchStatus: matchedUserId ? MATCH_STATUS_MATCHED : MATCH_STATUS_UNMATCHED,
        matchedUserId,
        source,
      };
    });

    await prisma.contactSyncEntry.createMany({
      data: entries,
    });

    const matchedCount = entries.filter(
      (entry) => entry.matchStatus === MATCH_STATUS_MATCHED
    ).length;
    const inviteCount = entries.length - matchedCount;

    const updatedSync = await prisma.contactSync.update({
      where: { id: sync.id },
      data: {
        lastSyncedAt: new Date(),
        matchedCount,
        inviteCount,
        totalCount: entries.length,
        status: 'ready',
      },
      select: {
        id: true,
        lastSyncedAt: true,
        totalCount: true,
        matchedCount: true,
        inviteCount: true,
      },
    });

    const response = await buildPeopleYouKnowResponse(currentUserId, updatedSync);
    res.status(200).json(response);
  } catch (error) {
    console.error('Error importing people you know:', error);
    res.status(500).json({ error: 'Failed to discover people you know' });
  }
};

export const clearPeopleYouKnow = async (
  req: AuthenticatedRequest,
  res: Response<{ message: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const existingSync = await prisma.contactSync.findUnique({
      where: { userId: currentUserId },
      select: { id: true },
    });

    if (existingSync) {
      await prisma.contactSync.delete({
        where: { userId: currentUserId },
      });
    }

    res.status(200).json({ message: 'People you know list cleared' });
  } catch (error) {
    console.error('Error clearing people you know:', error);
    res.status(500).json({ error: 'Failed to clear people you know' });
  }
};

export const markPeopleYouKnowInviteSent = async (
  req: AuthenticatedRequest,
  res: Response<{ invitedAt: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const entryId = String(req.params.entryId);

    const entry = await prisma.contactSyncEntry.findFirst({
      where: {
        id: entryId,
        sync: {
          userId: currentUserId,
        },
      },
      select: {
        id: true,
        invitedAt: true,
      },
    });

    if (!entry) {
      res.status(404).json({ error: 'Invite not found' });
      return;
    }

    const invitedAt = entry.invitedAt ?? new Date();
    const updatedEntry = await prisma.contactSyncEntry.update({
      where: { id: entry.id },
      data: { invitedAt },
      select: { invitedAt: true },
    });

    res.status(200).json({
      invitedAt: updatedEntry.invitedAt!.toISOString(),
    });
  } catch (error) {
    console.error('Error marking people you know invite:', error);
    res.status(500).json({ error: 'Failed to update invite state' });
  }
};
