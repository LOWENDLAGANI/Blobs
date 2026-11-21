import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, connectEvents, post, timeAgo } from './api.ts';
import { emitLive } from './live.ts';
import { Badge, Button, Field, Icon, Input, Orb, ToastProvider, useToast } from './ui.tsx';
import { ConsolePage } from './pages/console.tsx';
import { TasksPage } from './pages/tasks.tsx';
import { ProjectsPage } from './pages/projects.tsx';
import { MemoryPage } from './pages/memory.tsx';
import { ActivityPage } from './pages/activity.tsx';
import { CommsPage } from './pages/comms.tsx';
import { IntegrationsPage } from './pages/integrations.tsx';
import { SettingsPage } from './pages/settings.tsx';

type Route = 'console' | 'tasks' | 'projects' | 'memory' | 'activity' | 'comms' | 'integrations' | 'settings';

interface AuthState {
  setupRequired: boolean;
  authed: boolean;
  ownerName: string | null;
  companionName: string;
  tagline: string;
}

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
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [route, setRoute] = useState<Route>(routeFromHash());

  const reloadAuth = useCallback(async () => {
    try {
      const state = await api<AuthState>('/api/auth/state');
      setAuth(state);
    } catch {
      setAuth({ setupRequired: false, authed: false, ownerName: null, companionName: 'BLOBS', tagline: 'Your personal agent' });
    }
  }, []);

  useEffect(() => {
    void reloadAuth();
  }, [reloadAuth]);

  useEffect(() => {
    const onHash = (): void => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((next: Route) => {
    window.location.hash = `#/${next}`;
    setRoute(next);
  }, []);

  if (!auth) {
    return (
      <div className="boot">
        <div className="orb-static" />
        <p>Waking up…</p>
      </div>
    );
  }

  if (auth.setupRequired) {
    return (
      <ToastProvider>
        <SetupScreen onDone={reloadAuth} />
      </ToastProvider>
    );
  }

  if (!auth.authed) {
    return (
      <ToastProvider>
        <LoginScreen companionName={auth.companionName} onDone={reloadAuth} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <Shell route={route} go={go} onSignOut={reloadAuth} />
    </ToastProvider>
  );
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

function SetupScreen({ onDone }: { onDone: () => Promise<void> }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (): Promise<void> => {
    if (passphrase.length < 8) return setError('Use at least 8 characters for the passphrase.');
    if (passphrase !== confirm) return setError('The two passphrases do not match.');
    setBusy(true);
    setError('');
    try {
      await post('/api/auth/setup', { name, passphrase });
      toast('BLOBS is ready.', 'good');
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-art">
        <div className="orb-static" />
      </div>
      <div className="auth-panel">
        <p className="eyebrow">First run</p>
        <h1>Meet BLOBS</h1>
        <p className="lede">
          One continuous agent with its own memory, tasks and voice. This passphrase protects the whole control centre — it is
          hashed on the server and never leaves it.
        </p>
        <Field label="What should BLOBS call you?">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" autoFocus />
        </Field>
        <Field label="Owner passphrase" hint="At least 8 characters. There is no recovery, so store it well.">
          <Input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            placeholder="••••••••"
          />
        </Field>
        <Field label="Repeat passphrase">
          <Input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
        </Field>
        {error && <p className="form-error">{error}</p>}
        <Button size="lg" busy={busy} onClick={() => void submit()}>
          Create BLOBS
        </Button>
      </div>
    </div>
  );
}

function LoginScreen({ companionName, onDone }: { companionName: string; onDone: () => Promise<void> }) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await post('/api/auth/login', { passphrase });
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth auth-login">
      <div className="auth-panel">
        <div className="orb-static orb-small" />
        <h1>{companionName}</h1>
        <p className="lede">Sign in to your agent.</p>
        <Field label="Owner passphrase">
          <Input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void submit()}
            autoFocus
            placeholder="••••••••"
          />
        </Field>
        {error && <p className="form-error">{error}</p>}
        <Button size="lg" busy={busy} onClick={() => void submit()}>
          Unlock
        </Button>
      </div>
    </div>
  );
}

function Shell({ route, go, onSignOut }: { route: Route; go: (route: Route) => void; onSignOut: () => Promise<void> }) {
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

  const signOut = async (): Promise<void> => {
    await post('/api/auth/logout').catch(() => undefined);
    await onSignOut();
  };

  const page = useMemo<ReactNode>(() => {
    switch (route) {
      case 'tasks':
        return <TasksPage go={go} />;
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
          <button className="nav-item" onClick={signOut}>
            <span className="avatar">{(overview?.owner.name ?? 'O').slice(0, 1).toUpperCase()}</span>
            <span>Sign out</span>
          </button>
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
