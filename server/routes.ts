import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { APP_VERSION } from './env.ts';
import { all, get, run } from './db.ts';
import {
  authMode,
  changeOwnerPassword,
  changePassphrase,
  clearSessionCookie,
  createOwner,
  createSession,
  destroySession,
  getOwnerIdentity,
  isAuthed,
  isSameOrigin,
  loginAllowed,
  ownerExists,
  recordFailedLogin,
  registerOwnerWithEmail,
  sessionToken,
  setSessionCookie,
  verifyOwnerPassword,
  verifyPassphrase,
} from './auth.ts';
import {
  getSettings,
  providerApiKey,
  providerConfig,
  saveSettings,
  setSecret,
  PROVIDERS,
  activeModelLabel,
  DEFAULT_SETTINGS,
} from './settings.ts';
import {
  activityCounts,
  listActivity,
  listNotifications,
  logActivity,
  markNotificationsRead,
  notify,
  subscribe,
  unreadNotifications,
} from './activity.ts';
import {
  deleteMemory,
  listMemories,
  memoryStats,
  remember,
  searchMemories,
  updateMemory,
} from './memory.ts';
import {
  listConversations,
  getConversation,
  runTurn,
  continueAfterApproval,
  summariseConversation,
} from './agent/chat.ts';
import {
  cancelTask,
  createTask,
  executeTask,
  getTask,
  listTaskRows,
  normalizeSchedule,
  pauseTask,
  resumeTask,
  retryTask,
  taskDetail,
  taskStats,
} from './agent/tasks.ts';
import { executeApprovedTool } from './agent/core.ts';
import { createProject, deleteProject, listProjects, updateProject } from './agent/projects.ts';
import {
  createResponsibility,
  deleteResponsibility,
  listResponsibilities,
  runResponsibility,
  updateResponsibility,
} from './agent/responsibilities.ts';
import { dispatchChannels } from './channels.ts';
import { completeOAuth, deleteConnection, listConnections, oauthRequest, startOAuth } from './oauth.ts';
import {
  createDeliverable,
  deleteDeliverable,
  getDeliverable,
  getPublicDeliverable,
  listDeliverables,
  publishDeliverable,
  unpublishDeliverable,
} from './deliverables.ts';
import { schedulerState } from './agent/scheduler.ts';
import { toolCatalog } from './agent/tools.ts';
import { decideApproval, listApprovals, parseApprovalPayload } from './approvals.ts';
import { resumeTaskAfterApproval } from './agent/tasks.ts';
import { providerCatalog, testProvider, usageSummary } from './llm/index.ts';
import {
  emailConfig,
  emailHistory,
  emailStatus,
  disconnectEmail,
  fetchInbox,
  saveEmailConfig,
  sendEmail,
} from './comms/email.ts';
import {
  disconnectPhone,
  inboundTwiml,
  outboundTwiml,
  phoneHistory,
  phoneStatus,
  savePhoneConfig,
  twimlSay,
} from './comms/phone.ts';
import { getSecret } from './settings.ts';
import {
  computerStatus,
  desktopAction,
  disconnectComputer,
  resetComputer,
  saveComputerKey,
  screenshotPath,
} from './computer/e2b.ts';
import { machinesStatus } from './host.ts';
import fs from 'node:fs';
import { clamp, now, truncate } from './util.ts';
import { dbStatus } from './db.ts';
import { workspaceBackend } from './workspace.ts';

const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/state',
  '/api/auth/setup',
  '/api/auth/login',
  '/api/voice/twiml',
]);

function sse(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  reply.raw.flushHeaders?.();
}

function sseWrite(reply: FastifyReply, data: unknown): void {
  if (reply.raw.writableEnded) return;
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function bad(reply: FastifyReply, message: string, status = 400): void {
  reply.code(status).send({ error: message });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/** Standalone page for a published review packet; never shares the app session. */
function packetPage(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<body style="margin:0;background:#f6f3ec;color:#1f1d1a;font:16px/1.6 ui-sans-serif,system-ui,sans-serif">
<main style="max-width:820px;margin:0 auto;padding:48px 22px 96px">
<p style="font:600 12px/1.4 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#8a8377">BLOBS review packet</p>
<h1 style="font-size:30px;line-height:1.2;margin:8px 0 26px">${escapeHtml(title)}</h1>
${body}
</main></body>`;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api')) return;
    if (PUBLIC_PATHS.has(path)) return;
    if (!await isAuthed(request)) {
      reply.code(401).send({ error: 'Sign in to continue.' });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && !isSameOrigin(request)) {
      reply.code(403).send({ error: 'Request rejected: cross-origin write.' });
    }
  });

  /* ---------------- health & auth ---------------- */

  app.get('/api/health', async () => {
    const database = await dbStatus();
    return {
      ok: database.ok,
      version: APP_VERSION,
      database,
      workspace: workspaceBackend(),
      setupRequired: !await ownerExists(),
      uptime: Math.round(process.uptime()),
    };
  });

  app.get('/api/auth/state', async (request) => {
    const settings = getSettings();
    const identity = await getOwnerIdentity();
    return {
      setupRequired: !await ownerExists(),
      authed: await isAuthed(request),
      mode: authMode(),
      ownerName: settings.owner.name,
      ownerEmail: identity?.email ?? null,
      companionName: settings.companion.name,
      tagline: settings.companion.tagline,
    };
  });

  app.post('/api/auth/setup', async (request, reply) => {
    if (await ownerExists()) return bad(reply, 'An owner is already configured.', 409);
    const body = (request.body ?? {}) as { name?: string; email?: string; password?: string; passphrase?: string };
    const name = (body.name ?? '').trim() || 'Owner';
    if (authMode() === 'supabase') {
      if (!body.email || !body.password) return bad(reply, 'Enter an email address and a password.');
      if (body.password.length < 8) return bad(reply, 'Choose a password with at least 8 characters.');
      try {
        await registerOwnerWithEmail(body.email, body.password);
      } catch (error) {
        return bad(reply, (error as Error).message);
      }
    } else {
      if (!body.passphrase || body.passphrase.length < 8) {
        return bad(reply, 'Choose a passphrase with at least 8 characters.');
      }
      await createOwner(name, body.passphrase);
    }
    await saveSettings({ owner: { name } });
    const token = await createSession();
    setSessionCookie(reply, token);
    logActivity({ level: 'info', category: 'system', message: 'BLOBS was initialised by its owner.' });
    notify({ title: `Welcome to ${getSettings().companion.name}`, body: 'Start with a voice session, or add a model key in Settings.', level: 'success' });
    return { ok: true };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as { email?: string; password?: string; passphrase?: string };
    const ip = request.ip;
    if (!loginAllowed(ip)) return bad(reply, 'Too many attempts. Wait a minute and try again.', 429);

    let ok = false;
    try {
      ok =
        authMode() === 'supabase'
          ? Boolean(body.email && body.password) && (await verifyOwnerPassword(body.email ?? '', body.password ?? ''))
          : Boolean(body.passphrase) && (await verifyPassphrase(body.passphrase ?? ''));
    } catch (error) {
      return bad(reply, `Sign-in is unavailable right now: ${(error as Error).message}`, 502);
    }
    if (!ok) {
      recordFailedLogin(ip);
      return bad(
        reply,
        authMode() === 'supabase' ? 'That email and password do not match.' : 'That passphrase is not correct.',
        401,
      );
    }
    const token = await createSession();
    setSessionCookie(reply, token);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await destroySession(sessionToken(request));
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post('/api/auth/password', async (request, reply) => {
    const body = (request.body ?? {}) as { current?: string; next?: string };
    try {
      if (authMode() === 'supabase') await changeOwnerPassword(body.current ?? '', body.next ?? '');
      else await changePassphrase(body.current ?? '', body.next ?? '');
      logActivity({
        level: 'warn',
        category: 'security',
        message: authMode() === 'supabase' ? 'Owner password changed; all sessions signed out.' : 'Owner passphrase changed; all sessions signed out.',
      });
      return { ok: true };
    } catch (error) {
      return bad(reply, (error as Error).message);
    }
  });

  /* ---------------- overview ---------------- */

  app.get('/api/overview', async () => {
    const settings = getSettings();
    return {
      companion: settings.companion,
      owner: settings.owner,
      model: {
        provider: settings.model.provider,
        label: activeModelLabel(settings),
        hasKey: await providerApiKey(settings.model.provider) !== null,
      },
      autonomy: {
        level: settings.autonomy.level,
        state: settings.autonomy.state,
        backgroundEnabled: settings.autonomy.backgroundEnabled,
      },
      tasks: await taskStats(),
      memory: await memoryStats(),
      activity: await activityCounts(),
      unread: await unreadNotifications(),
      approvals: (await listApprovals('pending')).length,
      conversations: Number((await get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations'))?.n ?? 0),
      usage: await usageSummary(),
      scheduler: await schedulerState(),
      tools: toolCatalog().length,
      email: await emailStatus(),
      phone: await phoneStatus(),
      notifications: { browser: settings.notifications.browser },
      computer: await computerStatus(),
    };
  });

  /* ---------------- conversations & chat ---------------- */

  app.get('/api/conversations', async () => await listConversations());

  app.get('/api/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const found = await getConversation(id);
    if (!found) return bad(reply, 'Conversation not found.', 404);
    return found;
  });

  app.post('/api/conversations/:id/summarise', async (request, reply) => {
    const { id } = request.params as { id: string };
    await summariseConversation(id);
    return { ok: true };
  });

  app.delete('/api/conversations/:id', async (request) => {
    const { id } = request.params as { id: string };
    await run('DELETE FROM conversations WHERE id = ?', id);
    return { ok: true };
  });

  app.post('/api/chat', async (request, reply) => {
    const body = (request.body ?? {}) as { conversationId?: string; text?: string; voice?: boolean };
    sse(reply);
    const controller = new AbortController();
    const onClose = (): void => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.on('close', onClose);

    try {
      for await (const event of runTurn({
        conversationId: body.conversationId ?? null,
        text: String(body.text ?? ''),
        voice: Boolean(body.voice),
        signal: controller.signal,
      })) {
        sseWrite(reply, event);
      }
    } catch (error) {
      sseWrite(reply, { type: 'error', message: (error as Error).message });
    } finally {
      request.raw.off('close', onClose);
      if (!reply.raw.writableEnded) reply.raw.end();
    }
    return reply;
  });

  app.get('/api/events', async (request, reply) => {
    sse(reply);
    sseWrite(reply, { type: 'hello', data: { ts: now() } });
    const unsubscribe = subscribe((event) => sseWrite(reply, event));
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n');
    }, 25_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
    return reply;
  });

  /* ---------------- tasks ---------------- */

  app.get('/api/tasks', async (request) => {
    const query = request.query as { status?: string };
    const rows = await listTaskRows(query.status);
    return Promise.all(
      rows.map(async (task) => {
        const steps = await all<{ status: string }>('SELECT status FROM task_steps WHERE task_id = ?', task.id);
      return {
        ...task,
        schedule: task.schedule,
        step_total: steps.length,
        step_done: steps.filter((step) => step.status === 'done').length,
        };
      }),
    );
  });

  app.post('/api/tasks', async (request, reply) => {
    const body = (request.body ?? {}) as {
      title?: string;
      objective?: string;
      projectId?: string;
      schedule?: unknown;
    };
    if (!body.objective?.trim()) return bad(reply, 'An objective is required.');
    const task = await createTask({
      title: body.title?.trim() || body.objective.slice(0, 70),
      objective: body.objective.trim(),
      projectId: body.projectId || null,
      schedule: normalizeSchedule(body.schedule),
      origin: 'owner',
    });
    return { ok: true, task };
  });

  app.get('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const detail = await taskDetail(id);
    if (!detail) return bad(reply, 'Task not found.', 404);
    return detail;
  });

  app.post('/api/tasks/:id/:action', async (request, reply) => {
    const { id, action } = request.params as { id: string; action: string };
    const task = await getTask(id);
    if (!task) return bad(reply, 'Task not found.', 404);
    if (action === 'run') {
      await run("UPDATE tasks SET status = 'queued', next_run_at = ?, error = NULL WHERE id = ?", now(), id);
      void executeTask(id);
      return { ok: true };
    }
    if (action === 'cancel') {
      cancelTask(id);
      return { ok: true };
    }
    if (action === 'pause') {
      pauseTask(id);
      return { ok: true };
    }
    if (action === 'resume') {
      resumeTask(id);
      return { ok: true };
    }
    if (action === 'retry') {
      retryTask(id);
      return { ok: true };
    }
    return bad(reply, 'Unknown action.');
  });

  app.delete('/api/tasks/:id', async (request) => {
    const { id } = request.params as { id: string };
    await run('DELETE FROM tasks WHERE id = ?', id);
    return { ok: true };
  });

  /* ---------------- projects ---------------- */

  app.get('/api/projects', async () => await listProjects());

  app.post('/api/projects', async (request, reply) => {
    const body = (request.body ?? {}) as { title?: string; objective?: string; notes?: string };
    if (!body.title?.trim()) return bad(reply, 'A title is required.');
    return { ok: true, project: await createProject({ title: body.title, objective: body.objective, notes: body.notes }) };
  });

  app.patch('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      title?: string;
      objective?: string;
      status?: 'active' | 'paused' | 'done';
      notes?: string;
      notesAppend?: string;
    };
    const project = await updateProject(id, body);
    if (!project) return bad(reply, 'Project not found.', 404);
    return { ok: true, project };
  });

  app.delete('/api/projects/:id', async (request) => {
    const { id } = request.params as { id: string };
    await deleteProject(id);
    return { ok: true };
  });

  /* ---------------- memory ---------------- */

  app.get('/api/memory', async (request) => {
    const query = request.query as { query?: string; kind?: string; limit?: string };
    const limit = clamp(Number(query.limit ?? 200), 1, 500);
    if (query.query?.trim()) {
      return { items: await searchMemories(query.query.trim(), limit), stats: await memoryStats() };
    }
    return { items: await listMemories({ limit, kind: query.kind }), stats: await memoryStats() };
  });

  app.post('/api/memory', async (request, reply) => {
    const body = (request.body ?? {}) as {
      content?: string;
      kind?: string;
      tags?: string[];
      importance?: number;
      pinned?: boolean;
    };
    if (!body.content?.trim()) return bad(reply, 'Memory content is required.');
    const row = await remember({
      content: body.content,
      kind: (body.kind as 'fact') ?? 'fact',
      tags: body.tags ?? [],
      importance: body.importance ?? 3,
      pinned: body.pinned,
      source: 'owner',
    });
    return { ok: true, memory: row };
  });

  app.patch('/api/memory/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      content?: string;
      kind?: string;
      tags?: string[];
      importance?: number;
      pinned?: boolean;
    };
    const row = await updateMemory(id, {
      content: body.content,
      kind: body.kind as 'fact',
      tags: body.tags,
      importance: body.importance,
      pinned: body.pinned,
    });
    if (!row) return bad(reply, 'Memory not found.', 404);
    return { ok: true, memory: row };
  });

  app.delete('/api/memory/:id', async (request) => {
    const { id } = request.params as { id: string };
    await deleteMemory(id);
    return { ok: true };
  });

  /* ---------------- activity, notifications & approvals ---------------- */

  app.get('/api/activity', async (request) => {
    const query = request.query as { limit?: string; category?: string; level?: string };
    return { items: await listActivity({ limit: Number(query.limit ?? 120), category: query.category, level: query.level }), counts: await activityCounts() };
  });

  app.get('/api/notifications', async () => ({ items: await listNotifications(), unread: await unreadNotifications() }));

  app.post('/api/notifications/read', async () => {
    await markNotificationsRead();
    return { ok: true };
  });

  app.get('/api/approvals', async (request) => {
    const query = request.query as { status?: string };
    return { items: await listApprovals((query.status as 'pending') ?? 'pending') };
  });

  app.post('/api/approvals/:id/decide', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { decision?: 'approved' | 'rejected'; note?: string };
    if (body.decision !== 'approved' && body.decision !== 'rejected') return bad(reply, 'Decision must be approved or rejected.');
    const approval = await decideApproval(id, body.decision, body.note ?? '');
    if (!approval) return bad(reply, 'That approval is no longer pending.', 409);

    const payload = parseApprovalPayload(approval);
    if (body.decision === 'approved' && payload) {
      const settings = getSettings();
      const result = await executeApprovedTool(payload.tool, payload.args, {
        channel: payload.context.channel,
        conversationId: payload.context.conversationId ?? null,
        taskId: payload.context.taskId ?? null,
        autonomyLevel: settings.autonomy.level,
      });
      await run(
        'UPDATE approvals SET decision_note = ? WHERE id = ?',
        truncate(result.ok ? `Executed: ${result.summary}` : `Failed: ${result.content}`, 800),
        id,
      );
      if (approval.task_id) {
        await resumeTaskAfterApproval(approval.task_id, payload.tool, result.content);
      }
    }

    if (approval.conversation_id) {
      void continueAfterApproval(approval, body.decision).catch((error: Error) => {
        logActivity({ level: 'error', category: 'chat', message: `Approval follow-up failed: ${error.message}` });
      });
    }

    return { ok: true, approval };
  });

  /* ---------------- communications ---------------- */

  app.get('/api/comms', async (request) => {
    const query = request.query as { channel?: string; limit?: string };
    const limit = clamp(Number(query.limit ?? 60), 1, 200);
    const items =
      query.channel === 'email'
        ? await emailHistory(limit)
        : query.channel === 'phone'
          ? await phoneHistory(limit)
          : await all('SELECT * FROM comms_events ORDER BY created_at DESC LIMIT ?', limit);
    return { items, email: await emailStatus(), phone: await phoneStatus() };
  });

  app.get('/api/inbox', async () => await fetchInbox(15));

  /* ---------------- review packets ---------------- */

  app.get('/api/deliverables', async () => ({ items: await listDeliverables() }));

  app.post('/api/deliverables', async (request, reply) => {
    const body = (request.body ?? {}) as { title?: string; body?: string; kind?: string };
    if (!body.title?.trim()) return bad(reply, 'Give the packet a title.');
    const deliverable = await createDeliverable({
      title: body.title,
      body: String(body.body ?? ''),
      kind: body.kind === 'html' ? 'html' : 'markdown',
    });
    return { ok: true, deliverable };
  });

  app.get('/api/deliverables/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deliverable = await getDeliverable(id);
    if (!deliverable) return bad(reply, 'Packet not found.', 404);
    return { deliverable };
  });

  app.post('/api/deliverables/:id/publish', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { hours?: number };
    const published = await publishDeliverable(id, body.hours);
    if (!published) return bad(reply, 'Packet not found.', 404);
    return { ok: true, url: `/d/${published.token}`, expiresAt: published.expiresAt };
  });

  app.delete('/api/deliverables/:id/publish', async (request) => {
    const { id } = request.params as { id: string };
    return { ok: await unpublishDeliverable(id) };
  });

  app.delete('/api/deliverables/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { ok: await deleteDeliverable(id) };
  });

  /* ---------------- public review links ---------------- */

  app.get('/d/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const deliverable = await getPublicDeliverable(token);
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    if (!deliverable) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(packetPage('Link not found', '<p>This link has expired or was unpublished.</p>'));
    }
    reply.header('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    reply.type('text/html; charset=utf-8');
    if (deliverable.kind === 'html') return reply.send(deliverable.body);
    return reply.send(
      packetPage(deliverable.title, `<pre style="white-space:pre-wrap;font:15px/1.65 ui-monospace,monospace">${escapeHtml(deliverable.body)}</pre>`),
    );
  });

  /* ---------------- oauth connections ---------------- */

  app.get('/api/oauth/connections', async () => ({ items: await listConnections() }));

  app.post('/api/oauth/start', async (request, reply) => {
    const body = (request.body ?? {}) as {
      provider?: string;
      clientId?: string;
      clientSecret?: string;
      scopes?: string;
    };
    if (!body.provider || !body.clientId?.trim()) return bad(reply, 'Provider and client id are required.');
    const proto = String(request.headers['x-forwarded-proto'] ?? request.protocol ?? 'http')
      .split(',')[0]
      .trim();
    const host = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '').trim();
    if (!host) return bad(reply, 'Could not determine the public origin.');
    const redirectUri = `${proto}://${host}/oauth/callback`;
    try {
      const started = await startOAuth({
        provider: body.provider,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        scopes: body.scopes,
        redirectUri,
      });
      return { ok: true, url: started.url, state: started.state, redirectUri };
    } catch (error) {
      return bad(reply, (error as Error).message);
    }
  });

  app.delete('/api/oauth/connections/:provider', async (request) => {
    const { provider } = request.params as { provider: string };
    return { ok: await deleteConnection(provider) };
  });

  app.get('/oauth/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (query.error) {
      const message = encodeURIComponent(query.error_description || query.error);
      return reply.redirect(`/integrations?oauth=error&message=${message}`);
    }
    if (!query.code || !query.state) {
      return reply.redirect('/integrations?oauth=error&message=missing_code_or_state');
    }
    try {
      const connection = await completeOAuth({ code: query.code, state: query.state });
      return reply.redirect(`/integrations?oauth=connected&provider=${encodeURIComponent(connection.provider)}`);
    } catch (error) {
      const message = encodeURIComponent((error as Error).message);
      return reply.redirect(`/integrations?oauth=error&message=${message}`);
    }
  });

  /* ---------------- responsibilities ---------------- */

  app.get('/api/responsibilities', async () => ({ items: await listResponsibilities() }));

  app.post('/api/responsibilities', async (request, reply) => {
    const body = (request.body ?? {}) as {
      title?: string;
      objective?: string;
      projectId?: string | null;
      cadenceMinutes?: number;
    };
    if (!body.title?.trim() && !body.objective?.trim()) {
      return bad(reply, 'Give the responsibility a title or an objective.');
    }
    const responsibility = await createResponsibility({
      title: body.title ?? body.objective ?? 'Untitled responsibility',
      objective: body.objective ?? '',
      projectId: body.projectId ?? null,
      cadenceMinutes: body.cadenceMinutes,
    });
    return { ok: true, responsibility };
  });

  app.patch('/api/responsibilities/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const status = body.status;
    const updated = await updateResponsibility(id, {
      title: typeof body.title === 'string' ? body.title : undefined,
      objective: typeof body.objective === 'string' ? body.objective : undefined,
      status: status === 'active' || status === 'paused' || status === 'done' ? status : undefined,
      cadenceMinutes: body.cadenceMinutes === undefined ? undefined : Number(body.cadenceMinutes),
      projectId: body.projectId === undefined ? undefined : (body.projectId as string | null),
    });
    if (!updated) return bad(reply, 'Responsibility not found.', 404);
    return { ok: true, responsibility: updated };
  });

  app.post('/api/responsibilities/:id/run', async (request) => {
    const { id } = request.params as { id: string };
    void runResponsibility(id, { force: true }).catch((error: Error) =>
      logActivity({ level: 'error', category: 'responsibility', message: error.message }),
    );
    return { ok: true, started: true };
  });

  app.delete('/api/responsibilities/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { ok: await deleteResponsibility(id) };
  });

  /* ---------------- integrations ---------------- */

  app.get('/api/integrations', async () => ({
    items: [
      {
        key: 'research',
        name: 'Web research',
        category: 'built-in',
        status: 'connected',
        detail: 'DuckDuckGo/Wikipedia search plus page reading. No key required.',
        requires: [],
      },
      {
        key: 'files',
        name: 'Workspace files & notes',
        category: 'built-in',
        status: 'connected',
        detail: 'Private markdown notes and documents stored on the server.',
        requires: [],
      },
      {
        key: 'code',
        name: 'Sandboxed code',
        category: 'built-in',
        status: 'connected',
        detail: 'JavaScript compute in an isolated VM with no network or filesystem access.',
        requires: [],
      },
      {
        key: 'email',
        name: 'Email identity',
        category: 'communication',
        status: (await emailStatus()).ready ? 'connected' : 'disconnected',
        detail: (await emailStatus()).detail,
        requires: ['address', 'smtpHost', 'smtpPort', 'username', 'password'],
        config: (await emailConfig()) ? { ...(await emailConfig()), password: undefined } : null,
      },
      {
        key: 'phone',
        name: 'Phone calls (Twilio)',
        category: 'communication',
        status: (await phoneStatus()).ready ? 'connected' : 'disconnected',
        detail: (await phoneStatus()).detail,
        requires: ['accountSid', 'authToken', 'fromNumber', 'publicBaseUrl'],
        note: 'Twilio requires a card on file. Trial credit is typically enough for a few test calls; it is not free indefinitely.',
      },
      {
        key: 'computer',
        name: 'Cloud computer (E2B)',
        category: 'computer',
        status: (await computerStatus()).configured ? 'connected' : 'disconnected',
        detail: (await computerStatus()).detail,
        requires: ['apiKey'],
        note: 'E2B gives BLOBS its own isolated Linux machine: shell, any language, packages, long-running servers and a graphical desktop. It has a free credit allowance; heavier use is billed by E2B. The owner\'s own computer is never touched.',
        config: {
          sandboxId: (await computerStatus()).sandboxId,
          desktopId: (await computerStatus()).desktopId,
          timeoutMinutes: (await computerStatus()).timeoutMinutes,
        },
      },
      {
        key: 'messaging',
        name: 'Messaging (WhatsApp / SMS)',
        category: 'communication',
        status: 'unavailable',
        detail:
          'Every real messaging channel needs a paid provider or business verification. BLOBS will not fake this — connect Twilio later for SMS if you want it.',
        requires: [],
      },
    ],
  }));

  app.post('/api/integrations/email', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string | number | boolean>;
    const address = String(body.address ?? '').trim();
    const smtpHost = String(body.smtpHost ?? '').trim();
    const username = String(body.username ?? address).trim();
    const password = String(body.password ?? '');
    if (!address || !smtpHost) return bad(reply, 'Address and SMTP host are required.');
    await saveEmailConfig({
      address,
      displayName: String(body.displayName ?? getSettings().companion.name),
      smtpHost,
      smtpPort: Number(body.smtpPort ?? 587),
      smtpSecure: Boolean(body.smtpSecure),
      imapHost: String(body.imapHost ?? smtpHost),
      imapPort: Number(body.imapPort ?? 993),
      username,
    });
    if (password) await setSecret('email:password', password);
    return { ok: true, status: await emailStatus() };
  });

  app.delete('/api/integrations/email', async () => {
    await disconnectEmail();
    return { ok: true };
  });

  app.post('/api/integrations/email/test', async (request, reply) => {
    const body = (request.body ?? {}) as { to?: string };
    const to = body.to || (await emailConfig())?.address;
    if (!to) return bad(reply, 'No address to test with.');
    const result = await sendEmail({
      to,
      subject: `${getSettings().companion.name} connectivity test`,
      body: 'This is a test message confirming that your BLOBS email identity can send mail.',
    });
    if (!result.ok) return bad(reply, result.error ?? 'Send failed.', 502);
    return { ok: true };
  });

  app.get('/api/integrations/email/inbox', async () => await fetchInbox(15));

  app.post('/api/integrations/phone', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    if (!body.accountSid || !body.authToken || !body.fromNumber || !body.publicBaseUrl) {
      return bad(reply, 'Account SID, auth token, from number and public base URL are required.');
    }
    await savePhoneConfig(
      {
        accountSid: body.accountSid,
        fromNumber: body.fromNumber,
        ownerNumber: body.ownerNumber ?? '',
        publicBaseUrl: body.publicBaseUrl,
        voice: body.voice ?? 'Polly.Joanna',
      },
      body.authToken,
    );
    return { ok: true, status: await phoneStatus() };
  });

  app.delete('/api/integrations/phone', async () => {
    await disconnectPhone();
    return { ok: true };
  });

  /* ---------------- cloud computer (E2B) ---------------- */

  app.get('/api/machines', async () => await machinesStatus());

  app.get('/api/computer/status', async () => await computerStatus());

  app.post('/api/integrations/computer', async (request, reply) => {
    const body = (request.body ?? {}) as { apiKey?: string };
    if (!body.apiKey?.trim()) return bad(reply, 'Paste an E2B API key first.');
    saveComputerKey(body.apiKey.trim());
    logActivity({ level: 'info', category: 'integration', message: 'Connected the E2B cloud computer.' });
    return { ok: true, status: await computerStatus() };
  });

  app.delete('/api/integrations/computer', async () => {
    await disconnectComputer();
    return { ok: true, status: await computerStatus() };
  });

  app.post('/api/integrations/computer/reset', async () => {
    const result = await resetComputer();
    logActivity({
      level: 'warn',
      category: 'integration',
      message: `Reset the cloud computer (${result.killed.length} sandbox(es) killed).`,
    });
    return { ok: true, ...result, status: await computerStatus() };
  });

  app.post('/api/computer/screenshot', async (_request, reply) => {
    try {
      const result = await desktopAction({ action: 'screenshot' });
      return { ok: true, message: result.message, ts: now() };
    } catch (error) {
      return bad(reply, (error as Error).message, 502);
    }
  });

  app.get('/api/computer/screenshot', async (_request, reply) => {
    try {
      const data = await fs.promises.readFile(screenshotPath());
      reply.type('image/png').header('cache-control', 'no-store').send(data);
      return reply;
    } catch {
      return bad(reply, 'No screenshot has been taken yet.', 404);
    }
  });

  /* ---------------- voice webhooks (Twilio) ---------------- */

  app.post('/api/voice/twiml', async (request, reply) => {
    const query = request.query as { call?: string; inbound?: string; k?: string };
    const expected = await getSecret('phone:webhookKey');
    if (!expected || query.k !== expected) {
      reply.code(403).type('text/plain').send('Forbidden');
      return reply;
    }
    const body = (request.body ?? {}) as Record<string, string>;
    const speech = (body.SpeechResult ?? '').trim();
    const peer = body.From ?? 'unknown';

    reply.type('text/xml');

    if (query.call) {
      if (!speech) {
        const xml = await outboundTwiml(query.call);
        if (!xml) return reply.code(404).send(twimlSay('That call is no longer available.'));
        return xml;
      }
      const conversationId = `phone_${query.call}`;
      const answer = await drainVoiceTurn(conversationId, speech, peer);
      const phone = await phoneStatus();
      const action = phone.ready ? `${phoneBaseUrl()}/api/voice/twiml?call=${encodeURIComponent(query.call)}&k=${encodeURIComponent(expected)}` : undefined;
      return twimlSay(answer, { gather: true, action });
    }

    if (query.inbound) {
      if (!speech) return await inboundTwiml();
      const conversationId = `phone_in_${peer.replace(/\D/g, '').slice(-10)}`;
      const answer = await drainVoiceTurn(conversationId, speech, peer, true);
      const action = `${phoneBaseUrl()}/api/voice/twiml?inbound=1&k=${encodeURIComponent(expected)}`;
      return twimlSay(answer, { gather: true, action });
    }

    return await inboundTwiml();
  });

  /* ---------------- settings ---------------- */

  app.get('/api/settings', async () => {
    const identity = await getOwnerIdentity();
    return {
      settings: getSettings(),
      defaults: DEFAULT_SETTINGS,
      providers: await providerCatalog(),
      providerNotes: Object.fromEntries(Object.entries(PROVIDERS).map(([key, value]) => [key, value.note])),
      usage: await usageSummary(),
      secrets: { hasEmailPassword: await getSecret('email:password') !== null, hasPhoneToken: await getSecret('phone:authToken') !== null },
      auth: { mode: authMode(), email: identity?.email ?? null },
      version: APP_VERSION,
    };
  });

  app.patch('/api/settings', async (request) => {
    const saved = await saveSettings(request.body ?? {});
    logActivity({ level: 'info', category: 'settings', message: 'Settings updated.' });
    return { ok: true, settings: saved };
  });

  app.post('/api/settings/secret', async (request, reply) => {
    const body = (request.body ?? {}) as { key?: string; value?: string };
    const allowed = new Set(['telegram:botToken', 'webhook:secret']);
    if (!body.key || !allowed.has(body.key)) return bad(reply, 'Unknown secret.');
    if (!body.value?.trim()) return bad(reply, 'Paste the value first.');
    await setSecret(body.key, body.value.trim());
    return { ok: true };
  });

  app.post('/api/notifications/test', async () => {
    const results = await dispatchChannels({
      title: 'BLOBS test notification',
      body: 'Channels are wired up. This is what a notification looks like.',
      level: 'info',
      ts: now(),
    });
    return { ok: true, results };
  });

  app.post('/api/settings/provider-key', async (request, reply) => {
    const body = (request.body ?? {}) as { provider?: string; key?: string };
    if (!body.provider || !PROVIDERS[body.provider]) return bad(reply, 'Unknown provider.');
    if (!body.key?.trim()) return bad(reply, 'Paste the API key first.');
    await setSecret(`provider:${body.provider}`, body.key.trim());
    logActivity({ level: 'info', category: 'settings', message: `Saved an API key for ${PROVIDERS[body.provider].label}.` });
    return { ok: true, providers: await providerCatalog() };
  });

  app.delete('/api/settings/provider-key/:provider', async (request) => {
    const { provider } = request.params as { provider: string };
    await setSecret(`provider:${provider}`, null);
    return { ok: true, providers: await providerCatalog() };
  });

  app.post('/api/settings/test-provider', async (request, reply) => {
    const body = (request.body ?? {}) as { provider?: string };
    if (!body.provider) return bad(reply, 'Choose a provider.');
    const result = await testProvider(body.provider);
    if (!result.ok) return bad(reply, result.message, 502);
    return result;
  });

  app.post('/api/settings/autonomy', async (request, reply) => {
    const body = (request.body ?? {}) as { state?: 'active' | 'paused' | 'stopped' };
    if (!body.state || !['active', 'paused', 'stopped'].includes(body.state)) return bad(reply, 'Invalid state.');
    await saveSettings({ autonomy: { state: body.state } });
    const message =
      body.state === 'stopped'
        ? 'Emergency stop engaged: autonomous work halted.'
        : body.state === 'paused'
          ? 'Autonomy paused: current step finishes, nothing new starts.'
          : 'Autonomy resumed.';
    logActivity({ level: 'warn', category: 'security', message });
    return { ok: true, state: body.state };
  });

  app.get('/api/settings/tools', async () => toolCatalog());
}

/* ---------------- voice helpers ---------------- */

async function phoneBaseUrl(): Promise<string> {
  const config = await get<{ config: string }>("SELECT config FROM integrations WHERE key = 'phone'");
  if (!config?.config) return '';
  try {
    return String((JSON.parse(config.config) as { publicBaseUrl?: string }).publicBaseUrl ?? '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

async function drainVoiceTurn(
  conversationId: string,
  speech: string,
  peer: string,
  inbound = false,
): Promise<string> {
  let text = '';
  for await (const event of runTurn({ conversationId, text: speech, voice: true, channel: 'phone' })) {
    if (event.type === 'text') text += event.delta;
  }
  const settings = getSettings();
  const clean = text.replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim();
  const spoken = clean || 'I am here, but I could not produce a reply just now. Let me try again on the website.';
  await run(
    `INSERT INTO comms_events(id, channel, direction, peer, subject, body, status, external_id, meta, created_at)
     VALUES (?, 'phone', ?, ?, ?, ?, 'completed', ?, ?, ?)`,
    `cm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    inbound ? 'inbound' : 'outbound',
    peer,
    inbound ? 'Incoming call' : 'Outgoing call',
    spoken,
    conversationId,
    JSON.stringify({ model: settings.model.model }),
    now(),
  );
  return spoken.slice(0, 1200);
}

export const routeHelpers = { sse, sseWrite, bad };
