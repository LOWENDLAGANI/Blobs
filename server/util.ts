import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { SECRET_KEY } from './env.ts';

export const now = (): number => Date.now();

export function id(prefix = ''): string {
  const raw = crypto.randomBytes(9).toString('base64url');
  return prefix ? `${prefix}_${raw}` : raw;
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** AES-256-GCM encryption for stored third-party credentials. */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function decrypt(payload: string): string | null {
  try {
    const [ivPart, tagPart, dataPart] = payload.split('.');
    if (!ivPart || !tagPart || !dataPart) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} characters]`;
}

/** Strip HTML into readable text without pulling in a parser dependency. */
export function htmlToText(html: string): string {
  let out = html;
  out = out.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  out = out.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  out = out.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  out = out.replace(/<\/(p|div|section|article|li|h[1-6]|tr|br|blockquote)>/gi, '\n');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<[^>]+>/g, ' ');
  out = out
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  out = out.replace(/[ \t\f\v]+/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

export function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? htmlToText(match[1]).slice(0, 200) : '';
}

/** Dotted quad for an IPv4-mapped/compatible IPv6 literal, else null. */
function mappedIpv4(host: string): string | null {
  const match = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!match) return null;
  const high = parseInt(match[1] as string, 16);
  const low = parseInt(match[2] as string, 16);
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/** Reject loopback / private / link-local targets so tools cannot probe the host. */
export function isPrivateAddress(hostname: string): boolean {
  // URL.hostname keeps the brackets around an IPv6 literal and the trailing dot
  // of an absolute name ("localhost."), so normalise before classifying.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(host)) {
    const mapped = mappedIpv4(host);
    if (mapped) return isPrivateAddress(mapped);
    return (
      host === '::1' ||
      host === '::' ||
      host.startsWith('fc') || // unique-local fc00::/7
      host.startsWith('fd') ||
      /^fe[89ab]/.test(host) || // link-local fe80::/10
      host.startsWith('ff') // multicast ff00::/8
    );
  }
  return false;
}

export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs can be fetched.');
  }
  if (isPrivateAddress(url.hostname)) {
    throw new Error('Refusing to fetch a private or local address.');
  }
  return url;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 20_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a hostname the way the request will and refuse it if ANY address is
 * private. Checking the literal is not enough: names such as `localtest.me`,
 * `127.0.0.1.nip.io` or a rebinding domain look public but resolve to loopback
 * or a private range.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (isPrivateAddress(hostname)) {
    throw new Error('Refusing to fetch a private or local address.');
  }
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return; // a public literal, already classified above
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve ${host}.`);
  }
  if (!addresses.length) throw new Error(`Could not resolve ${host}.`);
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('Refusing to fetch a hostname that resolves to a private or local address.');
  }
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * Fetch a URL that came from the model, a search result or a page with the SSRF
 * guard applied to the original host, to its resolved addresses and to every
 * redirect hop. Redirects are followed by hand so `redirect: 'follow'` cannot
 * walk from a public page into the host's own network after the first check.
 */
export async function fetchPublicUrl(
  raw: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<Response> {
  let target = assertPublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(target.hostname);
    const response = await fetchWithTimeout(
      target.toString(),
      { ...init, redirect: 'manual' },
      timeoutMs,
    );
    if (!REDIRECT_STATUS.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    try {
      await response.body?.cancel();
    } catch {
      /* the redirect body is not needed; a failed cancel must not mask the hop */
    }
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      throw new Error('The page redirected to an invalid URL.');
    }
    target = assertPublicUrl(next.toString());
  }
  throw new Error('Too many redirects.');
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export type AutonomyState = 'active' | 'paused' | 'stopped';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
