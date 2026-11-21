import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Minimal .env loader. Keeps BLOBS dependency-free for configuration and
 * avoids silently overwriting variables that the host already provides.
 */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
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
    if (!(key in process.env)) process.env[key] = value;
  }
}

export const ROOT = path.resolve(import.meta.dirname, '..');
loadDotEnv(path.join(ROOT, '.env'));

export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR ?? '.data');
export const WORKSPACE_DIR = path.join(DATA_DIR, 'workspace');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');

/**
 * Where the agent's memory lives: Postgres, normally a Supabase project.
 *
 *   DATABASE_URL=postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres
 *
 * Supabase's pooled connection string is the right one for a long-lived Node
 * process: it survives the small connection limit of the free tier. Copy it
 * from Project Settings → Database → Connection string → Connection pooling.
 *
 * Unset falls back to a local Postgres for development (`docker compose up -d db`).
 */
export const DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.SUPABASE_DB_URL ??
  process.env.POSTGRES_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5432/blobs';

/** 'require' forces TLS, 'disable' turns it off for a plain local server. */
export const PG_SSL = process.env.PG_SSL ?? '';
export const PG_POOL_MAX = Number(process.env.PG_POOL_MAX ?? 10);

/**
 * Supabase Storage for the agent's file workspace. Optional: without both of
 * these, workspace files stay on disk under DATA_DIR/workspace.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=<Project Settings → API → service_role>
 *
 * The service-role key bypasses Row Level Security, so it is only ever used by
 * the server and is never sent to the browser.
 */
export const SUPABASE_URL = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')
  .trim()
  .replace(/\/+$/, '');
export const SUPABASE_SERVICE_ROLE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? ''
).trim();
export const WORKSPACE_BUCKET = process.env.WORKSPACE_BUCKET?.trim() || 'blobs-workspace';

export const PORT = Number(process.env.PORT ?? 3000);
export const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * What this process does:
 *   all    — serve HTTP and run the scheduler (default; one process, one host)
 *   server — serve HTTP only, used by the Vercel container service
 *   worker — run the scheduler only (server/worker.ts, the Vercel daemon)
 */
export const ROLE = (process.env.BLOBS_ROLE ?? 'all').toLowerCase();
export const SESSION_DAYS = Number(process.env.SESSION_DAYS ?? 30);

for (const dir of [DATA_DIR, WORKSPACE_DIR, TMP_DIR]) {
  // A container with a read-only or absent disk is fine when workspace files
  // live in Supabase Storage and BLOBS_SECRET is set; do not fail the boot.
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* the directory is only needed by the disk-backed workspace and secret.key */
  }
}

/**
 * Master key for encrypting integration credentials at rest. Generated on
 * first boot and stored next to the database with owner-only permissions.
 */
function resolveSecret(): Buffer {
  const fromEnv = process.env.BLOBS_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    return crypto.createHash('sha256').update(fromEnv).digest();
  }
  const keyFile = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(keyFile)) {
    return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  }
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  } catch (error) {
    throw new Error(
      `Could not write ${keyFile} (${(error as Error).message}). Set BLOBS_SECRET to a 32+ character random string on hosts without a writable disk.`,
    );
  }
  return key;
}

export const SECRET_KEY = resolveSecret();
export const APP_VERSION = '1.0.0';
