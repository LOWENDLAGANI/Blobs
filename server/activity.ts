import { all, count, get, run } from './db.ts';
import { id, now, safeJson } from './util.ts';

export type ActivityLevel = 'info' | 'success' | 'warn' | 'error' | 'action';

export interface ActivityInput {
  level?: ActivityLevel;
  category?: string;
  message: string;
  meta?: Record<string, unknown>;
  taskId?: string | null;
  conversationId?: string | null;
}

type Listener = (event: { type: string; data: unknown }) => void;
const listeners = new Set<Listener>();

/** Writes that are in flight. Reads await them so a log is never reported missing. */
const pending = new Set<Promise<void>>();

function track(work: Promise<void>): void {
  pending.add(work);
  void work
    .catch((error) => console.error('Activity write failed:', (error as Error).message))
    .finally(() => pending.delete(work));
}

/** Wait for every queued activity/notification write to reach the database. */
export async function flushActivity(): Promise<void> {
  if (!pending.size) return;
  await Promise.allSettled([...pending]);
}

/** Fan-out to every connected SSE client. Listener failures never break a run. */
export function broadcast(type: string, data: unknown): void {
  for (const listener of listeners) {
    try {
      listener({ type, data });
    } catch {
      /* a dead stream must not take down the agent */
    }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Logging stays synchronous for callers: the row is written in the background
 * so a slow or remote database never stalls the agent loop. Reads flush first.
 */
export function logActivity(input: ActivityInput): void {
  const entry = {
    id: id('act'),
    ts: now(),
    level: input.level ?? 'info',
    category: input.category ?? 'agent',
    message: input.message,
    meta: input.meta ? JSON.stringify(input.meta) : null,
    task_id: input.taskId ?? null,
    conversation_id: input.conversationId ?? null,
  };
  track(
    run(
      `INSERT INTO activity(id, ts, level, category, message, meta, task_id, conversation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.ts,
      entry.level,
      entry.category,
      entry.message,
      entry.meta,
      entry.task_id,
      entry.conversation_id,
    ),
  );
  broadcast('activity', entry);
}

export interface ActivityRow {
  id: string;
  ts: number;
  level: ActivityLevel;
  category: string;
  message: string;
  meta: string | null;
  task_id: string | null;
  conversation_id: string | null;
}

export async function listActivity(options: { limit?: number; category?: string; level?: string } = {}): Promise<ActivityRow[]> {
  await flushActivity();
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.category && options.category !== 'all') {
    clauses.push('category = ?');
    params.push(options.category);
  }
  if (options.level && options.level !== 'all') {
    clauses.push('level = ?');
    params.push(options.level);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all<ActivityRow>(`SELECT * FROM activity ${where} ORDER BY ts DESC LIMIT ${limit}`, ...params);
}

export async function activityCounts(): Promise<Record<string, number>> {
  await flushActivity();
  const [total, errors, actions] = await Promise.all([
    count('SELECT COUNT(*) AS n FROM activity'),
    count("SELECT COUNT(*) AS n FROM activity WHERE level = 'error'"),
    count("SELECT COUNT(*) AS n FROM activity WHERE level = 'action'"),
  ]);
  return { total, errors, actions };
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export interface NotificationInput {
  title: string;
  body?: string;
  level?: 'info' | 'success' | 'warn' | 'error';
  link?: string;
}

export function notify(input: NotificationInput): void {
  const row = {
    id: id('ntf'),
    ts: now(),
    title: input.title,
    body: input.body ?? '',
    level: input.level ?? 'info',
    read: 0,
    link: input.link ?? null,
  };
  track(
    run(
      `INSERT INTO notifications(id, ts, title, body, level, read, link) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.ts,
      row.title,
      row.body,
      row.level,
      row.read,
      row.link,
    ),
  );
  broadcast('notification', row);
}

export async function listNotifications(limit = 30): Promise<unknown[]> {
  await flushActivity();
  return all('SELECT * FROM notifications ORDER BY ts DESC LIMIT ?', Math.min(limit, 100));
}

export async function unreadNotifications(): Promise<number> {
  await flushActivity();
  return count('SELECT COUNT(*) AS n FROM notifications WHERE read = 0');
}

export async function markNotificationsRead(): Promise<void> {
  await run('UPDATE notifications SET read = 1 WHERE read = 0');
}

export function notificationRow(raw: string | null): Record<string, unknown> | null {
  return safeJson<Record<string, unknown> | null>(raw, null);
}
