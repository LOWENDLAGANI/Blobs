import { useCallback, useEffect, useState } from 'react';
import { api, del, patch, post, timeAgo } from '../api.ts';
import { useLive } from '../live.ts';
import { Badge, Button, Card, Empty, Field, Icon, Input, Modal, PageHeader, Select, TextArea, useToast } from '../ui.tsx';
import type { Project, Task } from '../types.ts';

export function ProjectsPage() {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [editing, setEditing] = useState<Project | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      const [projectRows, taskRows] = await Promise.all([
        api<Project[]>('/api/projects'),
        api<Task[]>('/api/tasks'),
      ]);
      setProjects(projectRows);
      setTasks(taskRows);
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useLive(['tasks', 'activity'], () => void load());

  const setStatus = async (project: Project, status: 'active' | 'paused' | 'done'): Promise<void> => {
    await patch(`/api/projects/${project.id}`, { status }).catch(() => undefined);
    await load();
  };

  const remove = async (project: Project): Promise<void> => {
    await del(`/api/projects/${project.id}`).catch(() => undefined);
    toast('Project removed. Its tasks were kept.', 'info');
    await load();
  };

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Long-term objectives that give BLOBS continuity — notes, decisions and every task that belongs to them."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Icon name="plus" size={16} /> New project
          </Button>
        }
      />

      {projects.length === 0 ? (
        <Card>
          <Empty
            icon="projects"
            title="No projects yet"
            body="Group related work into a project so BLOBS can keep context and check in on progress."
            action={<Button onClick={() => setEditing('new')}>Create a project</Button>}
          />
        </Card>
      ) : (
        <div className="grid-2">
          {projects.map((project) => {
            const linked = tasks.filter((task) => task.project_id === project.id);
            const open = linked.filter((task) => ['queued', 'running', 'waiting_approval', 'paused'].includes(task.status));
            return (
              <Card key={project.id} className="stack" padded>
                <div className="row-between">
                  <div className="row" style={{ gap: 8 }}>
                    <Badge tone={project.status === 'done' ? 'good' : project.status === 'paused' ? 'warn' : 'info'}>
                      {project.status}
                    </Badge>
                    <span className="muted tiny">updated {timeAgo(project.updated_at)}</span>
                  </div>
                  <div className="row" style={{ gap: 2 }}>
                    <button className="icon-btn" onClick={() => setEditing(project)} aria-label="Edit project">
                      <Icon name="gear" size={16} />
                    </button>
                    <button className="icon-btn" onClick={() => void remove(project)} aria-label="Delete project">
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </div>

                <div>
                  <h2>{project.title}</h2>
                  <p className="small muted" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
                    {project.objective || 'No objective written yet.'}
                  </p>
                </div>

                {project.notes && (
                  <div className="note" style={{ maxHeight: 130, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                    {project.notes}
                  </div>
                )}

                <div className="row" style={{ gap: 8 }}>
                  <Badge>{linked.length} tasks</Badge>
                  <Badge tone={open.length ? 'warn' : 'good'}>{open.length} open</Badge>
                </div>

                {linked.length > 0 && (
                  <div className="steps" style={{ marginTop: 0 }}>
                    {linked.slice(0, 4).map((task) => (
                      <div key={task.id} className="step">
                        <span className={`step-dot ${task.status === 'done' ? 'done' : task.status === 'failed' ? 'failed' : ''}`} />
                        <span style={{ flex: 1 }}>{task.title}</span>
                        <span className="muted tiny">{task.status.replace(/_/g, ' ')}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="row" style={{ gap: 6, marginTop: 4 }}>
                  {project.status !== 'done' && (
                    <Button size="sm" variant="outline" onClick={() => void setStatus(project, 'done')}>
                      Mark done
                    </Button>
                  )}
                  {project.status === 'active' && (
                    <Button size="sm" variant="quiet" onClick={() => void setStatus(project, 'paused')}>
                      Pause
                    </Button>
                  )}
                  {project.status === 'paused' && (
                    <Button size="sm" variant="quiet" onClick={() => void setStatus(project, 'active')}>
                      Reactivate
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {editing && (
        <ProjectEditor
          project={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </>
  );
}

function ProjectEditor({
  project,
  onClose,
  onSaved,
}: {
  project: Project | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(project?.title ?? '');
  const [objective, setObjective] = useState(project?.objective ?? '');
  const [notes, setNotes] = useState(project?.notes ?? '');
  const [status, setStatus] = useState(project?.status ?? 'active');
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    if (!title.trim()) return toast('Give the project a title.', 'bad');
    setBusy(true);
    try {
      if (project) await patch(`/api/projects/${project.id}`, { title, objective, notes, status });
      else await post('/api/projects', { title, objective, notes });
      await onSaved();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={project ? 'Edit project' : 'New project'} onClose={onClose} wide>
      <Field label="Title">
        <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Get fit by summer" autoFocus />
      </Field>
      <Field label="Objective" hint="What does done look like? BLOBS uses this when planning.">
        <TextArea value={objective} onChange={(event) => setObjective(event.target.value)} rows={3} />
      </Field>
      <Field label="Notes" hint="Markdown is fine. Decisions and research summaries belong here.">
        <TextArea value={notes} onChange={(event) => setNotes(event.target.value)} rows={7} />
      </Field>
      {project && (
        <Field label="Status">
          <Select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="done">Done</option>
          </Select>
        </Field>
      )}
      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button busy={busy} onClick={() => void save()}>
          {project ? 'Save changes' : 'Create project'}
        </Button>
      </div>
    </Modal>
  );
}
