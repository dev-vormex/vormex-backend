import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  currentEncryptionKey,
  decryptionKeyCandidates,
  EncryptionKeySource,
} from '../config/encryption-keyring';

const ALGORITHM = 'aes-256-gcm';
const EVIDENCE_MAGIC = Buffer.from('VXID1');

export interface DecryptedIdentityEvidence {
  buffer: Buffer;
  keySource: EncryptionKeySource;
}

export interface IdentityEvidenceRotationResult {
  keySource: EncryptionKeySource;
  rotated: boolean;
}

function evidenceRoot(): string {
  return process.env.IDENTITY_EVIDENCE_DIR || path.join(process.cwd(), 'private', 'identity-evidence');
}

function safeStorageKey(storageKey: string): string {
  const normalized = String(storageKey || '').trim();
  if (!/^[a-zA-Z0-9/_-]+\.bin$/.test(normalized) || normalized.includes('..')) {
    throw new Error('Invalid evidence storage key');
  }
  return normalized;
}

function storagePath(storageKey: string): string {
  return path.join(evidenceRoot(), safeStorageKey(storageKey));
}

function encryptIdentityEvidencePayload(buffer: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, currentEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([EVIDENCE_MAGIC, iv, authTag, ciphertext]);
}

function decryptIdentityEvidencePayload(payload: Buffer): DecryptedIdentityEvidence {
  const magic = payload.subarray(0, EVIDENCE_MAGIC.length);
  if (!magic.equals(EVIDENCE_MAGIC) || payload.length <= 33) {
    throw new Error('Invalid identity evidence payload');
  }

  const iv = payload.subarray(5, 17);
  const authTag = payload.subarray(17, 33);
  const ciphertext = payload.subarray(33);

  for (const candidate of decryptionKeyCandidates()) {
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, candidate.key, iv);
      decipher.setAuthTag(authTag);
      return {
        buffer: Buffer.concat([decipher.update(ciphertext), decipher.final()]),
        keySource: candidate.source,
      };
    } catch {
      // Try the next configured key without exposing cryptographic details.
    }
  }

  throw new Error('Unable to decrypt identity evidence');
}

function isWithinPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function createEvidenceBackup(params: {
  backupDirectory: string;
  payload: Buffer;
  storageKey: string;
}): Promise<void> {
  const sourceRoot = path.resolve(evidenceRoot());
  const backupRoot = path.resolve(params.backupDirectory);
  if (isWithinPath(backupRoot, sourceRoot)) {
    throw new Error('Identity evidence backup directory must be outside the evidence directory');
  }

  const backupDestination = path.join(backupRoot, safeStorageKey(params.storageKey));
  await fs.mkdir(path.dirname(backupDestination), { recursive: true, mode: 0o700 });

  try {
    await fs.writeFile(backupDestination, params.payload, { flag: 'wx', mode: 0o600 });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }

    const existingBackup = await fs.readFile(backupDestination);
    if (!existingBackup.equals(params.payload)) {
      throw new Error('Identity evidence backup already exists with different content');
    }
  }
}

async function atomicReplaceFile(destination: string, payload: Buffer): Promise<void> {
  const temporaryPath = `${destination}.rotation-${crypto.randomUUID()}.tmp`;
  let handle: fs.FileHandle | null = null;

  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, destination);
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await fs.unlink(temporaryPath).catch((error: any) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
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
  await fs.writeFile(destination, encryptIdentityEvidencePayload(params.buffer), { mode: 0o600 });
}

export async function readEncryptedIdentityEvidenceWithMetadata(
  storageKey: string
): Promise<DecryptedIdentityEvidence> {
  const source = storagePath(storageKey);
  const payload = await fs.readFile(source);
  return decryptIdentityEvidencePayload(payload);
}

export async function readEncryptedIdentityEvidence(storageKey: string): Promise<Buffer> {
  return (await readEncryptedIdentityEvidenceWithMetadata(storageKey)).buffer;
}

export async function rotateEncryptedIdentityEvidence(params: {
  backupDirectory?: string;
  dryRun: boolean;
  storageKey: string;
}): Promise<IdentityEvidenceRotationResult> {
  const safeKey = safeStorageKey(params.storageKey);
  const source = storagePath(safeKey);
  const originalPayload = await fs.readFile(source);
  const decrypted = decryptIdentityEvidencePayload(originalPayload);

  if (decrypted.keySource === 'current' || params.dryRun) {
    return { keySource: decrypted.keySource, rotated: false };
  }

  if (!params.backupDirectory) {
    throw new Error('An identity evidence backup directory is required for apply mode');
  }

  const replacementPayload = encryptIdentityEvidencePayload(decrypted.buffer);
  const verified = decryptIdentityEvidencePayload(replacementPayload);
  if (verified.keySource !== 'current' || !verified.buffer.equals(decrypted.buffer)) {
    throw new Error('Identity evidence replacement verification failed');
  }

  await createEvidenceBackup({
    backupDirectory: params.backupDirectory,
    payload: originalPayload,
    storageKey: safeKey,
  });

  const beforeReplace = await fs.readFile(source);
  if (!beforeReplace.equals(originalPayload)) {
    throw new Error('Identity evidence changed during rotation');
  }
  await atomicReplaceFile(source, replacementPayload);

  const persisted = decryptIdentityEvidencePayload(await fs.readFile(source));
  if (persisted.keySource !== 'current' || !persisted.buffer.equals(decrypted.buffer)) {
    throw new Error('Identity evidence persisted verification failed');
  }

  return { keySource: decrypted.keySource, rotated: true };
}

export async function listIdentityEvidenceStorageKeys(): Promise<string[]> {
  const root = path.resolve(evidenceRoot());
  const keys: string[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error('Symbolic links are not allowed in the identity evidence directory');
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.bin')) {
        const relative = path.relative(root, entryPath).split(path.sep).join('/');
        keys.push(safeStorageKey(relative));
      }
    }
  }

  await walk(root);
  return keys.sort();
}

export async function deleteIdentityEvidence(storageKey: string | null | undefined): Promise<boolean> {
  if (!storageKey) return false;
  const destination = storagePath(storageKey);
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
