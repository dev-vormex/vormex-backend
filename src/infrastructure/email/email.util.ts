/** Stable import surface; implementations live in focused responsibility modules. */
export {
  PublicEmailDeliveryFailure,
  EmailServiceConfigurationError,
  EmailServiceUnavailableError,
  EmailDeliveryError,
} from './email/email-errors';
export { ensureEmailServiceReady, toPublicEmailDeliveryFailure } from './email/email-delivery';
export { sendPasswordResetEmail, sendVerificationEmail } from './email/email-templates';
