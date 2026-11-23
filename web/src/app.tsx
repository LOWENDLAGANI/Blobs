import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, connectEvents, post, timeAgo } from './api.ts';
import { emitLive } from './live.ts';
import { Badge, Button, Field, Icon, Input, Orb, ToastProvider, useToast } from './ui.tsx';
import { ConsolePage } from './pages/console.tsx';
import { TasksPage } from './pages/tasks.tsx';
import { WatchesPage } from './pages/watches.tsx';
import { ReviewPage } from './pages/review.tsx';
import { ProjectsPage } from './pages/projects.tsx';
import { MemoryPage } from './pages/memory.tsx';
import { ActivityPage } from './pages/activity.tsx';
import { CommsPage } from './pages/comms.tsx';
import { IntegrationsPage } from './pages/integrations.tsx';
import { SettingsPage } from './pages/settings.tsx';

type Route =
  | 'console'
  | 'tasks'
  | 'watches'
  | 'review'
  | 'projects'
  | 'memory'
  | 'activity'
  | 'comms'
  | 'integrations'
  | 'settings';

interface Overview {
  companion: { name: string; tagline: string };
  owner: { name: string; timezone: string };
  model: { provider: string; label: string; hasKey: boolean };
  autonomy: { level: string; state: string; backgroundEnabled: boolean };
  tasks: Record<string, number>;
  approvals: number;
  unread: number;
  usage: { today: number; budget: number };
  scheduler: { running: boolean; queued: number };
  notifications: { browser: boolean };
}

const NAV: { route: Route; label: string; icon: string }[] = [
  { route: 'console', label: 'Talk', icon: 'mic' },
  { route: 'tasks', label: 'Tasks', icon: 'tasks' },
  { route: 'watches', label: 'Watches', icon: 'pulse' },
  { route: 'review', label: 'Review', icon: 'check' },
  { route: 'projects', label: 'Projects', icon: 'projects' },
  { route: 'memory', label: 'Memory', icon: 'brain' },
  { route: 'activity', label: 'Activity', icon: 'pulse' },
  { route: 'comms', label: 'Comms', icon: 'mail' },
  { route: 'integrations', label: 'Links', icon: 'plug' },
  { route: 'settings', label: 'Settings', icon: 'gear' },
];

function routeFromHash(): Route {
  const raw = window.location.hash.replace('#/', '').split('?')[0];
  return (NAV.find((item) => item.route === raw)?.route ?? 'console') as Route;
}

export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash());

  useEffect(() => {
    const onHash = (): void => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((next: Route) => {
    window.location.hash = `#/${next}`;
    setRoute(next);
  }, []);

  return (
    <ToastProvider>
      <Shell route={route} go={go} />
    </ToastProvider>
  );
}

function Shell({ route, go }: { route: Route; go: (route: Route) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [notifications, setNotifications] = useState<
    { id: string; ts: number; title: string; body: string; level: string; read: number; link: string | null }[]
  >([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [live, setLive] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api<Overview>('/api/overview');
      setOverview(data);
    } catch {
      /* transient */
    }
  }, []);

  const loadNotifications = useCallback(async () => {
    try {
      const data = await api<{ items: typeof notifications }>('/api/notifications');
      setNotifications(data.items);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadNotifications();
  }, [refresh, loadNotifications]);

  useEffect(() => {
    const disconnect = connectEvents((event) => {
      emitLive(event);
      if (['activity', 'notification', 'tasks', 'conversation'].includes(event.type)) void refresh();
      if (event.type === 'notification') {
        void loadNotifications();
        const payload = event.data as { title?: string; body?: string } | null;
        if (
          payload?.title &&
          typeof Notification !== 'undefined' &&
          Notification.permission === 'granted'
        ) {
          try {
            new Notification(payload.title, { body: payload.body ?? '' });
          } catch {
            /* some browsers require a service worker; in-app notifications still work */
          }
        }
      }
    });
    setLive(true);
    return () => {
      setLive(false);
      disconnect();
    };
  }, [refresh, loadNotifications]);

  useEffect(() => {
    if (route === 'activity' || route === 'console') void loadNotifications();
  }, [route, loadNotifications]);

  const markRead = async (): Promise<void> => {
    await post('/api/notifications/read').catch(() => undefined);
    await loadNotifications();
    await refresh();
  };

  const page = useMemo<ReactNode>(() => {
    switch (route) {
      case 'tasks':
        return <TasksPage go={go} />;
      case 'watches':
        return <WatchesPage />;
      case 'review':
        return <ReviewPage />;
      case 'projects':
        return <ProjectsPage />;
      case 'memory':
        return <MemoryPage />;
      case 'activity':
        return <ActivityPage />;
      case 'comms':
        return <CommsPage />;
      case 'integrations':
        return <IntegrationsPage />;
      case 'settings':
        return <SettingsPage refreshShell={refresh} />;
      default:
        return <ConsolePage overview={overview} />;
    }
  }, [route, go, overview, refresh]);

  const autonomyTone =
    overview?.autonomy.state === 'stopped' ? 'bad' : overview?.autonomy.state === 'paused' ? 'warn' : 'good';

  return (
    <div className="shell">
      <aside className="rail">
        <button className="brand" onClick={() => go('console')} aria-label="BLOBS home">
          <span className="brand-mark" />
          <span className="brand-word">{overview?.companion.name ?? 'BLOBS'}</span>
        </button>

        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.route}
              className={`nav-item${route === item.route ? ' active' : ''}`}
              onClick={() => go(item.route)}
              aria-current={route === item.route ? 'page' : undefined}
            >
              <Icon name={item.icon} size={21} />
              <span>{item.label}</span>
              {item.route === 'tasks' && (overview?.tasks.running ?? 0) > 0 && <span className="dot live" />}
            </button>
          ))}
        </nav>

        <div className="rail-foot">
          <span className="avatar">{(overview?.owner.name ?? 'O').slice(0, 1).toUpperCase()}</span>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="topbar-left">
            <span className={`status-dot${live ? ' on' : ''}`} />
            <span className="muted small">{live ? 'Live' : 'Reconnecting'}</span>
            <span className="divider" />
            <Badge tone="info">{overview?.model.label ?? 'Model loading'}</Badge>
            {overview && !overview.model.hasKey && <Badge tone="warn">No API key</Badge>}
            <Badge tone={autonomyTone}>
              {overview?.autonomy.state === 'active' ? 'autonomous' : overview?.autonomy.state ?? 'autonomous'}
            </Badge>
            {overview?.scheduler.running && overview.scheduler.queued > 0 && (
              <span className="muted small">{overview.scheduler.queued} queued</span>
            )}
          </div>
          <div className="topbar-right">
            <div className="notif-wrap">
              <button
                className={`icon-btn${notifications.some((item) => !item.read) ? ' has-dot' : ''}`}
                onClick={() => {
                  setShowNotifications((open) => !open);
                  if (!showNotifications) void markRead();
                }}
                aria-label="Notifications"
              >
                <Icon name="bell" size={19} />
              </button>
              {showNotifications && (
                <div className="notif-panel">
                  <div className="notif-head">
                    <strong>Notifications</strong>
                    <button className="icon-btn" onClick={() => setShowNotifications(false)} aria-label="Close">
                      <Icon name="x" size={16} />
                    </button>
                  </div>
                  {notifications.length === 0 && <p className="muted small pad">Nothing yet.</p>}
                  {notifications.slice(0, 12).map((item) => (
                    <div key={item.id} className="notif-item">
                      <span className={`dot ${item.level}`} />
                      <div>
                        <p>{item.title}</p>
                        {item.body && <p className="muted small">{item.body}</p>}
                        <p className="muted tiny">{timeAgo(item.ts)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <main className="content">{page}</main>
      </div>
    </div>
  );
}

export function PageOrb({ onClick, label }: { onClick: () => void; label: string }) {
  return <Orb state="idle" level={0.2} onClick={onClick} label={label} />;
}
