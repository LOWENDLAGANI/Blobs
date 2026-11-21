import { useCallback, useEffect, useState } from 'react';
import { api, del, patch, post, timeAgo } from '../api.ts';
import { useLive } from '../live.ts';
import { Badge, Button, Card, Empty, Field, Icon, Input, PageHeader, Select, Toggle, useToast } from '../ui.tsx';
import type { WatchItem } from '../types.ts';

const CADENCES = [
  { value: 60, label: 'Hourly' },
  { value: 360, label: 'Every 6 hours' },
  { value: 720, label: 'Every 12 hours' },
  { value: 1440, label: 'Daily' },
];

function cadenceLabel(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? 'Daily' : `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'Hourly' : `Every ${minutes / 60} hours`;
  return `Every ${minutes} min`;
}

/**
 * Watches are the proactive half of the agent: standing checks that only speak
 * up when something actually changes.
 */
export function WatchesPage() {
  const toast = useToast();
  const [items, setItems] = useState<WatchItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [kind, setKind] = useState<'url' | 'rss' | 'search'>('url');
  const [target, setTarget] = useState('');
  const [label, setLabel] = useState('');
  const [cadence, setCadence] = useState(360);
  const [notifyOnChange, setNotifyOnChange] = useState(true);
  const [createTask, setCreateTask] = useState(true);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: WatchItem[] }>('/api/watches')).items);
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useLive(['watches', 'notification'], () => void load());

  const create = async (): Promise<void> => {
    if (!target.trim()) return toast('Give the watch a URL, feed or query.', 'bad');
    setBusy('create');
    try {
      await post('/api/watches', {
        kind,
        target: target.trim(),
        label: label.trim(),
        cadence_minutes: cadence,
        notify: notifyOnChange,
        create_task: createTask,
      });
      toast('Watch added. The first check records a baseline.', 'good');
      setCreating(false);
      setTarget('');
      setLabel('');
      await load();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (watch: WatchItem): Promise<void> => {
    setBusy(watch.id);
    try {
      const result = await post<{ baseline: boolean; changed: boolean; summary: string }>(
        `/api/watches/${watch.id}/run`,
      );
      toast(result.baseline ? 'Baseline captured.' : result.changed ? 'Changed — you will see it below.' : 'No change.', 'info');
      await load();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (watch: WatchItem): Promise<void> => {
    await patch(`/api/watches/${watch.id}`, { status: watch.status === 'active' ? 'paused' : 'active' }).catch(
      (error: Error) => toast(error.message, 'bad'),
    );
    await load();
  };

  const remove = async (watch: WatchItem): Promise<void> => {
    await del(`/api/watches/${watch.id}`).catch(() => undefined);
    toast('Watch dropped.', 'info');
    await load();
  };

  return (
    <>
      <PageHeader
        title="Watches"
        subtitle="Standing checks on a page, feed or search. BLOBS stays quiet until something changes, then it tells you and — if you let it — looks into why."
      />

      <div className="row" style={{ gap: 8, marginBottom: 16 }}>
        <Button onClick={() => setCreating((open) => !open)}>
          <Icon name="plus" size={16} /> New watch
        </Button>
      </div>

      {creating && (
        <Card className="stack">
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <Field label="What to check">
              <Select value={kind} onChange={(event) => setKind(event.target.value as 'url' | 'rss' | 'search')}>
                <option value="url">A web page</option>
                <option value="rss">An RSS or Atom feed</option>
                <option value="search">A search query</option>
              </Select>
            </Field>
            <Field label="Cadence">
              <Select value={String(cadence)} onChange={(event) => setCadence(Number(event.target.value))}>
                {CADENCES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label={kind === 'search' ? 'Query' : 'URL'}
            hint={kind === 'rss' ? 'The feed URL, for example https://example.com/feed.xml' : undefined}
          >
            <Input
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={kind === 'search' ? 'e.g. "GPT-6 release notes"' : 'https://…'}
            />
          </Field>
          <Field label="Name" hint="How it appears in notifications. Optional.">
            <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Competitor pricing page" />
          </Field>
          <Toggle checked={notifyOnChange} onChange={setNotifyOnChange} label="Notify me when it changes" />
          <Toggle
            checked={createTask}
            onChange={setCreateTask}
            label="Investigate changes automatically"
            hint="Queues a task that works out what changed and whether it matters."
          />
          <div className="row" style={{ gap: 8 }}>
            <Button busy={busy === 'create'} onClick={() => void create()}>
              Add watch
            </Button>
            <Button variant="quiet" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {items.length === 0 ? (
        <Card>
          <Empty
            icon="pulse"
            title="Nothing watched yet"
            body="Add a page, a feed or a search. BLOBS will check it on your cadence and only interrupt you when the content actually changes."
          />
        </Card>
      ) : (
        <div className="stack">
          {items.map((watch) => (
            <Card key={watch.id} className="stack">
              <div className="row-between">
                <div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <h3>{watch.label || watch.target}</h3>
                    <Badge tone={watch.status === 'active' ? 'good' : 'neutral'}>{watch.status}</Badge>
                    <Badge tone="info">{watch.kind}</Badge>
                    <Badge tone="neutral">{cadenceLabel(watch.cadence_minutes)}</Badge>
                  </div>
                  <p className="muted tiny" style={{ wordBreak: 'break-all' }}>
                    {watch.target}
                  </p>
                  <p className="muted tiny">
                    Checked {watch.last_checked_at ? timeAgo(watch.last_checked_at) : 'never'}
                    {watch.last_change_at ? ` · changed ${timeAgo(watch.last_change_at)}` : ' · no change yet'}
                  </p>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <Button size="sm" variant="outline" busy={busy === watch.id} onClick={() => void runNow(watch)}>
                    Check now
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => void toggle(watch)}>
                    {watch.status === 'active' ? 'Pause' : 'Resume'}
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => void remove(watch)} title="Drop watch">
                    <Icon name="trash" size={14} />
                  </Button>
                </div>
              </div>
              {watch.last_summary && (
                <pre className="code-block" style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>
                  {watch.last_summary}
                </pre>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
