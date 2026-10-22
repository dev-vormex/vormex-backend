import { prisma } from "../../../../config/prisma";

export const STUDENT_EMAIL_OTP_TTL_MS = 10 * 60 * 1000;

export const STUDENT_EMAIL_RESEND_COOLDOWN_MS = 60 * 1000;

export const COMMON_PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
]);

export const ID_DOCUMENT_REVIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function cleanEmail(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

export function emailDomain(email: string): string | null {
  const [, domain] = email.split('@');
  return domain?.trim().toLowerCase() || null;
}

export function normalizedCollegeKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function trustedInstitutionDomains(): Map<string, string | null> {
  const entries = String(process.env.TRUSTED_INSTITUTION_DOMAINS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const registry = new Map<string, string | null>();
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    const domain = (separator >= 0 ? entry.slice(0, separator) : entry).trim().toLowerCase();
    const college = separator >= 0 ? entry.slice(separator + 1).trim() : '';
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      registry.set(domain, college || null);
    }
  }
  return registry;
}

export async function validateStudentEmailDomain(params: {
  college?: string | null;
  studentEmail: string;
}): Promise<{ ok: boolean; error?: string; college: string | null; domain: string }> {
  const domain = emailDomain(params.studentEmail);
  if (!domain) {
    return { ok: false, error: 'Enter a valid student email address.', college: null, domain: '' };
  }
  if (COMMON_PERSONAL_EMAIL_DOMAINS.has(domain)) {
    return { ok: false, error: 'Use your college or student email address, not a personal email.', college: null, domain };
  }

  const college = String(params.college || '').trim();
  const community = college
      ? await prisma.college_communities.findFirst({
        where: { college: { equals: college, mode: 'insensitive' } },
        select: { college: true, emailDomains: true, verificationMode: true },
      })
    : null;
  if (community?.verificationMode === 'student_email_otp' && community.emailDomains?.length) {
    const allowed = community.emailDomains.some((item: string) => item.toLowerCase() === domain);
    if (!allowed) {
      return {
        ok: false,
        error: `Use an email domain approved for ${community.college}.`,
        college: community.college,
        domain,
      };
    }
    return { ok: true, college: community.college, domain };
  }

  const registeredCollege = trustedInstitutionDomains().get(domain);
  if (registeredCollege === undefined) {
    return {
      ok: false,
      error: 'This institution email domain is not yet in the verified registry.',
      college: college || null,
      domain,
    };
  }

  if (
    college
    && registeredCollege
    && normalizedCollegeKey(college) !== normalizedCollegeKey(registeredCollege)
  ) {
    return {
      ok: false,
      error: 'This student email domain is registered to a different institution.',
      college,
      domain,
    };
  }

  return { ok: true, college: registeredCollege || college || null, domain };
}

export async function getLatestActiveIdDocumentVerification(userId: string) {
  return prisma.identity_verifications.findFirst({
    where: {
      userId,
      type: 'ID_DOCUMENT',
      status: { in: ['PENDING', 'VERIFIED'] },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export function hasSubmittedEvidence(verification: any): boolean {
  return Boolean(
    verification?.evidenceStorageKey &&
    verification?.evidenceFileName &&
    !verification?.evidenceDeletedAt
  );
}

export function buildIdUploadResponse(verification: { id: string; expiresAt?: Date | null }) {
  return {
    verificationId: verification.id,
    uploadMode: 'direct_submit',
    submitUrl: '/api/identity/id/submit',
    fieldName: 'evidence',
    maxBytes: 8 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    expiresAt: verification.expiresAt?.toISOString?.() || null,
  };
}
