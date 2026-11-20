import { all, get, run } from '../db.ts';
import { getSettings } from '../settings.ts';
import { broadcast, logActivity, notify } from '../activity.ts';
import { memoryContext, remember } from '../memory.ts';
import { complete } from '../llm/index.ts';
import type { LlmMessage } from '../llm/types.ts';
import { id, now, safeJson, truncate } from '../util.ts';
import { buildSystemPrompt } from './prompt.ts';
import { agentLoop, drainAgent, executeApprovedTool, type AgentEvent } from './core.ts';
import { getApproval, parseApprovalPayload, type ApprovalRow } from '../approvals.ts';
import { normalizeSchedule, executeTask } from './tasks.ts';
import type { ToolContext } from './tools.ts';

export interface ConversationRow {
  id: string;
  channel: string;
  title: string | null;
  summary: string | null;
  created_at: number;
  updated_at: number;
  archived: number;
  meta: string | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  untrusted: number;
  model: string | null;
  created_at: number;
}

export type TurnEvent =
  | { type: 'meta'; conversationId: string; title: string; model: string; channel: string }
  | AgentEvent
  | { type: 'message'; message: MessageRow }
  | { type: 'done'; conversationId: string; messageId: string; interrupted: boolean }
  | { type: 'error'; message: string; hint?: string };

const HISTORY_LIMIT = 60;

export function ensureConversation(conversationId?: string | null, channel = 'web'): ConversationRow {
  if (conversationId) {
    const existing = get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', conversationId);
    if (existing) return existing;
  }
  const ts = now();
  const row: ConversationRow = {
    id: id('cnv'),
    channel,
    title: null,
    summary: null,
    created_at: ts,
    updated_at: ts,
    archived: 0,
    meta: null,
  };
  run(
    `INSERT INTO conversations(id, channel, title, summary, created_at, updated_at, archived, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.channel,
    row.title,
    row.summary,
    row.created_at,
    row.updated_at,
    row.archived,
    row.meta,
  );
  return row;
}

export function addMessage(input: {
  conversationId: string;
  role: MessageRow['role'];
  content: string;
  toolCalls?: unknown;
  toolCallId?: string | null;
  toolName?: string | null;
  untrusted?: boolean;
  model?: string | null;
}): MessageRow {
  const row: MessageRow = {
    id: id('msg'),
    conversation_id: input.conversationId,
    role: input.role,
    content: input.content,
    tool_calls: input.toolCalls ? JSON.stringify(input.toolCalls) : null,
    tool_call_id: input.toolCallId ?? null,
    tool_name: input.toolName ?? null,
    untrusted: input.untrusted ? 1 : 0,
    model: input.model ?? null,
    created_at: now(),
  };
  run(
    `INSERT INTO messages(id, conversation_id, role, content, tool_calls, tool_call_id, tool_name, untrusted, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.conversation_id,
    row.role,
    truncate(row.content, 60_000),
    row.tool_calls,
    row.tool_call_id,
    row.tool_name,
    row.untrusted,
    row.model,
    row.created_at,
  );
  run('UPDATE conversations SET updated_at = ? WHERE id = ?', row.created_at, row.conversation_id);
  return row;
}

export function listConversations(limit = 40): (ConversationRow & { message_count: number; last_message: string | null })[] {
  return all<ConversationRow & { message_count: number; last_message: string | null }>(
    `SELECT c.*,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message
     FROM conversations c WHERE c.archived = 0 ORDER BY c.updated_at DESC LIMIT ?`,
    Math.min(limit, 100),
  );
}

export function getConversation(conversationId: string): { conversation: ConversationRow; messages: MessageRow[] } | null {
  const conversation = get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', conversationId);
  if (!conversation) return null;
  const messages = all<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 400',
    conversationId,
  );
  return { conversation, messages };
}

function toLlmMessages(rows: MessageRow[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const row of rows) {
    if (row.role === 'user') {
      out.push({ role: 'user', content: row.content, untrusted: row.untrusted === 1 });
    } else if (row.role === 'assistant') {
      const calls = safeJson<{ id: string; name: string; arguments: string }[] | null>(row.tool_calls, null);
      out.push({ role: 'assistant', content: row.content, toolCalls: calls ?? [] });
    } else if (row.role === 'tool') {
      out.push({
        role: 'tool',
        toolCallId: row.tool_call_id ?? row.id,
        name: row.tool_name ?? 'tool',
        content: row.content,
        untrusted: row.untrusted === 1,
      });
    }
  }
  return out.slice(-HISTORY_LIMIT);
}

function autoTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 52) return clean || 'New conversation';
  return `${clean.slice(0, 52).trimEnd()}…`;
}

/* ------------------------------------------------------------------ */
/* Turn execution                                                      */
/* ------------------------------------------------------------------ */

export async function* runTurn(input: {
  conversationId?: string | null;
  text: string;
  voice?: boolean;
  channel?: 'web' | 'phone';
  signal?: AbortSignal;
}): AsyncGenerator<TurnEvent> {
  const settings = getSettings();
  const channel = input.channel ?? 'web';
  const conversation = ensureConversation(input.conversationId, channel);
  const userText = input.text.trim().slice(0, 20_000);
  if (!userText) {
    yield { type: 'error', message: 'Nothing was said.' };
    return;
  }

  const userMessage = addMessage({ conversationId: conversation.id, role: 'user', content: userText });
  if (!conversation.title) {
    run('UPDATE conversations SET title = ? WHERE id = ?', autoTitle(userText), conversation.id);
    conversation.title = autoTitle(userText);
  }

  yield {
    type: 'meta',
    conversationId: conversation.id,
    title: conversation.title ?? 'Conversation',
    model: settings.model.model,
    channel: conversation.channel,
  };

  const history = all<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
    conversation.id,
    HISTORY_LIMIT,
  ).reverse();

  const system = buildSystemPrompt(settings, {
    voice: input.voice,
    query: userText,
    extraContext: conversation.summary ? `Earlier in this conversation: ${conversation.summary}` : '',
  });

  const messages: LlmMessage[] = [{ role: 'system', content: system }, ...toLlmMessages(history)];

  const context: ToolContext = {
    channel,
    conversationId: conversation.id,
    taskId: null,
    autonomyLevel: settings.autonomy.level,
    signal: input.signal,
  };

  const generator = agentLoop({
    messages,
    context,
    signal: input.signal,
    maxSteps: 8,
    kind: 'chat',
  });

  let finalText = '';
  let approvalSeen: ApprovalRow | null = null;
  let failure: string | null = null;

  while (true) {
    const next = await generator.next();
    if (next.done) {
      finalText = next.value.text;
      approvalSeen = next.value.approval;
      failure = next.value.error;
      break;
    }
    const event = next.value;
    if (event.type === 'text') finalText += event.delta;
    if (event.type === 'approval') approvalSeen = event.approval;
    yield event;
  }

  if (finalText.trim()) {
    const saved = addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: finalText,
      model: settings.model.model,
    });
    yield { type: 'message', message: saved };
  }

  if (failure) {
    logActivity({
      level: 'error',
      category: 'chat',
      message: `Model error: ${truncate(failure, 300)}`,
      conversationId: conversation.id,
    });
    yield { type: 'error', message: failure };
  }

  if (approvalSeen) {
    logActivity({
      level: 'action',
      category: 'chat',
      message: `Asked for approval: ${approvalSeen.title}`,
      conversationId: conversation.id,
    });
  }

  if (settings.memory.autoSummarize) {
    const total = Number(
      (get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', conversation.id)?.n ?? 0),
    );
    if (total > 0 && total % 12 === 0) {
      void summariseConversation(conversation.id).catch(() => undefined);
    }
  }

  const messageId = id('done');
  yield { type: 'done', conversationId: conversation.id, messageId, interrupted: Boolean(input.signal?.aborted) };
  broadcast('conversation', { conversationId: conversation.id });
}

/* ------------------------------------------------------------------ */
/* Approval continuation                                               */
/* ------------------------------------------------------------------ */

/** Runs after the owner decides on an approval raised inside a conversation. */
export async function continueAfterApproval(
  approval: ApprovalRow,
  decision: 'approved' | 'rejected',
): Promise<void> {
  const conversationId = approval.conversation_id;
  if (!conversationId) return;
  const settings = getSettings();

  let toolNote: string;
  if (decision === 'approved') {
    const payload = parseApprovalPayload(approval);
    if (!payload) return;
    const result = await executeApprovedTool(payload.tool, payload.args, {
      channel: 'web',
      conversationId,
      taskId: null,
      autonomyLevel: settings.autonomy.level,
    });
    toolNote = result.ok
      ? `The owner approved ${payload.tool}. Result: ${result.content}`
      : `The owner approved ${payload.tool}, but it failed: ${result.content}`;
    addMessage({
      conversationId,
      role: 'tool',
      content: truncate(toolNote, 8000),
      toolCallId: id('apr_tool'),
      toolName: payload.tool,
      untrusted: result.untrusted,
    });
  } else {
    toolNote = `The owner rejected ${approval.title}. Do not retry this action; acknowledge it briefly.`;
    addMessage({
      conversationId,
      role: 'tool',
      content: toolNote,
      toolCallId: id('apr_tool'),
      toolName: 'approval',
    });
  }

  const conversation = get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', conversationId);
  if (!conversation) return;

  const history = all<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
    conversationId,
    HISTORY_LIMIT,
  ).reverse();

  const system = buildSystemPrompt(settings, {
    channel: 'web',
    extraContext: `An approval decision just happened. ${toolNote}`,
  });

  const generator = agentLoop({
    messages: [{ role: 'system', content: system }, ...toLlmMessages(history)],
    context: { channel: 'web', conversationId, taskId: null, autonomyLevel: settings.autonomy.level },
    maxSteps: 4,
    kind: 'chat',
  });

  let text = '';
  while (true) {
    const next = await generator.next();
    if (next.done) {
      text = next.value.text;
      break;
    }
    const event = next.value;
    if (event.type === 'text') text += event.delta;
    broadcast('chat', { conversationId, event });
  }

  if (text.trim()) {
    addMessage({ conversationId, role: 'assistant', content: text, model: settings.model.model });
  }
  broadcast('chat', { conversationId, event: { type: 'done', conversationId, interrupted: false } });
  broadcast('conversation', { conversationId });
}

/* ------------------------------------------------------------------ */
/* Memory maintenance                                                  */
/* ------------------------------------------------------------------ */

export async function summariseConversation(conversationId: string): Promise<void> {
  const rows = all<MessageRow>(
    `SELECT * FROM messages WHERE conversation_id = ? AND role IN ('user','assistant')
     ORDER BY created_at DESC LIMIT 24`,
    conversationId,
  ).reverse();
  if (rows.length < 6) return;

  const transcript = rows
    .map((row) => `${row.role === 'user' ? 'Owner' : 'BLOBS'}: ${truncate(row.content, 700)}`)
    .join('\n');

  const summary = await complete(
    `Summarise this conversation for your own long-term memory. Keep durable facts only: decisions, preferences, project state, commitments, lessons. Ignore small talk. Write 2-5 short lines, no preamble. If there is nothing durable, reply "NONE".`,
    transcript,
    { maxTokens: 400, kind: 'summary' },
  );

  if (!summary || /^none$/i.test(summary.trim())) return;

  run('UPDATE conversations SET summary = ? WHERE id = ?', truncate(summary, 2000), conversationId);
  remember({
    content: `Conversation summary (${new Date().toISOString().slice(0, 10)}): ${summary}`,
    kind: 'summary',
    tags: ['conversation'],
    importance: 2,
    source: 'auto-summary',
  });
}

/** Queue an objective straight from the UI (Tasks page). */
export async function startTaskFromChat(conversationId: string, objective: string): Promise<void> {
  const { createTask } = await import('./tasks.ts');
  createTask({ title: objective.slice(0, 70), objective, schedule: normalizeSchedule('once'), origin: 'owner' });
  broadcast('tasks', { conversationId });
  notify({ title: 'Task queued', body: truncate(objective, 160), level: 'info', link: '/tasks' });
}

export { executeTask, drainAgent };
