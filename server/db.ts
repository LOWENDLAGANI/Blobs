import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { DATABASE_URL, PG_POOL_MAX, PG_SSL, ROOT } from './env.ts';

/**
 * Data layer: one Postgres database, normally a Supabase project.
 *
 *   DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
 *
 * The rest of the server only knows `all`, `get`, `run`, `count` and `tx`, so
 * the storage engine is not spread across the codebase. SQL is written with
 * `?` placeholders, exactly as before, and translated to Postgres `$1…$n`
 * numbering on the way through (`toPostgres`).
 *
 * Two details keep the existing code and its integer-millisecond timestamps
 * honest:
 *   * int8/numeric results are parsed into JS numbers, so `row.updated_at`
 *     arithmetic and `COUNT(*)` both behave like the SQLite driver did;
 *   * flags stay INTEGER 0/1 in the schema, so `pinned = 1` still works.
 */
const SCHEMA_FILE = path.join(ROOT, 'supabase', 'migrations', '0001_init.sql');

/** Timestamps and counts arrive as strings otherwise; the app does maths on them. */
types.setTypeParser(types.builtins.INT8, (value: string) => Number(value));
types.setTypeParser(types.builtins.NUMERIC, (value: string) => Number(value));

const LOCAL_HOSTS = /(^|@)(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/;

/**
 * Supabase hands out a certificate chain that node can verify, but the pooler
 * hostname rotates. `rejectUnauthorized: false` is the pragmatic setting here
 * and is only used off localhost; set PG_SSL=disable for a plain local server.
 */
function sslConfig(): { rejectUnauthorized: boolean } | undefined {
  if (PG_SSL === 'disable') return undefined;
  if (PG_SSL === 'require') return { rejectUnauthorized: false };
  return LOCAL_HOSTS.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Math.max(1, PG_POOL_MAX),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  // Never let a single statement hang the boot path (or a request) forever;
  // a stuck query surfaces as an error instead of an infinite "Waking up…".
  options: '-c statement_timeout=15000',
  application_name: 'blobs',
  ssl: sslConfig(),
});

pool.on('error', (error) => {
  console.error('Postgres pool error:', error.message);
});

/* ------------------------------------------------------------------ */
/* Placeholder translation: `?` → `$1`, `$2`, …                        */
/* ------------------------------------------------------------------ */

const translated = new Map<string, string>();

/** Rewrites `?` placeholders, leaving quoted literals and identifiers alone. */
function toPostgres(sql: string): string {
  const cached = translated.get(sql);
  if (cached) return cached;
  let out = '';
  let index = 0;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i] as string;
    if (quote) {
      out += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      continue;
    }
    if (char === '?') {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += char;
  }
  translated.set(sql, out);
  return out;
}

/* ------------------------------------------------------------------ */
/* SQL statement splitter (for the schema bootstrap)                    */
/* ------------------------------------------------------------------ */

/** Splits a SQL file into individual statements, honouring quotes/comments. */
function splitSql(input: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] as string;
    const next = (input[i + 1] ?? '') as string;
    if (inLineComment) {
      current += char;
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (inSingle) {
      current += char;
      if (char === "'") {
        if (next === "'") {
          current += next;
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (char === "'") {
      inSingle = true;
      current += char;
      continue;
    }
    if (char === '-' && next === '-') {
      inLineComment = true;
      current += char;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      current += char;
      continue;
    }
    if (char === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }
    current += char;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/* ------------------------------------------------------------------ */
/* Schema bootstrap                                                    */
/* ------------------------------------------------------------------ */

/**
 * The schema is created before the server accepts traffic, so a fresh Supabase
 * database needs nothing but DATABASE_URL. The SQL file is the single source
 * of truth and is safe to re-run.
 */
export const ready: Promise<void> = (async () => {
  if (!fs.existsSync(SCHEMA_FILE)) {
    throw new Error(`Schema file is missing at ${SCHEMA_FILE}.`);
  }
  const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
  // Run the migration one statement at a time. Sending the whole file as a
  // single multi-statement query can hang or be mishandled by a pooled
  // connection (e.g. Supabase's pgbouncer), which left the boot screen stuck
  // on "Waking up…" forever.
  for (const statement of splitSql(schema)) {
    await pool.query(statement);
  }
})().catch((error: Error) => {
  const hint = LOCAL_HOSTS.test(DATABASE_URL)
    ? ' Is a local Postgres running on 127.0.0.1:5432 (docker compose up -d db)?'
    : ' Check DATABASE_URL: Supabase → Project Settings → Database → Connection string → Connection pooling.';
  throw new Error(`Could not prepare the Postgres schema: ${error.message}.${hint}`);
});

// `ready` is created at module load and may reject before anyone awaits it.
// Attaching a handler here marks the rejection as handled so Node does not
// terminate the process on an unhandled promise rejection; awaiting `ready`
// still re-throws the underlying error.
ready.catch(() => undefined);

/* ------------------------------------------------------------------ */
/* Query helpers                                                       */
/* ------------------------------------------------------------------ */

type Param = string | number | null;
export type Row = Record<string, unknown>;

/**
 * Inside `tx()` every helper call must use the transaction's connection, not a
 * random one from the pool. AsyncLocalStorage carries it without threading a
 * client argument through 140 call sites.
 */
const scoped = new AsyncLocalStorage<PoolClient>();

function runner(): Pick<PoolClient, 'query'> {
  return scoped.getStore() ?? pool;
}

function normalize(params: unknown[]): Param[] {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number' || typeof value === 'string') return value;
    return JSON.stringify(value);
  });
}

export async function all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
  const result = await runner().query<QueryResultRow>(toPostgres(sql), normalize(params));
  return result.rows as unknown as T[];
}

export async function get<T = Row>(sql: string, ...params: unknown[]): Promise<T | null> {
  const result = await runner().query<QueryResultRow>(toPostgres(sql), normalize(params));
  return (result.rows[0] as unknown as T) ?? null;
}

export async function run(sql: string, ...params: unknown[]): Promise<void> {
  await runner().query(toPostgres(sql), normalize(params));
}

export async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await get<{ n: number }>(sql, ...params);
  return Number(row?.n ?? 0);
}

/** Write transaction. Everything called inside `fn` runs on one connection. */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (scoped.getStore()) return fn();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await scoped.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Reported by /api/health so a deploy can prove it reached the database. */
export async function dbStatus(): Promise<{ ok: boolean; detail: string }> {
  try {
    const row = await get<{ version: string }>('SELECT version() AS version');
    const version = String(row?.version ?? '');
    const match = /PostgreSQL (\d+\.\d+)/.exec(version);
    return { ok: true, detail: match ? `PostgreSQL ${match[1]}` : 'PostgreSQL' };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

export async function closeDb(): Promise<void> {
  await pool.end().catch(() => undefined);
}
