import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { HOST, PORT, ROOT, APP_VERSION } from './env.ts';
import { registerRoutes } from './routes.ts';
import { startScheduler, stopScheduler } from './agent/scheduler.ts';
import { logActivity } from './activity.ts';
import { getSettings } from './settings.ts';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'warn' },
  bodyLimit: 2 * 1024 * 1024,
  trustProxy: true,
});

await app.register(cookie);

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
  try {
    await app.listen({ host: HOST, port: PORT });
    const settings = getSettings();
    logActivity({
      level: 'info',
      category: 'system',
      message: `BLOBS ${APP_VERSION} online on port ${PORT} (model: ${settings.model.provider}/${settings.model.model}).`,
    });
    startScheduler();
    console.log(`BLOBS listening on http://${HOST}:${PORT} — model ${settings.model.provider}/${settings.model.model}`);
  } catch (error) {
    console.error('Failed to start BLOBS:', error);
    process.exit(1);
  }
}

void boot();

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal} received, shutting down.`);
  stopScheduler();
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
