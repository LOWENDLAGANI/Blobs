import { useCallback, useEffect, useState } from 'react';
import { api, del, post } from '../api.ts';
import { ComputerConnect, EmailConnect, PhoneConnect } from '../components/connectors.tsx';
import { Badge, Button, Card, Field, Icon, Input, Modal, PageHeader, Select, useToast } from '../ui.tsx';
import type { OAuthConnection } from '../types.ts';

interface IntegrationItem {
  key: string;
  name: string;
  category: string;
  status: string;
  detail: string;
  requires: string[];
  note?: string;
  config?: Record<string, unknown> | null;
}

interface ToolInfo {
  name: string;
  description: string;
  category: string;
  risk: string;
}

interface MachineLink {
  label: string;
  url: string;
}

interface MachineItem {
  key: 'host' | 'computer';
  name: string;
  provider: string;
  state: 'running' | 'local' | 'connected' | 'disabled' | 'disconnected';
  id: string | null;
  detail: string;
  links: MachineLink[];
}

function machineTone(state: MachineItem['state']): 'good' | 'info' | 'warn' {
  if (state === 'running' || state === 'connected') return 'good';
  if (state === 'local') return 'info';
  return 'warn';
}

const MACHINE_STATE_LABELS: Record<MachineItem['state'], string> = {
  running: 'running',
  local: 'this machine',
  connected: 'connected',
  disabled: 'switched off',
  disconnected: 'not connected',
};

const ICONS: Record<string, string> = {
  research: 'search',
  files: 'projects',
  code: 'bolt',
  computer: 'bolt',
  email: 'mail',
  phone: 'phone',
  messaging: 'send',
};

export function IntegrationsPage() {
  const toast = useToast();
  const [items, setItems] = useState<IntegrationItem[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [machines, setMachines] = useState<MachineItem[]>([]);
  const [editing, setEditing] = useState<'email' | 'phone' | 'computer' | null>(null);
  const [busy, setBusy] = useState(false);
  const [shotTs, setShotTs] = useState<number | null>(null);
  const [shotBusy, setShotBusy] = useState(false);
  const [connections, setConnections] = useState<OAuthConnection[]>([]);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [oauthForm, setOauthForm] = useState({ provider: 'github', clientId: '', clientSecret: '', scopes: '' });
  const [oauthBusy, setOauthBusy] = useState(false);

  const disconnectOAuth = async (provider: string): Promise<void> => {
    setBusy(true);
    try {
      await del(`/api/oauth/connections/${provider}`);
      toast('Disconnected.', 'info');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const connectOAuth = async (): Promise<void> => {
    if (!oauthForm.clientId.trim()) return toast('Client id is required.', 'bad');
    setOauthBusy(true);
    try {
      const result = await post<{ url: string }>('/api/oauth/start', {
        provider: oauthForm.provider,
        clientId: oauthForm.clientId,
        clientSecret: oauthForm.clientSecret,
        scopes: oauthForm.scopes,
      });
      window.location.href = result.url;
    } catch (error) {
      toast((error as Error).message, 'bad');
      setOauthBusy(false);
    }
  };

  const load = useCallback(async () => {
    try {
      const [integrations, toolList, machineList, oauthList] = await Promise.all([
        api<{ items: IntegrationItem[] }>('/api/integrations'),
        api<ToolInfo[]>('/api/settings/tools'),
        api<{ items: MachineItem[] }>('/api/machines'),
        api<{ items: OAuthConnection[] }>('/api/oauth/connections'),
      ]);
      setItems(integrations.items);
      setTools(toolList);
      setMachines(machineList.items);
      setConnections(oauthList.items);
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const disconnect = async (key: string): Promise<void> => {
    setBusy(true);
    try {
      await del(`/api/integrations/${key}`);
      toast(`${key} disconnected.`, 'info');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const email = items.find((item) => item.key === 'email');
  const phone = items.find((item) => item.key === 'phone');
  const computer = items.find((item) => item.key === 'computer');

  const takeScreenshot = async (): Promise<void> => {
    setShotBusy(true);
    try {
      await post('/api/computer/screenshot');
      setShotTs(Date.now());
      toast('Screenshot captured.', 'good');
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setShotBusy(false);
    }
  };

  const resetSandbox = async (): Promise<void> => {
    if (!window.confirm('Kill the running sandboxes? Files on the computer will be lost.')) return;
    setBusy(true);
    try {
      await post('/api/integrations/computer/reset');
      setShotTs(null);
      toast('Computer reset. The next action starts a fresh sandbox.', 'info');
      await load();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const disconnectComputer = async (): Promise<void> => {
    setBusy(true);
    try {
      await del('/api/integrations/computer');
      setShotTs(null);
      toast('Cloud computer disconnected.', 'info');
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="What BLOBS can actually reach. Free, built-in capabilities connect instantly; anything costing money is opt-in and clearly labelled."
      />

      <div className="stack">
        {machines.length > 0 && (
          <>
            <p className="section-title" style={{ marginTop: 0 }}>Machines</p>
            <div className="grid-2">
              {machines.map((machine) => (
                <Card key={machine.key} className="stack">
                  <div className="row-between">
                    <div className="row" style={{ gap: 12 }}>
                      <span className="avatar-lg">
                        <Icon name={machine.key === 'host' ? 'pulse' : 'bolt'} size={19} />
                      </span>
                      <div>
                        <h3>{machine.name}</h3>
                        <p className="muted tiny">{machine.provider}</p>
                      </div>
                    </div>
                    <Badge tone={machineTone(machine.state)}>{MACHINE_STATE_LABELS[machine.state]}</Badge>
                  </div>

                  <p className="small" style={{ color: 'var(--ink-2)' }}>
                    {machine.detail}
                  </p>

                  {machine.id && (
                    <p className="muted tiny">
                      Machine <code>{machine.id}</code>
                    </p>
                  )}

                  <div className="row" style={{ gap: 6 }}>
                    {machine.links.map((link) => (
                      <a
                        key={link.url}
                        className="btn btn-outline btn-sm"
                        href={link.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {link.label}
                      </a>
                    ))}
                  </div>

                  {machine.key === 'computer' && (
                    <p className="muted tiny">Connect, replace the key or reset it in the Cloud computer card below.</p>
                  )}
                </Card>
              ))}
            </div>
          </>
        )}

        {items.map((item) => (
          <Card key={item.key} className="stack">
            <div className="row-between">
              <div className="row" style={{ gap: 12 }}>
                <span className="avatar-lg">
                  <Icon name={ICONS[item.key] ?? 'plug'} size={19} />
                </span>
                <div>
                  <h3>{item.name}</h3>
                  <p className="muted tiny">{item.category}</p>
                </div>
              </div>
              <Badge
                tone={
                  item.status === 'connected' ? 'good' : item.status === 'unavailable' ? 'neutral' : 'warn'
                }
              >
                {item.status}
              </Badge>
            </div>

            <p className="small" style={{ color: 'var(--ink-2)' }}>
              {item.detail}
            </p>

            {item.note && <p className="note warn">{item.note}</p>}

            {item.requires.length > 0 && (
              <p className="muted tiny">Needs: {item.requires.join(', ')}</p>
            )}

            <div className="row" style={{ gap: 6 }}>
              {item.key === 'email' && (
                <>
                  <Button
                    size="sm"
                    variant={item.status === 'connected' ? 'outline' : 'primary'}
                    onClick={() => setEditing('email')}
                  >
                    {item.status === 'connected' ? 'Reconfigure' : 'Connect email'}
                  </Button>
                  {item.status === 'connected' && (
                    <Button size="sm" variant="quiet" busy={busy} onClick={() => void disconnect('email')}>
                      Disconnect
                    </Button>
                  )}
                </>
              )}
              {item.key === 'phone' && (
                <>
                  <Button
                    size="sm"
                    variant={item.status === 'connected' ? 'outline' : 'primary'}
                    onClick={() => setEditing('phone')}
                  >
                    {item.status === 'connected' ? 'Reconfigure' : 'Connect Twilio'}
                  </Button>
                  {item.status === 'connected' && (
                    <Button size="sm" variant="quiet" busy={busy} onClick={() => void disconnect('phone')}>
                      Disconnect
                    </Button>
                  )}
                </>
              )}
              {item.key === 'computer' && (
                <>
                  <Button
                    size="sm"
                    variant={item.status === 'connected' ? 'outline' : 'primary'}
                    onClick={() => setEditing('computer')}
                  >
                    {item.status === 'connected' ? 'Replace API key' : 'Connect E2B'}
                  </Button>
                  {item.status === 'connected' && (
                    <>
                      <Button size="sm" variant="outline" busy={shotBusy} onClick={() => void takeScreenshot()}>
                        Screenshot
                      </Button>
                      <Button size="sm" variant="quiet" busy={busy} onClick={() => void resetSandbox()}>
                        Reset sandbox
                      </Button>
                      <Button size="sm" variant="quiet" busy={busy} onClick={() => void disconnectComputer()}>
                        Disconnect
                      </Button>
                    </>
                  )}
                </>
              )}
              {item.category === 'built-in' && <span className="muted tiny">Always on · no key required</span>}
            </div>
          </Card>
        ))}
      </div>

      <p className="section-title">OAuth connections</p>
      <Card className="stack">
        <div className="row-between">
          <div>
            <h3>Connected accounts</h3>
            <p className="muted tiny">GitHub, Google and other OAuth providers BLOBS can act on your behalf with.</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setOauthOpen(true)}>
            <Icon name="plus" size={14} /> Connect account
          </Button>
        </div>
        {connections.length === 0 && <p className="muted small">No OAuth accounts connected yet.</p>}
        {connections.map((connection) => (
          <div key={connection.provider} className="log-line" style={{ alignItems: 'flex-start' }}>
            <span className="dot live" style={{ marginTop: 7 }} />
            <div className="log-body">
              <div className="row" style={{ gap: 8 }}>
                <strong>{connection.provider}</strong>
                {connection.account && <Badge tone="good">{connection.account}</Badge>}
              </div>
              {connection.scopes && <p className="muted tiny">{connection.scopes}</p>}
              <p className="muted tiny">Connected {new Date(connection.connectedAt).toLocaleString()}</p>
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <Button size="sm" variant="quiet" onClick={() => void disconnectOAuth(connection.provider)}>
                  Disconnect
                </Button>
              </div>
            </div>
          </div>
        ))}
      </Card>

      {shotTs && (
        <Card className="stack" >
          <div className="row-between">
            <h3>Computer screen</h3>
            <div className="row" style={{ gap: 6 }}>
              <Button size="sm" variant="outline" busy={shotBusy} onClick={() => void takeScreenshot()}>
                Refresh
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setShotTs(null)}>
                Hide
              </Button>
            </div>
          </div>
          <img className="screenshot" src={`/api/computer/screenshot?t=${shotTs}`} alt="Latest screenshot of the BLOBS cloud desktop" />
          <p className="muted tiny">
            This is the live desktop BLOBS controls with desktop_action. Ask it to screenshot, click, type or open a URL.
          </p>
        </Card>
      )}

      <p className="section-title">Tool catalogue</p>
      <Card padded>
        <div className="grid-2">
          {tools.map((tool) => (
            <div key={tool.name} style={{ padding: '8px 0' }}>
              <div className="row" style={{ gap: 8 }}>
                <code>{tool.name}</code>
                <Badge tone={tool.risk === 'high' ? 'warn' : tool.risk === 'medium' ? 'info' : 'neutral'}>{tool.risk}</Badge>
              </div>
              <p className="muted small" style={{ marginTop: 3 }}>
                {tool.description}
              </p>
            </div>
          ))}
        </div>
      </Card>

      <p className="section-title">Adding more later</p>
      <Card padded>
        <p className="small" style={{ color: 'var(--ink-2)' }}>
          New tools are added in one place on the server — a name, a JSON schema, a risk level and an implementation.
          BLOBS picks them up automatically, so a new capability becomes available to the agent, its task planner and the
          autonomy rules and audit log at once. Messaging channels (WhatsApp, SMS) are deliberately not faked: every real provider needs
          business verification or paid credit, so BLOBS reports them as unavailable rather than pretending.
        </p>
      </Card>

      {editing === 'email' && (
        <EmailConnect
          existing={(email?.config as never) ?? null}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
      {editing === 'phone' && (
        <PhoneConnect
          existing={(phone?.config as never) ?? null}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
      {oauthOpen && (
        <Modal title="Connect an OAuth account" onClose={() => setOauthOpen(false)} wide>
          <p className="note" style={{ marginBottom: 16 }}>
            Create an OAuth app in the provider's developer console, set its redirect URI to this app's
            <code> /oauth/callback</code>, then paste the client id (and secret for confidential clients).
          </p>
          <Field label="Provider">
            <Select value={oauthForm.provider} onChange={(event) => setOauthForm({ ...oauthForm, provider: event.target.value })}>
              <option value="github">GitHub</option>
              <option value="google">Google</option>
            </Select>
          </Field>
          <Field label="Client id">
            <Input value={oauthForm.clientId} onChange={(event) => setOauthForm({ ...oauthForm, clientId: event.target.value })} />
          </Field>
          <Field label="Client secret (optional for PKCE public clients)" hint="Stored encrypted and never shown again.">
            <Input type="password" value={oauthForm.clientSecret} onChange={(event) => setOauthForm({ ...oauthForm, clientSecret: event.target.value })} />
          </Field>
          <Field label="Scopes (optional)" hint="Leave blank for the provider's sensible default.">
            <Input value={oauthForm.scopes} onChange={(event) => setOauthForm({ ...oauthForm, scopes: event.target.value })} />
          </Field>
          <div className="modal-actions">
            <Button variant="quiet" onClick={() => setOauthOpen(false)}>
              Cancel
            </Button>
            <Button busy={oauthBusy} onClick={() => void connectOAuth()}>
              Start connection
            </Button>
          </div>
        </Modal>
      )}

      {editing === 'computer' && (
        <ComputerConnect
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            toast('Computer ready. Try asking BLOBS to run something.', 'good');
          }}
        />
      )}
    </>
  );
}
