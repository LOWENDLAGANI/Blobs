import fs from 'node:fs/promises';
import path from 'node:path';
import { Sandbox } from 'e2b';
import { Sandbox as DesktopSandbox } from '@e2b/desktop';
import { DATA_DIR, WORKSPACE_DIR } from '../env.ts';
import { get, run } from '../db.ts';
import { getSecret, getSettings, setSecret } from '../settings.ts';
import { now, safeJson, truncate } from '../util.ts';

/**
 * BLOBS's cloud computer.
 *
 * A real isolated Linux VM provided by E2B: shell, packages, long-running
 * servers, arbitrary files and an optional graphical desktop. Sandbox ids are
 * persisted so the same machine survives restarts until its timeout expires.
 *
 * The owner's own machine is never touched, and no BLOBS secret is ever passed
 * into the sandbox environment.
 */

export type ComputerAction = 'list' | 'read' | 'write' | 'delete' | 'mkdir' | 'move';

export interface E2BConfig {
  sandboxId?: string;
  desktopSandboxId?: string;
  updatedAt?: number;
}

const SCREEN_DIR = path.join(DATA_DIR, 'computer');
const MAX_FILE_BYTES = 2_000_000;

let codeCache: { id: string; sandbox: Sandbox } | null = null;
let desktopCache: { id: string; sandbox: DesktopSandbox } | null = null;

export function e2bApiKey(): string | null {
  const stored = getSecret('e2b:apiKey');
  if (stored) return stored;
  const fromEnv = process.env.E2B_API_KEY;
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : null;
}

export function readConfig(): E2BConfig {
  const row = get<{ config: string }>("SELECT config FROM integrations WHERE key = 'computer'");
  return safeJson<E2BConfig>(row?.config, {});
}

function writeConfig(patch: Partial<E2BConfig>): void {
  const next = { ...readConfig(), ...patch, updatedAt: now() };
  run(
    `INSERT INTO integrations(key, status, config, updated_at) VALUES ('computer', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET status = excluded.status, config = excluded.config, updated_at = excluded.updated_at`,
    e2bApiKey() ? 'connected' : 'disconnected',
    JSON.stringify(next),
    now(),
  );
}

export function computerStatus(): {
  provider: 'E2B';
  configured: boolean;
  hasKey: boolean;
  enabled: boolean;
  sandboxId: string | null;
  desktopId: string | null;
  timeoutMinutes: number;
  detail: string;
} {
  const settings = getSettings();
  const key = e2bApiKey();
  const config = readConfig();
  const enabled = settings.computer.enabled;
  return {
    provider: 'E2B',
    configured: Boolean(key) && enabled,
    hasKey: Boolean(key),
    enabled,
    sandboxId: config.sandboxId ?? null,
    desktopId: config.desktopSandboxId ?? null,
    timeoutMinutes: settings.computer.timeoutMinutes,
    detail: !key
      ? 'Not connected. An E2B API key gives BLOBS its own Linux computer with shell, code, files, servers and a desktop.'
      : !enabled
        ? 'Key saved, but computer access is switched off in Settings → Computer.'
        : `E2B computer ready${config.sandboxId ? ' (existing sandbox will be resumed)' : ' (created on first use)'}.`,
  };
}

export function saveComputerKey(key: string): void {
  setSecret('e2b:apiKey', key);
  writeConfig({});
  codeCache = null;
  desktopCache = null;
}

export async function disconnectComputer(): Promise<void> {
  await resetComputer().catch(() => undefined);
  setSecret('e2b:apiKey', null);
  run("UPDATE integrations SET status = 'disconnected', updated_at = ? WHERE key = 'computer'", now());
}

/** Kill both sandboxes and forget them. */
export async function resetComputer(): Promise<{ killed: string[]; errors: string[] }> {
  const key = e2bApiKey();
  const config = readConfig();
  const killed: string[] = [];
  const errors: string[] = [];
  if (key) {
    for (const id of [config.sandboxId, config.desktopSandboxId]) {
      if (!id) continue;
      try {
        await Sandbox.kill(id, { apiKey: key });
        killed.push(id);
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
  }
  codeCache = null;
  desktopCache = null;
  writeConfig({ sandboxId: undefined, desktopSandboxId: undefined });
  return { killed, errors };
}

function friendlyError(error: unknown): Error {
  const message = (error as Error)?.message ?? String(error);
  if (/401|unauthori[sz]ed|invalid.{0,10}api.{0,10}key/i.test(message)) {
    return new Error('E2B rejected the API key. Check it in Integrations → Computer.');
  }
  if (/402|quota|billing|credit|limit reached/i.test(message)) {
    return new Error('E2B refused the request because of a quota or billing limit. Check your E2B usage dashboard.');
  }
  if (/timeout|timed out/i.test(message)) {
    return new Error(`The sandbox did not answer in time. ${message}`);
  }
  return new Error(message);
}

function assertAvailable(): { key: string; timeoutMs: number } {
  const settings = getSettings();
  if (!settings.computer.enabled) {
    throw new Error('Computer access is switched off. Enable it in Settings → Computer.');
  }
  const key = e2bApiKey();
  if (!key) {
    throw new Error(
      'BLOBS has no cloud computer yet. Add an E2B API key in Integrations → Computer to give it shell, code, files and a desktop.',
    );
  }
  const minutes = Math.min(60, Math.max(5, Number(settings.computer.timeoutMinutes) || 20));
  return { key, timeoutMs: minutes * 60_000 };
}

async function connectCode(key: string, id: string, timeoutMs: number): Promise<Sandbox> {
  return Sandbox.connect(id, { apiKey: key, timeoutMs });
}

async function createCode(key: string, timeoutMs: number): Promise<Sandbox> {
  return Sandbox.create({ apiKey: key, timeoutMs });
}

/** Get (or lazily create and resume) the code sandbox. */
export async function getCodeSandbox(): Promise<Sandbox> {
  const { key, timeoutMs } = assertAvailable();
  const config = readConfig();

  if (codeCache && (!config.sandboxId || codeCache.id === config.sandboxId)) {
    try {
      await codeCache.sandbox.setTimeout(timeoutMs);
      return codeCache.sandbox;
    } catch {
      codeCache = null;
    }
  }

  if (config.sandboxId) {
    try {
      const sandbox = await connectCode(key, config.sandboxId, timeoutMs);
      codeCache = { id: config.sandboxId, sandbox };
      return sandbox;
    } catch {
      // Expired or killed: fall through and make a new one.
      writeConfig({ sandboxId: undefined });
    }
  }

  try {
    const sandbox = await createCode(key, timeoutMs);
    codeCache = { id: sandbox.sandboxId, sandbox };
    writeConfig({ sandboxId: sandbox.sandboxId });
    return sandbox;
  } catch (error) {
    throw friendlyError(error);
  }
}

/** Get (or lazily create) the graphical desktop sandbox. */
export async function getDesktopSandbox(): Promise<DesktopSandbox> {
  const { key, timeoutMs } = assertAvailable();
  const config = readConfig();

  if (desktopCache && (!config.desktopSandboxId || desktopCache.id === config.desktopSandboxId)) {
    try {
      await desktopCache.sandbox.setTimeout(timeoutMs);
      return desktopCache.sandbox;
    } catch {
      desktopCache = null;
    }
  }

  if (config.desktopSandboxId) {
    try {
      const sandbox = await DesktopSandbox.connect(config.desktopSandboxId, { apiKey: key, timeoutMs });
      desktopCache = { id: config.desktopSandboxId, sandbox };
      return sandbox;
    } catch {
      writeConfig({ desktopSandboxId: undefined });
    }
  }

  try {
    const sandbox = await DesktopSandbox.create({ apiKey: key, timeoutMs });
    desktopCache = { id: sandbox.sandboxId, sandbox };
    writeConfig({ desktopSandboxId: sandbox.sandboxId });
    return sandbox;
  } catch (error) {
    throw friendlyError(error);
  }
}

/* ------------------------------------------------------------------ */
/* Shell and code                                                      */
/* ------------------------------------------------------------------ */

export interface ShellResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export async function runShell(
  command: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ShellResult> {
  const sandbox = await getCodeSandbox();
  try {
    const result = await sandbox.commands.run(command, {
      cwd: options.cwd || '/home/user',
      timeoutMs: Math.min(120_000, Math.max(2_000, options.timeoutMs ?? 60_000)),
    });
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: truncate(result.stdout ?? '', 12_000),
      stderr: truncate(result.stderr ?? '', 6_000),
      error: result.error,
    };
  } catch (error) {
    throw friendlyError(error);
  }
}

const LANGUAGE_RUNNER: Record<string, { file: string; command: (file: string) => string; note: string }> = {
  python: { file: '/home/user/blobs_run.py', command: (file) => `python3 ${file}`, note: 'python3' },
  javascript: { file: '/home/user/blobs_run.mjs', command: (file) => `node ${file}`, note: 'node' },
  bash: { file: '/home/user/blobs_run.sh', command: (file) => `bash ${file}`, note: 'bash' },
};

export async function runCode(
  language: string,
  code: string,
): Promise<ShellResult & { language: string; file: string }> {
  const runner = LANGUAGE_RUNNER[language];
  if (!runner) {
    throw new Error(`Unsupported language "${language}". Use python, javascript or bash.`);
  }
  const sandbox = await getCodeSandbox();
  try {
    await sandbox.files.write(runner.file, code);
    const result = await sandbox.commands.run(runner.command(runner.file), {
      cwd: '/home/user',
      timeoutMs: 90_000,
    });
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: truncate(result.stdout ?? '', 12_000),
      stderr: truncate(result.stderr ?? '', 6_000),
      error: result.error,
      language,
      file: runner.file,
    };
  } catch (error) {
    throw friendlyError(error);
  }
}

export async function installPackages(manager: 'pip' | 'npm' | 'apt', packages: string[]): Promise<ShellResult> {
  const list = packages.map((name) => name.trim()).filter(Boolean);
  if (!list.length) throw new Error('No packages listed.');
  const safe = list.map((name) => (/^[a-zA-Z0-9@/_.:+-]+$/.test(name) ? name : '')).filter(Boolean);
  if (safe.length !== list.length) throw new Error('Package names may only contain letters, digits and @ / _ . : + -');
  if (manager === 'apt') {
    return runShell(`sudo apt-get update -qq && sudo apt-get install -y ${safe.join(' ')}`, { timeoutMs: 115_000 });
  }
  if (manager === 'pip') return runShell(`pip install --quiet ${safe.join(' ')}`, { timeoutMs: 115_000 });
  return runShell(`npm install --silent --no-fund ${safe.join(' ')}`, { timeoutMs: 115_000, cwd: '/home/user' });
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

export async function sandboxFiles(action: ComputerAction, options: {
  path: string;
  content?: string;
  destination?: string;
}): Promise<string> {
  const sandbox = await getCodeSandbox();
  const target = options.path;
  if (!target || !target.startsWith('/')) {
    throw new Error('Use an absolute path inside the sandbox, e.g. /home/user/notes.md');
  }
  try {
    if (action === 'list') {
      const entries = await sandbox.files.list(target);
      if (!entries.length) return `${target} is empty.`;
      return entries
        .map((entry) => `${entry.type === 'dir' ? 'd' : '-'} ${entry.path} (${entry.size} bytes)`)
        .join('\n');
    }
    if (action === 'read') {
      const info = await sandbox.files.exists(target);
      if (!info) return `${target} does not exist.`;
      const text = await sandbox.files.read(target);
      return truncate(text, 16_000);
    }
    if (action === 'write') {
      const content = options.content ?? '';
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('That file is larger than 2 MB.');
      const written = await sandbox.files.write(target, content);
      return `Wrote ${written.path} (${Buffer.byteLength(content, 'utf8')} bytes).`;
    }
    if (action === 'delete') {
      await sandbox.files.remove(target);
      return `Deleted ${target}.`;
    }
    if (action === 'mkdir') {
      const created = await sandbox.files.makeDir(target);
      return created ? `Created ${target}.` : `${target} already existed.`;
    }
    if (action === 'move') {
      if (!options.destination) throw new Error('A destination path is required to move a file.');
      const entry = await sandbox.files.rename(target, options.destination);
      return `Moved to ${entry.path}.`;
    }
    throw new Error(`Unknown file action ${action}.`);
  } catch (error) {
    throw friendlyError(error);
  }
}

function resolveWorkspace(raw: string): string {
  const clean = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(WORKSPACE_DIR, clean);
  if (!resolved.startsWith(WORKSPACE_DIR + path.sep) && resolved !== WORKSPACE_DIR) {
    throw new Error('That workspace path is outside the BLOBS workspace.');
  }
  return resolved;
}

export async function transferFile(
  direction: 'download' | 'upload',
  sandboxPath: string,
  workspacePath: string,
): Promise<string> {
  const sandbox = await getCodeSandbox();
  try {
    if (direction === 'download') {
      const bytes = await sandbox.files.read(sandboxPath, { format: 'bytes' });
      if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('That file is larger than 2 MB.');
      const local = resolveWorkspace(workspacePath);
      await fs.mkdir(path.dirname(local), { recursive: true });
      await fs.writeFile(local, bytes);
      return `Saved ${sandboxPath} to the BLOBS workspace as ${workspacePath} (${bytes.byteLength} bytes).`;
    }
    const local = resolveWorkspace(workspacePath);
    const bytes = await fs.readFile(local);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('That file is larger than 2 MB.');
    await sandbox.files.write(sandboxPath, bytes);
    return `Uploaded ${workspacePath} to ${sandboxPath} (${bytes.byteLength} bytes).`;
  } catch (error) {
    throw friendlyError(error);
  }
}

/* ------------------------------------------------------------------ */
/* Servers                                                             */
/* ------------------------------------------------------------------ */

export async function startServer(command: string, port: number): Promise<{ url: string; note: string }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  const sandbox = await getCodeSandbox();
  try {
    await sandbox.commands.run(command, { background: true, cwd: '/home/user', timeoutMs: 5_000 });
  } catch (error) {
    // Background commands may report a startup timeout even though the process is alive.
    const message = (error as Error).message;
    if (!/timeout|timed out/i.test(message)) throw friendlyError(error);
  }
  const host = sandbox.getHost(port);
  return {
    url: `https://${host}`,
    note: 'The server runs inside the sandbox. The public URL stays reachable while the sandbox lives; E2B resumes it on request.',
  };
}

/* ------------------------------------------------------------------ */
/* Desktop                                                             */
/* ------------------------------------------------------------------ */

export interface DesktopOptions {
  action:
    | 'screenshot'
    | 'click'
    | 'double_click'
    | 'right_click'
    | 'move'
    | 'type'
    | 'key'
    | 'scroll'
    | 'drag'
    | 'open'
    | 'launch';
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  text?: string;
  key?: string;
  direction?: 'up' | 'down';
  amount?: number;
  target?: string;
}

export async function desktopAction(options: DesktopOptions): Promise<{ message: string; screenshot?: string }> {
  const desktop = await getDesktopSandbox();
  try {
    switch (options.action) {
      case 'screenshot':
        break;
      case 'click':
        await desktop.leftClick(options.x, options.y);
        break;
      case 'double_click':
        await desktop.doubleClick(options.x, options.y);
        break;
      case 'right_click':
        await desktop.rightClick(options.x, options.y);
        break;
      case 'move':
        if (options.x === undefined || options.y === undefined) throw new Error('x and y are required.');
        await desktop.moveMouse(options.x, options.y);
        break;
      case 'type':
        if (!options.text) throw new Error('text is required.');
        await desktop.write(options.text);
        break;
      case 'key':
        if (!options.key) throw new Error('key is required, e.g. "Enter" or "ctrl+c".');
        await desktop.press(options.key.includes('+') ? options.key.split('+') : options.key);
        break;
      case 'scroll':
        await desktop.scroll(options.direction ?? 'down', Math.min(20, Math.max(1, options.amount ?? 3)));
        break;
      case 'drag':
        if (options.x === undefined || options.y === undefined || options.toX === undefined || options.toY === undefined) {
          throw new Error('drag needs x, y, toX and toY.');
        }
        await desktop.drag([options.x, options.y], [options.toX, options.toY]);
        break;
      case 'open':
        if (!options.target) throw new Error('target URL or file is required.');
        await desktop.open(options.target);
        break;
      case 'launch':
        if (!options.target) throw new Error('An application name is required.');
        await desktop.launch(options.target);
        break;
      default:
        throw new Error(`Unknown desktop action ${options.action}.`);
    }

    if (options.action === 'screenshot' || options.action !== 'type' && options.action !== 'key') {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    const shot = await desktop.screenshot();
    await fs.mkdir(SCREEN_DIR, { recursive: true });
    const file = path.join(SCREEN_DIR, 'latest.png');
    await fs.writeFile(file, shot);
    return {
      message:
        options.action === 'screenshot'
          ? 'Captured the desktop.'
          : `Performed ${options.action} and captured the result.`,
      screenshot: file,
    };
  } catch (error) {
    throw friendlyError(error);
  }
}

export function screenshotPath(): string {
  return path.join(SCREEN_DIR, 'latest.png');
}

export async function hasScreenshot(): Promise<boolean> {
  try {
    const stat = await fs.stat(screenshotPath());
    return stat.size > 0;
  } catch {
    return false;
  }
}
