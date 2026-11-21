import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { all, get, run } from '../db.ts';
import { getSecret, getSettings } from '../settings.ts';
import { id, now, safeJson, truncate } from '../util.ts';
import { logActivity } from '../activity.ts';
import type { ToolContext } from '../agent/tools.ts';

export interface EmailConfig {
  address: string;
  displayName: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  username: string;
}

export async function emailConfig(): Promise<EmailConfig | null> {
  const row = await get<{ config: string }>("SELECT config FROM integrations WHERE key = 'email'");
  if (!row?.config) return null;
  const parsed = safeJson<Partial<EmailConfig>>(row.config, {});
  if (!parsed.address || !parsed.smtpHost || !parsed.username) return null;
  return {
    address: parsed.address,
    displayName: parsed.displayName || getSettings().companion.name,
    smtpHost: parsed.smtpHost,
    smtpPort: Number(parsed.smtpPort ?? 587),
    smtpSecure: Boolean(parsed.smtpSecure),
    imapHost: parsed.imapHost || parsed.smtpHost,
    imapPort: Number(parsed.imapPort ?? 993),
    username: parsed.username,
  };
}

export async function emailStatus(): Promise<{ ready: boolean; address: string | null; detail: string }> {
  const config = await emailConfig();
  const password = await getSecret('email:password');
  if (!config) {
    return {
      ready: false,
      address: null,
      detail: 'Not connected. Add an SMTP mailbox (for example a free Gmail account with an app password).',
    };
  }
  if (!password) {
    return { ready: false, address: config.address, detail: 'Mailbox configured but the password is missing.' };
  }
  return { ready: true, address: config.address, detail: `Sending as ${config.displayName} <${config.address}>.` };
}

async function transport(config: EmailConfig) {
  const password = await getSecret('email:password');
  if (!password) throw new Error('The email password is not stored.');
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: { user: config.username, pass: password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 25_000,
  });
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  body: string;
  context?: ToolContext;
}): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  const config = await emailConfig();
  if (!config) return { ok: false, error: 'Email is not connected.' };
  const to = input.to.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, error: 'That recipient address does not look valid.' };

  const signature = `\n\n— ${config.displayName} (an AI assistant), on behalf of ${getSettings().owner.name}.`;
  const text = input.body.includes('— ')
    ? input.body
    : `${input.body}${signature}`;

  try {
    const info = await (await transport(config)).sendMail({
      from: { name: config.displayName, address: config.address },
      to,
      subject: input.subject.slice(0, 200),
      text,
    });
    await run(
      `INSERT INTO comms_events(id, channel, direction, peer, subject, body, status, external_id, meta, created_at)
       VALUES (?, 'email', 'outbound', ?, ?, ?, 'sent', ?, ?, ?)`,
      id('cm'),
      to,
      input.subject,
      truncate(text, 20_000),
      info.messageId ?? null,
      JSON.stringify({ tool: true }),
      now(),
    );
    logActivity({
      level: 'action',
      category: 'email',
      message: `Emailed ${to}: ${truncate(input.subject, 80)}`,
      meta: { to },
      taskId: input.context?.taskId ?? null,
    });
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    const message = (error as Error).message;
    await run(
      `INSERT INTO comms_events(id, channel, direction, peer, subject, body, status, external_id, meta, created_at)
       VALUES (?, 'email', 'outbound', ?, ?, ?, 'failed', NULL, ?, ?)`,
      id('cm'),
      to,
      input.subject,
      truncate(text, 20_000),
      JSON.stringify({ error: message }),
      now(),
    );
    logActivity({ level: 'error', category: 'email', message: `Email failed: ${truncate(message, 200)}` });
    return { ok: false, error: message };
  }
}

export interface InboxMessage {
  uid: string;
  from: string;
  subject: string;
  date: string;
  preview: string;
}

/** Read recent inbox headers. Never marks messages as read. */
export async function fetchInbox(limit = 15): Promise<{ ok: boolean; messages: InboxMessage[]; error?: string }> {
  const config = await emailConfig();
  const password = await getSecret('email:password');
  if (!config || !password) return { ok: false, messages: [], error: 'Email is not connected.' };

  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: true,
    auth: { user: config.username, pass: password },
    logger: false,
  });

  const messages: InboxMessage[] = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const mailbox = client.mailbox;
      const total = typeof mailbox === 'object' && mailbox ? mailbox.exists : 0;
      if (!total) return { ok: true, messages: [] };
      const start = Math.max(1, total - limit + 1);
      for await (const message of client.fetch(`${start}:${total}`, {
        envelope: true,
        flags: true,
        bodyStructure: true,
      })) {
        const envelope = message.envelope;
        const from = envelope?.from?.[0];
        messages.push({
          uid: String(message.uid),
          from: from ? `${from.name ?? ''} <${from.address ?? ''}>`.trim() : 'unknown',
          subject: envelope?.subject ?? '(no subject)',
          date: envelope?.date ? new Date(envelope.date).toISOString() : '',
          preview: `${envelope?.subject ?? ''}`.slice(0, 200),
        });
      }
    } finally {
      lock.release();
    }
    messages.reverse();
    await run(
      `INSERT INTO comms_events(id, channel, direction, peer, subject, body, status, external_id, meta, created_at)
       VALUES (?, 'email', 'inbound', ?, ?, ?, 'synced', NULL, ?, ?)`,
      id('cm'),
      'inbox',
      `Checked inbox (${messages.length} messages)`,
      '',
      JSON.stringify({ count: messages.length }),
      now(),
    );
    return { ok: true, messages };
  } catch (error) {
    return { ok: false, messages: [], error: (error as Error).message };
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export async function saveEmailConfig(config: EmailConfig): Promise<void> {
  await run(
    `INSERT INTO integrations(key, status, config, updated_at) VALUES ('email', 'connected', ?, ?)
     ON CONFLICT(key) DO UPDATE SET status = 'connected', config = excluded.config, updated_at = excluded.updated_at`,
    JSON.stringify(config),
    now(),
  );
  logActivity({ level: 'info', category: 'integration', message: `Connected email as ${config.address}.` });
}

export async function disconnectEmail(): Promise<void> {
  await run("UPDATE integrations SET status = 'disconnected', updated_at = ? WHERE key = 'email'", now());
  await run("DELETE FROM secrets WHERE key = 'email:password'");
  logActivity({ level: 'warn', category: 'integration', message: 'Disconnected email.' });
}

export async function emailHistory(limit = 40): Promise<unknown[]> {
  return await all(
    "SELECT * FROM comms_events WHERE channel = 'email' ORDER BY created_at DESC LIMIT ?",
    Math.min(limit, 200),
  );
}
