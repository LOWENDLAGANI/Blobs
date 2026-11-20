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
export const DB_PATH = path.join(DATA_DIR, 'blobs.db');

export const PORT = Number(process.env.PORT ?? 3000);
export const HOST = process.env.HOST ?? '0.0.0.0';
export const SESSION_DAYS = Number(process.env.SESSION_DAYS ?? 30);

for (const dir of [DATA_DIR, WORKSPACE_DIR, TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
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
  fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  return key;
}

export const SECRET_KEY = resolveSecret();
export const APP_VERSION = '1.0.0';
