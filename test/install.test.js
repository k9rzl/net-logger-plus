import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'install-debian.sh');
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0;
const opts = { skip: !hasBash && 'bash not available' };

/** Run the installer into a scratch root (DESTDIR), exactly as it would run on a server minus apt/systemd. */
function install(args, root = fs.mkdtempSync(path.join(os.tmpdir(), 'net-logger-plus-inst-')), extraEnv = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, DESTDIR: root, ...extraEnv } });
  const read = (p) => (fs.existsSync(path.join(root, p)) ? fs.readFileSync(path.join(root, p), 'utf8') : null);
  const envText = read('etc/net-logger-plus/net-logger-plus.env');
  const env = Object.fromEntries((envText || '').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { root, status: r.status, out: r.stdout, err: r.stderr, env, envText, caddy: read('etc/caddy/Caddyfile'), read };
}
const siteLine = (caddy) => caddy.split('\n').find((l) => /\{$/.test(l) && !l.startsWith('\t') && !l.startsWith('#'));
/** What the running app would make of the settings the installer wrote. */
const asApp = (env) => loadConfig({ ...env, NODE_ENV: 'production' });

test('domain: HTTPS site, no tls block, HSTS on', opts, () => {
  const r = install(['--domain', 'nets.example.org', '--caddy']);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.env.BASE_URL, 'https://nets.example.org');
  assert.equal(siteLine(r.caddy), 'nets.example.org {');
  assert.ok(!/^\s*tls\b/m.test(r.caddy));
  assert.ok(!r.caddy.includes('__TLS__'));
  const app = asApp(r.env);
  assert.equal(app.hsts, true);
  assert.equal(app.secureCookie, true);
  assert.equal(r.env.SESSION_SECRET.length, 64);
  assert.equal(fs.statSync(path.join(r.root, 'etc/net-logger-plus/net-logger-plus.env')).mode & 0o777, 0o600);
});

test('ip (default): HTTPS with Caddy internal certificate; app has no HSTS but secure cookies', opts, () => {
  const r = install(['--ip', '203.0.113.10', '--caddy']);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.env.BASE_URL, 'https://203.0.113.10');
  assert.equal(siteLine(r.caddy), '203.0.113.10 {');
  assert.match(r.caddy, /^\ttls internal$/m);
  assert.match(r.out, /root\.crt/); // tells people how to trust it
  const app = asApp(r.env);
  assert.equal(app.baseIsIp, true);
  assert.equal(app.hsts, false);
  assert.equal(app.secureCookie, true);
});

test('ip + --tls none: plain HTTP site, loud warning, app flags it', opts, () => {
  const r = install(['--ip', '203.0.113.10', '--tls', 'none', '--caddy']);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.env.BASE_URL, 'http://203.0.113.10');
  assert.equal(siteLine(r.caddy), 'http://203.0.113.10 {');
  assert.ok(!/^\s*tls\b/m.test(r.caddy));
  assert.match(r.out, /NOT encrypted/);
  const app = asApp(r.env);
  assert.equal(app.secureCookie, false);
  assert.equal(app.plainHttp, true);
});

test('ip + --tls letsencrypt: short-lived IP certificate with internal fallback', opts, () => {
  const r = install(['--ip', '203.0.113.10', '--tls', 'letsencrypt', '--caddy']);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.env.BASE_URL, 'https://203.0.113.10');
  assert.match(r.caddy, /issuer acme \{\s+profile shortlived\s+\}\s+issuer internal/);
  assert.match(r.out, /Let's Encrypt must reach port 80/);
});

test('letsencrypt is refused for private addresses; other modes only note it', opts, () => {
  const bad = install(['--ip', '192.168.1.20', '--tls', 'letsencrypt', '--caddy']);
  assert.equal(bad.status, 1);
  assert.match(bad.err, /private address/);
  const ok = install(['--ip', '192.168.1.20', '--caddy']);
  assert.equal(ok.status, 0, ok.err);
  assert.match(ok.err, /looks like a private/);
  for (const a of ['10.0.0.5', '172.16.4.4', '172.31.0.1', '100.64.1.1', 'fd12:3456::1', 'fe80::1']) {
    assert.match(install(['--ip', a, '--tls', 'none']).err, /looks like a private/, a);
  }
  for (const a of ['203.0.113.10', '172.32.0.1', '8.8.8.8', '2001:db8::10']) {
    assert.doesNotMatch(install(['--ip', a, '--tls', 'none']).err, /looks like a private/, a);
  }
});

test('IPv6 addresses are bracketed in the URL and the Caddy site, and accepted by the app', opts, () => {
  const r = install(['--ip', '2001:DB8::10', '--caddy']);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.env.BASE_URL, 'https://[2001:db8::10]');
  assert.equal(siteLine(r.caddy), '[2001:db8::10] {');
  assert.equal(asApp(r.env).baseIsIp, true);
  const plain = install(['--ip', '2001:db8::10', '--tls', 'none', '--caddy']);
  assert.equal(plain.env.BASE_URL, 'http://[2001:db8::10]');
  assert.equal(siteLine(plain.caddy), 'http://[2001:db8::10] {');
});

test('invalid combinations and addresses are rejected before anything is installed', opts, () => {
  const cases = [
    [['--ip', '999.1.1.1'], /not a valid IPv4 or IPv6/],
    [['--ip', 'nets.example.org'], /not a valid IPv4 or IPv6/],
    [['--ip', '1.2.3'], /not a valid IPv4 or IPv6/],
    [['--domain', '203.0.113.10'], /does not look like a lowercase domain/],
    [['--domain', 'a.example.org', '--ip', '203.0.113.10'], /either --domain or --ip/],
    [['--domain', 'a.example.org', '--tls', 'none'], /--tls only applies with --ip/],
    [['--ip', '203.0.113.10', '--tls', 'bogus'], /--tls must be/],
    [['--ip'], /--ip needs a value/],
    [['--caddy'], /first install needs|--caddy needs/],
    [[], /first install needs/],
    [['--wat'], /unknown option/],
  ];
  for (const [args, re] of cases) {
    const r = install(args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.err, re, args.join(' '));
    assert.equal(r.read('etc/net-logger-plus/net-logger-plus.env'), null, `${args.join(' ')} must not write settings`);
  }
});

test('re-running keeps the secret; switching address updates BASE_URL and Caddyfile only', opts, () => {
  const first = install(['--domain', 'nets.example.org', '--caddy']);
  const secret = first.env.SESSION_SECRET;
  fs.appendFileSync(path.join(first.root, 'etc/net-logger-plus/net-logger-plus.env'), 'QRZ_USERNAME=custom\n'); // a hand edit

  const same = install([], first.root); // plain upgrade: no address flag at all
  assert.equal(same.status, 0, same.err);
  assert.equal(same.env.SESSION_SECRET, secret);
  assert.equal(same.env.BASE_URL, 'https://nets.example.org');

  const toIp = install(['--ip', '203.0.113.10', '--caddy'], first.root);
  assert.equal(toIp.status, 0, toIp.err);
  assert.match(toIp.out, /Updated BASE_URL: https:\/\/nets\.example\.org -> https:\/\/203\.0\.113\.10/);
  assert.equal(toIp.env.BASE_URL, 'https://203.0.113.10');
  assert.equal(toIp.env.SESSION_SECRET, secret);
  assert.equal(toIp.env.QRZ_USERNAME, 'custom'); // hand edits survive
  assert.equal(siteLine(toIp.caddy), '203.0.113.10 {');
  assert.ok(fs.readdirSync(path.join(first.root, 'etc/caddy')).some((f) => f.startsWith('Caddyfile.bak.')));

  const back = install(['--domain', 'other.example.org'], first.root);
  assert.equal(back.env.BASE_URL, 'https://other.example.org');
});

test('the installed copy is complete: app code, public files, settings and unit', opts, () => {
  const r = install(['--ip', '203.0.113.10']);
  for (const f of ['opt/net-logger-plus/src/server.js', 'opt/net-logger-plus/src/config.js', 'opt/net-logger-plus/public/index.html', 'opt/net-logger-plus/package.json', 'etc/systemd/system/net-logger-plus.service']) {
    assert.ok(r.read(f) !== null, f);
  }
  assert.equal(r.caddy, null); // no --caddy, no Caddyfile
  assert.match(r.out, /listens on 127\.0\.0\.1:3000 only/);
});

test('--ip auto either detects an address or fails with a clear message', opts, () => {
  const r = install(['--ip', 'auto', '--tls', 'none']);
  if (r.status === 0) assert.match(r.env.BASE_URL, /^http:\/\/\d+\.\d+\.\d+\.\d+$/);
  else assert.match(r.err, /auto-detect|could not detect/);
});

/* ---------- Node.js version rules (the script can pretend to be another version, in tests only) ---------- */
const asNode = (v) => ({ NET_LOGGER_PLUS_TEST_NODE_VERSION: v });
const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'net-logger-plus-node-'));

test('Node 20.19 and newer are accepted; only 20.x gets an end-of-life note', opts, () => {
  for (const v of ['20.19.0', '20.19.2', '20.20.2', '22.0.0', '22.23.2', '24.21.0', '26.7.0', '30.1.0']) {
    const r = install(['--ip', '203.0.113.10', '--tls', 'none'], mkroot(), asNode(v));
    assert.equal(r.status, 0, `${v}: ${r.err}`);
    assert.match(r.out, new RegExp(`Using Node\\.js ${v.replace(/\./g, '\\.')}`));
    if (v.startsWith('20.')) assert.match(r.err, /Node\.js 20 passed its upstream end of life in April 2026/);
    else assert.doesNotMatch(r.err, /end of life/, v);
  }
});

test('Node older than 20.19 is refused with a clear message, and nothing is installed', opts, () => {
  for (const v of ['18.20.8', '18.18.0', '19.9.0', '20.18.3', '20.0.0', '16.20.2']) {
    const r = install(['--ip', '203.0.113.10'], mkroot(), asNode(v));
    assert.equal(r.status, 1, v);
    assert.match(r.err, /Node\.js 20\.19 or newer is required/, v);
    assert.equal(r.read('etc/net-logger-plus/net-logger-plus.env'), null, `${v} must not write settings`);
    assert.equal(r.read('opt/net-logger-plus/src/server.js'), null, `${v} must not copy the app`);
  }
});

test('the test hook only works with DESTDIR, so a real install always looks at the real Node', opts, () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /\[ -n "\$DESTDIR" \] && \[ -n "\$\{NET_LOGGER_PLUS_TEST_NODE_VERSION:-\}" \]/);
});
