import fs from 'node:fs/promises';
import path from 'node:path';
import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL, WORKSPACE_BUCKET, WORKSPACE_DIR } from './env.ts';
import { fetchWithTimeout } from './util.ts';

/**
 * The agent's file workspace.
 *
 * Two backends, one interface:
 *
 *   supabase — objects in a private Supabase Storage bucket. Chosen whenever
 *              SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set. Nothing is
 *              written to the host's disk, so a container with no volume (or a
 *              read-only filesystem) is enough.
 *   disk     — the original behaviour: files under DATA_DIR/workspace.
 *
 * Tools never care which one is active. Paths are always workspace-relative
 * and are validated here, so neither backend can be walked out of.
 */

const CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const MAX_ENTRIES = 200;

export type WorkspaceBackend = 'supabase' | 'disk';

export function workspaceBackend(): WorkspaceBackend {
  return CONFIGURED ? 'supabase' : 'disk';
}

/**
 * Reject absolute paths and any parent traversal. Returns the normalised
 * workspace-relative path ('' means the workspace root).
 */
export function cleanWorkspacePath(raw: string, allowEmpty = false): string {
  const clean = (raw ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!clean) {
    if (allowEmpty) return '';
    throw new Error('A workspace path is required.');
  }
  const segments = clean.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new Error('That path is outside the BLOBS workspace.');
  }
  return segments.join('/');
}

/* ------------------------------------------------------------------ */
/* Supabase Storage (REST, no SDK)                                     */
/* ------------------------------------------------------------------ */

const STORAGE = `${SUPABASE_URL}/storage/v1`;

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

function objectUrl(objectPath: string): string {
  const encoded = objectPath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${STORAGE}/object/${encodeURIComponent(WORKSPACE_BUCKET)}/${encoded}`;
}

async function storageError(response: Response, action: string): Promise<Error> {
  const body = await response.text().catch(() => '');
  return new Error(
    `Supabase Storage ${action} failed (${response.status}): ${body.slice(0, 240) || response.statusText}`,
  );
}

/**
 * Create the bucket on first use so a fresh project needs no dashboard steps.
 * Memoised, and retried on the next call if it failed.
 */
let bucketReady: Promise<void> | null = null;

function ensureBucket(): Promise<void> {
  if (bucketReady) return bucketReady;
  const attempt = (async () => {
    const response = await fetchWithTimeout(`${STORAGE}/bucket`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ id: WORKSPACE_BUCKET, name: WORKSPACE_BUCKET, public: false }),
    });
    if (response.ok || response.status === 409) return;
    const body = await response.text().catch(() => '');
    if (/already exists|duplicate/i.test(body)) return;
    throw new Error(
      `Could not create the "${WORKSPACE_BUCKET}" storage bucket (${response.status}): ${body.slice(0, 200)}. ` +
        'Create it manually in Supabase → Storage, or check SUPABASE_SERVICE_ROLE_KEY.',
    );
  })().catch((error) => {
    bucketReady = null;
    throw error;
  });
  bucketReady = attempt;
  return attempt;
}

interface StorageItem {
  name: string;
  id: string | null;
  metadata?: { size?: number } | null;
}

async function listPrefix(prefix: string): Promise<StorageItem[]> {
  const response = await fetchWithTimeout(`${STORAGE}/object/list/${encodeURIComponent(WORKSPACE_BUCKET)}`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!response.ok) throw await storageError(response, 'list');
  const rows = (await response.json()) as StorageItem[];
  return Array.isArray(rows) ? rows : [];
}

async function listRemote(prefix: string, depth: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(folder: string, level: number): Promise<void> {
    if (level > depth || out.length > MAX_ENTRIES) return;
    for (const item of await listPrefix(folder)) {
      if (!item?.name) continue;
      const full = folder ? `${folder}/${item.name}` : item.name;
      if (item.id === null) {
        out.push(`${full}/`);
        await walk(full, level + 1);
      } else {
        const kb = Math.ceil((item.metadata?.size ?? 0) / 1024);
        out.push(`${full} (${kb} KB)`);
      }
    }
  }
  await walk(prefix, 0);
  return out;
}

async function readRemote(objectPath: string): Promise<Uint8Array | null> {
  const response = await fetchWithTimeout(objectUrl(objectPath), { headers: authHeaders() });
  if (response.status === 404) return null;
  if (!response.ok) throw await storageError(response, 'download');
  return new Uint8Array(await response.arrayBuffer());
}

/** fetch wants an ArrayBuffer-backed body, so binary uploads get an exact copy. */
function requestBody(body: string | Uint8Array): BodyInit {
  if (typeof body === 'string') return body;
  const copy = new ArrayBuffer(body.byteLength);
  new Uint8Array(copy).set(body);
  return copy;
}

async function writeRemote(objectPath: string, body: string | Uint8Array, contentType: string): Promise<number> {
  await ensureBucket();
  const response = await fetchWithTimeout(objectUrl(objectPath), {
    method: 'POST',
    headers: authHeaders({ 'content-type': contentType, 'x-upsert': 'true', 'cache-control': 'no-cache' }),
    body: requestBody(body),
  });
  if (!response.ok) throw await storageError(response, 'upload');
  return typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
}

/* ------------------------------------------------------------------ */
/* Disk backend (original behaviour)                                    */
/* ------------------------------------------------------------------ */

function diskPath(relative: string): string {
  const resolved = path.resolve(WORKSPACE_DIR, relative);
  if (!resolved.startsWith(WORKSPACE_DIR + path.sep) && resolved !== WORKSPACE_DIR) {
    throw new Error('That path is outside the BLOBS workspace.');
  }
  return resolved;
}

async function listDisk(prefix: string, depth: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(folder: string, level: number): Promise<void> {
    if (level > depth || out.length > MAX_ENTRIES) return;
    let entries;
    try {
      entries = await fs.readdir(diskPath(folder), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(`${relative}/`);
        await walk(relative, level + 1);
      } else {
        const stat = await fs.stat(diskPath(relative)).catch(() => null);
        out.push(`${relative} (${stat ? Math.ceil(stat.size / 1024) : '?'} KB)`);
      }
    }
  }
  await walk(prefix, 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* Public interface                                                    */
/* ------------------------------------------------------------------ */

/** Human-readable listing, one entry per line, same shape as before. */
export async function listWorkspace(dir = '', depth = 2): Promise<string[]> {
  const prefix = cleanWorkspacePath(dir, true);
  return workspaceBackend() === 'supabase' ? listRemote(prefix, depth) : listDisk(prefix, depth);
}

export async function writeWorkspaceText(relativePath: string, content: string): Promise<string> {
  const target = cleanWorkspacePath(relativePath);
  if (workspaceBackend() === 'supabase') {
    await writeRemote(target, content, 'text/plain; charset=utf-8');
  } else {
    const resolved = diskPath(target);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf8');
  }
  return target;
}

export async function writeWorkspaceBytes(relativePath: string, bytes: Uint8Array): Promise<number> {
  const target = cleanWorkspacePath(relativePath);
  if (workspaceBackend() === 'supabase') return writeRemote(target, bytes, 'application/octet-stream');
  const resolved = diskPath(target);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, bytes);
  return bytes.byteLength;
}

export async function readWorkspaceText(relativePath: string): Promise<string | null> {
  const target = cleanWorkspacePath(relativePath);
  if (workspaceBackend() === 'supabase') {
    const bytes = await readRemote(target);
    return bytes ? Buffer.from(bytes).toString('utf8') : null;
  }
  try {
    const stat = await fs.stat(diskPath(target));
    if (!stat.isFile()) return null;
    return await fs.readFile(diskPath(target), 'utf8');
  } catch {
    return null;
  }
}

export async function readWorkspaceBytes(relativePath: string): Promise<Uint8Array | null> {
  const target = cleanWorkspacePath(relativePath);
  if (workspaceBackend() === 'supabase') return readRemote(target);
  try {
    const stat = await fs.stat(diskPath(target));
    if (!stat.isFile()) return null;
    return new Uint8Array(await fs.readFile(diskPath(target)));
  } catch {
    return null;
  }
}

