import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function normalizeEmail(v) {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

export const TOKEN_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Passwordless auth.
 * - Sign-in tokens: 256-bit random, stored hashed, single-use, 15 minute life.
 *   A new request invalidates older tokens for that address.
 * - Sessions: random id stored hashed server-side (revocable), cookie is id.HMAC.
 */
export function createAuth({ store, secret, secureCookie = false, now = () => Date.now() }) {
  const sign = (id) => crypto.createHmac('sha256', secret).update(id).digest('base64url');

  function prune() {
    const t = now();
    for (const [k, v] of Object.entries(store.data.tokens)) if (v.exp < t) delete store.data.tokens[k];
    for (const [k, v] of Object.entries(store.data.sessions)) if (v.exp < t) delete store.data.sessions[k];
  }

  function issueToken(email) {
    prune();
    for (const [k, v] of Object.entries(store.data.tokens)) if (v.email === email) delete store.data.tokens[k];
    const token = crypto.randomBytes(32).toString('base64url');
    store.data.tokens[sha(token)] = { email, exp: now() + TOKEN_TTL_MS };
    store.save();
    return token;
  }

  function consumeToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const key = sha(token);
    const rec = store.data.tokens[key];
    if (!rec) return null;
    delete store.data.tokens[key]; // single use, even if expired
    store.save();
    return rec.exp >= now() ? rec.email : null;
  }

  function createSession(email) {
    const id = crypto.randomBytes(32).toString('base64url');
    store.data.sessions[sha(id)] = { email, exp: now() + SESSION_TTL_MS };
    store.data.users[email] ??= { email, callsign: null, location: null, createdAt: now() };
    store.save();
    return `${id}.${sign(id)}`;
  }

  function sessionFromCookie(cookieHeader) {
    const m = (cookieHeader || '').match(/(?:^|;\s*)nl_session=([^;]+)/);
    if (!m) return null;
    const [id, mac] = m[1].split('.');
    if (!id || !mac) return null;
    const a = Buffer.from(mac);
    const b = Buffer.from(sign(id));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const rec = store.data.sessions[sha(id)];
    if (!rec || rec.exp < now()) return null;
    const user = store.data.users[rec.email];
    return user ? { id, email: rec.email, user } : null;
  }

  function destroySession(cookieHeader) {
    const s = sessionFromCookie(cookieHeader);
    if (s) {
      delete store.data.sessions[sha(s.id)];
      store.save();
    }
  }

  const cookie = (value, maxAgeSec) =>
    `nl_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secureCookie ? '; Secure' : ''}`;

  return {
    issueToken,
    consumeToken,
    createSession,
    sessionFromCookie,
    destroySession,
    sessionCookie: (value) => cookie(value, SESSION_TTL_MS / 1000),
    clearCookie: () => cookie('', 0),
  };
}
