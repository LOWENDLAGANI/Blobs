import { all, get, run } from '../db.ts';
import { id, now, truncate } from '../util.ts';
import { logActivity } from '../activity.ts';

export interface ProjectRow {
  id: string;
  title: string;
  objective: string;
  status: 'active' | 'paused' | 'done';
  notes: string;
  created_at: number;
  updated_at: number;
}

export async function createProject(input: { title: string; objective?: string; notes?: string }): Promise<ProjectRow> {
  const ts = now();
  const row: ProjectRow = {
    id: id('prj'),
    title: input.title.trim() || 'Untitled project',
    objective: (input.objective ?? '').trim(),
    status: 'active',
    notes: (input.notes ?? '').trim(),
    created_at: ts,
    updated_at: ts,
  };
  await run(
    `INSERT INTO projects(id, title, objective, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.title,
    row.objective,
    row.status,
    row.notes,
    row.created_at,
    row.updated_at,
  );
  logActivity({ level: 'info', category: 'project', message: `Created project "${row.title}".`, meta: { projectId: row.id } });
  return row;
}

export async function listProjects(): Promise<(ProjectRow & { task_count: number; open_tasks: number })[]> {
  return all<ProjectRow & { task_count: number; open_tasks: number }>(
    `SELECT p.*,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status IN ('queued','running','waiting_approval','paused')) AS open_tasks
     FROM projects p ORDER BY
       CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
       p.updated_at DESC`,
  );
}

export async function getProject(projectId: string): Promise<ProjectRow | null> {
  return get<ProjectRow>('SELECT * FROM projects WHERE id = ?', projectId);
}

export async function updateProject(
  projectId: string,
  patch: { title?: string; objective?: string; status?: 'active' | 'paused' | 'done'; notesAppend?: string; notes?: string },
): Promise<ProjectRow | null> {
  const existing = await getProject(projectId);
  if (!existing) return null;
  const notes =
    patch.notes !== undefined
      ? patch.notes
      : patch.notesAppend
        ? `${existing.notes}\n\n${new Date().toISOString().slice(0, 10)} — ${patch.notesAppend}`.trim()
        : existing.notes;
  await run(
    'UPDATE projects SET title = ?, objective = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?',
    patch.title ?? existing.title,
    patch.objective ?? existing.objective,
    patch.status ?? existing.status,
    truncate(notes, 40_000),
    now(),
    projectId,
  );
  return getProject(projectId);
}

export async function deleteProject(projectId: string): Promise<boolean> {
  if (!(await getProject(projectId))) return false;
  await run('DELETE FROM projects WHERE id = ?', projectId);
  return true;
}
