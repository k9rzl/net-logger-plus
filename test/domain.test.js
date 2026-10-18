import test from 'node:test';
import assert from 'node:assert/strict';
import * as d from '../src/domain.js';

const alice = { email: 'a@x.org', callsign: 'W1AW' };
const bob = { email: 'b@x.org', callsign: 'K1ABC' };
const mallory = { email: 'm@x.org', callsign: 'W1AW' }; // same call, different account

function liveNet() {
  const { net } = d.createNet(alice, { name: 'Test Net', frequency: '146.520', mode: 'FM' }, 1000, 'abc');
  assert.ok(d.runCommand(net, alice, '/start', 1001).ok);
  return net;
}

test('callsign validation', () => {
  for (const c of ['W1AW', 'N0AD', 'W0SUN', 'KH6ABC', 'VE3XYZ/P']) assert.ok(d.isCallsign(c), c);
  for (const c of ['', 'HELLO', '123', 'W1', 'W1AWWWWW', '<script>']) assert.ok(!d.isCallsign(c), c);
});

test('createNet requires callsign and valid fields', () => {
  assert.ok(!d.createNet({ email: 'x@y.z' }, {}).ok);
  assert.ok(!d.createNet(alice, { name: 'ab', frequency: '1', mode: 'FM' }).ok);
  assert.ok(!d.createNet(alice, { name: 'Good name', frequency: '1', mode: 'AM-ish' }).ok);
});

test('check-in only while live; closed nets reject', () => {
  const { net } = d.createNet(alice, { name: 'Test Net', frequency: '146.520', mode: 'FM' });
  assert.equal(d.join(net, bob).error, 'This net has not started yet.');
  d.runCommand(net, alice, '/start');
  assert.ok(d.join(net, bob).ok);
  d.runCommand(net, alice, '/close');
  assert.equal(d.join(net, alice).error, 'This net has closed.');
});

test('a callsign cannot be checked in from two accounts', () => {
  const net = liveNet();
  assert.ok(d.join(net, alice).ok);
  assert.match(d.join(net, mallory).error, /another account/);
});

test('hand raise requires check-in and clears on check-out', () => {
  const net = liveNet();
  assert.ok(!d.toggleHand(net, bob).ok);
  d.join(net, bob);
  assert.ok(d.toggleHand(net, bob).ok);
  assert.equal(net.stations[0].hand, true);
  d.leave(net, bob);
  assert.equal(net.stations[0].hand, false);
});

test('only net control can run commands', () => {
  const net = liveNet();
  d.join(net, bob);
  assert.match(d.runCommand(net, bob, '/rst K1ABC 59').error, /Only net control/);
  assert.ok(d.runCommand(net, alice, '/rst K1ABC 59').ok);
  assert.equal(net.stations[0].rst, '59');
});

test('control passes to a reassigned NCS', () => {
  const net = liveNet();
  d.join(net, bob);
  assert.ok(d.runCommand(net, alice, '/ncs K1ABC').ok);
  assert.ok(d.isControl(net, bob));
  assert.ok(d.runCommand(net, bob, '/note hello').ok);
});

test('signal report validation and unknown commands', () => {
  const net = liveNet();
  d.join(net, bob);
  assert.ok(!d.runCommand(net, alice, '/rst K1ABC 99').ok);
  assert.ok(!d.runCommand(net, alice, '/rst K1ABC abc').ok);
  assert.ok(d.runCommand(net, alice, '/rst K1ABC 579').ok);
  assert.match(d.runCommand(net, alice, '/bogus').error, /Unknown command/);
});

test('public view never leaks email addresses', () => {
  const net = liveNet();
  d.join(net, bob);
  assert.ok(!JSON.stringify(d.publicView(net)).includes('@'));
});

test('control characters are stripped from user text', () => {
  assert.equal(d.clean('hi\u0000\u001b[31m there\n', 50), 'hi [31m there');
});

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

test('the command list shown to net control matches the commands the server really accepts', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../src/domain.js', import.meta.url)), 'utf8');
  const handled = [...source.matchAll(/case '(\/[a-z]+)'/g)].map((m) => m[1]).sort();
  const documented = d.COMMANDS.map((c) => c.usage.split(' ')[0]).sort();
  assert.deepEqual(documented, handled, 'every command needs an entry in COMMANDS, and vice versa');
  for (const c of d.COMMANDS) {
    assert.ok(c.help.length > 10 && c.help.endsWith('.'), c.usage);
  }
});

test('every documented command is recognised (none falls through to "Unknown command")', () => {
  for (const c of d.COMMANDS) {
    const net = liveNet();
    d.join(net, bob);
    const sample = c.usage.replace('CALL', 'K1ABC').replace('59', '59').replace('text', 'hello');
    const r = d.runCommand(net, alice, sample);
    assert.ok(r.ok || !/Unknown command/.test(r.error), `${c.usage}: ${r.error}`);
  }
});

test('/ci: net control checks a station in without an account', () => {
  const net = liveNet();
  const r = d.runCommand(net, alice, '/ci w2xyz', 50);
  assert.ok(r.ok);
  assert.deepEqual(r.stations, ['W2XYZ']);
  assert.equal(r.notice, undefined);
  const s = net.stations[0];
  assert.deepEqual([s.callsign, s.state, s.email, s.addedBy], ['W2XYZ', 'in', null, 'W1AW']);
  assert.equal(net.log.at(-1).msg, 'W2XYZ checked in by W1AW');
  assert.ok(!JSON.stringify(d.publicView(net)).includes('@')); // still no email addresses
  assert.equal(d.publicView(net).stations[0].addedBy, 'W1AW');
});

test('/ci: refused when it should be', () => {
  const net = liveNet();
  assert.match(d.runCommand(net, alice, '/ci').error, /Give at least one callsign/);
  assert.match(d.runCommand(net, alice, '/ci HELLO').error, /HELLO: not a valid callsign/);
  d.runCommand(net, alice, '/ci K1ABC');
  assert.match(d.runCommand(net, alice, '/ci K1ABC').error, /already checked in/);
  d.join(net, bob); // bob is K1ABC and already in via net control: still just one station
  assert.equal(net.stations.length, 1);
  assert.match(d.runCommand(net, bob, '/ci N3QRS').error, /Only net control/);

  const early = d.createNet(alice, { name: 'Not Started', frequency: '1', mode: 'FM' }).net;
  assert.match(d.runCommand(early, alice, '/ci K1ABC').error, /Start the net/);
  d.runCommand(net, alice, '/close');
  assert.match(d.runCommand(net, alice, '/ci N3QRS').error, /closed/);
});

test('/ci brings a checked-out station back in', () => {
  const net = liveNet();
  d.join(net, bob);
  d.leave(net, bob);
  assert.equal(net.stations[0].state, 'out');
  assert.ok(d.runCommand(net, alice, '/ci K1ABC').ok);
  assert.equal(net.stations[0].state, 'in');
  assert.equal(net.stations[0].email, bob.email); // still bob's account
});

test('the real operator takes over a station net control checked in', () => {
  const net = liveNet();
  d.runCommand(net, alice, '/ci K1ABC');
  assert.equal(net.stations[0].email, null);
  assert.ok(d.join(net, bob).ok); // already in: no error, and no duplicate
  assert.equal(net.stations.length, 1);
  assert.equal(net.stations[0].email, bob.email);

  const net2 = liveNet();
  d.runCommand(net2, alice, '/ci K1ABC');
  assert.ok(d.toggleHand(net2, bob).ok); // bob can raise a hand without ever pressing Check in
  assert.ok(d.leave(net2, bob).ok);
  assert.equal(net2.stations[0].state, 'out');
});

test('an unrelated account cannot act on a station net control checked in', () => {
  const net = liveNet();
  d.runCommand(net, alice, '/ci K1ABC');
  const eve = { email: 'e@x.org', callsign: 'N3EVE' };
  assert.ok(!d.leave(net, eve).ok);
  assert.ok(!d.toggleHand(net, eve).ok);
  assert.equal(net.stations[0].email, null); // untouched
  const impostor = { email: 'i@x.org', callsign: 'K1ABC' }; // same callsign, different account, after bob claimed it
  d.toggleHand(net, bob);
  assert.match(d.join(net, impostor).error, /another account/);
});

test('/ncs cannot hand control to a station that has no account yet', () => {
  const net = liveNet();
  d.runCommand(net, alice, '/ci K1ABC');
  assert.match(d.runCommand(net, alice, '/ncs K1ABC').error, /not signed in to Net Logger Plus yet/);
  d.join(net, bob); // bob signs in and takes the station over
  assert.ok(d.runCommand(net, alice, '/ncs K1ABC').ok);
});

test('/ci takes several callsigns separated by spaces and keeps the order typed', () => {
  const net = liveNet();
  const r = d.runCommand(net, alice, '/ci w2xyz k1abc  n3qrs', 77);
  assert.ok(r.ok);
  assert.deepEqual(r.stations, ['W2XYZ', 'K1ABC', 'N3QRS']);
  assert.equal(r.notice, undefined);
  assert.deepEqual(net.stations.map((s) => [s.callsign, s.seq, s.state, s.addedBy]), [
    ['W2XYZ', 1, 'in', 'W1AW'], ['K1ABC', 2, 'in', 'W1AW'], ['N3QRS', 3, 'in', 'W1AW'],
  ]);
  assert.equal(net.log.at(-1).msg, 'W2XYZ, K1ABC, N3QRS checked in by W1AW'); // one tidy log line, not three
});

test('/ci also accepts commas and ignores repeats', () => {
  const net = liveNet();
  const r = d.runCommand(net, alice, '/ci W2XYZ, K1ABC,N3QRS W2XYZ k1abc');
  assert.deepEqual(r.stations, ['W2XYZ', 'K1ABC', 'N3QRS']);
  assert.equal(net.stations.length, 3);
});

test('/ci with a mix: valid ones are added, the rest are reported', () => {
  const net = liveNet();
  d.join(net, bob); // K1ABC is already in
  const r = d.runCommand(net, alice, '/ci W2XYZ HELLO K1ABC N3QRS 123');
  assert.ok(r.ok);
  assert.deepEqual(r.stations, ['W2XYZ', 'N3QRS']);
  assert.equal(r.notice, 'Checked in 2. Skipped: HELLO (not a valid callsign), K1ABC (already checked in), 123 (not a valid callsign).');
  assert.deepEqual(net.stations.map((s) => s.callsign), ['K1ABC', 'W2XYZ', 'N3QRS']);
  assert.equal(net.log.at(-1).msg, 'W2XYZ, N3QRS checked in by W1AW');
});

test('/ci with nothing usable explains why for each callsign', () => {
  const net = liveNet();
  d.runCommand(net, alice, '/ci K1ABC');
  const r = d.runCommand(net, alice, '/ci K1ABC HELLO');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Nobody was checked in. K1ABC (already checked in), HELLO (not a valid callsign).');
  assert.equal(net.stations.length, 1);
  assert.equal(net.log.length, 2); // start + the first check-in; the failed attempt logged nothing
});

test('/ci limits one command to 25 stations, and a full net adds what fits', () => {
  const net = liveNet();
  const calls = Array.from({ length: 26 }, (_, i) => `K1A${String.fromCharCode(65 + i)}`);
  assert.match(d.runCommand(net, alice, `/ci ${calls.join(' ')}`).error, /at most 25/);
  assert.equal(net.stations.length, 0); // all or nothing for this limit
  assert.equal(d.runCommand(net, alice, `/ci ${calls.slice(0, 25).join(' ')}`).stations.length, 25);

  const full = liveNet();
  for (let i = 0; i < 499; i++) full.stations.push({ callsign: `X${i}`, email: null, state: 'in', seq: ++full.seq });
  const r = d.runCommand(full, alice, '/ci W2XYZ K1ABC N3QRS');
  assert.deepEqual(r.stations, ['W2XYZ']);
  assert.match(r.notice, /K1ABC \(the net is full\), N3QRS \(the net is full\)/);
});

test('/ci works for a station that was checked out, among several others', () => {
  const net = liveNet();
  d.join(net, bob);
  d.leave(net, bob);
  const r = d.runCommand(net, alice, '/ci W2XYZ K1ABC');
  assert.deepEqual(r.stations, ['W2XYZ', 'K1ABC']);
  assert.equal(net.stations.find((s) => s.callsign === 'K1ABC').state, 'in');
  assert.equal(net.stations.length, 2); // K1ABC was reused, not duplicated
});

test('location: free text from the operator, 2 to 60 characters with at least one letter', () => {
  assert.equal(d.normalizeLocation('  Albany,\u0000  NY '), 'Albany, NY');
  assert.equal(d.normalizeLocation('x'.repeat(100)).length, 60);
  assert.equal(d.normalizeLocation(undefined), '');
  for (const ok of ['Albany, NY', 'Ottawa, Canada', 'ZH', '東京', 'São Paulo', 'St. John\'s']) assert.ok(d.isLocation(d.normalizeLocation(ok)), ok);
  for (const bad of ['', ' ', 'x', '12345', '--', '!!']) assert.ok(!d.isLocation(d.normalizeLocation(bad)), JSON.stringify(bad));
});

test('a station carries the operator\'s own location, and the public view shows it (never the email)', () => {
  const net = liveNet();
  const withPlace = { ...bob, location: 'Ottawa, Canada' };
  assert.ok(d.join(net, withPlace).ok);
  assert.equal(net.stations[0].location, 'Ottawa, Canada');
  const view = d.publicView(net);
  assert.equal(view.stations[0].location, 'Ottawa, Canada');
  assert.ok(!JSON.stringify(view).includes('@'));
});

test('stations net control checks in have no location until the operator takes them over', () => {
  const net = liveNet();
  d.runCommand(net, alice, '/ci K1ABC');
  assert.equal(net.stations[0].location, null);
  d.toggleHand(net, { ...bob, location: 'Ottawa, Canada' });
  assert.equal(net.stations[0].location, 'Ottawa, Canada'); // filled in when the real operator acts
});

/* ---------- loggers ---------- */
const carol = { email: 'c@x.org', callsign: 'N3QRS', location: 'Harrisburg, PA' };

/** A live net with bob and carol checked in, and no loggers yet. */
function netWithTwo() {
  const net = liveNet();
  d.join(net, bob);
  d.join(net, carol);
  return net;
}

test('/logger names one or several checked-in stations; the ledger data carries the label', () => {
  const net = netWithTwo();
  const r = d.runCommand(net, alice, '/logger k1abc n3qrs', 90);
  assert.ok(r.ok);
  assert.equal(r.notice, undefined);
  assert.deepEqual(net.stations.map((s) => [s.callsign, s.logger]), [['K1ABC', true], ['N3QRS', true]]);
  assert.equal(net.log.at(-1).msg, 'K1ABC, N3QRS are now loggers');
  assert.deepEqual(d.publicView(net).stations.map((s) => s.logger), [true, true]); // what the page draws the label from
  assert.ok(d.isLogger(net, bob) && d.isLogger(net, carol));

  const one = netWithTwo();
  d.runCommand(one, alice, '/logger K1ABC');
  assert.equal(one.log.at(-1).msg, 'K1ABC is now a logger');
  assert.ok(!d.isLogger(one, carol)); // only the one named
});

test('/logger skips what it cannot do and says why', () => {
  const net = netWithTwo();
  d.runCommand(net, alice, '/ci W2XYZ'); // checked in by net control: no account yet
  d.join(net, alice); // the owner is on the ledger too
  d.leave(net, carol); // N3QRS has checked out
  d.runCommand(net, alice, '/logger K1ABC');
  const r = d.runCommand(net, alice, '/logger K1ABC N3QRS W2XYZ W1AW HELLO N0NE');
  assert.equal(r.ok, false); // nobody new could be named, so it is an error with every reason
  assert.equal(r.error, 'Nobody was made a logger. K1ABC (already a logger), N3QRS (not checked in), W2XYZ (has not signed in to Net Logger Plus yet), W1AW (already has full control), HELLO (not a valid callsign), N0NE (not checked in).');

  d.join(net, carol); // back in
  const mixed = d.runCommand(net, alice, '/logger N3QRS K1ABC');
  assert.ok(mixed.ok);
  assert.equal(mixed.notice, 'Made 1 logger. Skipped: K1ABC (already a logger).');
  assert.match(d.runCommand(net, alice, '/logger').error, /Give at least one callsign/);
  assert.match(d.runCommand(net, alice, '/logger ZZ9ZZZ').error, /ZZ9ZZZ: not checked in\./);
});

test('a logger can add callsigns with /ci, and the log says a logger did it', () => {
  const net = netWithTwo();
  d.runCommand(net, alice, '/logger K1ABC');
  const r = d.runCommand(net, bob, '/ci w2xyz n0tst', 120);
  assert.ok(r.ok);
  assert.deepEqual(r.stations, ['W2XYZ', 'N0TST']); // the server then looks each one up on QRZ
  const added = net.stations.find((s) => s.callsign === 'W2XYZ');
  assert.deepEqual([added.state, added.addedBy, added.logger], ['in', 'K1ABC', false]);
  assert.equal(net.log.at(-1).msg, 'W2XYZ, N0TST checked in by K1ABC (logger)');
  // net control's own check-ins are logged as before
  d.runCommand(net, alice, '/ci K9LMN');
  assert.equal(net.log.at(-1).msg, 'K9LMN checked in by W1AW');
});

test('a logger can use /ci and /co and nothing else', () => {
  const net = netWithTwo();
  d.runCommand(net, alice, '/logger K1ABC');
  for (const cmd of ['/close', '/start', '/ncs N3QRS', '/ack N3QRS', '/rst N3QRS 59', '/drop N3QRS', '/mute N3QRS', '/unmute N3QRS', '/note hi', '/logger N3QRS', '/rlogger K1ABC', '/bogus']) {
    const r = d.runCommand(net, bob, cmd);
    assert.equal(r.ok, false, cmd);
    assert.equal(r.error, 'Loggers can only use /ci and /co.', cmd);
  }
  assert.equal(net.status, 'live');
  assert.ok(!net.stations.find((s) => s.callsign === 'N3QRS').logger); // a logger cannot make more loggers
  assert.match(d.runCommand(net, carol, '/ci W2XYZ').error, /Only net control/); // not a logger: same refusal as before
});

test('/rlogger takes the role away, for several at once', () => {
  const net = netWithTwo();
  d.runCommand(net, alice, '/logger K1ABC N3QRS');
  const r = d.runCommand(net, alice, '/rlogger k1abc n3qrs');
  assert.ok(r.ok);
  assert.equal(net.log.at(-1).msg, 'K1ABC, N3QRS are no longer loggers');
  assert.ok(!d.isLogger(net, bob));
  assert.match(d.runCommand(net, bob, '/ci W2XYZ').error, /Only net control/); // back to an ordinary station

  d.runCommand(net, alice, '/logger K1ABC');
  const mixed = d.runCommand(net, alice, '/rlogger K1ABC N3QRS NOBODY1');
  assert.equal(mixed.notice, 'Changed 1. Skipped: N3QRS (not a logger), NOBODY1 (not a valid callsign).');
  assert.equal(d.runCommand(net, alice, '/rlogger N3QRS').error, 'N3QRS: not a logger.');
  assert.equal(d.runCommand(net, alice, '/rlogger W9XYZ').error, 'W9XYZ: not on the list.');
});

test('the logger role ends when they check out, and does not come back by itself', () => {
  const net = netWithTwo();
  d.runCommand(net, alice, '/logger K1ABC');
  d.leave(net, bob);
  assert.ok(!d.isLogger(net, bob));
  d.join(net, bob);
  assert.ok(!d.isLogger(net, bob));
  assert.match(d.runCommand(net, bob, '/ci W2XYZ').error, /Only net control/);
  assert.ok(d.runCommand(net, alice, '/logger K1ABC').ok); // net control can name them again
});

test('handing over net control to a logger clears the label; net control cannot be a logger', () => {
  const net = netWithTwo();
  d.runCommand(net, alice, '/logger K1ABC');
  d.runCommand(net, alice, '/ncs K1ABC');
  assert.equal(net.stations.find((s) => s.callsign === 'K1ABC').logger, false);
  assert.ok(d.isControl(net, bob)); // full control now
  assert.match(d.runCommand(net, bob, '/logger K1ABC').error, /K1ABC: already has full control\./);
});

test('the logger role belongs to the account, not just the callsign', () => {
  const net = netWithTwo();
  d.runCommand(net, alice, '/logger K1ABC');
  const impostor = { email: 'i@x.org', callsign: 'K1ABC' };
  assert.ok(!d.isLogger(net, impostor));
  assert.match(d.runCommand(net, impostor, '/ci W2XYZ').error, /Only net control/);
});

test('each person is shown only the commands they may use', () => {
  const net = netWithTwo();
  d.runCommand(net, alice, '/logger K1ABC');
  assert.deepEqual(d.commandsFor(net, alice), d.COMMANDS); // net control: everything
  assert.deepEqual(d.commandsFor(net, bob).map((c) => c.usage), ['/ci CALL [CALL ...]', '/co CALL [CALL ...]']); // a logger: add and remove
  assert.deepEqual(d.commandsFor(net, carol), []); // an ordinary station: none
  assert.deepEqual(d.commandsFor(net, undefined), []); // a visitor: none
  assert.ok(d.COMMANDS.some((c) => c.usage.startsWith('/logger')) && d.COMMANDS.some((c) => c.usage.startsWith('/rlogger')));
});

test('the role is removed with /rlogger; the old /unlogger name no longer exists', () => {
  const net = netWithTwo();
  d.runCommand(net, alice, '/logger K1ABC');
  const gone = d.runCommand(net, alice, '/unlogger K1ABC');
  assert.equal(gone.ok, false);
  assert.match(gone.error, /Unknown command/);
  assert.ok(d.isLogger(net, bob)); // the old name did nothing
  assert.ok(d.runCommand(net, alice, '/rlogger K1ABC').ok);
  assert.ok(!d.isLogger(net, bob));
  assert.ok(!d.COMMANDS.some((c) => /unlogger/.test(c.usage)));
  assert.ok(d.COMMANDS.some((c) => c.usage === '/rlogger CALL [CALL ...]'));
  assert.match(d.runCommand(net, alice, '/rlogger').error, /for example \/rlogger W1AW K1ABC/);
});

/* ---------- /co (check stations out) ---------- */

test('/co checks out one or several stations; they stay on the ledger marked Out', () => {
  const net = liveNet();
  d.runCommand(net, alice, '/ci W2XYZ K1ABC N3QRS');
  const r = d.runCommand(net, alice, '/co w2xyz n3qrs', 200);
  assert.ok(r.ok);
  assert.equal(r.notice, undefined);
  assert.deepEqual(net.stations.map((s) => [s.callsign, s.state, s.seq]), [['W2XYZ', 'out', 1], ['K1ABC', 'in', 2], ['N3QRS', 'out', 3]]);
  assert.equal(net.stations.length, 3); // nothing was removed: that is what /drop is for
  assert.equal(net.log.at(-1).msg, 'W2XYZ, N3QRS checked out by W1AW'); // one log line for the group
  assert.ok(!JSON.stringify(d.publicView(net)).includes('@'));
});

test('/co does what the Check out button does: lowers the hand and ends a logger role', () => {
  const net = netWithTwo();
  d.runCommand(net, alice, '/logger K1ABC');
  d.toggleHand(net, carol);
  assert.equal(net.stations.find((s) => s.callsign === 'N3QRS').hand, true);
  assert.ok(d.isLogger(net, bob));
  d.runCommand(net, alice, '/co K1ABC N3QRS');
  for (const s of net.stations) assert.deepEqual([s.state, s.hand, s.handAt, s.logger], ['out', false, null, false]);
  assert.ok(!d.isLogger(net, bob));
});

test('/co works for stations nobody signed in as, and a station can be checked straight back in', () => {
  const net = liveNet();
  d.runCommand(net, alice, '/ci W2XYZ'); // no account behind it
  assert.ok(d.runCommand(net, alice, '/co W2XYZ').ok);
  assert.equal(net.stations[0].state, 'out');
  assert.ok(d.runCommand(net, alice, '/ci W2XYZ').ok);
  assert.deepEqual([net.stations[0].state, net.stations[0].seq, net.stations.length], ['in', 1, 1]); // same entry, not a duplicate
});

test('/co skips what it cannot do, and says why', () => {
  const net = liveNet();
  d.runCommand(net, alice, '/ci W2XYZ K1ABC');
  d.runCommand(net, alice, '/co K1ABC');
  const mixed = d.runCommand(net, alice, '/co W2XYZ K1ABC W9XYZ HELLO');
  assert.ok(mixed.ok);
  assert.equal(mixed.notice, 'Checked out 1. Skipped: K1ABC (already checked out), W9XYZ (not on the list), HELLO (not a valid callsign).');
  const none = d.runCommand(net, alice, '/co K1ABC HELLO');
  assert.equal(none.ok, false);
  assert.equal(none.error, 'Nobody was checked out. K1ABC (already checked out), HELLO (not a valid callsign).');
  assert.equal(d.runCommand(net, alice, '/co W9XYZ').error, 'W9XYZ: not on the list.');
  assert.match(d.runCommand(net, alice, '/co').error, /Give at least one callsign, for example \/co W1AW K1ABC/);
  const many = Array.from({ length: 26 }, (_, i) => `K1A${String.fromCharCode(65 + i)}`);
  assert.match(d.runCommand(net, alice, `/co ${many.join(' ')}`).error, /at most 25/);
});

test('/co: ordinary stations cannot use it; a logger can, on ordinary stations and on themselves', () => {
  const net = netWithTwo();
  d.runCommand(net, alice, '/logger K1ABC');
  d.runCommand(net, alice, '/ci W2XYZ N0TST'); // no accounts behind these two
  assert.match(d.runCommand(net, carol, '/co K1ABC').error, /Only net control/); // an ordinary station: refused as before

  const r = d.runCommand(net, bob, '/co w2xyz n0tst', 300);
  assert.ok(r.ok);
  assert.deepEqual(['W2XYZ', 'N0TST'].map((c) => net.stations.find((s) => s.callsign === c).state), ['out', 'out']);
  assert.equal(net.log.at(-1).msg, 'W2XYZ, N0TST checked out by K1ABC (logger)'); // the log says a logger did it
  assert.equal(net.stations.find((s) => s.callsign === 'N3QRS').state, 'in'); // the one not named is untouched

  assert.ok(d.runCommand(net, bob, '/co K1ABC').ok); // a logger may check themselves out...
  assert.ok(!d.isLogger(net, bob)); // ...which, as ever, ends the role
});

test('/co: a logger cannot check out net control or another logger', () => {
  const net = netWithTwo();
  d.runCommand(net, alice, '/ci W2XYZ');
  d.join(net, alice); // the owner is on the ledger as net control
  d.runCommand(net, alice, '/logger K1ABC N3QRS');

  assert.equal(d.runCommand(net, bob, '/co W1AW').error, 'W1AW: is net control.');
  assert.equal(d.runCommand(net, bob, '/co N3QRS').error, 'N3QRS: is a logger, so only net control can check them out.');
  const mixed = d.runCommand(net, bob, '/co W2XYZ N3QRS W1AW');
  assert.ok(mixed.ok);
  assert.equal(mixed.notice, 'Checked out 1. Skipped: N3QRS (is a logger, so only net control can check them out), W1AW (is net control).');
  const by = Object.fromEntries(net.stations.map((s) => [s.callsign, s]));
  assert.deepEqual([by.W2XYZ.state, by.N3QRS.state, by.W1AW.state], ['out', 'in', 'in']);
  assert.ok(d.isLogger(net, carol)); // the other logger's role is untouched

  // net control can still check out a logger, which ends that role
  assert.ok(d.runCommand(net, alice, '/co N3QRS').ok);
  assert.ok(!d.isLogger(net, carol));
});

test('/co: after net control is handed over, a logger still cannot check out the new net control', () => {
  const net = netWithTwo();
  d.runCommand(net, alice, '/logger K1ABC');
  d.runCommand(net, alice, '/ncs N3QRS');
  assert.equal(d.runCommand(net, bob, '/co N3QRS').error, 'N3QRS: is net control.');
  assert.equal(net.stations.find((s) => s.callsign === 'N3QRS').state, 'in');
});

test('the old /checkin name is gone, and /ci and /co are in the command list', () => {
  const net = liveNet();
  const r = d.runCommand(net, alice, '/checkin W2XYZ');
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown command/);
  assert.equal(net.stations.length, 0);
  assert.ok(!d.COMMANDS.some((c) => /checkin/.test(c.usage)));
  assert.deepEqual(d.COMMANDS.slice(2, 4).map((c) => c.usage), ['/ci CALL [CALL ...]', '/co CALL [CALL ...]']);
});

test('name: free text from the operator, 2 to 40 characters with at least one letter', () => {
  assert.equal(d.normalizeName('  Hiram\u0000   Percy '), 'Hiram Percy');
  assert.equal(d.normalizeName('x'.repeat(100)).length, 40);
  assert.equal(d.normalizeName(undefined), '');
  for (const ok of ['Hi', 'Hiram', 'José', '田中', "D'Arcy", 'Mary-Ann']) assert.ok(d.isName(d.normalizeName(ok)), ok);
  for (const bad of ['', ' ', 'x', '12345', '--', '!!']) assert.ok(!d.isName(d.normalizeName(bad)), JSON.stringify(bad));
});

test('a station carries the name the operator typed, and the public view shows it (never the email)', () => {
  const net = liveNet();
  assert.ok(d.join(net, { ...bob, location: 'Ottawa, Canada', name: 'Bob' }).ok);
  assert.equal(net.stations[0].name, 'Bob');
  const view = d.publicView(net);
  assert.equal(view.stations[0].name, 'Bob');
  assert.ok(!JSON.stringify(view).includes('@'));
});

test('stations net control checks in have no name until the operator takes them over', () => {
  const net = liveNet();
  d.runCommand(net, alice, '/ci K1ABC');
  assert.equal(net.stations[0].name, null);
  d.toggleHand(net, { ...bob, location: 'Ottawa, Canada', name: 'Bob' });
  assert.equal(net.stations[0].name, 'Bob'); // filled in when the real operator acts
});
