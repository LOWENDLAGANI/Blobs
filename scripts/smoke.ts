/**
 * End-to-end verification for BLOBS.
 *
 * Boots a stub OpenAI-compatible model server, starts the real BLOBS server
 * against a throwaway data directory, and exercises the actual HTTP API:
 * auth, streaming chat with a tool call, memory retrieval, autonomous tools,
 * the emergency stop and background task execution.
 *
 * Run with: npm run smoke
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const STUB_PORT = 8799;
const APP_PORT = 8811;
const DATA_DIR = path.resolve(import.meta.dirname, '..', '.data', 'smoke');
const BASE = `http://127.0.0.1:${APP_PORT}`;

let passes = 0;
let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passes += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/* ------------------------------ stub model ------------------------------ */

const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let body: { messages?: { role: string; content: string | null }[] } = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* keep empty */
    }
    const messages = body.messages ?? [];
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n');
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const sawToolResult = messages.some((m) => m.role === 'tool');

    const textResponse = (text: string): void => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const word of text.split(' ')) {
        res.write(sseChunk({ choices: [{ delta: { content: `${word} ` } }] }));
      }
      res.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30 } }));
      res.write('data: [DONE]\n\n');
      res.end();
    };

    const toolResponse = (name: string, args: unknown): void => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        sseChunk({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_smoke_1', function: { name, arguments: JSON.stringify(args) } }],
              },
            },
          ],
        }),
      );
      res.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
      res.write('data: [DONE]\n\n');
      res.end();
    };

    // Planner call
    if (system.includes('You plan work for an autonomous AI agent')) {
      textResponse(
        JSON.stringify({
          steps: [
            { description: 'Search the web for the objective and note the main findings.' },
            { description: 'Summarise the findings into a note and report the outcome.' },
          ],
        }),
      );
      return;
    }

    if (/reply with the single word: ready/i.test(lastUser)) {
      textResponse('ready');
      return;
    }

    // After a tool result, finish the turn.
    if (sawToolResult) {
      textResponse('All done — that is saved.');
      return;
    }

    if (/email/i.test(lastUser)) {
      toolResponse('send_email', {
        to: 'someone@example.com',
        subject: 'Smoke test',
        body: 'This should never actually send during the smoke test.',
      });
      return;
    }

    if (/remember/i.test(lastUser)) {
      toolResponse('remember', {
        content: 'The owner prefers short, direct answers with no preamble.',
        kind: 'preference',
        tags: ['style'],
        importance: 4,
      });
      return;
    }

    textResponse('I am here and listening.');
  });
});

/* -------------------------------- helpers -------------------------------- */

let cookie = '';

async function call<T>(method: string, route: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data: data as T };
}

async function waitFor(checker: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checker()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function chat(text: string): Promise<{ events: { type: string; [key: string]: unknown }[]; raw: string }> {
  const response = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text, voice: false }),
  });
  const raw = await response.text();
  const events: { type: string; [key: string]: unknown }[] = [];
  for (const block of raw.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(5).trim()));
    } catch {
      /* ignore */
    }
  }
  return { events, raw };
}

/* --------------------------------- runner -------------------------------- */

async function main(): Promise<void> {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  await new Promise<void>((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
  console.log(`stub model on :${STUB_PORT}`);

  const server = spawn(process.execPath, ['server/index.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      HOST: '127.0.0.1',
      DATA_DIR,
      BLOBS_SECRET: 'smoke-test-secret-value-0123456789',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverLog += chunk.toString();
  });

  const ready = await waitFor(async () => {
    try {
      const response = await fetch(`${BASE}/api/health`);
      return response.ok;
    } catch {
      return false;
    }
  }, 25_000);

  if (!ready) {
    console.error('Server did not start.\n', serverLog.slice(-3000));
    server.kill();
    stub.close();
    process.exit(1);
  }

  console.log('\nAuth and setup');
  const anon = await call<{ error: string }>('GET', '/api/overview');
  check('unauthenticated API is rejected', anon.status === 401, `got ${anon.status}`);

  const setup = await call<{ ok: boolean }>('POST', '/api/auth/setup', { name: 'Sam', passphrase: 'smoke-passphrase-1' });
  check('owner setup succeeds', setup.status === 200 && setup.data.ok === true, JSON.stringify(setup.data));
  check('session cookie issued', cookie.startsWith('blobs_session='));

  const badLogin = await call('POST', '/api/auth/login', { passphrase: 'wrong-passphrase' });
  check('wrong passphrase rejected', badLogin.status === 401);

  const authState = await call<{ authed: boolean }>('GET', '/api/auth/state');
  check('session is valid', authState.data.authed === true);

  console.log('\nModel configuration');
  const configured = await call<{ ok: boolean }>('PATCH', '/api/settings', {
    model: { provider: 'custom', model: 'smoke-model', customBaseUrl: `http://127.0.0.1:${STUB_PORT}/v1` },
  });
  check('custom provider configured', configured.status === 200);
  const tested = await call<{ ok?: boolean; message?: string }>('POST', '/api/settings/test-provider', {
    provider: 'custom',
  });
  check('provider connectivity test passes', tested.status === 200, JSON.stringify(tested.data));

  console.log('\nChat, tools and memory');
  const first = await chat('Please remember that I like short answers.');
  check('chat stream completes', first.events.some((event) => event.type === 'done'), first.raw.slice(0, 200));
  check('tool was executed', first.events.some((event) => event.type === 'tool_end' && event.name === 'remember'));
  check('assistant replied', first.events.some((event) => event.type === 'text'));

  const memory = await call<{ items: { content: string }[] }>('GET', '/api/memory?query=short%20answers');
  check('memory was persisted and retrieved', memory.data.items.some((item) => /short, direct answers/i.test(item.content)));

  const conversationId = first.events.find((event) => event.type === 'meta')?.conversationId as string | undefined;
  check('conversation id returned', Boolean(conversationId));

  const detail = await call<{ messages: { role: string; content: string }[] }>('GET', `/api/conversations/${conversationId}`);
  check('conversation history stored', detail.data.messages.filter((m) => m.role === 'user').length >= 1);

  const second = await chat('What do you remember about my style?');
  check('second turn streams', second.events.some((event) => event.type === 'done'));

  console.log('\nAutonomous actions');
  const action = await chat('Send an email to someone@example.com about the report.');
  check(
    'external email runs without an approval gate',
    action.events.some((event) => event.type === 'tool_start' && event.name === 'send_email'),
    action.raw.slice(0, 240),
  );
  const pending = await call<{ items: unknown[] }>('GET', '/api/approvals');
  check('nothing is queued for manual approval', pending.data.items.length === 0, JSON.stringify(pending.data.items));

  console.log('\nEmergency stop');
  await call('POST', '/api/settings/autonomy', { state: 'stopped' });
  const blocked = await chat('Send an email to someone@example.com right now.');
  check(
    'emergency stop blocks side-effecting tools',
    !blocked.events.some((event) => event.type === 'tool_start' && event.name === 'send_email'),
    blocked.raw.slice(0, 240),
  );
  await call('POST', '/api/settings/autonomy', { state: 'active' });

  console.log('\nBackground task execution');
  const created = await call<{ task: { id: string } }>('POST', '/api/tasks', {
    title: 'Competitor scan',
    objective: 'Research three competitors and summarise the findings.',
    schedule: 'once',
  });
  check('task created', created.status === 200 && Boolean(created.data.task.id));
  const taskId = created.data.task.id;

  const finished = await waitFor(async () => {
    const task = await call<{ task: { status: string } }>('GET', `/api/tasks/${taskId}`);
    return ['done', 'failed'].includes(task.data.task.status);
  }, 45_000);

  const finalTask = await call<{
    task: { status: string; result: string | null; attempts: number };
    steps: { status: string; output: string | null }[];
  }>('GET', `/api/tasks/${taskId}`);
  check('task ran in the background to completion', finished && finalTask.data.task.status === 'done', JSON.stringify(finalTask.data.task));
  check('task planned and executed steps', finalTask.data.steps.length >= 2, `${finalTask.data.steps.length} steps`);
  check('task produced an outcome', Boolean(finalTask.data.task.result));
  check('task used the model', finalTask.data.task.attempts >= 1);

  console.log('\nActivity and overview');
  const activity = await call<{ items: { category: string }[] }>('GET', '/api/activity?limit=80');
  check('activity was logged', activity.data.items.length > 5, `${activity.data.items.length} entries`);
  const toolActivity = activity.data.items.filter((item) => item.category === 'tool').length;
  check('tool usage is logged', toolActivity >= 1, `${toolActivity} tool entries`);

  const overview = await call<{ usage: { today: number }; memory: { total: number }; tasks: Record<string, number> }>(
    'GET',
    '/api/overview',
  );
  check('usage tracked', overview.data.usage.today > 0, JSON.stringify(overview.data.usage));
  check('memory stats present', overview.data.memory.total >= 1);

  const unknownRoute = await call('GET', '/api/does-not-exist');
  check('unknown API route returns 404', unknownRoute.status === 404);

  server.kill('SIGTERM');
  stub.close();
  await new Promise((resolve) => setTimeout(resolve, 400));

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) {
    console.log('\nServer log tail:\n', serverLog.slice(-2500));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('Smoke test crashed:', error);
  stub.close();
  process.exit(1);
});
