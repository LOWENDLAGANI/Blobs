import { useCallback, useEffect, useState } from 'react';
import { api, del, post } from '../api.ts';
import { ComputerConnect, EmailConnect, PhoneConnect } from '../components/connectors.tsx';
import { Badge, Button, Card, Icon, PageHeader, useToast } from '../ui.tsx';

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

  const load = useCallback(async () => {
    try {
      const [integrations, toolList, machineList] = await Promise.all([
        api<{ items: IntegrationItem[] }>('/api/integrations'),
        api<ToolInfo[]>('/api/settings/tools'),
        api<{ items: MachineItem[] }>('/api/machines'),
      ]);
      setItems(integrations.items);
      setTools(toolList);
      setMachines(machineList.items);
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
          approval system at once. Messaging channels (WhatsApp, SMS) are deliberately not faked: every real provider needs
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
