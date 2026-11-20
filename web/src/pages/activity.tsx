import { useCallback, useEffect, useState } from 'react';
import { api, post, timeAgo } from '../api.ts';
import { useLive } from '../live.ts';
import { Badge, Button, Card, Empty, Icon, PageHeader, Select, useToast } from '../ui.tsx';
import type { ActivityItem, ApprovalItem } from '../types.ts';

interface NotificationItem {
  id: string;
  ts: number;
  title: string;
  body: string;
  level: string;
  read: number;
}

const LEVEL_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = {
  info: 'info',
  success: 'good',
  warn: 'warn',
  error: 'bad',
  action: 'info',
};

export function ActivityPage() {
  const toast = useToast();
  const [tab, setTab] = useState<'activity' | 'approvals' | 'notifications'>('activity');
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [decided, setDecided] = useState<ApprovalItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [level, setLevel] = useState('all');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [activityData, approvalData, notificationData] = await Promise.all([
        api<{ items: ActivityItem[] }>(`/api/activity?level=${level}&limit=160`),
        api<{ items: ApprovalItem[] }>('/api/approvals?status=all'),
        api<{ items: NotificationItem[] }>('/api/notifications'),
      ]);
      setItems(activityData.items);
      setApprovals(approvalData.items.filter((item) => item.status === 'pending'));
      setDecided(approvalData.items.filter((item) => item.status !== 'pending').slice(0, 20));
      setNotifications(notificationData.items);
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  }, [level, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useLive(['activity', 'tasks', 'notification'], () => void load());

  const decide = async (id: string, decision: 'approved' | 'rejected'): Promise<void> => {
    setBusy(id);
    try {
      await post(`/api/approvals/${id}/decide`, { decision });
      toast(decision === 'approved' ? 'Approved — BLOBS is continuing.' : 'Rejected.', decision === 'approved' ? 'good' : 'info');
      await load();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="Everything BLOBS does, including the actions it is not allowed to take without you."
        actions={
          <Button variant="outline" onClick={() => void post('/api/notifications/read').then(load)}>
            <Icon name="check" size={15} /> Mark notifications read
          </Button>
        }
      />

      <div className="tabs">
        <button className={`tab${tab === 'activity' ? ' active' : ''}`} onClick={() => setTab('activity')}>
          Activity
        </button>
        <button className={`tab${tab === 'approvals' ? ' active' : ''}`} onClick={() => setTab('approvals')}>
          Approvals {approvals.length > 0 && `(${approvals.length})`}
        </button>
        <button className={`tab${tab === 'notifications' ? ' active' : ''}`} onClick={() => setTab('notifications')}>
          Notifications
        </button>
      </div>

      {tab === 'activity' && (
        <>
          <div className="row" style={{ marginBottom: 14, justifyContent: 'flex-end' }}>
            <Select value={level} onChange={(event) => setLevel(event.target.value)} style={{ width: 170 }}>
              <option value="all">All levels</option>
              <option value="action">Actions</option>
              <option value="info">Info</option>
              <option value="success">Success</option>
              <option value="warn">Warnings</option>
              <option value="error">Errors</option>
            </Select>
          </div>
          <Card padded>
            {items.length === 0 && <Empty icon="pulse" title="Nothing logged yet" body="Agent activity, tool use and errors appear here." />}
            {items.map((item) => (
              <div key={item.id} className="log-line">
                <span className="log-time">{timeAgo(item.ts)}</span>
                <span className={`dot ${item.level}`} style={{ marginTop: 7 }} />
                <div className="log-body">
                  <p>{item.message}</p>
                  <p className="log-cat" style={{ marginTop: 2 }}>
                    {item.category}
                    {item.task_id ? ' · task' : ''}
                  </p>
                </div>
                <Badge tone={LEVEL_TONE[item.level] ?? 'neutral'}>{item.level}</Badge>
              </div>
            ))}
          </Card>
        </>
      )}

      {tab === 'approvals' && (
        <div className="stack">
          {approvals.length === 0 && (
            <Card>
              <Empty
                icon="check"
                title="No approvals waiting"
                body="High-impact actions — money, deletion, publishing, external messages, security changes — stop here for your decision."
              />
            </Card>
          )}
          {approvals.map((approval) => (
            <Card key={approval.id} className="stack">
              <div className="row-between">
                <div className="row" style={{ gap: 8 }}>
                  <Badge tone="warn">{approval.kind}</Badge>
                  <span className="muted tiny">{timeAgo(approval.created_at)}</span>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <Button size="sm" variant="ghost" busy={busy === approval.id} onClick={() => void decide(approval.id, 'rejected')}>
                    Reject
                  </Button>
                  <Button size="sm" busy={busy === approval.id} onClick={() => void decide(approval.id, 'approved')}>
                    <Icon name="check" size={14} /> Approve
                  </Button>
                </div>
              </div>
              <h3>{approval.title}</h3>
              <pre className="code-block">{approval.detail}</pre>
              {approval.task_id && <p className="muted tiny">Belongs to task {approval.task_id}</p>}
            </Card>
          ))}

          {decided.length > 0 && (
            <>
              <p className="section-title">Recent decisions</p>
              <Card padded>
                {decided.map((approval) => (
                  <div key={approval.id} className="log-line">
                    <span className="log-time">{approval.decided_at ? timeAgo(approval.decided_at) : ''}</span>
                    <Badge tone={approval.status === 'approved' ? 'good' : approval.status === 'rejected' ? 'bad' : 'neutral'}>
                      {approval.status}
                    </Badge>
                    <div className="log-body">
                      <p>{approval.title}</p>
                      {approval.decision_note && <p className="muted tiny">{approval.decision_note}</p>}
                    </div>
                  </div>
                ))}
              </Card>
            </>
          )}
        </div>
      )}

      {tab === 'notifications' && (
        <Card padded>
          {notifications.length === 0 && <Empty icon="bell" title="No notifications" body="Task results, approvals and failures show up here." />}
          {notifications.map((item) => (
            <div key={item.id} className="log-line">
              <span className="log-time">{timeAgo(item.ts)}</span>
              <span className={`dot ${item.level}`} style={{ marginTop: 7 }} />
              <div className="log-body">
                <p>
                  <strong>{item.title}</strong>
                </p>
                {item.body && <p className="muted small">{item.body}</p>}
              </div>
              {!item.read && <Badge tone="info">new</Badge>}
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
