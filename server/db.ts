import { createClient, type Client } from '@libsql/client';
import { DB_AUTH_TOKEN, DB_SYNC_SECONDS, DB_SYNC_URL, DB_URL } from './env.ts';

/**
 * Data layer. libSQL is used for every environment:
 *
 *   DB_URL=file:.data/blobs.db              local file (default, offline)
 *   DB_URL=libsql://<db>-<org>.turso.io     Turso Cloud, with DB_AUTH_TOKEN
 *   DB_URL=file:.data/blobs.db + DB_SYNC_URL Turso embedded replica
 *
 * The SQL is plain SQLite: same tables, same FTS5 index, same bm25 ranking.
 * The client is asynchronous because a remote database answers over the
 * network, so every caller awaits.
 */
/** Local file + remote primary: reads stay local, writes and pulls sync to Turso. */
const EMBEDDED = Boolean(DB_SYNC_URL) && DB_URL.startsWith('file:');

export const client: Client = EMBEDDED
  ? createClient({ url: DB_URL, syncUrl: DB_SYNC_URL, authToken: DB_AUTH_TOKEN || undefined })
  : createClient(DB_AUTH_TOKEN ? { url: DB_URL, authToken: DB_AUTH_TOKEN } : { url: DB_URL });

/** Pull remote changes into the local replica. No-op for a plain file or remote DB. */
export async function syncNow(): Promise<void> {
  if (!EMBEDDED) return;
  await client.sync();
}

if (EMBEDDED) {
  const timer = setInterval(() => {
    void client.sync().catch((error) => console.error('libSQL sync failed:', (error as Error).message));
  }, Math.max(5, DB_SYNC_SECONDS) * 1_000);
  timer.unref?.();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  passphrase_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'web',
  title TEXT,
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  untrusted INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'fact',
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 3,
  source TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  content,
  tags,
  tokenize = 'porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(id, content, tags) VALUES (new.id, new.content, coalesce(new.tags, ''));
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  DELETE FROM memories_fts WHERE id = old.id;
  INSERT INTO memories_fts(id, content, tags) VALUES (new.id, new.content, coalesce(new.tags, ''));
END;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  autonomy TEXT NOT NULL DEFAULT 'assisted',
  schedule TEXT,
  next_run_at INTEGER,
  last_run_at INTEGER,
  heartbeat INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  plan TEXT,
  checkpoint TEXT,
  result TEXT,
  error TEXT,
  origin TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, next_run_at);

CREATE TABLE IF NOT EXISTS task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  output TEXT,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps(task_id, idx);

CREATE TABLE IF NOT EXISTS responsibilities (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  cadence_minutes INTEGER NOT NULL DEFAULT 1440,
  status TEXT NOT NULL DEFAULT 'active',
  last_run_at INTEGER,
  next_run_at INTEGER,
  last_outcome TEXT,
  last_task_id TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_responsibilities_due ON responsibilities(status, next_run_at);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  task_id TEXT,
  conversation_id TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  category TEXT NOT NULL DEFAULT 'agent',
  message TEXT NOT NULL,
  meta TEXT,
  task_id TEXT,
  conversation_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts DESC);

CREATE TABLE IF NOT EXISTS integrations (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'disconnected',
  config TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comms_events (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,
  peer TEXT,
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'logged',
  external_id TEXT,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comms_created ON comms_events(created_at DESC);

CREATE TABLE IF NOT EXISTS usage_log (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'chat',
  task_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT 'info',
  read INTEGER NOT NULL DEFAULT 0,
  link TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications(ts DESC);
`;

/**
 * Schema creation is asynchronous now, so it runs once as `ready`. The server
 * awaits it before accepting traffic; tests and scripts await it too.
 */
export const ready: Promise<void> = (async () => {
  if (EMBEDDED) {
    // A fresh replica has nothing local yet; pull the primary first.
    await client.sync().catch(() => undefined);
  }
  await client.executeMultiple(SCHEMA);
  try {
    // Per-connection in a local file; a no-op for a remote database, which
    // enforces foreign keys server-side.
    await client.execute('PRAGMA foreign_keys = ON');
  } catch {
    /* the server owns this setting when the database is remote */
  }
})();

type Param = string | number | null;
export type Row = Record<string, unknown>;

function normalize(params: unknown[]): Param[] {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number' || typeof value === 'string') return value;
    return JSON.stringify(value);
  });
}

export async function all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
  const result = await client.execute({ sql, args: normalize(params) });
  return result.rows as unknown as T[];
}

export async function get<T = Row>(sql: string, ...params: unknown[]): Promise<T | null> {
  const result = await client.execute({ sql, args: normalize(params) });
  return (result.rows[0] as unknown as T) ?? null;
}

export async function run(sql: string, ...params: unknown[]): Promise<void> {
  await client.execute({ sql, args: normalize(params) });
}

export async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await get<{ n: number }>(sql, ...params);
  return Number(row?.n ?? 0);
}

/** Write transaction. libSQL wraps BEGIN/COMMIT so a rollback is guaranteed. */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  const transaction = await client.transaction('write');
  try {
    const result = await fn();
    await transaction.commit();
    return result;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
