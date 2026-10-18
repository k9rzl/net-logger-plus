import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { MongoStore } from '../src/mongostore.js';
import { validateExport, importInto } from '../src/migrate.js';
import { fakeDb } from '../test-support/fakedb.js';

const NOW = 1_000_000;
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'import-json-to-mongo.js');

const sample = () => ({
  users: { 'a@x.org': { email: 'a@x.org', callsign: 'W1AW', createdAt: 1 } },
  sessions: {
    live: { email: 'a@x.org', exp: NOW + 5000 },
    old: { email: 'a@x.org', exp: NOW - 5 },
  },
  tokens: { stale: { email: 'a@x.org', exp: NOW - 1 }, fresh: { email: 'a@x.org', exp: NOW + 1 } },
  nets: { n1: { id: 'n1', name: 'Net', status: 'live', stations: [{ callsign: 'W1AW', state: 'in' }], log: [{ t: 1, msg: 'x' }] } },
  chat: { n1: [{ id: 'm1', t: 2, call: 'W1AW', text: 'hi' }] },
});

test('a valid export passes; expired sessions and tokens are dropped', () => {
  const r = validateExport(sample(), { now: NOW });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(Object.keys(r.data.sessions), ['live']);
  assert.deepEqual(Object.keys(r.data.tokens), ['fresh']);
  assert.deepEqual(r.dropped, { sessions: 1, tokens: 1 });
  assert.equal(r.data.chat.n1.length, 1);
});

test('--no-sessions style option drops live sessions too', () => {
  const r = validateExport(sample(), { now: NOW, keepSessions: false });
  assert.deepEqual(r.data.sessions, {});
});

test('malformed exports are reported, not imported', () => {
  assert.match(validateExport([], {}).errors[0], /not a JSON object/);
  const bad = sample();
  bad.users['a@x.org'].email = 'other@x.org';
  bad.nets.n1.id = 'zzz';
  bad.nets.n1.stations = 'nope';
  bad.chat.n1 = { not: 'array' };
  bad.sessions.live.exp = 'tomorrow';
  bad.tokens = [];
  const { errors } = validateExport(bad, { now: NOW });
  assert.ok(errors.length >= 6, errors.join('\n'));
  assert.ok(errors.some((e) => /does not match its key/.test(e)));
  assert.ok(errors.some((e) => /"tokens" must be an object/.test(e)));
});

test('unknown keys and orphaned chat only produce warnings', () => {
  const raw = sample();
  raw.extra = {};
  raw.chat.gone = [];
  const r = validateExport(raw, { now: NOW });
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 2);
});

test('import into an empty database round-trips exactly through MongoStore', async () => {
  const db = fakeDb();
  const store = new MongoStore(db);
  await store.load();
  const { data } = validateExport(sample(), { now: NOW });
  const r = await importInto(store, data, { mode: 'empty' });
  assert.equal(r.imported.nets, 1);
  assert.equal(r.imported.chat, 1);

  const fresh = new MongoStore(db); // what the app sees after restart
  await fresh.load();
  assert.deepEqual(fresh.data.users, data.users);
  assert.deepEqual(fresh.data.nets, data.nets);
  assert.deepEqual(fresh.data.chat, data.chat);
  assert.ok(db.cols.sessions.docs.get('live').expAt instanceof Date); // TTL field present
});

test('a non-empty database is refused by default and left untouched', async () => {
  const db = fakeDb();
  const seed = new MongoStore(db);
  seed.data.nets.keep = { id: 'keep', stations: [], log: [] };
  await seed.flush();
  const store = new MongoStore(db);
  await store.load();
  const { data } = validateExport(sample(), { now: NOW });
  await assert.rejects(() => importInto(store, data), /not empty \(nets: 1\)/);
  assert.equal(db.cols.nets.docs.size, 1);
});

test('merge adds missing records and never overwrites existing ones', async () => {
  const db = fakeDb();
  const seed = new MongoStore(db);
  seed.data.nets.n1 = { id: 'n1', name: 'EXISTING', stations: [], log: [] };
  await seed.flush();
  const store = new MongoStore(db);
  await store.load();
  const { data } = validateExport(sample(), { now: NOW });
  const r = await importInto(store, data, { mode: 'merge' });
  assert.equal(r.skipped.nets, 1);
  assert.equal(r.imported.users, 1);
  assert.equal(db.cols.nets.docs.get('n1').name, 'EXISTING');
  assert.ok(db.cols.users.docs.has('a@x.org'));
});

test('replace wipes existing Net Logger Plus documents first', async () => {
  const db = fakeDb();
  const seed = new MongoStore(db);
  seed.data.nets.old = { id: 'old', stations: [], log: [] };
  seed.data.users['z@x.org'] = { email: 'z@x.org' };
  await seed.flush();
  const store = new MongoStore(db);
  await store.load();
  const { data } = validateExport(sample(), { now: NOW });
  const r = await importInto(store, data, { mode: 'replace' });
  assert.equal(r.removed.nets, 1);
  assert.ok(!db.cols.nets.docs.has('old'));
  assert.ok(!db.cols.users.docs.has('z@x.org'));
  assert.ok(db.cols.nets.docs.has('n1'));
});

test('a database write failure surfaces as an error instead of a silent success', async () => {
  const db = fakeDb();
  const store = new MongoStore(db);
  await store.load();
  const { data } = validateExport(sample(), { now: NOW });
  db.stats.failNext = true;
  await assert.rejects(() => importInto(store, data), /network down/);
});

test('data written by the real JSON Store imports cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-logger-plus-'));
  const file = path.join(dir, 'db.json');
  const js = new Store(file);
  Object.assign(js.data, sample());
  js.flush();
  const { errors, data } = validateExport(JSON.parse(fs.readFileSync(file, 'utf8')), { now: NOW });
  assert.deepEqual(errors, []);
  assert.equal(Object.keys(data.nets).length, 1);
});

/* ---- the script itself (dry run needs no database) ---- */
const runCli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, MONGODB_URI: '' } });

function tmpFile(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-logger-plus-'));
  const f = path.join(dir, 'db.json');
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return f;
}

test('CLI --dry-run validates and reports without touching a database', () => {
  const r = runCli(['--dry-run', '--file', tmpFile(sample())]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Valid\. Records to import/);
  assert.match(r.stdout, /nets\s+1/);
  assert.match(r.stdout, /Dry run/);
});

test('CLI exits non-zero on an invalid or unreadable file', () => {
  const bad = sample();
  bad.nets.n1.id = 'wrong';
  const r1 = runCli(['--dry-run', '--file', tmpFile(bad)]);
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /Nothing was imported/);
  assert.equal(runCli(['--dry-run', '--file', tmpFile('{not json')]).status, 1);
  assert.equal(runCli(['--dry-run', '--file', '/nonexistent/db.json']).status, 1);
});

test('CLI guards: needs a URL, rejects conflicting or unconfirmed modes and unknown options', () => {
  const file = tmpFile(sample());
  assert.match(runCli(['--file', file]).stderr, /No MongoDB URL/);
  assert.match(runCli(['--merge', '--replace', '--file', file]).stderr, /either --merge or --replace/);
  assert.match(runCli(['--replace', '--file', file]).stderr, /Add --yes/);
  assert.match(runCli(['--bogus']).stderr, /Unknown option/);
});
