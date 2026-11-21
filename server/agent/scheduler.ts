import { all, get, run } from '../db.ts';
import { getSettings } from '../settings.ts';
import { logActivity, notify } from '../activity.ts';
import { complete } from '../llm/index.ts';
import { now, truncate } from '../util.ts';
import { executeTask, isTaskRunning } from './tasks.ts';

const TICK_MS = 8_000;
const STALE_HEARTBEAT_MS = 120_000;
const PROACTIVE_INTERVAL_MS = 60 * 60_000;

let timer: NodeJS.Timeout | null = null;
let ticking = false;
let lastProactive = 0;
let lastCleanup = 0;

/** Requeue tasks whose process died mid-run instead of restarting them from zero. */
export async function recoverInterruptedTasks(): Promise<number> {
  const stale = await all<{ id: string; title: string; attempts: number; max_attempts: number }>(
    `SELECT id, title, attempts, max_attempts FROM tasks
     WHERE status = 'running' AND (heartbeat IS NULL OR heartbeat < ?)`,
    now() - STALE_HEARTBEAT_MS,
  );
  for (const task of stale) {
    if (task.attempts >= task.max_attempts) {
      await run(
        `UPDATE tasks SET status = 'failed', error = ?, heartbeat = NULL, completed_at = ?, updated_at = ? WHERE id = ?`,
        'Interrupted too many times; needs a manual retry.',
        now(),
        now(),
        task.id,
      );
      logActivity({ level: 'error', category: 'task', message: `"${task.title}" was interrupted repeatedly and stopped.`, taskId: task.id });
    } else {
      await run(
        `UPDATE tasks SET status = 'queued', heartbeat = NULL, next_run_at = ?, updated_at = ? WHERE id = ?`,
        now(),
        now(),
        task.id,
      );
      logActivity({
        level: 'warn',
        category: 'task',
        message: `Resuming "${task.title}" after an interruption, from its last checkpoint.`,
        taskId: task.id,
      });
    }
  }
  return stale.length;
}

async function cleanup(): Promise<void> {
  const ts = now();
  await run('DELETE FROM sessions WHERE expires_at < ?', ts);
  await run("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND created_at < ?", ts - 14 * 86_400_000);
  const retention = getSettings().memory.retentionDays;
  if (retention > 0) {
    await run(
      "DELETE FROM memories WHERE pinned = 0 AND created_at < ? AND kind NOT IN ('preference','decision')",
      ts - retention * 86_400_000,
    );
  }
  await run('DELETE FROM activity WHERE ts < ?', ts - 120 * 86_400_000);
}

async function proactiveCheck(): Promise<void> {
  const settings = getSettings();
  if (!settings.autonomy.proactiveCheckIns || settings.autonomy.level === 'manual') return;
  if (now() - lastProactive < PROACTIVE_INTERVAL_MS) return;
  lastProactive = now();

  const openTasks = await all<{ title: string; status: string }>(
    "SELECT title, status FROM tasks WHERE status IN ('queued','running','waiting_approval','paused') LIMIT 8",
  );
  const projects = await all<{ title: string; objective: string }>(
    "SELECT title, objective FROM projects WHERE status = 'active' LIMIT 6",
  );
  if (!projects.length && !openTasks.length) return;

  try {
    const suggestion = await complete(
      `You are BLOBS checking in on your owner's work. Look at their open projects and tasks and decide whether there is ONE genuinely useful proactive action worth doing or suggesting now. Be conservative: only suggest something concrete and useful. Reply with one short sentence, or exactly "NONE".`,
      `Open projects:\n${projects.map((p) => `- ${p.title}: ${p.objective}`).join('\n') || 'none'}\n\nOpen tasks:\n${
        openTasks.map((t) => `- [${t.status}] ${t.title}`).join('\n') || 'none'
      }`,
      { maxTokens: 180, temperature: 0.5, kind: 'proactive' },
    );
    const text = suggestion.trim();
    if (!text || /^none$/i.test(text)) return;
    notify({ title: 'BLOBS has an idea', body: truncate(text, 240), level: 'info', link: '/activity' });
    logActivity({ level: 'info', category: 'autonomy', message: `Proactive suggestion: ${truncate(text, 240)}` });
  } catch {
    /* proactive checks are best-effort and must never spam errors */
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const settings = getSettings();
    if (now() - lastCleanup > 6 * 3_600_000) {
      lastCleanup = now();
      await cleanup();
    }
    if (!settings.autonomy.backgroundEnabled || settings.autonomy.state !== 'active') return;

    const due = await all<{ id: string }>(
      `SELECT id FROM tasks
       WHERE status = 'queued' AND (next_run_at IS NULL OR next_run_at <= ?)
       ORDER BY created_at ASC LIMIT 2`,
      now(),
    );
    for (const row of due) {
      if (isTaskRunning(row.id)) continue;
      await executeTask(row.id);
    }

    await proactiveCheck();
  } catch (error) {
    logActivity({ level: 'error', category: 'scheduler', message: `Scheduler error: ${(error as Error).message}` });
  } finally {
    ticking = false;
  }
}

export async function startScheduler(): Promise<void> {
  if (timer) return;
  const recovered = await recoverInterruptedTasks();
  logActivity({
    level: 'info',
    category: 'system',
    message: `Background worker started${recovered ? `, resumed ${recovered} interrupted task(s)` : ''}.`,
  });
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  timer.unref?.();
  void tick();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function schedulerState(): Promise<Record<string, unknown>> {
  const [next, queued] = await Promise.all([
    get<{ next_run_at: number | null }>("SELECT MIN(next_run_at) AS next_run_at FROM tasks WHERE status = 'queued'"),
    get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status = 'queued'"),
  ]);
  return {
    running: timer !== null,
    tickMs: TICK_MS,
    queued: queued?.n ?? 0,
    nextRunAt: next?.next_run_at ?? null,
  };
}
