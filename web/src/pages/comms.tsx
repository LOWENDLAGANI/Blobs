import { useCallback, useEffect, useState } from 'react';
import { api, del, post, timeAgo } from '../api.ts';
import { EmailConnect, PhoneConnect } from '../components/connectors.tsx';
import { useLive } from '../live.ts';
import { Badge, Button, Card, Empty, Icon, PageHeader, useToast } from '../ui.tsx';
import type { CommsItem } from '../types.ts';

interface CommStatus {
  ready: boolean;
  address?: string | null;
  number?: string | null;
  detail: string;
}

interface IntegrationConfig {
  email?: { address?: string; smtpHost?: string; username?: string; displayName?: string } | null;
  phone?: { accountSid?: string; fromNumber?: string; ownerNumber?: string; publicBaseUrl?: string } | null;
}

export function CommsPage() {
  const toast = useToast();
  const [channel, setChannel] = useState<'email' | 'phone'>('email');
  const [items, setItems] = useState<CommsItem[]>([]);
  const [email, setEmail] = useState<CommStatus>({ ready: false, detail: '' });
  const [phone, setPhone] = useState<CommStatus>({ ready: false, detail: '' });
  const [config, setConfig] = useState<IntegrationConfig>({});
  const [editing, setEditing] = useState<'email' | 'phone' | null>(null);
  const [inbox, setInbox] = useState<{ uid: string; from: string; subject: string; date: string }[] | null>(null);
  const [inboxBusy, setInboxBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [comms, integrations] = await Promise.all([
        api<{ items: CommsItem[]; email: CommStatus; phone: CommStatus }>(`/api/comms?channel=${channel}`),
        api<{ items: { key: string; config?: unknown }[] }>('/api/integrations'),
      ]);
      setItems(comms.items);
      setEmail(comms.email);
      setPhone(comms.phone);
      const next: IntegrationConfig = {};
      for (const item of integrations.items) {
        if (item.key === 'email') next.email = item.config as IntegrationConfig['email'];
        if (item.key === 'phone') next.phone = item.config as IntegrationConfig['phone'];
      }
      setConfig(next);
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  }, [channel, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useLive(['activity'], () => void load());

  const syncInbox = async (): Promise<void> => {
    setInboxBusy(true);
    try {
      const result = await api<{ ok: boolean; messages: { uid: string; from: string; subject: string; date: string }[]; error?: string }>(
        '/api/integrations/email/inbox',
      );
      if (!result.ok) toast(result.error ?? 'Could not read the inbox.', 'bad');
      else {
        setInbox(result.messages);
        toast(`${result.messages.length} recent messages.`, 'good');
      }
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setInboxBusy(false);
    }
  };

  const disconnect = async (which: 'email' | 'phone'): Promise<void> => {
    await del(`/api/integrations/${which}`).catch(() => undefined);
    toast(`${which} disconnected.`, 'info');
    await load();
  };

  const test = async (): Promise<void> => {
    try {
      await post('/api/integrations/email/test', {});
      toast('Test email sent.', 'good');
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  };

  const active = channel === 'email' ? email : phone;

  return (
    <>
      <PageHeader
        title="Communications"
        subtitle="BLOBS has its own identity. Every outward message says it is an AI, it sends autonomously, and every send is logged."
        actions={
          active.ready ? (
            <Button variant="outline" onClick={() => setEditing(channel)}>
              <Icon name="gear" size={15} /> Configure
            </Button>
          ) : (
            <Button onClick={() => setEditing(channel)}>
              <Icon name="plus" size={15} /> Connect {channel}
            </Button>
          )
        }
      />

      <div className="grid-2" style={{ marginBottom: 20 }}>
        <Card className="stack">
          <div className="row-between">
            <div className="row" style={{ gap: 10 }}>
              <span className="avatar-lg">
                <Icon name="mail" size={18} />
              </span>
              <div>
                <h3>Email</h3>
                <p className="muted tiny">{email.address ?? 'No address yet'}</p>
              </div>
            </div>
            <Badge tone={email.ready ? 'good' : 'neutral'}>{email.ready ? 'connected' : 'off'}</Badge>
          </div>
          <p className="muted small">{email.detail}</p>
          <div className="row" style={{ gap: 6 }}>
            {email.ready ? (
              <>
                <Button size="sm" variant="outline" onClick={() => void test()}>
                  Send test
                </Button>
                <Button size="sm" variant="outline" busy={inboxBusy} onClick={() => void syncInbox()}>
                  Read inbox
                </Button>
                <Button size="sm" variant="quiet" onClick={() => void disconnect('email')}>
                  Disconnect
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setEditing('email')}>
                Connect mailbox
              </Button>
            )}
          </div>
        </Card>

        <Card className="stack">
          <div className="row-between">
            <div className="row" style={{ gap: 10 }}>
              <span className="avatar-lg">
                <Icon name="phone" size={18} />
              </span>
              <div>
                <h3>Phone</h3>
                <p className="muted tiny">{phone.number ?? 'No number yet'}</p>
              </div>
            </div>
            <Badge tone={phone.ready ? 'good' : 'neutral'}>{phone.ready ? 'connected' : 'off'}</Badge>
          </div>
          <p className="muted small">{phone.detail}</p>
          <div className="row" style={{ gap: 6 }}>
            {phone.ready ? (
              <Button size="sm" variant="outline" onClick={() => void disconnect('phone')}>
                Disconnect
              </Button>
            ) : (
              <Button size="sm" onClick={() => setEditing('phone')}>
                Connect Twilio
              </Button>
            )}
          </div>
        </Card>
      </div>

      {inbox && (
        <Card className="stack" >
          <div className="row-between">
            <h3>Recent inbox</h3>
            <Button size="sm" variant="quiet" onClick={() => setInbox(null)}>
              Close
            </Button>
          </div>
          <p className="muted tiny">Headers only — BLOBS does not mark anything as read.</p>
          {inbox.length === 0 && <p className="muted small">The inbox is empty.</p>}
          {inbox.map((message) => (
            <div key={message.uid} className="log-line">
              <div className="log-body">
                <p>
                  <strong>{message.subject}</strong>
                </p>
                <p className="muted tiny">
                  {message.from} · {message.date ? new Date(message.date).toLocaleString() : ''}
                </p>
              </div>
            </div>
          ))}
        </Card>
      )}

      <div className="tabs" style={{ marginTop: 22 }}>
        <button className={`tab${channel === 'email' ? ' active' : ''}`} onClick={() => setChannel('email')}>
          Email history
        </button>
        <button className={`tab${channel === 'phone' ? ' active' : ''}`} onClick={() => setChannel('phone')}>
          Call history
        </button>
      </div>

      <Card padded>
        {items.length === 0 ? (
          <Empty
            icon={channel === 'email' ? 'mail' : 'phone'}
            title={`No ${channel === 'email' ? 'email' : 'call'} history`}
            body="Sent, received and failed messages are recorded here with their outcome."
          />
        ) : (
          items.map((item) => (
            <div key={item.id} className="log-line">
              <span className="log-time">{timeAgo(item.created_at)}</span>
              <Badge tone={item.status === 'sent' || item.status === 'completed' ? 'good' : item.status === 'failed' ? 'bad' : 'info'}>
                {item.direction}
              </Badge>
              <div className="log-body">
                <p>
                  <strong>{item.subject || item.peer}</strong>
                  {item.peer && item.subject ? <span className="muted"> · {item.peer}</span> : null}
                </p>
                {item.body && (
                  <p className="muted small" style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>
                    {item.body.slice(0, 300)}
                    {item.body.length > 300 ? '…' : ''}
                  </p>
                )}
              </div>
              <span className="muted tiny">{item.status}</span>
            </div>
          ))
        )}
      </Card>

      {editing === 'email' && (
        <EmailConnect
          existing={config.email ?? null}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
      {editing === 'phone' && (
        <PhoneConnect
          existing={config.phone ?? null}
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
