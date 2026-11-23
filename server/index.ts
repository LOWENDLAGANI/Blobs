import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { HOST, PORT, ROOT, APP_VERSION, ROLE } from './env.ts';
import { ready } from './db.ts';
import { registerRoutes } from './routes.ts';
import { startScheduler, stopScheduler } from './agent/scheduler.ts';
import { flushActivity, logActivity } from './activity.ts';
import { getSettings, hydrateSettings } from './settings.ts';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'warn' },
  bodyLimit: 2 * 1024 * 1024,
  trustProxy: true,
});

await app.register(cookie);

const CONNECTION_FAILURE =
  /econnrefused|econnreset|enotfound|etimedout|connection terminated|connection timeout|timeout expired|terminating connection|server closed the connection/i;

/**
 * Turns a raw Postgres failure into something the owner can act on. Without
 * this the browser only ever sees "Internal Server Error", so a host that
 * cannot reach its database looks like a broken app with no explanation.
 */
function databaseFailure(code: string | undefined, detail: string): { message: string; hint: string } | null {
  if (code === '28P01' || /password authentication failed/i.test(detail)) {
    return {
      message: `BLOBS cannot sign in to its database: ${detail}`,
      hint: 'Check the user and password inside DATABASE_URL.',
    };
  }
  if (code === '42P01' || /relation "[^"]+" does not exist/i.test(detail)) {
    return {
      message: `BLOBS reached its database but its tables are missing: ${detail}`,
      hint: 'The schema is applied on boot; check the server log for the migration error.',
    };
  }
  if (CONNECTION_FAILURE.test(detail)) {
    return {
      message: `BLOBS cannot reach its database: ${detail}`,
      hint: 'Check DATABASE_URL on the host (Supabase → Project Settings → Database → Connection string → Connection pooling) and that the database is awake.',
    };
  }
  return null;
}

/**
 * One handler for every unhandled route error. It keeps the real message
 * instead of Fastify's bare "Internal Server Error" and marks a database it
 * cannot use as 503 (not ready) rather than 500 (broken code).
 */
app.setErrorHandler((error: FastifyError, request, reply) => {
  // /api/chat and /api/events stream their own frames; once SSE headers are on
  // the wire there is no HTTP status left to change.
  if (reply.raw.headersSent) {
    reply.raw.end();
    return;
  }
  const status = error.statusCode ?? 500;
  const detail = error.message || 'Unexpected server error.';
  if (status < 500) {
    reply.code(status).send({ error: detail });
    return;
  }
  request.log.error({ err: error }, 'Request failed');
  const database = databaseFailure(error.code, detail);
  if (database) {
    reply.code(503).send({ error: database.message, hint: database.hint });
    return;
  }
  reply.code(500).send({ error: detail });
});

await app.register(registerRoutes);

const dist = path.join(ROOT, 'web', 'dist');
const hasDist = fs.existsSync(path.join(dist, 'index.html'));

if (hasDist) {
  await app.register(fastifyStatic, {
    root: dist,
    prefix: '/',
    wildcard: false,
    index: ['index.html'],
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api')) {
      reply.code(404).send({ error: 'Unknown endpoint.' });
      return;
    }
    reply.type('text/html').sendFile('index.html');
  });
} else {
  app.get('/', async (_request, reply) => {
    reply
      .type('text/html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>BLOBS</title>
         <body style="font:16px/1.6 system-ui;padding:48px;max-width:640px;margin:auto;background:#0e0f12;color:#e9e9ee">
         <h1>BLOBS API is running</h1>
         <p>The web interface has not been built yet. Run <code style="background:#1c1e24;padding:2px 6px;border-radius:4px">npm run build</code>, then restart the server.</p>
         <p style="color:#8b8f9a">API health: <a style="color:#8ad" href="/api/health">/api/health</a></p></body>`,
      );
  });
}

async function boot(): Promise<void> {
  // Bind the port FIRST. The control centre's first request is /api/auth/state,
  // which degrades gracefully when the database is unavailable; if we instead
  // await the schema bootstrap before listening, a slow or stuck Postgres query
  // leaves the browser on "Waking up…" forever.
  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (error) {
    console.error('Failed to start BLOBS:', error);
    process.exit(1);
  }

  // Initialise the database, settings and scheduler in the background. Failures
  // are reported via /api/health and the console instead of killing the process.
  void (async () => {
    let bootError: Error | null = null;
    try {
      await ready;
      await hydrateSettings();
    } catch (error) {
      bootError = error as Error;
      console.error('BLOBS boot dependency failed:', error);
    }
    if (bootError) {
      console.error('BLOBS is running without a working database:', bootError.message);
      return;
    }
    const settings = getSettings();
    logActivity({
      level: 'info',
      category: 'system',
      message: `BLOBS ${APP_VERSION} online on port ${PORT} (model: ${settings.model.provider}/${settings.model.model}).`,
    });
    if (ROLE === 'server') {
      logActivity({
        level: 'info',
        category: 'system',
        message: 'Scheduler disabled on this process (BLOBS_ROLE=server); the worker process runs it.',
      });
    } else {
      await startScheduler().catch((error: Error) => {
        console.error('Scheduler failed to start:', error);
      });
    }
    console.log(`BLOBS listening on http://${HOST}:${PORT} — model ${getSettings().model.provider}/${getSettings().model.model}`);
  })();
}

void boot();

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal} received, shutting down.`);
  stopScheduler();
  await flushActivity();
  await app.close().catch(() => undefined);
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  logActivity({ level: 'error', category: 'system', message: `Unhandled rejection: ${String(reason).slice(0, 300)}` });
});

export { app };
