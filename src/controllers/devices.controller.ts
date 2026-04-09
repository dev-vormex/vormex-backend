import { Request, Response } from 'express';
import { prisma } from '../config/prisma';

interface AuthRequest extends Request {
  user?: { userId: string };
}

// Register device token
export const registerDevice = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { token, platform } = req.body;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!token || !platform) {
      res.status(400).json({ error: 'Token and platform are required' });
      return;
    }

    // Check if token already exists
    const existingToken = await prisma.device_tokens.findUnique({
      where: { token },
    });

    if (existingToken) {
      // Update existing token
      await prisma.device_tokens.update({
        where: { token },
        data: {
          userId,
          platform,
          isActive: true,
          updatedAt: new Date(),
        },
      });
    } else {
      // Create new token
      await prisma.device_tokens.create({
        data: {
          userId,
          token,
          platform,
          isActive: true,
        },
      });
    }

    res.json({
      success: true,
      message: 'Device registered successfully',
    });
  } catch (error) {
    console.error('Failed to register device:', error);
    res.status(500).json({ error: 'Failed to register device' });
  }
};

// Unregister device token
export const unregisterDevice = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { token } = req.body;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!token) {
      res.status(400).json({ error: 'Token is required' });
      return;
    }

    await prisma.device_tokens.updateMany({
      where: {
        userId,
        token,
      },
      data: {
        isActive: false,
      },
    });

    res.json({
      success: true,
      message: 'Device unregistered successfully',
    });
  } catch (error) {
    console.error('Failed to unregister device:', error);
    res.status(500).json({ error: 'Failed to unregister device' });
  }
};
