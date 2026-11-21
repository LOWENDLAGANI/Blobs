import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  clock,
  del,
  post,
  streamChat,
  timeAgo,
  type Conversation,
  type Message,
} from '../api.ts';
import { useLive } from '../live.ts';
import { Badge, Button, Empty, Icon, Orb, useToast } from '../ui.tsx';
import { VoiceEngine, speechSupported, type VoiceState } from '../voice.ts';
import type { AppSettings } from '../types.ts';

interface OverviewShape {
  companion: { name: string; tagline: string };
  model: { provider: string; label: string; hasKey: boolean };
  autonomy: { state: string };
  approvals: number;
}

const SUGGESTIONS = [
  'What should we work on today?',
  'Research something I have been wondering about',
  'Check on my projects and tell me what matters',
];

export function ConsolePage({ overview }: { overview: OverviewShape | null }) {
  const toast = useToast();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [streamText, setStreamText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [tool, setTool] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [interim, setInterim] = useState('');
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [level, setLevel] = useState(0);
  const [session, setSession] = useState(false);
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [title, setTitle] = useState('New conversation');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);

  const engineRef = useRef<VoiceEngine | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sendRef = useRef<(text: string, voice: boolean) => void>(() => undefined);
  const sessionRef = useRef(false);
  const streamingRef = useRef(false);
  const conversationRef = useRef<string | null>(null);

  streamingRef.current = streaming;
  conversationRef.current = conversationId;

  /* ------------------------------ bootstrap ------------------------------ */

  useEffect(() => {
    void api<{ settings: AppSettings }>('/api/settings')
      .then((data) => {
        setSettings(data.settings);
        engineRef.current?.setOptions({
          rate: data.settings.voice.rate,
          pitch: data.settings.voice.pitch,
          voiceURI: data.settings.voice.voiceURI,
          silenceMs: data.settings.voice.silenceMs,
          bargeIn: data.settings.voice.bargeIn,
          handsFree: data.settings.voice.handsFree,
          autoListen: data.settings.voice.autoListen,
        });
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const engine = new VoiceEngine({
      rate: 1,
      pitch: 1,
      voiceURI: '',
      silenceMs: 1400,
      bargeIn: true,
      handsFree: true,
      autoListen: true,
    });
    engineRef.current = engine;
    engine.onState = (state) => setVoiceState(state);
    engine.onLevel = (value) => setLevel(value);
    engine.onInterim = (text) => setInterim(text);
    engine.onError = (message) => toast(message, 'bad');
    engine.onFinal = (text) => {
      if (streamingRef.current) {
        setDraft(text);
        return;
      }
      sendRef.current(text, true);
    };
    return () => {
      engine.stop();
      engineRef.current = null;
    };
  }, [toast]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, streamText, tool, interim]);

  const refreshConversation = useCallback(async (id: string) => {
    try {
      const data = await api<{ conversation: Conversation; messages: Message[] }>(`/api/conversations/${id}`);
      setMessages(data.messages.filter((message) => message.role === 'user' || message.role === 'assistant'));
      setTitle(data.conversation.title ?? 'Conversation');
    } catch {
      /* keep the optimistic transcript */
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const rows = await api<Conversation[]>('/api/conversations');
      setConversations(rows);
    } catch {
      /* transient */
    }
  }, []);

  useLive(['conversation', 'notification'], () => {
    if (!streamingRef.current) void loadHistory();
  });

  /* -------------------------------- sending ------------------------------ */

  const send = useCallback(
    async (raw: string, voice: boolean) => {
      const text = raw.trim();
      if (!text || streamingRef.current) return;
      const engine = engineRef.current;
      setError('');
      setInterim('');
      setDraft('');
      const local: Message = {
        id: `local_${Date.now()}`,
        conversation_id: conversationRef.current ?? 'local',
        role: 'user',
        content: text,
        tool_name: null,
        created_at: Date.now(),
        untrusted: 0,
      };
      setMessages((current) => [...current, local]);
      setStreaming(true);
      streamingRef.current = true;
      setStreamText('');
      if (voice && engine) {
        engine.pauseListening();
        engine.setThinking();
      }

      const controller = new AbortController();
      abortRef.current = controller;
      let accumulated = '';
      let convId = conversationRef.current;

      try {
        await streamChat(
          { conversationId: convId, text, voice },
          (event) => {
            switch (event.type) {
              case 'meta':
                convId = event.conversationId;
                conversationRef.current = event.conversationId;
                setConversationId(event.conversationId);
                setTitle(event.title);
                break;
              case 'text':
                accumulated += event.delta;
                setStreamText(accumulated);
                if (voice) engine?.speakStream(event.delta);
                break;
              case 'tool_start':
                setTool(event.name);
                break;
              case 'tool_end':
                setTool(null);
                break;
              case 'error':
                setError(event.message);
                if (voice) engine?.speak(event.message);
                break;
              default:
                break;
            }
          },
          controller.signal,
        );
      } catch (err) {
        const name = (err as Error).name;
        if (name !== 'AbortError') setError((err as Error).message || 'The connection dropped.');
      } finally {
        setStreaming(false);
        streamingRef.current = false;
        setTool(null);
        setStreamText('');
        abortRef.current = null;
        if (voice) engine?.finishTurn();
        if (convId) await refreshConversation(convId);
      }
    },
    [refreshConversation],
  );

  sendRef.current = (text, voice) => void send(text, voice);

  /* -------------------------------- session ------------------------------ */

  const beginSession = async (): Promise<void> => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!speechSupported()) {
      toast('This browser cannot do speech recognition. Chrome, Edge or Safari work best — text chat still works.', 'bad');
      return;
    }
    setSession(true);
    sessionRef.current = true;
    setMuted(false);
    setPaused(false);
    await engine.start();
    if (settings?.voice.autoListen === false) {
      engine.pauseListening();
      setPaused(true);
    }
  };

  const endSession = (): void => {
    engineRef.current?.stop();
    setSession(false);
    sessionRef.current = false;
    setPaused(false);
    setInterim('');
    setMuted(false);
  };

  const orbClick = (): void => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!session) {
      void beginSession();
      return;
    }
    if (voiceState === 'speaking') {
      engine.interrupt();
      return;
    }
    if (streaming) {
      abortRef.current?.abort();
      engine.interrupt();
      return;
    }
    endSession();
  };

  const interrupt = (): void => {
    abortRef.current?.abort();
    engineRef.current?.interrupt();
  };

  const toggleMute = (): void => {
    const engine = engineRef.current;
    if (!engine) return;
    const next = !muted;
    engine.mute(next);
    setMuted(next);
  };

  const togglePause = (): void => {
    const engine = engineRef.current;
    if (!engine) return;
    if (paused) {
      engine.resumeListening();
      setPaused(false);
    } else {
      engine.pauseListening();
      setPaused(true);
    }
  };

  const newConversation = (): void => {
    abortRef.current?.abort();
    engineRef.current?.cancelSpeech();
    setConversationId(null);
    conversationRef.current = null;
    setMessages([]);
    setTitle('New conversation');
    setError('');
    setHistoryOpen(false);
  };

  const openConversation = async (id: string): Promise<void> => {
    setHistoryOpen(false);
    setConversationId(id);
    conversationRef.current = id;
    setError('');
    await refreshConversation(id);
  };

  const removeConversation = async (id: string): Promise<void> => {
    await del(`/api/conversations/${id}`).catch(() => undefined);
    if (conversationId === id) newConversation();
    await loadHistory();
  };

  /* --------------------------------- render ------------------------------ */

  const stateLabel = (() => {
    if (!session) return 'Tap to start a voice session';
    if (voiceState === 'listening') return interim ? 'Listening…' : 'Listening';
    if (voiceState === 'thinking' || streaming) return tool ? `Working — ${tool.replace(/_/g, ' ')}` : 'Thinking…';
    if (voiceState === 'speaking') return 'Speaking — tap the orb to interrupt';
    return 'Here when you are';
  })();

  return (
    <div className="console-wrap">
      <div className="console">
        <div className="console-head">
          <div className="console-title">
            <span className="status-dot on" />
            <h2>{title}</h2>
            {overview?.model.hasKey === false && (
              <button className="badge badge-warn" onClick={() => (window.location.hash = '#/settings')}>
                Add a model key
              </button>
            )}
          </div>
          <div className="row">
            <span className="muted small">{overview?.model.label ?? ''}</span>
            <button className="icon-btn" onClick={() => { setHistoryOpen((open) => !open); void loadHistory(); }} aria-label="History">
              <Icon name="clock" size={18} />
            </button>
            <Button variant="ghost" size="sm" onClick={newConversation}>
              <Icon name="plus" size={15} /> New
            </Button>
          </div>
        </div>

        <div className="console-body">
          <div className="stage">
            <Orb state={voiceState} level={level} onClick={orbClick} label={stateLabel} />
            <p className="state-line">
              {stateLabel}
              {session && paused && <span className="faint"> · paused</span>}
            </p>

            {session ? (
              <div className="voice-controls">
                <button
                  className={`control-btn${muted ? ' active' : ''}`}
                  onClick={toggleMute}
                  title={muted ? 'Unmute BLOBS' : 'Mute BLOBS'}
                  aria-label={muted ? 'Unmute' : 'Mute'}
                >
                  <Icon name={muted ? 'x' : 'mic'} size={17} />
                </button>
                <button
                  className={`control-btn${paused ? ' active' : ''}`}
                  onClick={togglePause}
                  title={paused ? 'Resume listening' : 'Pause listening'}
                  aria-label={paused ? 'Resume' : 'Pause'}
                >
                  <Icon name={paused ? 'play' : 'pause'} size={16} />
                </button>
                <button className="control-btn" onClick={interrupt} title="Interrupt" aria-label="Interrupt">
                  <Icon name="stop" size={15} />
                </button>
                <button className="control-btn danger" onClick={endSession} title="End session" aria-label="End session">
                  <Icon name="x" size={17} />
                </button>
              </div>
            ) : (
              <p className="stage-hint">
                Voice is the main way to talk. BLOBS keeps listening between sentences, and you can interrupt it mid-sentence.
              </p>
            )}

            {!speechSupported() && session === false && (
              <p className="stage-hint">This browser has no speech recognition. Text chat works everywhere.</p>
            )}
          </div>

          <div className="transcript" ref={scrollRef}>
            {messages.length === 0 && !streamText && (
              <div className="empty" style={{ paddingTop: 28 }}>
                <span className="empty-icon">
                  <Icon name="spark" size={20} />
                </span>
                <h3>Start anywhere</h3>
                <p>Talk or type. BLOBS remembers what matters, and keeps working after you close the tab.</p>
                <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
                  {SUGGESTIONS.map((suggestion) => (
                    <button key={suggestion} className="badge" onClick={() => void send(suggestion, session)}>
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => (
              <div key={message.id} className={`msg ${message.role === 'user' ? 'msg-user' : 'msg-assistant'}`}>
                {message.role === 'assistant' && <span className="msg-avatar" />}
                <div>
                  <div className="bubble">{message.content}</div>
                  <div className="msg-time">{clock(message.created_at)}</div>
                </div>
              </div>
            ))}

            {streamText && (
              <div className="msg msg-assistant">
                <span className="msg-avatar" />
                <div>
                  <div className="bubble">{streamText}</div>
                </div>
              </div>
            )}

            {streaming && !streamText && (
              <div className="tool-pill">
                <span className="typing">
                  <span />
                  <span />
                  <span />
                </span>
                {tool ? `using ${tool.replace(/_/g, ' ')}` : 'thinking'}
              </div>
            )}

            {interim && <p className="live-line">“{interim}”</p>}

            {error && <div className="msg-error">{error}</div>}
          </div>
        </div>

        <div className="composer">
          <div className="composer-row">
            <textarea
              className="input"
              value={draft}
              placeholder={session ? 'Type instead of speaking…' : 'Message BLOBS…'}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send(draft, session);
                }
              }}
              rows={1}
            />
            {streaming ? (
              <Button variant="outline" onClick={interrupt}>
                <Icon name="stop" size={15} /> Stop
              </Button>
            ) : (
              <Button onClick={() => void send(draft, session)} disabled={!draft.trim()}>
                <Icon name="send" size={16} />
              </Button>
            )}
          </div>
          <div className="composer-meta">
            <span>
              {session ? (
                <>
                  Voice session · mic on · <Badge tone="good">hands-free</Badge>
                </>
              ) : (
                <>
                  Text mode · <button className="btn btn-quiet btn-sm" onClick={() => void beginSession()}>start voice</button>
                </>
              )}
            </span>
            <span>
              {overview?.autonomy.state === 'active'
                ? 'Autonomous · acting on its own'
                : `Autonomy ${overview?.autonomy.state ?? ''}`}
            </span>
          </div>
        </div>
      </div>

      {historyOpen && (
        <div className="history-panel">
          <div className="console-head">
            <h2>History</h2>
            <button className="icon-btn" onClick={() => setHistoryOpen(false)} aria-label="Close history">
              <Icon name="x" size={17} />
            </button>
          </div>
          <div className="history-list">
            {conversations.length === 0 && <Empty title="No conversations yet" body="Your first chat will appear here." />}
            {conversations.map((item) => (
              <div key={item.id} className="history-entry">
                <button
                  className={`history-item${conversationId === item.id ? ' active' : ''}`}
                  onClick={() => void openConversation(item.id)}
                >
                  <strong>{item.title ?? 'Conversation'}</strong>
                  <span className="muted tiny">
                    {timeAgo(item.updated_at)} · {item.message_count ?? 0} messages
                  </span>
                  {item.last_message && (
                    <span className="muted tiny truncate-line">{item.last_message}</span>
                  )}
                </button>
                <button
                  className="icon-btn history-delete"
                  onClick={() => void removeConversation(item.id)}
                  aria-label="Delete conversation"
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
