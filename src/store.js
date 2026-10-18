import fs from 'node:fs';
import path from 'node:path';

export const COLLECTIONS = ['users', 'sessions', 'tokens', 'nets', 'chat'];

/** Tiny JSON-file store with atomic writes. Pass file=null for in-memory (tests). */
export class Store {
  constructor(file = null) {
    this.file = file;
    this.timer = null;
    this.data = Object.fromEntries(COLLECTIONS.map((c) => [c, {}]));
    if (file && fs.existsSync(file)) {
      try {
        Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch (e) {
        throw new Error(`Cannot read ${file}: ${e.message}`);
      }
    }
  }

  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 250);
  }

  async close() {
    this.flush();
  }

  flush() {
    if (!this.file) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
