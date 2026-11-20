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

export function listActivity(options: { limit?: number; category?: string; level?: string } = {}): ActivityRow[] {
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

export function activityCounts(): Record<string, number> {
  return {
    total: count('SELECT COUNT(*) AS n FROM activity'),
    errors: count("SELECT COUNT(*) AS n FROM activity WHERE level = 'error'"),
    actions: count("SELECT COUNT(*) AS n FROM activity WHERE level = 'action'"),
  };
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
  run(
    `INSERT INTO notifications(id, ts, title, body, level, read, link) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.ts,
    row.title,
    row.body,
    row.level,
    row.read,
    row.link,
  );
  broadcast('notification', row);
}

export function listNotifications(limit = 30): unknown[] {
  return all('SELECT * FROM notifications ORDER BY ts DESC LIMIT ?', Math.min(limit, 100));
}

export function unreadNotifications(): number {
  return count('SELECT COUNT(*) AS n FROM notifications WHERE read = 0');
}

export function markNotificationsRead(): void {
  run('UPDATE notifications SET read = 1 WHERE read = 0');
}

export function notificationRow(raw: string | null): Record<string, unknown> | null {
  return safeJson<Record<string, unknown> | null>(raw, null);
}
