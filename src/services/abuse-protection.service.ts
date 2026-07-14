import type { AuthenticatedRequest } from '../types/auth.types';
import type { RateLimitRule } from './rate-limit.service';
import { hashRateLimitIdentifier } from '../utils/auth-security.util';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const TEN_MINUTES = 10 * MINUTE;

const HIGH_CONFIDENCE_SCANNER_UA =
  /\b(sqlmap|nikto|nmap|masscan|zgrab|dirbuster|gobuster|ffuf|dirsearch|nuclei|openvas|nessus|acunetix|metasploit|wpscan)\b/i;

const SCRIPT_LIKE_UA =
  /\b(curl|wget|python-requests|aiohttp|scrapy|go-http-client|libwww-perl|phpcrawl|node-fetch|axios|httpie|java\/|apache-httpclient|headlesschrome|phantomjs)\b/i;

const READ_HEAVY_PATHS = [
  /^\/api\/feed(?:\/|$)/,
  /^\/api\/people(?:\/|$)/,
  /^\/api\/posts\/feed(?:\/|$)/,
  /^\/api\/reels(?:\/|$)/,
  /^\/api\/users\/[^/]+\/profile(?:\/|$)/,
  /^\/api\/social-proof(?:\/|$)/,
  /^\/api\/matching(?:\/|$)/,
  /^\/api\/mentions\/search(?:\/|$)/,
];

const AI_PATHS = [
  /^\/api\/ai\/chat(?:\/|$)/,
  /^\/api\/agent(?:\/|$)/,
];

const PAYMENT_PATHS = [
  /^\/api\/premium\/checkout(?:\/|$)/,
  /^\/api\/premium\/verify(?:\/|$)/,
  /^\/api\/premium\/cancel(?:\/|$)/,
];

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function getNormalizedApiPath(req: AuthenticatedRequest): string {
  const originalPath = (req.originalUrl || req.url || '').split('?')[0] || '/';
  const normalized = originalPath.replace(/\/+$/, '') || '/';
  return normalized.startsWith('/api') ? normalized : `/api${normalized.startsWith('/') ? '' : '/'}${normalized}`;
}

export function isHighConfidenceScannerUserAgent(userAgent: string | undefined): boolean {
  return HIGH_CONFIDENCE_SCANNER_UA.test(userAgent || '');
}

export function isScriptLikeUserAgent(userAgent: string | undefined): boolean {
  return SCRIPT_LIKE_UA.test(userAgent || '');
}

export function isReadHeavyApiPath(path: string): boolean {
  return READ_HEAVY_PATHS.some((pattern) => pattern.test(path));
}

export function isSensitiveAiPath(path: string): boolean {
  return AI_PATHS.some((pattern) => pattern.test(path));
}

export function isPaymentPath(path: string): boolean {
  return PAYMENT_PATHS.some((pattern) => pattern.test(path));
}

export function isSensitiveApiPath(path: string): boolean {
  return isSensitiveAiPath(path) || isPaymentPath(path);
}

function clientFingerprint(req: AuthenticatedRequest): string {
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 256);
  const acceptLanguage = String(req.headers['accept-language'] || '').slice(0, 128);
  const clientHeader = String(req.headers['x-vormex-client'] || '').slice(0, 64);
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return hashRateLimitIdentifier(`${ip}|${userAgent}|${acceptLanguage}|${clientHeader}`);
}

export function resolveGeneralApiRateLimitRules(req: AuthenticatedRequest): RateLimitRule[] {
  const path = getNormalizedApiPath(req);
  const method = req.method.toUpperCase();
  const userId = req.user?.userId ? String(req.user.userId) : null;
  const userAgent = String(req.headers['user-agent'] || '');
  const scriptLikeClient = isScriptLikeUserAgent(userAgent);
  const missingUserAgent = userAgent.trim().length === 0;
  const readHeavy = isReadHeavyApiPath(path);
  const writeRequest = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  // Authenticated UI traffic fans out across feed, notifications, chat, and
  // profile data. Keep anonymous limits conservative, but do not let one
  // signed-in browser or a campus/mobile NAT exhaust the anonymous buckets.
  const ipBurstLimit = userId
    ? intEnv('RATE_LIMIT_AUTH_API_IP_PER_MINUTE', 1200)
    : intEnv('RATE_LIMIT_API_IP_PER_MINUTE', 120);
  const ipSustainedLimit = userId
    ? intEnv('RATE_LIMIT_AUTH_API_IP_PER_HOUR', 20_000)
    : intEnv('RATE_LIMIT_API_IP_PER_HOUR', 3000);
  const fingerprintBurstLimit = userId
    ? intEnv('RATE_LIMIT_AUTH_API_FINGERPRINT_PER_MINUTE', 600)
    : intEnv('RATE_LIMIT_API_FINGERPRINT_PER_MINUTE', 90);
  const rules: RateLimitRule[] = [
    {
      keyPrefix: 'rate:ip:api:burst',
      limit: ipBurstLimit,
      windowSeconds: MINUTE,
      code: 'api_rate_limited',
      message: 'Too many API requests. Please slow down and try again shortly.',
    },
    {
      keyPrefix: 'rate:ip:api:sustained',
      limit: ipSustainedLimit,
      windowSeconds: HOUR,
      code: 'api_rate_limited',
      message: 'Too many API requests. Please try again later.',
    },
    {
      keyPrefix: 'rate:fingerprint:api:burst',
      limit: fingerprintBurstLimit,
      windowSeconds: MINUTE,
      identifier: clientFingerprint,
      code: 'api_rate_limited',
      message: 'Too many API requests from this client. Please slow down.',
    },
  ];

  if (userId) {
    rules.push(
      {
        keyPrefix: 'rate:user:api:burst',
        limit: intEnv('RATE_LIMIT_API_USER_PER_MINUTE', 600),
        windowSeconds: MINUTE,
        code: 'api_rate_limited',
        message: 'Too many API requests. Please slow down and try again shortly.',
      },
      {
        keyPrefix: 'rate:user:api:sustained',
        limit: intEnv('RATE_LIMIT_API_USER_PER_HOUR', 10000),
        windowSeconds: HOUR,
        code: 'api_rate_limited',
        message: 'Too many API requests. Please try again later.',
      }
    );
  } else {
    rules.push({
      keyPrefix: 'rate:ip:api:anonymous:sustained',
      limit: intEnv('RATE_LIMIT_API_ANON_IP_PER_HOUR', 900),
      windowSeconds: HOUR,
      code: 'anonymous_api_rate_limited',
      message: 'Too many anonymous API requests. Please sign in or try again later.',
    });
  }

  if (writeRequest) {
    rules.push({
      keyPrefix: 'rate:ip:api:write',
      limit: intEnv('RATE_LIMIT_API_WRITE_IP_PER_MINUTE', 80),
      windowSeconds: MINUTE,
      code: 'write_rate_limited',
      message: 'Too many write requests. Please wait before trying again.',
    });

    if (userId) {
      rules.push({
        keyPrefix: 'rate:user:api:write',
        limit: intEnv('RATE_LIMIT_API_WRITE_USER_PER_MINUTE', 240),
        windowSeconds: MINUTE,
        code: 'write_rate_limited',
        message: 'Too many write requests. Please wait before trying again.',
      });
    } else {
      rules.push({
        keyPrefix: 'rate:ip:api:anonymous:write',
        limit: intEnv('RATE_LIMIT_API_ANON_WRITE_IP_PER_10_MINUTES', 60),
        windowSeconds: TEN_MINUTES,
        code: 'anonymous_write_rate_limited',
        message: 'Too many anonymous write requests. Please wait before trying again.',
      });
    }
  }

  if (readHeavy) {
    rules.push({
      keyPrefix: 'rate:ip:api:read-heavy',
      limit: intEnv('RATE_LIMIT_READ_HEAVY_IP_PER_MINUTE', userId ? 180 : 60),
      windowSeconds: MINUTE,
      code: 'read_rate_limited',
      message: 'Too many read requests. Please slow down before loading more.',
    });

    if (userId) {
      rules.push({
        keyPrefix: 'rate:user:api:read-heavy',
        limit: intEnv('RATE_LIMIT_READ_HEAVY_USER_PER_MINUTE', 360),
        windowSeconds: MINUTE,
        code: 'read_rate_limited',
        message: 'Too many read requests. Please slow down before loading more.',
      });
    } else {
      rules.push({
        keyPrefix: 'rate:ip:api:anonymous:read-heavy:sustained',
        limit: intEnv('RATE_LIMIT_READ_HEAVY_ANON_IP_PER_HOUR', 600),
        windowSeconds: HOUR,
        code: 'scrape_rate_limited',
        message: 'Too many public profile/feed requests. Please slow down.',
      });
    }
  }

  if (scriptLikeClient || (missingUserAgent && !userId)) {
    rules.push(
      {
        keyPrefix: 'rate:ip:api:automated:burst',
        limit: intEnv('RATE_LIMIT_AUTOMATED_IP_PER_MINUTE', 20),
        windowSeconds: MINUTE,
        code: 'automated_client_rate_limited',
        message: 'Automated traffic is being rate limited. Please slow down.',
      },
      {
        keyPrefix: 'rate:ip:api:automated:sustained',
        limit: intEnv('RATE_LIMIT_AUTOMATED_IP_PER_HOUR', 150),
        windowSeconds: HOUR,
        code: 'automated_client_rate_limited',
        message: 'Automated traffic is being rate limited. Please try again later.',
      }
    );
  }

  return rules;
}

export function resolveSensitiveActionRateLimitRules(
  req: AuthenticatedRequest,
  scope: 'payment' | 'ai'
): RateLimitRule[] {
  const isPayment = scope === 'payment';
  const prefix = isPayment ? 'payment' : 'ai';
  const message = isPayment
    ? 'Payment actions are cooling down. Please wait before trying again.'
    : 'AI requests are cooling down. Please wait before trying again.';
  const code = isPayment ? 'payment_rate_limited' : 'ai_rate_limited';

  return [
    {
      keyPrefix: `rate:ip:sensitive:${prefix}:burst`,
      limit: intEnv(
        isPayment ? 'RATE_LIMIT_PAYMENT_IP_PER_10_MINUTES' : 'RATE_LIMIT_AI_IP_PER_10_MINUTES',
        isPayment ? 20 : 40
      ),
      windowSeconds: TEN_MINUTES,
      code,
      message,
    },
    {
      keyPrefix: `rate:user:sensitive:${prefix}:burst`,
      limit: intEnv(
        isPayment ? 'RATE_LIMIT_PAYMENT_USER_PER_10_MINUTES' : 'RATE_LIMIT_AI_USER_PER_10_MINUTES',
        isPayment ? 6 : 20
      ),
      windowSeconds: TEN_MINUTES,
      code,
      message,
    },
    {
      keyPrefix: `rate:ip:sensitive:${prefix}:sustained`,
      limit: intEnv(
        isPayment ? 'RATE_LIMIT_PAYMENT_IP_PER_HOUR' : 'RATE_LIMIT_AI_IP_PER_HOUR',
        isPayment ? 60 : 120
      ),
      windowSeconds: HOUR,
      code,
      message,
    },
    {
      keyPrefix: `rate:user:sensitive:${prefix}:sustained`,
      limit: intEnv(
        isPayment ? 'RATE_LIMIT_PAYMENT_USER_PER_HOUR' : 'RATE_LIMIT_AI_USER_PER_HOUR',
        isPayment ? 20 : 60
      ),
      windowSeconds: HOUR,
      code,
      message,
    },
  ];
}
