import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const MAX_REDIRECTS = 3;

function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function ipv4InCidr(address: string, network: string, bits: number): boolean {
  const value = ipv4ToNumber(address);
  const base = ipv4ToNumber(network);
  if (value === null || base === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

function expandIpv6(address: string): bigint | null {
  const stripped = address.toLowerCase().split('%')[0];
  if (stripped.includes('.')) {
    const lastColon = stripped.lastIndexOf(':');
    const ipv4 = ipv4ToNumber(stripped.slice(lastColon + 1));
    if (ipv4 === null) return null;
    address = `${stripped.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  } else {
    address = stripped;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6InCidr(address: string, network: string, bits: number): boolean {
  const value = expandIpv6(address);
  const base = expandIpv6(network);
  if (value === null || base === null) return false;
  const shift = BigInt(128 - bits);
  return (value >> shift) === (base >> shift);
}

/** True only for globally routable unicast addresses accepted by link preview fetching. */
export function isPublicOutboundAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const blocked: Array<[string, number]> = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return !blocked.some(([network, bits]) => ipv4InCidr(address, network, bits));
  }
  if (family === 6) {
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
    if (mapped) return isPublicOutboundAddress(mapped);
    const expanded = expandIpv6(address);
    const mappedPrefix = expandIpv6('::ffff:0:0');
    if (expanded !== null && mappedPrefix !== null && (expanded >> 32n) === (mappedPrefix >> 32n)) {
      const mappedNumber = Number(expanded & 0xffffffffn);
      const mappedAddress = [24, 16, 8, 0]
        .map((shift) => String((mappedNumber >>> shift) & 0xff))
        .join('.');
      return isPublicOutboundAddress(mappedAddress);
    }
    const blocked: Array<[string, number]> = [
      ['::', 96], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
      ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
      ['3fff::', 20], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
    ];
    return !blocked.some(([network, bits]) => ipv6InCidr(address, network, bits));
  }
  return false;
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  if (net.isIP(hostname)) {
    if (!isPublicOutboundAddress(hostname)) throw new Error('Outbound address is not public');
    return { address: hostname, family: net.isIP(hostname) as 4 | 6 };
  }

  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!answers.length || answers.some((answer) => !isPublicOutboundAddress(answer.address))) {
    throw new Error('Outbound hostname resolves to a non-public address');
  }
  return answers[0] as { address: string; family: 4 | 6 };
}

function validateTarget(input: string): URL {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public HTTP(S) URLs are supported');
  }
  const expectedPort = url.protocol === 'https:' ? '443' : '80';
  if (url.port && url.port !== expectedPort) {
    throw new Error('Non-standard outbound ports are not allowed');
  }
  return url;
}

async function requestPinnedText(url: URL, maxBytes: number, timeoutMs: number): Promise<{
  statusCode: number;
  location?: string;
  contentType?: string;
  body: string;
}> {
  const pinned = await resolvePublicAddress(url.hostname);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: url.hostname,
      headers: {
        Host: url.host,
        'User-Agent': 'VormexLinkPreview/1.0',
        Accept: 'text/html,application/xhtml+xml',
      },
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    }, (response) => {
      const statusCode = response.statusCode || 0;
      const location = typeof response.headers.location === 'string' ? response.headers.location : undefined;
      const contentType = typeof response.headers['content-type'] === 'string'
        ? response.headers['content-type'].split(';')[0].trim().toLowerCase()
        : undefined;
      const declaredLength = Number(response.headers['content-length'] || 0);
      if (declaredLength > maxBytes) {
        response.destroy(new Error('Outbound response exceeds size limit'));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (received > maxBytes) {
          response.destroy(new Error('Outbound response exceeds size limit'));
          return;
        }
        chunks.push(bytes);
      });
      response.on('end', () => resolve({
        statusCode,
        location,
        contentType,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Outbound request timed out')));
    request.on('error', reject);
    request.end();
  });
}

export async function fetchPublicHtml(
  input: string,
  options: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<string> {
  const maxBytes = Math.min(1024 * 1024, Math.max(1024, options.maxBytes || 512 * 1024));
  const timeoutMs = Math.min(10_000, Math.max(1_000, options.timeoutMs || 8_000));
  let target = validateTarget(input);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await requestPinnedText(target, maxBytes, timeoutMs);
    if (response.statusCode >= 300 && response.statusCode < 400 && response.location) {
      if (redirects === MAX_REDIRECTS) throw new Error('Too many outbound redirects');
      target = validateTarget(new URL(response.location, target).toString());
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error('Outbound server returned an invalid status');
    }
    if (!['text/html', 'application/xhtml+xml'].includes(response.contentType || '')) {
      throw new Error('Outbound response is not HTML');
    }
    return response.body;
  }
  throw new Error('Too many outbound redirects');
}
