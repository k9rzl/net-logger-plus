#!/usr/bin/env node
// One-off migration: copy a Net Logger Plus data/db.json into MongoDB.
//
//   npm install mongodb
//   node scripts/import-json-to-mongo.js --dry-run                 # check the file, change nothing
//   node scripts/import-json-to-mongo.js                           # import into an EMPTY database
//   node scripts/import-json-to-mongo.js --merge                   # add records that are missing
//   node scripts/import-json-to-mongo.js --replace --yes           # wipe Net Logger Plus collections, then import
//
// Options: --file PATH (default DATA_FILE or data/db.json)  --uri URL (default MONGODB_URI)
//          --db NAME (default MONGODB_DB or net-logger-plus)       --no-sessions (do not carry over logins)
import fs from 'node:fs';
import path from 'node:path';
import { loadDotEnv, ROOT } from '../src/config.js';
import { MongoStore } from '../src/mongostore.js';
import { validateExport, importInto } from '../src/migrate.js';
import { COLLECTIONS } from '../src/store.js';

function parseArgs(argv) {
  const opts = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument "${a}".`);
    const name = a.slice(2);
    if (['file', 'uri', 'db'].includes(name)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`--${name} needs a value.`);
      opts.values[name] = argv[++i];
    } else if (['dry-run', 'merge', 'replace', 'yes', 'no-sessions', 'help'].includes(name)) {
      opts.flags.add(name);
    } else {
      throw new Error(`Unknown option --${name}.`);
    }
  }
  return opts;
}

const table = (obj) => COLLECTIONS.map((c) => `  ${c.padEnd(9)} ${obj[c]}`).join('\n');

async function run(argv) {
  loadDotEnv();
  const { flags, values } = parseArgs(argv);
  if (flags.has('help')) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return 0;
  }
  if (flags.has('merge') && flags.has('replace')) throw new Error('Choose either --merge or --replace, not both.');
  if (flags.has('replace') && !flags.has('yes') && !flags.has('dry-run')) {
    throw new Error('--replace deletes every Net Logger Plus collection in the target database first. Add --yes to confirm.');
  }

  const file = path.resolve(ROOT, values.file || process.env.DATA_FILE || 'data/db.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read ${file}: ${e.message}`);
  }

  const { errors, warnings, data, dropped } = validateExport(raw, { keepSessions: !flags.has('no-sessions') });
  console.log(`Source: ${file}`);
  warnings.forEach((w) => console.log(`warning: ${w}`));
  if (errors.length) {
    errors.forEach((e) => console.error(`error: ${e}`));
    console.error(`\n${errors.length} problem(s) found. Nothing was imported.`);
    return 1;
  }
  const counts = Object.fromEntries(COLLECTIONS.map((c) => [c, Object.keys(data[c]).length]));
  console.log(`Valid. Records to import:\n${table(counts)}`);
  if (dropped.sessions || dropped.tokens) console.log(`Left out: ${dropped.sessions} expired/skipped session(s), ${dropped.tokens} expired sign-in token(s).`);

  if (flags.has('dry-run')) {
    console.log('\nDry run: the database was not contacted and nothing was written.');
    return 0;
  }

  const uri = values.uri || process.env.MONGODB_URI;
  if (!uri) throw new Error('No MongoDB URL. Pass --uri or set MONGODB_URI.');
  const dbName = values.db || process.env.MONGODB_DB || 'net-logger-plus';
  const mode = flags.has('replace') ? 'replace' : flags.has('merge') ? 'merge' : 'empty';

  const store = await MongoStore.connect({ uri, dbName });
  try {
    const result = await importInto(store, data, { mode });
    console.log(`\nImported into "${dbName}" (${mode} mode):\n${table(result.imported)}`);
    if (COLLECTIONS.some((c) => result.skipped[c])) console.log(`Skipped (already present):\n${table(result.skipped)}`);
    if (COLLECTIONS.some((c) => result.removed[c])) console.log(`Removed before import:\n${table(result.removed)}`);
    console.log('\nDone. Start Net Logger Plus with MONGODB_URI set.');
    return 0;
  } finally {
    await store.client?.close();
  }
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  },
);
