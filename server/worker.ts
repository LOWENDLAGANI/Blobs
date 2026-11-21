import http from 'node:http';
import { closeDb, ready } from './db.ts';
import { hydrateSettings } from './settings.ts';
import { flushActivity, logActivity } from './activity.ts';
import { schedulerHeartbeat, startScheduler, stopScheduler } from './agent/scheduler.ts';

/**
 * Scheduler worker.
 *
 * Vercel container services scale to zero after a few idle minutes, so they
 * cannot own a `setInterval` that has to keep running. This process is the
 * other half: no HTTP traffic, no user requests, just the task engine —
 * deployed as a Vercel Daemon (see vercel.json) with the same image and a
 * different command. On a normal host the default role still runs both halves
 * in one process, so nothing changes there.
 *
 * A tiny probe listener exists only so the daemon's livenessProbe can tell
 * "busy" from "wedged": a long task keeps `ticking` true, a dead loop does not.
 */
const PROBE_PORT = Number(process.env.WORKER_PROBE_PORT ?? 8081);
const STALE_MS = 5 * 60_000;

async function main(): Promise<void> {
  await ready;
  await hydrateSettings();
  await startScheduler();
  logActivity({
    level: 'info',
    category: 'system',
    message: 'Scheduler worker online; background tasks run here.',
  });
  console.log(`BLOBS scheduler worker online (probe on :${PROBE_PORT})`);

  const probe = http.createServer((request, response) => {
    if (request.url !== '/health') {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    const beat = schedulerHeartbeat();
    const healthy = beat.running && (beat.ticking || Date.now() - beat.lastTickAt < STALE_MS);
    response
      .writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: healthy, ...beat, uptime: Math.round(process.uptime()) }));
  });
  probe.listen(PROBE_PORT, '0.0.0.0');
  probe.on('error', (error) => console.error('Probe listener failed:', error.message));

  // The scheduler's own timer is unref'd, so it cannot hold the loop by itself.
  const keepAlive = setInterval(() => undefined, 1 << 30);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`${signal} received, draining the scheduler worker.`);
    clearInterval(keepAlive);
    stopScheduler();
    probe.close();
    await flushActivity();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection in scheduler worker:', reason);
    logActivity({ level: 'error', category: 'system', message: `Worker rejection: ${String(reason).slice(0, 300)}` });
  });
}

void main().catch((error: Error) => {
  console.error('Scheduler worker failed to start:', error);
  process.exit(1);
});
