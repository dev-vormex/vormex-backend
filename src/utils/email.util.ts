import { Resend } from 'resend';

/**
 * Initialize Resend client (use placeholder when key missing so app can start in dev)
 */
const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder');

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
  const emailFrom = process.env.EMAIL_FROM || 'noreply@vormex.in';
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not defined in environment variables');
  }

  const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;

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

  try {
    const { data, error } = await resend.emails.send({
      from: emailFrom,
      to: email,
      subject: 'Reset Your Vormex Password',
      html: htmlBody,
      text: textBody,
    });

    if (error) {
      console.error('Resend API error:', error);
      throw new Error(`Failed to send email: ${error.message}`);
    }

    if (!data) {
      throw new Error('Email sending failed: No data returned from Resend');
    }

    console.log('Password reset email sent successfully to:', email);
  } catch (error) {
    console.error('Error sending password reset email:', error);
    throw error;
  }
}

/**
 * Send email verification email to user
 * 
 * @param email - User's email address
 * @param verificationToken - Plain text verification token (will be included in URL)
 * @param name - User's name for personalization
 * @throws Error if email sending fails
 */
export async function sendVerificationEmail(
  email: string,
  verificationToken: string,
  name: string
): Promise<void> {
  const emailFrom = process.env.EMAIL_FROM || 'noreply@vormex.in';
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not defined in environment variables');
  }

  const verificationUrl = `${frontendUrl}/verify-email?token=${verificationToken}`;

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Your Account</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 40px 30px;">
              <h1 style="margin: 0 0 20px 0; color: #000000; font-size: 24px; font-weight: 600;">Welcome to Vormex!</h1>
              
              <p style="margin: 0 0 20px 0; color: #333333; font-size: 16px; line-height: 1.5;">
                Hello ${name},
              </p>
              
              <p style="margin: 0 0 20px 0; color: #333333; font-size: 16px; line-height: 1.5;">
                Thank you for joining Vormex! We're excited to have you on board. To get started and access all features, please verify your email address by clicking the button below.
              </p>
              
              <table role="presentation" style="width: 100%; margin: 30px 0;">
                <tr>
                  <td align="center">
                    <a href="${verificationUrl}" style="display: inline-block; padding: 14px 32px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600; text-align: center;">Verify Email Address</a>
                  </td>
                </tr>
              </table>
              
              <p style="margin: 20px 0; color: #666666; font-size: 14px; line-height: 1.5;">
                Or copy and paste this link into your browser:
              </p>
              
              <p style="margin: 0 0 20px 0; color: #2563eb; font-size: 14px; word-break: break-all; line-height: 1.5;">
                ${verificationUrl}
              </p>
              
              <p style="margin: 0 0 20px 0; color: #666666; font-size: 14px; line-height: 1.5;">
                <strong>This verification link will expire in 24 hours.</strong> If you don't verify your email within this time, you can request a new verification email.
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
Welcome to Vormex!

Hello ${name},

Thank you for joining Vormex! We're excited to have you on board. To get started and access all features, please verify your email address using the link below:

${verificationUrl}

This verification link will expire in 24 hours. If you don't verify your email within this time, you can request a new verification email.

If you didn't create a Vormex account, please ignore this email.

Best regards,
The Vormex Team
  `.trim();

  try {
    const { data, error } = await resend.emails.send({
      from: emailFrom,
      to: email,
      subject: 'Verify Your Vormex Account',
      html: htmlBody,
      text: textBody,
    });

    if (error) {
      console.error('Resend API error:', error);
      throw new Error(`Failed to send email: ${error.message}`);
    }

    if (!data) {
      throw new Error('Email sending failed: No data returned from Resend');
    }

    console.log('Verification email sent successfully to:', email);
  } catch (error) {
    console.error('Error sending verification email:', error);
    throw error;
  }
}

