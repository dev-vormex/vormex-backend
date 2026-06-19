import { OAuth2Client } from 'google-auth-library';
import { fetchWithBreaker } from './http-client-with-breaker.util';

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

export interface GoogleAuthorizationCodeExchangeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
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

function getGoogleWebClientId(): string {
  const clientId = (
    process.env.GOOGLE_CLIENT_ID_WEB ||
    process.env.GOOGLE_CLIENT_ID ||
    process.env.GOOGLE_CLIENT_IDS?.split(',')[0]
  )?.trim();

  if (!clientId) {
    throw new Error('GOOGLE_CLIENT_ID_WEB or GOOGLE_CLIENT_ID is not defined in environment variables');
  }

  return clientId;
}

function getGoogleClientSecret(): string {
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientSecret) {
    throw new Error('GOOGLE_CLIENT_SECRET is not defined in environment variables');
  }
  return clientSecret;
}

function getAllowedRedirectOrigins(): Set<string> {
  const origins = new Set<string>();
  const configuredOrigins = [
    process.env.FRONTEND_URL,
    process.env.ADMIN_FRONTEND_URL,
    process.env.GOOGLE_OAUTH_REDIRECT_ORIGINS,
    process.env.CORS_EXTRA_ORIGINS,
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
  ];

  for (const value of configuredOrigins) {
    if (!value) continue;
    for (const entry of value.split(',')) {
      const trimmed = entry.trim().replace(/\/$/, '');
      if (trimmed) {
        origins.add(trimmed);
      }
    }
  }

  return origins;
}

function assertAllowedRedirectUri(redirectUri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error('Invalid Google redirect URI');
  }

  const isLocalhost = ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLocalhost) {
    throw new Error('Google redirect URI must use HTTPS');
  }

  if (!getAllowedRedirectOrigins().has(parsed.origin)) {
    throw new Error('Google redirect URI origin is not allowed');
  }
}

async function parseGoogleTokenError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as {
    error?: string;
    error_description?: string;
  } | null;
  const errorCode = String(body?.error || '');
  const errorDescription = String(body?.error_description || body?.error || '');

  if (errorCode === 'invalid_client') {
    if (process.env.NODE_ENV !== 'production') {
      return 'Google OAuth client secret is invalid for GOOGLE_CLIENT_ID_WEB. Update GOOGLE_CLIENT_SECRET from the same Web OAuth client in Google Cloud Console and restart the backend.';
    }
    return 'Google sign-in is misconfigured. Please contact support.';
  }

  if (errorCode === 'redirect_uri_mismatch') {
    return 'Google sign-in redirect is misconfigured. Please contact support.';
  }

  if (errorCode === 'invalid_grant') {
    return 'Authorization code expired or already used. Please try signing in again.';
  }

  return errorDescription || 'Failed to exchange Google authorization code';
}

export async function exchangeGoogleAuthorizationCodeForIdToken(
  input: GoogleAuthorizationCodeExchangeInput
): Promise<string> {
  const code = input.code.trim();
  const codeVerifier = input.codeVerifier.trim();
  const redirectUri = input.redirectUri.trim();

  if (!code || !codeVerifier || !redirectUri) {
    throw new Error('Code, code verifier, and redirect URI are required');
  }

  assertAllowedRedirectUri(redirectUri);

  const tokenParams = new URLSearchParams({
    code,
    client_id: getGoogleWebClientId(),
    client_secret: getGoogleClientSecret(),
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  const tokenResponse = await fetchWithBreaker('google_oauth', 'exchange_token', 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: tokenParams.toString(),
  }, { connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 });

  if (!tokenResponse.ok) {
    throw new Error(await parseGoogleTokenError(tokenResponse));
  }

  const tokenData = await tokenResponse.json() as { id_token?: string };
  if (!tokenData?.id_token || typeof tokenData.id_token !== 'string') {
    throw new Error('ID token not found in Google token response');
  }

  return tokenData.id_token;
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

    if (payload.email_verified !== true) {
      throw new Error('Google account email is not verified');
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
