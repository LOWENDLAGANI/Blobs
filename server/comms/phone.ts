import { all, get, run } from '../db.ts';
import { getSecret, getSettings, setSecret } from '../settings.ts';
import { fetchWithTimeout, id, now, safeJson, truncate } from '../util.ts';
import { logActivity } from '../activity.ts';

export interface PhoneConfig {
  accountSid: string;
  fromNumber: string;
  ownerNumber: string;
  /** Public https origin Twilio can reach, e.g. https://blobs.example.com */
  publicBaseUrl: string;
  voice: string;
}

export function phoneConfig(): PhoneConfig | null {
  const row = get<{ config: string }>("SELECT config FROM integrations WHERE key = 'phone'");
  if (!row?.config) return null;
  const parsed = safeJson<Partial<PhoneConfig>>(row.config, {});
  if (!parsed.accountSid || !parsed.fromNumber || !parsed.publicBaseUrl) return null;
  return {
    accountSid: parsed.accountSid,
    fromNumber: parsed.fromNumber,
    ownerNumber: parsed.ownerNumber ?? '',
    publicBaseUrl: parsed.publicBaseUrl.replace(/\/$/, ''),
    voice: parsed.voice || 'Polly.Joanna',
  };
}

export function phoneStatus(): { ready: boolean; number: string | null; detail: string } {
  const config = phoneConfig();
  const token = getSecret('phone:authToken');
  if (!config) {
    return {
      ready: false,
      number: null,
      detail:
        'Not connected. A real phone number needs a telephony provider such as Twilio, which requires a card on file (trial credit is usually enough to start).',
    };
  }
  if (!token) return { ready: false, number: config.fromNumber, detail: 'Phone configured but the auth token is missing.' };
  return { ready: true, number: config.fromNumber, detail: `Calling from ${config.fromNumber}.` };
}

function twiml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`;
}

export function twimlSay(text: string, options: { gather?: boolean; action?: string } = {}): string {
  const say = `<Say voice="Polly.Joanna">${escapeXml(text)}</Say>`;
  if (!options.gather || !options.action) return twiml(say);
  return twiml(
    `<Gather input="speech" speechTimeout="auto" action="${escapeXml(options.action)}" method="POST">${say}</Gather>` +
      `<Say voice="Polly.Joanna">I didn't catch that. I'll end the call here — you can reach me on the website.</Say>`,
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function twilioRequest(
  config: PhoneConfig,
  path: string,
  body: URLSearchParams,
): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  const token = getSecret('phone:authToken');
  if (!token) return { ok: false, error: 'Missing auth token.' };
  const auth = Buffer.from(`${config.accountSid}:${token}`).toString('base64');
  try {
    const response = await fetchWithTimeout(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/${path}`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      },
      20_000,
    );
    const text = await response.text();
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      return { ok: false, error: String((data as { message?: string }).message ?? `HTTP ${response.status}`) };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export async function placeCall(input: { message: string; to?: string | null }): Promise<{ ok: boolean; error?: string }> {
  const config = phoneConfig();
  if (!config) return { ok: false, error: 'Phone is not connected.' };
  const to = (input.to || config.ownerNumber || '').trim();
  if (!to) return { ok: false, error: 'No destination number configured.' };

  const eventId = id('call');
  const message = truncate(input.message, 1200);
  run(
    `INSERT INTO comms_events(id, channel, direction, peer, subject, body, status, external_id, meta, created_at)
     VALUES (?, 'phone', 'outbound', ?, ?, ?, 'dialing', NULL, ?, ?)`,
    eventId,
    to,
    'Outbound call',
    message,
    JSON.stringify({ message }),
    now(),
  );

  const key = getSecret('phone:webhookKey');
  const actionUrl = `${config.publicBaseUrl}/api/voice/twiml?call=${encodeURIComponent(eventId)}&k=${encodeURIComponent(key ?? '')}`;
  const body = new URLSearchParams({
    To: to,
    From: config.fromNumber,
    Url: actionUrl,
    Method: 'POST',
  });

  const result = await twilioRequest(config, 'Calls.json', body);
  if (!result.ok) {
    run("UPDATE comms_events SET status = 'failed', meta = ? WHERE id = ?", JSON.stringify({ error: result.error }), eventId);
    logActivity({ level: 'error', category: 'phone', message: `Call failed: ${truncate(result.error ?? '', 200)}` });
    return { ok: false, error: result.error };
  }
  const sid = String((result.data as { sid?: string }).sid ?? '');
  run("UPDATE comms_events SET status = 'ringing', external_id = ? WHERE id = ?", sid, eventId);
  logActivity({ level: 'action', category: 'phone', message: `Placed a call to ${to}.` });
  return { ok: true };
}

/** TwiML for an outbound call answered by the owner. */
export function outboundTwiml(eventId: string): string | null {
  const row = get<{ body: string; subject: string }>('SELECT body, subject FROM comms_events WHERE id = ?', eventId);
  if (!row) return null;
  const config = phoneConfig();
  const continueUrl = config
    ? `${config.publicBaseUrl}/api/voice/twiml?call=${encodeURIComponent(eventId)}&k=${encodeURIComponent(
        getSecret('phone:webhookKey') ?? '',
      )}`
    : undefined;
  return twimlSay(
    `Hello, this is ${getSettingsName()}, an AI assistant calling on behalf of your owner. ${row.body}`,
    { gather: true, action: continueUrl },
  );
}

function getSettingsName(): string {
  return getSettings().companion.name;
}

export function inboundTwiml(): string {
  const config = phoneConfig();
  const action = config
    ? `${config.publicBaseUrl}/api/voice/twiml?inbound=1&k=${encodeURIComponent(getSecret('phone:webhookKey') ?? '')}`
    : undefined;
  return twimlSay(
    `Hello, this is ${getSettingsName()}, an AI assistant. How can I help?`,
    { gather: true, action },
  );
}

export function savePhoneConfig(config: PhoneConfig, authToken: string): void {
  run(
    `INSERT INTO integrations(key, status, config, updated_at) VALUES ('phone', 'connected', ?, ?)
     ON CONFLICT(key) DO UPDATE SET status = 'connected', config = excluded.config, updated_at = excluded.updated_at`,
    JSON.stringify(config),
    now(),
  );
  setSecret('phone:authToken', authToken);
  if (!getSecret('phone:webhookKey')) {
    setSecret('phone:webhookKey', cryptoRandom());
  }
  logActivity({ level: 'info', category: 'integration', message: `Connected phone ${config.fromNumber}.` });
}

function cryptoRandom(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return id('whk');
}

export function disconnectPhone(): void {
  run("UPDATE integrations SET status = 'disconnected', updated_at = ? WHERE key = 'phone'", now());
  run("DELETE FROM secrets WHERE key IN ('phone:authToken','phone:webhookKey')");
  logActivity({ level: 'warn', category: 'integration', message: 'Disconnected phone.' });
}

export function phoneHistory(limit = 40): unknown[] {
  return all("SELECT * FROM comms_events WHERE channel = 'phone' ORDER BY created_at DESC LIMIT ?", Math.min(limit, 200));
}

export function logCallEvent(input: {
  direction: 'inbound' | 'outbound';
  peer: string;
  body: string;
  status: string;
}): void {
  run(
    `INSERT INTO comms_events(id, channel, direction, peer, subject, body, status, external_id, meta, created_at)
     VALUES (?, 'phone', ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    id('cm'),
    input.direction,
    input.peer,
    input.direction === 'inbound' ? 'Incoming call' : 'Call',
    trunk(input.body),
    input.status,
    now(),
  );
}

function trunk(text: string): string {
  return truncate(text, 4000);
}
