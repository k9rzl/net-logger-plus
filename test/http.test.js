import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Store } from '../src/store.js';
import { createAuth } from '../src/auth.js';
import { createApp } from '../src/server.js';
import { createQrz } from '../src/qrz.js';

const NS = 'xmlns="http://xmldata.qrz.com"';
const qrzFetch = async (url) => {
  const u = String(url);
  if (!u.includes('username=') && /callsign=K1EMPT/i.test(u)) return { ok: true, status: 200, text: async () => `<QRZDatabase ${NS}><Callsign><call>K1EMPT</call></Callsign><Session><Error>A subscription is required to obtain the complete data</Error><Key>k</Key></Session></QRZDatabase>` };
  if (!u.includes('username=') && /callsign=K1LOCO/i.test(u)) return { ok: true, status: 200, text: async () => `<QRZDatabase ${NS}><Callsign><call>K1LOCO</call><country>Canada</country></Callsign><Session><Key>k</Key></Session></QRZDatabase>` };
  const body = u.includes('username=')
    ? `<QRZDatabase ${NS}><Session><Key>k</Key></Session></QRZDatabase>`
    : /callsign=N0NE/i.test(u)
      ? `<QRZDatabase ${NS}><Session><Error>Not found: N0NE</Error><Key>k</Key></Session></QRZDatabase>`
      : `<QRZDatabase ${NS}><Callsign><call>X</call><fname>Pat Q</fname><name>Op</name><addr2>Austin</addr2><state>TX</state><country>United States</country><grid>EM10</grid><class>E</class></Callsign><Session><Key>k</Key></Session></QRZDatabase>`;
  return { ok: true, status: 200, text: async () => body };
};

async function boot(t, { qrz = true, qrzRequire = false, hsts = false } = {}) {
  const store = new Store(null);
  const config = { devLinks: true, baseUrl: 'http://localhost', secureCookie: false, trustProxy: false, qrzRequire, hsts };
  const auth = createAuth({ store, secret: 's'.repeat(40) });
  const app = createApp({ config, store, auth, sendMail: async () => {}, qrz: createQrz(qrz ? { username: 'u', password: 'p', fetchFn: qrzFetch } : {}) });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const client = () => {
    let cookie = '';
    const call = async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { 'x-net-logger-plus': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    return {
      call,
      cookie: () => cookie,
      async signIn(email, callsign) {
        const r = await call('POST', '/api/auth/request', { email });
        await call('POST', '/api/auth/verify', { token: r.body.devLink.split('#')[1] });
        if (callsign) return call('POST', '/api/me', { callsign, name: 'Alex', location: 'Albany, NY' });
      },
    };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  t.after(close);
  return { base, client, store, close };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('chat: sign-in required, post, read, control can remove, mute blocks', async (t) => {
  const s = await boot(t);
  const alice = s.client(), bob = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  await bob.signIn('bob@x.org', 'K1ABC');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '146.520', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });

  assert.equal((await anon.call('GET', `/api/nets/${id}/chat`)).status, 401);
  assert.equal((await anon.call('POST', `/api/nets/${id}/chat`, { text: 'hi' })).status, 401);

  assert.equal((await bob.call('POST', `/api/nets/${id}/chat`, { text: 'hello net' })).status, 201);
  const hist = await alice.call('GET', `/api/nets/${id}/chat`);
  assert.equal(hist.body.messages[0].text, 'hello net');
  assert.equal(hist.body.messages[0].call, 'K1ABC');
  assert.ok(!JSON.stringify(hist.body).includes('@'));

  const msgId = hist.body.messages[0].id;
  assert.equal((await bob.call('DELETE', `/api/nets/${id}/chat/${msgId}`)).status, 403);
  assert.equal((await alice.call('DELETE', `/api/nets/${id}/chat/${msgId}`)).status, 200);
  assert.equal((await alice.call('GET', `/api/nets/${id}/chat`)).body.messages.length, 0);

  await alice.call('POST', `/api/nets/${id}/command`, { text: '/mute K1ABC' });
  const muted = await bob.call('POST', `/api/nets/${id}/chat`, { text: 'still here?' });
  assert.equal(muted.status, 400);
  assert.match(muted.body.error, /muted/);
});

/** Read from an event stream until `done(text)` is true or the time runs out. */
async function readStream(reader, done, ms = 1500) {
  let seen = '';
  const dec = new TextDecoder();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done(seen)) {
    const r = await Promise.race([reader.read(), sleep(200).then(() => null)]);
    if (r?.done) break;
    if (r?.value) seen += dec.decode(r.value);
  }
  return seen;
}

test('one stream per page: net updates for everyone, chat only for signed-in viewers', async (t) => {
  const s = await boot(t);
  const alice = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });

  // a visitor with no session: gets the net snapshot...
  const anonRes = await fetch(`${s.base}/api/nets/${id}/events`);
  assert.equal(anonRes.status, 200);
  const anon = anonRes.body.getReader();
  // ...and a signed-in viewer gets the same stream plus chat
  const meRes = await fetch(`${s.base}/api/nets/${id}/events`, { headers: { cookie: alice.cookie() } });
  const me = meRes.body.getReader();

  assert.match(await readStream(anon, (t_) => t_.includes('event: net')), /event: net/);
  assert.match(await readStream(me, (t_) => t_.includes('event: net')), /event: net/);

  await alice.call('POST', `/api/nets/${id}/chat`, { text: 'private chatter' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' }); // a net update both should see

  const mine = await readStream(me, (t_) => t_.includes('private chatter') && t_.includes('"status":"live"'));
  assert.match(mine, /event: msg/);
  assert.match(mine, /private chatter/);
  assert.match(mine, /"status":"live"/); // the same connection also carries the net update

  const theirs = await readStream(anon, (t_) => t_.includes('"status":"live"'));
  assert.match(theirs, /"status":"live"/);
  assert.doesNotMatch(theirs, /private chatter/); // chat never reaches an anonymous connection
  assert.doesNotMatch(theirs, /event: msg/);
  await anon.cancel();
  await me.cancel();
});

test('removing a chat message is pushed on the same stream', async (t) => {
  const s = await boot(t);
  const alice = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/chat`, { text: 'oops' });
  const msgId = (await alice.call('GET', `/api/nets/${id}/chat`)).body.messages[0].id;
  const res = await fetch(`${s.base}/api/nets/${id}/events`, { headers: { cookie: alice.cookie() } });
  const reader = res.body.getReader();
  await readStream(reader, (t_) => t_.includes('event: net'));
  await alice.call('DELETE', `/api/nets/${id}/chat/${msgId}`);
  const seen = await readStream(reader, (t_) => t_.includes('event: del'));
  assert.match(seen, /event: del/);
  assert.match(seen, new RegExp(msgId));
  await reader.cancel();
});

test('the old separate chat stream is gone', async (t) => {
  const s = await boot(t);
  const alice = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  const res = await fetch(`${s.base}/api/nets/${id}/chat/events`, { headers: { cookie: alice.cookie() } });
  assert.equal(res.status, 404);
});

test('logout closes that session\'s stream', async (t) => {
  const s = await boot(t);
  const alice = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  const res = await fetch(`${s.base}/api/nets/${id}/events`, { headers: { cookie: alice.cookie() } });
  const reader = res.body.getReader();
  await sleep(50);
  const oldCookie = alice.cookie();
  await alice.call('POST', '/api/auth/logout', {});
  let ended = false;
  for (let i = 0; i < 5; i++) { const { done } = await reader.read(); if (done) { ended = true; break; } }
  assert.ok(ended);
  const again = await fetch(`${s.base}/api/nets/${id}/chat`, { headers: { cookie: oldCookie } });
  assert.equal(again.status, 401);
});

test('QRZ: details are added when a callsign joins the ledger, and only a name and location are kept', async (t) => {
  const s = await boot(t);
  const alice = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });
  await alice.call('POST', `/api/nets/${id}/join`, {});
  await sleep(50);
  const pub = await anon.call('GET', `/api/nets/${id}`);
  const info = pub.body.net.stations[0].info;
  assert.equal(info.name, 'Pat');
  assert.equal(info.location, 'Austin, TX, United States');
  assert.deepEqual(Object.keys(info).sort(), ['location', 'name']); // nothing else from QRZ is stored or shown
  assert.ok(!JSON.stringify(pub.body).includes('@'));
});

test('there is no separate callsign lookup any more: QRZ is used only when callsigns are added to the ledger', async (t) => {
  const s = await boot(t);
  const alice = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  for (const who of [alice, anon]) {
    assert.equal((await who.call('GET', '/api/callsign?call=W1AW')).status, 404); // the endpoint is gone
  }
  assert.equal((await alice.call('GET', '/api/me')).body.features, undefined); // and nothing advertises it
});

test('QRZ not configured: check-in works, shows the typed location, and attaches nothing', async (t) => {
  const s = await boot(t, { qrz: false });
  const alice = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });
  assert.equal((await alice.call('POST', `/api/nets/${id}/join`, {})).status, 200);
  assert.equal((await alice.call('POST', `/api/nets/${id}/command`, { text: '/ci N0TST' })).status, 200);
  await sleep(80);
  const st = Object.fromEntries((await anon.call('GET', `/api/nets/${id}`)).body.net.stations.map((x) => [x.callsign, x]));
  assert.deepEqual([st.W1AW.state, st.W1AW.location, st.W1AW.info], ['in', 'Albany, NY', null]);
  assert.deepEqual([st.N0TST.state, st.N0TST.info], ['in', null]); // checked in, just without QRZ details
});

test('QRZ_REQUIRE rejects callsigns QRZ does not know', async (t) => {
  const s = await boot(t, { qrzRequire: true });
  const alice = s.client();
  const r = await alice.signIn('alice@x.org', 'N0NE');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no record/);
  assert.equal((await alice.call('POST', '/api/me', { callsign: 'W1AW', name: 'Alex', location: 'Albany, NY' })).status, 200);
});

test('HSTS header only when the config says so (domains yes, IP addresses no)', async (t) => {
  const withHsts = await boot(t, { hsts: true });
  const without = await boot(t, { hsts: false });
  assert.match((await fetch(withHsts.base + '/')).headers.get('strict-transport-security') || '', /max-age=/);
  assert.equal((await fetch(without.base + '/')).headers.get('strict-transport-security'), null);
});

test('the net endpoint lists every net control command with a description', async (t) => {
  const s = await boot(t);
  const alice = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  const { body } = await alice.call('GET', `/api/nets/${id}`);
  assert.equal(body.commands.length, 13);
  assert.ok(body.commands.every((c) => c.usage.startsWith('/') && c.help.length > 10));
  assert.deepEqual(body.commands.map((c) => c.usage.split(' ')[0]).sort(),
    ['/ack', '/ci', '/close', '/co', '/drop', '/logger', '/mute', '/ncs', '/note', '/rlogger', '/rst', '/start', '/unmute']);
});

test('/ci over HTTP: adds the station, looks it up on QRZ, and only net control may do it', async (t) => {
  const s = await boot(t);
  const alice = s.client(), bob = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  await bob.signIn('bob@x.org', 'K1ABC');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });

  const denied = await bob.call('POST', `/api/nets/${id}/command`, { text: '/ci N0TST' });
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, /Only net control/);

  assert.equal((await alice.call('POST', `/api/nets/${id}/command`, { text: '/ci N0TST' })).status, 200);
  await sleep(60);
  const pub = (await anon.call('GET', `/api/nets/${id}`)).body.net;
  const st = pub.stations.find((x) => x.callsign === 'N0TST');
  assert.equal(st.state, 'in');
  assert.equal(st.addedBy, 'W1AW');
  assert.equal(st.info.name, 'Pat'); // QRZ details attached even though nobody signed in as N0TST
  assert.ok(!JSON.stringify(pub).includes('@'));
});

test('/ci with several callsigns: all added with QRZ details, skips reported, one coalesced broadcast', async (t) => {
  const s = await boot(t);
  const alice = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });

  const res = await fetch(`${s.base}/api/nets/${id}/events`);
  const reader = res.body.getReader();
  await readStream(reader, (x) => x.includes('event: net'));

  const r = await alice.call('POST', `/api/nets/${id}/command`, { text: '/ci N0TST W5HAM N0NE K1XYZ BADCALL N3QRS' });
  assert.equal(r.status, 200);
  assert.equal(r.body.notice, 'Checked in 5. Skipped: BADCALL (not a valid callsign).');

  const seen = await readStream(reader, () => false, 700); // let the QRZ results land
  const broadcasts = (seen.match(/event: net/g) || []).length;
  assert.ok(broadcasts >= 1 && broadcasts <= 3, `expected a few coalesced updates, got ${broadcasts}`);
  await reader.cancel();

  const pub = (await anon.call('GET', `/api/nets/${id}`)).body.net;
  assert.deepEqual(pub.stations.map((x) => x.callsign), ['N0TST', 'W5HAM', 'N0NE', 'K1XYZ', 'N3QRS']);
  for (const x of pub.stations) {
    assert.equal(x.state, 'in');
    assert.equal(x.addedBy, 'W1AW');
    if (x.callsign === 'N0NE') assert.equal(x.info, null); // QRZ has no record: still checked in, just no details
    else assert.equal(x.info.name, 'Pat');
  }
  assert.ok(!JSON.stringify(pub).includes('@'));
  assert.equal(pub.log.at(-1).msg, 'N0TST, W5HAM, N0NE, K1XYZ, N3QRS checked in by W1AW');
});

test('/ci over HTTP: nothing usable is a clear error, not a silent success', async (t) => {
  const s = await boot(t);
  const alice = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });
  const r = await alice.call('POST', `/api/nets/${id}/command`, { text: '/ci HELLO 123' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Nobody was checked in\. HELLO \(not a valid callsign\), 123 \(not a valid callsign\)\./);
});

test('QRZ knows the callsign but returns nothing to show: no empty details are attached', async (t) => {
  const s = await boot(t);
  const alice = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/ci K1EMPT K1LOCO N0TST' });
  await sleep(120);
  const st = Object.fromEntries((await anon.call('GET', `/api/nets/${id}`)).body.net.stations.map((x) => [x.callsign, x]));
  assert.equal(st.K1EMPT.info, null); // known to QRZ, but no name and no location
  assert.deepEqual(st.K1LOCO.info, { name: '', location: 'Canada' }); // partial data is still shown
  assert.equal(st.N0TST.info.name, 'Pat'); // full data unaffected
  assert.equal(st.K1EMPT.state, 'in'); // and checking in never depended on QRZ
});

test('registration needs a valid callsign, a name AND a location, and all three come back from /api/me', async (t) => {
  // (profile saves are limited to 10 per 15 minutes per account, so this test keeps to exactly 10 attempts)
  const s = await boot(t);
  const alice = s.client();
  await alice.signIn('alice@x.org');
  const me = (body) => alice.call('POST', '/api/me', body);
  const NAME = 'Hiram';

  assert.match((await me({ callsign: 'W1AW', location: 'Albany, NY' })).body.error, /Enter your name/);
  assert.match((await me({ callsign: 'W1AW', name: 'x', location: 'Albany, NY' })).body.error, /Enter your name/);
  assert.match((await me({ callsign: 'W1AW', name: '12345', location: 'Albany, NY' })).body.error, /Enter your name/);
  assert.match((await me({ callsign: 'W1AW', name: NAME })).body.error, /Enter your location/);
  assert.match((await me({ callsign: 'W1AW', name: NAME, location: 'x' })).body.error, /Enter your location/);
  assert.match((await me({ callsign: 'W1AW', name: NAME, location: '12345' })).body.error, /Enter your location/);
  assert.match((await me({ name: NAME, location: 'Albany, NY' })).body.error, /does not look like a callsign/);
  assert.match((await me({ callsign: 'HELLO', name: NAME, location: 'Albany, NY' })).body.error, /does not look like a callsign/);
  const before = (await alice.call('GET', '/api/me')).body.user;
  assert.deepEqual([before.callsign, before.name, before.location], [null, null, null]); // none of the refusals above saved anything

  const ok = await me({ callsign: 'w1aw', name: '  Hiram\u0000  Percy ', location: '  Albany,\u0000 NY  ' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.user, { email: 'alice@x.org', callsign: 'W1AW', name: 'Hiram Percy', location: 'Albany, NY' });
  assert.deepEqual((await alice.call('GET', '/api/me')).body.user, ok.body.user); // saved to the profile
  assert.equal((await me({ callsign: 'W1AW', name: 'x'.repeat(100), location: 'Albany, NY' })).body.user.name.length, 40);
});

test('a brand-new account starts with an empty profile, and nothing is saved until all three are valid', async (t) => {
  const s = await boot(t);
  const fresh = s.client();
  await fresh.signIn('fresh@x.org'); // signed in, nothing registered yet
  assert.deepEqual((await fresh.call('GET', '/api/me')).body.user, { email: 'fresh@x.org', callsign: null, name: null, location: null });
  assert.equal((await fresh.call('POST', '/api/me', { callsign: 'W1AW', location: 'Albany, NY' })).status, 400); // no name
  assert.equal((await fresh.call('GET', '/api/me')).body.user.callsign, null); // not even the callsign was kept
  const ok = await fresh.call('POST', '/api/me', { callsign: 'W1AW', name: 'Hiram', location: 'Albany, NY' });
  assert.equal(ok.status, 200);
  assert.deepEqual((await fresh.call('GET', '/api/me')).body.user, { email: 'fresh@x.org', callsign: 'W1AW', name: 'Hiram', location: 'Albany, NY' });
});

test('the ledger shows the name an operator typed, ahead of what QRZ says; /ci stations get QRZ\'s name', async (t) => {
  const s = await boot(t);
  const alice = s.client(), anon = s.client();
  await alice.signIn('alice@x.org');
  await alice.call('POST', '/api/me', { callsign: 'W1AW', name: 'Hiram', location: 'Albany, NY' });
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });
  await alice.call('POST', `/api/nets/${id}/join`, {});
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/ci N0TST' });
  await sleep(100);
  const st = Object.fromEntries((await anon.call('GET', `/api/nets/${id}`)).body.net.stations.map((x) => [x.callsign, x]));
  assert.equal(st.W1AW.name, 'Hiram'); // typed at registration
  assert.equal(st.W1AW.info.name, 'Pat'); // QRZ's answer is still kept, but the typed name is what the page shows first
  assert.equal(st.N0TST.name, null); // nobody registered N0TST...
  assert.equal(st.N0TST.info.name, 'Pat'); // ...so QRZ fills it in
  assert.ok(!JSON.stringify(st).includes('@'));
});

test('editing the name updates the ledger of nets still running', async (t) => {
  const s = await boot(t, { qrz: false });
  const alice = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });
  await alice.call('POST', `/api/nets/${id}/join`, {});
  const shown = async () => (await anon.call('GET', `/api/nets/${id}`)).body.net.stations[0].name;
  assert.equal(await shown(), 'Alex');
  await alice.call('POST', '/api/me', { callsign: 'W1AW', name: 'Alexandra', location: 'Albany, NY' });
  assert.equal(await shown(), 'Alexandra');
});

test('until the profile is complete: no nets, no check-in, no chat. Reading still works', async (t) => {
  const s = await boot(t);
  const alice = s.client(), legacy = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });

  // an account from before locations existed: it has a callsign but no location
  await legacy.signIn('old@x.org');
  s.store.data.users['old@x.org'].callsign = 'K1OLD';
  s.store.data.users['old@x.org'].location = 'Boise, ID'; // registered before names existed: callsign and location, no name
  for (const [method, path, body] of [
    ['POST', '/api/nets', { name: 'Nope Net', frequency: '1', mode: 'FM' }],
    ['POST', `/api/nets/${id}/join`, {}],
    ['POST', `/api/nets/${id}/chat`, { text: 'hi' }],
  ]) {
    const r = await legacy.call(method, path, body);
    assert.equal(r.status, 403, path);
    assert.match(r.body.error, /Finish your profile first/);
  }
  assert.equal((await legacy.call('GET', `/api/nets/${id}`)).status, 200); // watching is unaffected
  assert.equal((await legacy.call('GET', `/api/nets/${id}/chat`)).status, 200);
  assert.equal((await anon.call('GET', `/api/nets/${id}`)).status, 200);

  assert.equal((await legacy.call('POST', '/api/me', { callsign: 'K1OLD', name: 'Olive', location: 'Boise, ID' })).status, 200);
  assert.equal((await legacy.call('POST', `/api/nets/${id}/join`, {})).status, 200);
});

test('the ledger shows each person\'s own location with no QRZ at all', async (t) => {
  const s = await boot(t, { qrz: false });
  const alice = s.client(), bob = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  assert.equal((await bob.signIn('bob@x.org', 'K1ABC')).status, 200);
  await bob.call('POST', '/api/me', { callsign: 'K1ABC', name: 'Bob', location: 'Ottawa, Canada' });
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });
  await alice.call('POST', `/api/nets/${id}/join`, {});
  await bob.call('POST', `/api/nets/${id}/join`, {});
  await sleep(80);

  const pub = (await anon.call('GET', `/api/nets/${id}`)).body.net;
  const by = Object.fromEntries(pub.stations.map((x) => [x.callsign, x]));
  assert.equal(by.W1AW.location, 'Albany, NY');
  assert.equal(by.K1ABC.location, 'Ottawa, Canada');
  assert.equal(by.W1AW.info, null); // no QRZ, no extra details, and nothing broke
  assert.ok(!JSON.stringify(pub).includes('@'));
});

test('with QRZ on, the typed location is kept next to what QRZ adds', async (t) => {
  const s = await boot(t);
  const alice = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });
  await alice.call('POST', `/api/nets/${id}/join`, {});
  await sleep(80);
  const st = (await anon.call('GET', `/api/nets/${id}`)).body.net.stations[0];
  assert.equal(st.location, 'Albany, NY'); // what the operator typed
  assert.equal(st.info.name, 'Pat'); // QRZ adds the name
  assert.equal(st.info.location, 'Austin, TX, United States'); // QRZ's own location is still there too
});

test('editing a location updates the ledger of nets still running, but not closed ones', async (t) => {
  const s = await boot(t, { qrz: false });
  const alice = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  const make = async (name) => {
    const { body: { id } } = await alice.call('POST', '/api/nets', { name, frequency: '1', mode: 'FM' });
    await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });
    await alice.call('POST', `/api/nets/${id}/join`, {});
    return id;
  };
  const live = await make('Running Net');
  const done = await make('Finished Net');
  await alice.call('POST', `/api/nets/${done}/command`, { text: '/close' });

  assert.equal((await alice.call('POST', '/api/me', { callsign: 'W1AW', name: 'Alex', location: 'Boise, ID' })).status, 200);
  const loc = async (id) => (await anon.call('GET', `/api/nets/${id}`)).body.net.stations[0].location;
  assert.equal(await loc(live), 'Boise, ID');
  assert.equal(await loc(done), 'Albany, NY'); // history is left as it was
});

test('registration still rejects a callsign another account already holds', async (t) => {
  const s = await boot(t);
  const alice = s.client(), mallory = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  await mallory.signIn('mallory@x.org');
  const r = await mallory.call('POST', '/api/me', { callsign: 'W1AW', name: 'Mal', location: 'Elsewhere' });
  assert.equal(r.status, 409);
});

test('loggers over HTTP: each person is told only what they may do, and the server enforces it', async (t) => {
  const s = await boot(t);
  const alice = s.client(), bob = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  await bob.signIn('bob@x.org', 'K1ABC');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });
  await bob.call('POST', `/api/nets/${id}/join`, {});
  const view = async (who) => (await who.call('GET', `/api/nets/${id}`)).body;

  let v = await view(bob); // checked in, but not a logger yet
  assert.deepEqual([v.canControl, v.canLog, v.commands], [false, false, []]);

  assert.equal((await alice.call('POST', `/api/nets/${id}/command`, { text: '/logger K1ABC' })).status, 200);
  v = await view(bob);
  assert.deepEqual([v.canControl, v.canLog], [false, true]);
  assert.deepEqual(v.commands.map((c) => c.usage), ['/ci CALL [CALL ...]', '/co CALL [CALL ...]']); // add and remove, nothing else
  v = await view(alice);
  assert.deepEqual([v.canControl, v.canLog, v.commands.length], [true, true, 13]);
  v = await view(anon);
  assert.deepEqual([v.canControl, v.canLog, v.commands], [false, false, []]);
  assert.equal(v.net.stations[0].logger, true); // everyone can see who the loggers are
  assert.ok(!JSON.stringify(v).includes('@'));

  // the logger adds callsigns, each looked up on QRZ, and the log says a logger did it
  assert.equal((await bob.call('POST', `/api/nets/${id}/command`, { text: '/ci N0TST W5HAM' })).status, 200);
  await sleep(100);
  const net = (await view(anon)).net;
  const added = net.stations.filter((x) => x.addedBy === 'K1ABC');
  assert.deepEqual(added.map((x) => x.callsign), ['N0TST', 'W5HAM']);
  assert.ok(added.every((x) => x.info?.name === 'Pat'));
  assert.equal(net.log.at(-1).msg, 'N0TST, W5HAM checked in by K1ABC (logger)');

  // but nothing else
  const closed = await bob.call('POST', `/api/nets/${id}/command`, { text: '/close' });
  assert.equal(closed.status, 400);
  assert.equal(closed.body.error, 'Loggers can only use /ci and /co.');
  assert.equal((await view(anon)).net.status, 'live');
  assert.equal((await bob.call('POST', `/api/nets/${id}/command`, { text: '/logger W5HAM' })).status, 400);

  // taking the role away takes the powers away
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/rlogger K1ABC' });
  v = await view(bob);
  assert.deepEqual([v.canLog, v.commands], [false, []]);
  const after = await bob.call('POST', `/api/nets/${id}/command`, { text: '/ci N3QRS' });
  assert.match(after.body.error, /Only net control/);
});

test('/co over HTTP: checks stations out, reports what it skipped, and is for net control only', async (t) => {
  const s = await boot(t);
  const alice = s.client(), bob = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  await bob.signIn('bob@x.org', 'K1ABC');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });
  await bob.call('POST', `/api/nets/${id}/join`, {});
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/ci N0TST W5HAM' });
  await bob.call('POST', `/api/nets/${id}/hand`, {});

  const denied = await bob.call('POST', `/api/nets/${id}/command`, { text: '/co N0TST' });
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, /Only net control/);

  const r = await alice.call('POST', `/api/nets/${id}/command`, { text: '/co n0tst k1abc nobody' });
  assert.equal(r.status, 200);
  assert.equal(r.body.notice, 'Checked out 2. Skipped: NOBODY (not a valid callsign).');
  const net = (await anon.call('GET', `/api/nets/${id}`)).body.net;
  const st = Object.fromEntries(net.stations.map((x) => [x.callsign, x]));
  assert.deepEqual([st.N0TST.state, st.K1ABC.state, st.W5HAM.state], ['out', 'out', 'in']);
  assert.equal(st.K1ABC.hand, false); // bob's raised hand was lowered with him
  assert.equal(net.log.at(-1).msg, 'N0TST, K1ABC checked out by W1AW');
  // bob, checked out by net control, can simply check back in with the button
  assert.equal((await bob.call('POST', `/api/nets/${id}/join`, {})).status, 200);
  assert.equal((await anon.call('GET', `/api/nets/${id}`)).body.net.stations.find((x) => x.callsign === 'K1ABC').state, 'in');
});

test('a logger over HTTP can check stations out, but not net control or another logger', async (t) => {
  const s = await boot(t);
  const alice = s.client(), bob = s.client(), carol = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  await bob.signIn('bob@x.org', 'K1ABC');
  await carol.signIn('carol@x.org', 'N3QRS');
  const { body: { id } } = await alice.call('POST', '/api/nets', { name: 'Test Net', frequency: '1', mode: 'FM' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });
  for (const who of [alice, bob, carol]) await who.call('POST', `/api/nets/${id}/join`, {});
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/ci N0TST' });
  await alice.call('POST', `/api/nets/${id}/command`, { text: '/logger K1ABC N3QRS' });
  const stations = async () => Object.fromEntries((await anon.call('GET', `/api/nets/${id}`)).body.net.stations.map((x) => [x.callsign, x]));

  const ok = await bob.call('POST', `/api/nets/${id}/command`, { text: '/co n0tst' });
  assert.equal(ok.status, 200);
  assert.equal((await stations()).N0TST.state, 'out');
  assert.equal((await anon.call('GET', `/api/nets/${id}`)).body.net.log.at(-1).msg, 'N0TST checked out by K1ABC (logger)');

  const ncs = await bob.call('POST', `/api/nets/${id}/command`, { text: '/co W1AW' });
  assert.equal(ncs.status, 400);
  assert.equal(ncs.body.error, 'W1AW: is net control.');
  const peer = await bob.call('POST', `/api/nets/${id}/command`, { text: '/co N3QRS' });
  assert.equal(peer.status, 400);
  assert.match(peer.body.error, /is a logger, so only net control can check them out/);
  const after = await stations();
  assert.deepEqual([after.W1AW.state, after.N3QRS.state, after.N3QRS.logger], ['in', 'in', true]);
});

test('the net list shows live nets first, then scheduled, then closed, newest first within each', async (t) => {
  const s = await boot(t);
  const alice = s.client(), anon = s.client();
  await alice.signIn('alice@x.org', 'W1AW');
  const make = async (name) => {
    const { body: { id } } = await alice.call('POST', '/api/nets', { name, frequency: '1', mode: 'FM' });
    await sleep(5); // distinct creation times
    return id;
  };
  const oldLive = await make('Old live net');
  const closed = await make('Closed net');
  const scheduled = await make('Scheduled net');
  const newLive = await make('New live net');
  for (const id of [oldLive, closed, newLive]) await alice.call('POST', `/api/nets/${id}/command`, { text: '/start' });
  await alice.call('POST', `/api/nets/${closed}/command`, { text: '/close' }); // newer than the old live net, but closed
  const { body } = await anon.call('GET', '/api/nets');
  assert.deepEqual(body.nets.map((n) => [n.name, n.status]), [
    ['New live net', 'live'], ['Old live net', 'live'], ['Scheduled net', 'scheduled'], ['Closed net', 'closed'],
  ]);
  assert.equal(scheduled.length, 10);
});

test('the shared-stream worker script is served from this site, so the strict CSP allows it', async (t) => {
  const s = await boot(t);
  const res = await fetch(`${s.base}/js/stream-worker.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await res.text(), /EventSource/);
});
