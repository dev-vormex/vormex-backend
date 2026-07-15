import type { RequestHandler } from 'express';

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'] as const;
export const AUDIO_MIME_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/wav', 'audio/x-wav'] as const;
export const DOCUMENT_MIME_TYPES = ['application/pdf', 'text/plain'] as const;
export const CHAT_MIME_TYPES = [
  ...IMAGE_MIME_TYPES,
  ...VIDEO_MIME_TYPES,
  ...AUDIO_MIME_TYPES,
  ...DOCUMENT_MIME_TYPES,
] as const;

export interface UploadFieldRule {
  allowedMimeTypes: readonly string[];
  maxBytes: number;
}

export interface UploadValidationOptions {
  defaultRule?: UploadFieldRule;
  fields?: Record<string, UploadFieldRule>;
  maxFiles?: number;
  requireKnownField?: boolean;
}

const MIME_EXTENSIONS: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'video/mp4': ['mp4', 'm4v'],
  'video/webm': ['webm'],
  'video/quicktime': ['mov', 'qt'],
  'audio/mpeg': ['mp3', 'mpeg'],
  'audio/mp4': ['m4a', 'mp4'],
  'audio/webm': ['webm'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt', 'text', 'log'],
};

function collectFiles(req: Parameters<RequestHandler>[0]): Express.Multer.File[] {
  const files: Express.Multer.File[] = [];
  if (req.file) {
    files.push(req.file);
  }

  if (Array.isArray(req.files)) {
    files.push(...req.files);
  } else if (req.files && typeof req.files === 'object') {
    Object.values(req.files).forEach((value) => {
      if (Array.isArray(value)) {
        files.push(...value);
      }
    });
  }

  return files;
}

function getExtension(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function hasMagic(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length === 0) return false;

  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === 'image/gif') {
    return buffer.subarray(0, 6).toString('ascii') === 'GIF87a'
      || buffer.subarray(0, 6).toString('ascii') === 'GIF89a';
  }
  if (mimeType === 'image/webp') {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (mimeType === 'video/webm' || mimeType === 'audio/webm') {
    return buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime' || mimeType === 'audio/mp4') {
    return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  }
  if (mimeType === 'audio/mpeg') {
    return buffer.subarray(0, 3).toString('ascii') === 'ID3'
      || (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
  }
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WAVE';
  }
  if (mimeType === 'application/pdf') {
    return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  }
  if (mimeType === 'text/plain') {
    return !buffer.includes(0x00);
  }

  return false;
}

export function fileNameIsSafe(fileName: string): boolean {
  const raw = fileName || '';
  if (raw.includes('/') || raw.includes('\\')) return false;
  const base = raw;
  return base.length > 0
    && base.length <= 180
    && !base.includes('..')
    && /^[a-zA-Z0-9._ (),@-]+$/.test(base);
}

function validateFile(file: Express.Multer.File, rule: UploadFieldRule): string | null {
  const mimeType = String(file.mimetype || '').toLowerCase();
  if (!rule.allowedMimeTypes.includes(mimeType)) {
    return `Unsupported file type for ${file.fieldname}`;
  }

  if (file.size <= 0 || file.size > rule.maxBytes) {
    return `File ${file.originalname || file.fieldname} exceeds the allowed size`;
  }

  if (!fileNameIsSafe(file.originalname || 'upload')) {
    return 'File name contains unsafe characters';
  }

  const extension = getExtension(file.originalname || '');
  const allowedExtensions = MIME_EXTENSIONS[mimeType] || [];
  if (extension && allowedExtensions.length > 0 && !allowedExtensions.includes(extension)) {
    return 'File extension does not match file type';
  }

  if (!Buffer.isBuffer(file.buffer) || !hasMagic(file.buffer, mimeType)) {
    return 'File contents do not match the declared file type';
  }

  return null;
}

export function validateUploadedFiles(options: UploadValidationOptions): RequestHandler {
  return (req, res, next) => {
    const files = collectFiles(req);
    const maxFiles = options.maxFiles ?? 10;

    if (files.length > maxFiles) {
      res.status(400).json({ error: `Too many files uploaded; maximum is ${maxFiles}` });
      return;
    }

    for (const file of files) {
      const rule = options.fields?.[file.fieldname] || options.defaultRule;
      if (!rule || (options.requireKnownField && !options.fields?.[file.fieldname])) {
        res.status(400).json({ error: `Unexpected file field: ${file.fieldname}` });
        return;
      }

      const error = validateFile(file, rule);
      if (error) {
        res.status(400).json({ error });
        return;
      }
    }

    next();
  };
}

export const imageUploadRule = (maxBytes: number): UploadFieldRule => ({
  allowedMimeTypes: IMAGE_MIME_TYPES,
  maxBytes,
});

export const videoUploadRule = (maxBytes: number): UploadFieldRule => ({
  allowedMimeTypes: VIDEO_MIME_TYPES,
  maxBytes,
});

export const audioUploadRule = (maxBytes: number): UploadFieldRule => ({
  allowedMimeTypes: AUDIO_MIME_TYPES,
  maxBytes,
});

export const chatUploadRule = (maxBytes: number): UploadFieldRule => ({
  allowedMimeTypes: CHAT_MIME_TYPES,
  maxBytes,
});
