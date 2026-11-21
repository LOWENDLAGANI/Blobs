import { useCallback, useEffect, useState } from 'react';
import { api, post, timeAgo } from '../api.ts';
import { useLive } from '../live.ts';
import { Badge, Button, Card, Empty, Icon, PageHeader, Select, useToast } from '../ui.tsx';
import type { ActivityItem } from '../types.ts';

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
  const [tab, setTab] = useState<'activity' | 'notifications'>('activity');
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [level, setLevel] = useState('all');

  const load = useCallback(async () => {
    try {
      const [activityData, notificationData] = await Promise.all([
        api<{ items: ActivityItem[] }>(`/api/activity?level=${level}&limit=160`),
        api<{ items: NotificationItem[] }>('/api/notifications'),
      ]);
      setItems(activityData.items);
      setNotifications(notificationData.items);
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  }, [level, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useLive(['activity', 'tasks', 'notification'], () => void load());

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="Everything BLOBS does on its own: tool calls, tasks, messages and failures."
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

      {tab === 'notifications' && (
        <Card padded>
          {notifications.length === 0 && <Empty icon="bell" title="No notifications" body="Task results and failures show up here." />}
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
