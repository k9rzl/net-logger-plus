import test from 'node:test';
import assert from 'node:assert/strict';
import { createQrz } from '../src/qrz.js';

const NS = 'xmlns="http://xmldata.qrz.com"';
const LOGIN_OK = `<?xml version="1.0"?><QRZDatabase version="1.34" ${NS}><Session><Key>k1</Key><Count>3</Count></Session></QRZDatabase>`;
const LOGIN_BAD = `<QRZDatabase ${NS}><Session><Error>Username/password incorrect</Error></Session></QRZDatabase>`;
const FOUND = `<QRZDatabase ${NS}><Callsign><call>W1AW</call><fname>Hiram Percy</fname><name>Maxim</name>
<addr1>225 Main St</addr1><addr2>Newington</addr2><state>CT</state><country>United States</country>
<grid>FN31pr</grid><class>C</class><email>secret@example.org</email></Callsign><Session><Key>k1</Key></Session></QRZDatabase>`;
const NOT_FOUND = `<QRZDatabase ${NS}><Session><Error>Not found: XX9XX</Error><Key>k1</Key></Session></QRZDatabase>`;
const TIMEOUT = `<QRZDatabase ${NS}><Session><Error>Session Timeout</Error></Session></QRZDatabase>`;

function fakeFetch(...bodies) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const body = bodies.shift();
    if (body === undefined) throw new Error('unexpected extra request');
    return { ok: true, status: 200, text: async () => body };
  };
  fn.calls = calls;
  return fn;
}
const make = (f, now) => createQrz({ username: 'u', password: 'p', fetchFn: f, now });
const origError = console.error;

test('logs in, looks up, and returns only public fields', async () => {
  const f = fakeFetch(LOGIN_OK, FOUND);
  const r = await make(f).lookup('W1AW');
  assert.equal(r.status, 'found');
  assert.deepEqual(r.info, { name: 'Hiram', location: 'Newington, CT, United States' }); // all the ledger needs
  assert.deepEqual(Object.keys(r.info).sort(), ['location', 'name']);
  assert.ok(!JSON.stringify(r).includes('secret@example.org'));
  assert.ok(!JSON.stringify(r).includes('FN31pr')); // not even the grid square
  assert.ok(!JSON.stringify(r).includes('225 Main'));
  assert.match(f.calls[0], /username=u;password=p;agent=net-logger-plus/);
  assert.match(f.calls[1], /s=k1;callsign=W1AW/);
});

test('callsign not found is reported as notfound', async () => {
  const r = await make(fakeFetch(LOGIN_OK, NOT_FOUND)).lookup('XX9XX');
  assert.equal(r.status, 'notfound');
});

test('re-logs in once when the session key is missing from a response', async () => {
  const f = fakeFetch(LOGIN_OK, TIMEOUT, LOGIN_OK, FOUND);
  const r = await make(f).lookup('W1AW');
  assert.equal(r.status, 'found');
  assert.equal(f.calls.length, 4);
});

test('results are cached; repeat lookups do not hit QRZ', async () => {
  const f = fakeFetch(LOGIN_OK, FOUND);
  const q = make(f);
  await q.lookup('W1AW');
  await q.lookup('W1AW');
  assert.equal(f.calls.length, 2);
});

test('concurrent lookups of one callsign share a single request', async () => {
  const f = fakeFetch(LOGIN_OK, FOUND);
  const q = make(f);
  const [a, b] = await Promise.all([q.lookup('W1AW'), q.lookup('W1AW')]);
  assert.equal(a.status, 'found');
  assert.equal(b.status, 'found');
  assert.equal(f.calls.length, 2);
});

test('a failed login makes QRZ unavailable and backs off instead of retrying', async () => {
  console.error = () => {};
  let t = 0;
  const f = fakeFetch(LOGIN_BAD);
  const q = make(f, () => t);
  assert.equal((await q.lookup('W1AW')).status, 'unavailable');
  assert.equal((await q.lookup('K1ABC')).status, 'unavailable');
  assert.equal(f.calls.length, 1); // second call never reached QRZ
  console.error = origError;
});

test('network errors never throw', async () => {
  console.error = () => {};
  const q = createQrz({ username: 'u', password: 'p', fetchFn: async () => { throw new Error('down'); } });
  assert.equal((await q.lookup('W1AW')).status, 'unavailable');
  console.error = origError;
});

test('without credentials lookups are disabled', async () => {
  const q = createQrz({});
  assert.equal(q.enabled, false);
  assert.equal((await q.lookup('W1AW')).status, 'unavailable');
});

test('a burst of different callsigns shares one login and never exceeds three requests in flight', async () => {
  let inFlight = 0, max = 0, logins = 0, lookups = 0;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const f = async (url) => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    await wait(10);
    inFlight -= 1;
    const isLogin = String(url).includes('username=');
    if (isLogin) logins += 1; else lookups += 1;
    return { ok: true, status: 200, text: async () => (isLogin ? LOGIN_OK : FOUND) };
  };
  const q = make(f);
  const calls = Array.from({ length: 14 }, (_, i) => `K1A${String.fromCharCode(65 + i)}`);
  const results = await Promise.all(calls.map((c) => q.lookup(c)));
  assert.ok(results.every((r) => r.status === 'found'));
  assert.equal(logins, 1);
  assert.equal(lookups, 14);
  assert.ok(max <= 3, `max in flight was ${max}`);
  assert.ok(max >= 2, 'it should still run some lookups in parallel');
});

test('lookups queued behind a failed login all come back unavailable without extra logins', async () => {
  console.error = () => {};
  let logins = 0;
  const f = async () => { logins += 1; return { ok: true, status: 200, text: async () => LOGIN_BAD }; };
  const q = make(f);
  const results = await Promise.all(['K1AA', 'K1AB', 'K1AC', 'K1AD', 'K1AE'].map((c) => q.lookup(c)));
  assert.ok(results.every((r) => r.status === 'unavailable'));
  assert.ok(logins <= 3, `logins: ${logins}`); // at most the first wave; the cool-down stops the rest
  console.error = origError;
});

const SUBSCRIPTION = `<QRZDatabase ${NS}><Session><Error>A subscription is required to obtain the complete data</Error><Key>k1</Key><SubExp>non-subscriber</SubExp></Session></QRZDatabase>`;

test('an error QRZ itself reports is remembered for ten minutes: one request and one log line, not one per ask', async () => {
  let t = 1_000_000;
  const logs = [];
  console.error = (...a) => logs.push(a.join(' '));
  const f = fakeFetch(LOGIN_OK, SUBSCRIPTION, SUBSCRIPTION); // a third body is available if it wrongly asks again
  const q = make(f, () => t);
  for (let i = 0; i < 5; i++) assert.equal((await q.lookup('W1AW')).status, 'unavailable');
  assert.equal(f.calls.length, 2); // one login + one lookup, nothing more
  assert.equal(logs.length, 1);
  assert.match(logs[0], /subscription is required/);

  t += 9 * 60 * 1000;
  await q.lookup('W1AW');
  assert.equal(f.calls.length, 2); // still remembered after nine minutes
  t += 2 * 60 * 1000;
  await q.lookup('W1AW');
  assert.equal(f.calls.length, 3); // asks again after ten
  console.error = origError;
});

test('a network failure is remembered for one minute, then retried', async () => {
  let t = 1_000_000, calls = 0, up = false;
  console.error = () => {};
  const f = async (url) => {
    calls += 1;
    if (!up) throw new Error('network down');
    return { ok: true, status: 200, text: async () => (String(url).includes('username=') ? LOGIN_OK : FOUND) };
  };
  const q = make(f, () => t);
  assert.equal((await q.lookup('W1AW')).status, 'unavailable');
  assert.equal((await q.lookup('W1AW')).status, 'unavailable');
  assert.equal(calls, 1); // the second ask did not go to the network
  up = true;
  t += 30_000;
  assert.equal((await q.lookup('W1AW')).status, 'unavailable'); // still inside the minute
  t += 31_000;
  assert.equal((await q.lookup('W1AW')).status, 'found'); // recovered as soon as the minute is up
  console.error = origError;
});

test('a remembered failure for one callsign does not stop other callsigns being tried', async () => {
  console.error = () => {};
  const f = fakeFetch(LOGIN_OK, SUBSCRIPTION, FOUND);
  const q = make(f);
  assert.equal((await q.lookup('AA1AA')).status, 'unavailable');
  assert.equal((await q.lookup('W1AW')).status, 'found');
  console.error = origError;
});
