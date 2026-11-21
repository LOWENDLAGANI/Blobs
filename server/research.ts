import { all, get, run } from './db.ts';
import { complete } from './llm/index.ts';
import { createDeliverable } from './deliverables.ts';
import { webSearch, hasExaKey, type SearchHit } from './search.ts';
import { assertPublicUrl, extractTitle, fetchWithTimeout, htmlToText, id, now, truncate } from './util.ts';

/**
 * Deep research.
 *
 * A chat turn gets 8 model steps and 25 tool calls, which cannot cover dozens
 * of sources. This module runs its own pipeline with its own budget: plan
 * sub-questions, gather and read sources in parallel, extract claims with
 * quotes, then synthesize a report where every factual sentence is tied to a
 * numbered source. The full report is stored as a deliverable and the sources
 * are recorded, so citations can be checked after the links rot.
 */

export type ResearchDepth = 'quick' | 'deep';

export interface ResearchRequest {
  question: string;
  depth?: ResearchDepth;
  maxSources?: number;
  taskId?: string | null;
  conversationId?: string | null;
}

export interface ResearchResult {
  ok: boolean;
  summary: string;
  deliverableId: string | null;
  sourceCount: number;
  claimCount: number;
  error?: string;
}

interface DepthConfig {
  subquestions: number;
  queriesPerQuestion: number;
  sources: number;
  claimsPerSource: number;
  reportTokens: number;
  gapRound: boolean;
}

const DEPTH: Record<ResearchDepth, DepthConfig> = {
  quick: {
    subquestions: 3,
    queriesPerQuestion: 2,
    sources: 8,
    claimsPerSource: 3,
    reportTokens: 1800,
    gapRound: false,
  },
  deep: {
    subquestions: 5,
    queriesPerQuestion: 2,
    sources: 16,
    claimsPerSource: 4,
    reportTokens: 2600,
    gapRound: true,
  },
};

interface PlannedQuestion {
  question: string;
  queries: string[];
}

interface ReadSource {
  index: number;
  title: string;
  url: string;
  domain: string;
  text: string;
  published: string;
}

interface Claim {
  source: number;
  claim: string;
  quote: string;
}

/** Bounded concurrency without pulling in a dependency. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Models sometimes wrap JSON in prose or fences; recover the first valid value. */
function jsonValue<T>(raw: string, fallback: T): T {
  const text = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const candidates: (string | undefined)[] = [
    text,
    /\[[\s\S]*\]/.exec(text)?.[0],
    /\{[\s\S]*\}/.exec(text)?.[0],
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try the next candidate */
    }
  }
  return fallback;
}

function normaliseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

function domainOf(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function planQuestions(question: string, config: DepthConfig): Promise<PlannedQuestion[]> {
  const raw = await complete(
    `You plan web research. Return ONLY compact JSON of the form {"subquestions":[{"question":"...","queries":["..."]}]}.
Rules: exactly ${config.subquestions} sub-questions that together answer the main question and cover different angles (definition, current state, evidence/data, opposing views, practical implications). ${config.queriesPerQuestion} search queries per sub-question, 2-8 words each, phrased the way a search engine expects. No commentary.`,
    `Question: ${question}`,
    { maxTokens: 700, temperature: 0.2, kind: 'research-plan' },
  );

  const parsed = jsonValue<{ subquestions?: { question?: string; queries?: unknown }[] }>(raw, {});
  const planned = (parsed.subquestions ?? [])
    .map((item) => ({
      question: typeof item.question === 'string' ? item.question.trim() : '',
      queries: Array.isArray(item.queries)
        ? item.queries.map((query) => String(query).trim()).filter(Boolean)
        : [],
    }))
    .filter((item) => item.question && item.queries.length)
    .slice(0, config.subquestions);

  if (planned.length) return planned;
  return [{ question, queries: [question] }];
}

async function readSource(hit: SearchHit, index: number): Promise<ReadSource | null> {
  let text = hit.snippet ?? '';
  let title = hit.title;
  try {
    const target = assertPublicUrl(hit.url);
    const response = await fetchWithTimeout(
      target.toString(),
      {
        headers: {
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
      },
      15_000,
    );
    if (response.ok) {
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('pdf')) {
        const body = await response.text();
        if (contentType.includes('application/json')) {
          text = truncate(body, 6000);
        } else {
          const extracted = htmlToText(body).replace(/\s+/g, ' ').trim();
          if (extracted.length > (text ?? '').length) text = extracted;
          if (!title) title = extractTitle(body);
        }
      }
    }
  } catch {
    /* keep the search snippet when the page cannot be read */
  }

  const cleaned = (text ?? '').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 200) return null;
  return {
    index,
    title: (title || domainOf(hit.url) || hit.url).slice(0, 200),
    url: hit.url,
    domain: domainOf(hit.url),
    text: truncate(cleaned, 6000),
    published: hit.published ?? '',
  };
}

async function extractClaims(
  sources: ReadSource[],
  perSource: number,
  question: string,
): Promise<Claim[]> {
  const batches: ReadSource[][] = [];
  for (let i = 0; i < sources.length; i += 3) batches.push(sources.slice(i, i + 3));

  const results = await mapLimit(batches, 2, async (batch) => {
    const block = batch
      .map(
        (source) =>
          `[${source.index}] ${source.title} — ${source.url}\n${truncate(source.text, 2600)}`,
      )
      .join('\n\n');
    try {
      const raw = await complete(
        `You extract verifiable claims from sources. Return ONLY compact JSON: {"sources":[{"index":<n>,"claims":[{"claim":"...","quote":"..."}]}]}.
Rules: up to ${perSource} claims per source. A claim is one factual assertion relevant to the question. The quote MUST be a verbatim substring of that source's text, 10-300 characters. Skip opinions, marketing and anything not supported by the text. If a source has nothing usable, return an empty claims array. No commentary.`,
        `Question: ${question}\n\nSources:\n\n${block}`,
        { maxTokens: 1100, temperature: 0.1, kind: 'research-extract' },
      );
      const parsed = jsonValue<{ sources?: { index?: number; claims?: { claim?: string; quote?: string }[] }[] }>(
        raw,
        {},
      );
      const out: Claim[] = [];
      for (const entry of parsed.sources ?? []) {
        const sourceIndex = Number(entry.index);
        if (!Number.isFinite(sourceIndex)) continue;
        for (const claim of entry.claims ?? []) {
          const text = typeof claim.claim === 'string' ? claim.claim.trim() : '';
          const quote = typeof claim.quote === 'string' ? claim.quote.trim() : '';
          if (!text || !quote) continue;
          out.push({ source: sourceIndex, claim: text.slice(0, 400), quote: quote.slice(0, 400) });
        }
      }
      return out;
    } catch {
      return [] as Claim[];
    }
  });

  return results.flat();
}

async function gather(
  questions: PlannedQuestion[],
  config: DepthConfig,
  startIndex: number,
): Promise<ReadSource[]> {
  const queries = questions
    .flatMap((item) => item.queries)
    .map((query) => query.trim())
    .filter(Boolean)
    .slice(0, config.subquestions * config.queriesPerQuestion + 2);

  const searched = await mapLimit(queries, 4, async (query) => {
    try {
      const result = await webSearch(query, 6);
      return result.hits;
    } catch {
      return [] as SearchHit[];
    }
  });

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const hit of searched.flat()) {
    const url = normaliseUrl(hit.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    hits.push({ ...hit, url });
  }

  const selected = hits.slice(0, config.sources);
  let index = startIndex;
  const read = await mapLimit(selected, 4, async (hit) => {
    const source = await readSource(hit, index);
    index += 1;
    return source;
  });
  return read.filter((source): source is ReadSource => source !== null);
}

async function gapQueries(question: string, claims: Claim[], sources: ReadSource[]): Promise<string[]> {
  try {
    const raw = await complete(
      `You audit research coverage. Return ONLY compact JSON: {"queries":["...","..."]}.
Given the question, the claims already found, and the source titles, propose up to 2 short search queries that would fill the most important missing evidence. If coverage is already good, return {"queries":[]}.`,
      `Question: ${question}\n\nClaims:\n${claims
        .slice(0, 24)
        .map((claim) => `- ${claim.claim}`)
        .join('\n')}\n\nSources:\n${sources
        .slice(0, 16)
        .map((source) => `- ${source.title} (${source.domain})`)
        .join('\n')}`,
      { maxTokens: 220, temperature: 0.3, kind: 'research-gap' },
    );
    const parsed = jsonValue<{ queries?: unknown }>(raw, {});
    return Array.isArray(parsed.queries)
      ? parsed.queries.map((query) => String(query).trim()).filter(Boolean).slice(0, 2)
      : [];
  } catch {
    return [];
  }
}

function sourceTable(sources: ReadSource[]): string {
  return sources
    .map((source) => `[${source.index}] ${source.title} — ${source.url}`)
    .join('\n');
}

/**
 * Run the pipeline. Returns a short summary for the conversation; the cited
 * report is stored as a review packet.
 */
export async function runResearch(request: ResearchRequest): Promise<ResearchResult> {
  const question = request.question.trim();
  if (!question) {
    return { ok: false, summary: 'Give me a research question.', deliverableId: null, sourceCount: 0, claimCount: 0 };
  }

  const depth: ResearchDepth = request.depth === 'deep' ? 'deep' : 'quick';
  const config = { ...DEPTH[depth] };
  if (request.maxSources && Number.isFinite(request.maxSources)) {
    config.sources = Math.min(24, Math.max(4, Math.round(request.maxSources)));
  }

  const runId = id('rsh');
  const started = now();
  await run(
    `INSERT INTO research_runs(id, question, depth, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    runId,
    truncate(question, 1000),
    depth,
    'running',
    started,
  );

  try {
    const planned = await planQuestions(question, config);
    const first = await gather(planned, config, 1);
    let sources = first;
    let claims = (await extractClaims(sources, config.claimsPerSource, question)).filter((claim) =>
      sources.some((source) => source.index === claim.source),
    );

    if (config.gapRound && sources.length) {
      const extraQueries = await gapQueries(question, claims, sources);
      if (extraQueries.length) {
        const extraConfig = { ...config, subquestions: 1, sources: 4 };
        const more = await gather(
          [{ question, queries: extraQueries }],
          extraConfig,
          sources.length + 1,
        );
        const known = new Set(sources.map((source) => normaliseUrl(source.url)));
        const fresh = more.filter((source) => !known.has(normaliseUrl(source.url)));
        if (fresh.length) {
          sources = [...sources, ...fresh];
          claims = [
            ...claims,
            ...(await extractClaims(fresh, config.claimsPerSource, question)).filter((claim) =>
              sources.some((source) => source.index === claim.source),
            ),
          ];
        }
      }
    }

    if (!sources.length) {
      await run(
        `UPDATE research_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?`,
        'failed',
        now(),
        'No sources could be retrieved.',
        runId,
      );
      return {
        ok: false,
        summary:
          'No sources could be retrieved. The search engines may be rate limiting, or the question may need different wording. Try again in a minute or add an Exa key for reliable search.',
        deliverableId: null,
        sourceCount: 0,
        claimCount: 0,
      };
    }

    for (const source of sources) {
      await run(
        `INSERT INTO research_sources(id, run_id, idx, url, title, domain, published, excerpt, retrieved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id('src'),
        runId,
        source.index,
        source.url,
        source.title,
        source.domain,
        source.published,
        truncate(source.text, 3000),
        now(),
      );
    }
    for (const claim of claims) {
      await run(
        `INSERT INTO research_claims(id, run_id, source_idx, claim, quote, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id('clm'),
        runId,
        claim.source,
        truncate(claim.claim, 600),
        truncate(claim.quote, 600),
        now(),
      );
    }
    await run(
      `UPDATE research_runs SET plan = ?, source_count = ? WHERE id = ?`,
      JSON.stringify(planned),
      sources.length,
      runId,
    );

    const claimBlock = claims.length
      ? claims
          .slice(0, 60)
          .map((claim) => `- [${claim.source}] ${claim.claim}\n  quote: "${claim.quote}"`)
          .join('\n')
      : '(no claims could be extracted; rely on the sources directly)';

    const report = await complete(
      `You are writing a research report for the owner. Use ONLY the numbered sources provided.
Rules:
- Cite every factual sentence with [n], where n is the source number. Several cites like [2][5] are fine.
- If the sources do not support a point, say so explicitly instead of inventing it.
- Structure in markdown: a direct answer first, then "Key findings", "Evidence and detail", "Contradictions and uncertainty", "Open questions".
- Be concrete: names, numbers, dates and mechanisms. No filler, no generic advice.
- Do not add a sources section; it is appended automatically.`,
      `Question: ${question}\n\nClaims extracted from sources:\n${claimBlock}\n\nSources:\n${sources
        .map(
          (source) =>
            `[${source.index}] ${source.title} — ${source.url}\n${truncate(source.text, 1800)}`,
        )
        .join('\n\n')}`,
      { maxTokens: config.reportTokens, temperature: 0.3, kind: 'research-report' },
    );

    const citationCount = (report.match(/\[\d+\]/g) ?? []).length;
    const usedIndices = new Set(
      (report.match(/\[(\d+)\]/g) ?? []).map((token) => Number(token.slice(1, -1))),
    );
    const valid = [...usedIndices].filter((index) => sources.some((source) => source.index === index));
    const invalidCitations = usedIndices.size - valid.length;
    const exa = await hasExaKey();

    const header = [
      '> Research packet',
      `> Question: ${question}`,
      `> ${sources.length} sources read, ${claims.length} claims extracted, ${citationCount} citations.`,
      exa ? '' : '> Search provider: DuckDuckGo/Wikipedia fallback. Add EXA_API_KEY for stronger coverage.',
      citationCount === 0
        ? '> ⚠️ No inline citations were produced. Treat this report as unverified and check the sources below.'
        : '',
      invalidCitations > 0
        ? `> ⚠️ ${invalidCitations} citation${invalidCitations === 1 ? '' : 's'} did not match a source; check those sentences against the list below.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const body = `${header}\n\n${report.trim()}\n\n---\n\n## Sources\n\n${sourceTable(sources)}\n`;

    const deliverable = await createDeliverable({
      title: `Research: ${truncate(question.replace(/\s+/g, ' '), 90)}`,
      body,
      taskId: request.taskId ?? null,
      conversationId: request.conversationId ?? null,
    });

    await run(
      `UPDATE research_runs SET status = ?, deliverable_id = ?, source_count = ?, claim_count = ?, finished_at = ? WHERE id = ?`,
      'done',
      deliverable.id,
      sources.length,
      claims.length,
      now(),
      runId,
    );

    const headline = report.trim().slice(0, 1200);
    return {
      ok: true,
      summary: [
        `Research complete: ${sources.length} sources, ${claims.length} claims, ${valid.length} cited sources.`,
        headline,
        `Full cited report saved as ${deliverable.id} (open Review).`,
      ].join('\n\n'),
      deliverableId: deliverable.id,
      sourceCount: sources.length,
      claimCount: claims.length,
    };
  } catch (error) {
    const message = (error as Error).message;
    await run(
      `UPDATE research_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?`,
      'failed',
      now(),
      truncate(message, 800),
      runId,
    );
    return {
      ok: false,
      summary: `Research failed: ${message}`,
      deliverableId: null,
      sourceCount: 0,
      claimCount: 0,
      error: message,
    };
  }
}

export async function researchRuns(limit = 20): Promise<unknown[]> {
  return all(
    'SELECT id, question, depth, status, source_count, claim_count, deliverable_id, created_at, finished_at, error FROM research_runs ORDER BY created_at DESC LIMIT ?',
    Math.min(limit, 100),
  );
}

export async function researchRunDetail(runId: string): Promise<unknown> {
  const runRow = await get('SELECT * FROM research_runs WHERE id = ?', runId);
  if (!runRow) return null;
  return {
    run: runRow,
    sources: await all('SELECT * FROM research_sources WHERE run_id = ? ORDER BY idx', runId),
    claims: await all('SELECT * FROM research_claims WHERE run_id = ? ORDER BY source_idx', runId),
  };
}
