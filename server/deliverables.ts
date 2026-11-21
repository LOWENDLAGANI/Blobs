import crypto from 'node:crypto';
import { all, get, run } from './db.ts';
import { id, now } from './util.ts';
import { broadcast, logActivity, notify } from './activity.ts';

/**
 * Review packets.
 *
 * The autonomous loop needs somewhere to put finished work: a report, a draft,
 * a plan, a summary. A deliverable is that packet — readable in the Review
 * page, optionally published as an expiring public link (handy on a phone or
 * for sharing), and never gated behind an approval.
 */

export type DeliverableKind = 'markdown' | 'html';

export interface DeliverableRow {
  id: string;
  task_id: string | null;
  conversation_id: string | null;
  responsibility_id: string | null;
  title: string;
  kind: DeliverableKind;
  body: string;
  public_token: string | null;
  public_expires_at: number | null;
  created_at: number;
}

const MAX_BODY = 200_000;

export async function createDeliverable(input: {
  title: string;
  body: string;
  kind?: DeliverableKind;
  taskId?: string | null;
  conversationId?: string | null;
  responsibilityId?: string | null;
  silent?: boolean;
}): Promise<DeliverableRow> {
  const row: DeliverableRow = {
    id: id('dlv'),
    task_id: input.taskId ?? null,
    conversation_id: input.conversationId ?? null,
    responsibility_id: input.responsibilityId ?? null,
    title: (input.title.trim() || 'Untitled packet').slice(0, 200),
    kind: input.kind === 'html' ? 'html' : 'markdown',
    body: input.body.slice(0, MAX_BODY),
    public_token: null,
    public_expires_at: null,
    created_at: now(),
  };
  await run(
    `INSERT INTO deliverables(id, task_id, conversation_id, responsibility_id, title, kind, body, public_token,
      public_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.task_id,
    row.conversation_id,
    row.responsibility_id,
    row.title,
    row.kind,
    row.body,
    row.public_token,
    row.public_expires_at,
    row.created_at,
  );
  logActivity({
    level: 'info',
    category: 'deliverable',
    message: `Prepared a review packet: "${row.title}".`,
    meta: { deliverableId: row.id },
    taskId: row.task_id,
  });
  if (!input.silent) notify({ title: 'New review packet', body: row.title, level: 'info', link: '/review' });
  broadcast('tasks', { deliverableId: row.id });
  return row;
}

export async function listDeliverables(limit = 50): Promise<DeliverableRow[]> {
  return all<DeliverableRow>('SELECT * FROM deliverables ORDER BY created_at DESC LIMIT ?', limit);
}

export async function getDeliverable(deliverableId: string): Promise<DeliverableRow | null> {
  return get<DeliverableRow>('SELECT * FROM deliverables WHERE id = ?', deliverableId);
}

export async function deleteDeliverable(deliverableId: string): Promise<boolean> {
  const existing = await getDeliverable(deliverableId);
  if (!existing) return false;
  await run('DELETE FROM deliverables WHERE id = ?', deliverableId);
  logActivity({ level: 'info', category: 'deliverable', message: `Deleted review packet "${existing.title}".` });
  broadcast('tasks', { deliverableId });
  return true;
}

/** Publish a packet at an unguessable path that expires. 1 hour to 7 days. */
export async function publishDeliverable(
  deliverableId: string,
  hours = 168,
): Promise<{ token: string; expiresAt: number } | null> {
  const existing = await getDeliverable(deliverableId);
  if (!existing) return null;
  const ttlHours = Math.min(168, Math.max(1, Math.round(Number(hours) || 168)));
  const token = existing.public_token ?? crypto.randomBytes(18).toString('base64url');
  const expiresAt = now() + ttlHours * 3_600_000;
  await run('UPDATE deliverables SET public_token = ?, public_expires_at = ? WHERE id = ?', token, expiresAt, deliverableId);
  logActivity({
    level: 'info',
    category: 'deliverable',
    message: `Published "${existing.title}" for ${ttlHours}h.`,
    meta: { deliverableId },
  });
  broadcast('tasks', { deliverableId });
  return { token, expiresAt };
}

export async function unpublishDeliverable(deliverableId: string): Promise<boolean> {
  const existing = await getDeliverable(deliverableId);
  if (!existing) return false;
  await run('UPDATE deliverables SET public_token = NULL, public_expires_at = NULL WHERE id = ?', deliverableId);
  broadcast('tasks', { deliverableId });
  return true;
}

export async function getPublicDeliverable(token: string): Promise<DeliverableRow | null> {
  if (!token) return null;
  const row = await get<DeliverableRow>('SELECT * FROM deliverables WHERE public_token = ?', token);
  if (!row) return null;
  if (row.public_expires_at !== null && row.public_expires_at <= now()) return null;
  return row;
}
