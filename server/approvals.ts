import { all, get, run } from './db.ts';
import { id, now, safeJson } from './util.ts';
import { logActivity, notify } from './activity.ts';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalPayload {
  tool: string;
  args: Record<string, unknown>;
  context: {
    channel: 'web' | 'phone' | 'task' | 'email';
    conversationId?: string | null;
    taskId?: string | null;
    stepIndex?: number | null;
  };
}

export interface ApprovalRow {
  id: string;
  kind: string;
  title: string;
  detail: string;
  payload: string;
  status: ApprovalStatus;
  task_id: string | null;
  conversation_id: string | null;
  created_at: number;
  decided_at: number | null;
  decision_note: string | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  financial: 'money or paid services',
  deletion: 'deleting data',
  publishing: 'publishing something publicly',
  externalMessages: 'messaging someone outside you',
  security: 'a security or account change',
};

export async function createApproval(input: {
  kind: string;
  title: string;
  detail: string;
  payload: ApprovalPayload;
  taskId?: string | null;
  conversationId?: string | null;
}): Promise<ApprovalRow> {
  const row: ApprovalRow = {
    id: id('apr'),
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    payload: JSON.stringify(input.payload),
    status: 'pending',
    task_id: input.taskId ?? null,
    conversation_id: input.conversationId ?? null,
    created_at: now(),
    decided_at: null,
    decision_note: null,
  };
  await run(
    `INSERT INTO approvals(id, kind, title, detail, payload, status, task_id, conversation_id, created_at, decided_at, decision_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.kind,
    row.title,
    row.detail,
    row.payload,
    row.status,
    row.task_id,
    row.conversation_id,
    row.created_at,
    row.decided_at,
    row.decision_note,
  );
  logActivity({
    level: 'action',
    category: 'approval',
    message: `Waiting for approval: ${row.title}`,
    meta: { approvalId: row.id, kind: row.kind },
    taskId: row.task_id,
    conversationId: row.conversation_id,
  });
  notify({
    title: 'BLOBS needs your approval',
    body: row.title,
    level: 'warn',
    link: '/approvals',
  });
  return row;
}

export async function listApprovals(status: ApprovalStatus | 'all' = 'pending'): Promise<ApprovalRow[]> {
  if (status === 'all') return all<ApprovalRow>('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100');
  return all<ApprovalRow>('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 100', status);
}

export async function getApproval(approvalId: string): Promise<ApprovalRow | null> {
  return get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', approvalId);
}

export async function decideApproval(
  approvalId: string,
  decision: 'approved' | 'rejected',
  note = '',
): Promise<ApprovalRow | null> {
  const row = await getApproval(approvalId);
  if (!row || row.status !== 'pending') return null;
  await run(
    'UPDATE approvals SET status = ?, decided_at = ?, decision_note = ? WHERE id = ?',
    decision,
    now(),
    note,
    approvalId,
  );
  logActivity({
    level: decision === 'approved' ? 'action' : 'warn',
    category: 'approval',
    message: `${decision === 'approved' ? 'Approved' : 'Rejected'}: ${row.title}`,
    meta: { approvalId },
    taskId: row.task_id,
    conversationId: row.conversation_id,
  });
  return getApproval(approvalId);
}

export function parseApprovalPayload(row: ApprovalRow): ApprovalPayload | null {
  return safeJson<ApprovalPayload | null>(row.payload, null);
}

export function describeApproval(kind: string, tool: string, args: Record<string, unknown>): string {
  const label = CATEGORY_LABEL[kind] ?? 'a high-impact action';
  const argText = Object.entries(args)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return `${key}: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`;
    })
    .join('\n');
  return `BLOBS wants to run ${tool}, which involves ${label}.\n\n${argText}`;
}

export const APPROVAL_CATEGORIES = CATEGORY_LABEL;
