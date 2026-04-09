/**
 * Username validation and generation utilities
 * 
 * Username rules:
 * - 3-30 characters
 * - Lowercase letters, numbers, and underscores only
 * - Must start with a letter
 * - Reserved usernames are blocked
 */

/**
 * Reserved usernames that cannot be used
 */
const RESERVED_USERNAMES = [
  'admin',
  'api',
  'www',
  'app',
  'support',
  'help',
  'about',
  'settings',
  'profile',
  'login',
  'register',
  'logout',
  'auth',
  'oauth',
  'github',
  'google',
  'apple',
  'me',
  'root',
  'system',
  'test',
  'null',
  'undefined',
];

/**
 * Validate username format and availability rules
 * 
 * @param username - Username to validate
 * @returns Validation result with error message if invalid
 */
export function validateUsername(username: string): { valid: boolean; error?: string } {
  // Trim and lowercase
  username = username.trim().toLowerCase();

  // Length check
  if (username.length < 3 || username.length > 30) {
    return { valid: false, error: 'Username must be 3-30 characters' };
  }

  // Pattern check (alphanumeric + underscore, must start with letter)
  const usernameRegex = /^[a-z][a-z0-9_]*$/;
  if (!usernameRegex.test(username)) {
    return { valid: false, error: 'Username must start with letter and contain only lowercase letters, numbers, underscore' };
  }

  // Reserved usernames
  if (RESERVED_USERNAMES.includes(username)) {
    return { valid: false, error: `Username '${username}' is reserved` };
  }

  return { valid: true };
}

/**
 * Normalize username (trim and lowercase)
 * 
 * @param username - Username to normalize
 * @returns Normalized username
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Generate a username from a name
 * Used for auto-generating usernames for OAuth users or existing users
 * 
 * @param name - Full name (e.g., "Koushik Kumar")
 * @returns Generated username (e.g., "koushik_kumar_1234")
 */
export function generateUsernameFromName(name: string): string {
  // Convert to lowercase and replace non-alphanumeric with underscore
  let username = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // Replace non-alphanumeric with underscore
    .replace(/^_+|_+$/g, '');     // Remove leading/trailing underscores

  // Ensure starts with letter
  if (!/^[a-z]/.test(username)) {
    username = 'user_' + username;
  }

  // If empty after processing, use default
  if (!username || username.length < 3) {
    username = 'user';
  }

  // Truncate to 26 chars to leave room for suffix
  if (username.length > 26) {
    username = username.substring(0, 26);
  }

  // Add random suffix to ensure uniqueness (4 digits)
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  return `${username}_${randomSuffix}`;
}

/**
 * Check if a string is a valid UUID format
 * 
 * @param str - String to check
 * @returns True if string is a valid UUID
 */
export function isUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}


