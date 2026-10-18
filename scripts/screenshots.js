#!/usr/bin/env node
// Capture README screenshots of the real UI, filled with demo data.
//
//   npm install
//   npm run test:e2e:install        # one-time: downloads Chromium
//   npm run screenshots             # writes PNGs to docs/screenshots/
//
// Options: --out DIR   where to write the PNGs (default docs/screenshots)
//          --check     seed the demo data and verify it, without opening a browser
//
// It starts its own throw-away server (port 3300) and fake QRZ service (port 3301), so it never touches
// your real data or the real QRZ.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const APP = 'http://127.0.0.1:3300';
const QRZ = 'http://127.0.0.1:3301';
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const outDir = path.resolve(ROOT, value('out') || 'docs/screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function start(file, env) {
  const child = spawn(process.execPath, [file], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
  children.push(child);
  return child;
}

async function waitFor(url, what) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`${what} did not start (${url})`);
}

let ipSeq = 0;
const nextIp = () => `10.9.0.${++ipSeq}`; // the server rate-limits sign-ins per client address

/** A tiny API client with its own session cookie, like one person's browser. */
function person() {
  const ip = nextIp();
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(APP + url, {
      method,
      headers: { 'x-net-logger-plus': '1', 'x-forwarded-for': ip, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} failed (${res.status}): ${data.error || ''}`);
    return data;
  };
  return {
    ip,
    call,
    session: () => cookie.replace(/^nl_session=/, ''),
    async signIn(email, callsign, location) {
      const r = await call('POST', '/api/auth/request', { email });
      await call('POST', '/api/auth/verify', { token: r.devLink.split('#')[1] });
      await call('POST', '/api/me', { callsign, location });
    },
  };
}

/** Three operators, three nets, and a ledger with every kind of row the page can draw. */
async function seed() {
  const alice = person(), bob = person(), carol = person();
  await alice.signIn('alice@example.org', 'W1AW', 'Albany, NY');
  await bob.signIn('bob@example.org', 'K1ABC', 'Ottawa, Canada');
  await carol.signIn('carol@example.org', 'N3QRS', 'Harrisburg, PA');

  const make = async (name, frequency, mode, description) =>
    (await alice.call('POST', '/api/nets', { name, frequency, mode, description })).id;
  const cmd = (id, text) => alice.call('POST', `/api/nets/${id}/command`, { text });

  const old = await make('Club check-in', '147.300 MHz', 'FM', '');
  await cmd(old, '/start');
  await cmd(old, '/close');
  const later = await make('Sunday digital roundtable', '14.074 MHz', 'Digital', 'FT8 and PSK31 operators welcome.');
  const live = await make('Tuesday evening net', '146.520 MHz', 'FM', 'Weekly check-in for the county. Visitors welcome.');

  await cmd(live, '/start');
  for (const who of [alice, bob, carol]) await who.call('POST', `/api/nets/${live}/join`, {});
  await cmd(live, '/ci W2XYZ N0TST');
  await cmd(live, '/logger K1ABC');
  await carol.call('POST', `/api/nets/${live}/hand`, {});
  await cmd(live, '/rst W1AW 59');
  await cmd(live, '/rst K1ABC 57');
  await cmd(live, '/co N0TST');
  await cmd(live, '/note Weather watch: severe storms possible after 21:00 local');
  await carol.call('POST', `/api/nets/${live}/chat`, { text: 'Good evening, net. Strong signal here in Harrisburg.' });
  await bob.call('POST', `/api/nets/${live}/chat`, { text: 'Evening from Ottawa. Logging check-ins tonight.' });
  await alice.call('POST', `/api/nets/${live}/chat`, { text: 'Thanks both. Send traffic after the roll call.' });
  await sleep(600); // let the QRZ names arrive

  return { alice, bob, carol, live, later, old };
}

async function check({ live }) {
  const { net } = await person().call('GET', `/api/nets/${live}`);
  const by = Object.fromEntries(net.stations.map((s) => [s.callsign, s]));
  const problems = [];
  if (net.stations.length !== 5) problems.push(`expected 5 stations, got ${net.stations.length}`);
  if (!by.K1ABC?.logger) problems.push('K1ABC should be a logger');
  if (!by.N3QRS?.hand) problems.push('N3QRS should have a hand up');
  if (by.N0TST?.state !== 'out') problems.push('N0TST should be checked out');
  if (by.W2XYZ?.info?.name !== 'Pat') problems.push('QRZ details did not arrive');
  if (problems.length) throw new Error(`Demo data is not as expected:\n- ${problems.join('\n- ')}`);
  console.log(`Demo data OK: ${net.stations.length} stations, ${net.log.length} log lines.`);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-logger-plus-shots-'));
  try {
    start('e2e/fake-qrz.js', { FAKE_QRZ_PORT: '3301' });
    start('src/server.js', {
      PORT: '3300', BASE_URL: APP, DEV_LINKS: '1', TRUST_PROXY: '1', NODE_ENV: 'development', SESSION_SECRET: '',
      DATA_FILE: path.join(dataDir, 'db.json'), QRZ_USERNAME: 'e2e', QRZ_PASSWORD: 'e2e', QRZ_BASE_URL: `${QRZ}/xml/current/`,
      MONGODB_URI: '', MAIL_WEBHOOK_URL: '', QRZ_REQUIRE: '0',
    });
    await waitFor(`${QRZ}/health`, 'The fake QRZ service');
    await waitFor(`${APP}/api/me`, 'Net Logger Plus');

    const demo = await seed();
    await check(demo);
    if (flag('check')) return;

    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new Error('Playwright is not installed. Run: npm install && npm run test:e2e:install');
    }
    const browser = await chromium.launch().catch((e) => {
      throw new Error(`Could not start Chromium (${e.message.split('\n')[0]}). Run: npm run test:e2e:install`);
    });
    fs.mkdirSync(outDir, { recursive: true });

    // Each shot is a separate browser context: a visitor, or someone signed in with the session made above.
    const shoot = async (name, { as, hash, size, wait }) => {
      const context = await browser.newContext({
        viewport: size,
        deviceScaleFactor: 2,
        baseURL: APP,
        extraHTTPHeaders: { 'x-forwarded-for': as?.ip || nextIp() },
      });
      if (as) await context.addCookies([{ name: 'nl_session', value: as.session(), url: APP }]);
      const page = await context.newPage();
      await page.goto(`/#/${hash}`);
      await page.waitForSelector(wait, { timeout: 10_000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
      await context.close();
      console.log(`wrote ${path.relative(ROOT, path.join(outDir, `${name}.png`))}`);
    };

    const desktop = { width: 960, height: 800 };
    const phone = { width: 390, height: 844 };
    const net = `net/${demo.live}`;
    const ledger = '.ledger tbody tr .op';
    await shoot('home', { as: demo.alice, hash: '', size: desktop, wait: '.nets li .net-row' });
    await shoot('home-signed-out', { hash: '', size: desktop, wait: '.nets li .net-row' });
    await shoot('net-control', { as: demo.alice, hash: net, size: desktop, wait: ledger });
    await shoot('net-logger', { as: demo.bob, hash: net, size: desktop, wait: ledger });
    await shoot('net-visitor', { hash: net, size: desktop, wait: ledger });
    await shoot('net-phone', { as: demo.alice, hash: net, size: phone, wait: ledger });
    await browser.close();
    console.log(`\nDone. Screenshots are in ${path.relative(ROOT, outDir)}/`);
  } finally {
    // Stop the servers first: the app writes its data file as it shuts down.
    await Promise.all(children.map((c) => new Promise((done) => {
      if (c.exitCode !== null) return done();
      c.once('exit', done);
      c.kill();
    })));
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  },
);
