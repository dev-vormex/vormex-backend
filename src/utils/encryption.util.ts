import crypto from 'crypto';

const algorithm = 'aes-256-cbc';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;

if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  throw new Error('ENCRYPTION_KEY must be 64 characters (32 bytes in hex)');
}

const key = Buffer.from(ENCRYPTION_KEY, 'hex');

/**
 * Encrypts a GitHub access token using AES-256-CBC encryption
 * @param token - The plaintext access token to encrypt
 * @returns Encrypted token string in format "iv:encryptedData" (both in hex)
 */
export function encryptToken(token: string): string {
  // Create random IV (initialization vector)
  const iv = crypto.randomBytes(16);
  
  // Create cipher
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  
  // Encrypt token
  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  // Return IV + encrypted data (both in hex, separated by :)
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypts a GitHub access token that was encrypted with encryptToken
 * @param encryptedData - The encrypted token string in format "iv:encryptedData"
 * @returns The plaintext access token
 * @throws Error if the encrypted data format is invalid
 */
export function decryptToken(encryptedData: string): string {
  // Split IV and encrypted data
  const parts = encryptedData.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted token format');
  }
  
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  
  // Create decipher
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  
  // Decrypt
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

