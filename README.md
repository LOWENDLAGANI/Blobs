# BLOBS

A persistent, voice-first personal AI agent. Not a chatbot with a nicer skin — one continuous agent with its own
identity, long-term memory, a task engine that keeps working after you close the tab, and a control centre to watch and
steer it.

Built to run on a free tier first: browser-native voice, free web research, SQLite (on disk or in Turso Cloud), and a
model layer you can point at Gemini's free tier, a small DeepSeek top-up, or any OpenAI-compatible endpoint.

```
┌──────────────────────────────┐        ┌──────────────────────────────────────────┐
│  Web control centre (React)  │  SSE   │  Agent server (Node + Fastify)            │
│  voice · chat · tasks · mem  │◄──────►│  provider adapter · tool loop · approvals │
└──────────────────────────────┘        │  task engine · scheduler · libSQL → Turso  │
                                        └───────────────┬──────────────────────────┘
                                                        │
                             DeepSeek / Gemini / Groq / OpenRouter / Ollama / custom
                                                        │
                                        SMTP+IMAP email · Twilio calls (optional)
```

## Quick start

Requires **Node 22.6+**. The database driver is libSQL, which ships prebuilt binaries — nothing to compile.

```bash
npm install
npm run build
npm start            # http://localhost:3000
```

On first open you choose an owner passphrase. That single passphrase protects the control centre; it is scrypt-hashed
on the server, and sessions are http-only cookies.

Then, in **Settings → Intelligence**, pick a provider and paste a key. Nothing else is required to start talking.

For development with hot reload:

```bash
npm run dev          # API on :8787
npm run web          # Vite UI on :3000, proxying /api
```

## Where memory lives: local file or Turso

BLOBS keeps everything — memory, conversations, tasks, approvals, settings — in one SQLite schema. The client speaks
libSQL, so the same code runs against a file on the server or a Turso Cloud database across the network.

```bash
# 1. local file (default, works offline, nothing to sign up for)
DB_URL=file:.data/blobs.db

# 2. Turso Cloud — memory survives a lost, rebuilt or replaced server
turso auth login                          # once
turso db create blobs
turso db show blobs --url                 # → libsql://blobs-<org>.turso.io

DB_URL=libsql://blobs-<org>.turso.io
DB_AUTH_TOKEN=<token from `turso db tokens create blobs`>
```

Moving an existing local agent to Turso is a dump and an import, not a rewrite:

```bash
turso db shell blobs < <(sqlite3 .data/blobs.db .dump)   # or: turso db import blobs .data/blobs.db
```

**Embedded replica** is the best of both: reads hit a local file at disk speed, writes go to Turso, and the replica
pulls the rest on an interval. If the machine dies, the cloud copy is the source of truth.

```bash
DB_URL=file:.data/blobs.db
DB_SYNC_URL=libsql://blobs-<org>.turso.io
DB_AUTH_TOKEN=<token>
DB_SYNC_SECONDS=30
```

Notes that matter in practice:

- The schema and the memory ranking are unchanged: the `memories` table, the FTS5 index with the `porter` tokenizer,
the three sync triggers and `bm25(memories_fts, 1.0, 0.4)` all run on libSQL and Turso Cloud as-is.
- Turso's Free plan (100 databases, 5 GB, 500M rows read/month) is far beyond one owner's usage.
- `.data/secret.key` (or `BLOBS_SECRET`) encrypts stored integration keys and is deliberately **not** part of the
database. If you restore onto a new machine, either copy that key or re-enter the integration credentials.
- The server awaits schema creation before it accepts traffic, so a fresh Turso database bootstraps itself on first run.

## Models: what is actually free

| Provider | Key needed | Cost reality |
| --- | --- | --- |
| **Google Gemini** | yes | Generous free tier with per-minute and per-day limits. Best zero-budget default. |
| **DeepSeek** | yes | Very cheap, but requires a small prepaid top-up. No permanent free tier. |
| **Groq** | yes | Free tier with daily limits, very fast, OpenAI-compatible. |
| **OpenRouter** | yes | Some `:free` models with tight daily caps, plus paid routing. |
| **Ollama / LM Studio** | no | Completely free and private, but you must host the server yourself and keep it running. |
| **OpenAI** | yes | Paid per token. Optional. |

The active model is always visible in the top bar and on the console. Switching providers never touches identity,
memory, projects or conversation history — the model is a replaceable part, not the agent.

Failure handling is explicit: 401/402/403 produce a "check your key/credit" message, 429 is retried with backoff and can
fall through to the configured fallback provider, 404 tells you the model name is wrong, and network errors retry. The
daily token budget stops autonomous work rather than silently overspending.

Keys are encrypted with AES-256-GCM using a master key generated once into `DATA_DIR/secret.key` (or `BLOBS_SECRET`).
They are never returned to the browser — the API only reports whether a key exists.

## Voice: primary, and free

Voice is handled in the browser with the Web Speech API:

- one tap to open a session, continuous listening between sentences
- streaming speech: BLOBS starts speaking the first sentence while the rest is still generating
- barge-in by voice (VAD over a muted, echo-cancelled stream) **and** by tapping the orb or pressing Stop
- listening / thinking / speaking / idle states, mute, pause, end session
- live transcript, plus a text composer that shares the same conversation, so you can switch mid-thread without
  losing context

This costs nothing and needs no key, which is why it is the RM0 default. The `VoiceEngine` class is isolated, so a
Whisper/TTS provider can be added later without touching the agent.

Caveat: speech recognition requires Chrome, Edge or Safari. Firefox users get the text chat, and the UI says so instead
of pretending.

## Memory

- Stored in SQLite with an FTS5 index.
- Retrieval is hybrid: BM25 relevance, blended with importance, pinning and recency, then injected into the system
  prompt only when relevant. The whole history is never dumped in.
- Written three ways: the owner adds it manually, BLOBS decides to save something with the `remember` tool, and long
  conversations are summarised into durable facts.
- Fully inspectable: view, edit, pin, re-rank and delete every memory in **Memory**.
- Survives model changes and restarts; optional retention window, with pinned memories and decisions exempt.

## Background work

Tasks are durable rows, not in-memory promises:

1. An objective is planned into steps by the model (JSON plan, with a safe single-step fallback).
2. Each step runs the full tool loop with its own limits.
3. After every step the checkpoint is written, so a crash resumes rather than restarts.
4. Stale `running` tasks (dead process) are detected by heartbeat and requeued; too many interruptions fails them
   cleanly.
5. Recurring schedules (`hourly`, `daily`, `every:6h`) re-queue themselves.
6. Failures retry once automatically, then surface as a failed task with the real error.

The scheduler runs inside the server, not the browser. That is verified by the smoke test, which starts a task and
watches it complete with no client attached.

Hosting note: this needs a process with a persistent disk. It runs on a small VPS, a home server, or a container host
with a volume. It is **not** deployable to Cloudflare Workers/Sites, which cannot run a Node server or keep SQLite on
disk. Free 24/7 hosting with a persistent volume is increasingly rare — plan for either a ~$2–5/month instance or a
machine you own. The app never silently upgrades itself to a paid service.

## Tools

| Tool | Needs | Risk |
| --- | --- | --- |
| `web_search` | free network | low |
| `fetch_page` | free network | low |
| `remember`, `recall` | — | low |
| `write_note`, `read_file`, `list_files` | — | low |
| `run_js` | — | low (isolated VM: no network, no filesystem, 3s timeout) |
| `create_task`, `list_tasks`, `manage_project`, `notify_owner` | — | low/medium |
| `computer_status` | E2B key | low |
| `run_shell` | E2B key | medium |
| `run_code` (Python/JS/Bash) | E2B key | medium |
| `install_packages` (apt/pip/npm) | E2B key | medium |
| `sandbox_files` (list/read/write/move/delete) | E2B key | medium |
| `sandbox_transfer` (upload/download) | E2B key | medium |
| `start_server` + public URL | E2B key | medium |
| `desktop_action` (screenshot/click/type/keys/scroll/drag/open/launch) | E2B key | medium |
| `send_email` | SMTP/IMAP mailbox | high → approval |
| `make_phone_call` | Twilio | high → approval |

Adding a tool is one object in `server/agent/tools.ts`: name, description, JSON schema, risk level, implementation.
The agent loop, task planner and approval system pick it up automatically.

Tool output is always treated as **untrusted data** and fenced as such in the prompt. The system prompt states that
instructions found in webpages, files or messages must never override the owner's rules, and the approval gates are
enforced in server code — not by asking the model nicely.

`fetch_page` blocks loopback, private, link-local and metadata-style addresses, and refuses non-http(s) schemes.

## The cloud computer (E2B)

BLOBS can own a real Linux machine through [E2B](https://e2b.dev): not a simulator, an isolated cloud VM with
persistent files, a shell, any language runtime, package installation, long-running servers with public HTTPS URLs, and
an optional graphical desktop.

Connect it in **Integrations → Cloud computer** with an E2B API key. Sandboxes are created on first use, their ids are
stored in SQLite, and later actions reconnect (auto-resuming a paused sandbox) so work continues on the same machine.

- **Shell:** `run_shell` for git, curl, compilers, scripts — up to two minutes per command.
- **Code:** `run_code` writes and executes Python, JavaScript or Bash, returning stdout, stderr and the exit code.
- **Packages:** `install_packages` with apt, pip or npm.
- **Files:** list, read, write, move, delete, plus transfer to and from the BLOBS workspace.
- **Servers:** start a process in the background and get `https://<port>-<id>.e2b.app`.
- **Desktop:** `desktop_action` drives a real X11 desktop with a browser — screenshots, clicks, typing, key chords,
  scrolling, dragging, opening URLs and launching apps. The latest screenshot is shown in **Integrations → Computer**,
  so you can watch what it is doing.

Safety: the VM is isolated from your own computer, and no BLOBS secret is ever injected into its environment. Computer
use can be switched off entirely, limited to non-desktop work, or made to require your approval for **every** action in
**Settings → Computer**. The emergency stop blocks all computer tools immediately.

Cost and limits: E2B includes free credits, then bills per sandbox-second; the free tier also caps sandbox lifetime at
one hour. Default timeout here is 20 minutes, configurable up to 60, and **Reset sandbox** kills the machine and its
files. BLOBS reports E2B quota and auth errors instead of pretending an action worked.

Honest boundary: this is BLOBS's own cloud computer, not remote control of your laptop. Nothing in this project reads,
writes or clicks on your personal machine.

## Communication identity

**Email** (optional, free with any mailbox): sending over SMTP and header-only inbox reading over IMAP, both configured
in **Integrations**. Gmail needs an app password. Sent and failed messages are logged, and BLOBS signs as an AI.

**Phone** (optional, not free): Twilio outbound calls that speak a message and support a real two-way exchange through
TwiML `<Gather>`, sharing the same identity and memory as the website. Twilio requires a card on file; trial credit is
enough for a few tests. BLOBS states this plainly and will not claim a call happened unless Twilio accepted it.

**Messaging (WhatsApp/SMS)**: reported as *unavailable* rather than faked. Every real channel needs a paid provider or
business verification.

## Autonomy and control

- **Levels**: manual (only what you ask), assisted (research and prepare, propose bigger actions), autonomous (act
  within the rules).
- **Approval gates** for money, deletion, publishing, messaging people outside you, and security changes. Each can be
  toggled, but they are on by default and enforced server-side.
- A pending approval pauses the conversation or task and shows up in Activity, the top banner and notifications. The
  model can never approve its own action.
- **Execution limits**: steps per task, tool calls per task, daily token budget.
- **Pause** stops new work after the current step. **Emergency stop** blocks every side-effecting tool immediately.
- Everything is logged: tool calls, plans, approvals, errors, retries, model usage.

## Security model

- Single owner, scrypt-hashed passphrase, http-only session cookie, login throttling.
- Mutating requests must be same-origin (CSRF), and secrets are encrypted at rest.
- All API routes except health, auth and the signed Twilio webhook require a session.
- The Twilio webhook requires a per-install secret in the query string.
- SSRF guard on outbound fetches; path sandbox for files; no shell execution.
- The agent is instructed to refuse prompt-injection attempts, and every untrusted tool result is labelled as data.
- No credentials are ever sent to the browser, and no keys are written into the repository.

## Verification

```bash
npm run smoke        # 28 end-to-end checks against a throwaway database
node scripts/tools-check.ts   # live web research, files, sandbox, SSRF guard
npx tsc --noEmit
npm run build
```

`npm run smoke` boots a stub OpenAI-compatible model server and the real app, then exercises auth, streaming chat with a
tool call, memory persistence and retrieval, approval gating, the emergency stop, and background task execution from
plan to outcome. `scripts/tools-check.ts` additionally proves live web search and page reading, the SSRF guard, the
workspace sandbox, the JS sandbox, and that computer tools refuse cleanly when E2B is not connected.

## Project layout

```
server/
  index.ts            Fastify bootstrap, static SPA, scheduler start
  routes.ts           all HTTP + SSE endpoints
  db.ts               SQLite schema and helpers
  auth.ts             owner passphrase, sessions, CSRF check
  settings.ts         defaults, providers, encrypted secrets
  memory.ts           memory CRUD + hybrid FTS5 retrieval
  approvals.ts        approval queue
  llm/                provider adapters (OpenAI-compatible, Gemini) + retries
  agent/              prompt, tool registry, agent loop, chat, tasks, scheduler
  comms/              email (SMTP/IMAP) and phone (Twilio)
  computer/           E2B sandbox manager (shell, code, files, servers, desktop)
web/src/
  app.tsx             auth gate, rail, live status, notifications
  voice.ts            speech engine (recognition, synthesis, barge-in, VAD)
  pages/              console, tasks, projects, memory, activity, comms, integrations, settings
scripts/              smoke + tools verification
```

The database lives wherever `DB_URL` points (`.data/blobs.db` by default, or Turso). Everything else — the file
workspace, the E2B screenshot cache and `secret.key` — stays in `.data/`, so copy that directory (plus your Turso
database, if you use one) and you have backed up BLOBS.
