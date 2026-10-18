import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const GOOD = 'k'.repeat(40);

test('production requires a strong SESSION_SECRET', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'short' }), /SESSION_SECRET/);
  assert.equal(loadConfig({ NODE_ENV: 'production', SESSION_SECRET: GOOD }).production, true);
});

test('production refuses DEV_LINKS', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: GOOD, DEV_LINKS: '1' }), /DEV_LINKS/);
});

test('production refuses a non-https QRZ_BASE_URL', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: GOOD, QRZ_BASE_URL: 'http://x.test/' }), /https/);
  const ok = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: GOOD, QRZ_BASE_URL: 'https://x.test/' });
  assert.equal(ok.qrzBaseUrl, 'https://x.test/');
});

test('cookie is Secure only for https base URLs; defaults are sane', () => {
  const dev = loadConfig({ SESSION_SECRET: GOOD });
  assert.equal(dev.secureCookie, false);
  assert.equal(dev.qrzBaseUrl, undefined);
  assert.equal(loadConfig({ SESSION_SECRET: GOOD, BASE_URL: 'https://n.example.org/' }).secureCookie, true);
});

test('listens on loopback by default; HOST overrides it', () => {
  assert.equal(loadConfig({ SESSION_SECRET: GOOD }).host, '127.0.0.1');
  assert.equal(loadConfig({ SESSION_SECRET: GOOD, HOST: '0.0.0.0' }).host, '0.0.0.0');
});

import { parseBaseUrl } from '../src/config.js';

test('BASE_URL: domains get HSTS and secure cookies', () => {
  const c = loadConfig({ SESSION_SECRET: GOOD, BASE_URL: 'https://nets.example.org/' });
  assert.equal(c.baseUrl, 'https://nets.example.org');
  assert.equal(c.secureCookie, true);
  assert.equal(c.hsts, true);
  assert.equal(c.baseIsIp, false);
});

test('BASE_URL: IPv4 and IPv6 addresses work; HSTS is off for them', () => {
  const v4 = loadConfig({ SESSION_SECRET: GOOD, BASE_URL: 'https://203.0.113.10' });
  assert.equal(v4.baseUrl, 'https://203.0.113.10');
  assert.equal(v4.baseIsIp, true);
  assert.equal(v4.secureCookie, true);
  assert.equal(v4.hsts, false);

  const v6 = loadConfig({ SESSION_SECRET: GOOD, BASE_URL: 'https://[2001:db8::10]:8443' });
  assert.equal(v6.baseUrl, 'https://[2001:db8::10]:8443');
  assert.equal(v6.baseIsIp, true);
  assert.equal(v6.hsts, false);
  assert.equal(parseBaseUrl('https://[2001:DB8::10]').hostname, '2001:db8::10');
});

test('BASE_URL: plain-HTTP IP installs work, are not secure-cookie, and are flagged', () => {
  const c = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: GOOD, BASE_URL: 'http://203.0.113.10' });
  assert.equal(c.secureCookie, false);
  assert.equal(c.plainHttp, true);
  assert.equal(c.hsts, false);
  // localhost over http is normal for development and is not flagged
  assert.equal(loadConfig({ SESSION_SECRET: GOOD }).plainHttp, false);
  assert.equal(loadConfig({ SESSION_SECRET: GOOD, BASE_URL: 'http://127.0.0.1:3200' }).plainHttp, false);
});

test('BASE_URL: bad values are rejected with a helpful message', () => {
  for (const bad of ['nets.example.org', 'ftp://x.example.org', 'https://x.example.org/app', 'https://user:pw@x.example.org', 'https://x.example.org/?a=1']) {
    assert.throws(() => loadConfig({ SESSION_SECRET: GOOD, BASE_URL: bad }), /BASE_URL/, bad);
  }
});
