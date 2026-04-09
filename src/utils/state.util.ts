/**
 * State management for OAuth CSRF protection
 * Stores state tokens with userId and expiration time
 */

interface StateData {
  userId: string;
  expiresAt: number;
}

// In-memory store for OAuth state tokens
const stateStore = new Map<string, StateData>();

import crypto from 'crypto';

/**
 * Generate and store a new OAuth state token
 * @param userId - User ID to associate with the state
 * @returns Generated state token
 */
export function generateStateToken(userId: string): string {
  const state = crypto.randomBytes(32).toString('hex');
  
  // Store state with 5-minute expiration
  stateStore.set(state, {
    userId,
    expiresAt: Date.now() + 300000, // 5 minutes
  });
  
  return state;
}

/**
 * Validate and retrieve state token data
 * @param state - State token to validate
 * @returns State data if valid, null if invalid or expired
 */
export function validateStateToken(state: string): StateData | null {
  const stateData = stateStore.get(state);
  
  if (!stateData) {
    return null; // State not found
  }
  
  if (Date.now() > stateData.expiresAt) {
    stateStore.delete(state); // Clean up expired state
    return null; // State expired
  }
  
  return stateData;
}

/**
 * Delete a state token (after successful validation)
 * @param state - State token to delete
 */
export function deleteStateToken(state: string): void {
  stateStore.delete(state);
}

/**
 * Clean up expired state tokens
 * Called periodically to prevent memory leaks
 */
export function cleanupExpiredStates(): void {
  const now = Date.now();
  for (const [state, data] of stateStore.entries()) {
    if (now > data.expiresAt) {
      stateStore.delete(state);
    }
  }
}

// Clean up expired states every minute
setInterval(cleanupExpiredStates, 60000);

