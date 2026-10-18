import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));

// The oldest Node we claim to support. Everything below must agree with it, because the claim was once
// "18.18" while nothing ever tested it.
const MIN = '20.19.0';
const [MIN_MAJOR, MIN_MINOR] = MIN.split('.').map(Number);

test('package.json declares one minimum Node, and the optional MongoDB driver can run on it', () => {
  assert.equal(pkg.engines.node, `>=${MIN}`);
  const mongo = pkg.optionalDependencies.mongodb;
  assert.match(mongo, /^\^7\./); // driver 7.x requires Node 20.19.0 or newer, which is our minimum
});

test('the installer, the README and the CI matrix all agree with that minimum', () => {
  assert.match(read('deploy/install-debian.sh'), new RegExp(`Node\\.js ${MIN_MAJOR}\\.${MIN_MINOR} or newer is required`));
  assert.match(read('README.md'), new RegExp(`Requires Node ${MIN_MAJOR}\\.${MIN_MINOR} or newer`));
  const ci = read('.github/workflows/ci.yml');
  const matrix = ci.match(/node: \[([0-9, ]+)\]/)[1].split(',').map((n) => Number(n.trim()));
  assert.equal(Math.min(...matrix), MIN_MAJOR, 'CI must test the oldest supported major');
  assert.ok(matrix.includes(24), 'CI must test the current long-term-support Node');
});

test('nothing still claims the old, untested minimum', () => {
  for (const f of ['README.md', 'package.json', 'deploy/install-debian.sh', '.github/workflows/ci.yml']) {
    assert.doesNotMatch(read(f), /18\.18/, f);
  }
});

test('GitHub Actions use current majors, not the old v4', () => {
  const ci = read('.github/workflows/ci.yml');
  const uses = [...ci.matchAll(/uses: (actions\/[a-z-]+)@v(\d+)/g)].map((m) => [m[1], Number(m[2])]);
  assert.ok(uses.length >= 6);
  for (const [action, major] of uses) assert.ok(major >= 7, `${action}@v${major}`);
});

test('browser tests run on a Node that Playwright works on (not 26, where it currently hangs)', () => {
  const ci = read('.github/workflows/ci.yml');
  const e2e = ci.slice(ci.indexOf('  e2e:'), ci.indexOf('  install-script:'));
  assert.match(e2e, /node-version: 24/);
  assert.doesNotMatch(e2e, /node-version: 26/);
});
