/**
 * Host BLOBS itself on a Daytona sandbox.
 *
 * Daytona gives BLOBS what a Worker platform cannot: a real Linux box with a
 * disk, where the server, the SQLite file, the workspace and the scheduler all
 * live. The sandbox is created with `idleExpirySeconds: DISABLED`, so it does
 * not stop when nobody interacts with it, and its disk survives stop/start.
 *
 * Two machines, kept apart:
 *   - this sandbox           → the BLOBS server and its memory
 *   - the E2B cloud computer → the machine BLOBS uses to run code (server/computer/e2b.ts)
 *
 * The E2B key is never needed here, and this Daytona key is never sent into the
 * sandbox's environment.
 *
 * Usage:
 *   npm run deploy:daytona           create/reuse the sandbox, build, start, print URL
 *   node scripts/daytona.ts status   sandbox state and public URL
 *   node scripts/daytona.ts logs     last 200 lines of the server log
 *   node scripts/daytona.ts stop     stop the sandbox, keeping its disk
 *   node scripts/daytona.ts start    start the same sandbox and relaunch BLOBS
 *   node scripts/daytona.ts destroy  delete the sandbox and everything on it
 *
 * Requires DAYTONA_API_KEY (app.daytona.io → Keys). Optional: DAYTONA_API_URL,
 * DAYTONA_TARGET, and a local .env whose values are handed to the server.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Daytona } from '@daytona/sdk';
import { DISABLED, type ProcessResult, type Sandbox } from '@daytona/sdk/v2';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_NAME = 'blobs';
const APP_PORT = 3000;
const IMAGE = 'node:22';
const TAG = 'blobs-app';
const STATE_FILE = path.join(ROOT, '.daytona.json');
const ARCHIVE_ENTRIES = [
  'server',
  'web',
  'scripts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'README.md',
];
const ARCHIVE_EXCLUDES = ['node_modules', '.git', '.data', 'web/dist', '.daytona.json', '.env', '*.log'];

interface DeployState {
  sandboxId: string;
  url?: string;
  updatedAt: string;
}

function say(message: string): void {
  console.log(`[daytona] ${message}`);
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function readState(): DeployState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as DeployState;
    return parsed.sandboxId ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(patch: Partial<DeployState>): void {
  const next: DeployState = {
    sandboxId: '',
    ...readState(),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  if (!next.sandboxId) throw new Error('Refusing to write deploy state without a sandbox id.');
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function assertKey(): void {
  if (!process.env.DAYTONA_API_KEY?.trim()) {
    throw new Error(
      'No Daytona API key. Create one at app.daytona.io → Keys, then run: export DAYTONA_API_KEY=...',
    );
  }
}

function readDotEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

/** Let hosting credentials live in .env like everything else, without overriding the shell. */
function loadDotEnv(): void {
  for (const [key, value] of Object.entries(readDotEnv())) {
    if (key.startsWith('DAYTONA_') && !(key in process.env)) process.env[key] = value;
  }
}

/**
 * Read the local .env so the remote process gets the same provider keys and
 * database settings the developer configured. Only parsed, never uploaded.
 * Hosting credentials stay out: they have no business inside the sandbox.
 */
function appEnv(): Record<string, string> {
  const env: Record<string, string> = { NODE_ENV: 'production' };
  for (const [key, value] of Object.entries(readDotEnv())) {
    if (!key.startsWith('DAYTONA_')) env[key] = value;
  }
  // The public URL is the sandbox edge, so the app always listens on this port.
  env.PORT = String(APP_PORT);
  env.HOST = '0.0.0.0';
  return env;
}

function makeArchive(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-daytona-'));
  const archive = path.join(dir, 'app.tgz');
  const args = ['-czf', archive, ...ARCHIVE_EXCLUDES.map((pattern) => `--exclude=${pattern}`), ...ARCHIVE_ENTRIES];
  execFileSync('tar', args, { cwd: ROOT, stdio: 'pipe' });
  return archive;
}

async function ensureRunning(sandbox: Sandbox): Promise<void> {
  await sandbox.refreshData();
  if (sandbox.state === 'started') return;
  if (sandbox.state === 'destroyed' || sandbox.state === 'destroying') {
    throw new Error(`Sandbox ${sandbox.id} no longer exists. Run "node scripts/daytona.ts deploy" to create a new one.`);
  }
  say(`Starting sandbox ${sandbox.id} (was ${sandbox.state})…`);
  await sandbox.start({ timeoutSeconds: 180 });
}

async function keepAwake(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.updateLifecyclePolicy({ idleExpirySeconds: DISABLED });
  } catch (error) {
    say(`Warning: could not clear the idle stop policy: ${(error as Error).message}`);
  }
}

function isAuthError(error: unknown): boolean {
  return /401|unauthori[sz]ed|invalid.{0,10}(api.{0,10})?key/i.test((error as Error)?.message ?? '');
}

async function resolveSandbox(daytona: Daytona, create: boolean): Promise<Sandbox | null> {
  const state = readState();
  if (state) {
    try {
      const sandbox = await daytona.v2.get(state.sandboxId);
      await ensureRunning(sandbox);
      return sandbox;
    } catch (error) {
      // A bad key must not read as "no deployment yet".
      if (isAuthError(error)) throw error;
      say(`Saved sandbox is gone (${(error as Error).message}).`);
    }
  }

  try {
    const [existing] = await daytona.v2.findByName(APP_NAME);
    if (existing) {
      say(`Found existing sandbox named "${APP_NAME}".`);
      await ensureRunning(existing);
      writeState({ sandboxId: existing.id });
      return existing;
    }
  } catch (error) {
    if (isAuthError(error)) throw error;
    // Search is optional on some deployments; creating is the fallback.
  }

  if (!create) return null;

  say(`Creating sandbox "${APP_NAME}" from ${IMAGE} (idle auto-stop disabled)…`);
  const sandbox = await daytona.v2.create(IMAGE, {
    name: APP_NAME,
    labels: { app: APP_NAME, role: 'host' },
    lifecyclePolicy: { idleExpirySeconds: DISABLED },
    waitSeconds: 300,
  });
  writeState({ sandboxId: sandbox.id });
  say(`Sandbox ${sandbox.id} is running.`);
  return sandbox;
}

async function homeDir(sandbox: Sandbox): Promise<string> {
  const result = await sandbox.process.run('printf %s "$HOME"');
  const home = result.stdout.trim();
  return home.startsWith('/') ? home : '/home/daytona';
}

async function appDir(sandbox: Sandbox): Promise<string> {
  return path.posix.join(await homeDir(sandbox), APP_NAME);
}

async function sh(
  sandbox: Sandbox,
  command: string,
  options: { cwd?: string; timeoutSeconds?: number } = {},
): Promise<ProcessResult> {
  const timeoutSeconds = options.timeoutSeconds ?? 120;
  const result = await sandbox.process.run(command, {
    cwd: options.cwd,
    timeoutSeconds,
    executionTimeoutSeconds: timeoutSeconds + 30,
  });
  if ((result.exitCode ?? 1) !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`Command failed (${result.exitCode}): ${command}${detail ? `\n${truncate(detail, 2000)}` : ''}`);
  }
  return result;
}

const HEALTH_COMMAND = `node -e "fetch('http://127.0.0.1:${APP_PORT}/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"`;

/**
 * Record the sandbox in the app directory itself, so the running server can
 * report its own host, sandbox id and public URL in Integrations → Machines.
 * The local .daytona.json is for this CLI; the copy inside the sandbox is for
 * the app, and is refreshed on every deploy and start.
 */
async function writeHostState(sandbox: Sandbox, dir: string, url: string): Promise<void> {
  const payload = Buffer.from(
    JSON.stringify({ sandboxId: sandbox.id, url, updatedAt: new Date().toISOString() }),
    'utf8',
  ).toString('base64');
  await sh(sandbox, `printf %s '${payload}' | base64 -d > .daytona.json`, { cwd: dir });
}

async function startApp(sandbox: Sandbox, dir: string): Promise<void> {
  await sandbox.process.killAll({ tag: TAG }).catch(() => undefined);
  say('Launching the BLOBS server…');
  await sandbox.process.start('mkdir -p .data && exec node server/index.ts >> .data/server.log 2>&1', {
    cwd: dir,
    env: appEnv(),
    tag: TAG,
    keepLogs: 'until_cleanup',
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const health = await sandbox.process.run(HEALTH_COMMAND, { timeoutSeconds: 10 });
    if ((health.exitCode ?? 1) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  const logs = await sandbox.process.run('tail -n 40 .data/server.log', { cwd: dir, timeoutSeconds: 15 });
  throw new Error(`BLOBS did not become healthy on port ${APP_PORT}.\n${truncate(logs.stdout || logs.stderr, 3000)}`);
}

async function deploy(daytona: Daytona): Promise<void> {
  const sandbox = await resolveSandbox(daytona, true);
  if (!sandbox) throw new Error('Could not create the Daytona sandbox.');
  await keepAwake(sandbox);

  const dir = await appDir(sandbox);
  say(`Uploading the project to ${dir}…`);
  await sh(sandbox, `mkdir -p "${dir}"`);
  const archive = makeArchive();
  try {
    await sandbox.fs.uploadFile(archive, `${dir}/app.tgz`);
  } finally {
    fs.rmSync(path.dirname(archive), { recursive: true, force: true });
  }
  await sh(sandbox, 'tar -xzf app.tgz && rm -f app.tgz', { cwd: dir });

  say('Installing dependencies (npm ci)…');
  await sh(sandbox, 'npm ci --no-audit --no-fund', { cwd: dir, timeoutSeconds: 900 });
  say('Building the web control centre…');
  await sh(sandbox, 'npm run build', { cwd: dir, timeoutSeconds: 300 });

  await startApp(sandbox, dir);

  const endpoint = await sandbox.ports.expose(APP_PORT, { public: true });
  writeState({ sandboxId: sandbox.id, url: endpoint.url });
  await writeHostState(sandbox, dir, endpoint.url);
  say(`BLOBS is live: ${endpoint.url}`);
  say('The URL is public, but the owner passphrase still guards the control centre.');
  say('Idle auto-stop is disabled; "node scripts/daytona.ts stop" takes it offline and keeps the disk.');
}

async function status(daytona: Daytona): Promise<void> {
  const sandbox = await resolveSandbox(daytona, false);
  if (!sandbox) {
    say('No BLOBS sandbox yet. Run "npm run deploy:daytona".');
    return;
  }
  const state = readState();
  let url = state?.url ?? '';
  try {
    const endpoints = await sandbox.ports.listEndpoints();
    url = endpoints.items.find((item) => item.port === APP_PORT)?.url ?? url;
  } catch {
    // Not exposed yet, or the sandbox is stopped.
  }
  const lifecycle = sandbox.lifecyclePolicy;
  console.log(
    [
      `sandbox   ${sandbox.id} (${sandbox.state})`,
      `name      ${sandbox.name ?? APP_NAME}`,
      `idle stop ${lifecycle?.idleExpirySeconds ? `${lifecycle.idleExpirySeconds}s` : 'disabled'}`,
      `url       ${url || '(not exposed yet)'}`,
      `updated   ${state?.updatedAt ?? 'unknown'}`,
    ].join('\n'),
  );
}

async function logs(daytona: Daytona): Promise<void> {
  const sandbox = await resolveSandbox(daytona, false);
  if (!sandbox) throw new Error('No BLOBS sandbox yet. Run "npm run deploy:daytona".');
  const dir = await appDir(sandbox);
  const result = await sandbox.process.run('tail -n 200 .data/server.log', { cwd: dir, timeoutSeconds: 20 });
  console.log(result.stdout || result.stderr || '(the server log is empty)');
}

async function stop(daytona: Daytona): Promise<void> {
  const sandbox = await resolveSandbox(daytona, false);
  if (!sandbox) throw new Error('No BLOBS sandbox yet. Run "npm run deploy:daytona".');
  await sandbox.stop({ timeoutSeconds: 120 });
  say(`Sandbox ${sandbox.id} stopped. Its disk, database and workspace are kept.`);
}

async function start(daytona: Daytona): Promise<void> {
  const sandbox = await resolveSandbox(daytona, false);
  if (!sandbox) throw new Error('No BLOBS sandbox yet. Run "npm run deploy:daytona".');
  await keepAwake(sandbox);
  const dir = await appDir(sandbox);
  await startApp(sandbox, dir);
  const endpoint = await sandbox.ports.expose(APP_PORT, { public: true });
  writeState({ sandboxId: sandbox.id, url: endpoint.url });
  await writeHostState(sandbox, dir, endpoint.url);
  say(`BLOBS is live again: ${endpoint.url}`);
}

async function destroy(daytona: Daytona): Promise<void> {
  const sandbox = await resolveSandbox(daytona, false);
  if (!sandbox) {
    fs.rmSync(STATE_FILE, { force: true });
    say('No BLOBS sandbox to destroy.');
    return;
  }
  await sandbox.delete({ timeoutSeconds: 120 });
  fs.rmSync(STATE_FILE, { force: true });
  say(`Sandbox ${sandbox.id} deleted, along with its database and workspace.`);
}

async function main(): Promise<void> {
  const command = (process.argv[2] ?? 'deploy').toLowerCase();
  const commands: Record<string, (daytona: Daytona) => Promise<void>> = {
    deploy,
    status,
    logs,
    stop,
    start,
    destroy,
  };
  const action = commands[command];
  if (!action) {
    throw new Error(`Unknown command "${command}". Use deploy, status, logs, stop, start or destroy.`);
  }

  loadDotEnv();
  assertKey();
  const daytona = new Daytona();
  try {
    await action(daytona);
  } finally {
    await daytona.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const message = (error as Error)?.message ?? String(error);
  if (/401|unauthori[sz]ed|invalid.{0,10}(api.{0,10})?key/i.test(message)) {
    console.error('Daytona rejected the API key. Check DAYTONA_API_KEY (app.daytona.io → Keys).');
  } else if (/402|quota|billing|credit|limit reached|budget/i.test(message)) {
    console.error(`Daytona refused the request because of a quota, budget or billing limit.\n${message}`);
  } else {
    console.error(`Daytona deploy failed: ${message}`);
  }
  process.exit(1);
});
