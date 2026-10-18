import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const pub = (f) => fileURLToPath(new URL(`../public/js/${f}`, import.meta.url));

/** A stand-in for EventSource that records what was opened and lets a test push events through. */
function fakeEventSource() {
  class FakeES {
    constructor(url) { this.url = url; this.closed = false; this.handlers = {}; FakeES.all.push(this); }
    addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
    close() { this.closed = true; }
    emit(type, data) { (this.handlers[type] || []).forEach((fn) => fn({ data: JSON.stringify(data) })); }
  }
  FakeES.all = [];
  return FakeES;
}

/** Run the real worker script against fake ports, the way a browser would. */
function workerHarness() {
  const ES = fakeEventSource();
  const ctx = vm.createContext({ EventSource: ES });
  vm.runInContext(fs.readFileSync(pub('stream-worker.js'), 'utf8'), ctx);
  const tab = () => {
    const got = [];
    const port = { postMessage: (m) => got.push(m), onmessage: null };
    ctx.onconnect({ ports: [port] });
    return { got, send: (m) => port.onmessage({ data: m }) };
  };
  return { ES, tab };
}
const NET = 'abcdef0123';
const plain = (x) => JSON.parse(JSON.stringify(x)); // objects built inside the worker's VM context differ by prototype

test('worker: many tabs watching one net share a single connection, and every tab gets each event', () => {
  const { ES, tab } = workerHarness();
  const tabs = Array.from({ length: 8 }, tab);
  tabs.forEach((t) => t.send({ cmd: 'sub', id: NET, chat: true }));
  assert.equal(ES.all.length, 1);
  assert.equal(ES.all[0].url, `/api/nets/${NET}/events`);
  ES.all[0].emit('msg', { id: 'm1', text: 'hi' });
  for (const t of tabs) assert.deepEqual(plain(t.got), [{ type: 'msg', data: { id: 'm1', text: 'hi' } }]);
});

test('worker: visitors and signed-in viewers use separate connections, so chat never reaches a visitor', () => {
  const { ES, tab } = workerHarness();
  const member = tab(), visitor = tab();
  member.send({ cmd: 'sub', id: NET, chat: true });
  visitor.send({ cmd: 'sub', id: NET, chat: false });
  assert.equal(ES.all.length, 2);
  ES.all[0].emit('msg', { id: 'm1', text: 'private chatter' });
  assert.equal(member.got.length, 1);
  assert.equal(visitor.got.length, 0);
});

test('worker: a tab that joins later is handed the latest ledger straight away', () => {
  const { ES, tab } = workerHarness();
  const first = tab();
  first.send({ cmd: 'sub', id: NET, chat: false });
  ES.all[0].emit('net', { status: 'live', stations: [1] });
  const late = tab();
  late.send({ cmd: 'sub', id: NET, chat: false });
  assert.deepEqual(plain(late.got), [{ type: 'net', data: { status: 'live', stations: [1] } }]);
  assert.equal(ES.all.length, 1);
});

test('worker: the connection closes when the last tab leaves, and only then', () => {
  const { ES, tab } = workerHarness();
  const a = tab(), b = tab();
  a.send({ cmd: 'sub', id: NET, chat: true });
  b.send({ cmd: 'sub', id: NET, chat: true });
  a.send({ cmd: 'unsub', id: NET, chat: true });
  assert.equal(ES.all[0].closed, false);
  ES.all[0].emit('del', { id: 'm1' });
  assert.equal(a.got.length, 0); // a left: nothing more for it
  assert.equal(b.got.length, 1);
  b.send({ cmd: 'unsub', id: NET, chat: true });
  assert.equal(ES.all[0].closed, true);
  a.send({ cmd: 'sub', id: NET, chat: true }); // watching again opens a fresh connection
  assert.equal(ES.all.length, 2);
});

test('worker: ignores nonsense (bad net ids, repeated subscriptions)', () => {
  const { ES, tab } = workerHarness();
  const t = tab();
  t.send({ cmd: 'sub', id: '../../etc/passwd', chat: true });
  t.send({ cmd: 'sub' });
  assert.equal(ES.all.length, 0);
  t.send({ cmd: 'sub', id: NET, chat: true });
  t.send({ cmd: 'sub', id: NET, chat: true });
  ES.all[0].emit('msg', { id: 'm1' });
  assert.equal(t.got.length, 1); // one subscription, one copy
});

/* ---------- the page side ---------- */

async function withGlobals(globals, fn) {
  const before = Object.fromEntries(Object.keys(globals).map((k) => [k, globalThis[k]]));
  for (const [k, v] of Object.entries(globals)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  }
}
const loadStream = () => import('../public/js/stream.js');

test('page: without SharedWorker each tab opens its own stream and events reach the callback', async () => {
  const ES = fakeEventSource();
  await withGlobals({ EventSource: ES, SharedWorker: undefined }, async () => {
    const { openNetStream } = await loadStream();
    const seen = [];
    const s = openNetStream(NET, true, (type, data) => seen.push([type, data]));
    assert.equal(ES.all.length, 1);
    ES.all[0].emit('net', { a: 1 });
    ES.all[0].emit('msg', { id: 'm' });
    assert.deepEqual(seen, [['net', { a: 1 }], ['msg', { id: 'm' }]]);
    s.close();
    assert.equal(ES.all[0].closed, true);
  });
});

test('page: with SharedWorker it subscribes through the worker and opens no stream of its own', async () => {
  const ES = fakeEventSource();
  const posted = [];
  class FakeSW {
    constructor(url) { this.url = url; this.port = { postMessage: (m) => posted.push(m), close() {}, onmessage: null }; FakeSW.last = this; }
  }
  await withGlobals({ EventSource: ES, SharedWorker: FakeSW }, async () => {
    const { openNetStream } = await loadStream();
    const seen = [];
    const s = openNetStream(NET, true, (type, data) => seen.push([type, data]));
    assert.equal(FakeSW.last.url, '/js/stream-worker.js');
    assert.deepEqual(posted, [{ cmd: 'sub', id: NET, chat: true }]);
    assert.equal(ES.all.length, 0);
    FakeSW.last.port.onmessage({ data: { type: 'net', data: { b: 2 } } });
    assert.deepEqual(seen, [['net', { b: 2 }]]);
    s.close();
    assert.deepEqual(posted.at(-1), { cmd: 'unsub', id: NET, chat: true });
  });
});

test('page: if the worker cannot load, it falls back to a stream of its own', async () => {
  const ES = fakeEventSource();
  class BrokenSW { constructor() { this.port = { postMessage() {}, close() {} }; BrokenSW.last = this; } }
  await withGlobals({ EventSource: ES, SharedWorker: BrokenSW }, async () => {
    const { openNetStream } = await loadStream();
    const seen = [];
    openNetStream(NET, false, (type, data) => seen.push([type, data]));
    assert.equal(ES.all.length, 0);
    BrokenSW.last.onerror(); // the browser reports the script failed to load
    assert.equal(ES.all.length, 1);
    ES.all[0].emit('net', { c: 3 });
    assert.deepEqual(seen, [['net', { c: 3 }]]);
  });
  const Throwing = class { constructor() { throw new Error('blocked'); } };
  const ES2 = fakeEventSource();
  await withGlobals({ EventSource: ES2, SharedWorker: Throwing }, async () => {
    const { openNetStream } = await loadStream();
    openNetStream(NET, false, () => {});
    assert.equal(ES2.all.length, 1); // constructing the worker threw: straight to a stream of its own
  });
});
