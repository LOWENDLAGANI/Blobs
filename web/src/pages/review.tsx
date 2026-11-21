import { useCallback, useEffect, useState } from 'react';
import { api, del, post, timeAgo } from '../api.ts';
import { useLive } from '../live.ts';
import { Badge, Button, Card, Empty, Icon, PageHeader, useToast } from '../ui.tsx';
import type { Deliverable } from '../types.ts';

/**
 * Review packets: where the autonomous loop leaves finished work. Reading is
 * the default; publishing is a deliberate click that creates an unguessable,
 * expiring link.
 */
export function ReviewPage() {
  const toast = useToast();
  const [items, setItems] = useState<Deliverable[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ items: Deliverable[] }>('/api/deliverables');
      setItems(data.items);
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useLive(['tasks', 'activity'], () => void load());

  const publish = async (item: Deliverable): Promise<void> => {
    try {
      const result = await post<{ url: string }>(`/api/deliverables/${item.id}/publish`, { hours: 168 });
      const absolute = `${window.location.origin}${result.url}`;
      try {
        await navigator.clipboard.writeText(absolute);
        toast('Public link ready for 7 days — copied to your clipboard.', 'good');
      } catch {
        toast(`Public link ready for 7 days: ${absolute}`, 'info');
      }
      await load();
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  };

  const unpublish = async (item: Deliverable): Promise<void> => {
    await del(`/api/deliverables/${item.id}/publish`).catch(() => undefined);
    toast('Public link revoked.', 'info');
    await load();
  };

  const remove = async (item: Deliverable): Promise<void> => {
    await del(`/api/deliverables/${item.id}`).catch(() => undefined);
    await load();
  };

  return (
    <>
      <PageHeader
        title="Review"
        subtitle="Finished work the agent put down for you: reports, drafts, plans and summaries. Publish one when you want a private link that expires."
      />

      {items.length === 0 ? (
        <Card>
          <Empty
            icon="check"
            title="No packets yet"
            body="When BLOBS finishes something substantial — or completes a responsibility run — it delivers a review packet here."
          />
        </Card>
      ) : (
        <div className="stack">
          {items.map((item) => {
            const published = Boolean(item.public_token) && (item.public_expires_at ?? 0) > Date.now();
            return (
              <Card key={item.id} className="stack">
                <div className="row-between">
                  <div>
                    <div className="row" style={{ gap: 8 }}>
                      <h3>{item.title}</h3>
                      <Badge tone="neutral">{item.kind}</Badge>
                      {published && <Badge tone="good">public link</Badge>}
                    </div>
                    <p className="muted tiny">
                      {timeAgo(item.created_at)} · {item.body.length.toLocaleString()} characters
                    </p>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setOpenId(openId === item.id ? null : item.id)}
                    >
                      {openId === item.id ? 'Hide' : 'Read'}
                    </Button>
                    {published ? (
                      <>
                        <a
                          className="btn btn-outline btn-sm"
                          href={`/d/${item.public_token}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open link
                        </a>
                        <Button size="sm" variant="quiet" onClick={() => void unpublish(item)}>
                          Revoke
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" onClick={() => void publish(item)}>
                        Publish 7d
                      </Button>
                    )}
                    <Button size="sm" variant="quiet" onClick={() => void remove(item)} title="Delete packet">
                      <Icon name="trash" size={14} />
                    </Button>
                  </div>
                </div>

                {published && item.public_expires_at && (
                  <p className="muted tiny">Link expires {new Date(item.public_expires_at).toLocaleString()}.</p>
                )}

                {openId === item.id && (
                  <pre className="code-block" style={{ whiteSpace: 'pre-wrap', maxHeight: 520, overflow: 'auto' }}>
                    {item.body}
                  </pre>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
