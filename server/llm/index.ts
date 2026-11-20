import { count, run } from '../db.ts';
import { getSettings, providerApiKey, providerConfig, PROVIDERS } from '../settings.ts';
import { id, now, sleep } from '../util.ts';
import { geminiProvider } from './gemini.ts';
import { openAiCompatibleProvider } from './openai.ts';
import { LlmError } from './types.ts';
import type { ChatRequest, LlmEvent, LlmMessage, LlmProvider, ToolSchema } from './types.ts';

export type { ChatRequest, LlmEvent, LlmMessage, ToolSchema } from './types.ts';
export { LlmError } from './types.ts';

export function resolveProvider(providerId: string): { provider: LlmProvider; model: string } {
  const settings = getSettings();
  const config = providerConfig(providerId, settings);
  const model = providerId === settings.model.provider && settings.model.model
    ? settings.model.model
    : config.model;

  if (providerId === 'gemini') {
    return { provider: geminiProvider({ baseUrl: config.baseUrl, label: config.label }), model };
  }

  const baseUrl = providerId === 'custom' ? settings.model.customBaseUrl : config.baseUrl;
  if (!baseUrl) {
    throw new LlmError('The custom provider has no base URL configured.', {
      provider: 'Custom',
      hint: 'Settings → AI model → Custom base URL, e.g. http://127.0.0.1:1234/v1',
    });
  }
  if (providerId === 'openrouter') {
    return {
      provider: openAiCompatibleProvider({
        id: providerId,
        label: config.label,
        baseUrl,
        extraHeaders: { 'HTTP-Referer': 'https://blobs.local', 'X-Title': 'BLOBS' },
      }),
      model,
    };
  }
  return { provider: openAiCompatibleProvider({ id: providerId, label: config.label, baseUrl }), model };
}

export interface RunOptions extends ChatRequest {
  /** Label stored in the usage log, e.g. 'chat' or 'task'. */
  kind?: string;
  taskId?: string | null;
}

export function tokensUsedToday(): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const row = count(
    'SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS n FROM usage_log WHERE ts >= ?',
    start.getTime(),
  );
  return Number(row ?? 0);
}

export function usageSummary(): { today: number; totalCalls: number; failures: number; budget: number } {
  return {
    today: tokensUsedToday(),
    totalCalls: count('SELECT COUNT(*) AS n FROM usage_log'),
    failures: count('SELECT COUNT(*) AS n FROM usage_log WHERE ok = 0'),
    budget: getSettings().autonomy.dailyTokenBudget,
  };
}

function logUsage(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  ok: boolean,
  kind: string,
  taskId: string | null,
): void {
  run(
    `INSERT INTO usage_log(id, ts, provider, model, prompt_tokens, completion_tokens, ok, kind, task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id('use'),
    now(),
    provider,
    model,
    promptTokens,
    completionTokens,
    ok ? 1 : 0,
    kind,
    taskId,
  );
}

/**
 * Streams a model turn. Retries transient failures (429/5xx/network) only when
 * nothing has been emitted yet, so the owner never sees duplicated text.
 */
export async function* streamChat(options: RunOptions): AsyncGenerator<LlmEvent> {
  const settings = getSettings();
  const providerId = settings.model.provider;
  const budget = settings.autonomy.dailyTokenBudget;
  if (budget > 0 && tokensUsedToday() > budget) {
    throw new LlmError('The daily token budget is used up.', {
      provider: 'BLOBS',
      hint: 'Raise the budget in Settings → Autonomy, or wait until tomorrow.',
    });
  }

  const primary = resolveProvider(providerId);
  const attempts: { provider: LlmProvider; model: string }[] = [primary];

  const fallbackId = settings.model.fallbackProvider;
  if (fallbackId && fallbackId !== providerId) {
    try {
      attempts.push(resolveProvider(fallbackId));
    } catch {
      /* a broken fallback must not block the primary provider */
    }
  }

  let lastError: unknown = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const { provider, model } = attempts[index];
    const apiKey = providerApiKey(provider.id);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let emitted = false;
      let promptTokens = 0;
      let completionTokens = 0;
      try {
        for await (const event of provider.chat({ ...options, model }, apiKey)) {
          if (event.type === 'text' && event.delta) emitted = true;
          if (event.type === 'usage') {
            promptTokens = event.promptTokens;
            completionTokens = event.completionTokens;
          }
          yield event;
        }
        logUsage(provider.id, model, promptTokens, completionTokens, true, options.kind ?? 'chat', options.taskId ?? null);
        return;
      } catch (error) {
        lastError = error;
        const llmError = error instanceof LlmError ? error : null;
        if ((error as Error).name === 'AbortError') return;
        logUsage(provider.id, model, promptTokens, completionTokens, false, options.kind ?? 'chat', options.taskId ?? null);
        const retryable = llmError?.retryable ?? true;
        if (emitted || !retryable || attempt === 2) break;
        await sleep(600 * 2 ** attempt + Math.random() * 250);
      }
    }
    if (index < attempts.length - 1) {
      // Fall through to the configured backup provider.
      continue;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('The model request failed.');
}

/** Non-streaming helper for planning, summaries and titles. */
export async function complete(
  system: string,
  user: string,
  options: { maxTokens?: number; temperature?: number; kind?: string } = {},
): Promise<string> {
  const settings = getSettings();
  let text = '';
  for await (const event of streamChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    tools: [],
    model: settings.model.model,
    temperature: options.temperature ?? 0.4,
    maxTokens: options.maxTokens ?? 900,
    kind: options.kind ?? 'internal',
  })) {
    if (event.type === 'text') text += event.delta;
  }
  return text.trim();
}

export function providerCatalog(): unknown {
  const settings = getSettings();
  return Object.entries(PROVIDERS).map(([key, config]) => ({
    id: key,
    label: config.label,
    note: config.note,
    model: key === 'custom' ? settings.model.model : config.model,
    baseUrl: key === 'custom' ? settings.model.customBaseUrl : config.baseUrl,
    supportsTools: config.supportsTools,
    hasKey: providerApiKey(key) !== null,
    active: settings.model.provider === key,
  }));
}

/** Quick key check used by Settings to confirm a provider works before saving. */
export async function testProvider(providerId: string): Promise<{ ok: boolean; message: string }> {
  const settings = getSettings();
  const restore = settings.model.provider;
  try {
    const { provider, model } = resolveProvider(providerId);
    let text = '';
    for await (const event of provider.chat(
      {
        model: providerId === restore ? settings.model.model || model : model,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        tools: [],
        temperature: 0,
        maxTokens: 16,
      },
      providerApiKey(providerId),
    )) {
      if (event.type === 'text') text += event.delta;
    }
    return { ok: true, message: `${provider.label} responded: ${text.trim().slice(0, 60) || '(empty)'}` };
  } catch (error) {
    const err = error as LlmError;
    return { ok: false, message: `${err.message}${err.hint ? ` ${err.hint}` : ''}` };
  }
}
