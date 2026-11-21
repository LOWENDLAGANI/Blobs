/**
 * Browser daemon.
 *
 * Lives inside the BLOBS cloud computer and keeps one Chromium page open
 * between tool calls, so "open, click, type" is one session rather than three
 * cold starts. The server talks to it over HTTP on a token-guarded port.
 *
 * Snapshot model: every interactive element is stamped with data-blobs-idx and
 * reported with that number, so the agent clicks by number instead of guessing
 * selectors.
 */
import http from 'node:http';
import { chromium } from 'playwright';

const PORT = Number(process.env.BLOBS_BROWSER_PORT || 8099);
const TOKEN = process.env.BLOBS_BROWSER_TOKEN || '';
const MAX_ELEMENTS = 120;
const MAX_TEXT = 6000;

let browser = null;
let context = null;
let page = null;

async function ensurePage() {
  if (browser && browser.isConnected() && page) return page;
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  return page;
}

/** Stamp and describe the interactive elements currently on screen. */
function snapshotInPage(limit) {
  const selector =
    'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[contenteditable="true"],summary';
  const visible = [...document.querySelectorAll(selector)].filter((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none';
  });
  return visible.slice(0, limit).map((el, index) => {
    el.setAttribute('data-blobs-idx', String(index));
    const label = (
      el.innerText ||
      el.value ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      el.getAttribute('title') ||
      ''
    )
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    return {
      index,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      label,
      href: el.getAttribute('href') || undefined,
    };
  });
}

async function describe(target) {
  const elements = await target.evaluate(snapshotInPage, MAX_ELEMENTS);
  const text = await target
    .evaluate((limit) => (document.body ? document.body.innerText.slice(0, limit) : ''), MAX_TEXT)
    .catch(() => '');
  return {
    url: target.url(),
    title: await target.title().catch(() => ''),
    elements,
    text: String(text || '').trim(),
  };
}

async function settle(target) {
  await target.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
  await target.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
}

function targetSelector(body) {
  if (body.index !== undefined && body.index !== null) return `[data-blobs-idx="${Number(body.index)}"]`;
  if (body.selector) return String(body.selector);
  throw new Error('Give an element number from the last snapshot, or a CSS selector.');
}

async function act(body) {
  const action = String(body.action || '');
  const target = await ensurePage();

  switch (action) {
    case 'open': {
      if (!body.url) throw new Error('A url is required to open a page.');
      const url = String(body.url);
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https URLs can be opened.');
      await target.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await settle(target);
      return describe(target);
    }
    case 'snapshot':
      return describe(target);
    case 'click': {
      await target.click(targetSelector(body), { timeout: 15_000 });
      await settle(target);
      return describe(target);
    }
    case 'type': {
      const selector = targetSelector(body);
      if (typeof body.text !== 'string') throw new Error('text is required to type.');
      await target.fill(selector, body.text, { timeout: 15_000 }).catch(async () => {
        await target.click(selector);
        await target.keyboard.type(body.text);
      });
      if (body.submit) await target.press(selector, 'Enter');
      await settle(target);
      return describe(target);
    }
    case 'press': {
      if (!body.key) throw new Error('A key is required, e.g. "Enter" or "Control+L".');
      await target.keyboard.press(String(body.key));
      await settle(target);
      return describe(target);
    }
    case 'back': {
      await target.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      await settle(target);
      return describe(target);
    }
    case 'extract': {
      const kind = String(body.kind || 'text');
      const limit = Math.min(20_000, Math.max(200, Number(body.limit) || MAX_TEXT));
      if (kind === 'html') {
        return { url: target.url(), title: await target.title(), html: (await target.content()).slice(0, limit) };
      }
      if (kind === 'links') {
        const links = await target.evaluate((max) =>
          [...document.querySelectorAll('a[href]')]
            .slice(0, max)
            .map((a) => ({ text: (a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80), href: a.href })),
        limit);
        return { url: target.url(), title: await target.title(), links };
      }
      const text = await target.evaluate((max) => (document.body ? document.body.innerText : '').slice(0, max), limit);
      return { url: target.url(), title: await target.title(), text: String(text || '').trim() };
    }
    case 'screenshot': {
      const buffer = await target.screenshot({ type: 'png', fullPage: Boolean(body.full_page) });
      return {
        url: target.url(),
        title: await target.title(),
        screenshot: buffer.toString('base64'),
        bytes: buffer.byteLength,
      };
    }
    case 'close': {
      await browser.close().catch(() => undefined);
      browser = null;
      context = null;
      page = null;
      return { closed: true };
    }
    default:
      throw new Error(`Unknown browser action "${action}".`);
  }
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, page: page ? page.url() : null }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/action') {
    response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    return;
  }

  let raw = '';
  request.on('data', (chunk) => (raw += chunk));
  request.on('end', async () => {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid json"}');
      return;
    }
    if (TOKEN && body.token !== TOKEN) {
      response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"bad token"}');
      return;
    }
    try {
      const result = await act(body);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: String(error?.message ?? error).slice(0, 500) }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`browser daemon listening on ${PORT}`);
});

const shutdown = async () => {
  await browser?.close().catch(() => undefined);
  server.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
