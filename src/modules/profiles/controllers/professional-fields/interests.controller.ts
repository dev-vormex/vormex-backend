import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { queueMatchAvailabilityNotifications } from "../../../notifications/services/match-availability-notification.service";
import { ensureString } from "../../../../shared/utils/request.util";
import { invalidateProfessionalProfileCaches } from "./support.controller";

export // ============================================
// INTERESTS
// ============================================

/**
 * Helper function to process and validate a single interest
 */
function processInterest(interest: string): string | null {
  const trimmed = interest.trim();
  if (trimmed.length < 2 || trimmed.length > 30) {
    return null;
  }
  // Capitalize first letter of each word
  return trimmed
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Get user interests
 * GET /api/users/me/interests
 * Protected route
 */
export const getInterests = async (
  req: AuthenticatedRequest,
  res: Response<{ interests: string[] } | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'Unauthorized',
      });
      return;
    }

    const userId = String(req.user.userId);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { interests: true },
    });

    if (!user) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    res.status(200).json({
      interests: user.interests || [],
    });
  } catch (error) {
    console.error('Error getting interests:', error);
    res.status(500).json({
      error: 'Failed to fetch interests',
    });
  }
};

/**
 * Add a new interest
 * POST /api/users/me/interests
 * Protected route
 */
export const addInterest = async (
  req: AuthenticatedRequest,
  res: Response<{ interests: string[] } | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'Unauthorized',
      });
      return;
    }

    const userId = String(req.user.userId);
    const { interest } = req.body;

    if (!interest || typeof interest !== 'string') {
      res.status(400).json({
        error: 'Interest is required and must be a string',
      });
      return;
    }

    // Process the interest
    const processed = processInterest(interest);
    if (!processed) {
      res.status(400).json({
        error: 'Interest must be between 2 and 30 characters',
      });
      return;
    }

    // Get current interests
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { interests: true },
    });

    if (!user) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    const currentInterests = user.interests || [];

    // Check if already exists (case-insensitive)
    const exists = currentInterests.some(
      (i) => i.toLowerCase() === processed.toLowerCase()
    );

    if (exists) {
      res.status(409).json({
        error: 'Interest already exists',
      });
      return;
    }

    // Check max limit
    if (currentInterests.length >= 10) {
      res.status(400).json({
        error: 'Maximum 10 interests allowed',
      });
      return;
    }

    // Add new interest
    const updatedInterests = [...currentInterests, processed];

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { interests: updatedInterests },
      select: { interests: true },
    });

    queueMatchAvailabilityNotifications(userId, 'interest_add');
    await invalidateProfessionalProfileCaches(userId, true);

    res.status(201).json({
      interests: updatedUser.interests || [],
    });
  } catch (error) {
    console.error('Error adding interest:', error);
    res.status(500).json({
      error: 'Failed to add interest',
    });
  }
};

/**
 * Update an existing interest
 * PUT /api/users/me/interests/:interest
 * Protected route
 * Note: :interest is URL-encoded interest value
 */
export const updateInterest = async (
  req: AuthenticatedRequest,
  res: Response<{ interests: string[] } | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'Unauthorized',
      });
      return;
    }

    const userId = String(req.user.userId);
    const oldInterest = decodeURIComponent(ensureString(req.params.interest) || '');
    const { interest: newInterest } = req.body;

    if (!newInterest || typeof newInterest !== 'string') {
      res.status(400).json({
        error: 'Interest is required and must be a string',
      });
      return;
    }

    // Process the new interest
    const processed = processInterest(newInterest);
    if (!processed) {
      res.status(400).json({
        error: 'Interest must be between 2 and 30 characters',
      });
      return;
    }

    // Get current interests
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { interests: true },
    });

    if (!user) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    const currentInterests = user.interests || [];

    // Find the index of the old interest (case-insensitive)
    const index = currentInterests.findIndex(
      (i) => i.toLowerCase() === oldInterest.toLowerCase()
    );

    if (index === -1) {
      res.status(404).json({
        error: 'Interest not found',
      });
      return;
    }

    // Check if new value already exists (excluding the one we're updating)
    const exists = currentInterests.some(
      (i, idx) => idx !== index && i.toLowerCase() === processed.toLowerCase()
    );

    if (exists) {
      res.status(409).json({
        error: 'Interest already exists',
      });
      return;
    }

    // Update the interest
    const updatedInterests = [...currentInterests];
    updatedInterests[index] = processed;

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { interests: updatedInterests },
      select: { interests: true },
    });

    queueMatchAvailabilityNotifications(userId, 'interest_update');
    await invalidateProfessionalProfileCaches(userId, true);

    res.status(200).json({
      interests: updatedUser.interests || [],
    });
  } catch (error) {
    console.error('Error updating interest:', error);
    res.status(500).json({
      error: 'Failed to update interest',
    });
  }
};

/**
 * Delete an interest
 * DELETE /api/users/me/interests/:interest
 * Protected route
 * Note: :interest is URL-encoded interest value
 */
export const deleteInterest = async (
  req: AuthenticatedRequest,
  res: Response<{ interests: string[] } | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'Unauthorized',
      });
      return;
    }

    const userId = String(req.user.userId);
    const interestToDelete = decodeURIComponent(ensureString(req.params.interest) || '');

    // Get current interests
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { interests: true },
    });

    if (!user) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    const currentInterests = user.interests || [];

    // Find and remove the interest (case-insensitive)
    const updatedInterests = currentInterests.filter(
      (i) => i.toLowerCase() !== interestToDelete.toLowerCase()
    );

    // Check if interest was found
    if (updatedInterests.length === currentInterests.length) {
      res.status(404).json({
        error: 'Interest not found',
      });
      return;
    }

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { interests: updatedInterests },
      select: { interests: true },
    });

    await invalidateProfessionalProfileCaches(userId, true);

    res.status(200).json({
      interests: updatedUser.interests || [],
    });
  } catch (error) {
    console.error('Error deleting interest:', error);
    res.status(500).json({
      error: 'Failed to delete interest',
    });
  }
};
