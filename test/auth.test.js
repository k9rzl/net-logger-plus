import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createAuth, normalizeEmail, TOKEN_TTL_MS } from '../src/auth.js';
import { createLimiter } from '../src/ratelimit.js';

function setup() {
  let t = 1_000_000;
  const store = new Store(null);
  const auth = createAuth({ store, secret: 'x'.repeat(40), now: () => t });
  return { store, auth, advance: (ms) => { t += ms; } };
}
const cookieOf = (setCookie) => setCookie;

test('email normalization', () => {
  assert.equal(normalizeEmail('  Ann@Example.ORG '), 'ann@example.org');
  assert.equal(normalizeEmail('nope'), null);
  assert.equal(normalizeEmail('a b@c.de'), null);
  assert.equal(normalizeEmail(42), null);
});

test('sign-in tokens are single use', () => {
  const { auth } = setup();
  const tok = auth.issueToken('a@x.org');
  assert.equal(auth.consumeToken(tok), 'a@x.org');
  assert.equal(auth.consumeToken(tok), null);
});

test('sign-in tokens expire after 15 minutes', () => {
  const { auth, advance } = setup();
  const tok = auth.issueToken('a@x.org');
  advance(TOKEN_TTL_MS + 1);
  assert.equal(auth.consumeToken(tok), null);
});

test('a new request invalidates the previous token', () => {
  const { auth } = setup();
  const first = auth.issueToken('a@x.org');
  const second = auth.issueToken('a@x.org');
  assert.equal(auth.consumeToken(first), null);
  assert.equal(auth.consumeToken(second), 'a@x.org');
});

test('tokens are stored hashed, never in plain text', () => {
  const { store, auth } = setup();
  const tok = auth.issueToken('a@x.org');
  assert.ok(!JSON.stringify(store.data).includes(tok));
});

test('session cookie round trip, tamper detection, and revocation', () => {
  const { auth } = setup();
  const value = auth.createSession('a@x.org');
  const header = `nl_session=${value}`;
  assert.equal(auth.sessionFromCookie(header).email, 'a@x.org');
  assert.equal(auth.sessionFromCookie(`nl_session=${value}x`), null);
  assert.equal(auth.sessionFromCookie(`nl_session=${value.split('.')[0]}.AAAA`), null);
  assert.equal(auth.sessionFromCookie(`nl_session=${'other.' + value.split('.')[1]}`), null);
  auth.destroySession(header);
  assert.equal(auth.sessionFromCookie(header), null);
});

test('cookie flags', () => {
  const { store } = setup();
  const secure = createAuth({ store, secret: 'x'.repeat(40), secureCookie: true });
  const c = cookieOf(secure.sessionCookie('v'));
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
});

test('rate limiter blocks after max and resets after the window', () => {
  let t = 0;
  const allow = createLimiter(() => t);
  assert.ok(allow('k', 2, 1000));
  assert.ok(allow('k', 2, 1000));
  assert.ok(!allow('k', 2, 1000));
  t = 1001;
  assert.ok(allow('k', 2, 1000));
});
