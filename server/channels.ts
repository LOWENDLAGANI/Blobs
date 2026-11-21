import crypto from 'node:crypto';
import { getSecret, getSettings } from './settings.ts';

/**
 * Outbound notification channels.
 *
 * The in-app notification list is always written. This module additionally
 * pushes a notification to Telegram and/or a signed webhook, so the agent can
 * reach the owner when they are away from the app. Sends are best-effort and
 * never block the work that produced them.
 */

export interface OutgoingNotification {
  title: string;
  body: string;
  level: 'info' | 'success' | 'warn' | 'error';
  link?: string | null;
  ts?: number;
}

export interface ChannelResult {
  channel: 'telegram' | 'webhook';
  ok: boolean;
  error?: string;
}

const LEVEL_RANK: Record<OutgoingNotification['level'], number> = { info: 0, success: 1, warn: 2, error: 3 };
const TIMEOUT_MS = 8_000;

function isAllowedWebhookUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

async function sendTelegram(notification: OutgoingNotification, chatId: string): Promise<ChannelResult> {
  const token = await getSecret('telegram:botToken');
  if (!token) return { channel: 'telegram', ok: false, error: 'No bot token saved.' };
  const text = `${notification.title}${notification.body ? `\n\n${notification.body}` : ''}`.slice(0, 4000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      return { channel: 'telegram', ok: false, error: `Telegram replied ${response.status}: ${detail}` };
    }
    return { channel: 'telegram', ok: true };
  } catch (error) {
    return { channel: 'telegram', ok: false, error: (error as Error).message };
  }
}

async function sendWebhook(notification: OutgoingNotification, url: string): Promise<ChannelResult> {
  if (!isAllowedWebhookUrl(url)) {
    return { channel: 'webhook', ok: false, error: 'Webhook must be HTTPS (HTTP is allowed only for localhost).' };
  }
  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    level: notification.level,
    link: notification.link ?? null,
    ts: notification.ts ?? Date.now(),
  });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-blobs-event': 'notification',
    'user-agent': 'BLOBS/1.0',
  };
  const secret = await getSecret('webhook:secret');
  if (secret) {
    headers['x-blobs-signature'] = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { channel: 'webhook', ok: false, error: `Endpoint replied ${response.status}.` };
    return { channel: 'webhook', ok: true };
  } catch (error) {
    return { channel: 'webhook', ok: false, error: (error as Error).message };
  }
}

/** Fan a notification out to every enabled channel that meets its level. */
export async function dispatchChannels(notification: OutgoingNotification): Promise<ChannelResult[]> {
  const settings = getSettings().notifications;
  const minLevel = settings.minLevel ?? 'info';
  if (LEVEL_RANK[notification.level] < LEVEL_RANK[minLevel]) return [];

  const sends: Promise<ChannelResult>[] = [];
  if (settings.telegram?.enabled && settings.telegram.chatId?.trim()) {
    sends.push(sendTelegram(notification, settings.telegram.chatId.trim()));
  }
  if (settings.webhook?.enabled && settings.webhook.url?.trim()) {
    sends.push(sendWebhook(notification, settings.webhook.url.trim()));
  }
  return Promise.all(sends);
}
