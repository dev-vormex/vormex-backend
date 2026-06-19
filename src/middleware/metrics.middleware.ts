import type { NextFunction, Request, Response } from 'express';
import { httpRequestDuration } from '../infrastructure/metrics/registry';

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    httpRequestDuration.observe(
      {
        method: req.method,
        route: req.route?.path || req.path || 'unknown',
        status_code: String(res.statusCode),
      },
      durationMs
    );
  });

  next();
}

const DEFAULT_METRICS_ALLOWED_NETWORKS = [
  '127.0.0.1/32',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
];

function parseMetricsAllowedNetworks(): string[] {
  const configured = (process.env.METRICS_ALLOWED_NETWORKS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return configured.length > 0 ? configured : DEFAULT_METRICS_ALLOWED_NETWORKS;
}

function normalizeIpAddress(value: string | undefined): string {
  const ip = String(value || '').trim();
  if (ip.startsWith('::ffff:')) {
    return ip.slice('::ffff:'.length);
  }
  return ip;
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = (result << 8) + octet;
  }

  return result >>> 0;
}

function isIpAllowedByNetwork(ip: string, network: string): boolean {
  const normalizedIp = normalizeIpAddress(ip);
  const normalizedNetwork = normalizeIpAddress(network);

  if (normalizedNetwork === normalizedIp) {
    return true;
  }

  if (normalizedNetwork === '::1/128' || normalizedNetwork === '::1') {
    return normalizedIp === '::1';
  }

  const [networkAddress, prefixText] = normalizedNetwork.split('/');
  if (!networkAddress || prefixText === undefined) {
    return false;
  }

  const ipInt = ipv4ToInt(normalizedIp);
  const networkInt = ipv4ToInt(networkAddress);
  const prefix = Number(prefixText);
  if (
    ipInt === null ||
    networkInt === null ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false;
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (networkInt & mask);
}

export function isMetricsIpAllowed(ip: string | undefined): boolean {
  const normalizedIp = normalizeIpAddress(ip);
  if (!normalizedIp) {
    return false;
  }

  return parseMetricsAllowedNetworks().some((network) =>
    isIpAllowedByNetwork(normalizedIp, network)
  );
}

export function requireMetricsIpAllowList(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!isMetricsIpAllowed(req.ip)) {
    res.status(403).json({ error: 'Metrics access denied' });
    return;
  }

  next();
}
