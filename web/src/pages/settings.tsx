import { useEffect, useState } from 'react';
import { api, patch, post, del } from '../api.ts';
import {
  Badge,
  Button,
  Card,
  Field,
  Icon,
  Input,
  PageHeader,
  Range,
  Select,
  TextArea,
  Toggle,
  useToast,
} from '../ui.tsx';
import type { AppSettings, ProviderInfo } from '../types.ts';

interface SettingsResponse {
  settings: AppSettings;
  providers: ProviderInfo[];
  providerNotes: Record<string, string>;
  usage: { today: number; totalCalls: number; failures: number; budget: number };
  version: string;
}

export function SettingsPage({ refreshShell }: { refreshShell: () => Promise<void> | void }) {
  const toast = useToast();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [passphrase, setPassphrase] = useState({ current: '', next: '' });
  const [channelSecrets, setChannelSecrets] = useState({ telegram: '', webhook: '' });
  const [channelResult, setChannelResult] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const response = await api<SettingsResponse>('/api/settings');
      setData(response);
      setDraft(response.settings);
    } catch (error) {
      toast((error as Error).message, 'bad');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const read = (): void => setVoices(synth.getVoices());
    read();
    synth.addEventListener('voiceschanged', read);
    return () => synth.removeEventListener('voiceschanged', read);
  }, []);

  const saveChannelSecret = async (key: 'telegram:botToken' | 'webhook:secret', value: string, field: 'telegram' | 'webhook'): Promise<void> => {
    if (!value.trim()) return toast('Paste the value first.', 'bad');
    setBusy(key);
    try {
      await post('/api/settings/secret', { key, value });
      setChannelSecrets((current) => ({ ...current, [field]: '' }));
      toast('Saved encrypted. It is never shown again.', 'good');
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const testChannels = async (): Promise<void> => {
    setBusy('channels');
    try {
      const result = await post<{ results: { channel: string; ok: boolean; error?: string }[] }>('/api/notifications/test');
      if (result.results.length === 0) setChannelResult('No channels enabled yet.');
      else setChannelResult(result.results.map((item) => `${item.channel}: ${item.ok ? 'sent' : item.error ?? 'failed'}`).join(' · '));
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const save = async (partial: unknown, label = 'Saved'): Promise<void> => {
    setBusy('save');
    try {
      const response = await patch<{ settings: AppSettings }>('/api/settings', partial);
      setDraft(response.settings);
      setData((current) => (current ? { ...current, settings: response.settings } : current));
      toast(label, 'good');
      await refreshShell();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const saveKey = async (): Promise<void> => {
    if (!draft) return;
    if (!apiKey.trim()) return toast('Paste the key first.', 'bad');
    setBusy('key');
    try {
      await post('/api/settings/provider-key', { provider: draft.model.provider, key: apiKey });
      setApiKey('');
      toast('Key stored encrypted on the server.', 'good');
      await load();
      await refreshShell();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const testProvider = async (provider: string): Promise<void> => {
    setBusy(`test:${provider}`);
    try {
      const result = await post<{ message: string }>('/api/settings/test-provider', { provider });
      toast(result.message, 'good');
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const setState = async (state: 'active' | 'paused' | 'stopped'): Promise<void> => {
    if (state === 'stopped' && !window.confirm('Emergency stop halts all autonomous work immediately. Continue?')) return;
    setBusy('state');
    try {
      await post('/api/settings/autonomy', { state });
      toast(state === 'stopped' ? 'Emergency stop engaged.' : state === 'paused' ? 'Autonomy paused.' : 'Autonomy resumed.', 'good');
      await load();
      await refreshShell();
    } finally {
      setBusy(null);
    }
  };

  const changePassphrase = async (): Promise<void> => {
    setBusy('pass');
    try {
      await post('/api/auth/passphrase', passphrase);
      setPassphrase({ current: '', next: '' });
      toast('Passphrase changed. You will be signed out on other devices.', 'good');
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  if (!data || !draft) {
    return (
      <div className="empty">
        <span className="empty-icon">
          <Icon name="gear" size={20} />
        </span>
        <h3>Loading settings…</h3>
      </div>
    );
  }

  const provider = data.providers.find((item) => item.id === draft.model.provider);
  const usagePercent = data.usage.budget > 0 ? Math.min(100, Math.round((data.usage.today / data.usage.budget) * 100)) : 0;

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="The model can change; BLOBS's identity, memory and work do not. Nothing here requires a paid service to stay running."
        actions={<Badge tone="neutral">v{data.version}</Badge>}
      />

      {/* ------------------------------- model ------------------------------- */}
      <p className="section-title">Intelligence</p>
      <Card className="stack">
        <div className="row-between">
          <div>
            <h3>Provider and model</h3>
            <p className="muted tiny">
              Active: <strong>{provider?.label ?? draft.model.provider}</strong> · {draft.model.model}
            </p>
          </div>
          <Button size="sm" variant="outline" busy={busy === `test:${draft.model.provider}`} onClick={() => void testProvider(draft.model.provider)}>
            Test connection
          </Button>
        </div>

        <div className="grid-2">
          <Field label="Provider">
            <Select
              value={draft.model.provider}
              onChange={(event) => {
                const next = event.target.value;
                const info = data.providers.find((item) => item.id === next);
                setDraft({
                  ...draft,
                  model: { ...draft.model, provider: next, model: info?.model ?? draft.model.model },
                });
              }}
            >
              {data.providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                  {item.hasKey ? ' · key saved' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model name">
            <Input
              value={draft.model.model}
              onChange={(event) => setDraft({ ...draft, model: { ...draft.model, model: event.target.value } })}
              placeholder="gemini-2.0-flash"
            />
          </Field>
        </div>

        {provider && <p className="note">{data.providerNotes[provider.id] ?? provider.note}</p>}

        {draft.model.provider === 'custom' && (
          <Field label="Custom base URL" hint="Any OpenAI-compatible /chat/completions server.">
            <Input
              value={draft.model.customBaseUrl}
              onChange={(event) => setDraft({ ...draft, model: { ...draft.model, customBaseUrl: event.target.value } })}
              placeholder="http://127.0.0.1:1234/v1"
            />
          </Field>
        )}

        <div className="grid-2">
          <Field label="API key" hint={provider?.hasKey ? 'A key is stored. Paste a new one to replace it.' : 'Stored encrypted; never returned to this browser.'}>
            <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="••••••••" />
          </Field>
          <div className="row" style={{ alignItems: 'flex-end', gap: 6, paddingBottom: 14 }}>
            <Button size="sm" busy={busy === 'key'} onClick={() => void saveKey()}>
              Save key
            </Button>
            {provider?.hasKey && (
              <Button
                size="sm"
                variant="quiet"
                onClick={async () => {
                  await del(`/api/settings/provider-key/${provider.id}`).catch(() => undefined);
                  await load();
                  toast('Key removed.', 'info');
                }}
              >
                Remove key
              </Button>
            )}
          </div>
        </div>

        <div className="grid-2">
          <Range
            label="Temperature"
            value={draft.model.temperature}
            min={0}
            max={1.4}
            step={0.1}
            onChange={(value) => setDraft({ ...draft, model: { ...draft.model, temperature: value } })}
            format={(value) => value.toFixed(1)}
          />
          <Field label="Max reply tokens">
            <Input
              type="number"
              value={draft.model.maxTokens}
              onChange={(event) => setDraft({ ...draft, model: { ...draft.model, maxTokens: Number(event.target.value) } })}
            />
          </Field>
        </div>

        <Field label="Fallback provider" hint="Used automatically when the active provider fails or hits a quota.">
          <Select
            value={draft.model.fallbackProvider}
            onChange={(event) => setDraft({ ...draft, model: { ...draft.model, fallbackProvider: event.target.value } })}
          >
            <option value="">None</option>
            {data.providers
              .filter((item) => item.id !== draft.model.provider)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
          </Select>
        </Field>

        <div className="row">
          <Button busy={busy === 'save'} onClick={() => void save({ model: draft.model }, 'Model settings saved.')}>
            Save model settings
          </Button>
          <span className="muted tiny">Changing models keeps every memory and conversation intact.</span>
        </div>
      </Card>

      {/* ----------------------------- identity ----------------------------- */}
      <p className="section-title">Identity and personality</p>
      <Card className="stack">
        <div className="grid-2">
          <Field label="Agent name">
            <Input value={draft.companion.name} onChange={(event) => setDraft({ ...draft, companion: { ...draft.companion, name: event.target.value } })} />
          </Field>
          <Field label="Tagline">
            <Input value={draft.companion.tagline} onChange={(event) => setDraft({ ...draft, companion: { ...draft.companion, tagline: event.target.value } })} />
          </Field>
        </div>
        <Field label="Self-introduction" hint="Read by the agent as its own identity.">
          <TextArea
            value={draft.companion.selfIntroduction}
            onChange={(event) => setDraft({ ...draft, companion: { ...draft.companion, selfIntroduction: event.target.value } })}
            rows={3}
          />
        </Field>
        <div className="grid-2">
          <Field label="Your name">
            <Input value={draft.owner.name} onChange={(event) => setDraft({ ...draft, owner: { ...draft.owner, name: event.target.value } })} />
          </Field>
          <Field label="Your timezone" hint="IANA name, e.g. Asia/Kuala_Lumpur.">
            <Input value={draft.owner.timezone} onChange={(event) => setDraft({ ...draft, owner: { ...draft.owner, timezone: event.target.value } })} />
          </Field>
        </div>

        <div className="grid-2">
          <Field label="Tone">
            <Select
              value={draft.personality.tone}
              onChange={(event) => setDraft({ ...draft, personality: { ...draft.personality, tone: event.target.value as AppSettings['personality']['tone'] } })}
            >
              <option value="balanced">Balanced</option>
              <option value="warm">Warm</option>
              <option value="direct">Direct</option>
              <option value="playful">Playful</option>
            </Select>
          </Field>
          <Field label="Verbosity">
            <Select
              value={draft.personality.verbosity}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  personality: { ...draft.personality, verbosity: event.target.value as AppSettings['personality']['verbosity'] },
                })
              }
            >
              <option value="concise">Concise</option>
              <option value="normal">Normal</option>
              <option value="detailed">Detailed</option>
            </Select>
          </Field>
        </div>

        <Range
          label="Formality"
          value={draft.personality.formality}
          min={1}
          max={5}
          step={1}
          onChange={(value) => setDraft({ ...draft, personality: { ...draft.personality, formality: value } })}
          format={(value) => (value <= 2 ? 'casual' : value >= 4 ? 'formal' : 'balanced')}
        />

        <Field label="Standing instructions" hint="Applied to every conversation and task.">
          <TextArea
            value={draft.personality.customInstructions}
            onChange={(event) => setDraft({ ...draft, personality: { ...draft.personality, customInstructions: event.target.value } })}
            rows={3}
            placeholder="Keep replies under four sentences. Always tell me when you are unsure."
          />
        </Field>

        <Field label="Spoken style" hint="How replies should sound when read out loud.">
          <TextArea
            value={draft.personality.spokenStyle}
            onChange={(event) => setDraft({ ...draft, personality: { ...draft.personality, spokenStyle: event.target.value } })}
            rows={2}
          />
        </Field>

        <Button
          busy={busy === 'save'}
          onClick={() =>
            void save(
              { companion: draft.companion, owner: draft.owner, personality: draft.personality },
              'Identity saved.',
            )
          }
        >
          Save identity
        </Button>
      </Card>

      {/* ------------------------------- voice ------------------------------ */}
      <p className="section-title">Voice</p>
      <Card className="stack">
        <p className="note">
          Voice runs entirely in the browser using your device's speech recognition and speech synthesis. It costs
          nothing, needs no extra API key, and no audio leaves the machine except to the browser's own speech service.
          Chrome, Edge and Safari support it best.
        </p>
        <Field label="Voice" hint="Available voices come from your operating system.">
          <Select
            value={draft.voice.voiceURI}
            onChange={(event) => setDraft({ ...draft, voice: { ...draft.voice, voiceURI: event.target.value } })}
          >
            <option value="">System default</option>
            {voices.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>
                {voice.name} ({voice.lang})
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid-2">
          <Range
            label="Speaking rate"
            value={draft.voice.rate}
            min={0.6}
            max={1.6}
            step={0.05}
            onChange={(value) => setDraft({ ...draft, voice: { ...draft.voice, rate: value } })}
            format={(value) => `${value.toFixed(2)}×`}
          />
          <Range
            label="Pitch"
            value={draft.voice.pitch}
            min={0.6}
            max={1.6}
            step={0.05}
            onChange={(value) => setDraft({ ...draft, voice: { ...draft.voice, pitch: value } })}
            format={(value) => value.toFixed(2)}
          />
        </div>
        <Range
          label="Silence before sending"
          value={draft.voice.silenceMs}
          min={600}
          max={3000}
          step={100}
          onChange={(value) => setDraft({ ...draft, voice: { ...draft.voice, silenceMs: value } })}
          format={(value) => `${(value / 1000).toFixed(1)}s`}
        />
        <Toggle
          checked={draft.voice.handsFree}
          onChange={(value) => setDraft({ ...draft, voice: { ...draft.voice, handsFree: value } })}
          label="Hands-free conversation"
          hint="Keep listening after BLOBS speaks, so you never press a button between sentences."
        />
        <Toggle
          checked={draft.voice.bargeIn}
          onChange={(value) => setDraft({ ...draft, voice: { ...draft.voice, bargeIn: value } })}
          label="Interrupt by speaking"
          hint="Detect your voice over BLOBS and stop its speech immediately. Tapping the orb always interrupts too."
        />
        <Toggle
          checked={draft.voice.autoListen}
          onChange={(value) => setDraft({ ...draft, voice: { ...draft.voice, autoListen: value } })}
          label="Start listening on connection"
        />
        <div className="row">
          <Button
            busy={busy === 'save'}
            onClick={() => void save({ voice: draft.voice }, 'Voice settings saved.')}
          >
            Save voice
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              if (!window.speechSynthesis) return;
              window.speechSynthesis.cancel();
              const utterance = new SpeechSynthesisUtterance('This is how I sound. Tell me if you want me faster, slower or softer.');
              const voice = voices.find((item) => item.voiceURI === draft.voice.voiceURI);
              if (voice) utterance.voice = voice;
              utterance.rate = draft.voice.rate;
              utterance.pitch = draft.voice.pitch;
              window.speechSynthesis.speak(utterance);
            }}
          >
            <Icon name="play" size={14} /> Preview
          </Button>
        </div>
      </Card>

      {/* ----------------------------- autonomy ---------------------------- */}
      <p className="section-title">Autonomous</p>
      <Card className="stack">
        <div className="row" style={{ gap: 8 }}>
          <Badge tone={draft.autonomy.state === 'stopped' ? 'bad' : draft.autonomy.state === 'paused' ? 'warn' : 'good'}>
            {draft.autonomy.state === 'active' ? 'autonomous' : draft.autonomy.state}
          </Badge>
          <span className="muted tiny">No approvals · background work always on</span>
        </div>

        <p className="small" style={{ color: 'var(--ink-2)' }}>
          BLOBS acts without asking. Money, deletion, publishing, external messages and security changes run immediately,
          so the limits below and the stop buttons are the real guardrails.
        </p>
        <Toggle
          checked={draft.autonomy.proactiveCheckIns}
          onChange={(value) => setDraft({ ...draft, autonomy: { ...draft.autonomy, proactiveCheckIns: value } })}
          label="Proactive check-ins"
          hint="Roughly once an hour, BLOBS reviews your open work and may suggest one useful action."
        />

        <div className="grid-2">
          <Field label="Steps per task step">
            <Input
              type="number"
              value={draft.autonomy.maxStepsPerTask}
              onChange={(event) => setDraft({ ...draft, autonomy: { ...draft.autonomy, maxStepsPerTask: Number(event.target.value) } })}
            />
          </Field>
          <Field label="Tool calls per task">
            <Input
              type="number"
              value={draft.autonomy.maxToolCallsPerTask}
              onChange={(event) => setDraft({ ...draft, autonomy: { ...draft.autonomy, maxToolCallsPerTask: Number(event.target.value) } })}
            />
          </Field>
        </div>
        <Field label="Daily token budget" hint="BLOBS stops autonomous work when this is reached. 0 disables the limit.">
          <Input
            type="number"
            value={draft.autonomy.dailyTokenBudget}
            onChange={(event) => setDraft({ ...draft, autonomy: { ...draft.autonomy, dailyTokenBudget: Number(event.target.value) } })}
          />
        </Field>

        <div className="row">
          <Button busy={busy === 'save'} onClick={() => void save({ autonomy: draft.autonomy }, 'Limits saved.')}>
            Save limits
          </Button>
        </div>

        <div className="row" style={{ gap: 8, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <Button size="sm" variant="outline" busy={busy === 'state'} onClick={() => void setState('paused')}>
            <Icon name="pause" size={14} /> Pause everything
          </Button>
          <Button size="sm" variant="outline" busy={busy === 'state'} onClick={() => void setState('active')}>
            <Icon name="play" size={14} /> Resume
          </Button>
          <Button size="sm" variant="danger" busy={busy === 'state'} onClick={() => void setState('stopped')}>
            <Icon name="stop" size={14} /> Emergency stop
          </Button>
        </div>
      </Card>

      {/* ------------------------------- memory ---------------------------- */}
      <p className="section-title">Memory</p>
      <Card className="stack">
        <Toggle
          checked={draft.memory.autoSummarize}
          onChange={(value) => setDraft({ ...draft, memory: { ...draft.memory, autoSummarize: value } })}
          label="Summarise long conversations into memory"
          hint="Keeps durable facts instead of the whole transcript. Uses a small model call."
        />
        <Range
          label="Memories injected per turn"
          value={draft.memory.maxInjected}
          min={0}
          max={20}
          step={1}
          onChange={(value) => setDraft({ ...draft, memory: { ...draft.memory, maxInjected: value } })}
        />
        <Field label="Forget after (days)" hint="0 keeps memories indefinitely. Pinned memories and decisions are always kept.">
          <Input
            type="number"
            value={draft.memory.retentionDays}
            onChange={(event) => setDraft({ ...draft, memory: { ...draft.memory, retentionDays: Number(event.target.value) } })}
          />
        </Field>
        <Button busy={busy === 'save'} onClick={() => void save({ memory: draft.memory }, 'Memory settings saved.')}>
          Save memory settings
        </Button>
      </Card>

      {/* ---------------------------- notifications ------------------------ */}
      <p className="section-title">Notifications</p>
      <Card className="stack">
        <Toggle
          checked={draft.notifications.browser}
          onChange={(value) => setDraft({ ...draft, notifications: { ...draft.notifications, browser: value } })}
          label="Browser notifications"
          hint="In-app notifications always appear; this also asks the browser for permission."
        />
        <Toggle
          checked={draft.notifications.notifyOnTaskComplete}
          onChange={(value) => setDraft({ ...draft, notifications: { ...draft.notifications, notifyOnTaskComplete: value } })}
          label="When a task finishes"
        />
        <Toggle
          checked={draft.notifications.notifyOnError}
          onChange={(value) => setDraft({ ...draft, notifications: { ...draft.notifications, notifyOnError: value } })}
          label="When something fails"
        />
        <Field label="Email me results at" hint="Requires the email identity to be connected.">
          <Input
            value={draft.notifications.email}
            onChange={(event) => setDraft({ ...draft, notifications: { ...draft.notifications, email: event.target.value } })}
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Only send out" hint="Filters channels; in-app notifications are always kept.">
          <Select
            value={draft.notifications.minLevel}
            onChange={(event) =>
              setDraft({
                ...draft,
                notifications: { ...draft.notifications, minLevel: event.target.value as 'info' | 'warn' | 'error' },
              })
            }
          >
            <option value="info">Everything</option>
            <option value="warn">Warnings and failures</option>
            <option value="error">Failures only</option>
          </Select>
        </Field>

        <p className="section-title" style={{ margin: '8px 0 0' }}>Telegram</p>
        <Toggle
          checked={draft.notifications.telegram.enabled}
          onChange={(value) =>
            setDraft({ ...draft, notifications: { ...draft.notifications, telegram: { ...draft.notifications.telegram, enabled: value } } })
          }
          label="Send notifications to Telegram"
          hint="Create a bot with @BotFather, then paste its token and your chat id."
        />
        <Field label="Chat id" hint="Message the bot once, then use @userinfobot or the getUpdates API to find your id.">
          <Input
            value={draft.notifications.telegram.chatId}
            onChange={(event) =>
              setDraft({ ...draft, notifications: { ...draft.notifications, telegram: { ...draft.notifications.telegram, chatId: event.target.value } } })
            }
            placeholder="123456789"
          />
        </Field>
        <Field label="Bot token" hint="Stored encrypted server-side; it never comes back to this page.">
          <div className="row">
            <Input
              type="password"
              value={channelSecrets.telegram}
              onChange={(event) => setChannelSecrets((current) => ({ ...current, telegram: event.target.value }))}
              placeholder="123456789:AA…"
            />
            <Button
              variant="outline"
              busy={busy === 'telegram:botToken'}
              onClick={() => void saveChannelSecret('telegram:botToken', channelSecrets.telegram, 'telegram')}
            >
              Save token
            </Button>
          </div>
        </Field>

        <p className="section-title" style={{ margin: '8px 0 0' }}>Webhook</p>
        <Toggle
          checked={draft.notifications.webhook.enabled}
          onChange={(value) =>
            setDraft({ ...draft, notifications: { ...draft.notifications, webhook: { ...draft.notifications.webhook, enabled: value } } })
          }
          label="POST notifications to a webhook"
          hint="HTTPS endpoint. Requests are JSON and optionally signed with HMAC-SHA256."
        />
        <Field label="Webhook URL">
          <Input
            value={draft.notifications.webhook.url}
            onChange={(event) =>
              setDraft({ ...draft, notifications: { ...draft.notifications, webhook: { ...draft.notifications.webhook, url: event.target.value } } })
            }
            placeholder="https://example.com/blobs"
          />
        </Field>
        <Field label="Signing secret (optional)" hint="Sent as x-blobs-signature: sha256=…">
          <div className="row">
            <Input
              type="password"
              value={channelSecrets.webhook}
              onChange={(event) => setChannelSecrets((current) => ({ ...current, webhook: event.target.value }))}
            />
            <Button
              variant="outline"
              busy={busy === 'webhook:secret'}
              onClick={() => void saveChannelSecret('webhook:secret', channelSecrets.webhook, 'webhook')}
            >
              Save secret
            </Button>
          </div>
        </Field>

        {channelResult && <p className="muted small">Test: {channelResult}</p>}

        <div className="row">
          <Button busy={busy === 'save'} onClick={() => void save({ notifications: draft.notifications }, 'Notification settings saved.')}>
            Save notifications
          </Button>
          <Button variant="outline" busy={busy === 'channels'} onClick={() => void testChannels()}>
            Send test
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              if (!('Notification' in window)) return toast('This browser has no notification support.', 'bad');
              const permission = await Notification.requestPermission();
              toast(permission === 'granted' ? 'Browser notifications enabled.' : 'Permission not granted.', permission === 'granted' ? 'good' : 'info');
            }}
          >
            Request browser permission
          </Button>
        </div>
      </Card>

      {/* ------------------------------- usage ----------------------------- */}
      <p className="section-title">Usage</p>
      <Card className="stack">
        <div className="row-between">
          <h3>Token budget today</h3>
          <span className="muted small">
            {data.usage.today.toLocaleString()} / {data.usage.budget.toLocaleString()}
          </span>
        </div>
        <div className="progress">
          <span style={{ width: `${usagePercent}%` }} />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Badge>{data.usage.totalCalls} model calls</Badge>
          <Badge tone={data.usage.failures > 0 ? 'warn' : 'good'}>{data.usage.failures} failures</Badge>
          <span className="muted tiny">Questions are counted per provider call, including tool steps and plans.</span>
        </div>
        <div className="stack" style={{ gap: 6 }}>
          {data.providers.map((item) => (
            <div key={item.id} className="row-between" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
              <div className="row" style={{ gap: 8 }}>
                <span className={`dot ${item.active ? 'success' : 'info'}`} />
                <span className="small">{item.label}</span>
                {item.active && <Badge tone="info">active</Badge>}
                {item.hasKey && <Badge tone="good">key</Badge>}
              </div>
              <span className="muted tiny">{item.note.split('.')[0]}.</span>
            </div>
          ))}
        </div>
      </Card>

      {/* ---------------------------- computer ---------------------------- */}
      <p className="section-title">Computer</p>
      <Card className="stack">
        <p className="note">
          BLOBS can have its own isolated Linux machine through E2B: a real shell, any language, package installs,
          long-running servers with public URLs, file transfer and a graphical desktop. It never touches your own
          computer. Add an E2B API key in <strong>Integrations → Cloud computer</strong> to switch it on.
        </p>
        <Toggle
          checked={draft.computer.enabled}
          onChange={(value) => setDraft({ ...draft, computer: { ...draft.computer, enabled: value } })}
          label="Allow computer use"
          hint="Shell, code, files, servers and package installs. Off means every computer tool refuses to run."
        />
        <Toggle
          checked={draft.computer.desktop}
          onChange={(value) => setDraft({ ...draft, computer: { ...draft.computer, desktop: value } })}
          label="Graphical desktop"
          hint="Screenshot, mouse and keyboard control of a full Linux desktop with a browser."
        />
        <Field label="Sandbox timeout (minutes)" hint="How long the machine stays alive after its last use. E2B caps this at 60 minutes on the free tier.">
          <Input
            type="number"
            value={draft.computer.timeoutMinutes}
            onChange={(event) => setDraft({ ...draft, computer: { ...draft.computer, timeoutMinutes: Number(event.target.value) } })}
          />
        </Field>
        <div className="row">
          <Button busy={busy === 'save'} onClick={() => void save({ computer: draft.computer }, 'Computer settings saved.')}>
            Save computer settings
          </Button>
          <Button variant="outline" onClick={() => (window.location.hash = '#/integrations')}>
            Open integrations
          </Button>
        </div>
      </Card>

      {/* ------------------------------ security --------------------------- */}
      <p className="section-title">Security</p>
      <Card className="stack">
        <p className="note">
          API keys are encrypted with a server-side master key and never sent to the browser. The interface is protected
          by a single owner passphrase, sessions are http-only cookies, and every state-changing request is checked for
          same-origin.
        </p>
        <div className="grid-2">
          <Field label="Current passphrase">
            <Input
              type="password"
              value={passphrase.current}
              onChange={(event) => setPassphrase({ ...passphrase, current: event.target.value })}
            />
          </Field>
          <Field label="New passphrase">
            <Input
              type="password"
              value={passphrase.next}
              onChange={(event) => setPassphrase({ ...passphrase, next: event.target.value })}
            />
          </Field>
        </div>
        <Button busy={busy === 'pass'} onClick={() => void changePassphrase()}>
          Change passphrase
        </Button>
      </Card>
    </>
  );
}
