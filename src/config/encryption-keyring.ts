export type EncryptionKeySource = 'current' | 'previous';

export interface EncryptionKeyCandidate {
  source: EncryptionKeySource;
  key: Buffer;
}

function parseEncryptionKey(name: string, value: string | undefined): Buffer {
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${name} must be 64 characters (32 bytes in hex)`);
  }

  return Buffer.from(value, 'hex');
}

const currentKey = parseEncryptionKey('ENCRYPTION_KEY', process.env.ENCRYPTION_KEY);
const previousKey = process.env.ENCRYPTION_KEY_PREVIOUS
  ? parseEncryptionKey('ENCRYPTION_KEY_PREVIOUS', process.env.ENCRYPTION_KEY_PREVIOUS)
  : null;

if (previousKey && currentKey.equals(previousKey)) {
  throw new Error('ENCRYPTION_KEY_PREVIOUS must be different from ENCRYPTION_KEY');
}

export function currentEncryptionKey(): Buffer {
  return Buffer.from(currentKey);
}

export function hasPreviousEncryptionKey(): boolean {
  return previousKey !== null;
}

/**
 * Authenticated values can safely try the current key first. Legacy CBC values
 * have no authentication tag, so during a rotation the previous key is tried
 * first: all newly written values use authenticated encryption and the current
 * key, while legacy values necessarily pre-date the key rotation.
 */
export function decryptionKeyCandidates(options: {
  legacyUnauthenticated?: boolean;
} = {}): EncryptionKeyCandidate[] {
  const current: EncryptionKeyCandidate = {
    source: 'current',
    key: Buffer.from(currentKey),
  };
  const previous: EncryptionKeyCandidate | null = previousKey
    ? {
        source: 'previous',
        key: Buffer.from(previousKey),
      }
    : null;

  if (options.legacyUnauthenticated && previous) {
    return [previous, current];
  }

  return previous ? [current, previous] : [current];
}
