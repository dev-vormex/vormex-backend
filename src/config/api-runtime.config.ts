import { validateAuthRuntimeConfig } from './auth-security.config';

export function validateApiEnvironment(): void {
  // Validate required environment variables
  const requiredEnvVars = [
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GITHUB_CALLBACK_URL',
    'FRONTEND_URL',
    'ENCRYPTION_KEY',
  ];

  if (process.env.NODE_ENV === 'production') {
    requiredEnvVars.push('DATABASE_URL', 'JWT_SECRET', 'AUTH_CSRF_SECRET');
  }

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  validateAuthRuntimeConfig();
}
