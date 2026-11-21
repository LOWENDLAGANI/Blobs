import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, SECRET_KEY } from '../env.ts';
import { fetchWithTimeout } from '../util.ts';
import { writeWorkspaceBytes } from '../workspace.ts';
import { getCodeSandbox } from './e2b.ts';

/**
 * Interactive browsing for the agent.
 *
 * The browser itself lives in the E2B cloud computer, next to the shell and the
 * desktop: one Chromium page kept open between calls, driven through a small
 * token-guarded HTTP daemon (browser-daemon.mjs). Nothing heavy is installed on
 * the machine that serves the app, which keeps the container image small and
 * Vercel-friendly.
 *
 * Setting BROWSER_BASE_URL points the client at an existing daemon instead —
 * handy for a self-hosted browser container, and how this module is tested.
 */

const DAEMON_DIR = '/home/user/.blobs/browser';
const DAEMON_FILE = `${DAEMON_DIR}/browser-daemon.mjs`;
const INSTALLED = `${DAEMON_DIR}/.installed`;
const INSTALL_STARTED = `${DAEMON_DIR}/.installing`;
const PORT = 8099;
const HEALTH_TIMEOUT = 3_000;
const START_TIMEOUT_MS = 40_000;

export type BrowserActionName =
  | 'open'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'press'
  | 'back'
  | 'extract'
  | 'screenshot'
  | 'close';

export interface BrowserAction {
  action: BrowserActionName;
  url?: string;
  index?: number;
  selector?: string;
  text?: string;
  submit?: boolean;
  key?: string;
  kind?: 'text' | 'links' | 'html';
  limit?: number;
  fullPage?: boolean;
}

export interface BrowserElement {
  index: number;
  tag: string;
  type?: string;
  label: string;
  href?: string;
}

export interface BrowserResult {
  url?: string;
  title?: string;
  elements?: BrowserElement[];
  text?: string;
  html?: string;
  links?: { text: string; href: string }[];
  screenshot?: string;
  screenshotPath?: string;
  bytes?: number;
  closed?: boolean;
}

const external = (process.env.BROWSER_BASE_URL ?? '').trim().replace(/\/+$/, '');

function tokenFor(sandboxId: string): string {
  return crypto.createHmac('sha256', SECRET_KEY).update(`browser:${sandboxId}`).digest('hex').slice(0, 32);
}

/** Per-sandbox readiness, so the daemon is started once rather than per call. */
const starting = new Map<string, Promise<{ baseUrl: string; token: string }>>();

async function health(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${baseUrl}/health`, { method: 'GET' }, HEALTH_TIMEOUT);
    return response.ok;
  } catch {
    return false;
  }
}

async function daemonSource(): Promise<string> {
  return fs.readFile(path.join(ROOT, 'server', 'computer', 'browser-daemon.mjs'), 'utf8');
}

/**
 * Make sure the daemon is running in the cloud computer and return its base URL.
 * The first call kicks off a Playwright + Chromium install and fails with an
 * actionable message; the sandbox keeps working on it in the background.
 */
async function ensureSandboxBrowser(): Promise<{ baseUrl: string; token: string }> {
  const sandbox = await getCodeSandbox();
  const key = sandbox.sandboxId;
  const pending = starting.get(key);
  if (pending) return pending;

  const attempt = (async () => {
    const token = tokenFor(key);
    const baseUrl = `https://${sandbox.getHost(PORT)}`;

    if (await health(baseUrl)) return { baseUrl, token };

    const installed = await sandbox.files.exists(INSTALLED);
    if (!installed) {
      await sandbox.files.makeDir(DAEMON_DIR).catch(() => undefined);
      await sandbox.files.write(DAEMON_FILE, await daemonSource());

      if (!(await sandbox.files.exists(INSTALL_STARTED))) {
        await sandbox.files.write(INSTALL_STARTED, String(Date.now()));
        // Background so the tool call returns immediately; chromium is ~150 MB.
        await sandbox.commands.run(
          `cd ${DAEMON_DIR} && npm init -y >/dev/null 2>&1 && npm install --silent --no-fund playwright && npx playwright install chromium && sudo npx playwright install-deps chromium >/dev/null 2>&1; touch ${INSTALLED}`,
          { background: true, timeoutMs: 5_000 },
        );
      }
      throw new Error(
        'The browser is installing in the cloud computer (Playwright and Chromium, a few minutes the first time). Try again shortly.',
      );
    }

    await sandbox.commands.run(
      `cd ${DAEMON_DIR} && BLOBS_BROWSER_TOKEN=${token} BLOBS_BROWSER_PORT=${PORT} node browser-daemon.mjs`,
      { background: true, timeoutMs: 5_000 },
    );

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await health(baseUrl)) return { baseUrl, token };
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error('The browser daemon did not come up in the cloud computer. Check the sandbox logs and try again.');
  })().catch((error: Error) => {
    starting.delete(key);
    throw error;
  });

  starting.set(key, attempt);
  return attempt;
}

/** Drive the browser. Returns a normalised result the tool turns into text. */
export async function browserAction(options: BrowserAction): Promise<BrowserResult> {
  const target = external
    ? { baseUrl: external, token: process.env.BROWSER_TOKEN ?? '' }
    : await ensureSandboxBrowser();
  const { baseUrl, token } = target;

  const payload: Record<string, unknown> = { action: options.action, token };
  if (options.url !== undefined) payload.url = options.url;
  if (options.index !== undefined) payload.index = options.index;
  if (options.selector !== undefined) payload.selector = options.selector;
  if (options.text !== undefined) payload.text = options.text;
  if (options.submit !== undefined) payload.submit = options.submit;
  if (options.key !== undefined) payload.key = options.key;
  if (options.kind !== undefined) payload.kind = options.kind;
  if (options.limit !== undefined) payload.limit = options.limit;
  if (options.fullPage !== undefined) payload.full_page = options.fullPage;

  const response = await fetchWithTimeout(
    `${baseUrl}/action`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
    60_000,
  );

  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`The browser daemon sent an unreadable reply (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(String(body.error ?? `Browser daemon error (${response.status}).`));
  }
  if (typeof body.error === 'string') throw new Error(body.error);

  const result = body as BrowserResult;
  if (typeof result.screenshot === 'string' && result.screenshot) {
    const bytes = Buffer.from(result.screenshot, 'base64');
    const relative = `screenshots/browser-${Date.now()}.png`;
    await writeWorkspaceBytes(relative, new Uint8Array(bytes));
    result.screenshotPath = relative;
    result.bytes = bytes.byteLength;
    delete result.screenshot;
  }
  return result;
}
