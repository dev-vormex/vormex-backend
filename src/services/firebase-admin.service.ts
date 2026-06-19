import * as admin from 'firebase-admin';
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
  if (firebaseInitialized || admin.apps.length > 0) {
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
    admin.initializeApp({
      credential: admin.credential.cert(credentials),
    });
    firebaseInitialized = true;
    logger.info({ event: 'firebase_admin.initialized' });
    return true;
  } catch (error) {
    if (admin.apps.length > 0) {
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

export function getFirebaseMessaging(): admin.messaging.Messaging | null {
  return initializeFirebaseAdmin() ? admin.messaging() : null;
}

export function getFirebaseAuth(): admin.auth.Auth | null {
  return initializeFirebaseAdmin() ? admin.auth() : null;
}

export function getFirebaseAppCheck(): admin.appCheck.AppCheck | null {
  return initializeFirebaseAdmin() ? admin.appCheck() : null;
}
