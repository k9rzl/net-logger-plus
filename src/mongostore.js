import { COLLECTIONS } from './store.js';

/**
 * MongoDB persistence with the same interface as the JSON Store.
 *
 * The working set lives in memory (store.data), exactly as before, so the rest of the app
 * stays synchronous. On save() the changed documents are diffed against what was last
 * written and sent to MongoDB with a single bulkWrite per collection. Sessions and
 * sign-in tokens get a TTL index so MongoDB expires them itself.
 *
 * This is a single-instance design: the SSE hub and rate limiter are also in-process.
 */
export class MongoStore {
  constructor(db, { debounceMs = 250 } = {}) {
    this.db = db;
    this.debounceMs = debounceMs;
    this.data = Object.fromEntries(COLLECTIONS.map((c) => [c, {}]));
    this.written = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
    this.timer = null;
    this.chain = Promise.resolve();
  }

  static async connect({ uri, dbName }) {
    let MongoClient;
    try {
      ({ MongoClient } = await import('mongodb'));
    } catch {
      throw new Error('MONGODB_URI is set but the "mongodb" package is not installed. Run: npm install mongodb');
    }
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const store = new MongoStore(client.db(dbName));
    store.client = client;
    await store.init();
    return store;
  }

  async init() {
    await this.db.collection('sessions').createIndex({ expAt: 1 }, { expireAfterSeconds: 0 });
    await this.db.collection('tokens').createIndex({ expAt: 1 }, { expireAfterSeconds: 0 });
    await this.load();
  }

  async load() {
    for (const c of COLLECTIONS) {
      for (const doc of await this.db.collection(c).find({}).toArray()) {
        const { _id, expAt, ...rest } = doc;
        // chat is stored as {_id, list:[...]} because documents must be objects
        const value = c === 'chat' ? rest.list : rest;
        this.data[c][_id] = value;
        this.written[c].set(_id, JSON.stringify(value));
      }
    }
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((e) => console.error('MongoDB write failed (will retry on next change):', e.message));
    }, this.debounceMs);
  }

  /** Write pending changes now. Rejects if MongoDB refuses (used by the import script). */
  commit() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const run = this.chain.then(() => this.#write());
    this.chain = run.catch(() => {}); // a failed write must not poison later flushes
    return run;
  }

  /** Like commit() but logs instead of throwing: the app keeps running and retries on the next change. */
  flush() {
    return this.commit().catch((e) => {
      console.error('MongoDB write failed (will retry on next change):', e.message);
    });
  }

  async #write() {
    for (const c of COLLECTIONS) {
      const ops = [];
      const commit = [];
      for (const [key, value] of Object.entries(this.data[c])) {
        const json = JSON.stringify(value);
        if (this.written[c].get(key) === json) continue;
        let doc = c === 'chat' ? { list: value } : { ...value };
        if ((c === 'sessions' || c === 'tokens') && typeof value.exp === 'number') doc.expAt = new Date(value.exp);
        ops.push({ replaceOne: { filter: { _id: key }, replacement: doc, upsert: true } });
        commit.push(() => this.written[c].set(key, json));
      }
      for (const key of this.written[c].keys()) {
        if (key in this.data[c]) continue;
        ops.push({ deleteOne: { filter: { _id: key } } });
        commit.push(() => this.written[c].delete(key));
      }
      if (!ops.length) continue;
      await this.db.collection(c).bulkWrite(ops, { ordered: false });
      commit.forEach((fn) => fn()); // only mark as written once MongoDB accepted it
    }
  }

  async close() {
    await this.flush();
    await this.client?.close();
  }
}
