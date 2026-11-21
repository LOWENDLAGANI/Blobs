import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from './env.ts';
import { fetchWithTimeout } from './util.ts';

/**
 * Supabase Auth over its REST API, server-side only.
 *
 * The browser never holds a Supabase key or a Supabase session: BLOBS verifies
 * the owner's email and password here, then issues its own http-only session
 * cookie exactly as before. That keeps every existing API route, CSRF check and
 * session rule unchanged, and means the password is never stored in Postgres.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (Project Settings → API).
 * The service-role key bypasses Row Level Security, so it stays on the server.
 */

const AUTH = `${SUPABASE_URL}/auth/v1`;

export function supabaseAuthReady(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

function jsonHeaders(): Record<string, string> {
  return headers({ 'content-type': 'application/json' });
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function describe(body: Record<string, unknown>): string {
  const message =
    body.msg ?? body.message ?? body.error_description ?? body.error ?? body.code ?? '';
  return String(message || 'unknown error').slice(0, 200);
}

export interface SupabaseUser {
  id: string;
  email: string;
}

/** Admin create. The address is confirmed immediately so no inbox round trip is needed. */
export async function createUser(email: string, password: string): Promise<SupabaseUser> {
  const response = await fetchWithTimeout(`${AUTH}/admin/users`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await readBody(response);
  if (!response.ok) {
    const detail = describe(body);
    if (/already|exist|registered|duplicate/i.test(detail) || response.status === 422) {
      throw new Error('That email already has an account. Sign in instead.');
    }
    throw new Error(`Supabase Auth could not create the account (${response.status}): ${detail}`);
  }
  return { id: String(body.id ?? ''), email: String(body.email ?? email) };
}

/** Password sign-in. Returns null for bad credentials, throws for real failures. */
export async function verifyPassword(email: string, password: string): Promise<SupabaseUser | null> {
  const response = await fetchWithTimeout(`${AUTH}/token?grant_type=password`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password }),
  });
  if (response.status === 400 || response.status === 401 || response.status === 422) return null;
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(`Supabase Auth rejected the sign-in (${response.status}): ${describe(body)}`);
  }
  const user = (body.user ?? {}) as { id?: string; email?: string };
  if (!user.id) throw new Error('Supabase Auth returned no user for that sign-in.');
  return { id: String(user.id), email: String(user.email ?? email) };
}

export async function updatePassword(userId: string, password: string): Promise<void> {
  const response = await fetchWithTimeout(`${AUTH}/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    throw new Error(`Supabase Auth could not change the password (${response.status}): ${describe(await readBody(response))}`);
  }
}

/** Fallback for owner rows created before the user id was stored. */
export async function findUserByEmail(email: string): Promise<string | null> {
  const response = await fetchWithTimeout(`${AUTH}/admin/users?page=1&per_page=200`, { headers: headers() });
  if (!response.ok) return null;
  const body = await readBody(response);
  const users = (Array.isArray(body) ? body : (body.users as unknown[] | undefined) ?? []) as {
    id?: string;
    email?: string;
  }[];
  const match = users.find((user) => String(user.email ?? '').toLowerCase() === email.toLowerCase());
  return match?.id ? String(match.id) : null;
}
