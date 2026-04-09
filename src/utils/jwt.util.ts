import jwt from 'jsonwebtoken';

/**
 * JWT Token Payload Interface
 */
export interface JWTPayload {
  userId: string | number; // Supports both String (UUID) and Number (legacy) IDs
  sessionId?: string;
  iat?: number;
  exp?: number;
}

/**
 * Generate JWT token for a user
 * 
 * @param userId - User ID to include in token payload (String or Number)
 * @returns JWT token string
 */
export function generateAccessToken(userId: string | number, sessionId?: string): string {
  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';

  if (!secret) {
    throw new Error('JWT_SECRET is not defined in environment variables');
  }

  const payload: JWTPayload = {
    userId,
    ...(sessionId ? { sessionId } : {}),
  };

  return jwt.sign(payload, secret, {
    expiresIn,
  } as jwt.SignOptions);
}

export function generateToken(userId: string | number): string {
  return generateAccessToken(userId);
}

/**
 * Verify and decode JWT token
 * 
 * @param token - JWT token string to verify
 * @returns Decoded token payload
 * @throws Error if token is invalid or expired
 */
export function verifyToken(token: string): JWTPayload {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET is not defined in environment variables');
  }

  try {
    const decoded = jwt.verify(token, secret) as JWTPayload;
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error('Token has expired');
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid token');
    }
    throw new Error('Token verification failed');
  }
}
