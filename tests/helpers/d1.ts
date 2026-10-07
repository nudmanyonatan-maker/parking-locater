// A minimal D1Database over node:sqlite, enough for worker/db.ts:
// prepare().bind().first()/all()/run()/raw(), batch() (one transaction) and
// exec(). Bound statements are immutable, like D1's. Foreign keys are
// enforced, as in D1. Every migrations/*.sql file is applied in name order.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

type Row = Record<string, SQLInputValue>;

function toSqlValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  // D1 rejects undefined and objects the same way.
  throw new TypeError(`D1_TYPE_ERROR: Type '${typeof value}' not supported for value '${String(value)}'`);
}

class SqliteStatement {
  private readonly db: SqliteD1;
  readonly sql: string;
  readonly params: SQLInputValue[];

  constructor(db: SqliteD1, sql: string, params: SQLInputValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]) {
    return new SqliteStatement(this.db, this.sql, values.map(toSqlValue));
  }

  async first(column?: string) {
    const row = this.db.execute(this).results[0];
    if (!row) return null;
    if (column === undefined) return row;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column];
  }

  async all() {
    return this.db.execute(this);
  }

  async run() {
    return this.db.execute(this);
  }

  async raw() {
    return this.db.execute(this).results.map((row) => Object.values(row));
  }
}

class SqliteD1 {
  readonly sqlite: DatabaseSync;

  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
  }

  private totalChanges(): number {
    return Number((this.sqlite.prepare('SELECT total_changes() AS n').get() as Row).n);
  }

  execute(stmt: SqliteStatement) {
    const started = performance.now();
    const before = this.totalChanges();
    const prepared = this.sqlite.prepare(stmt.sql);
    let results: Row[] = [];
    if (prepared.columns().length > 0) results = prepared.all(...stmt.params) as Row[];
    else prepared.run(...stmt.params);
    const changes = this.totalChanges() - before;
    const lastRowId = Number((this.sqlite.prepare('SELECT last_insert_rowid() AS id').get() as Row).id);
    return {
      success: true as const,
      results: results.map((row) => ({ ...row })),
      meta: {
        duration: performance.now() - started,
        last_row_id: lastRowId,
        changes,
        rows_read: results.length,
        rows_written: changes,
        changed_db: changes > 0,
        size_after: 0,
      },
    };
  }

  prepare(sql: string) {
    return new SqliteStatement(this, sql);
  }

  async batch(statements: SqliteStatement[]) {
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => this.execute(s));
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw e;
    }
  }

  async exec(sql: string) {
    const started = performance.now();
    this.sqlite.exec(sql);
    return { count: sql.split(';').filter((s) => s.trim()).length, duration: performance.now() - started };
  }
}

export interface TestDb {
  /** Pass this as env.DB. */
  d1: D1Database;
  /** Direct access for test setup and assertions. */
  sqlite: DatabaseSync;
}

export function createTestDb(): TestDb {
  const db = new SqliteD1();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    db.sqlite.exec(readFileSync(MIGRATIONS_DIR + file, 'utf8'));
  }
  return { d1: db as unknown as D1Database, sqlite: db.sqlite };
}
