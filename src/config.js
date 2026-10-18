import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

export function loadDotEnv() {
  loadEnvFile(path.join(ROOT, '.env'));
}

/**
 * Validate BASE_URL and describe it. Works for domains and bare IP addresses (IPv4 or [IPv6]).
 * HSTS is only meaningful for real hostnames: browsers ignore it for IP addresses, and it would
 * make a self-signed certificate impossible to click through.
 */
export function parseBaseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`BASE_URL "${raw}" is not a valid URL. Examples: https://nets.example.org or https://203.0.113.10`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('BASE_URL must start with http:// or https://');
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) {
    throw new Error('BASE_URL must be just the address (scheme, host, optional port), with no path.');
  }
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  const isIp = net.isIP(hostname) !== 0;
  const https = u.protocol === 'https:';
  return {
    baseUrl: `${u.protocol}//${u.host}`,
    https,
    hostname,
    isIp,
    hsts: https && !isIp && hostname !== 'localhost',
    loopback: hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname),
  };
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const devLinks = env.DEV_LINKS === '1';
  const port = Number(env.PORT || 3000);
  const base = parseBaseUrl(env.BASE_URL || `http://localhost:${port}`);
  const dataFile = path.resolve(ROOT, env.DATA_FILE || 'data/db.json');

  if (production && devLinks) {
    throw new Error('DEV_LINKS=1 is not allowed when NODE_ENV=production.');
  }

  const qrzBaseUrl = env.QRZ_BASE_URL || undefined; // for tests and QRZ-compatible mirrors
  if (production && qrzBaseUrl && !qrzBaseUrl.startsWith('https://')) {
    throw new Error('QRZ_BASE_URL must use https:// in production (credentials are sent in the query).');
  }

  let secret = env.SESSION_SECRET || '';
  if (production) {
    if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters in production.');
  } else if (!secret) {
    // Dev convenience: persist a random secret so sessions survive restarts.
    const f = path.join(path.dirname(dataFile), '.dev-secret');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    secret = fs.readFileSync(f, 'utf8').trim();
  }

  return {
    production,
    devLinks,
    port,
    host: env.HOST || '127.0.0.1', // loopback by default: put a TLS proxy in front, or set HOST=0.0.0.0
    baseUrl: base.baseUrl,
    baseIsIp: base.isIp,
    secureCookie: base.https,
    hsts: base.hsts,
    plainHttp: !base.https && !base.loopback,
    secret,
    dataFile,
    avatarDir: path.resolve(ROOT, env.AVATAR_DIR || path.join(path.dirname(dataFile), 'avatars')), // profile pictures live beside the data file
    trustProxy: env.TRUST_PROXY === '1',
    mailWebhookUrl: env.MAIL_WEBHOOK_URL || '',
    mailWebhookToken: env.MAIL_WEBHOOK_TOKEN || '',
    mongoUri: env.MONGODB_URI || '',
    mongoDb: env.MONGODB_DB || 'net-logger-plus',
    qrzUsername: env.QRZ_USERNAME || '',
    qrzPassword: env.QRZ_PASSWORD || '',
    qrzRequire: env.QRZ_REQUIRE === '1',
    qrzBaseUrl,
  };
}
