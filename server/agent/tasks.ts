import { all, get, run } from '../db.ts';
import { getSettings } from '../settings.ts';
import { broadcast, logActivity, notify } from '../activity.ts';
import { complete, tokensUsedToday } from '../llm/index.ts';
import { id, now, safeJson, sleep, truncate } from '../util.ts';
import { buildSystemPrompt } from './prompt.ts';
import { agentLoop, drainAgent } from './core.ts';
import { TOOL_NAMES } from './tools.ts';
import { createDeliverable } from '../deliverables.ts';
import type { LlmMessage } from '../llm/types.ts';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';

export type TaskSchedule =
  | { type: 'once' }
  | { type: 'interval'; minutes: number }
  | { type: 'clock'; at: string; days?: number[]; tz?: string; until?: number };

export interface TaskRow {
  id: string;
  project_id: string | null;
  title: string;
  objective: string;
  status: TaskStatus;
  autonomy: string;
  schedule: string | null;
  next_run_at: number | null;
  last_run_at: number | null;
  heartbeat: number | null;
  attempts: number;
  max_attempts: number;
  plan: string | null;
  checkpoint: string | null;
  result: string | null;
  error: string | null;
  origin: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface TaskStep {
  id: string;
  task_id: string;
  idx: number;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  output: string | null;
  started_at: number | null;
  finished_at: number | null;
}

interface Checkpoint {
  stepIndex: number;
  pendingApprovalId?: string | null;
  approvedResults?: { tool: string; content: string }[];
}

const DAY_NAMES: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

function parseClockTime(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text.trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = (match[3] ?? '').toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23) return null;
  return { hour, minute };
}

function parseDays(text: string): number[] | null {
  const cleaned = text.toLowerCase().trim();
  if (!cleaned) return null;
  if (/\bweekdays?\b/.test(cleaned)) return [1, 2, 3, 4, 5];
  if (/\bweekends?\b/.test(cleaned)) return [0, 6];
  const days: number[] = [];
  for (const part of cleaned.split(/[,+/]|\band\b/)) {
    for (const token of part.trim().split(/\s+/)) {
      const key = token.replace(/[^a-z]/g, '');
      if (key && key in DAY_NAMES) days.push(DAY_NAMES[key] as number);
    }
  }
  return days.length ? [...new Set(days)].sort((a, b) => a - b) : null;
}

/**
 * Schedules accept three shapes: once, an interval, or a local clock time.
 * Examples: "daily", "hourly", "every:30m", "09:00", "weekdays 09:00",
 * "mon,wed,fri 18:00 until 2026-12-31". Clock times use the owner's timezone.
 */
export function normalizeSchedule(raw: unknown): TaskSchedule {
  if (!raw) return { type: 'once' };

  if (typeof raw === 'object' && raw !== null && 'type' in raw) {
    const value = raw as {
      type?: string;
      minutes?: number;
      at?: string;
      days?: unknown;
      tz?: string;
      until?: number;
    };
    if (value.type === 'interval' && Number(value.minutes) > 0) {
      return { type: 'interval', minutes: Math.max(1, Math.round(Number(value.minutes))) };
    }
    if (value.type === 'clock') {
      const time = parseClockTime(String(value.at ?? ''));
      if (time) {
        const schedule: TaskSchedule = {
          type: 'clock',
          at: `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`,
        };
        const days = Array.isArray(value.days)
          ? value.days
              .map((day) => Number(day))
              .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
          : [];
        if (days.length) schedule.days = [...new Set(days)].sort((a, b) => a - b);
        if (typeof value.tz === 'string' && value.tz.trim()) schedule.tz = value.tz.trim();
        if (Number(value.until) > 0) schedule.until = Number(value.until);
        return schedule;
      }
    }
    return { type: 'once' };
  }

  if (typeof raw !== 'string') return { type: 'once' };
  let text = raw.trim().toLowerCase();
  if (!text || text === 'once') return { type: 'once' };
  if (text === 'hourly') return { type: 'interval', minutes: 60 };
  if (text === 'daily') return { type: 'interval', minutes: 1440 };

  const every = /^every:(\d+)(m|h|d)$/.exec(text);
  if (every) {
    const unit = every[2] === 'h' ? 60 : every[2] === 'd' ? 1440 : 1;
    return { type: 'interval', minutes: Math.max(1, Number(every[1]) * unit) };
  }

  let until: number | undefined;
  const untilMatch = /\buntil\s+(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (untilMatch) {
    const parsedUntil = Date.parse(`${untilMatch[1]}T23:59:59Z`);
    if (Number.isFinite(parsedUntil)) until = parsedUntil;
    text = text.replace(untilMatch[0], ' ').trim();
  }

  const timeMatch = /(\d{1,2}:\d{2})\b/.exec(text) ?? /(\d{1,2}\s*(?:am|pm))\b/.exec(text);
  if (!timeMatch) return { type: 'once' };
  const time = parseClockTime(timeMatch[1]);
  if (!time) return { type: 'once' };

  const prefix = text
    .replace(timeMatch[0], ' ')
    .replace(/\bat\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const days = parseDays(prefix);
  const schedule: TaskSchedule = {
    type: 'clock',
    at: `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`,
  };
  if (days) schedule.days = days;
  if (until) schedule.until = until;
  return schedule;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function zonedParts(ts: number, tz: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ts))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
  };
}

function tzOffsetMs(ts: number, tz: string): number {
  const parts = zonedParts(ts, tz);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return asUtc - ts;
}

/** Convert a wall-clock time in `tz` to an epoch timestamp, handling DST twice. */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz);
  return ts;
}

/** Next time this schedule should run, or null when it has no future run. */
export function nextRunAt(schedule: TaskSchedule, from = now()): number | null {
  if (schedule.type === 'once') return null;
  if (schedule.type === 'interval') {
    return from + Math.max(1, schedule.minutes) * 60_000;
  }

  const time = parseClockTime(schedule.at);
  if (!time) return from + 86_400_000;
  const tz = schedule.tz || getSettings().owner.timezone || 'UTC';
  const base = zonedParts(from, tz);
  const until = schedule.until ?? null;

  for (let offset = 0; offset < 14; offset += 1) {
    const day = new Date(Date.UTC(base.year, base.month - 1, base.day + offset));
    if (schedule.days?.length && !schedule.days.includes(day.getUTCDay())) continue;
    const candidate = zonedTimeToUtc(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      time.hour,
      time.minute,
      tz,
    );
    if (candidate <= from + 30_000) continue;
    if (until !== null && candidate > until) return null;
    return candidate;
  }
  return null;
}

export async function createTask(input: {
  title: string;
  objective: string;
  projectId?: string | null;
  schedule?: TaskSchedule;
  origin?: string;
  autonomy?: string;
  runAt?: number | null;
}): Promise<TaskRow> {
  const ts = now();
  const schedule = input.schedule ?? { type: 'once' };
  const row: TaskRow = {
    id: id('tsk'),
    project_id: input.projectId ?? null,
    title: (input.title || input.objective).slice(0, 160),
    objective: input.objective.trim(),
    status: 'queued',
    autonomy: input.autonomy ?? getSettings().autonomy.level,
    schedule: JSON.stringify(schedule),
    next_run_at: input.runAt ?? ts,
    last_run_at: null,
    heartbeat: null,
    attempts: 0,
    max_attempts: 3,
    plan: null,
    checkpoint: null,
    result: null,
    error: null,
    origin: input.origin ?? 'owner',
    created_at: ts,
    updated_at: ts,
    completed_at: null,
  };
  await run(
    `INSERT INTO tasks(id, project_id, title, objective, status, autonomy, schedule, next_run_at, last_run_at,
      heartbeat, attempts, max_attempts, plan, checkpoint, result, error, origin, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.project_id,
    row.title,
    row.objective,
    row.status,
    row.autonomy,
    row.schedule,
    row.next_run_at,
    row.last_run_at,
    row.heartbeat,
    row.attempts,
    row.max_attempts,
    row.plan,
    row.checkpoint,
    row.result,
    row.error,
    row.origin,
    row.created_at,
    row.updated_at,
    row.completed_at,
  );
  logActivity({
    level: 'info',
    category: 'task',
    message: `Queued task "${row.title}".`,
    meta: { taskId: row.id, schedule },
    taskId: row.id,
  });
  broadcast('tasks', { taskId: row.id, status: row.status });
  return row;
}

export async function listTaskRows(status?: string): Promise<TaskRow[]> {
  if (status && status !== 'all') {
    return await all<TaskRow>('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT 200', status);
  }
  return await all<TaskRow>('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200');
}

export async function getTask(taskId: string): Promise<TaskRow | null> {
  return await get<TaskRow>('SELECT * FROM tasks WHERE id = ?', taskId);
}

export async function taskDetail(
  taskId: string,
): Promise<{ task: TaskRow; steps: TaskStep[] } | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  const steps = await all<TaskStep>('SELECT * FROM task_steps WHERE task_id = ? ORDER BY idx', taskId);
  return { task, steps };
}

export async function taskStats(): Promise<Record<string, number>> {
  const rows = await all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status');
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = Number(row.n);
  return out;
}

async function setStatus(taskId: string, status: TaskStatus, patch: Partial<TaskRow> = {}): Promise<void> {
  const fields: string[] = ['status = ?', 'updated_at = ?'];
  const params: unknown[] = [status, now()];
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = ?`);
    params.push(value);
  }
  params.push(taskId);
  await run(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`, ...params);
  broadcast('tasks', { taskId, status });
}

export async function cancelTask(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;
  await setStatus(taskId, 'cancelled', { error: 'Cancelled by the owner.', heartbeat: null });
  logActivity({ level: 'warn', category: 'task', message: `Cancelled "${task.title}".`, taskId });
}

export async function retryTask(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;
  const checkpoint = safeJson<Checkpoint>(task.checkpoint, { stepIndex: 0 });
  await run(
    `UPDATE tasks SET status = 'queued', error = NULL, attempts = 0, next_run_at = ?, heartbeat = NULL,
      checkpoint = ?, updated_at = ? WHERE id = ?`,
    now(),
    JSON.stringify({ stepIndex: Math.max(0, checkpoint.stepIndex - 0) }),
    now(),
    taskId,
  );
  broadcast('tasks', { taskId, status: 'queued' });
}

export async function pauseTask(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;
  await setStatus(taskId, 'paused', { heartbeat: null });
}

export async function resumeTask(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;
  await setStatus(taskId, 'queued', { next_run_at: now(), error: null });
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

interface PlanStep {
  description: string;
}

function parsePlan(raw: string): PlanStep[] {
  const text = raw.trim();
  const candidates: string[] = [];
  const arrayMatch = /\[[\s\S]*\]/.exec(text);
  if (arrayMatch) candidates.push(arrayMatch[0]);
  const objectMatch = /\{[\s\S]*\}/.exec(text);
  if (objectMatch) candidates.push(objectMatch[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { steps?: unknown }).steps)
          ? (parsed as { steps: unknown[] }).steps
          : [];
      const steps = list
        .map((item) => {
          if (typeof item === 'string') return { description: item };
          if (item && typeof item === 'object' && typeof (item as { description?: unknown }).description === 'string') {
            return { description: (item as { description: string }).description };
          }
          return null;
        })
        .filter((item): item is PlanStep => Boolean(item && item.description.trim()))
        .slice(0, 10)
        .map((item) => ({ description: truncate(item.description.trim(), 400) }));
      if (steps.length) return steps;
    } catch {
      /* try the next candidate */
    }
  }
  return [];
}

async function planSteps(task: TaskRow): Promise<PlanStep[]> {
  try {
    const raw = await complete(
      `You plan work for an autonomous AI agent. Return ONLY compact JSON of the form {"steps":[{"description":"..."}]}.
Rules: 3-8 steps. Each step must be completable in one agent run using tools (web_search, fetch_page, write_note, run_js, remember, create_task is forbidden). Never plan a step that requires asking the owner a question. Order steps so later steps can use earlier results. Be concrete.`,
      `Task: ${task.title}\nObjective: ${task.objective}\n\nProduce the plan.`,
      { maxTokens: 700, temperature: 0.2, kind: 'plan' },
    );
    const parsed = parsePlan(raw);
    if (parsed.length) return parsed;
  } catch {
    /* fall through to a single-step plan */
  }
  return [
    {
      description: `Work through the objective end to end using tools, then report what was done and what remains.`,
    },
  ];
}

async function ensurePlan(task: TaskRow): Promise<TaskStep[]> {
  const existing = await all<TaskStep>('SELECT * FROM task_steps WHERE task_id = ? ORDER BY idx', task.id);
  if (existing.length) return existing;
  const plan = await planSteps(task);
  for (const [idx, step] of plan.entries()) {
    await run(
      `INSERT INTO task_steps(id, task_id, idx, description, status) VALUES (?, ?, ?, ?, 'pending')`,
      id('stp'),
      task.id,
      idx,
      step.description,
    );
  }
  await run('UPDATE tasks SET plan = ?, updated_at = ? WHERE id = ?', JSON.stringify(plan), now(), task.id);
  logActivity({
    level: 'info',
    category: 'task',
    message: `Planned ${plan.length} steps for "${task.title}".`,
    meta: { steps: plan.map((step) => step.description) },
    taskId: task.id,
  });
  return await all<TaskStep>('SELECT * FROM task_steps WHERE task_id = ? ORDER BY idx', task.id);
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

const running = new Set<string>();

export function isTaskRunning(taskId: string): boolean {
  return running.has(taskId);
}

export async function executeTask(taskId: string): Promise<void> {
  if (running.has(taskId)) return;
  const task = await getTask(taskId);
  if (!task) return;
  if (!['queued', 'running', 'paused', 'waiting_approval'].includes(task.status)) return;

  const settings = getSettings();
  if (settings.autonomy.state === 'stopped') {
    await setStatus(taskId, 'paused', { error: 'Emergency stop is active.' });
    return;
  }
  if (settings.autonomy.state === 'paused') {
    await setStatus(taskId, 'paused', { error: 'Autonomy is paused by the owner.' });
    return;
  }
  if (settings.autonomy.dailyTokenBudget > 0 && await tokensUsedToday() >= settings.autonomy.dailyTokenBudget) {
    await setStatus(taskId, 'paused', { error: 'Daily token budget reached. BLOBS will resume when you raise it.' });
    notify({
      title: 'Task paused: token budget reached',
      body: `"${task.title}" is waiting for tomorrow's budget.`,
      level: 'warn',
      link: '/tasks',
    });
    return;
  }

  running.add(taskId);
  try {
    await setStatus(taskId, 'running', {
      heartbeat: now(),
      last_run_at: now(),
      attempts: task.attempts + 1,
      error: null,
    });

    const steps = await ensurePlan(task);
    const checkpoint = safeJson<Checkpoint>(task.checkpoint, { stepIndex: 0 });
    let stepIndex = Math.min(checkpoint.stepIndex ?? 0, steps.length);
    const approvedResults = checkpoint.approvedResults ?? [];

    let lastOutput = task.result ?? '';

    while (stepIndex < steps.length) {
      const current = await getTask(taskId);
      if (!current) return;
      if (getSettings().autonomy.state === 'stopped') {
        await setStatus(taskId, 'paused', { error: 'Emergency stop is active.', heartbeat: null });
        return;
      }
      if (getSettings().autonomy.state === 'paused') {
        await setStatus(taskId, 'paused', { error: 'Autonomy paused by the owner.', heartbeat: null });
        return;
      }

      const step = steps[stepIndex];
      await run('UPDATE task_steps SET status = ?, started_at = ? WHERE id = ?', 'running', now(), step.id);
      await run('UPDATE tasks SET heartbeat = ?, updated_at = ? WHERE id = ?', now(), now(), taskId);
      broadcast('tasks', { taskId, status: 'running', stepIndex });

      const completed = steps
        .slice(0, stepIndex)
        .map((item) => `- ${item.description}: ${truncate(item.output ?? '(no output)', 260)}`)
        .join('\n');

      const extra = [
        `Task: ${task.title}`,
        `Objective: ${task.objective}`,
        `Full plan:\n${steps.map((item, idx) => `${idx + 1}. ${item.description}`).join('\n')}`,
        completed ? `Completed so far:\n${completed}` : '',
        approvedResults.length
          ? `Approved tool results from earlier:\n${approvedResults
              .map((result) => `${result.tool}: ${truncate(result.content, 700)}`)
              .join('\n')}`
          : '',
        `Current step (${stepIndex + 1}/${steps.length}): ${step.description}`,
      ]
        .filter(Boolean)
        .join('\n\n');

      const messages: LlmMessage[] = [
        { role: 'system', content: await buildSystemPrompt(getSettings(), { taskMode: true, query: task.objective, extraContext: extra }) },
        {
          role: 'user',
          content: `Execute step ${stepIndex + 1} now. Use tools. When it is complete, reply with a 2-4 sentence outcome: what you did, what you found, and anything still blocked. Do not ask me questions.`,
        },
      ];

      let output = '';
      let failure: string | null = null;
      let approvalId: string | null = null;

      // One automatic retry for a step that failed before producing anything.
      let result = { text: '', error: null as string | null, approval: null as { id: string } | null };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const generator = agentLoop({
          messages,
          context: { channel: 'task', taskId, conversationId: null, autonomyLevel: settings.autonomy.level },
          maxSteps: Math.min(settings.autonomy.maxStepsPerTask, 8),
          maxToolCalls: Math.min(settings.autonomy.maxToolCallsPerTask, 20),
          allowTools: TOOL_NAMES.filter((name) => name !== 'create_task'),
          kind: 'task',
        });

        result = await drainAgent(generator, (event) => {
          if (event.type === 'tool_end') {
            broadcast('tasks', { taskId, status: 'running', tool: event.name, ok: event.ok, stepIndex });
          }
        });
        if (!result.error || result.text.trim()) break;
        if (attempt === 0) {
          logActivity({
            level: 'warn',
            category: 'task',
            message: `Step ${stepIndex + 1} failed, retrying once.`,
            taskId,
          });
          await sleep(1500);
        }
      }
      output = result.text;
      failure = result.error;
      approvalId = result.approval?.id ?? null;

      if (approvalId) {
        await run('UPDATE task_steps SET status = ?, output = ? WHERE id = ?', 'pending', truncate(output, 4000), step.id);
        await run(
          'UPDATE tasks SET status = ?, checkpoint = ?, updated_at = ?, heartbeat = NULL WHERE id = ?',
          'waiting_approval',
          JSON.stringify({ stepIndex, pendingApprovalId: approvalId, approvedResults }),
          now(),
          taskId,
        );
        broadcast('tasks', { taskId, status: 'waiting_approval', stepIndex });
        logActivity({
          level: 'action',
          category: 'task',
          message: `"${task.title}" is waiting for approval.`,
          taskId,
        });
        notify({ title: 'Task needs approval', body: task.title, level: 'warn', link: '/approvals' });
        return;
      }

      if (failure && !output.trim()) {
        await run('UPDATE task_steps SET status = ?, output = ? WHERE id = ?', 'failed', failure, step.id);
        await setStatus(taskId, 'failed', {
          error: truncate(failure, 1500),
          heartbeat: null,
          checkpoint: JSON.stringify({ stepIndex, approvedResults }),
          completed_at: now(),
        });
        logActivity({ level: 'error', category: 'task', message: `Task failed: ${truncate(failure, 250)}`, taskId });
        if (getSettings().notifications.notifyOnError) {
          notify({ title: 'Task failed', body: `${task.title}: ${truncate(failure, 160)}`, level: 'error', link: '/tasks' });
        }
        return;
      }

      lastOutput = output || failure || lastOutput;
      await run(
        'UPDATE task_steps SET status = ?, output = ?, finished_at = ? WHERE id = ?',
        'done',
        truncate(output || '(completed)', 8000),
        now(),
        step.id,
      );
      stepIndex += 1;
      await run(
        'UPDATE tasks SET checkpoint = ?, result = ?, updated_at = ?, heartbeat = ? WHERE id = ?',
        JSON.stringify({ stepIndex, approvedResults }),
        truncate(lastOutput, 8000),
        now(),
        now(),
        taskId,
      );
      broadcast('tasks', { taskId, status: 'running', stepIndex, total: steps.length });
    }

    const schedule = safeJson<TaskSchedule>(task.schedule, { type: 'once' });
    const next = schedule.type === 'once' ? null : nextRunAt(schedule);
    if (next !== null) {
      await run('DELETE FROM task_steps WHERE task_id = ?', taskId);
      await run(
        `UPDATE tasks SET status = 'queued', checkpoint = NULL, plan = NULL, next_run_at = ?, completed_at = ?,
          heartbeat = NULL, updated_at = ? WHERE id = ?`,
        next,
        now(),
        now(),
        taskId,
      );
      logActivity({
        level: 'success',
        category: 'task',
        message: `"${task.title}" finished this round; next run ${new Date(next).toLocaleString()}.`,
        taskId,
      });
      broadcast('tasks', { taskId, status: 'queued' });
    } else {
      await setStatus(taskId, 'done', {
        completed_at: now(),
        heartbeat: null,
        result: truncate(lastOutput, 8000),
        checkpoint: JSON.stringify({ stepIndex, approvedResults }),
      });
      // A completed run must leave something reviewable behind. If the agent
      // did not deliver a packet itself, hand the outcome over as one.
      if (task.origin !== 'responsibility' && lastOutput.trim().length > 120) {
        const existing = await get<{ id: string }>(
          'SELECT id FROM deliverables WHERE task_id = ? LIMIT 1',
          taskId,
        );
        if (!existing) {
          await createDeliverable({
            title: task.title,
            body: `# ${task.title}\n\n${lastOutput.trim()}`,
            taskId,
            silent: true,
          });
        }
      }
      logActivity({ level: 'success', category: 'task', message: `Completed "${task.title}".`, taskId });
      if (getSettings().notifications.notifyOnTaskComplete) {
        notify({
          title: 'Task complete',
          body: `${task.title}: ${truncate(lastOutput.replace(/\s+/g, ' '), 180)}`,
          level: 'success',
          link: '/tasks',
        });
      }
      broadcast('tasks', { taskId, status: 'done' });
    }
  } catch (error) {
    const message = (error as Error).message;
    await setStatus(taskId, 'failed', { error: truncate(message, 1500), heartbeat: null, completed_at: now() });
    logActivity({ level: 'error', category: 'task', message: `Task crashed: ${truncate(message, 300)}`, taskId });
  } finally {
    running.delete(taskId);
  }
}

/** Called when an approval belonging to a task is decided. */
export async function resumeTaskAfterApproval(taskId: string, tool: string, content: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;
  const checkpoint = safeJson<Checkpoint>(task.checkpoint, { stepIndex: 0 });
  await run(
    `UPDATE tasks SET status = 'queued', checkpoint = ?, next_run_at = ?, error = NULL, updated_at = ? WHERE id = ?`,
    JSON.stringify({
      stepIndex: checkpoint.stepIndex ?? 0,
      approvedResults: [...(checkpoint.approvedResults ?? []), { tool, content: truncate(content, 3000) }],
    }),
    now(),
    now(),
    taskId,
  );
  broadcast('tasks', { taskId, status: 'queued' });
}
