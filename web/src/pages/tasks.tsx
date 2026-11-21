import { useCallback, useEffect, useState } from 'react';
import { api, del, post, timeAgo } from '../api.ts';
import { useLive } from '../live.ts';
import { Badge, Button, Card, Empty, Field, Icon, Input, Modal, PageHeader, Select, TextArea, useToast } from '../ui.tsx';
import type { Project, Task, TaskStep } from '../types.ts';

const STATUS_TONE: Record<Task['status'], 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = {
  queued: 'neutral',
  running: 'info',
  waiting_approval: 'warn',
  paused: 'warn',
  done: 'good',
  failed: 'bad',
  cancelled: 'neutral',
};

const FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'done', label: 'Done' },
  { key: 'failed', label: 'Failed' },
];

function scheduleLabel(raw: string | null): string {
  if (!raw) return 'Once';
  try {
    const parsed = JSON.parse(raw) as { type: string; minutes?: number; at?: string; days?: number[] };
    if (parsed.type === 'interval' && parsed.minutes) {
      if (parsed.minutes === 1440) return 'Daily';
      if (parsed.minutes === 60) return 'Hourly';
      if (parsed.minutes % 60 === 0) return `Every ${parsed.minutes / 60}h`;
      return `Every ${parsed.minutes}m`;
    }
    if (parsed.type === 'clock' && parsed.at) {
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dayLabel = parsed.days?.length
        ? `${parsed.days.map((day) => names[day] ?? '').filter(Boolean).join(', ')} `
        : 'Daily ';
      return `${dayLabel}${parsed.at}`;
    }
  } catch {
    /* fall through */
  }
  return 'Once';
}

export function TasksPage({ go }: { go: (route: 'projects') => void }) {
  const toast = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState('all');
  const [creating, setCreating] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [detail, setDetail] = useState<{ task: Task; steps: TaskStep[] } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await api<Task[]>(`/api/tasks${filter === 'all' ? '' : `?status=${filter}`}`);
      setTasks(rows);
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  }, [filter, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api<Project[]>('/api/projects').then(setProjects).catch(() => undefined);
  }, []);

  useLive(['tasks'], () => void load());

  const action = async (id: string, verb: string): Promise<void> => {
    setBusy(`${id}:${verb}`);
    try {
      await post(`/api/tasks/${id}/${verb}`);
      toast(`Task ${verb === 'run' ? 'started' : verb}.`, 'good');
      await load();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const openDetail = async (id: string): Promise<void> => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    try {
      const data = await api<{ task: Task; steps: TaskStep[] }>(`/api/tasks/${id}`);
      setDetail(data);
    } catch {
      /* ignore */
    }
  };

  const remove = async (id: string): Promise<void> => {
    await del(`/api/tasks/${id}`).catch(() => undefined);
    await load();
  };

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle="Real work that keeps running on the server, even when this tab is closed. Progress is checkpointed so nothing restarts from zero."
        actions={
          <>
            <Button variant="outline" onClick={() => go('projects')}>
              <Icon name="projects" size={16} /> Projects
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Icon name="plus" size={16} /> New task
            </Button>
          </>
        }
      />

      <div className="tabs">
        {FILTERS.map((item) => (
          <button key={item.key} className={`tab${filter === item.key ? ' active' : ''}`} onClick={() => setFilter(item.key)}>
            {item.label}
          </button>
        ))}
      </div>

      {tasks.length === 0 ? (
        <Card>
          <Empty
            icon="tasks"
            title="No tasks here yet"
            body="Ask BLOBS to do something in the console and it will queue the work here, or create one directly."
            action={<Button onClick={() => setCreating(true)}>Create a task</Button>}
          />
        </Card>
      ) : (
        <div className="stack">
          {tasks.map((task) => {
            const progress = task.step_total ? Math.round((task.step_done / task.step_total) * 100) : 0;
            const project = projects.find((item) => item.id === task.project_id);
            const isOpen = expanded === task.id;
            return (
              <Card key={task.id} className="task-card">
                <div className="task-head">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <Badge tone={STATUS_TONE[task.status]}>{task.status.replace(/_/g, ' ')}</Badge>
                      <Badge>{scheduleLabel(task.schedule)}</Badge>
                      {project && <Badge tone="info">{project.title}</Badge>}
                      {task.origin === 'agent' && <Badge>self-initiated</Badge>}
                      <span className="muted tiny">{timeAgo(task.updated_at)}</span>
                    </div>
                    <h3 style={{ marginTop: 8 }}>{task.title}</h3>
                    <p className="task-objective">{task.objective}</p>
                    {task.step_total > 0 && (
                      <>
                        <div className="progress">
                          <span style={{ width: `${progress}%` }} />
                        </div>
                        <p className="muted tiny" style={{ marginTop: 4 }}>
                          {task.step_done} of {task.step_total} steps · attempt {task.attempts}/{task.max_attempts}
                          {task.next_run_at && task.status === 'queued' ? ` · next run ${new Date(task.next_run_at).toLocaleString()}` : ''}
                        </p>
                      </>
                    )}
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    {(task.status === 'queued' || task.status === 'paused' || task.status === 'failed') && (
                      <Button size="sm" variant="outline" busy={busy === `${task.id}:run`} onClick={() => void action(task.id, 'run')}>
                        <Icon name="play" size={13} /> Run
                      </Button>
                    )}
                    {task.status === 'running' && (
                      <Button size="sm" variant="outline" onClick={() => void action(task.id, 'pause')}>
                        <Icon name="pause" size={13} /> Pause
                      </Button>
                    )}
                    {task.status === 'paused' && (
                      <Button size="sm" variant="outline" onClick={() => void action(task.id, 'resume')}>
                        Resume
                      </Button>
                    )}
                    {task.status === 'failed' && (
                      <Button size="sm" variant="outline" onClick={() => void action(task.id, 'retry')}>
                        Retry
                      </Button>
                    )}
                    <button className="icon-btn" onClick={() => void openDetail(task.id)} aria-label="Details">
                      <Icon name={isOpen ? 'chevron' : 'tasks'} size={16} />
                    </button>
                    <button className="icon-btn" onClick={() => void action(task.id, 'cancel')} aria-label="Cancel">
                      <Icon name="stop" size={15} />
                    </button>
                  </div>
                </div>

                {task.error && <p className="note bad" style={{ marginTop: 12 }}>{task.error}</p>}

                {isOpen && detail?.task.id === task.id && (
                  <div className="steps">
                    {detail.steps.map((step) => (
                      <div key={step.id} className="step">
                        <span className={`step-dot ${step.status}`}>
                          {step.status === 'done' ? '✓' : step.status === 'failed' ? '✕' : ''}
                        </span>
                        <div style={{ flex: 1 }}>
                          <span>{step.description}</span>
                          {step.output && <pre>{step.output}</pre>}
                        </div>
                      </div>
                    ))}
                    {detail.steps.length === 0 && <p className="muted small">The plan appears once the task starts.</p>}
                    {task.result && (
                      <div style={{ marginTop: 10 }}>
                        <p className="log-cat">Outcome</p>
                        <p className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{task.result}</p>
                      </div>
                    )}
                  </div>
                )}

                {!isOpen && task.result && (
                  <p className="muted small" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
                    {task.result.slice(0, 260)}
                    {task.result.length > 260 ? '…' : ''}
                  </p>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {creating && (
        <CreateTask
          projects={projects}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await load();
          }}
        />
      )}
    </>
  );
}

function CreateTask({
  projects,
  onClose,
  onCreated,
}: {
  projects: Project[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [projectId, setProjectId] = useState('');
  const [schedule, setSchedule] = useState('once');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!objective.trim()) return toast('Describe what BLOBS should achieve.', 'bad');
    setBusy(true);
    try {
      await post('/api/tasks', { title: title || objective.slice(0, 70), objective, projectId: projectId || null, schedule });
      toast('Task queued. BLOBS will start shortly.', 'good');
      await onCreated();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New task" onClose={onClose}>
      <Field label="Title" hint="Optional — a short name for the list.">
        <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Weekly market scan" />
      </Field>
      <Field label="Objective" hint="Be specific. BLOBS plans the steps, uses tools and reports back.">
        <TextArea
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          placeholder="Research three competitors, summarise their pricing into a note, and remember the key differences."
        />
      </Field>
      <Field label="Project">
        <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">No project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Schedule" hint="Clock times use your timezone from Settings.">
        <Select value={schedule} onChange={(event) => setSchedule(event.target.value)}>
          <option value="once">Run once</option>
          <option value="hourly">Every hour</option>
          <option value="every:6h">Every 6 hours</option>
          <option value="every:30m">Every 30 minutes</option>
          <option value="daily">Daily</option>
          <option value="09:00">Daily at 09:00</option>
          <option value="weekdays 09:00">Weekdays at 09:00</option>
        </Select>
      </Field>
      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button busy={busy} onClick={() => void submit()}>
          Queue task
        </Button>
      </div>
    </Modal>
  );
}
