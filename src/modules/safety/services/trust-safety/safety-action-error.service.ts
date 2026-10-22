import crypto from "crypto";
import type { Request } from "express";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../../../config/prisma";
import { TtlMemo } from "../../../../infrastructure/cache/ttl-memo";

export type IdentityTrustLevel =
  | 'BASIC'
  | 'EMAIL_VERIFIED'
  | 'PHONE_VERIFIED'
  | 'STUDENT_VERIFIED'
  | 'ID_VERIFIED';

export type TrustLimitedAction =
  | 'dm'
  | 'connection_request'
  | 'post'
  | 'comment'
  | 'report'
  | 'media';

export const TRUST_LEVELS: IdentityTrustLevel[] = [
  'BASIC',
  'EMAIL_VERIFIED',
  'PHONE_VERIFIED',
  'STUDENT_VERIFIED',
  'ID_VERIFIED',
];

export // Active-chat checks are warmed when the socket joins/types. A short TTL
// removes a remote database round-trip from each send while explicit
// block/unblock paths invalidate the pair immediately.
const messageInteractionMemo = new TtlMemo<void>(5_000, 20_000);

export const identityTrustLevelMemo = new TtlMemo<IdentityTrustLevel>(30_000, 10_000);

export const BLOCKED_USER_IDS_CACHE_TTL_SECONDS = 60;

const INSTALL_ID_HEADER = 'x-vormex-install-id';

const PLATFORM_HEADER = 'x-vormex-platform';

const INSTALL_ID_PATTERN = /^[a-zA-Z0-9._:-]{16,256}$/;

const PLATFORM_PATTERN = /^[a-z0-9_-]{2,32}$/;

export const ACTION_LIMITS: Record<TrustLimitedAction, Record<IdentityTrustLevel, number>> = {
  dm: {
    BASIC: 20,
    EMAIL_VERIFIED: 40,
    PHONE_VERIFIED: 80,
    STUDENT_VERIFIED: 120,
    ID_VERIFIED: 200,
  },
  connection_request: {
    BASIC: 10,
    EMAIL_VERIFIED: 20,
    PHONE_VERIFIED: 40,
    STUDENT_VERIFIED: 60,
    ID_VERIFIED: 100,
  },
  post: {
    BASIC: 8,
    EMAIL_VERIFIED: 15,
    PHONE_VERIFIED: 30,
    STUDENT_VERIFIED: 45,
    ID_VERIFIED: 80,
  },
  comment: {
    BASIC: 30,
    EMAIL_VERIFIED: 60,
    PHONE_VERIFIED: 120,
    STUDENT_VERIFIED: 180,
    ID_VERIFIED: 300,
  },
  report: {
    BASIC: 8,
    EMAIL_VERIFIED: 12,
    PHONE_VERIFIED: 20,
    STUDENT_VERIFIED: 30,
    ID_VERIFIED: 40,
  },
  media: {
    BASIC: 15,
    EMAIL_VERIFIED: 25,
    PHONE_VERIFIED: 40,
    STUDENT_VERIFIED: 60,
    ID_VERIFIED: 90,
  },
};

export const ACTION_WINDOW_SECONDS: Record<TrustLimitedAction, number> = {
  dm: 24 * 60 * 60,
  connection_request: 24 * 60 * 60,
  post: 60 * 60,
  comment: 60 * 60,
  report: 60 * 60,
  media: 10 * 60,
};

export class SafetyActionError extends Error {
  statusCode: number;
  code: string;
  retryAfterSeconds?: number;
  retryable: boolean;

  constructor(
    message: string,
    code: string,
    statusCode = 403,
    retryAfterSeconds?: number,
    retryable?: boolean
  ) {
    super(message);
    this.name = 'SafetyActionError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
    this.retryable = retryable ?? (statusCode === 429 || statusCode >= 500);
  }
}

export function db(client?: PrismaClient | any): any {
  return client || prisma;
}

function safetyPepper(): string {
  return process.env.SAFETY_HASH_PEPPER || process.env.AUTH_OTP_PEPPER || process.env.JWT_SECRET || 'vormex-dev-safety-pepper';
}

export function hashSafetyValue(value: string): string {
  return crypto.createHmac('sha256', safetyPepper()).update(value.trim().toLowerCase()).digest('hex');
}

export function normalizePhoneE164(value: string): string | null {
  const normalized = String(value || '').replace(/[^\d+]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

export function maskPhone(value: string): string {
  const last4 = value.replace(/\D/g, '').slice(-4);
  return last4 ? `•••• ${last4}` : 'Verified phone';
}

export function maskEmail(value: string): string {
  const [local, domain] = String(value || '').toLowerCase().split('@');
  if (!local || !domain) return 'verified email';
  const visible = local.length <= 2 ? local[0] || '*' : `${local[0]}${local.slice(-1)}`;
  return `${visible.padEnd(Math.min(local.length, 4), '•')}@${domain}`;
}

export function trustLevelRank(level: string | null | undefined): number {
  const index = TRUST_LEVELS.indexOf((level || 'BASIC') as IdentityTrustLevel);
  return index >= 0 ? index : 0;
}

export function chooseHigherTrustLevel(a: string | null | undefined, b: IdentityTrustLevel): IdentityTrustLevel {
  return trustLevelRank(a) >= trustLevelRank(b) ? (a as IdentityTrustLevel) : b;
}

export function verificationBadgesForTrustLevel(level: string | null | undefined): string[] {
  const rank = trustLevelRank(level);
  const badges: string[] = [];
  if (rank >= trustLevelRank('EMAIL_VERIFIED')) badges.push('email');
  if (rank >= trustLevelRank('PHONE_VERIFIED')) badges.push('phone');
  if (rank >= trustLevelRank('STUDENT_VERIFIED')) badges.push('student');
  if (rank >= trustLevelRank('ID_VERIFIED')) badges.push('id');
  return badges;
}

export function publicTrustFields(level: string | null | undefined) {
  const identityTrustLevel = (TRUST_LEVELS.includes(level as IdentityTrustLevel)
    ? level
    : 'BASIC') as IdentityTrustLevel;
  return {
    identityTrustLevel,
    verificationBadges: verificationBadgesForTrustLevel(identityTrustLevel),
  };
}

function firstHeaderValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

function deviceLinkSecret(): string {
  return (
    process.env.DEVICE_LINK_SECRET ||
    process.env.JWT_SECRET ||
    process.env.AUTH_CSRF_SECRET ||
    'vormex-dev-device-link-secret'
  );
}

export function normalizeDeviceInstallId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!INSTALL_ID_PATTERN.test(value)) return null;
  return value;
}

export function normalizeDevicePlatform(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  const value = raw.trim().toLowerCase();
  return PLATFORM_PATTERN.test(value) ? value : 'unknown';
}

function hmacDeviceValue(kind: string, value: string): string {
  return crypto
    .createHmac('sha256', deviceLinkSecret())
    .update(`${kind}:${value}`)
    .digest('hex');
}

export function hashDeviceInstallCode(installId: string, platform = 'unknown'): string {
  return hmacDeviceValue('install', `${normalizeDevicePlatform(platform)}:${installId}`);
}

function hashOptionalDeviceValue(kind: string, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  return hmacDeviceValue(kind, value.slice(0, 512));
}

export function getDeviceSignalFromRequest(req: Request): {
  installHash: string;
  platform: string;
  userAgentHash: string | null;
  ipHash: string | null;
} | null {
  const installId = normalizeDeviceInstallId(firstHeaderValue(req.headers[INSTALL_ID_HEADER]));
  if (!installId) return null;
  const platform = normalizeDevicePlatform(firstHeaderValue(req.headers[PLATFORM_HEADER]));
  return {
    installHash: hashDeviceInstallCode(installId, platform),
    platform,
    userAgentHash: hashOptionalDeviceValue('ua', firstHeaderValue(req.headers['user-agent'])),
    ipHash: hashOptionalDeviceValue('ip', req.ip || req.socket?.remoteAddress || ''),
  };
}
