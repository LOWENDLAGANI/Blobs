import { all, get, run } from './db.ts';
import { decrypt, encrypt, now, safeJson } from './util.ts';

export type Tone = 'balanced' | 'warm' | 'direct' | 'playful';
export type AutonomyLevel = 'manual' | 'assisted' | 'autonomous';
export type AutonomyState = 'active' | 'paused' | 'stopped';

export interface ProviderConfig {
  label: string;
  baseUrl: string;
  model: string;
  supportsTools: boolean;
  note: string;
  builtin: boolean;
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    supportsTools: true,
    note: 'Very low cost per token; requires a small prepaid top-up. No long-term free tier.',
    builtin: true,
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
    supportsTools: true,
    note: 'Generous free tier (rate limited per minute and per day). Best zero-budget default.',
    builtin: true,
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    supportsTools: true,
    note: 'Paid per token. Optional, if you already have access.',
    builtin: true,
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    supportsTools: true,
    note: 'Free tier with high speed and daily limits. OpenAI-compatible.',
    builtin: true,
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    supportsTools: true,
    note: 'Has free models (suffix :free) with tight daily limits plus paid routing.',
    builtin: true,
  },
  ollama: {
    label: 'Local Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.1',
    supportsTools: true,
    note: 'Fully free and private, but only reachable if you self-host the server.',
    builtin: true,
  },
  custom: {
    label: 'Custom OpenAI-compatible',
    baseUrl: '',
    model: '',
    supportsTools: true,
    note: 'Any server that implements /chat/completions, e.g. LM Studio or vLLM.',
    builtin: true,
  },
};

export interface Settings {
  companion: {
    name: string;
    tagline: string;
    selfIntroduction: string;
  };
  owner: {
    name: string;
    timezone: string;
    pronouns: string;
  };
  personality: {
    tone: Tone;
    verbosity: 'concise' | 'normal' | 'detailed';
    formality: number;
    customInstructions: string;
    spokenStyle: string;
  };
  model: {
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
    fallbackProvider: string;
    customBaseUrl: string;
  };
  voice: {
    voiceURI: string;
    rate: number;
    pitch: number;
    autoListen: boolean;
    bargeIn: boolean;
    handsFree: boolean;
    silenceMs: number;
    speakInterim: boolean;
  };
  autonomy: {
    level: AutonomyLevel;
    state: AutonomyState;
    backgroundEnabled: boolean;
    maxStepsPerTask: number;
    maxToolCallsPerTask: number;
    dailyTokenBudget: number;
    proactiveCheckIns: boolean;
    requireApproval: {
      financial: boolean;
      deletion: boolean;
      publishing: boolean;
      externalMessages: boolean;
      security: boolean;
    };
  };
  memory: {
    autoSummarize: boolean;
    maxInjected: number;
    retentionDays: number;
  };
  notifications: {
    browser: boolean;
    email: string;
    notifyOnTaskComplete: boolean;
    notifyOnApproval: boolean;
    notifyOnError: boolean;
  };
  computer: {
    enabled: boolean;
    requireApproval: boolean;
    desktop: boolean;
    timeoutMinutes: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  companion: {
    name: 'BLOBS',
    tagline: 'Your personal agent',
    selfIntroduction:
      'I am BLOBS, your personal agent. I keep your context, do the legwork, and tell you honestly what I did.',
  },
  owner: {
    name: 'Owner',
    timezone: 'Asia/Kuala_Lumpur',
    pronouns: 'they/them',
  },
  personality: {
    tone: 'balanced',
    verbosity: 'normal',
    formality: 3,
    customInstructions: '',
    spokenStyle: 'Short, natural sentences. No lists read aloud unless asked.',
  },
  model: {
    provider: 'gemini',
    model: 'gemini-2.0-flash',
    temperature: 0.7,
    maxTokens: 1400,
    fallbackProvider: '',
    customBaseUrl: '',
  },
  voice: {
    voiceURI: '',
    rate: 1,
    pitch: 1,
    autoListen: true,
    bargeIn: true,
    handsFree: true,
    silenceMs: 1400,
    speakInterim: false,
  },
  autonomy: {
    level: 'assisted',
    state: 'active',
    backgroundEnabled: true,
    maxStepsPerTask: 12,
    maxToolCallsPerTask: 40,
    dailyTokenBudget: 150000,
    proactiveCheckIns: false,
    requireApproval: {
      financial: true,
      deletion: true,
      publishing: true,
      externalMessages: true,
      security: true,
    },
  },
  memory: {
    autoSummarize: true,
    maxInjected: 8,
    retentionDays: 0,
  },
  notifications: {
    browser: true,
    email: '',
    notifyOnTaskComplete: true,
    notifyOnApproval: true,
    notifyOnError: true,
  },
  computer: {
    enabled: true,
    requireApproval: false,
    desktop: true,
    timeoutMinutes: 20,
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = isPlainObject(base) ? { ...(base as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      out[key] = deepMerge(current, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

const SETTINGS_KEY = 'app';

export function getSettings(): Settings {
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', SETTINGS_KEY);
  const stored = safeJson<Record<string, unknown>>(row?.value, {});
  return deepMerge(DEFAULT_SETTINGS, stored);
}

export function saveSettings(patch: unknown): Settings {
  const merged = deepMerge(getSettings(), patch);
  run(
    `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    SETTINGS_KEY,
    JSON.stringify(merged),
    now(),
  );
  return merged;
}

/* ------------------------------------------------------------------ */
/* Secrets: encrypted at rest, never returned to the browser.          */
/* ------------------------------------------------------------------ */

export function getSecret(key: string): string | null {
  const row = get<{ value: string }>('SELECT value FROM secrets WHERE key = ?', key);
  if (!row) return null;
  return decrypt(row.value);
}

export function setSecret(key: string, value: string | null): void {
  if (value === null || value.trim() === '') {
    run('DELETE FROM secrets WHERE key = ?', key);
    return;
  }
  run(
    `INSERT INTO secrets(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    encrypt(value.trim()),
    now(),
  );
}

export function hasSecret(key: string): boolean {
  return getSecret(key) !== null;
}

export function secretKeys(): string[] {
  return all<{ key: string }>('SELECT key FROM secrets').map((row) => row.key);
}

/** Provider keys are read from the encrypted store, then from the environment. */
export function providerApiKey(provider: string): string | null {
  const fromStore = getSecret(`provider:${provider}`);
  if (fromStore) return fromStore;
  const envName = `${provider.toUpperCase()}_API_KEY`;
  const fromEnv = process.env[envName];
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : null;
}

export function activeProviderId(settings: Settings = getSettings()): string {
  return settings.model.provider || 'gemini';
}

export function providerConfig(provider: string, settings: Settings = getSettings()): ProviderConfig {
  const builtin = PROVIDERS[provider] ?? PROVIDERS.custom;
  if (provider === 'custom') {
    return {
      ...builtin,
      baseUrl: settings.model.customBaseUrl || builtin.baseUrl,
      model: settings.model.model || builtin.model,
    };
  }
  return builtin;
}

export function activeModelLabel(settings: Settings = getSettings()): string {
  const provider = providerConfig(settings.model.provider, settings);
  const model = providerConfig(settings.model.provider, settings).model;
  return `${provider.label} · ${settings.model.model || model}`;
}
