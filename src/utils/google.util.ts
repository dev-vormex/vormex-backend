import { OAuth2Client } from 'google-auth-library';

/**
 * Google Token Payload Interface
 * Extracted from verified Google ID token
 */
export interface GoogleTokenPayload {
  email: string;
  name: string;
  picture: string;
  googleId: string; // sub field from Google
}

/**
 * Get allowed Google client IDs (supports web + Android + iOS)
 * Reads from platform-specific env vars: GOOGLE_CLIENT_ID_WEB, GOOGLE_CLIENT_ID_ANDROID, GOOGLE_CLIENT_ID_IOS
 * Also supports legacy GOOGLE_CLIENT_IDS (comma-separated) or GOOGLE_CLIENT_ID for backwards compatibility
 */
function getAllowedClientIds(): string[] {
  const clientIds: string[] = [];
  
  // Platform-specific client IDs (recommended)
  if (process.env.GOOGLE_CLIENT_ID_WEB) {
    clientIds.push(process.env.GOOGLE_CLIENT_ID_WEB.trim());
  }
  if (process.env.GOOGLE_CLIENT_ID_ANDROID) {
    clientIds.push(process.env.GOOGLE_CLIENT_ID_ANDROID.trim());
  }
  if (process.env.GOOGLE_CLIENT_ID_IOS) {
    clientIds.push(process.env.GOOGLE_CLIENT_ID_IOS.trim());
  }
  
  // Legacy support: comma-separated list or single ID
  if (clientIds.length === 0) {
    const idsEnv = process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID;
    if (idsEnv) {
      clientIds.push(...idsEnv.split(',').map((id) => id.trim()).filter(Boolean));
    }
  }
  
  return clientIds;
}

/**
 * Initialize Google OAuth2 Client
 * Note: In production, ensure HTTPS is used for token transmission
 */
const client = new OAuth2Client();

/**
 * Verify Google ID token and extract user information
 * Supports both web (PKCE) and Android (Credential Manager) tokens.
 * Use GOOGLE_CLIENT_IDS for multiple platforms: "web-client-id,android-client-id"
 * 
 * @param idToken - Google ID token from frontend
 * @returns GoogleTokenPayload with email, name, picture, and googleId
 * @throws Error if token verification fails
 */
export async function verifyGoogleToken(idToken: string): Promise<GoogleTokenPayload> {
  const allowedIds = getAllowedClientIds();

  if (allowedIds.length === 0) {
    throw new Error('GOOGLE_CLIENT_ID or GOOGLE_CLIENT_IDS is not defined in environment variables');
  }

  if (!idToken || typeof idToken !== 'string' || idToken.trim().length === 0) {
    throw new Error('Invalid idToken: must be a non-empty string');
  }

  try {
    // Verify the token with Google - try each allowed client ID (web + Android)
    const ticket = await client.verifyIdToken({
      idToken: idToken.trim(),
      audience: allowedIds,
    });

    // Get the payload from the verified token
    const payload = ticket.getPayload();

    if (!payload) {
      throw new Error('Failed to extract payload from Google token');
    }

    // Extract required fields
    const email = payload.email;
    const name = payload.name;
    const picture = payload.picture;
    const googleId = payload.sub; // Google's unique user ID

    // Validate required fields exist
    if (!email) {
      throw new Error('Google token payload missing email');
    }

    if (!name) {
      throw new Error('Google token payload missing name');
    }

    if (!googleId) {
      throw new Error('Google token payload missing sub (googleId)');
    }

    // Return extracted payload
    return {
      email: email.toLowerCase(), // Normalize email to lowercase
      name: name.trim(),
      picture: picture || '', // Default to empty string if no picture
      googleId,
    };
  } catch (error) {
    // Handle specific Google Auth errors
    if (error instanceof Error) {
      if (error.message.includes('Token used too early') || 
          error.message.includes('Token used too late')) {
        throw new Error('Google token has expired or is not yet valid');
      }
      
      if (error.message.includes('Invalid token signature')) {
        throw new Error('Invalid Google token signature');
      }
      
      if (error.message.includes('Wrong number of segments')) {
        throw new Error('Invalid Google token format');
      }
    }

    // Log error for debugging
    console.error('Google token verification error:', error);

    // Re-throw with user-friendly message
    throw new Error('Failed to verify Google token. Please try again.');
  }
}

