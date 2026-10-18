import { clean } from './domain.js';

const BASE = 'https://xmldata.qrz.com/xml/current/';
const POSITIVE_TTL = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 10 * 60 * 1000; // "not found", and errors QRZ itself reports (e.g. subscription required)
const FAILURE_TTL = 60 * 1000; // network trouble and timeouts: try again soon, but not on every request
const COOLDOWN = 5 * 60 * 1000; // after a failed login, stop hitting QRZ for a while
const MAX_CACHE = 5000;
const MAX_CONCURRENT = 3; // be polite to QRZ when many callsigns are looked up at once (e.g. /ci A B C ...)

const unxml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Flat tag -> value map for one element's body. QRZ records contain no nested elements. */
function fields(xml) {
  const out = {};
  for (const m of xml.matchAll(/<([A-Za-z_][\w-]*)>([^<]*)<\/\1>/g)) out[m[1].toLowerCase()] = unxml(m[2].trim());
  return out;
}

function block(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : null;
}

/**
 * Only what the ledger shows leaves this module: a first name and a location. No street address, email, phone,
 * grid square or licence details are kept.
 * @returns {{name:string, location:string}}
 */
export function toInfo(rec) {
  const location = [rec.addr2, rec.state, rec.country].filter(Boolean).join(', ');
  const first = (rec.fname || '').split(' ')[0];
  return {
    name: clean(first, 40),
    location: clean(location, 80),
  };
}

/**
 * QRZ XML client (requires a QRZ XML data subscription).
 * lookup() resolves to {status: 'found', info} | {status: 'notfound'} | {status: 'unavailable'}.
 * It never throws, so callers can treat QRZ as best-effort.
 */
export function createQrz({ username, password, baseUrl = BASE, fetchFn = fetch, now = () => Date.now(), timeoutMs = 5000 }) {
  const enabled = Boolean(username && password);
  let key = null;
  let blockedUntil = 0;
  const cache = new Map();
  const inflight = new Map();
  let loginInFlight = null;
  let active = 0;
  const waiting = [];

  /** Run at most MAX_CONCURRENT requests against QRZ at a time; the rest queue up in order. */
  const limited = (fn) =>
    new Promise((resolve, reject) => {
      const start = () => {
        active += 1;
        fn().then(resolve, reject).finally(() => {
          active -= 1;
          waiting.shift()?.();
        });
      };
      if (active < MAX_CONCURRENT) start();
      else waiting.push(start);
    });

  async function get(params) {
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join(';'); // QRZ's documented style
    const res = await fetchFn(`${baseUrl}?${qs}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!res.ok) throw new Error(`QRZ HTTP ${res.status}`);
    return res.text();
  }

  async function login() {
    const xml = await get({ username, password, agent: 'net-logger-plus-1.0' });
    const session = fields(block(xml, 'Session') || '');
    if (!session.key) {
      blockedUntil = now() + COOLDOWN;
      throw new Error(`QRZ login failed: ${session.error || 'no session key'}`);
    }
    key = session.key;
  }

  /** Everyone who needs a session waits on the same login instead of each starting their own. */
  async function ensureLogin() {
    if (key) return;
    loginInFlight ??= login().finally(() => { loginInFlight = null; });
    await loginInFlight;
  }

  async function query(call, retry = true) {
    await ensureLogin();
    const xml = await get({ s: key, callsign: call });
    const session = fields(block(xml, 'Session') || '');
    if (!session.key) {
      // Per the QRZ spec: a response without a Key means the session ended. Log in again once.
      key = null;
      if (retry) return query(call, false);
      throw new Error('QRZ session could not be re-established');
    }
    key = session.key;
    const rec = block(xml, 'Callsign');
    if (rec) return { status: 'found', info: toInfo(fields(rec)) };
    if (/not found/i.test(session.error || '')) return { status: 'notfound' };
    // QRZ answered with an error (e.g. "a subscription is required"). That will not fix itself in a minute.
    throw Object.assign(new Error(`QRZ error: ${session.error || 'unknown'}`), { persistent: true });
  }

  function remember(call, value, ttl) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(call, { value, exp: now() + ttl });
  }

  async function lookup(call) {
    if (!enabled) return { status: 'unavailable' };
    const hit = cache.get(call);
    if (hit && hit.exp > now()) return hit.value;
    if (blockedUntil > now()) return { status: 'unavailable' };
    if (inflight.has(call)) return inflight.get(call);

    const p = limited(() => query(call))
      .then((r) => {
        remember(call, r, r.status === 'found' ? POSITIVE_TTL : NEGATIVE_TTL);
        return r;
      })
      .catch((e) => {
        console.error('QRZ lookup failed:', e.message);
        const r = { status: 'unavailable' };
        remember(call, r, e.persistent ? NEGATIVE_TTL : FAILURE_TTL); // do not ask (and log) again for every request
        return r;
      })
      .finally(() => inflight.delete(call));
    inflight.set(call, p);
    return p;
  }

  return { enabled, lookup };
}
