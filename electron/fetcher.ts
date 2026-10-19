// ============================================================================
// vellum - fetcher.ts (F8)
// ============================================================================
// Safe page download for the deep web search.
//
// This module opens the prompt-injection surface (Haverom only ever used
// search snippets), so the security checks are the reason it exists:
//
//   1. SSRF: every hop (first request, each redirect, robots.txt) resolves the
//      host ONCE, rejects loopback / private / link-local / reserved ranges
//      (IPv4, IPv6, IPv4-mapped / -compatible IPv6, NAT64, 6to4, Teredo) and
//      then connects to exactly that validated address (DNS pinning via a
//      custom `lookup`), so a second DNS answer cannot rebind to 127.0.0.1.
//   2. Redirects are followed by hand (max 3), each one re-checked BEFORE it
//      is requested.
//   3. One deadline covers connect + headers + body, and the body is capped
//      (after decompression), so a slow or huge page cannot stall the reply.
// ============================================================================

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { lookup } from 'node:dns/promises';
import type { Readable } from 'node:stream';

// ----------------------------------------------------------------------------
// limits
// ----------------------------------------------------------------------------

const MAX_BYTES = 500 * 1024; // 500 kB of (decompressed) body
const TIMEOUT_MS = 10_000; // whole download: connect + headers + body
const ROBOTS_TIMEOUT_MS = 5_000;
const ROBOTS_MAX_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
// No version number here on purpose: package.json is the single version source.
const USER_AGENT = 'Mozilla/5.0 (compatible; Vellum local assistant)';

// ----------------------------------------------------------------------------
// address policy
// ----------------------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

/** Blocked IPv4 ranges: "this network", private, CGNAT, loopback, link-local
 *  (cloud metadata), IETF/test/benchmark/documentation, 6to4 relay, multicast,
 *  reserved and broadcast. */
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const BLOCKED_V4_RANGES = BLOCKED_V4.map(([base, bits]) => ({
  base: ipv4ToInt(base) as number,
  mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0,
}));

function isBlockedV4(value: number): boolean {
  return BLOCKED_V4_RANGES.some(({ base, mask }) => ((value & mask) >>> 0) === base);
}

/** Expands an IPv6 literal (optionally with an embedded dotted IPv4 tail and
 *  a zone id) to its 8 16-bit groups. Returns null for anything malformed. */
export function parseIpv6(ip: string): number[] | null {
  let s = ip.split('%')[0].toLowerCase();
  const lastColon = s.lastIndexOf(':');
  if (lastColon === -1) return null;

  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;

  const groups = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isBlockedV6(g: number[]): boolean {
  const embeddedV4 = ((g[6] << 16) | g[7]) >>> 0;
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);

  // :: and ::1
  if (zeroUpTo(7) && (g[7] === 0 || g[7] === 1)) return true;
  // ::ffff:a.b.c.d (IPv4-mapped) -> judge the embedded IPv4
  if (zeroUpTo(5) && g[5] === 0xffff) return isBlockedV4(embeddedV4);
  // ::a.b.c.d (deprecated IPv4-compatible)
  if (zeroUpTo(6)) return isBlockedV4(embeddedV4);
  // 64:ff9b::/96 NAT64 well-known prefix -> embedded IPv4
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedV4(embeddedV4);
  }
  // 2002::/16 6to4 -> the IPv4 sits in groups 1-2
  if (g[0] === 0x2002) return isBlockedV4(((g[1] << 16) | g[2]) >>> 0);
  // 2001::/32 Teredo (obfuscated IPv4) and 2001:db8::/32 documentation
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0x0db8)) return true;
  // only global unicast (2000::/3) is reachable; this also rejects ULA
  // fc00::/7, link-local fe80::/10, site-local, multicast, 64:ff9b:1::/48 ...
  return (g[0] & 0xe000) !== 0x2000;
}

/** True when the address must never be contacted (or is not an IP at all). */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  const family = net.isIP(bare.split('%')[0]);
  if (family === 4) return isBlockedV4(ipv4ToInt(bare) as number);
  if (family === 6) {
    const groups = parseIpv6(bare);
    return groups === null || isBlockedV6(groups);
  }
  return true;
}

/** Test seam: lets the unit tests talk to a loopback fixture server. */
let addressFilterForTests: ((ip: string, port: number) => boolean) | null = null;

export function setAddressFilterForTests(
  filter: ((ip: string, port: number) => boolean) | null,
): void {
  addressFilterForTests = filter;
}

export interface UrlCheckResult {
  ok: boolean;
  error?: string;
  /** the validated address the connection will be pinned to */
  resolvedIp?: string;
  family?: 4 | 6;
}

const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home\.arpa)$/;

/**
 * Checks whether a URL may be downloaded and resolves its host once.
 * The host name is resolved here (not only string-matched), because anyone
 * can register a domain that points to 127.0.0.1.
 */
export async function checkUrlSafety(rawUrl: string): Promise<UrlCheckResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'invalid URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `unsupported protocol: ${url.protocol}` };
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const allowed = (ip: string) =>
    addressFilterForTests ? addressFilterForTests(ip, port) : !isBlockedAddress(ip);

  if (LOCAL_NAME.test(hostname)) {
    return { ok: false, error: 'local host names are not allowed' };
  }

  const literalFamily = net.isIP(hostname);
  if (literalFamily !== 0) {
    if (!allowed(hostname)) {
      return { ok: false, error: 'private, loopback or reserved addresses are not allowed' };
    }
    return { ok: true, resolvedIp: hostname, family: literalFamily as 4 | 6 };
  }

  try {
    const resolved = await lookup(hostname, { all: true, verbatim: true });
    if (resolved.length === 0) return { ok: false, error: 'the domain does not resolve' };
    if (resolved.some((entry) => !allowed(entry.address))) {
      return {
        ok: false,
        error: 'the domain resolves to a private address (possible SSRF attempt)',
      };
    }
    return {
      ok: true,
      resolvedIp: resolved[0].address,
      family: resolved[0].family === 6 ? 6 : 4,
    };
  } catch {
    return { ok: false, error: 'the domain does not resolve' };
  }
}

// ----------------------------------------------------------------------------
// one pinned HTTP(S) request
// ----------------------------------------------------------------------------

interface RawResponse {
  status: number;
  location: string | null;
  contentType: string;
  body: Buffer;
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/** Decompresses (if needed) and collects at most `maxBytes` of the body. */
function readBody(res: http.IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
  let stream: Readable = res;
  if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
  else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
  else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const onAbort = () => {
      res.destroy();
      if (stream !== res) stream.destroy();
      finish(abortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (chunk: Buffer) => {
      const room = maxBytes - total;
      if (room <= 0) return;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      total += Math.min(chunk.length, room);
      if (total >= maxBytes) {
        // enough: stop downloading, keep what we have
        res.destroy();
        if (stream !== res) stream.destroy();
        finish();
      }
    });
    stream.on('end', () => finish());
    stream.on('error', (error) => finish(signal.aborted ? abortError() : error));
    res.on('close', () => {
      if (!res.complete) finish(signal.aborted ? abortError() : new Error('connection closed'));
    });
  });
}

function requestPinned(
  url: URL,
  pinned: { address: string; family: 4 | 6 },
  signal: AbortSignal,
  maxBytes: number,
  accept: string,
): Promise<RawResponse> {
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }

    const req = transport.request(
      url,
      {
        method: 'GET',
        // no pooling: every request gets its own socket to the pinned address
        agent: false,
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: accept,
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en,hu;q=0.8',
        },
        // DNS pinning: connect to the address that was validated, never to
        // whatever a second resolution would return. (Node may ask for
        // `all: true` because of happy-eyeballs, so both shapes are served.)
        lookup: ((
          _hostname: string,
          options: { all?: boolean },
          callback: (...args: unknown[]) => void,
        ) => {
          if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
          else callback(null, pinned.address, pinned.family);
        }) as unknown as net.LookupFunction,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = status >= 300 && status < 400 ? (res.headers.location ?? null) : null;
        const contentType = String(res.headers['content-type'] ?? '');

        if (location || status < 200 || status >= 300) {
          res.resume();
          resolve({ status, location, contentType, body: Buffer.alloc(0) });
          return;
        }

        readBody(res, maxBytes, signal)
          .then((body) => resolve({ status, location: null, contentType, body }))
          .catch(reject);
      },
    );

    req.on('error', (error) => reject(signal.aborted ? abortError() : error));
    req.end();
  });
}

interface SafeGetResult {
  ok: boolean;
  status?: number;
  finalUrl?: string;
  contentType?: string;
  body?: Buffer;
  error?: string;
}

/**
 * GET with the full SSRF policy on every hop and manual redirects.
 * The caller owns the deadline through `signal`.
 */
async function safeGet(
  rawUrl: string,
  signal: AbortSignal,
  maxBytes: number,
  accept: string,
): Promise<SafeGetResult> {
  let currentUrl = rawUrl;

  for (let redirects = 0; ; redirects++) {
    const safety = await checkUrlSafety(currentUrl);
    if (!safety.ok || !safety.resolvedIp || !safety.family) {
      return {
        ok: false,
        error:
          redirects === 0
            ? safety.error
            : `the redirect points to an unsafe location: ${safety.error}`,
      };
    }
    if (signal.aborted) throw abortError();

    const response = await requestPinned(
      new URL(currentUrl),
      { address: safety.resolvedIp, family: safety.family },
      signal,
      maxBytes,
      accept,
    );

    if (!response.location) {
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        finalUrl: currentUrl,
        contentType: response.contentType,
        body: response.body,
        error: response.status >= 200 && response.status < 300 ? undefined : `HTTP ${response.status}`,
      };
    }

    if (redirects >= MAX_REDIRECTS) {
      return { ok: false, error: `too many redirects (${MAX_REDIRECTS})` };
    }
    // Location may be relative: resolve it against the current URL
    currentUrl = new URL(response.location, currentUrl).toString();
  }
}

// ----------------------------------------------------------------------------
// robots.txt
// ----------------------------------------------------------------------------

const robotsCache = new Map<string, { disallowed: string[]; fetchedAt: number }>();
const ROBOTS_CACHE_MS = 60 * 60 * 1000;

/** Disallow prefixes of the `User-agent: *` group (deliberately minimal). */
export function parseRobotsDisallow(text: string): string[] {
  let inWildcardBlock = false;
  const disallowed: string[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim().toLowerCase();
    if (trimmed.startsWith('user-agent:')) {
      inWildcardBlock = trimmed.slice('user-agent:'.length).trim() === '*';
      continue;
    }
    if (inWildcardBlock && trimmed.startsWith('disallow:')) {
      const prefix = trimmed.slice('disallow:'.length).trim();
      if (prefix.length > 0) disallowed.push(prefix);
    }
  }
  return disallowed;
}

/**
 * Polite robots.txt check. The robots request goes through the same
 * SSRF-checked, pinned, redirect-by-hand path as the page itself; if it cannot
 * be fetched safely we treat the site as having no robots.txt.
 */
async function isAllowedByRobots(url: URL, pageSignal: AbortSignal): Promise<boolean> {
  const origin = url.origin;
  const cached = robotsCache.get(origin);
  let disallowed = cached && Date.now() - cached.fetchedAt < ROBOTS_CACHE_MS ? cached.disallowed : null;

  if (!disallowed) {
    // the robots request also lives inside the page deadline
    const signal = AbortSignal.any([pageSignal, AbortSignal.timeout(ROBOTS_TIMEOUT_MS)]);
    try {
      const result = await safeGet(`${origin}/robots.txt`, signal, ROBOTS_MAX_BYTES, 'text/plain');
      disallowed = result.ok && result.body ? parseRobotsDisallow(result.body.toString('utf-8')) : [];
    } catch {
      disallowed = [];
    }
    if (pageSignal.aborted) throw abortError();
    robotsCache.set(origin, { disallowed, fetchedAt: Date.now() });
  }

  const pathname = url.pathname.toLowerCase();
  return !disallowed.some((prefix) => pathname.startsWith(prefix));
}

/** Test helper: forget cached robots.txt decisions. */
export function clearRobotsCache(): void {
  robotsCache.clear();
}

// ----------------------------------------------------------------------------
// public API
// ----------------------------------------------------------------------------

export interface FetchResult {
  ok: boolean;
  html?: string;
  finalUrl?: string;
  contentType?: string;
  error?: string;
  durationMs: number;
}

export interface FetchOptions {
  respectRobotsTxt?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Downloads one page with all safety checks. Never throws. */
export async function fetchPage(rawUrl: string, options?: FetchOptions): Promise<FetchResult> {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = options?.maxBytes ?? MAX_BYTES;
  const done = (result: Omit<FetchResult, 'durationMs'>): FetchResult => ({
    ...result,
    durationMs: Date.now() - startedAt,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return done({ ok: false, error: 'invalid URL' });
    }

    if (options?.respectRobotsTxt !== false && !(await isAllowedByRobots(url, controller.signal))) {
      return done({ ok: false, error: "the site's robots.txt disallows this page" });
    }

    const result = await safeGet(rawUrl, controller.signal, maxBytes, 'text/html,application/xhtml+xml');
    if (!result.ok || !result.body) return done({ ok: false, error: result.error ?? 'download failed' });

    const contentType = result.contentType ?? '';
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return done({ ok: false, error: `not a text document: ${contentType}` });
    }

    return done({
      ok: true,
      html: result.body.toString('utf-8'),
      finalUrl: result.finalUrl ?? rawUrl,
      contentType,
    });
  } catch (error) {
    const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    return done({
      ok: false,
      error: aborted
        ? `timed out (${timeoutMs} ms)`
        : error instanceof Error
          ? error.message
          : 'unknown error',
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads several pages in parallel. One failure does not stop the others.
 */
export async function fetchPages(
  urls: string[],
  options?: FetchOptions,
): Promise<{ url: string; result: FetchResult }[]> {
  return Promise.all(urls.map(async (url) => ({ url, result: await fetchPage(url, options) })));
}
