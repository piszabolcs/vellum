import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  checkUrlSafety,
  clearRobotsCache,
  fetchPage,
  isBlockedAddress,
  setAddressFilterForTests,
} from './fetcher';

describe('isBlockedAddress', () => {
  it('blocks loopback, private, link-local and IPv6 forms that embed them', () => {
    const blocked = [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.5.4',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::127.0.0.1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::1',
      '2001::1',
      'fe80::1',
      'fd12:3456::1',
      'ff02::1',
      'not-an-ip',
    ];
    expect(blocked.filter((ip) => !isBlockedAddress(ip))).toEqual([]);
  });

  it('allows public unicast addresses, including IPv4-mapped public ones', () => {
    const allowed = ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '::ffff:93.184.216.34'];
    expect(allowed.filter((ip) => isBlockedAddress(ip))).toEqual([]);
  });
});

describe('checkUrlSafety', () => {
  it('rejects the bypasses found in the assessment and local host names', async () => {
    for (const url of [
      'http://[::ffff:127.0.0.1]/',
      'http://[::]/',
      'http://2130706433/',
      'http://foo.localhost/',
      'file:///C:/Windows/win.ini',
    ]) {
      expect((await checkUrlSafety(url)).ok, url).toBe(false);
    }
  });
});

describe('fetchPage against loopback fixtures', () => {
  const hits: string[] = [];
  let site: http.Server;
  let internal: http.Server;
  let sitePort = 0;
  let internalPort = 0;

  beforeAll(async () => {
    internal = http.createServer((req, res) => {
      hits.push(`internal:${req.url}`);
      res.end('internal');
    });
    site = http.createServer((req, res) => {
      hits.push(`site:${req.url}`);
      if (req.url === '/robots.txt') {
        res.writeHead(302, { Location: `http://127.0.0.1:${internalPort}/admin/reboot` });
        res.end();
      } else if (req.url === '/redirect-internal') {
        res.writeHead(302, { Location: `http://127.0.0.1:${internalPort}/secret` });
        res.end();
      } else if (req.url === '/slow') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write('<html><body>');
        const timer = setInterval(() => res.write('x'), 200);
        req.on('close', () => clearInterval(timer));
      } else if (req.url === '/big-gzip') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
        res.end(zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024, 'a')));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><p>hello</p></body></html>');
      }
    });
    await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    internalPort = (internal.address() as AddressInfo).port;
    sitePort = (site.address() as AddressInfo).port;
    // only the "public" fixture site counts as reachable
    setAddressFilterForTests((ip, port) => ip === '127.0.0.1' && port === sitePort);
  });

  afterEach(() => {
    hits.length = 0;
    clearRobotsCache();
  });

  afterAll(() => {
    setAddressFilterForTests(null);
    site.closeAllConnections();
    site.close();
    internal.close();
  });

  it('never follows a robots.txt redirect into the internal network', async () => {
    const result = await fetchPage(`http://127.0.0.1:${sitePort}/page`, { timeoutMs: 3000 });
    expect(result.ok).toBe(true);
    expect(hits).toContain('site:/robots.txt');
    expect(hits.some((h) => h.startsWith('internal:'))).toBe(false);
  });

  it('refuses a page redirect to a blocked address before requesting it', async () => {
    const result = await fetchPage(`http://127.0.0.1:${sitePort}/redirect-internal`, {
      respectRobotsTxt: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/redirect/);
    expect(hits).toEqual(['site:/redirect-internal']);
  });

  it('gives up on a trickling body within the deadline', async () => {
    const started = Date.now();
    const result = await fetchPage(`http://127.0.0.1:${sitePort}/slow`, {
      respectRobotsTxt: false,
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('caps the decompressed body size', async () => {
    const result = await fetchPage(`http://127.0.0.1:${sitePort}/big-gzip`, {
      respectRobotsTxt: false,
      maxBytes: 10_000,
    });
    expect(result.ok).toBe(true);
    expect(result.html?.length).toBe(10_000);
  });
});
