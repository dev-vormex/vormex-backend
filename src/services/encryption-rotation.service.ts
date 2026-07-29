import {
  decryptTokenWithMetadata,
  encryptToken,
  EncryptedTokenFormat,
} from '../utils/encryption.util';
import { EncryptionKeySource } from '../config/encryption-keyring';

export interface StoredSecretInspection {
  format: EncryptedTokenFormat | 'plaintext';
  keySource: EncryptionKeySource | 'none';
  needsRotation: boolean;
}

export interface StoredSecretReplacement extends StoredSecretInspection {
  replacement: string | null;
}

function verifiedReplacement(plaintext: string): string {
  const replacement = encryptToken(plaintext);
  const verified = decryptTokenWithMetadata(replacement);
  if (
    verified.keySource !== 'current' ||
    verified.format !== 'v2' ||
    verified.plaintext !== plaintext
  ) {
    throw new Error('Stored secret replacement verification failed');
  }
  return replacement;
}

export function inspectStoredSecret(value: string): StoredSecretInspection {
  const decrypted = decryptTokenWithMetadata(value);
  return {
    format: decrypted.format,
    keySource: decrypted.keySource,
    needsRotation: decrypted.keySource !== 'current' || decrypted.format !== 'v2',
  };
}

export function reencryptStoredSecret(value: string): StoredSecretReplacement {
  const decrypted = decryptTokenWithMetadata(value);
  const needsRotation = decrypted.keySource !== 'current' || decrypted.format !== 'v2';
  return {
    format: decrypted.format,
    keySource: decrypted.keySource,
    needsRotation,
    replacement: needsRotation ? verifiedReplacement(decrypted.plaintext) : null,
  };
}

export function inspectAdminTwoFactorSecret(value: string): StoredSecretInspection {
  if (!value.startsWith('enc:')) {
    return { format: 'plaintext', keySource: 'none', needsRotation: true };
  }
  return inspectStoredSecret(value.slice(4));
}

export function reencryptAdminTwoFactorSecret(value: string): StoredSecretReplacement {
  if (!value.startsWith('enc:')) {
    return {
      format: 'plaintext',
      keySource: 'none',
      needsRotation: true,
      replacement: `enc:${verifiedReplacement(value)}`,
    };
  }

  const result = reencryptStoredSecret(value.slice(4));
  return {
    ...result,
    replacement: result.replacement ? `enc:${result.replacement}` : null,
  };
}
