// Minimal Cloudflare D1 stand-in backed by node:sqlite, for tests and tools/dev-worker.mjs.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'worker', 'schema.sql');

export class LocalD1 {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec(readFileSync(SCHEMA, 'utf8'));
  }

  prepare(sql) {
    const db = this.db;
    const stmt = (params) => ({
      bind: (...p) => stmt(p),
      first: async () => db.prepare(sql).get(...params) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      run: async () => {
        const r = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
      },
    });
    return stmt([]);
  }
}
