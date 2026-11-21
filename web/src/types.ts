export interface AppSettings {
  companion: { name: string; tagline: string; selfIntroduction: string };
  owner: { name: string; timezone: string; pronouns: string };
  personality: {
    tone: 'balanced' | 'warm' | 'direct' | 'playful';
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
    level: 'manual' | 'assisted' | 'autonomous';
    state: 'active' | 'paused' | 'stopped';
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
  memory: { autoSummarize: boolean; maxInjected: number; retentionDays: number };
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

export interface ProviderInfo {
  id: string;
  label: string;
  note: string;
  model: string;
  baseUrl: string;
  supportsTools: boolean;
  hasKey: boolean;
  active: boolean;
}

export interface Task {
  id: string;
  project_id: string | null;
  title: string;
  objective: string;
  status: 'queued' | 'running' | 'waiting_approval' | 'paused' | 'done' | 'failed' | 'cancelled';
  schedule: string | null;
  next_run_at: number | null;
  last_run_at: number | null;
  attempts: number;
  max_attempts: number;
  plan: string | null;
  checkpoint: string | null;
  result: string | null;
  error: string | null;
  origin: string;
  created_at: number;
  updated_at: number;
  step_total: number;
  step_done: number;
}

export interface TaskStep {
  id: string;
  task_id: string;
  idx: number;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  output: string | null;
  started_at: number | null;
  finished_at: number | null;
}

export interface Project {
  id: string;
  title: string;
  objective: string;
  status: 'active' | 'paused' | 'done';
  notes: string;
  created_at: number;
  updated_at: number;
  task_count?: number;
  open_tasks?: number;
}

export interface Responsibility {
  id: string;
  project_id: string | null;
  title: string;
  objective: string;
  cadence_minutes: number;
  status: 'active' | 'paused' | 'done';
  last_run_at: number | null;
  next_run_at: number | null;
  last_outcome: string | null;
  last_task_id: string | null;
  run_count: number;
  created_at: number;
  updated_at: number;
}

export interface MemoryItem {
  id: string;
  kind: string;
  content: string;
  tags: string;
  importance: number;
  source: string | null;
  pinned: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  use_count: number;
}

export interface ActivityItem {
  id: string;
  ts: number;
  level: 'info' | 'success' | 'warn' | 'error' | 'action';
  category: string;
  message: string;
  meta: string | null;
  task_id: string | null;
  conversation_id: string | null;
}

export interface ApprovalItem {
  id: string;
  kind: string;
  title: string;
  detail: string;
  payload: string;
  status: string;
  task_id: string | null;
  conversation_id: string | null;
  created_at: number;
  decided_at: number | null;
  decision_note: string | null;
}

export interface CommsItem {
  id: string;
  channel: string;
  direction: string;
  peer: string | null;
  subject: string | null;
  body: string | null;
  status: string;
  external_id: string | null;
  meta: string | null;
  created_at: number;
}
