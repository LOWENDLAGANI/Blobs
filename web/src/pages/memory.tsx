import { useCallback, useEffect, useState } from 'react';
import { api, del, patch, post, timeAgo } from '../api.ts';
import { useLive } from '../live.ts';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Icon,
  Input,
  Modal,
  PageHeader,
  Range,
  Select,
  TextArea,
  useToast,
} from '../ui.tsx';
import type { MemoryItem } from '../types.ts';

const KINDS = ['fact', 'preference', 'project', 'decision', 'lesson', 'person', 'summary', 'note'];

export function MemoryPage() {
  const toast = useToast();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [stats, setStats] = useState<{ total: number; byKind: Record<string, number> }>({ total: 0, byKind: {} });
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [editing, setEditing] = useState<MemoryItem | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('query', query.trim());
      if (kind !== 'all') params.set('kind', kind);
      const data = await api<{ items: MemoryItem[]; stats: { total: number; byKind: Record<string, number> } }>(
        `/api/memory?${params.toString()}`,
      );
      setItems(data.items);
      setStats(data.stats);
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  }, [query, kind, toast]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 220);
    return () => window.clearTimeout(timer);
  }, [load]);

  useLive(['activity'], () => void load());

  const togglePin = async (item: MemoryItem): Promise<void> => {
    await patch(`/api/memory/${item.id}`, { pinned: item.pinned !== 1 }).catch(() => undefined);
    await load();
  };

  const remove = async (item: MemoryItem): Promise<void> => {
    await del(`/api/memory/${item.id}`).catch(() => undefined);
    toast('Memory deleted.', 'info');
    await load();
  };

  return (
    <>
      <PageHeader
        title="Memory"
        subtitle="What BLOBS carries between sessions and across model changes. Retrieval is relevance-based, so old detail does not crowd out what matters now."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Icon name="plus" size={16} /> Add memory
          </Button>
        }
      />

      <div className="row" style={{ marginBottom: 16, gap: 10 }}>
        <div style={{ flex: 1, minWidth: 220, position: 'relative' }}>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search memories…"
            style={{ paddingLeft: 34 }}
          />
          <span style={{ position: 'absolute', left: 11, top: 10, color: 'var(--muted)' }}>
            <Icon name="search" size={16} />
          </span>
        </div>
        <Select value={kind} onChange={(event) => setKind(event.target.value)} style={{ width: 160 }}>
          <option value="all">All kinds</option>
          {KINDS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </div>

      <div className="row" style={{ gap: 8, marginBottom: 18 }}>
        <Badge tone="info">{stats.total} memories</Badge>
        {Object.entries(stats.byKind).map(([name, count]) => (
          <Badge key={name}>
            {name}: {count}
          </Badge>
        ))}
      </div>

      {items.length === 0 ? (
        <Card>
          <Empty
            icon="brain"
            title={query ? 'Nothing matches that search' : 'Memory is empty'}
            body={
              query
                ? 'Try a broader phrase. BLOBS also stores summaries of longer conversations.'
                : 'Talk to BLOBS and it will start storing preferences, decisions and project context — or add a memory by hand.'
            }
          />
        </Card>
      ) : (
        <div className="stack">
          {items.map((item) => (
            <Card key={item.id} padded={false}>
              <div className="memory-card">
                <span className="avatar-lg" style={{ width: 34, height: 34, borderRadius: 10 }}>
                  <Icon name={item.kind === 'preference' ? 'bolt' : item.kind === 'project' ? 'projects' : 'brain'} size={16} />
                </span>
                <div className="memory-body">
                  <p>{item.content}</p>
                  <div className="memory-meta">
                    <Badge tone={item.pinned ? 'info' : 'neutral'}>{item.kind}</Badge>
                    <span className="muted tiny">importance {item.importance}/5</span>
                    {item.tags && <span className="muted tiny">#{item.tags.split(' ').join(' #')}</span>}
                    <span className="muted tiny">{timeAgo(item.updated_at)}</span>
                    {item.use_count > 0 && <span className="muted tiny">recalled {item.use_count}×</span>}
                  </div>
                </div>
                <div className="icon-actions">
                  <button className={`icon-btn${item.pinned ? ' pin-on' : ''}`} onClick={() => void togglePin(item)} aria-label="Pin">
                    <Icon name="pin" size={15} />
                  </button>
                  <button className="icon-btn" onClick={() => setEditing(item)} aria-label="Edit">
                    <Icon name="gear" size={15} />
                  </button>
                  <button className="icon-btn" onClick={() => void remove(item)} aria-label="Delete">
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <MemoryEditor
          item={editing === 'new' ? null : editing}
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

function MemoryEditor({
  item,
  onClose,
  onSaved,
}: {
  item: MemoryItem | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [content, setContent] = useState(item?.content ?? '');
  const [kind, setKind] = useState(item?.kind ?? 'fact');
  const [tags, setTags] = useState(item?.tags ?? '');
  const [importance, setImportance] = useState(item?.importance ?? 3);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    if (!content.trim()) return toast('Write what should be remembered.', 'bad');
    setBusy(true);
    try {
      const body = {
        content,
        kind,
        tags: tags.split(/[,\s]+/).filter(Boolean),
        importance,
      };
      if (item) await patch(`/api/memory/${item.id}`, body);
      else await post('/api/memory', body);
      await onSaved();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={item ? 'Edit memory' : 'Add memory'} onClose={onClose}>
      <Field label="What should BLOBS remember?">
        <TextArea value={content} onChange={(event) => setContent(event.target.value)} rows={5} autoFocus />
      </Field>
      <Field label="Kind">
        <Select value={kind} onChange={(event) => setKind(event.target.value)}>
          {KINDS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Tags" hint="Space or comma separated, used for retrieval.">
        <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="work pricing" />
      </Field>
      <Range label="Importance" value={importance} min={1} max={5} step={1} onChange={setImportance} format={(value) => `${value}/5`} />
      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button busy={busy} onClick={() => void save()}>
          Save memory
        </Button>
      </div>
    </Modal>
  );
}
