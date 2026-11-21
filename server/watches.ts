import { all, get, run } from './db.ts';
import { broadcast, logActivity, notify } from './activity.ts';
import { getSettings } from './settings.ts';
import { webSearch } from './search.ts';
import {
  assertPublicUrl,
  fetchWithTimeout,
  htmlToText,
  id,
  now,
  sha256,
  truncate,
} from './util.ts';

/**
 * Watches: the proactive half of the agent.
 *
 * A watch is a standing instruction to check something — a page, a feed, or a
 * search — on a cadence. When the fingerprint changes, BLOBS records what
 * changed, notifies the owner and (optionally) queues a task to investigate.
 * First check only captures a baseline, so adding a watch never fires noise.
 */

export type WatchKind = 'url' | 'rss' | 'search';
export type WatchStatus = 'active' | 'paused';

export interface WatchRow {
  id: string;
  kind: WatchKind;
  target: string;
  label: string;
  cadence_minutes: number;
  status: WatchStatus;
  notify_on_change: number;
  create_task_on_change: number;
  last_checked_at: number | null;
  last_fingerprint: string | null;
  last_change_at: number | null;
  last_summary: string | null;
  created_at: number;
  updated_at: number;
}

const MIN_CADENCE = 5;
const MAX_CADENCE = 43_200;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function cadence(value: unknown, fallback = 360): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_CADENCE, Math.max(MIN_CADENCE, parsed));
}

function clean(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

interface FeedItem {
  title: string;
  link: string;
  date: string;
}

/** Minimal RSS/Atom parsing: enough for change detection, no dependency. */
function parseFeed(xml: string): FeedItem[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((match) => match[0]);
  const items: FeedItem[] = [];
  for (const block of blocks.slice(0, 40)) {
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(block);
    const linkMatch = /<link[^>]*href="([^"]+)"/i.exec(block) ?? /<link[^>]*>([\s\S]*?)<\/link>/i.exec(block);
    const dateMatch = /<(pubDate|updated|published)[^>]*>([\s\S]*?)<\/\1>/i.exec(block);
    const strip = (value: string): string =>
      clean(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' '));
    const title = titleMatch ? strip(titleMatch[1]) : '';
    const link = linkMatch ? strip(linkMatch[1]) : '';
    if (!title && !link) continue;
    items.push({ title: title || link, link, date: dateMatch ? strip(dateMatch[2]) : '' });
  }
  return items;
}

interface Snapshot {
  fingerprint: string;
  summary: string;
}

async function snapshot(kind: WatchKind, target: string): Promise<Snapshot> {
  if (kind === 'search') {
    const result = await webSearch(target, 8);
    if (!result.hits.length) throw new Error('The search returned nothing.');
    const fingerprint = sha256(result.hits.map((hit) => hit.url).join('\n'));
    const summary = result.hits
      .slice(0, 6)
      .map((hit) => `- ${hit.title || hit.url} — ${hit.url}`)
      .join('\n');
    return { fingerprint, summary };
  }

  const url = assertPublicUrl(target);
  const response = await fetchWithTimeout(
    url.toString(),
    {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/rss+xml,application/atom+xml,application/xml,text/xml,application/json;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    },
    20_000,
  );
  if (!response.ok) throw new Error(`The target responded with HTTP ${response.status}.`);
  const body = await response.text();

  if (kind === 'rss') {
    const items = parseFeed(body);
    if (!items.length) throw new Error('No feed items were found at that URL.');
    const fingerprint = sha256(items.map((item) => `${item.title}|${item.link}`).join('\n'));
    const summary = items
      .slice(0, 6)
      .map((item) => `- ${item.title}${item.date ? ` (${item.date})` : ''}${item.link ? ` — ${item.link}` : ''}`)
      .join('\n');
    return { fingerprint, summary };
  }

  const contentType = response.headers.get('content-type') ?? '';
  const text = contentType.includes('application/json')
    ? body.slice(0, 20_000)
    : htmlToText(body).slice(0, 20_000);
  const normalised = clean(text);
  if (normalised.length < 40) throw new Error('The page had almost no readable text.');
  return { fingerprint: sha256(normalised), summary: truncate(normalised, 600) };
}

export async function createWatch(input: {
  kind: WatchKind;
  target: string;
  label?: string;
  cadenceMinutes?: number;
  notifyOnChange?: boolean;
  createTaskOnChange?: boolean;
  runNow?: boolean;
}): Promise<WatchRow> {
  const ts = now();
  const row: WatchRow = {
    id: id('wtc'),
    kind: input.kind,
    target: input.target.trim().slice(0, 2000),
    label: (input.label?.trim() || input.target.trim()).slice(0, 200),
    cadence_minutes: cadence(input.cadenceMinutes),
    status: 'active',
    notify_on_change: input.notifyOnChange === false ? 0 : 1,
    create_task_on_change: input.createTaskOnChange === false ? 0 : 1,
    last_checked_at: null,
    last_fingerprint: null,
    last_change_at: null,
    last_summary: null,
    created_at: ts,
    updated_at: ts,
  };
  await run(
    `INSERT INTO watches(id, kind, target, label, cadence_minutes, status, notify_on_change, create_task_on_change,
      last_checked_at, last_fingerprint, last_change_at, last_summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.kind,
    row.target,
    row.label,
    row.cadence_minutes,
    row.status,
    row.notify_on_change,
    row.create_task_on_change,
    row.last_checked_at,
    row.last_fingerprint,
    row.last_change_at,
    row.last_summary,
    row.created_at,
    row.updated_at,
  );
  logActivity({
    level: 'info',
    category: 'watch',
    message: `Watching "${row.label}" every ${row.cadence_minutes} minutes.`,
    meta: { watchId: row.id, kind: row.kind },
  });
  broadcast('watches', { watchId: row.id, status: row.status });
  return row;
}

export async function listWatches(): Promise<WatchRow[]> {
  return all<WatchRow>(
    `SELECT * FROM watches
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, COALESCE(last_checked_at, 0) ASC, created_at DESC`,
  );
}

export async function getWatch(watchId: string): Promise<WatchRow | null> {
  return get<WatchRow>('SELECT * FROM watches WHERE id = ?', watchId);
}

export async function updateWatch(
  watchId: string,
  patch: {
    status?: WatchStatus;
    label?: string;
    cadenceMinutes?: number;
    target?: string;
    notifyOnChange?: boolean;
    createTaskOnChange?: boolean;
  },
): Promise<WatchRow | null> {
  const existing = await getWatch(watchId);
  if (!existing) return null;
  await run(
    `UPDATE watches SET label = ?, target = ?, cadence_minutes = ?, status = ?, notify_on_change = ?,
      create_task_on_change = ?, updated_at = ? WHERE id = ?`,
    patch.label?.trim().slice(0, 200) || existing.label,
    patch.target?.trim().slice(0, 2000) || existing.target,
    patch.cadenceMinutes === undefined ? existing.cadence_minutes : cadence(patch.cadenceMinutes, existing.cadence_minutes),
    patch.status ?? existing.status,
    patch.notifyOnChange === undefined ? existing.notify_on_change : patch.notifyOnChange ? 1 : 0,
    patch.createTaskOnChange === undefined ? existing.create_task_on_change : patch.createTaskOnChange ? 1 : 0,
    now(),
    watchId,
  );
  logActivity({ level: 'info', category: 'watch', message: `Updated watch "${existing.label}".`, meta: { watchId } });
  broadcast('watches', { watchId, status: patch.status ?? existing.status });
  return getWatch(watchId);
}

export async function deleteWatch(watchId: string): Promise<boolean> {
  const existing = await getWatch(watchId);
  if (!existing) return false;
  await run('DELETE FROM watches WHERE id = ?', watchId);
  logActivity({ level: 'info', category: 'watch', message: `Dropped watch "${existing.label}".`, meta: { watchId } });
  broadcast('watches', { watchId, status: 'deleted' });
  return true;
}

/**
 * Check one watch. Returns whether the content changed. Errors are recorded on
 * the watch and never thrown into the scheduler.
 */
export async function checkWatch(
  watchId: string,
): Promise<{ changed: boolean; baseline: boolean; summary: string; watch: WatchRow } | null> {
  const watch = await getWatch(watchId);
  if (!watch) return null;

  try {
    const current = await snapshot(watch.kind, watch.target);
    const baseline = watch.last_fingerprint === null;
    const changed = !baseline && watch.last_fingerprint !== current.fingerprint;

    await run(
      `UPDATE watches SET last_checked_at = ?, last_fingerprint = ?, last_summary = ?,
        last_change_at = ?, updated_at = ? WHERE id = ?`,
      now(),
      current.fingerprint,
      truncate(current.summary, 2000),
      changed ? now() : watch.last_change_at,
      now(),
      watchId,
    );

    if (baseline) {
      logActivity({
        level: 'info',
        category: 'watch',
        message: `Baseline captured for "${watch.label}".`,
        meta: { watchId },
      });
    }

    if (changed) {
      logActivity({
        level: 'success',
        category: 'watch',
        message: `"${watch.label}" changed.`,
        meta: { watchId },
      });
      if (watch.notify_on_change) {
        notify({
          title: `Watch changed: ${watch.label}`,
          body: truncate(current.summary, 240),
          level: 'info',
          link: '/watches',
        });
      }
      const settings = getSettings();
      if (
        watch.create_task_on_change &&
        settings.autonomy.backgroundEnabled &&
        settings.autonomy.state === 'active'
      ) {
        // Dynamic import keeps watches → tasks from becoming a module cycle.
        const { createTask } = await import('./agent/tasks.ts');
        await createTask({
          title: `Watch: ${watch.label}`,
          objective: [
            `A watch you own has changed: ${watch.label}.`,
            `Target (${watch.kind}): ${watch.target}`,
            `What it looks like now:\n${truncate(current.summary, 2000)}`,
            watch.last_summary ? `What it looked like before:\n${truncate(watch.last_summary, 1200)}` : '',
            'Work out what actually changed, whether it matters to the owner, and what (if anything) should be done about it. Report concisely; do not ask questions.',
          ]
            .filter(Boolean)
            .join('\n\n'),
          origin: 'watch',
        });
      }
      broadcast('watches', { watchId, status: 'changed' });
    }

    const updated = await getWatch(watchId);
    return {
      changed,
      baseline,
      summary: current.summary,
      watch: updated ?? watch,
    };
  } catch (error) {
    const message = (error as Error).message;
    await run(
      'UPDATE watches SET last_checked_at = ?, updated_at = ? WHERE id = ?',
      now(),
      now(),
      watchId,
    );
    logActivity({
      level: 'warn',
      category: 'watch',
      message: `Watch "${watch.label}" failed: ${truncate(message, 200)}`,
      meta: { watchId },
    });
    const updated = await getWatch(watchId);
    return { changed: false, baseline: false, summary: `Check failed: ${message}`, watch: updated ?? watch };
  }
}

/** Run due watches, one at a time so the scheduler tick stays responsive. */
export async function runDueWatches(limit = 1): Promise<number> {
  const due = await all<{ id: string }>(
    `SELECT id FROM watches
     WHERE status = 'active'
       AND (last_checked_at IS NULL OR last_checked_at + (cadence_minutes * 60000) <= ?)
     ORDER BY last_checked_at ASC NULLS FIRST
     LIMIT ?`,
    now(),
    limit,
  );
  let checked = 0;
  for (const row of due) {
    await checkWatch(row.id);
    checked += 1;
  }
  return checked;
}

export async function watchCount(): Promise<{ active: number; total: number }> {
  const rows = await all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM watches GROUP BY status');
  const active = Number(rows.find((row) => row.status === 'active')?.n ?? 0);
  const total = rows.reduce((sum, row) => sum + Number(row.n), 0);
  return { active, total };
}
