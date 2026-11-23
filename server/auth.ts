import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { get, run } from './db.ts';
import { now, sha256 } from './util.ts';
import { SESSION_DAYS } from './env.ts';

const COOKIE = 'blobs_session';
const SCRYPT_KEYLEN = 64;

export interface OwnerRow {
  id: number;
  name: string;
  passphrase_hash: string;
  salt: string;
  created_at: number;
}

function hashPassphrase(passphrase: string, salt: string): string {
  return crypto.scryptSync(passphrase, salt, SCRYPT_KEYLEN).toString('hex');
}

export type AuthMode = 'passphrase';

/**
 * BLOBS is passphrase-only: a single owner passphrase, scrypt-hashed on the
 * server. Supabase Auth is no longer used for sign-in.
 */
export function authMode(): AuthMode {
  return 'passphrase';
}

export interface OwnerIdentity {
  email: string;
  userId: string | null;
  createdAt: number;
}

export async function getOwnerIdentity(): Promise<OwnerIdentity | null> {
  try {
    const row = await get<{ email: string; supabase_user_id: string | null; created_at: number }>(
      'SELECT email, supabase_user_id, created_at FROM owner_identity WHERE id = 1',
    );
    if (!row) return null;
    return { email: row.email, userId: row.supabase_user_id, createdAt: Number(row.created_at) };
  } catch {
    return null;
  }
}

export async function ownerExists(): Promise<boolean> {
  try {
    return (await get<{ id: number }>('SELECT id FROM owner WHERE id = 1')) !== null;
  } catch {
    return false;
  }
}

export async function getOwner(): Promise<OwnerRow | null> {
  return get<OwnerRow>('SELECT * FROM owner WHERE id = 1');
}

export async function createOwner(name: string, passphrase: string): Promise<void> {
  if (await ownerExists()) throw new Error('An owner already exists.');
  if (passphrase.trim().length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  await run(
    'INSERT INTO owner(id, name, passphrase_hash, salt, created_at) VALUES (1, ?, ?, ?, ?)',
    name.trim() || 'Owner',
    hashPassphrase(passphrase, salt),
    salt,
    now(),
  );
}

export async function changePassphrase(current: string, next: string): Promise<void> {
  const owner = await getOwner();
  if (!owner) throw new Error('No owner configured.');
  if (!(await verifyPassphrase(current))) throw new Error('The current passphrase is incorrect.');
  if (next.trim().length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  await run('UPDATE owner SET passphrase_hash = ?, salt = ? WHERE id = 1', hashPassphrase(next, salt), salt);
  await run('DELETE FROM sessions');
}

export async function verifyPassphrase(passphrase: string): Promise<boolean> {
  const owner = await getOwner();
  if (!owner) return false;
  const expected = Buffer.from(owner.passphrase_hash, 'hex');
  const actual = Buffer.from(hashPassphrase(passphrase, owner.salt), 'hex');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/* Simple in-process throttle for login attempts. */
const attempts = new Map<string, { count: number; until: number }>();

export function loginAllowed(ip: string): boolean {
  const record = attempts.get(ip);
  if (!record) return true;
  return record.until < now();
}

export function recordFailedLogin(ip: string): void {
  const record = attempts.get(ip) ?? { count: 0, until: 0 };
  record.count += 1;
  if (record.count >= 5) {
    record.until = now() + 60_000;
    record.count = 0;
  }
  attempts.set(ip, record);
}

export async function createSession(): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const ts = now();
  await run(
    'INSERT INTO sessions(token_hash, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?)',
    sha256(token),
    ts,
    ts + SESSION_DAYS * 86_400_000,
    ts,
  );
  await run('DELETE FROM sessions WHERE expires_at < ?', ts);
  return token;
}

export async function sessionValid(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const row = await get<{ expires_at: number; last_seen: number }>(
    'SELECT expires_at, last_seen FROM sessions WHERE token_hash = ?',
    sha256(token),
  );
  if (!row) return false;
  if (row.expires_at < now()) {
    await run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
    return false;
  }
  if (now() - row.last_seen > 3_600_000) {
    await run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', now(), sha256(token));
  }
  return true;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Set behind HTTPS (the Daytona preview proxy forwards the proto with
    // trustProxy on) but left off on plain-http localhost, where a secure
    // cookie would never be sent back.
    secure: reply.request.protocol === 'https',
    maxAge: SESSION_DAYS * 86_400,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: '/' });
}

export function sessionToken(request: FastifyRequest): string | undefined {
  return request.cookies?.[COOKIE];
}

export async function isAuthed(request: FastifyRequest): Promise<boolean> {
  return sessionValid(sessionToken(request));
}

/** Mutating requests must come from the same origin to block drive-by CSRF. */
export function isSameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const host = request.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
