import { all, get, run } from './db.ts';
import { id, now, truncate } from './util.ts';
import { logActivity } from './activity.ts';

export type MemoryKind = 'fact' | 'preference' | 'project' | 'decision' | 'lesson' | 'person' | 'summary' | 'note';

export interface MemoryInput {
  content: string;
  kind?: MemoryKind;
  tags?: string[];
  importance?: number;
  source?: string;
  pinned?: boolean;
}

export interface MemoryRow {
  id: string;
  kind: MemoryKind;
  content: string;
  tags: string;
  importance: number;
  source: string | null;
  pinned: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  use_count: number;
  score?: number;
}

const KIND_LABELS: Record<string, string> = {
  fact: 'FACT',
  preference: 'PREFERENCE',
  project: 'PROJECT',
  decision: 'DECISION',
  lesson: 'LESSON',
  person: 'PERSON',
  summary: 'SUMMARY',
  note: 'NOTE',
};

export async function remember(input: MemoryInput): Promise<MemoryRow> {
  const content = input.content.trim();
  if (!content) throw new Error('A memory needs content.');
  const ts = now();
  const row: MemoryRow = {
    id: id('mem'),
    kind: input.kind ?? 'fact',
    content: truncate(content, 4000),
    tags: (input.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean).join(' '),
    importance: Math.min(5, Math.max(1, Math.round(input.importance ?? 3))),
    source: input.source ?? 'agent',
    pinned: input.pinned ? 1 : 0,
    created_at: ts,
    updated_at: ts,
    last_used_at: null,
    use_count: 0,
  };
  await run(
    `INSERT INTO memories(id, kind, content, tags, importance, source, pinned, created_at, updated_at, last_used_at, use_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.kind,
    row.content,
    row.tags,
    row.importance,
    row.source,
    row.pinned,
    row.created_at,
    row.updated_at,
    row.last_used_at,
    row.use_count,
  );
  logActivity({
    level: 'info',
    category: 'memory',
    message: `Remembered a ${row.kind}: ${truncate(row.content, 120)}`,
    meta: { memoryId: row.id },
  });
  return row;
}

export async function updateMemory(
  memoryId: string,
  patch: Partial<Pick<MemoryInput, 'content' | 'kind' | 'tags' | 'importance' | 'pinned'>>,
): Promise<MemoryRow | null> {
  const existing = await get<MemoryRow>('SELECT * FROM memories WHERE id = ?', memoryId);
  if (!existing) return null;
  const next: MemoryRow = {
    ...existing,
    content: patch.content !== undefined ? truncate(patch.content.trim(), 4000) : existing.content,
    kind: patch.kind ?? existing.kind,
    tags: patch.tags
      ? patch.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean).join(' ')
      : existing.tags,
    importance: patch.importance !== undefined ? Math.min(5, Math.max(1, Math.round(patch.importance))) : existing.importance,
    pinned: patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : existing.pinned,
    updated_at: now(),
  };
  await run(
    `UPDATE memories SET content = ?, kind = ?, tags = ?, importance = ?, pinned = ?, updated_at = ? WHERE id = ?`,
    next.content,
    next.kind,
    next.tags,
    next.importance,
    next.pinned,
    next.updated_at,
    memoryId,
  );
  return get<MemoryRow>('SELECT * FROM memories WHERE id = ?', memoryId);
}

export async function deleteMemory(memoryId: string): Promise<boolean> {
  const existing = await get<{ id: string }>('SELECT id FROM memories WHERE id = ?', memoryId);
  if (!existing) return false;
  await run('DELETE FROM memories WHERE id = ?', memoryId);
  return true;
}

export async function listMemories(options: { limit?: number; kind?: string; query?: string } = {}): Promise<MemoryRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.kind && options.kind !== 'all') {
    clauses.push('kind = ?');
    params.push(options.kind);
  }
  if (options.query?.trim()) {
    // SQLite's LIKE was case-insensitive; Postgres needs ILIKE for parity.
    clauses.push('(content ILIKE ? OR tags ILIKE ?)');
    const like = `%${options.query.trim()}%`;
    params.push(like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all<MemoryRow>(
    `SELECT * FROM memories ${where} ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ${limit}`,
    ...params,
  );
}

/**
 * Postgres full-text query: prefix-matched lexemes, OR-ed together. Tokens are
 * reduced to letters and digits by the regex, so nothing can inject tsquery
 * syntax; the whole string is still passed as a bound parameter.
 */
function ftsQuery(text: string): string {
  const tokens = (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, 14);
  if (!tokens.length) return '';
  return tokens.map((token) => `'${token}':*`).join(' | ');
}

/** The indexed document; must match the GIN index expression in the schema. */
const SEARCH_DOC = "to_tsvector('english', coalesce(m.content, '') || ' ' || coalesce(m.tags, ''))";

/**
 * Hybrid retrieval: full-text rank, blended with importance, pinning and
 * recency so the agent recalls what actually matters instead of everything.
 */
export async function searchMemories(query: string, limit = 8): Promise<MemoryRow[]> {
  const max = Math.min(Math.max(limit, 1), 40);
  const match = ftsQuery(query);
  const results = new Map<string, MemoryRow>();

  if (match) {
    const rows = await all<MemoryRow & { rank: number }>(
      `SELECT m.*, ts_rank(${SEARCH_DOC}, q.query) AS rank
       FROM memories m, to_tsquery('english', ?) AS q(query)
       WHERE ${SEARCH_DOC} @@ q.query
       ORDER BY rank DESC LIMIT ?`,
      match,
      max * 3,
    );
    for (const row of rows) {
      const relevance = Math.min(1, Math.max(0, row.rank));
      const ageDays = (now() - row.updated_at) / 86_400_000;
      const recency = Math.exp(-ageDays / 120);
      row.score =
        relevance * 0.62 +
        (row.importance / 5) * 0.2 +
        (row.pinned ? 0.12 : 0) +
        recency * 0.06;
      results.set(row.id, row);
    }
  }

  const pinnedRows = await all<MemoryRow>('SELECT * FROM memories WHERE pinned = 1 ORDER BY updated_at DESC LIMIT ?', max);
  for (const pinned of pinnedRows) {
    if (!results.has(pinned.id)) results.set(pinned.id, { ...pinned, score: 0.35 + (pinned.importance / 5) * 0.1 });
  }

  const ranked = [...results.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, max);
  if (ranked.length) {
    const stamp = now();
    await Promise.all(
      ranked.map((row) => run('UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?', stamp, row.id)),
    );
  }
  return ranked;
}

/** Compact block injected into the system prompt. Empty string when nothing matches. */
export async function memoryContext(query: string, limit = 8): Promise<string> {
  const rows = await searchMemories(query, limit);
  if (!rows.length) return '';
  const lines = rows.map((row) => {
    const kind = KIND_LABELS[row.kind] ?? row.kind.toUpperCase();
    return `- [${kind}${row.pinned ? ' · pinned' : ''}] ${truncate(row.content, 400)}`;
  });
  return lines.join('\n');
}

export async function memoryStats(): Promise<Record<string, unknown>> {
  const [byKind, total] = await Promise.all([
    all<{ kind: string; n: number }>('SELECT kind, COUNT(*) AS n FROM memories GROUP BY kind'),
    get<{ n: number }>('SELECT COUNT(*) AS n FROM memories'),
  ]);
  return {
    total: Number(total?.n ?? 0),
    byKind: Object.fromEntries(byKind.map((row) => [row.kind, Number(row.n)])),
  };
}
