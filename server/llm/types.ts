export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; untrusted?: boolean }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; untrusted?: boolean };

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: LlmMessage[];
  tools: ToolSchema[];
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
}

export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; call: ToolCall }
  | { type: 'usage'; promptTokens: number; completionTokens: number };

export interface LlmProvider {
  id: string;
  label: string;
  chat(request: ChatRequest, apiKey: string | null): AsyncGenerator<LlmEvent, void, unknown>;
}

export class LlmError extends Error {
  status: number;
  provider: string;
  retryable: boolean;
  hint: string;

  constructor(message: string, options: { status?: number; provider?: string; retryable?: boolean; hint?: string } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = options.status ?? 0;
    this.provider = options.provider ?? 'unknown';
    this.retryable = options.retryable ?? false;
    this.hint = options.hint ?? '';
  }
}

/** Turn an HTTP failure into a message the owner can act on. */
export function describeHttpError(
  provider: string,
  status: number,
  body: string,
): LlmError {
  let detail = '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') detail = parsed.error;
    else if (parsed.error?.message) detail = parsed.error.message;
    else if (parsed.message) detail = parsed.message;
  } catch {
    detail = body.slice(0, 300);
  }

  if (status === 401 || status === 403) {
    return new LlmError(`${provider} rejected the API key.`, {
      status,
      provider,
      hint: 'Open Settings → AI model and save a valid key for this provider.',
    });
  }
  if (status === 402) {
    return new LlmError(`${provider} reports insufficient credit.`, {
      status,
      provider,
      hint: 'Top up the provider account, or switch to Gemini’s free tier in Settings.',
    });
  }
  if (status === 429) {
    return new LlmError(`${provider} rate limit or daily quota reached.`, {
      status,
      provider,
      retryable: true,
      hint: 'Wait for the quota window to reset, or switch provider in Settings.',
    });
  }
  if (status === 404) {
    return new LlmError(`${provider} does not recognise that model.`, {
      status,
      provider,
      hint: 'Check the model name in Settings. Gemini models are usually gemini-2.0-flash or gemini-2.5-flash.',
    });
  }
  return new LlmError(`${provider} request failed (${status}). ${detail}`.trim(), {
    status,
    provider,
    retryable: status >= 500,
    hint: status >= 500 ? 'This is usually temporary. BLOBS will retry automatically.' : '',
  });
}
