import { executeWithCircuitBreaker } from "../../http/http-client-with-breaker.util";
import { getEmailConfig, ensureEmailServiceReady, normalizeResendSendError, escapeHtml, resolveVormexLogo } from "./email-delivery";
import { resend, getResendResponseHeaders, EmailDeliveryError, EmailSendError, EmailServiceUnavailableError, EmailAttachment } from "./email-errors";

async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}): Promise<void> {
  const { emailFrom } = getEmailConfig();
  await ensureEmailServiceReady();

  try {
    const result = await executeWithCircuitBreaker(
      'resend',
      'send_email',
      () => resend.emails.send({
        from: emailFrom,
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        attachments: params.attachments,
      }),
      {
        connectTimeoutMs: 5_000,
        requestTimeoutMs: 10_000,
      }
    );

    if (result.error) {
      throw normalizeResendSendError(result.error, getResendResponseHeaders(result));
    }

    if (!result.data) {
      throw new EmailDeliveryError('Email sending failed: No data returned from Resend');
    }
  } catch (error) {
    if (error instanceof EmailSendError) {
      throw error;
    }

    throw new EmailServiceUnavailableError(
      'Email service is temporarily unavailable. Unable to send email through Resend.',
      'EMAIL_SERVICE_NETWORK_ERROR'
    );
  }
}

/**
 * Send password reset email to user
 *
 * @param email - User's email address
 * @param resetToken - Plain text reset token (will be included in URL)
 * @throws Error if email sending fails
 */
export async function sendPasswordResetEmail(
  email: string,
  resetToken: string
): Promise<void> {
  const { frontendUrl } = getEmailConfig();
  const resetUrl = `${frontendUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 40px 30px;">
              <h1 style="margin: 0 0 20px 0; color: #000000; font-size: 24px; font-weight: 600;">Reset Your Password</h1>

              <p style="margin: 0 0 20px 0; color: #333333; font-size: 16px; line-height: 1.5;">
                Hello,
              </p>

              <p style="margin: 0 0 20px 0; color: #333333; font-size: 16px; line-height: 1.5;">
                We received a request to reset your password for your Vormex account. If you made this request, click the button below to reset your password.
              </p>

              <table role="presentation" style="width: 100%; margin: 30px 0;">
                <tr>
                  <td align="center">
                    <a href="${resetUrl}" style="display: inline-block; padding: 14px 32px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600; text-align: center;">Reset Password</a>
                  </td>
                </tr>
              </table>

              <p style="margin: 20px 0; color: #666666; font-size: 14px; line-height: 1.5;">
                Or copy and paste this link into your browser:
              </p>

              <p style="margin: 0 0 20px 0; color: #2563eb; font-size: 14px; word-break: break-all; line-height: 1.5;">
                ${resetUrl}
              </p>

              <p style="margin: 0 0 20px 0; color: #666666; font-size: 14px; line-height: 1.5;">
                <strong>This link will expire in 1 hour.</strong> If you don't reset your password within this time, you'll need to request a new reset link.
              </p>

              <p style="margin: 0 0 20px 0; color: #666666; font-size: 14px; line-height: 1.5;">
                If you didn't request a password reset, please ignore this email. Your password will remain unchanged.
              </p>

              <p style="margin: 30px 0 0 0; color: #333333; font-size: 16px; line-height: 1.5;">
                Best regards,<br>
                <strong>The Vormex Team</strong>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textBody = `
Reset Your Password

Hello,

We received a request to reset your password for your Vormex account. If you made this request, use the link below to reset your password:

${resetUrl}

This link will expire in 1 hour. If you don't reset your password within this time, you'll need to request a new reset link.

If you didn't request a password reset, please ignore this email. Your password will remain unchanged.

Best regards,
The Vormex Team
  `.trim();

  await sendEmail({
    to: email,
    subject: 'Reset Your Vormex Password',
    html: htmlBody,
    text: textBody,
  });

  console.log('Password reset email sent successfully to:', email);
}

/**
 * Send email verification OTP to user
 *
 * @param email - User's email address
 * @param verificationCode - Plain text 6-digit verification code
 * @param name - User's name for personalization
 * @throws Error if email sending fails
 */
export async function sendVerificationEmail(
  email: string,
  verificationCode: string,
  name: string
): Promise<void> {
  const escapedName = escapeHtml(name);
  const escapedCode = escapeHtml(verificationCode);
  const logo = resolveVormexLogo();
  const escapedLogoSrc = escapeHtml(logo.src);

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Your Vormex Email</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 40px 30px;">
              <div style="margin: 0 auto 26px auto; text-align: center;">
                <img src="${escapedLogoSrc}" width="82" height="82" alt="Vormex" style="display: inline-block; width: 82px; height: 82px; border: 0; outline: none; text-decoration: none; border-radius: 18px;">
              </div>

              <h1 style="margin: 0 0 20px 0; color: #000000; font-size: 24px; font-weight: 600; text-align: center;">Verify your Vormex email</h1>

              <p style="margin: 0 0 20px 0; color: #333333; font-size: 16px; line-height: 1.5;">
                Hello ${escapedName},
              </p>

              <p style="margin: 0 0 20px 0; color: #333333; font-size: 16px; line-height: 1.5;">
                Enter this verification code in the app to continue your Vormex verification.
              </p>

              <div style="margin: 30px 0; padding: 18px 24px; background-color: #f1f5f9; border-radius: 10px; text-align: center; letter-spacing: 8px; font-size: 32px; font-weight: 700; color: #111827;">
                ${escapedCode}
              </div>

              <p style="margin: 0 0 20px 0; color: #666666; font-size: 14px; line-height: 1.5;">
                <strong>This code expires in 10 minutes.</strong> If it expires, request a new code from the app.
              </p>

              <p style="margin: 0 0 20px 0; color: #666666; font-size: 14px; line-height: 1.5;">
                If you didn't create a Vormex account, please ignore this email.
              </p>

              <p style="margin: 30px 0 0 0; color: #333333; font-size: 16px; line-height: 1.5;">
                Best regards,<br>
                <strong>The Vormex Team</strong>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textBody = `
Verify your Vormex email

Hello ${name},

Enter this verification code in the app to continue your Vormex verification:

${verificationCode}

This code expires in 10 minutes. If it expires, request a new code from the app.

If you didn't create a Vormex account, please ignore this email.

Best regards,
The Vormex Team
  `.trim();

  await sendEmail({
    to: email,
    subject: `${verificationCode} is your Vormex verification code`,
    html: htmlBody,
    text: textBody,
    attachments: logo.attachments,
  });

  console.log('Verification email sent successfully to:', email);
}
