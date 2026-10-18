import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sniffImage, createAvatarStore, MAX_AVATAR_BYTES } from '../src/avatars.js';
import { loadConfig } from '../src/config.js';
import * as d from '../src/domain.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(20)]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'net-logger-plus-av-'));

test('sniffImage trusts the bytes: JPEG, PNG and WebP only', () => {
  assert.deepEqual([PNG, JPG, WEBP].map(sniffImage), ['png', 'jpg', 'webp']);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(30)]);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(20)]);
  for (const bad of [gif, svg, wav, Buffer.from('<html></html>'.repeat(3)), Buffer.alloc(40), Buffer.from([0xff, 0xd8]), 'png', null, undefined]) {
    assert.equal(sniffImage(bad), null);
  }
});

test('the store saves under a random id, finds it again, and removes it', () => {
  const dir = path.join(tmp(), 'avatars'); // created on first save
  const store = createAvatarStore(dir);
  const id = store.save(PNG);
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.notEqual(store.save(PNG), id); // every upload is a fresh id
  const found = store.find(id);
  assert.equal(found.type, 'image/png');
  assert.deepEqual(fs.readFileSync(found.file), PNG);
  store.remove(id);
  assert.equal(store.find(id), null);
  store.remove(id); // removing twice is harmless
  store.remove('../../etc/passwd'); // and a bad id never touches anything
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp'))); // no half-written leftovers
});

test('the store refuses non-images and oversized files, and stores nothing', () => {
  const dir = tmp();
  const store = createAvatarStore(dir);
  assert.throws(() => store.save(Buffer.from('<svg onload="x()"></svg> padding padding')), /not a JPEG, PNG or WebP/);
  assert.throws(() => store.save(Buffer.concat([JPG, Buffer.alloc(MAX_AVATAR_BYTES)])), /too large/);
  assert.equal(fs.readdirSync(dir).length, 0);
  for (const bad of ['', 'xyz', '../x', 'A'.repeat(32), 'a'.repeat(31)]) assert.equal(store.find(bad), null, bad);
});

test('config: pictures live beside the data file unless AVATAR_DIR says otherwise', () => {
  const secret = 'k'.repeat(40);
  const dflt = loadConfig({ SESSION_SECRET: secret, DATA_FILE: '/var/lib/net-logger-plus/db.json' });
  assert.equal(dflt.avatarDir, '/var/lib/net-logger-plus/avatars');
  assert.equal(loadConfig({ SESSION_SECRET: secret, AVATAR_DIR: '/srv/pics' }).avatarDir, '/srv/pics');
});

test('ledger stations carry the picture id, take it over with the entry, and the public view still has no email', () => {
  const alice = { email: 'a@x.org', callsign: 'W1AW' };
  const bob = { email: 'b@x.org', callsign: 'K1ABC', avatar: { id: 'b'.repeat(32) } };
  const { net } = d.createNet(alice, { name: 'Test Net', frequency: '1', mode: 'FM' }, 1, 'aaaaaaaaaa');
  d.runCommand(net, alice, '/start');
  d.join(net, alice);
  d.runCommand(net, alice, '/ci K1ABC'); // checked in by net control: no account, so no picture
  assert.equal(net.stations.find((s) => s.callsign === 'K1ABC').avatar ?? null, null);
  d.toggleHand(net, bob); // Bob takes the entry over
  assert.equal(net.stations.find((s) => s.callsign === 'K1ABC').avatar, 'b'.repeat(32));
  assert.equal(net.stations.find((s) => s.callsign === 'W1AW').avatar, null);

  const view = d.publicView(net);
  assert.equal(view.stations.find((s) => s.callsign === 'K1ABC').avatar, 'b'.repeat(32));
  assert.ok(!JSON.stringify(view).includes('@'));
});
