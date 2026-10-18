import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import * as chat from '../src/chat.js';
import * as d from '../src/domain.js';

const alice = { email: 'a@x.org', callsign: 'W1AW' };
const bob = { email: 'b@x.org', callsign: 'K1ABC' };
const setup = () => {
  const store = new Store(null);
  const { net } = d.createNet(alice, { name: 'Test Net', frequency: '1', mode: 'FM' }, 1, 'aaaaaaaaaa');
  store.data.nets[net.id] = net;
  return { store, net };
};

test('posting stores a cleaned message', () => {
  const { store, net } = setup();
  const r = chat.postMessage(store, net, bob, '  hello\u0000   net  ', 5);
  assert.ok(r.ok);
  assert.equal(r.msg.text, 'hello net');
  assert.equal(chat.messages(store, net.id).length, 1);
});

test('requires callsign, text, and an open net', () => {
  const { store, net } = setup();
  assert.ok(!chat.postMessage(store, net, { email: 'x@y.z' }, 'hi').ok);
  assert.ok(!chat.postMessage(store, net, bob, '   ').ok);
  net.status = 'closed';
  assert.match(chat.postMessage(store, net, bob, 'hi').error, /read-only/);
});

test('history is capped', () => {
  const { store, net } = setup();
  for (let i = 0; i < chat.MAX_MESSAGES + 25; i++) chat.postMessage(store, net, bob, `m${i}`);
  const list = chat.messages(store, net.id);
  assert.equal(list.length, chat.MAX_MESSAGES);
  assert.equal(list.at(-1).text, `m${chat.MAX_MESSAGES + 24}`);
});

test('long messages are truncated', () => {
  const { store, net } = setup();
  const r = chat.postMessage(store, net, bob, 'x'.repeat(5000));
  assert.equal(r.msg.text.length, chat.MAX_TEXT);
});

test('mute blocks chat, unmute restores it; owner cannot be muted', () => {
  const { store, net } = setup();
  d.runCommand(net, alice, '/start');
  assert.ok(d.runCommand(net, alice, '/mute K1ABC').ok);
  assert.match(chat.postMessage(store, net, bob, 'hi').error, /muted/);
  assert.ok(d.runCommand(net, alice, '/unmute K1ABC').ok);
  assert.ok(chat.postMessage(store, net, bob, 'hi').ok);
  assert.ok(!d.runCommand(net, alice, '/mute W1AW').ok);
  assert.ok(!d.runCommand(net, alice, '/mute nonsense').ok);
});

test('deleteMessage removes by id', () => {
  const { store, net } = setup();
  const { msg } = chat.postMessage(store, net, bob, 'hi');
  assert.ok(chat.deleteMessage(store, net.id, msg.id));
  assert.ok(!chat.deleteMessage(store, net.id, msg.id));
});

test('pruneNets removes old closed and never-started nets with their chat', () => {
  const { store, net } = setup();
  chat.postMessage(store, net, bob, 'hi');
  const day = 24 * 60 * 60 * 1000;
  assert.equal(d.pruneNets(store.data, 10 * day), 0); // not old enough
  assert.equal(d.pruneNets(store.data, 40 * day), 1); // scheduled and stale
  assert.deepEqual(store.data.nets, {});
  assert.deepEqual(store.data.chat, {});
});
