import vm from 'node:vm';
import { cleanWorkspacePath, listWorkspace, readWorkspaceText, writeWorkspaceText } from '../workspace.ts';
import type { AutonomyLevel } from '../settings.ts';
import { getSettings } from '../settings.ts';
import { get } from '../db.ts';
import {
  remember,
  searchMemories,
  listMemories,
  updateMemory,
  deleteMemory,
  mergeMemories,
  type MemoryKind,
} from '../memory.ts';
import { assertPublicUrl, extractTitle, fetchWithTimeout, htmlToText, truncate } from '../util.ts';
import type { ToolSchema } from '../llm/types.ts';
import { createTask, executeTask, getTask, listTaskRows, normalizeSchedule } from './tasks.ts';
import { webSearch, type SearchHit } from '../search.ts';
import {
  checkWatch,
  createWatch,
  deleteWatch,
  listWatches,
  updateWatch,
  type WatchKind,
} from '../watches.ts';
import { runResearch } from '../research.ts';
import {
  createResponsibility,
  listResponsibilities,
  runResponsibility,
  updateResponsibility,
} from './responsibilities.ts';
import { createDeliverable, publishDeliverable } from '../deliverables.ts';
import { oauthRequest } from '../oauth.ts';
import { createProject, updateProject } from './projects.ts';
import { browserAction, type BrowserActionName, type BrowserResult } from '../computer/browser.ts';
import { sendEmail, emailStatus } from '../comms/email.ts';
import { placeCall, phoneStatus } from '../comms/phone.ts';
import { notify } from '../activity.ts';
import {
  computerStatus,
  desktopAction,
  installPackages,
  runCode,
  runShell,
  sandboxFiles,
  startServer,
  transferFile,
} from '../computer/e2b.ts';

export type RiskKey = 'financial' | 'deletion' | 'publishing' | 'externalMessages' | 'security';

export interface ToolContext {
  channel: 'web' | 'phone' | 'task' | 'email';
  conversationId?: string | null;
  taskId?: string | null;
  autonomyLevel: AutonomyLevel;
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  untrusted?: boolean;
  summary: string;
  display?: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: 'low' | 'medium' | 'high';
  approvalKey?: RiskKey;
  category: 'research' | 'memory' | 'files' | 'code' | 'tasks' | 'comms' | 'system' | 'computer';
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Render a browser result as the compact text the model reads. */
function formatBrowser(result: BrowserResult): string {
  if (result.closed) return 'Browser closed.';
  const lines: string[] = [];
  if (result.url) lines.push(`${result.title || '(untitled)'} — ${result.url}`);
  if (result.screenshotPath) {
    lines.push(`Screenshot saved to ${result.screenshotPath} (${Math.round((result.bytes ?? 0) / 1024)} KB).`);
  }
  if (result.links?.length) {
    lines.push('Links:');
    for (const link of result.links.slice(0, 60)) lines.push(`- ${link.text || '(no text)'} → ${link.href}`);
  }
  if (result.html) lines.push(truncate(result.html, 8000));
  if (result.elements?.length) {
    lines.push('Elements:');
    for (const element of result.elements) {
      const bits = [`[${element.index}]`, element.tag];
      if (element.type) bits.push(`(${element.type})`);
      if (element.label) bits.push(`"${element.label}"`);
      if (element.href) bits.push(`→ ${element.href}`);
      lines.push(bits.join(' '));
    }
  }
  if (result.text) lines.push('Text:', truncate(result.text, 4000));
  return lines.join('\n').trim() || 'Done.';
}

/* ------------------------------------------------------------------ */
/* Web research                                                        */
/* ------------------------------------------------------------------ */

/* Web search lives in ../search.ts so the research pipeline shares it. */

/* ------------------------------------------------------------------ */
/* Workspace files                                                     */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Sandboxed JavaScript                                                */
/* ------------------------------------------------------------------ */

function runSandboxed(code: string): { output: string; error: string | null } {
  const logs: string[] = [];
  const write = (...args: unknown[]): void => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  const sandbox = {
    console: { log: write, error: write, warn: write, info: write },
    JSON,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    Error,
    isNaN,
    parseInt,
    parseFloat,
    result: undefined as unknown,
  };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  try {
    const script = new vm.Script(code, { filename: 'blobs-sandbox.js' });
    const returned = script.runInContext(context, { timeout: 3000, displayErrors: true });
    if (returned !== undefined) logs.push(typeof returned === 'string' ? returned : JSON.stringify(returned));
    return { output: logs.join('\n').slice(0, 8000), error: null };
  } catch (error) {
    return { output: logs.join('\n').slice(0, 8000), error: (error as Error).message };
  }
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const TOOLS: ToolDef[] = [
  {
    name: 'web_search',
    description:
      'Search the public web and get titles, URLs and snippets. Use for current facts, news or anything you do not already know. Follow up with fetch_page to read a promising result.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, 2-8 words.' },
      },
      required: ['query'],
    },
    risk: 'low',
    category: 'research',
    async run(args) {
      const query = str(args, 'query').trim();
      if (!query) return { ok: false, content: 'Missing query.', summary: 'Search called without a query.' };
      let hits: SearchHit[] = [];
      let engine = 'DuckDuckGo';
      try {
        const result = await webSearch(query, 8);
        hits = result.hits;
        engine = result.engine;
      } catch {
        hits = [];
      }
      if (!hits.length) {
        return {
          ok: false,
          content: `No results were returned for "${query}". The search engines may be rate limiting.`,
          summary: `Search for "${query}" returned nothing.`,
        };
      }
      const body = hits
        .slice(0, 6)
        .map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`)
        .join('\n');
      return {
        ok: true,
        untrusted: true,
        content: `Results from ${engine} for "${query}":\n${body}`,
        summary: `Searched for "${query}" (${hits.length} results via ${engine}).`,
      };
    },
  },
  {
    name: 'fetch_page',
    description: 'Download a public web page and return its readable text. Use after web_search to read a source in detail.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) URL.' },
        max_chars: { type: 'number', description: 'How much text to return, 500-20000. Default 8000.' },
      },
      required: ['url'],
    },
    risk: 'low',
    category: 'research',
    async run(args) {
      const raw = str(args, 'url').trim();
      const target = assertPublicUrl(raw);
      const response = await fetchWithTimeout(
        target.toString(),
        { headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' }, redirect: 'follow' },
        20_000,
      );
      if (!response.ok) {
        return { ok: false, content: `The page responded with HTTP ${response.status}.`, summary: `Fetch failed (${response.status}) for ${target.hostname}.` };
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const raw = await response.text();
        return {
          ok: true,
          untrusted: true,
          content: truncate(raw, num(args, 'max_chars', 8000)),
          summary: `Read JSON from ${target.hostname}.`,
        };
      }
      const html = await response.text();
      const text = htmlToText(html);
      const title = extractTitle(html);
      return {
        ok: true,
        untrusted: true,
        content: `${title ? `# ${title}\n` : ''}Source: ${target.toString()}\n\n${truncate(text, Math.min(num(args, 'max_chars', 8000), 20_000))}`,
        summary: `Read ${title || target.hostname}.`,
      };
    },
  },
  {
    name: 'research',
    description:
      'Run a deep research task on a question: plan sub-questions, search and read several sources, extract claims with quotes, and write a cited report saved as a review packet. Use this instead of a few web_search/fetch_page calls when the answer needs multiple sources, dates or numbers. Returns a short summary plus the packet id.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question to research, including any scope, timeframe or constraints.',
        },
        depth: {
          type: 'string',
          enum: ['quick', 'deep'],
          description:
            'quick = 3 sub-questions and up to 8 sources. deep = 5 sub-questions, up to 16 sources and a gap-filling round. Default quick.',
        },
        max_sources: { type: 'number', description: 'Optional cap on sources read, 4-24.' },
      },
      required: ['question'],
    },
    risk: 'low',
    category: 'research',
    async run(args, context) {
      const question = str(args, 'question').trim();
      if (!question) {
        return { ok: false, content: 'Give me a research question.', summary: 'Research called without a question.' };
      }
      const depth = str(args, 'depth') === 'deep' ? 'deep' : 'quick';
      const result = await runResearch({
        question,
        depth,
        maxSources: args.max_sources === undefined ? undefined : num(args, 'max_sources', 8),
        taskId: context.taskId ?? null,
        conversationId: context.conversationId ?? null,
      });
      return {
        ok: result.ok,
        content: result.summary,
        summary: result.ok
          ? `Researched "${truncate(question, 60)}" (${result.sourceCount} sources, ${result.claimCount} claims).`
          : 'Research failed.',
        display: result.deliverableId
          ? { deliverableId: result.deliverableId, sourceCount: result.sourceCount }
          : undefined,
      };
    },
  },
  {
    name: 'remember',
    description:
      'Store something durable about the owner, their preferences, a decision, a project, a lesson or an important fact. Use sparingly and never for secrets, passwords or full private documents.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'One clear sentence or short paragraph in the owner\'s context.' },
        kind: { type: 'string', enum: ['fact', 'preference', 'project', 'decision', 'lesson', 'person', 'note'] },
        tags: { type: 'array', items: { type: 'string' }, description: 'Short lower-case tags for retrieval.' },
        importance: { type: 'number', description: '1-5, 5 = must never be forgotten.' },
      },
      required: ['content'],
    },
    risk: 'low',
    category: 'memory',
    async run(args) {
      const row = await remember({
        content: str(args, 'content'),
        kind: (str(args, 'kind') || 'fact') as 'fact',
        tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
        importance: num(args, 'importance', 3),
        source: 'agent',
      });
      return { ok: true, content: `Saved memory ${row.id} (${row.kind}).`, summary: 'Saved a memory.', display: { memoryId: row.id } };
    },
  },
  {
    name: 'recall',
    description: 'Search your long-term memory for anything relevant to a topic. Use it before saying you do not remember.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for.' },
        limit: { type: 'number', description: 'How many memories, 1-15. Default 6.' },
      },
      required: ['query'],
    },
    risk: 'low',
    category: 'memory',
    async run(args) {
      const query = str(args, 'query');
      const rows = query ? await searchMemories(query, num(args, 'limit', 6)) : await listMemories({ limit: 6 });
      if (!rows.length) return { ok: true, content: 'Nothing relevant is stored in memory.', summary: 'Memory search found nothing.' };
      return {
        ok: true,
        untrusted: true,
        // The id is part of the line so update_memory and forget_memory can address it.
        content: rows.map((row) => `- [${row.kind}] (${row.id}) ${row.content}`).join('\n'),
        summary: `Recalled ${rows.length} memories.`,
      };
    },
  },
  {
    name: 'update_memory',
    description:
      'Correct a memory you already stored: fix its wording, change its kind, retag it or re-rank its importance. Pass merge_ids to fold duplicate memories into it. Use this instead of storing a second, contradictory memory.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The memory id shown by recall.' },
        content: { type: 'string', description: 'Replacement text, in the owner context.' },
        kind: {
          type: 'string',
          enum: ['fact', 'preference', 'project', 'decision', 'lesson', 'person', 'summary', 'note'],
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tags.' },
        importance: { type: 'number', description: '1-5, 5 = must never be forgotten.' },
        pinned: { type: 'boolean', description: 'Pin or unpin the memory.' },
        merge_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Other memories to fold into this one and delete. Pinned memories are refused.',
        },
      },
      required: ['id'],
    },
    risk: 'low',
    category: 'memory',
    async run(args) {
      const memoryId = str(args, 'id').trim();
      if (!memoryId) return { ok: false, content: 'Give the memory id that recall showed.', summary: 'Update needs a memory id.' };
      const existing = await get<{ id: string }>('SELECT id FROM memories WHERE id = ?', memoryId);
      if (!existing) return { ok: false, content: `No memory ${memoryId}.`, summary: 'Update failed: no such memory.' };

      const mergeIds = (Array.isArray(args.merge_ids) ? (args.merge_ids as string[]) : [])
        .map((value) => String(value).trim())
        .filter((value) => value && value !== memoryId);
      for (const otherId of mergeIds) {
        const row = await get<{ pinned: number }>('SELECT pinned FROM memories WHERE id = ?', otherId);
        if (!row) return { ok: false, content: `No memory ${otherId}.`, summary: 'Merge failed: no such memory.' };
        if (row.pinned) {
          return {
            ok: false,
            content: `Memory ${otherId} is pinned. Unpin it with pinned: false before merging it away.`,
            summary: 'Merge refused: pinned memory.',
          };
        }
      }

      const patch: { content?: string; kind?: MemoryKind; tags?: string[]; importance?: number; pinned?: boolean } = {};
      if (str(args, 'content').trim()) patch.content = str(args, 'content');
      const kind = str(args, 'kind');
      const kinds: MemoryKind[] = ['fact', 'preference', 'project', 'decision', 'lesson', 'person', 'summary', 'note'];
      if (kind && kinds.includes(kind as MemoryKind)) patch.kind = kind as MemoryKind;
      if (Array.isArray(args.tags)) patch.tags = (args.tags as unknown[]).map((tag) => String(tag));
      if (args.importance !== undefined) patch.importance = num(args, 'importance', 3);
      if (typeof args.pinned === 'boolean') patch.pinned = args.pinned;

      if (!Object.keys(patch).length && !mergeIds.length) {
        return { ok: false, content: 'Nothing to change: give content, kind, tags, importance, pinned or merge_ids.', summary: 'Update had no changes.' };
      }

      if (Object.keys(patch).length) await updateMemory(memoryId, patch);
      if (mergeIds.length) await mergeMemories(memoryId, mergeIds);

      return {
        ok: true,
        content: `Updated memory ${memoryId}.${mergeIds.length ? ` Merged ${mergeIds.length} more into it.` : ''}`,
        summary: 'Corrected a memory.',
        display: { memoryId, merged: mergeIds },
      };
    },
  },
  {
    name: 'forget_memory',
    description:
      'Delete memories that are wrong, obsolete or duplicated. Prefer update_memory when the fact is still true but worded badly. Pinned memories are refused; unpin them first.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'One memory id from recall.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Several memory ids at once.' },
      },
    },
    risk: 'low',
    category: 'memory',
    async run(args) {
      const ids = [...(Array.isArray(args.ids) ? (args.ids as string[]) : []), str(args, 'id')]
        .map((value) => String(value).trim())
        .filter(Boolean);
      if (!ids.length) return { ok: false, content: 'Give a memory id that recall showed.', summary: 'Forget needs a memory id.' };

      const removed: string[] = [];
      const skipped: string[] = [];
      for (const memoryId of ids) {
        const row = await get<{ pinned: number }>('SELECT pinned FROM memories WHERE id = ?', memoryId);
        if (!row) {
          skipped.push(`${memoryId} (not found)`);
          continue;
        }
        if (row.pinned) {
          skipped.push(`${memoryId} (pinned)`);
          continue;
        }
        if (await deleteMemory(memoryId)) removed.push(memoryId);
      }

      const parts = [
        removed.length ? `Forgot ${removed.length}: ${removed.join(', ')}.` : '',
        skipped.length ? `Skipped ${skipped.join(', ')}.` : '',
      ].filter(Boolean);
      return {
        ok: removed.length > 0,
        content: parts.join(' ') || 'Nothing was deleted.',
        summary: `Forgot ${removed.length} ${removed.length === 1 ? 'memory' : 'memories'}.`,
        display: { removed, skipped },
      };
    },
  },
  {
    name: 'write_note',
    description: 'Create or overwrite a markdown note in your workspace. Use for research summaries, drafts and organised information.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path, e.g. notes/market-research.md' },
        content: { type: 'string', description: 'Markdown content.' },
      },
      required: ['path', 'content'],
    },
    risk: 'low',
    category: 'files',
    async run(args) {
      const relative = cleanWorkspacePath(str(args, 'path') || 'notes/untitled.md');
      await writeWorkspaceText(relative, str(args, 'content'));
      return {
        ok: true,
        content: `Wrote ${relative}.`,
        summary: `Wrote note ${relative}.`,
        display: { path: relative },
      };
    },
  },
  {
    name: 'list_files',
    description: 'List files in your workspace so you know what has already been written.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Optional subfolder.' } },
    },
    risk: 'low',
    category: 'files',
    async run(args) {
      const files = await listWorkspace(str(args, 'path'), 2);
      return {
        ok: true,
        content: files.length ? files.join('\n') : 'The workspace is empty.',
        summary: `Listed ${files.length} workspace entries.`,
      };
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file from your workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path.' },
        max_chars: { type: 'number', description: 'Default 8000.' },
      },
      required: ['path'],
    },
    risk: 'low',
    category: 'files',
    async run(args) {
      const relative = cleanWorkspacePath(str(args, 'path'));
      const text = await readWorkspaceText(relative);
      if (text === null) return { ok: false, content: 'No such file.', summary: 'Read failed: file missing.' };
      return {
        ok: true,
        untrusted: true,
        content: truncate(text, num(args, 'max_chars', 8000)),
        summary: `Read ${relative}.`,
      };
    },
  },
  {
    name: 'run_js',
    description:
      'Run a short JavaScript snippet in an isolated sandbox (no network, no filesystem) to compute or transform data. Use console.log or return a value.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'JavaScript source, max ~4000 characters.' } },
      required: ['code'],
    },
    risk: 'low',
    category: 'code',
    async run(args) {
      const code = str(args, 'code').slice(0, 6000);
      if (!code.trim()) return { ok: false, content: 'No code supplied.', summary: 'Empty code run.' };
      const result = runSandboxed(code);
      return {
        ok: !result.error,
        content: result.error
          ? `Error: ${result.error}\nOutput before the error:\n${result.output}`
          : result.output || '(no output)',
        summary: result.error ? 'Sandboxed script failed.' : 'Ran a sandboxed script.',
      };
    },
  },
  {
    name: 'create_task',
    description:
      'Queue a multi-step background task that BLOBS will work on even when the owner closes the site. Use for objectives that need real research or several steps.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title.' },
        objective: { type: 'string', description: 'What must be achieved, with any constraints.' },
        project_id: { type: 'string', description: 'Optional existing project id.' },
        schedule: {
          type: 'string',
          description:
            'Optional: "once" (default), "hourly", "daily", "every:30m", or a local time such as "09:00", "weekdays 09:00", "mon,wed,fri 18:00". Add "until 2026-12-31" to stop. Times use the owner timezone.',
        },
      },
      required: ['title', 'objective'],
    },
    risk: 'medium',
    category: 'tasks',
    async run(args, context) {
      if (context.channel === 'task') {
        return { ok: false, content: 'Nested task creation is not allowed. Finish this task instead.', summary: 'Blocked nested task.' };
      }
      if (getSettings().autonomy.level === 'manual') {
        return { ok: false, content: 'The owner set autonomy to manual; background tasks need their approval.', summary: 'Task creation blocked by autonomy.' };
      }
      const schedule = normalizeSchedule(str(args, 'schedule'));
      const task = await createTask({
        title: str(args, 'title') || 'Untitled task',
        objective: str(args, 'objective'),
        projectId: str(args, 'project_id') || null,
        schedule,
        origin: 'agent',
        autonomy: getSettings().autonomy.level,
      });
      return {
        ok: true,
        content: `Queued task ${task.id}: ${task.title}. It will run in the background.`,
        summary: `Queued background task "${task.title}".`,
        display: { taskId: task.id },
      };
    },
  },
  {
    name: 'list_tasks',
    description: 'See the current tasks and their status so you do not duplicate work.',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string', description: 'Optional status filter.' } },
    },
    risk: 'low',
    category: 'tasks',
    async run(args) {
      const rows = await listTaskRows(args.status ? String(args.status) : undefined);
      if (!rows.length) return { ok: true, content: 'There are no tasks yet.', summary: 'Listed tasks: none.' };
      return {
        ok: true,
        content: rows.map((task) => `- [${task.status}] ${task.title} (${task.id})`).join('\n'),
        summary: `Listed ${rows.length} tasks.`,
      };
    },
  },
  {
    name: 'deliver',
    description:
      'Hand the owner a finished review packet — a report, draft, plan or summary — as markdown or HTML. Optionally publish it to an unguessable link that expires, for reading on a phone or sharing. Use this when substantial work is done.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title the owner will see.' },
        body: { type: 'string', description: 'The full packet. Markdown unless kind is html.' },
        kind: { type: 'string', enum: ['markdown', 'html'] },
        publish: { type: 'boolean', description: 'Create an expiring public link.' },
        hours: { type: 'number', description: 'Link lifetime in hours, 1-168. Default 168.' },
      },
      required: ['title', 'body'],
    },
    risk: 'low',
    category: 'files',
    async run(args, context) {
      const title = str(args, 'title').trim();
      const body = str(args, 'body');
      if (!title) return { ok: false, content: 'Give the packet a title.', summary: 'Packet needs a title.' };
      if (!body.trim()) return { ok: false, content: 'The packet body is empty.', summary: 'Packet needs a body.' };
      const deliverable = await createDeliverable({
        title,
        body,
        kind: str(args, 'kind') === 'html' ? 'html' : 'markdown',
        taskId: context.taskId ?? null,
        conversationId: context.conversationId ?? null,
      });
      let link = '';
      if (args.publish === true) {
        const published = await publishDeliverable(deliverable.id, num(args, 'hours', 168));
        if (published) link = `/d/${published.token}`;
      }
      return {
        ok: true,
        content: `Saved review packet ${deliverable.id}: ${deliverable.title}.${link ? ` Public link: ${link}` : ''}`,
        summary: `Delivered "${deliverable.title}".`,
        display: { deliverableId: deliverable.id, url: link || null },
      };
    },
  },
  {
    name: 'delegate',
    description:
      'Hand a self-contained piece of work to a sub-agent that runs it in its own task with a fresh context and returns its outcome. Use for deep or parallel work; do not delegate what you can finish in one step.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the sub-task.' },
        objective: { type: 'string', description: 'What the sub-agent must deliver. Be specific about the expected output.' },
        objectives: {
          type: 'array',
          items: { type: 'string' },
          description: 'Several self-contained objectives to run in parallel (at most 4). Use this when the pieces do not depend on each other.',
        },
        project_id: { type: 'string' },
      },
      required: [],
    },
    risk: 'low',
    category: 'tasks',
    async run(args, context) {
      if (context.taskId) {
        return {
          ok: false,
          content: 'A sub-agent cannot spawn another sub-agent.',
          summary: 'Nested delegation refused.',
        };
      }
      const many = Array.isArray(args.objectives)
        ? (args.objectives as unknown[]).map((item) => String(item).trim()).filter(Boolean).slice(0, 4)
        : [];
      const single = str(args, 'objective').trim();
      const objectives = many.length ? many : single ? [single] : [];
      if (!objectives.length) {
        return { ok: false, content: 'Give the sub-agent an objective, or several in objectives.', summary: 'Sub-agent needs an objective.' };
      }

      const runOne = async (objective: string, index: number) => {
        const task = await createTask({
          title: (index === 0 ? str(args, 'title').trim() : '') || objective.slice(0, 80),
          objective,
          projectId: str(args, 'project_id') || null,
          origin: 'subagent',
        });
        await executeTask(task.id);
        const finished = await getTask(task.id);
        return {
          taskId: task.id,
          title: finished?.title ?? objective.slice(0, 80),
          status: finished?.status ?? 'missing',
          result: finished?.result ?? '',
          error: finished?.error ?? '',
        };
      };

      // Two at a time overlaps the work without tripping provider rate limits.
      const outcomes: Awaited<ReturnType<typeof runOne>>[] = [];
      for (let start = 0; start < objectives.length; start += 2) {
        const batch = objectives.slice(start, start + 2).map((objective, offset) => runOne(objective, start + offset));
        outcomes.push(...(await Promise.all(batch)));
      }

      const failed = outcomes.filter((outcome) => outcome.status !== 'done');
      const report = outcomes
        .map((outcome) => `### ${outcome.title}\nStatus: ${outcome.status}\n${outcome.result || outcome.error || 'No output.'}`)
        .join('\n\n');
      return {
        ok: failed.length === 0,
        content: `${outcomes.length === 1 ? 'Sub-agent finished' : `${outcomes.length} sub-agents ran`}.\n\n${report}`,
        summary:
          failed.length > 0
            ? `${failed.length} of ${outcomes.length} sub-agent tasks did not finish.`
            : `Completed ${outcomes.length} sub-agent ${outcomes.length === 1 ? 'task' : 'tasks'}.`,
        display: { taskIds: outcomes.map((outcome) => outcome.taskId) },
      };
    },
  },
  {
    name: 'watch',
    description:
      'Set up or manage a proactive watch: a page, RSS/Atom feed or search query checked on a cadence. When the content changes the owner is notified and, by default, you are handed a task to investigate what changed. This is how you notice things between conversations.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'update', 'delete', 'run'] },
        watch_id: { type: 'string', description: 'Required for update, delete and run.' },
        kind: { type: 'string', enum: ['url', 'rss', 'search'], description: 'url = a page, rss = a feed, search = a query whose top results are tracked.' },
        target: { type: 'string', description: 'The URL, feed URL or search query.' },
        label: { type: 'string', description: 'Short human name for the watch.' },
        cadence_minutes: { type: 'number', description: 'How often to check. Default 360 (six hours).' },
        notify: { type: 'boolean', description: 'Notify on change. Default true.' },
        create_task: { type: 'boolean', description: 'Queue an investigation task on change. Default true.' },
        status: { type: 'string', enum: ['active', 'paused'] },
      },
      required: ['action'],
    },
    risk: 'low',
    category: 'tasks',
    async run(args) {
      const action = str(args, 'action');
      if (action === 'list') {
        const watches = await listWatches();
        if (!watches.length) return { ok: true, content: 'No watches are set up yet.', summary: 'Listed watches: none.' };
        return {
          ok: true,
          content: watches
            .map(
              (watch) =>
                `- [${watch.status}] ${watch.label} (${watch.id}), ${watch.kind}: ${watch.target}, every ${watch.cadence_minutes} min. Last checked: ${watch.last_checked_at ? new Date(watch.last_checked_at).toISOString() : 'never'}. Last change: ${watch.last_change_at ? new Date(watch.last_change_at).toISOString() : 'none yet'}.`,
            )
            .join('\n'),
          summary: `Listed ${watches.length} watches.`,
        };
      }

      if (action === 'create') {
        const kind = str(args, 'kind') as WatchKind;
        if (kind !== 'url' && kind !== 'rss' && kind !== 'search') {
          return { ok: false, content: 'Choose kind url, rss or search.', summary: 'Watch needs a kind.' };
        }
        const target = str(args, 'target').trim();
        if (!target) return { ok: false, content: 'Give the watch a URL or query.', summary: 'Watch needs a target.' };
        const watch = await createWatch({
          kind,
          target,
          label: str(args, 'label'),
          cadenceMinutes: num(args, 'cadence_minutes', 360),
          notifyOnChange: args.notify !== false,
          createTaskOnChange: args.create_task !== false,
        });
        return {
          ok: true,
          content: `Watching "${watch.label}" (${watch.kind}) every ${watch.cadence_minutes} minutes. The first check records a baseline; you hear about it only when it changes.`,
          summary: `Watching "${watch.label}".`,
          display: { watchId: watch.id },
        };
      }

      const watchId = str(args, 'watch_id');
      if (!watchId) return { ok: false, content: `Give the watch id for ${action}.`, summary: 'Watch id required.' };

      if (action === 'delete') {
        const removed = await deleteWatch(watchId);
        return removed
          ? { ok: true, content: `Dropped watch ${watchId}.`, summary: 'Watch dropped.' }
          : { ok: false, content: 'No such watch.', summary: 'Watch not found.' };
      }

      if (action === 'update') {
        const updated = await updateWatch(watchId, {
          status: str(args, 'status') === 'paused' ? 'paused' : str(args, 'status') === 'active' ? 'active' : undefined,
          label: str(args, 'label') || undefined,
          target: str(args, 'target') || undefined,
          cadenceMinutes: args.cadence_minutes === undefined ? undefined : num(args, 'cadence_minutes', 360),
          notifyOnChange: args.notify === undefined ? undefined : args.notify !== false,
          createTaskOnChange: args.create_task === undefined ? undefined : args.create_task !== false,
        });
        return updated
          ? { ok: true, content: `Updated watch "${updated.label}" (${updated.status}, every ${updated.cadence_minutes} min).`, summary: 'Watch updated.' }
          : { ok: false, content: 'No such watch.', summary: 'Watch not found.' };
      }

      if (action === 'run') {
        const result = await checkWatch(watchId);
        if (!result) return { ok: false, content: 'No such watch.', summary: 'Watch not found.' };
        const verdict = result.baseline ? 'Baseline captured' : result.changed ? 'Changed since the last check' : 'Unchanged';
        return {
          ok: true,
          content: `${verdict} for "${result.watch.label}".\n\n${result.summary}`,
          summary: `${verdict}: "${result.watch.label}".`,
          display: { watchId, changed: result.changed },
        };
      }

      return { ok: false, content: 'Unknown action. Use create, list, update, delete or run.', summary: 'Unknown watch action.' };
    },
  },
  {
    name: 'own_responsibility',
    description:
      'Take on, adjust, list or run a standing responsibility: an ongoing goal you keep advancing on a cadence, using your own previous outcome to decide the next step. This is how you own work between conversations.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'list', 'run'] },
        responsibility_id: { type: 'string', description: 'Required for update and run.' },
        title: { type: 'string' },
        objective: { type: 'string', description: 'What this responsibility is for.' },
        cadence_minutes: { type: 'number', description: 'How often to work on it, in minutes. Default 1440 (daily).' },
        project_id: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused', 'done'] },
      },
      required: ['action'],
    },
    risk: 'low',
    category: 'tasks',
    async run(args) {
      const action = str(args, 'action');
      if (action === 'list') {
        const rows = await listResponsibilities();
        if (!rows.length) {
          return { ok: true, content: 'You have no standing responsibilities yet.', summary: 'Listed responsibilities: none.' };
        }
        return {
          ok: true,
          content: rows
            .map(
              (row) =>
                `- [${row.status}] ${row.title} (${row.id}), every ${row.cadence_minutes} min. Last outcome: ${truncate(row.last_outcome ?? 'none yet', 180)}`,
            )
            .join('\n'),
          summary: `Listed ${rows.length} responsibilities.`,
        };
      }
      if (action === 'create') {
        if (!str(args, 'title') && !str(args, 'objective')) {
          return { ok: false, content: 'Give the responsibility a title or an objective.', summary: 'Responsibility needs a title.' };
        }
        const row = await createResponsibility({
          title: str(args, 'title') || str(args, 'objective'),
          objective: str(args, 'objective'),
          projectId: str(args, 'project_id') || null,
          cadenceMinutes: num(args, 'cadence_minutes', 1440),
        });
        return {
          ok: true,
          content: `Took on responsibility ${row.id}: ${row.title}, worked on every ${row.cadence_minutes} minutes.`,
          summary: `Took on responsibility "${row.title}".`,
          display: { responsibilityId: row.id },
        };
      }
      const responsibilityId = str(args, 'responsibility_id');
      if (!responsibilityId) {
        return { ok: false, content: 'responsibility_id is required for update and run.', summary: 'Missing responsibility id.' };
      }
      if (action === 'run') {
        const result = await runResponsibility(responsibilityId, { force: true });
        if (!result) {
          return { ok: false, content: 'That responsibility does not exist or is already running.', summary: 'Responsibility not run.' };
        }
        return {
          ok: true,
          content: `Ran it and advanced the responsibility. Outcome:\n${result.outcome}`,
          summary: 'Advanced a responsibility.',
          display: { taskId: result.taskId },
        };
      }
      if (action === 'update') {
        const status = str(args, 'status');
        const updated = await updateResponsibility(responsibilityId, {
          title: str(args, 'title') || undefined,
          objective: str(args, 'objective') || undefined,
          cadenceMinutes: args.cadence_minutes === undefined ? undefined : num(args, 'cadence_minutes', 1440),
          projectId: args.project_id === undefined ? undefined : str(args, 'project_id') || null,
          status: status === 'active' || status === 'paused' || status === 'done' ? status : undefined,
        });
        if (!updated) {
          return { ok: false, content: 'No responsibility with that id.', summary: 'Responsibility not found.' };
        }
        return {
          ok: true,
          content: `Updated ${updated.title}: ${updated.status}, worked on every ${updated.cadence_minutes} minutes.`,
          summary: 'Updated a responsibility.',
        };
      }
      return { ok: false, content: 'Unknown action. Use create, update, list or run.', summary: 'Unknown responsibility action.' };
    },
  },
  {
    name: 'oauth_request',
    description:
      'Call an authenticated HTTP API using a connected OAuth account (GitHub, Google, ...). Use after the owner connects the account in Integrations.',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Connected provider id, e.g. github or google.' },
        method: { type: 'string', description: 'HTTP method. Default GET.' },
        url: { type: 'string', description: 'Full https URL of the API endpoint.' },
        headers: { type: 'object', description: 'Extra headers as an object.' },
        body: { type: 'string', description: 'Request body as a string.' },
      },
      required: ['provider', 'url'],
    },
    risk: 'low',
    category: 'computer',
    async run(args) {
      const provider = str(args, 'provider');
      const url = str(args, 'url').trim();
      if (!provider || !url) return { ok: false, content: 'provider and url are required.', summary: 'Missing OAuth request fields.' };
      try {
        const result = await oauthRequest({
          provider,
          method: str(args, 'method') || 'GET',
          url,
          headers: (args.headers as Record<string, string>) ?? undefined,
          body: args.body === undefined ? undefined : String(args.body),
        });
        return {
          ok: result.status >= 200 && result.status < 300,
          content: `HTTP ${result.status}\n${result.body}`,
          summary: `OAuth request to ${provider}: ${result.status}.`,
        };
      } catch (error) {
        return { ok: false, content: (error as Error).message, summary: 'OAuth request failed.' };
      }
    },
  },
  {
    name: 'manage_project',
    description: 'Create a long-term project or update one (status, objective, notes append).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update'] },
        project_id: { type: 'string', description: 'Required for update.' },
        title: { type: 'string' },
        objective: { type: 'string' },
        notes_append: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused', 'done'] },
      },
      required: ['action'],
    },
    risk: 'low',
    category: 'system',
    async run(args) {
      if (str(args, 'action') === 'create') {
        const project = await createProject({ title: str(args, 'title') || 'Untitled project', objective: str(args, 'objective') });
        return { ok: true, content: `Created project ${project.id}.`, summary: `Created project "${project.title}".` };
      }
      const updated = await updateProject(str(args, 'project_id'), {
        title: str(args, 'title') || undefined,
        objective: str(args, 'objective') || undefined,
        notesAppend: str(args, 'notes_append') || undefined,
        status: (str(args, 'status') || undefined) as 'active' | undefined,
      });
      if (!updated) return { ok: false, content: 'No project with that id.', summary: 'Project update failed.' };
      return { ok: true, content: `Updated project ${updated.id}.`, summary: `Updated project "${updated.title}".` };
    },
  },
  {
    name: 'notify_owner',
    description: 'Send the owner an in-app notification about something important that happened or needs their attention.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        level: { type: 'string', enum: ['info', 'success', 'warn', 'error'] },
      },
      required: ['title'],
    },
    risk: 'low',
    category: 'system',
    async run(args) {
      notify({
        title: str(args, 'title'),
        body: str(args, 'body'),
        level: (str(args, 'level') || 'info') as 'info',
      });
      return { ok: true, content: 'Notification delivered.', summary: `Notified owner: ${str(args, 'title')}` };
    },
  },
  {
    name: 'send_email',
    description:
      'Send an email as BLOBS from its own configured address. Requires the owner to connect email in Integrations and to approve this action.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain text body. Sign as BLOBS and state that you are an AI.' },
      },
      required: ['to', 'subject', 'body'],
    },
    risk: 'high',
    approvalKey: 'externalMessages',
    category: 'comms',
    async run(args, context) {
      const status = await emailStatus();
      if (!status.ready) {
        return {
          ok: false,
          content: `Email is not connected: ${status.detail}. Tell the owner to connect it in Integrations.`,
          summary: 'Email send blocked: not configured.',
        };
      }
      const result = await sendEmail({
        to: str(args, 'to'),
        subject: str(args, 'subject'),
        body: str(args, 'body'),
        context,
      });
      return {
        ok: result.ok,
        content: result.ok ? `Email sent to ${str(args, 'to')}.` : `Email failed: ${result.error}`,
        summary: result.ok ? `Emailed ${str(args, 'to')}.` : 'Email failed.',
      };
    },
  },
  {
    name: 'make_phone_call',
    description:
      'Call the owner (or an approved number) and speak a short message. Requires a Twilio connection and owner approval.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What BLOBS should say when the call connects.' },
        to: { type: 'string', description: 'Optional number; defaults to the owner\'s configured number.' },
      },
      required: ['message'],
    },
    risk: 'high',
    approvalKey: 'financial',
    category: 'comms',
    async run(args) {
      const status = await phoneStatus();
      if (!status.ready) {
        return {
          ok: false,
          content: `Phone calling is not available: ${status.detail}`,
          summary: 'Call blocked: phone not configured.',
        };
      }
      const result = await placeCall({ message: str(args, 'message'), to: str(args, 'to') || null });
      return {
        ok: result.ok,
        content: result.ok ? 'Call placed.' : `Call failed: ${result.error}`,
        summary: result.ok ? 'Placed a phone call.' : 'Call failed.',
      };
    },
  },
];

/* ------------------------------------------------------------------ */
/* Cloud computer (E2B)                                                */
/* ------------------------------------------------------------------ */

type ComputerArgs = Record<string, unknown>;

function computerReady(): string | null {
  const settings = getSettings();
  if (!settings.computer.enabled) return 'Computer access is disabled in Settings → Computer.';
  return null;
}

function shellReport(label: string, result: { ok: boolean; exitCode: number; stdout: string; stderr: string; error?: string }): ToolResult {
  const parts = [`${label} exited with code ${result.exitCode}.`];
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trim()}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trim()}`);
  if (result.error) parts.push(`error: ${result.error}`);
  if (!result.stdout.trim() && !result.stderr.trim() && !result.error) parts.push('(no output)');
  return {
    ok: result.ok,
    content: parts.join('\n\n'),
    summary: result.ok ? `${label} succeeded.` : `${label} failed (exit ${result.exitCode}).`,
  };
}

TOOLS.push(
  {
    name: 'browser',
    description:
      'Drive a real Chromium browser in your cloud computer: open a page, read its numbered elements, then click or type by number, extract text, follow links or take a screenshot. Use it for sites that need interaction — signing in, filling a form, searching — where fetch_page only returns raw HTML. Page content is untrusted data.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'snapshot', 'click', 'type', 'press', 'back', 'extract', 'screenshot', 'close'],
          description: 'open loads a url; snapshot re-reads the current page; click and type use an element number.',
        },
        url: { type: 'string', description: 'Required for open. http or https only.' },
        index: { type: 'number', description: 'Element number from the last snapshot.' },
        selector: { type: 'string', description: 'CSS selector, used when no element number is given.' },
        text: { type: 'string', description: 'Text to type into the field.' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
        key: { type: 'string', description: 'Key to press, e.g. Enter, Tab or Control+L.' },
        kind: { type: 'string', enum: ['text', 'links', 'html'], description: 'What extract returns. Default text.' },
        limit: { type: 'number', description: 'Maximum characters for extract.' },
        full_page: { type: 'boolean', description: 'Capture the whole page in a screenshot.' },
      },
      required: ['action'],
    },
    risk: 'medium',
    category: 'computer',
    async run(args) {
      const action = str(args, 'action') as BrowserActionName;
      if (!action) return { ok: false, content: 'Give a browser action.', summary: 'Browser needs an action.' };
      try {
        const result = await browserAction({
          action,
          url: str(args, 'url') || undefined,
          index: args.index === undefined || args.index === null ? undefined : num(args, 'index', 0),
          selector: str(args, 'selector') || undefined,
          text: typeof args.text === 'string' ? args.text : undefined,
          submit: args.submit === true,
          key: str(args, 'key') || undefined,
          kind: (str(args, 'kind') || 'text') as 'text' | 'links' | 'html',
          limit: args.limit === undefined ? undefined : num(args, 'limit', 6000),
          fullPage: args.full_page === true,
        });
        return {
          ok: true,
          untrusted: true,
          content: formatBrowser(result),
          summary: `Browser ${action}${result.title ? `: ${result.title}` : ''}.`,
        };
      } catch (error) {
        return { ok: false, content: (error as Error).message, summary: 'Browser action failed.' };
      }
    },
  },
  {
    name: 'computer_status',
    description:
      'Check whether BLOBS has a cloud computer, which sandbox is attached, and how to use it. Call this before assuming shell access.',
    parameters: { type: 'object', properties: {} },
    risk: 'low',
    category: 'computer',
    async run() {
      const status = await computerStatus();
      const lines = [
        `Provider: ${status.provider}`,
        `Connected: ${status.configured ? 'yes' : 'no'}`,
        `Sandbox: ${status.sandboxId ?? 'not created yet'}`,
        `Desktop sandbox: ${status.desktopId ?? 'not created yet'}`,
        `Timeout: ${status.timeoutMinutes} minutes`,
        status.detail,
      ];
      if (status.configured) {
        lines.push(
          'Available: run_shell, run_code, install_packages, sandbox_files, sandbox_transfer, start_server, desktop_action.',
          'The computer is an isolated Linux VM. Nothing on the owner\'s own machine is touched.',
        );
      }
      return {
        ok: status.configured,
        content: lines.join('\n'),
        summary: status.configured ? 'Cloud computer is available.' : 'Cloud computer is not connected.',
      };
    },
  },
  {
    name: 'run_shell',
    description:
      'Run any shell command on your own cloud Linux computer (E2B). Use this for real work: inspecting systems, git, curl, compilers, package managers, scripts, long commands. Files persist between calls in the same sandbox.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        cwd: { type: 'string', description: 'Working directory, default /home/user.' },
        timeout_seconds: { type: 'number', description: '1-120, default 60.' },
      },
      required: ['command'],
    },
    risk: 'medium',
    category: 'computer',
    async run(args: ComputerArgs) {
      const blocked = computerReady();
      if (blocked) return { ok: false, content: blocked, summary: 'Computer disabled.' };
      const command = str(args, 'command').trim();
      if (!command) return { ok: false, content: 'No command supplied.', summary: 'Empty shell call.' };
      const result = await runShell(command, {
        cwd: str(args, 'cwd') || undefined,
        timeoutMs: num(args, 'timeout_seconds', 60) * 1000,
      });
      return shellReport(`\`${truncate(command, 80)}\``, result);
    },
  },
  {
    name: 'run_code',
    description:
      'Write and execute a Python, JavaScript or Bash program on your cloud computer. Prefer this over describing code when the owner wants something actually run.',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['python', 'javascript', 'bash'] },
        code: { type: 'string', description: 'Full program source.' },
      },
      required: ['language', 'code'],
    },
    risk: 'medium',
    category: 'computer',
    async run(args: ComputerArgs) {
      const blocked = computerReady();
      if (blocked) return { ok: false, content: blocked, summary: 'Computer disabled.' };
      const language = str(args, 'language') || 'python';
      const code = str(args, 'code');
      if (!code.trim()) return { ok: false, content: 'No code supplied.', summary: 'Empty code run.' };
      const result = await runCode(language, code.slice(0, 100_000));
      const report = shellReport(`${language} program`, result);
      return { ...report, content: `${report.content}\n\nSaved as ${result.file}.` };
    },
  },
  {
    name: 'install_packages',
    description: 'Install system or language packages on your cloud computer with apt, pip or npm.',
    parameters: {
      type: 'object',
      properties: {
        manager: { type: 'string', enum: ['pip', 'npm', 'apt'] },
        packages: { type: 'array', items: { type: 'string' }, description: 'Package names.' },
      },
      required: ['manager', 'packages'],
    },
    risk: 'medium',
    category: 'computer',
    async run(args: ComputerArgs) {
      const blocked = computerReady();
      if (blocked) return { ok: false, content: blocked, summary: 'Computer disabled.' };
      const manager = (['pip', 'npm', 'apt'].includes(str(args, 'manager')) ? str(args, 'manager') : 'pip') as
        | 'pip'
        | 'npm'
        | 'apt';
      const packages = Array.isArray(args.packages) ? (args.packages as string[]) : [];
      const result = await installPackages(manager, packages);
      return shellReport(`${manager} install`, result);
    },
  },
  {
    name: 'sandbox_files',
    description:
      'List, read, write, create, move or delete files on your cloud computer. Use absolute paths such as /home/user/report.md.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'write', 'delete', 'mkdir', 'move'] },
        path: { type: 'string', description: 'Absolute path inside the sandbox.' },
        content: { type: 'string', description: 'File content when writing.' },
        destination: { type: 'string', description: 'Destination path when moving.' },
      },
      required: ['action', 'path'],
    },
    risk: 'medium',
    category: 'computer',
    async run(args: ComputerArgs) {
      const blocked = computerReady();
      if (blocked) return { ok: false, content: blocked, summary: 'Computer disabled.' };
      const action = str(args, 'action') as 'list';
      const path = str(args, 'path');
      const text = await sandboxFiles(action, {
        path,
        content: str(args, 'content'),
        destination: str(args, 'destination'),
      });
      const ok = !/^.*(does not exist).*$/i.test(text);
      return { ok, content: text, summary: `${action} ${truncate(path, 60)}` };
    },
  },
  {
    name: 'sandbox_transfer',
    description:
      'Move a file between your cloud computer and the BLOBS workspace. Download brings a result home; upload sends a document you already have to the computer.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['download', 'upload'] },
        sandbox_path: { type: 'string', description: 'Absolute path on the computer.' },
        workspace_path: { type: 'string', description: 'Relative path in the BLOBS workspace.' },
      },
      required: ['direction', 'sandbox_path', 'workspace_path'],
    },
    risk: 'medium',
    category: 'computer',
    async run(args: ComputerArgs) {
      const blocked = computerReady();
      if (blocked) return { ok: false, content: blocked, summary: 'Computer disabled.' };
      const direction = str(args, 'direction') === 'upload' ? 'upload' : 'download';
      const message = await transferFile(direction, str(args, 'sandbox_path'), str(args, 'workspace_path'));
      return { ok: true, content: message, summary: `${direction} file.` };
    },
  },
  {
    name: 'start_server',
    description:
      'Start a long-running process on your cloud computer (web app, API, notebook server) and get a public HTTPS URL for it.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command that starts the server, e.g. "python3 -m http.server 8000".' },
        port: { type: 'number', description: 'Port the server listens on.' },
      },
      required: ['command', 'port'],
    },
    risk: 'medium',
    category: 'computer',
    async run(args: ComputerArgs) {
      const blocked = computerReady();
      if (blocked) return { ok: false, content: blocked, summary: 'Computer disabled.' };
      const port = Math.round(num(args, 'port', 0));
      if (!port) return { ok: false, content: 'A port is required.', summary: 'Server start failed.' };
      const result = await startServer(str(args, 'command'), port);
      return {
        ok: true,
        content: `${result.url}\n\n${result.note}`,
        summary: `Started a server on port ${port}.`,
        display: { url: result.url },
      };
    },
  },
  {
    name: 'desktop_action',
    description:
      'Control the graphical desktop of your cloud computer: screenshot, click, type, press keys, scroll, drag, open a URL or launch an app. Take a screenshot first, then act. The owner can see the latest screenshot in the control centre.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'click', 'double_click', 'right_click', 'move', 'type', 'key', 'scroll', 'drag', 'open', 'launch'],
        },
        x: { type: 'number' },
        y: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        text: { type: 'string', description: 'Text to type.' },
        key: { type: 'string', description: 'Key or chord, e.g. Enter or ctrl+c.' },
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'number', description: 'Scroll ticks, 1-20.' },
        target: { type: 'string', description: 'URL, file or application for open/launch.' },
      },
      required: ['action'],
    },
    risk: 'medium',
    category: 'computer',
    async run(args: ComputerArgs) {
      const settings = getSettings();
      if (!settings.computer.desktop) {
        return { ok: false, content: 'Desktop control is disabled in Settings → Computer.', summary: 'Desktop disabled.' };
      }
      const result = await desktopAction({
        action: str(args, 'action') as 'screenshot',
        x: args.x === undefined ? undefined : Number(args.x),
        y: args.y === undefined ? undefined : Number(args.y),
        toX: args.toX === undefined ? undefined : Number(args.toX),
        toY: args.toY === undefined ? undefined : Number(args.toY),
        text: str(args, 'text'),
        key: str(args, 'key'),
        direction: (str(args, 'direction') as 'down') || undefined,
        amount: args.amount === undefined ? undefined : Number(args.amount),
        target: str(args, 'target'),
      });
      return {
        ok: true,
        content: `${result.message} The latest screenshot is available to the owner in Integrations → Computer.`,
        summary: `Desktop ${str(args, 'action')}.`,
        display: { screenshot: Boolean(result.screenshot) },
      };
    },
  },
);

export const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function toolSchemas(allowed?: string[]): ToolSchema[] {
  return TOOLS.filter((tool) => !allowed || allowed.includes(tool.name)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * BLOBS is autonomous-first: no tool is ever held behind a manual approval.
 * The emergency stop is enforced in the agent loop and stays the only thing
 * that can block a side-effecting action. Kept as a function so callers and
 * older integrations still have one place to ask.
 */
export function requiresApproval(_tool: ToolDef, _context: ToolContext): boolean {
  return false;
}

export function approvalCategory(tool: ToolDef): RiskKey {
  if (tool.approvalKey) return tool.approvalKey;
  return tool.category === 'computer' ? 'security' : 'publishing';
}

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);

export function toolCount(): number {
  return TOOLS.length;
}

export function toolCatalog(): { name: string; description: string; category: string; risk: string }[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description.split('.')[0] + '.',
    category: tool.category,
    risk: tool.risk,
  }));
}

export function hasTool(name: string): boolean {
  return TOOL_MAP.has(name);
}

export function getTool(name: string): ToolDef | null {
  return TOOL_MAP.get(name) ?? null;
}

export async function ownerPhone(): Promise<string> {
  const row = await get<{ config: string }>("SELECT config FROM integrations WHERE key = 'phone'");
  if (!row?.config) return '';
  try {
    return (JSON.parse(row.config) as { ownerNumber?: string }).ownerNumber ?? '';
  } catch {
    return '';
  }
}
