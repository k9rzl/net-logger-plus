import { COLLECTIONS } from './store.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Check a parsed db.json and return the records worth importing.
 * Expired sessions and sign-in tokens are dropped (they are useless and tokens are short-lived).
 * @returns {{errors:string[], warnings:string[], data:object, dropped:{sessions:number,tokens:number}}}
 */
export function validateExport(raw, { now = Date.now(), keepSessions = true } = {}) {
  const errors = [];
  const warnings = [];
  const data = Object.fromEntries(COLLECTIONS.map((c) => [c, {}]));
  const dropped = { sessions: 0, tokens: 0 };

  if (!isObj(raw)) return { errors: ['The file is not a JSON object.'], warnings, data, dropped };

  for (const key of Object.keys(raw)) {
    if (!COLLECTIONS.includes(key)) warnings.push(`Ignoring unknown top-level key "${key}".`);
  }

  for (const c of COLLECTIONS) {
    const coll = raw[c];
    if (coll === undefined) continue;
    if (!isObj(coll)) {
      errors.push(`"${c}" must be an object keyed by id.`);
      continue;
    }
    for (const [key, rec] of Object.entries(coll)) {
      const where = `${c}["${key}"]`;
      if (c === 'chat') {
        if (!Array.isArray(rec)) errors.push(`${where} must be an array of messages.`);
        else data.chat[key] = rec;
        continue;
      }
      if (!isObj(rec)) {
        errors.push(`${where} must be an object.`);
        continue;
      }
      if (c === 'users' && rec.email !== key) errors.push(`${where} has email "${rec.email}", which does not match its key.`);
      if (c === 'nets') {
        if (rec.id !== key) errors.push(`${where} has id "${rec.id}", which does not match its key.`);
        if (!Array.isArray(rec.stations) || !Array.isArray(rec.log)) errors.push(`${where} needs "stations" and "log" arrays.`);
      }
      if (c === 'sessions' || c === 'tokens') {
        if (typeof rec.exp !== 'number' || typeof rec.email !== 'string') {
          errors.push(`${where} needs a numeric "exp" and a string "email".`);
          continue;
        }
        if (rec.exp < now || (c === 'sessions' && !keepSessions)) {
          dropped[c] += 1;
          continue;
        }
      }
      data[c][key] = rec;
    }
  }

  // Referential sanity: warn about chat for nets that are not in the file.
  for (const id of Object.keys(data.chat)) {
    if (!data.nets[id]) warnings.push(`chat["${id}"] belongs to a net that is not in the file.`);
  }
  return { errors, warnings, data, dropped };
}

const countDocs = (data) => Object.fromEntries(COLLECTIONS.map((c) => [c, Object.keys(data[c]).length]));

/**
 * Write validated data into a MongoStore that has already load()ed.
 * mode 'empty'   : refuse if the database already has documents (safe default)
 * mode 'merge'   : add documents whose id is not present, never overwrite existing ones
 * mode 'replace' : wipe the five collections first, then import
 * @returns {{imported:object, skipped:object, removed:object}}
 */
export async function importInto(store, data, { mode = 'empty' } = {}) {
  const existing = countDocs(store.data);
  const imported = {};
  const skipped = {};
  const removed = Object.fromEntries(COLLECTIONS.map((c) => [c, 0]));

  if (mode === 'empty' && Object.values(existing).some((n) => n > 0)) {
    const have = COLLECTIONS.filter((c) => existing[c]).map((c) => `${c}: ${existing[c]}`).join(', ');
    throw new Error(`The target database is not empty (${have}). Use --merge to add missing records or --replace --yes to overwrite.`);
  }
  if (!['empty', 'merge', 'replace'].includes(mode)) throw new Error(`Unknown mode "${mode}".`);

  for (const c of COLLECTIONS) {
    if (mode === 'replace') {
      removed[c] = existing[c];
      store.data[c] = {};
    }
    imported[c] = 0;
    skipped[c] = 0;
    for (const [key, value] of Object.entries(data[c])) {
      if (key in store.data[c]) {
        skipped[c] += 1;
        continue;
      }
      store.data[c][key] = value;
      imported[c] += 1;
    }
  }
  await store.commit(); // throws if MongoDB rejects the write
  return { imported, skipped, removed };
}
