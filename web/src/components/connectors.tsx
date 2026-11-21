import { useState } from 'react';
import { post } from '../api.ts';
import { Button, Field, Input, Modal, Toggle, useToast } from '../ui.tsx';

export function EmailConnect({
  existing,
  onClose,
  onSaved,
}: {
  existing: { address?: string; smtpHost?: string; smtpPort?: number; username?: string; displayName?: string; imapHost?: string; imapPort?: number; smtpSecure?: boolean } | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [address, setAddress] = useState(existing?.address ?? '');
  const [displayName, setDisplayName] = useState(existing?.displayName ?? 'BLOBS');
  const [smtpHost, setSmtpHost] = useState(existing?.smtpHost ?? '');
  const [smtpPort, setSmtpPort] = useState(String(existing?.smtpPort ?? 587));
  const [smtpSecure, setSmtpSecure] = useState(Boolean(existing?.smtpSecure));
  const [imapHost, setImapHost] = useState(existing?.imapHost ?? '');
  const [imapPort, setImapPort] = useState(String(existing?.imapPort ?? 993));
  const [username, setUsername] = useState(existing?.username ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const gmail = (): void => {
    const local = address.includes('@') ? address.split('@')[0] : address;
    setSmtpHost('smtp.gmail.com');
    setSmtpPort('587');
    setSmtpSecure(false);
    setImapHost('imap.gmail.com');
    setImapPort('993');
    setUsername(address || local);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await post('/api/integrations/email', {
        address,
        displayName,
        smtpHost,
        smtpPort: Number(smtpPort),
        smtpSecure,
        imapHost: imapHost || smtpHost,
        imapPort: Number(imapPort),
        username: username || address,
        password,
      });
      toast('Email identity saved. Send yourself a test to confirm.', 'good');
      await onSaved();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Connect an email identity" onClose={onClose} wide>
      <p className="note" style={{ marginBottom: 16 }}>
        Any mailbox with SMTP works, including a free Gmail account. For Gmail you must create an{' '}
        <strong>app password</strong> (Google Account → Security → 2-Step Verification → App passwords) — your normal
        password will be rejected.
      </p>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <Button size="sm" variant="outline" onClick={gmail}>
          Fill Gmail defaults
        </Button>
        <span className="muted tiny">Stored encrypted on the server. Never sent back to the browser.</span>
      </div>
      <Field label="Email address">
        <Input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="blobs.agent@gmail.com" />
      </Field>
      <Field label="Display name">
        <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      </Field>
      <div className="grid-2">
        <Field label="SMTP host">
          <Input value={smtpHost} onChange={(event) => setSmtpHost(event.target.value)} placeholder="smtp.gmail.com" />
        </Field>
        <Field label="SMTP port">
          <Input value={smtpPort} onChange={(event) => setSmtpPort(event.target.value)} inputMode="numeric" />
        </Field>
        <Field label="IMAP host">
          <Input value={imapHost} onChange={(event) => setImapHost(event.target.value)} placeholder="imap.gmail.com" />
        </Field>
        <Field label="IMAP port">
          <Input value={imapPort} onChange={(event) => setImapPort(event.target.value)} inputMode="numeric" />
        </Field>
      </div>
      <Field label="Username">
        <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Usually the full address" />
      </Field>
      <Field label="Password / app password" hint="Leave blank to keep the stored password.">
        <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••" />
      </Field>
      <Toggle checked={smtpSecure} onChange={setSmtpSecure} label="Use implicit TLS on SMTP" hint="Port 465 usually needs this; port 587 with STARTTLS does not." />
      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button busy={busy} onClick={() => void save()}>
          Save mailbox
        </Button>
      </div>
    </Modal>
  );
}

export function ComputerConnect({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    if (!apiKey.trim()) return toast('Paste your E2B API key first.', 'bad');
    setBusy(true);
    try {
      await post('/api/integrations/computer', { apiKey });
      toast('Cloud computer connected. Sandboxes start on first use.', 'good');
      await onSaved();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Connect a cloud computer" onClose={onClose} wide>
      <p className="note" style={{ marginBottom: 16 }}>
        BLOBS gets its own isolated Linux machine through E2B: a real shell, Python/Node/Bash, package installation,
        long-running servers with public URLs, file transfer and an optional graphical desktop. It is a separate cloud
        VM — nothing on your own computer is accessed or modified.
      </p>
      <p className="note warn" style={{ marginBottom: 16 }}>
        E2B includes a free credit allowance, then charges per sandbox-second. Sandboxes are stopped when their timeout
        expires and can be reset at any time from this page.
      </p>
      <Field label="E2B API key" hint="Create one at e2b.dev → Dashboard → API keys. Stored encrypted on this server and never sent back to the browser.">
        <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="e2b_…" autoFocus />
      </Field>
      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button busy={busy} onClick={() => void save()}>
          Connect computer
        </Button>
      </div>
    </Modal>
  );
}

export function PhoneConnect({
  existing,
  onClose,
  onSaved,
}: {
  existing: { accountSid?: string; fromNumber?: string; ownerNumber?: string; publicBaseUrl?: string } | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [accountSid, setAccountSid] = useState(existing?.accountSid ?? '');
  const [authToken, setAuthToken] = useState('');
  const [fromNumber, setFromNumber] = useState(existing?.fromNumber ?? '');
  const [ownerNumber, setOwnerNumber] = useState(existing?.ownerNumber ?? '');
  const [publicBaseUrl, setPublicBaseUrl] = useState(existing?.publicBaseUrl ?? '');
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await post('/api/integrations/phone', { accountSid, authToken, fromNumber, ownerNumber, publicBaseUrl });
      toast('Phone connected.', 'good');
      await onSaved();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Connect phone calling" onClose={onClose} wide>
      <p className="note warn" style={{ marginBottom: 16 }}>
        Twilio requires a payment method on file. Trial credit is usually enough for a handful of test calls, but this is{' '}
        <strong>not a free service</strong> and calls cost money. BLOBS is autonomous, so it can dial once Twilio is connected — only connect it when that is what you want.
      </p>
      <Field label="Account SID">
        <Input value={accountSid} onChange={(event) => setAccountSid(event.target.value)} placeholder="AC…" />
      </Field>
      <Field label="Auth token" hint="Leave blank to keep the stored token.">
        <Input type="password" value={authToken} onChange={(event) => setAuthToken(event.target.value)} placeholder="••••••••" />
      </Field>
      <div className="grid-2">
        <Field label="BLOBS number (from)">
          <Input value={fromNumber} onChange={(event) => setFromNumber(event.target.value)} placeholder="+15551234567" />
        </Field>
        <Field label="Your number (to call)">
          <Input value={ownerNumber} onChange={(event) => setOwnerNumber(event.target.value)} placeholder="+60123456789" />
        </Field>
      </div>
      <Field
        label="Public base URL"
        hint="Twilio must reach this server for two-way calls, e.g. https://your-tunnel.example.com. Local addresses will not work."
      >
        <Input value={publicBaseUrl} onChange={(event) => setPublicBaseUrl(event.target.value)} placeholder="https://…" />
      </Field>
      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button busy={busy} onClick={() => void save()}>
          Save phone
        </Button>
      </div>
    </Modal>
  );
}
