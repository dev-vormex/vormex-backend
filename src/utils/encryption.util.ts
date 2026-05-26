import crypto from 'crypto';

const LEGACY_ALGORITHM = 'aes-256-cbc';
const ALGORITHM = 'aes-256-gcm';
const GCM_PREFIX = 'v2';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;

if (!ENCRYPTION_KEY || !/^[a-f0-9]{64}$/i.test(ENCRYPTION_KEY)) {
  throw new Error('ENCRYPTION_KEY must be 64 characters (32 bytes in hex)');
}

const key = Buffer.from(ENCRYPTION_KEY, 'hex');

function bufferFromHex(value: string, expectedBytes?: number): Buffer {
  if (!/^[a-f0-9]+$/i.test(value) || value.length % 2 !== 0) {
    throw new Error('Invalid encrypted token format');
  }

  const buffer = Buffer.from(value, 'hex');
  if (expectedBytes !== undefined && buffer.length !== expectedBytes) {
    throw new Error('Invalid encrypted token format');
  }

  return buffer;
}

/**
 * Encrypts a stored secret using authenticated AES-256-GCM encryption.
 * @param token - The plaintext access token to encrypt
 * @returns Encrypted token string in format "v2:iv:tag:ciphertext" (hex parts)
 */
export function encryptToken(token: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(token, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    GCM_PREFIX,
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

/**
 * Decrypts a stored secret encrypted with encryptToken.
 * Legacy AES-CBC values in "iv:ciphertext" format are still supported so existing
 * GitHub access tokens and admin 2FA secrets remain readable after deployment.
 *
 * @param encryptedData - The encrypted token string
 * @returns The plaintext access token
 * @throws Error if the encrypted data format is invalid
 */
export function decryptToken(encryptedData: string): string {
  const parts = encryptedData.split(':');

  if (parts.length === 4 && parts[0] === GCM_PREFIX) {
    const iv = bufferFromHex(parts[1], 12);
    const authTag = bufferFromHex(parts[2], 16);
    const encrypted = bufferFromHex(parts[3]);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
  }

  if (parts.length !== 2) {
    throw new Error('Invalid encrypted token format');
  }

  const iv = bufferFromHex(parts[0], 16);
  const encrypted = parts[1];

  const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
