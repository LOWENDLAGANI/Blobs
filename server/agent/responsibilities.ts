import { all, get, run } from '../db.ts';
import { id, now, truncate } from '../util.ts';
import { broadcast, logActivity, notify } from '../activity.ts';
import { createTask, executeTask, getTask } from './tasks.ts';
import { createDeliverable } from '../deliverables.ts';

/**
 * Responsibilities: the standing goals BLOBS owns.
 *
 * A task is work that ends. A responsibility is something the agent keeps
 * coming back to: it runs on a cadence, reads its own previous outcome, decides
 * the single most useful next step, does it, and reports. Nothing asks the
 * owner for permission — this is the autonomous loop.
 */

export type ResponsibilityStatus = 'active' | 'paused' | 'done';

export interface ResponsibilityRow {
  id: string;
  project_id: string | null;
  title: string;
  objective: string;
  cadence_minutes: number;
  status: ResponsibilityStatus;
  last_run_at: number | null;
  next_run_at: number | null;
  last_outcome: string | null;
  last_task_id: string | null;
  run_count: number;
  created_at: number;
  updated_at: number;
}

const running = new Set<string>();
const MIN_CADENCE = 1;
const MAX_CADENCE = 43_200; // 30 days

function cadence(value: unknown, fallback = 1440): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_CADENCE, Math.max(MIN_CADENCE, parsed));
}

export function isResponsibilityRunning(responsibilityId: string): boolean {
  return running.has(responsibilityId);
}

export async function createResponsibility(input: {
  title: string;
  objective: string;
  projectId?: string | null;
  cadenceMinutes?: number;
  runNow?: boolean;
}): Promise<ResponsibilityRow> {
  const ts = now();
  const minutes = cadence(input.cadenceMinutes);
  const row: ResponsibilityRow = {
    id: id('rsp'),
    project_id: input.projectId ?? null,
    title: (input.title.trim() || input.objective.trim() || 'Untitled responsibility').slice(0, 160),
    objective: input.objective.trim(),
    cadence_minutes: minutes,
    status: 'active',
    last_run_at: null,
    next_run_at: input.runNow ? ts : ts + minutes * 60_000,
    last_outcome: null,
    last_task_id: null,
    run_count: 0,
    created_at: ts,
    updated_at: ts,
  };
  await run(
    `INSERT INTO responsibilities(id, project_id, title, objective, cadence_minutes, status, last_run_at, next_run_at,
      last_outcome, last_task_id, run_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.project_id,
    row.title,
    row.objective,
    row.cadence_minutes,
    row.status,
    row.last_run_at,
    row.next_run_at,
    row.last_outcome,
    row.last_task_id,
    row.run_count,
    row.created_at,
    row.updated_at,
  );
  logActivity({
    level: 'info',
    category: 'responsibility',
    message: `Took on responsibility "${row.title}".`,
    meta: { responsibilityId: row.id, cadenceMinutes: row.cadence_minutes },
  });
  broadcast('tasks', { responsibilityId: row.id, status: row.status });
  return row;
}

export async function listResponsibilities(): Promise<ResponsibilityRow[]> {
  return all<ResponsibilityRow>(
    `SELECT * FROM responsibilities
     ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
              COALESCE(next_run_at, 0) ASC, created_at DESC`,
  );
}

export async function getResponsibility(responsibilityId: string): Promise<ResponsibilityRow | null> {
  return get<ResponsibilityRow>('SELECT * FROM responsibilities WHERE id = ?', responsibilityId);
}

export async function updateResponsibility(
  responsibilityId: string,
  patch: {
    title?: string;
    objective?: string;
    status?: ResponsibilityStatus;
    cadenceMinutes?: number;
    projectId?: string | null;
  },
): Promise<ResponsibilityRow | null> {
  const existing = await getResponsibility(responsibilityId);
  if (!existing) return null;

  const minutes = patch.cadenceMinutes === undefined ? existing.cadence_minutes : cadence(patch.cadenceMinutes, existing.cadence_minutes);
  const status = patch.status ?? existing.status;
  const rearm =
    status === 'active' &&
    (existing.status !== 'active' ||
      minutes !== existing.cadence_minutes ||
      (existing.next_run_at !== null && existing.next_run_at <= now()));
  const nextRunAt = status !== 'active' ? existing.next_run_at : rearm ? now() : existing.next_run_at;

  await run(
    `UPDATE responsibilities SET project_id = ?, title = ?, objective = ?, cadence_minutes = ?, status = ?,
      next_run_at = ?, updated_at = ? WHERE id = ?`,
    patch.projectId === undefined ? existing.project_id : patch.projectId,
    patch.title?.trim().slice(0, 160) || existing.title,
    patch.objective?.trim() ?? existing.objective,
    minutes,
    status,
    nextRunAt,
    now(),
    responsibilityId,
  );
  logActivity({
    level: 'info',
    category: 'responsibility',
    message: `Updated responsibility "${existing.title}" (${status}).`,
    meta: { responsibilityId },
  });
  broadcast('tasks', { responsibilityId, status });
  return getResponsibility(responsibilityId);
}

export async function deleteResponsibility(responsibilityId: string): Promise<boolean> {
  const existing = await getResponsibility(responsibilityId);
  if (!existing) return false;
  await run('DELETE FROM responsibilities WHERE id = ?', responsibilityId);
  logActivity({
    level: 'info',
    category: 'responsibility',
    message: `Dropped responsibility "${existing.title}".`,
    meta: { responsibilityId },
  });
  broadcast('tasks', { responsibilityId, status: 'deleted' });
  return true;
}

function objectiveFor(row: ResponsibilityRow): string {
  return [
    `Standing responsibility: ${row.title}`,
    `Objective: ${row.objective || 'Advance this responsibility in a useful way.'}`,
    row.last_outcome
      ? `What you did last time and how it went:\n${truncate(row.last_outcome, 1800)}`
      : 'You have not run this responsibility yet.',
    'Decide the single most useful next step that moves this forward, do it now with your tools, and finish with a short outcome report.',
    'Do not ask the owner questions. If something blocks you, work around it or report the blocker plainly.',
  ].join('\n\n');
}

/**
 * Run one responsibility now: plan a task from the standing objective plus the
 * previous outcome, execute it, and store the outcome for the next run.
 */
export async function runResponsibility(
  responsibilityId: string,
  options: { force?: boolean } = {},
): Promise<{ taskId: string; outcome: string } | null> {
  if (running.has(responsibilityId)) return null;
  const row = await getResponsibility(responsibilityId);
  if (!row) return null;
  if (!options.force && row.status !== 'active') return null;

  running.add(responsibilityId);
  const started = now();
  try {
    // Reserve the slot before doing the work, so a second tick cannot start it.
    await run(
      'UPDATE responsibilities SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
      started,
      started + row.cadence_minutes * 60_000,
      started,
      responsibilityId,
    );
    broadcast('tasks', { responsibilityId, status: 'running' });

    const task = await createTask({
      title: `Responsibility: ${row.title}`,
      objective: objectiveFor(row),
      projectId: row.project_id,
      origin: 'responsibility',
    });
    await run('UPDATE responsibilities SET last_task_id = ? WHERE id = ?', task.id, responsibilityId);

    await executeTask(task.id);

    const finished = await getTask(task.id);
    const outcome = truncate(
      (finished?.result || finished?.error || 'No outcome was recorded.').trim(),
      2000,
    );
    await run(
      'UPDATE responsibilities SET last_outcome = ?, run_count = run_count + 1, updated_at = ? WHERE id = ?',
      outcome,
      now(),
      responsibilityId,
    );
    await createDeliverable({
      title: `${row.title} · run ${row.run_count + 1}`,
      body: outcome,
      taskId: task.id,
      responsibilityId,
      silent: true,
    });
    notify({
      title: `${row.title}: progress`,
      body: truncate(outcome, 240),
      level: finished?.status === 'done' ? 'success' : 'warn',
      link: '/projects',
    });
    logActivity({
      level: 'info',
      category: 'responsibility',
      message: `Ran responsibility "${row.title}".`,
      meta: { responsibilityId, taskId: task.id },
    });
    broadcast('tasks', { responsibilityId, status: 'idle' });
    return { taskId: task.id, outcome };
  } finally {
    running.delete(responsibilityId);
  }
}

/** Run the due responsibilities, one at a time, so the scheduler stays serial. */
export async function runDueResponsibilities(limit = 1): Promise<number> {
  const due = await all<{ id: string }>(
    `SELECT id FROM responsibilities
     WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
     ORDER BY next_run_at ASC LIMIT ?`,
    now(),
    limit,
  );
  let ran = 0;
  for (const row of due) {
    if (running.has(row.id)) continue;
    await runResponsibility(row.id);
    ran += 1;
  }
  return ran;
}
