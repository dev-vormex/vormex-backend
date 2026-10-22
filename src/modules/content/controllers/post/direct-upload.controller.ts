import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { createStorageUploadIntent } from "../../utils/direct-media-upload.util";
import { AuthRequest } from "./support.controller";

export const getPostUploadUrl = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const mimeType = ensureString(req.body?.mimeType);
    const sizeBytes = Number(req.body?.sizeBytes);
    if (!mimeType || !Number.isFinite(sizeBytes)) {
      res.status(400).json({ error: 'mimeType and sizeBytes are required' });
      return;
    }

    const credential = createStorageUploadIntent({
      userId: String(req.user.userId),
      purpose: 'post_media',
      mimeType,
      sizeBytes,
    });

    res.json({
      provider: 'bunny_storage',
      uploadMethod: 'PUT',
      uploadUrl: credential.uploadUrl,
      uploadHeaders: credential.headers,
      objectKey: credential.objectKey,
      cdnUrl: credential.cdnUrl,
      uploadToken: credential.token,
      expiresAt: credential.intent.expiresAt,
      maxBytes: credential.intent.maxBytes,
      mimeType,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to issue upload credential';
    res.status(message.includes('large') || message.includes('Unsupported') ? 400 : 500).json({ error: message });
  }
};
