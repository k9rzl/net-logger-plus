import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoStore } from '../src/mongostore.js';
import { fakeDb } from '../test-support/fakedb.js';

test('writes survive a restart (reload from the same database)', async () => {
  const db = fakeDb();
  const a = new MongoStore(db);
  a.data.users['a@x.org'] = { email: 'a@x.org', callsign: 'W1AW' };
  a.data.nets.n1 = { id: 'n1', name: 'Net', stations: [{ callsign: 'W1AW' }], log: [] };
  a.data.chat.n1 = [{ id: 'm1', text: 'hi' }];
  await a.flush();

  const b = new MongoStore(db);
  await b.load();
  assert.deepEqual(b.data.users, a.data.users);
  assert.deepEqual(b.data.nets, a.data.nets);
  assert.deepEqual(b.data.chat, a.data.chat); // arrays round-trip through the {list} wrapper
});

test('only changed documents are written', async () => {
  const db = fakeDb();
  const s = new MongoStore(db);
  s.data.nets.n1 = { id: 'n1', v: 1 };
  s.data.nets.n2 = { id: 'n2', v: 1 };
  await s.flush();
  assert.equal(db.stats.ops, 2);
  s.data.nets.n2.v = 2;
  await s.flush();
  assert.equal(db.stats.ops, 3);
  await s.flush(); // nothing changed
  assert.equal(db.stats.ops, 3);
});

test('deleted documents are removed from the database', async () => {
  const db = fakeDb();
  const s = new MongoStore(db);
  s.data.nets.n1 = { id: 'n1' };
  await s.flush();
  delete s.data.nets.n1;
  await s.flush();
  assert.equal(db.cols.nets.docs.size, 0);
});

test('sessions and tokens get an expAt date for TTL expiry', async () => {
  const db = fakeDb();
  const s = new MongoStore(db);
  s.data.sessions.h = { email: 'a@x.org', exp: Date.UTC(2030, 0, 1) };
  await s.flush();
  const doc = db.cols.sessions.docs.get('h');
  assert.ok(doc.expAt instanceof Date);
  assert.equal(doc.expAt.getTime(), Date.UTC(2030, 0, 1));
  await s.init(); // creates the TTL indexes
  assert.ok(db.stats.indexes.some(([c, spec, o]) => c === 'sessions' && spec.expAt === 1 && o.expireAfterSeconds === 0));
  assert.ok(db.stats.indexes.some(([c]) => c === 'tokens'));
});

test('a failed write is retried on the next flush instead of being lost', async () => {
  const db = fakeDb();
  const s = new MongoStore(db);
  s.data.nets.n1 = { id: 'n1' };
  db.stats.failNext = true;
  const orig = console.error;
  console.error = () => {};
  await s.flush();
  console.error = orig;
  assert.equal(db.cols.nets?.docs.size ?? 0, 0);
  await s.flush();
  assert.equal(db.cols.nets.docs.size, 1);
});
