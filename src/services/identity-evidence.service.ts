import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;

function evidenceRoot(): string {
  return process.env.IDENTITY_EVIDENCE_DIR || path.join(process.cwd(), 'private', 'identity-evidence');
}

function encryptionKey(): Buffer {
  if (!ENCRYPTION_KEY || !/^[a-f0-9]{64}$/i.test(ENCRYPTION_KEY)) {
    throw new Error('ENCRYPTION_KEY must be 64 characters (32 bytes in hex)');
  }
  return Buffer.from(ENCRYPTION_KEY, 'hex');
}

function safeStorageKey(storageKey: string): string {
  const normalized = String(storageKey || '').trim();
  if (!/^[a-zA-Z0-9/_-]+\.bin$/.test(normalized) || normalized.includes('..')) {
    throw new Error('Invalid evidence storage key');
  }
  return normalized;
}

export function createEvidenceStorageKey(userId: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${date}/${userId}/${crypto.randomUUID()}.bin`;
}

export async function storeEncryptedIdentityEvidence(params: {
  buffer: Buffer;
  storageKey: string;
}): Promise<void> {
  const key = safeStorageKey(params.storageKey);
  const destination = path.join(evidenceRoot(), key);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(params.buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([
    Buffer.from('VXID1'),
    iv,
    authTag,
    ciphertext,
  ]);

  await fs.writeFile(destination, payload, { mode: 0o600 });
}

export async function readEncryptedIdentityEvidence(storageKey: string): Promise<Buffer> {
  const key = safeStorageKey(storageKey);
  const source = path.join(evidenceRoot(), key);
  const payload = await fs.readFile(source);
  const magic = payload.subarray(0, 5).toString('utf8');
  if (magic !== 'VXID1' || payload.length <= 33) {
    throw new Error('Invalid identity evidence payload');
  }

  const iv = payload.subarray(5, 17);
  const authTag = payload.subarray(17, 33);
  const ciphertext = payload.subarray(33);
  const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export async function deleteIdentityEvidence(storageKey: string | null | undefined): Promise<boolean> {
  if (!storageKey) return false;
  const key = safeStorageKey(storageKey);
  const destination = path.join(evidenceRoot(), key);
  try {
    await fs.unlink(destination);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
