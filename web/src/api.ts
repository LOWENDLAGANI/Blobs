export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: string }).error)
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return (data ?? {}) as T;
}

export const post = <T>(path: string, body?: unknown, init?: RequestInit): Promise<T> =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), ...init });

export const patch = <T>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

export const del = <T>(path: string): Promise<T> => api<T>(path, { method: 'DELETE' });

export type ChatEvent =
  | { type: 'meta'; conversationId: string; title: string; model: string; channel: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string; ok: boolean; summary: string }
  | { type: 'approval'; approval: { id: string; title: string; detail: string } }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'message'; message: Message }
  | { type: 'done'; conversationId: string; messageId: string; interrupted: boolean }
  | { type: 'error'; message: string };

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_name: string | null;
  created_at: number;
  untrusted: number;
}

export interface Conversation {
  id: string;
  title: string | null;
  channel: string;
  updated_at: number;
  created_at: number;
  message_count?: number;
  last_message?: string | null;
  summary?: string | null;
}

export async function streamChat(
  body: { conversationId?: string | null; text: string; voice?: boolean },
  onEvent: (event: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    let message = `The agent could not respond (${response.status}).`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      /* keep the generic message */
    }
    throw new ApiError(message, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload) as ChatEvent);
        } catch {
          /* ignore a malformed frame instead of killing the stream */
        }
      }
    }
  }
}

export interface LiveEvent {
  type: string;
  data: unknown;
}

export function connectEvents(onEvent: (event: LiveEvent) => void): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let retry = 0;

  const connect = (): void => {
    if (closed) return;
    source = new EventSource('/api/events');
    source.onmessage = (message) => {
      retry = 0;
      try {
        const parsed = JSON.parse(message.data) as LiveEvent;
        onEvent(parsed);
      } catch {
        /* ignore */
      }
    };
    source.onerror = () => {
      source?.close();
      source = null;
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 800 * retry);
    };
  };

  connect();
  return () => {
    closed = true;
    source?.close();
  };
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
