import crypto from 'node:crypto';
import { all, get, run } from './db.ts';
import { getSecret, setSecret } from './settings.ts';
import { id, now } from './util.ts';

export interface OAuthPreset {
  id: string;
  name: string;
  authUrl: string;
  tokenUrl: string;
  defaultScopes: string;
  accountUrl?: string;
}

export const OAUTH_PRESETS: Record<string, OAuthPreset> = {
  github: {
    id: 'github',
    name: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    defaultScopes: 'read:user user:email',
    accountUrl: 'https://api.github.com/user',
  },
  google: {
    id: 'google',
    name: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    defaultScopes: 'openid email profile',
    accountUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
  },
};

export interface OAuthConnection {
  provider: string;
  account: string | null;
  scopes: string;
  accessExpiresAt: number | null;
  connectedAt: number;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function codeVerifier(): string {
  return base64Url(crypto.randomBytes(64));
}

function codeChallenge(verifier: string): string {
  return base64Url(crypto.createHash('sha256').update(verifier).digest());
}

function stateToken(): string {
  return base64Url(crypto.randomBytes(24));
}

export async function startOAuth(input: {
  provider: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string;
  redirectUri: string;
}): Promise<{ url: string; state: string }> {
  const preset = OAUTH_PRESETS[input.provider];
  if (!preset) throw new Error('Unknown provider. Use github or google.');
  if (!input.clientId.trim()) throw new Error('Client id is required.');
  const scopes = (input.scopes?.trim() || preset.defaultScopes).trim();
  const verifier = codeVerifier();
  const state = stateToken();
  const expiresAt = now() + 10 * 60 * 1000;
  await run(
    `INSERT INTO oauth_states(state, provider, client_id, redirect_uri, code_verifier, scopes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    state,
    input.provider,
    input.clientId.trim(),
    input.redirectUri,
    verifier,
    scopes,
    now(),
    expiresAt,
  );
  await setSecret(`oauth:${input.provider}:clientId`, input.clientId.trim());
  if (input.clientSecret?.trim()) {
    await setSecret(`oauth:${input.provider}:clientSecret`, input.clientSecret.trim());
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId.trim(),
    redirect_uri: input.redirectUri,
    scope: scopes,
    state,
    code_challenge: codeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  if (input.provider === 'google') {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  }
  return { url: `${preset.authUrl}?${params.toString()}`, state };
}

export async function completeOAuth(input: { code: string; state: string }): Promise<OAuthConnection> {
  const row = await get<{
    provider: string;
    client_id: string;
    redirect_uri: string;
    code_verifier: string;
    scopes: string;
    expires_at: number;
  }>('SELECT * FROM oauth_states WHERE state = ?', input.state);
  if (!row) throw new Error('Unknown or expired OAuth state.');
  if (row.expires_at <= now()) {
    await run('DELETE FROM oauth_states WHERE state = ?', input.state);
    throw new Error('OAuth state expired. Start again.');
  }
  const preset = OAUTH_PRESETS[row.provider];
  if (!preset) throw new Error('Unknown provider.');

  const clientSecret = await getSecret(`oauth:${row.provider}:clientSecret`);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: row.redirect_uri,
    client_id: row.client_id,
    code_verifier: row.code_verifier,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const response = await fetch(preset.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Token exchange failed.');
  }

  await setSecret(`oauth:${row.provider}:accessToken`, data.access_token);
  if (data.refresh_token) await setSecret(`oauth:${row.provider}:refreshToken`, data.refresh_token);

  let account: string | null = null;
  if (preset.accountUrl) {
    try {
      const profileResponse = await fetch(preset.accountUrl, {
        headers: { authorization: `Bearer ${data.access_token}`, accept: 'application/json' },
      });
      if (profileResponse.ok) {
        const profile = (await profileResponse.json()) as Record<string, unknown>;
        account = String(profile.login || profile.email || profile.name || profile.sub || '').trim() || null;
      }
    } catch {
      account = null;
    }
  }

  const expiresAt = data.expires_in ? now() + data.expires_in * 1000 : null;
  await run(
    `INSERT INTO oauth_connections(provider, account, scopes, access_expires_at, connected_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       account = excluded.account,
       scopes = excluded.scopes,
       access_expires_at = excluded.access_expires_at,
       connected_at = excluded.connected_at`,
    row.provider,
    account,
    row.scopes,
    expiresAt,
    now(),
  );
  await run('DELETE FROM oauth_states WHERE state = ?', input.state);
  return { provider: row.provider, account, scopes: row.scopes, accessExpiresAt: expiresAt, connectedAt: now() };
}

export async function listConnections(): Promise<OAuthConnection[]> {
  const rows = await all<{ provider: string; account: string | null; scopes: string; access_expires_at: number | null; connected_at: number }>(
    'SELECT * FROM oauth_connections ORDER BY connected_at DESC',
  );
  return rows.map((row) => ({
    provider: row.provider,
    account: row.account,
    scopes: row.scopes,
    accessExpiresAt: row.access_expires_at,
    connectedAt: row.connected_at,
  }));
}

export async function deleteConnection(provider: string): Promise<boolean> {
  const existing = await get('SELECT provider FROM oauth_connections WHERE provider = ?', provider);
  if (!existing) return false;
  await run('DELETE FROM oauth_connections WHERE provider = ?', provider);
  await setSecret(`oauth:${provider}:accessToken`, null);
  await setSecret(`oauth:${provider}:refreshToken`, null);
  await setSecret(`oauth:${provider}:clientSecret`, null);
  await setSecret(`oauth:${provider}:clientId`, null);
  return true;
}

async function refreshToken(provider: string): Promise<string | null> {
  const preset = OAUTH_PRESETS[provider];
  if (!preset) return null;
  const clientId = await getSecret(`oauth:${provider}:clientId`);
  if (!clientId) return null;
  const clientSecret = await getSecret(`oauth:${provider}:clientSecret`);
  const refreshTokenValue = await getSecret(`oauth:${provider}:refreshToken`);
  if (!refreshTokenValue) return null;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshTokenValue, client_id: clientId });
  if (clientSecret) body.set('client_secret', clientSecret);
  const response = await fetch(preset.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!response.ok || !data.access_token) return null;
  await setSecret(`oauth:${provider}:accessToken`, data.access_token);
  if (data.expires_in) {
    await run('UPDATE oauth_connections SET access_expires_at = ? WHERE provider = ?', now() + data.expires_in * 1000, provider);
  }
  return data.access_token;
}

export async function getAccessToken(provider: string): Promise<string | null> {
  const token = await getSecret(`oauth:${provider}:accessToken`);
  const connection = await get<{ access_expires_at: number | null }>('SELECT access_expires_at FROM oauth_connections WHERE provider = ?', provider);
  if (token && (!connection?.access_expires_at || connection.access_expires_at > now() + 30_000)) return token;
  return refreshToken(provider);
}

export async function oauthRequest(input: {
  provider: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  const token = await getAccessToken(input.provider);
  if (!token) throw new Error(`No OAuth connection for ${input.provider}. Connect it first.`);
  const response = await fetch(input.url, {
    method: input.method || 'GET',
    headers: { ...(input.headers ?? {}), authorization: `Bearer ${token}` },
    body: input.body,
  });
  const text = await response.text();
  return { status: response.status, body: text.slice(0, 20_000) };
}
