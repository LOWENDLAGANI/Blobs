# BLOBS

A persistent, voice-first, **autonomous** personal AI agent. Not a chatbot with a nicer skin — one continuous agent with
its own identity, long-term memory, a task engine that keeps working after you close the tab, and a control centre to
watch and steer it.

It acts on its own. Voice and chat are the whole interface: there is no approval prompt, card or manual gate between
what BLOBS decides and what it does.

Built to run on a free tier first: browser-native voice, free web research, Supabase Postgres as the whole backend, and
a model layer you can point at Gemini's free tier, a small DeepSeek top-up, or any OpenAI-compatible endpoint.

```
┌──────────────────────────────┐        ┌──────────────────────────────────────────┐
│  Web control centre (React)  │  SSE   │  Agent server (Node + Fastify)            │
│  voice · chat · tasks · mem  │◄──────►│  provider adapter · autonomous tool loop   │
└──────────────────────────────┘        │  task engine · scheduler · pg → Supabase  │
                                        └───────────────┬──────────────────────────┘
                                                        │
                             DeepSeek / Gemini / Groq / OpenRouter / Ollama / custom
                                                        │
                                        SMTP+IMAP email · Twilio calls (optional)
```

## Quick start

Requires **Node 22.18+** (the server runs its TypeScript sources directly, which is on by default from 22.18) and Postgres — a Supabase project is the intended backend, and its pooled connection string is
the only database setting there is.

```bash
npm install
npm run build
npm start            # http://localhost:3000
```

Set `DATABASE_URL` first (see [Backend: Supabase Postgres](#backend-supabase-postgres)); the schema is applied on
boot. No Supabase project yet? `docker compose up -d db` starts a local Postgres and the default URL already points at
it.

On first open you choose how the control centre is protected. With Supabase configured that is an email and password
through Supabase Auth, so you can sign in from any device; without it, it is a single owner passphrase, scrypt-hashed on
the server. Either way sessions are http-only cookies.

Then, in **Settings → Intelligence**, pick a provider and paste a key. Nothing else is required to start talking.

For development with hot reload:

```bash
npm run dev          # API on :8787
npm run web          # Vite UI on :3000, proxying /api
```

## Backend: Supabase Postgres

BLOBS keeps everything — memory, conversations, tasks, settings, sessions and activity — in one Postgres schema. The
server talks to it with `pg` over a single `DATABASE_URL`, so no data is trapped on a container's disk.

```bash
# 1. create a project at supabase.com
# 2. Project Settings → Database → Connection string → Connection pooling
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres

npm install && npm run build && npm start
```

That is the whole database setup. On boot the server applies
[`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql), which is idempotent: a brand-new project
bootstraps itself and re-running it is harmless. You can also paste that file into the Supabase SQL editor if you would
rather create everything up front.

Notes that matter in practice:

- **Use the pooled string** (port `6543`). It is built for a long-lived Node process and stays inside the free tier's
  connection limit. The direct string (port `5432`) also works but is IPv6-only on newer projects and caps out sooner.
- **Full-text search** moved with the database: the FTS5 virtual table and its three triggers are gone, replaced by a
  GIN index over an immutable `to_tsvector('english', …)` expression, scored with `ts_rank`. The hybrid ranking in
  `server/memory.ts` — relevance, importance, pinning, recency — is unchanged.
- **Timestamps are still integer milliseconds** (`bigint`) and flags are still `integer` 0/1, so date arithmetic and
  comparisons behave exactly as they did before the swap.
- **`.data/secret.key` is deliberately not in the database.** It encrypts the integration keys that *are* stored there.
  Set `BLOBS_SECRET` (32+ characters) on your host, or keep `DATA_DIR` on a volume; lose it and the stored provider and
  integration credentials must be re-entered.
- **Sessions live in Postgres**, so signing in on a phone and a laptop both work and a restart never logs you out.
- **Email sign-in replaces the owner passphrase** when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set. On first
  open you enter an email and a password; BLOBS creates the account through the Supabase Auth admin API and records only
  the address — the password is never stored in your database. Later sign-ins are checked against Supabase Auth, and
  BLOBS still issues its own http-only session cookie, so every route, CSRF check and session rule is unchanged. An
  existing passphrase install is asked to enrol an email once; memory, tasks and settings are untouched. Leave the two
  variables unset to keep the passphrase.
- **Workspace files can live in Supabase Storage too.** Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (Project
  Settings → API) and notes, downloads and sandbox transfers go to a private `blobs-workspace` bucket created on first
  use. The host then needs no disk at all, and files survive every redeploy. Leave them unset and they stay in
  `DATA_DIR/workspace`. The service-role key is used server-side only and never reaches the browser.
- **No Supabase keys reach the browser.** The anon and service-role keys are not used at all: the app connects to
  Postgres directly from the server. Row Level Security is therefore not the security boundary here — the owner
  passphrase, the http-only session cookie and same-origin checks are. Treat `DATABASE_URL` as a server-side secret.
- The free tier (500 MB, shared CPU) is far beyond one owner's usage of this app.

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

- Stored in Postgres with a GIN full-text index.
- Retrieval is hybrid: BM25 relevance, blended with importance, pinning and recency, then injected into the system
  prompt only when relevant. The whole history is never dumped in.
- Written three ways: the owner adds it manually, BLOBS decides to save something with the `remember` tool, and long
  conversations are summarised into durable facts.
- Self-correcting: `update_memory` fixes a memory that turns out wrong, folds duplicates into one and drops the
  copies; `forget_memory` deletes what is obsolete. Pinned memories are refused, because pinning is the owner's signal
  that it must be kept.
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
with a volume. It is **not** deployable to Cloudflare Workers/Sites, which cannot run a long-lived Node process. Free 24/7 hosting with a persistent volume is increasingly rare — plan for either a ~$2–5/month instance or a
machine you own. The app never silently upgrades itself to a paid service.

## Deployment: Vercel (container service + scheduler daemon)

`vercel.json` splits the app into the two shapes Vercel can run:

- **`blobs`** — a container service built from the `Dockerfile`. It serves the UI and the API, SSE included, and scales to
  zero when idle. It runs with `BLOBS_ROLE=server`, so it never starts the scheduler.
- **`scheduler`** — a **Vercel Daemon** using the same image with `command: ["node", "server/worker.ts"]`. Daemons stay
  running, so queued tasks and recurring responsibilities keep executing while nobody is using the app. It runs exactly
  one instance; two would claim the same tasks.

Set these on the Vercel project, then deploy:

| Variable | Why |
| --- | --- |
| `DATABASE_URL` | the Supabase pooled connection string |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | email sign-in and Storage — required here, because a container has no durable disk |
| `BLOBS_SECRET` | a stable encryption key instead of `secret.key` on disk |

Notes that matter:

- The image listens on **port 80**, Vercel's default for container services. Every other host must set `PORT`
  (docker-compose and `render.yaml` already do).
- **Daemons only run in production** during the beta; a preview deployment serves the UI but does no background work.
- Each request, including a streamed chat reply, is capped at **300s on Hobby and 800s on Pro**. Long-running work should
  be a task, which the daemon executes with no request attached.
- The daemon exposes `/health` on port 8081 for its liveness probe: a long task counts as healthy, a stalled loop does
  not, and Vercel restarts the instance when checks fail.

## Deployment: any container host (Docker)

The app is one Node process plus a static build, so a single image runs anywhere — Railway, Render, Fly.io, a VPS, or
your own machine. `render.yaml` is a ready blueprint and `docker-compose.yml` runs the whole stack locally.

```bash
docker build -t blobs .
docker run -p 3000:3000 -v blobs-data:/data \
  -e PORT=3000 \
  -e DATABASE_URL='postgresql://…pooler.supabase.com:6543/postgres' \
  -e BLOBS_SECRET='a-long-random-string' \
  blobs
```

Then open `http://localhost:3000` or the host's public URL. `GET /api/health` reports the version and whether the app
reached Postgres; that is the endpoint the Render health check uses.

What the host has to provide:

- **`DATABASE_URL`** — the Supabase pooled connection string. The database itself needs no disk.
- **`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`** — moves the file workspace into Supabase Storage, so the host needs no
  disk. Without them, workspace files go to `DATA_DIR` and a volume is required. Either way, set `BLOBS_SECRET` so the
  encryption key does not have to live on disk.
- **One always-on process.** The scheduler that executes background tasks runs inside the server. Serverless functions
  and free tiers that sleep when idle are the wrong shape: a sleeping BLOBS cannot run its tasks. Render's free
  instance spins down and has no disk, which is why the blueprint asks for the smallest paid instance.
- **One instance, not several.** The scheduler assumes a single worker; extra replicas would claim the same tasks.

## Deployment: a Daytona sandbox that stays awake

[Daytona](https://www.daytona.io) is the supported always-on host: a Linux sandbox with a real disk, which can be told not
to sleep. That is the piece a free PaaS usually takes away — idle apps are stopped, and a stopped BLOBS cannot run its
scheduler or finish a background task.

```bash
export DAYTONA_API_KEY=...      # app.daytona.io → Keys (or put it in .env)
npm run deploy:daytona          # create (or reuse) the sandbox, build, start, print the URL

node scripts/daytona.ts status  # sandbox state and public URL
node scripts/daytona.ts logs    # last 200 lines of the server log
node scripts/daytona.ts backup  # download .data (database, workspace, secret.key)
node scripts/daytona.ts stop    # take it offline; the disk, database and workspace are kept
node scripts/daytona.ts start   # bring the same sandbox back and relaunch BLOBS
node scripts/daytona.ts destroy # delete the sandbox and everything on it
```

The script creates a sandbox named `blobs` from `node:22` with `idleExpirySeconds: DISABLED`, so inactivity never stops
it, and exposes port 3000 at an HTTPS preview URL. Re-running `npm run deploy:daytona` reuses that sandbox, replaces only
the code, and leaves `.data/` alone — memory, tasks and encrypted integration keys survive a redeploy. The sandbox id and
URL are recorded in `.daytona.json` (git-ignored). If you create the sandbox in the Daytona dashboard instead, set
**auto-stop to `0`** yourself.

The server runs under a small supervisor inside the sandbox: if it crashes it restarts after three seconds, and
`server.log` is rotated to `server.log.1` once it passes 5 MB. `backup` downloads `.data` — the database, the workspace
and `secret.key` — into `.data/backups/` on this machine, or to the path you pass after `backup`.

What to keep in mind:

- The preview URL is public. BLOBS still asks for the owner passphrase, so make that passphrase strong: it is the only
  thing in front of the login. Stop the sandbox or remove the preview endpoint to take it offline.
- Without auto-stop, the sandbox bills for as long as it runs. The script clears the idle policy, but a project-level
  wall-clock timeout can still apply — check Daytona's pricing and lifecycle defaults before leaving it up. To keep the
  quiet hours free, stop it from your own cron (`0 1 * * * cd /path/to/Blobs && node scripts/daytona.ts stop`) and
  start it again in the morning (`0 8 * * *`). Scheduled tasks do not run while the sandbox is stopped.
- The disk survives `stop`/`start`, not `destroy`. For memory that outlives the sandbox, point `DATABASE_URL` at Supabase (above)
  or keep a copy of `.data/`.
- Your local `.env` is read at deploy time and passed to the remote server process. It is not uploaded as a file, and
  `DAYTONA_API_KEY` is filtered out so the hosting credential never enters the sandbox.

## Tools

| Tool | Needs | Risk |
| --- | --- | --- |
| `web_search` | free network | low |
| `fetch_page` | free network | low |
| `remember`, `recall` | — | low |
| `update_memory`, `forget_memory` | — | low (pinned memories are refused) |
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
| `browser` (open/snapshot/click/type/press/back/extract/screenshot/close) | E2B key | medium |
| `send_email` | SMTP/IMAP mailbox | high |
| `make_phone_call` | Twilio | high |

Adding a tool is one object in `server/agent/tools.ts`: name, description, JSON schema, risk level, implementation.
The agent loop and task planner pick it up automatically.

Tool output is always treated as **untrusted data** and fenced as such in the prompt. The system prompt states that
instructions found in webpages, files or messages must never override the owner's rules, and the execution limits and
emergency stop are enforced in server code — not by asking the model nicely.

`fetch_page` blocks loopback, private, link-local and metadata-style addresses, and refuses non-http(s) schemes. It also
resolves the hostname and checks every address that comes back, so a public name pointing at `127.0.0.1` is refused, and
it follows redirects by hand with the same check on each hop.

## The cloud computer (E2B)

BLOBS can own a real Linux machine through [E2B](https://e2b.dev): not a simulator, an isolated cloud VM with
persistent files, a shell, any language runtime, package installation, long-running servers with public HTTPS URLs, and
an optional graphical desktop.

This is the agent's machine, not the machine BLOBS runs on. Hosting comes from the Daytona sandbox above, and the two
use separate keys (`DAYTONA_API_KEY` for the host, `E2B_API_KEY` for the computer). Neither key is shared with the other
provider, and the Daytona key is never placed in the E2B environment.

Connect it in **Integrations → Cloud computer** with an E2B API key. Sandboxes are created on first use, their ids are
stored in Postgres, and later actions reconnect (auto-resuming a paused sandbox) so work continues on the same machine.

- **Shell:** `run_shell` for git, curl, compilers, scripts — up to two minutes per command.
- **Code:** `run_code` writes and executes Python, JavaScript or Bash, returning stdout, stderr and the exit code.
- **Packages:** `install_packages` with apt, pip or npm.
- **Files:** list, read, write, move, delete, plus transfer to and from the BLOBS workspace.
- **Servers:** start a process in the background and get `https://<port>-<id>.e2b.app`.
- **Desktop:** `desktop_action` drives a real X11 desktop with a browser — screenshots, clicks, typing, key chords,
  scrolling, dragging, opening URLs and launching apps. The latest screenshot is shown in **Integrations → Computer**,
  so you can watch what it is doing.
- **Browsing:** `browser` drives a real Chromium page on the same machine. It opens a URL and reports the
  interactive elements it finds with **numbers** — links, buttons, inputs — so `click` and `type` name an element
  instead of guessing at CSS. `extract` pulls out text, links or HTML, `screenshot` saves a PNG into the BLOBS
  workspace, and one page stays open between calls, so signing in and then filling a form is a single session.

The first browser call installs Playwright and Chromium inside the sandbox, which takes a few minutes; the tool says
so and the next call works. Screenshots land in the workspace under `screenshots/`. To drive your own browser container
instead of E2B, set `BROWSER_BASE_URL` (plus `BROWSER_TOKEN` if that daemon checks one) and run
`server/computer/browser-daemon.mjs` there.

Safety: the VM is isolated from your own computer, and no BLOBS secret is ever injected into its environment. Computer
use can be switched off entirely or limited to non-desktop work in **Settings → Computer**; there is no per-action
approval, because BLOBS acts autonomously. The emergency stop blocks all computer tools immediately.

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

BLOBS is **autonomous-first**. Voice and chat are the front door, and no screen ever asks you to approve an action.

- **No approval step.** Money, deletion, publishing, external messages and security changes execute immediately. The
  server does not create approval requests, so nothing can pause waiting for a decision.
- **One mode.** Autonomy is always `autonomous`, with background work on. Old settings rows that still contain manual
  modes or approval gates are upgraded when they are read.
- **Guardrails, not permission slips**: steps per task, tool calls per task, daily token budget.
- **Pause** stops new work after the current step. **Emergency stop** blocks every side-effecting tool immediately and
  is the only thing that can stop the agent acting.
- **Proactive check-ins** let it review open work and act on one useful thing roughly once an hour.
- Everything is logged: tool calls, plans, messages, errors, retries, model usage.

## Security model

- Single owner. With Supabase Auth configured the password lives in Supabase and sign-in is verified server-side; without
  it the passphrase is scrypt-hashed locally. Either way the session is an http-only cookie, logins are throttled, and no
  credential is ever stored in plaintext or sent to the browser.
- Mutating requests must be same-origin (CSRF), and secrets are encrypted at rest.
- All API routes except health, auth and the signed Twilio webhook require a session.
- The Twilio webhook requires a per-install secret in the query string.
- SSRF guard on outbound fetches; path sandbox for files; no shell execution.
- The agent is instructed to refuse prompt-injection attempts, and every untrusted tool result is labelled as data.
- No credentials are ever sent to the browser, and no keys are written into the repository.

## Verification

```bash
npm run smoke        # 41 end-to-end checks against a throwaway local database (blobs_smoke)
node scripts/tools-check.ts   # live web research, files, sandbox, SSRF guard
npx tsc --noEmit
npm run build
```

`npm run smoke` boots a stub OpenAI-compatible model server and the real app, then exercises auth, streaming chat with a
tool call, memory persistence and retrieval, autonomous tool execution, the emergency stop, and background task
execution from plan to outcome. `scripts/tools-check.ts` additionally proves live web search and page reading, the SSRF guard, the
workspace sandbox, the JS sandbox, and that computer tools refuse cleanly when E2B is not connected.

## Project layout

```
server/
  index.ts            Fastify bootstrap, static SPA, scheduler start
  worker.ts           scheduler-only entrypoint for a split deployment (Vercel daemon)
  routes.ts           all HTTP + SSE endpoints
  db.ts               Postgres pool, ?→$n translation, schema bootstrap
  workspace.ts        agent file workspace: Supabase Storage, or disk when unconfigured
  auth.ts             owner passphrase, sessions, CSRF check
  settings.ts         defaults, providers, encrypted secrets
  memory.ts           memory CRUD + hybrid FTS5 retrieval
  approvals.ts        approval records (kept for old data; the agent never gates)
  llm/                provider adapters (OpenAI-compatible, Gemini) + retries
supabase/migrations/  Postgres schema, applied on boot (paste into Supabase SQL editor if you prefer)
  agent/              prompt, tool registry, agent loop, chat, tasks, scheduler
  comms/              email (SMTP/IMAP) and phone (Twilio)
  computer/           E2B sandbox manager (shell, code, files, servers, desktop)
  host.ts             Daytona host + E2B computer status for Integrations
web/src/
  app.tsx             auth gate, rail, live status, notifications
  voice.ts            speech engine (recognition, synthesis, barge-in, VAD)
  pages/              console, tasks, projects, memory, activity, comms, integrations, settings
scripts/              smoke + tools verification, Daytona host deploy
```

The database lives in `DATABASE_URL` (Supabase), workspace files in Supabase Storage when it is configured (and in
`.data/workspace` otherwise), and the E2B screenshot cache is transient. `secret.key` is replaced entirely by
`BLOBS_SECRET`, so a Supabase backup plus that one variable is a complete backup of BLOBS.
