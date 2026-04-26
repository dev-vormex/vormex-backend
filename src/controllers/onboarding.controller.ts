// @ts-nocheck
import { Response } from 'express';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prisma } from '../config/prisma';
import { queueMatchAvailabilityNotifications } from '../services/match-availability-notification.service';

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0)
    )
  ).sort();
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

type OnboardingData = {
  primaryGoal?: string | null;
  secondaryGoals?: string[];
  wantToLearn?: string[];
  canTeach?: string[];
  lookingFor?: string[];
  availability?: string | null;
  hoursPerWeek?: number | null;
  communicationPref?: string | null;
  college?: string | null;
  interests?: string[];
};

function toOnboardingResponse(user: any, uo: any) {
  return {
    id: user.id,
    userId: user.id,
    isCompleted: user.onboardingCompleted,
    completedAt: uo?.completedAt?.toISOString() ?? null,
    currentStep: user.onboardingCompleted ? 2 : (uo?.currentStep ?? 0),
    primaryGoal: uo?.primaryGoal ?? null,
    secondaryGoals: uo?.secondaryGoals ?? [],
    wantToLearn: uo?.wantToLearn ?? [],
    canTeach: uo?.canTeach ?? [],
    lookingFor: uo?.lookingFor ?? [],
    availability: uo?.availability ?? null,
    hoursPerWeek: uo?.hoursPerWeek ?? null,
    communicationPref: uo?.communicationPref ?? null,
  };
}

/**
 * GET /api/onboarding
 * Get current user's onboarding data
 */
export const getOnboarding = async (
  req: AuthenticatedRequest,
  res: Response<{ onboarding: OnboardingData & { id: string; userId: string; currentStep: number } } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const userId = String(req.user.userId);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        college: true,
        interests: true,
        onboardingCompleted: true,
        user_onboarding: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.status(200).json({
      onboarding: toOnboardingResponse(user, user.user_onboarding),
    });
  } catch (error) {
    console.error('Get onboarding error:', error);
    res.status(500).json({ error: 'Failed to fetch onboarding data' });
  }
};

/**
 * POST /api/onboarding/step
 * Update onboarding step data
 */
export const updateStep = async (
  req: AuthenticatedRequest,
  res: Response<{ onboarding: OnboardingData & { id: string; userId: string; currentStep: number }; nextStep: number } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const userId = String(req.user.userId);
    const { step, data } = req.body as { step: number; data: Record<string, unknown> };

    if (typeof step !== 'number' || !data || typeof data !== 'object') {
      res.status(400).json({ error: 'Step and data are required' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        college: true,
        interests: true,
        onboardingCompleted: true,
        user_onboarding: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const existing = user.user_onboarding || {};
    const primaryGoal = (step === 0 && data.primaryGoal != null) ? String(data.primaryGoal) : (existing.primaryGoal ?? null);
    const secondaryGoals = (step === 0 && data.secondaryGoals != null) ? (data.secondaryGoals as string[]) : (existing.secondaryGoals ?? []);
    const lookingFor = (step === 0 && data.lookingFor != null) ? (data.lookingFor as string[]) : (existing.lookingFor ?? []);
    const wantToLearn = (step === 1 && data.wantToLearn != null) ? (data.wantToLearn as string[]) : (existing.wantToLearn ?? []);
    const canTeach = (step === 1 && data.canTeach != null) ? (data.canTeach as string[]) : (existing.canTeach ?? []);
    const shouldTriggerMatchNotifications =
      (step === 0 && (
        normalizeOptionalText(data.college) !== normalizeOptionalText(user.college) ||
        normalizeOptionalText(data.primaryGoal) !== normalizeOptionalText(existing.primaryGoal)
      )) ||
      (step === 1 && Array.isArray(data.interests) && !arraysEqual(
        normalizeStringList(data.interests),
        normalizeStringList(user.interests)
      ));

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          ...(step === 0 && data.college != null ? { college: String(data.college) } : {}),
          ...(step === 1 && Array.isArray(data.interests) ? { interests: data.interests } : {}),
        },
      }),
      prisma.user_onboarding.upsert({
        where: { userId },
        create: {
          userId,
          primaryGoal,
          secondaryGoals,
          wantToLearn,
          canTeach,
          lookingFor,
          currentStep: step + 1,
        },
        update: {
          primaryGoal,
          secondaryGoals,
          wantToLearn,
          canTeach,
          lookingFor,
          currentStep: step + 1,
        },
      }),
    ]);

    const updatedUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        college: true,
        interests: true,
        onboardingCompleted: true,
        user_onboarding: true,
      },
    });

    if (!updatedUser) {
      res.status(500).json({ error: 'Failed to fetch updated data' });
      return;
    }

    if (shouldTriggerMatchNotifications) {
      queueMatchAvailabilityNotifications(userId, 'onboarding_update');
    }

    res.status(200).json({
      onboarding: toOnboardingResponse(updatedUser, updatedUser.user_onboarding),
      nextStep: step + 1,
    });
  } catch (error) {
    console.error('Update onboarding step error:', error);
    res.status(500).json({ error: 'Failed to update onboarding step' });
  }
};

/**
 * POST /api/onboarding/complete
 * Mark onboarding as completed
 */
export const completeOnboarding = async (
  req: AuthenticatedRequest,
  res: Response<{ onboarding: OnboardingData & { id: string; userId: string; currentStep: number }; message: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const userId = String(req.user.userId);
    const existingUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        onboardingCompleted: true,
      },
    });

    if (!existingUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { onboardingCompleted: true, onboardingCompletedAt: new Date() },
      }),
      prisma.user_onboarding.upsert({
        where: { userId },
        create: {
          userId,
          isCompleted: true,
          completedAt: new Date(),
          currentStep: 2,
        },
        update: {
          isCompleted: true,
          completedAt: new Date(),
          currentStep: 2,
        },
      }),
    ]);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        college: true,
        interests: true,
        onboardingCompleted: true,
        user_onboarding: true,
      },
    });

    if (!user) {
      res.status(500).json({ error: 'Failed to fetch updated data' });
      return;
    }

    if (!existingUser.onboardingCompleted) {
      queueMatchAvailabilityNotifications(userId, 'onboarding_complete');
    }

    res.status(200).json({
      onboarding: toOnboardingResponse(user, user.user_onboarding),
      message: 'Onboarding completed successfully',
    });
  } catch (error) {
    console.error('Complete onboarding error:', error);
    res.status(500).json({ error: 'Failed to complete onboarding' });
  }
};

/**
 * GET /api/onboarding/matches
 * Get initial matches for the user
 */
export const getOnboardingMatches = async (
  req: AuthenticatedRequest,
  res: Response<{ matches: unknown[]; totalCandidates: number } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    res.status(200).json({
      matches: [],
      totalCandidates: 0,
    });
  } catch (error) {
    console.error('Get onboarding matches error:', error);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
};
