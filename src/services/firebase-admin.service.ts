import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { AppCheck, getAppCheck } from 'firebase-admin/app-check';
import { Auth, getAuth } from 'firebase-admin/auth';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { logger } from '../lib/logger';

let firebaseInitialized = false;
let firebaseUnavailableLogged = false;

function firebaseCredentials() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  return {
    projectId,
    clientEmail,
    privateKey,
  };
}

export function initializeFirebaseAdmin(): boolean {
  if (firebaseInitialized || getApps().length > 0) {
    firebaseInitialized = true;
    return true;
  }

  const credentials = firebaseCredentials();
  if (!credentials) {
    if (!firebaseUnavailableLogged) {
      firebaseUnavailableLogged = true;
      logger.warn({
        event: 'firebase_admin.unconfigured',
        message: 'Firebase credentials are not configured.',
      });
    }
    return false;
  }

  try {
    initializeApp({
      credential: cert(credentials),
    });
    firebaseInitialized = true;
    logger.info({ event: 'firebase_admin.initialized' });
    return true;
  } catch (error) {
    if (getApps().length > 0) {
      firebaseInitialized = true;
      return true;
    }

    logger.error({
      event: 'firebase_admin.initialize_failed',
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function getFirebaseMessaging(): Messaging | null {
  return initializeFirebaseAdmin() ? getMessaging() : null;
}

export function getFirebaseAuth(): Auth | null {
  return initializeFirebaseAdmin() ? getAuth() : null;
}

export function getFirebaseAppCheck(): AppCheck | null {
  return initializeFirebaseAdmin() ? getAppCheck() : null;
}
