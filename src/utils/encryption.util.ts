import crypto from 'crypto';
import {
  currentEncryptionKey,
  decryptionKeyCandidates,
  EncryptionKeySource,
} from '../config/encryption-keyring';

const LEGACY_ALGORITHM = 'aes-256-cbc';
const ALGORITHM = 'aes-256-gcm';
const GCM_PREFIX = 'v2';

export type EncryptedTokenFormat = 'v2' | 'legacy';

export interface DecryptedToken {
  plaintext: string;
  keySource: EncryptionKeySource;
  format: EncryptedTokenFormat;
}

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
  const cipher = crypto.createCipheriv(ALGORITHM, currentEncryptionKey(), iv);
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
export function decryptTokenWithMetadata(encryptedData: string): DecryptedToken {
  const parts = encryptedData.split(':');

  if (parts.length === 4 && parts[0] === GCM_PREFIX) {
    const iv = bufferFromHex(parts[1], 12);
    const authTag = bufferFromHex(parts[2], 16);
    const encrypted = bufferFromHex(parts[3]);

    for (const candidate of decryptionKeyCandidates()) {
      try {
        const decipher = crypto.createDecipheriv(ALGORITHM, candidate.key, iv);
        decipher.setAuthTag(authTag);

        return {
          plaintext: Buffer.concat([
            decipher.update(encrypted),
            decipher.final(),
          ]).toString('utf8'),
          keySource: candidate.source,
          format: 'v2',
        };
      } catch {
        // Try the next configured key without exposing cryptographic details.
      }
    }

    throw new Error('Unable to decrypt stored secret');
  }

  if (parts.length !== 2) {
    throw new Error('Invalid encrypted token format');
  }

  const iv = bufferFromHex(parts[0], 16);
  const encrypted = bufferFromHex(parts[1]);

  for (const candidate of decryptionKeyCandidates({ legacyUnauthenticated: true })) {
    try {
      const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, candidate.key, iv);
      return {
        plaintext: Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]).toString('utf8'),
        keySource: candidate.source,
        format: 'legacy',
      };
    } catch {
      // Try the next configured key without exposing cryptographic details.
    }
  }

  throw new Error('Unable to decrypt stored secret');
}

export function decryptToken(encryptedData: string): string {
  return decryptTokenWithMetadata(encryptedData).plaintext;
}
