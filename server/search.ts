import { getSecret } from './settings.ts';
import { fetchWithTimeout, htmlToText } from './util.ts';

/**
 * Web search, in one place.
 *
 * The free path scrapes DuckDuckGo's HTML endpoint and falls back to Wikipedia.
 * If an Exa key is configured (EXA_API_KEY, or the `exa:apiKey` secret), Exa is
 * used instead: it returns ranked results with citation-ready text, which is
 * what the research pipeline needs.
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  engine: string;
  published?: string;
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decodeDdg(href: string): string {
  if (href.startsWith('//duckduckgo.com/l/')) {
    const match = /uddg=([^&]+)/.exec(href);
    if (match) return decodeURIComponent(match[1]);
  }
  if (href.startsWith('/l/')) {
    const match = /uddg=([^&]+)/.exec(href);
    if (match) return decodeURIComponent(match[1]);
  }
  return href.startsWith('//') ? `https:${href}` : href;
}

async function duckDuckGo(query: string, limit: number): Promise<SearchHit[]> {
  const response = await fetchWithTimeout(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { headers: { 'user-agent': USER_AGENT, accept: 'text/html' } },
    15_000,
  );
  if (!response.ok) throw new Error(`DuckDuckGo responded ${response.status}`);
  const html = await response.text();
  const hits: SearchHit[] = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/g;
  const snippets: string[] = [];
  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetRe.exec(html)) !== null) {
    snippets.push(htmlToText(snippetMatch[1]).slice(0, 320));
  }
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null) {
    const url = decodeDdg(match[1]);
    if (!/^https?:\/\//.test(url) || url.includes('duckduckgo.com/y.js')) continue;
    hits.push({
      title: htmlToText(match[2]).slice(0, 180),
      url,
      snippet: snippets[hits.length] ?? '',
      engine: 'DuckDuckGo',
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

async function wikipedia(query: string, limit: number): Promise<SearchHit[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
    query,
  )}&format=json&srlimit=${Math.min(limit, 8)}&origin=*`;
  const response = await fetchWithTimeout(url, { headers: { 'user-agent': USER_AGENT } }, 12_000);
  if (!response.ok) throw new Error(`Wikipedia responded ${response.status}`);
  const data = (await response.json()) as {
    query?: { search?: { title: string; snippet: string }[] };
  };
  return (data.query?.search ?? []).map((hit) => ({
    title: hit.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
    snippet: htmlToText(hit.snippet).slice(0, 320),
    engine: 'Wikipedia',
  }));
}

let cachedKey: { value: string; at: number } | null = null;

async function exaKey(): Promise<string> {
  const fromEnv = process.env.EXA_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (cachedKey && Date.now() - cachedKey.at < 60_000) return cachedKey.value;
  const stored = (await getSecret('exa:apiKey').catch(() => null)) ?? '';
  cachedKey = { value: stored, at: Date.now() };
  return stored;
}

async function exa(query: string, limit: number): Promise<SearchHit[]> {
  const key = await exaKey();
  if (!key) return [];
  const response = await fetchWithTimeout(
    'https://api.exa.ai/search',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        query,
        numResults: Math.min(Math.max(limit, 1), 20),
        type: 'auto',
        contents: { text: { maxCharacters: 2000 }, highlights: { numSentences: 3 } },
      }),
    },
    25_000,
  );
  if (!response.ok) throw new Error(`Exa responded ${response.status}`);
  const data = (await response.json()) as {
    results?: { title?: string; url: string; text?: string; highlights?: string[]; publishedDate?: string }[];
  };
  return (data.results ?? []).map((hit) => ({
    title: hit.title ?? '',
    url: hit.url,
    snippet: (hit.highlights?.join(' ') || hit.text || '').replace(/\s+/g, ' ').slice(0, 900),
    engine: 'Exa',
    published: hit.publishedDate,
  }));
}

/**
 * Search with the best available engine. Exa is tried first when configured,
 * then DuckDuckGo, then Wikipedia. A rate limit on one engine must not fail the
 * whole call, so every attempt is isolated.
 */
export async function webSearch(
  query: string,
  limit = 8,
): Promise<{ hits: SearchHit[]; engine: string }> {
  const trimmed = query.trim();
  if (!trimmed) return { hits: [], engine: 'none' };

  try {
    const hits = await exa(trimmed, limit);
    if (hits.length) return { hits, engine: 'Exa' };
  } catch {
    /* fall through to the free engines */
  }
  try {
    const hits = await duckDuckGo(trimmed, limit);
    if (hits.length) return { hits, engine: 'DuckDuckGo' };
  } catch {
    /* fall through */
  }
  try {
    const hits = await wikipedia(trimmed, limit);
    if (hits.length) return { hits, engine: 'Wikipedia' };
  } catch {
    /* nothing left to try */
  }
  return { hits: [], engine: 'none' };
}

/** Whether a paid search provider is configured. */
export async function hasExaKey(): Promise<boolean> {
  return (await exaKey()) !== '';
}
