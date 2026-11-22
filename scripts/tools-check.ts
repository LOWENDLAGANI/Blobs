/**
 * Verifies the tools that do not need any external credentials: real web
 * search, page reading, the workspace filesystem and the JS sandbox.
 * Run with: node scripts/tools-check.ts
 */
import { getTool } from '../server/agent/tools.ts';

const context = { channel: 'web' as const, conversationId: null, taskId: null, autonomyLevel: 'assisted' as const };
let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const search = getTool('web_search');
  const fetchPage = getTool('fetch_page');
  const writeNote = getTool('write_note');
  const readFile = getTool('read_file');
  const listFiles = getTool('list_files');
  const runJs = getTool('run_js');
  const remember = getTool('remember');

  if (!search || !fetchPage || !writeNote || !readFile || !listFiles || !runJs || !remember) {
    console.error('A required tool is missing from the registry.');
    process.exit(1);
  }

  console.log('Web research (live network)');
  const results = await search.run({ query: 'TypeScript release notes' }, context);
  check('web_search returns results', results.ok && results.content.length > 120, results.content.slice(0, 160));
  check('web_search output is marked untrusted', results.untrusted === true);

  const page = await fetchPage.run({ url: 'https://example.com', max_chars: 2000 }, context);
  check('fetch_page reads a page', page.ok && /Example Domain/i.test(page.content), page.content.slice(0, 120));
  check('fetch_page output is marked untrusted', page.untrusted === true);

  let blocked = false;
  try {
    const local = await fetchPage.run({ url: 'http://127.0.0.1:3000/' }, context);
    blocked = !local.ok;
  } catch {
    blocked = true;
  }
  check('fetch_page refuses private addresses (SSRF guard)', blocked);

  let blockedIpv6 = false;
  try {
    const local = await fetchPage.run({ url: 'http://[::1]:3000/' }, context);
    blockedIpv6 = !local.ok;
  } catch {
    blockedIpv6 = true;
  }
  check('fetch_page refuses bracketed IPv6 loopback (SSRF guard)', blockedIpv6);

  let blockedRebinding = false;
  try {
    // A public-looking name that resolves to 127.0.0.1; it is refused whether or
    // not the lookup succeeds, because an unresolvable host is blocked too.
    const local = await fetchPage.run({ url: 'http://localtest.me:3000/' }, context);
    blockedRebinding = !local.ok;
  } catch {
    blockedRebinding = true;
  }
  check('fetch_page refuses a name that resolves to loopback (SSRF guard)', blockedRebinding);

  console.log('\nWorkspace files');
  const note = await writeNote.run(
    { path: 'notes/smoke.md', content: '# Smoke note\n\nWritten by the tools check.' },
    context,
  );
  check('write_note writes a file', note.ok, note.content);
  const read = await readFile.run({ path: 'notes/smoke.md' }, context);
  check('read_file reads it back', read.ok && read.content.includes('Smoke note'));
  const list = await listFiles.run({}, context);
  check('list_files shows it', list.ok && list.content.includes('notes/smoke.md'), list.content.slice(0, 120));
  let traversed = false;
  try {
    const escape = await readFile.run({ path: '../../etc/passwd' }, context);
    traversed = escape.ok;
  } catch {
    traversed = false;
  }
  check('path traversal is blocked', !traversed);

  console.log('\nSandbox');
  const math = await runJs.run({ code: 'const xs = [1,2,3,4]; console.log(xs.reduce((a,b)=>a+b,0));' }, context);
  check('run_js computes', math.ok && math.content.trim() === '10', math.content);
  const noNetwork = await runJs.run({ code: '(() => typeof fetch)()' }, context);
  check('run_js has no network access', /undefined/.test(noNetwork.content), noNetwork.content);

  console.log('\nMemory tool');
  const stored = await remember.run({ content: 'Tools check ran successfully on this machine.', tags: ['smoke'] }, context);
  check('remember stores a memory', stored.ok, stored.content);

  console.log('\nCloud computer gating');
  const shell = getTool('run_shell');
  const desktop = getTool('desktop_action');
  const status = getTool('computer_status');
  check('computer tools are registered', Boolean(shell && desktop && status));
  let message = '';
  try {
    await shell!.run({ command: 'echo hello' }, context);
  } catch (error) {
    message = (error as Error).message;
  }
  check(
    'computer tools refuse clearly without an E2B key',
    /E2B|computer/i.test(message),
    message || 'no error raised',
  );
  const reported = await status!.run({}, context);
  check('computer_status reports the missing key honestly', reported.ok === false && /E2B|Not connected/i.test(reported.content));

  console.log(failures === 0 ? '\nall tool checks passed' : `\n${failures} tool checks failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('tools check crashed:', error);
  process.exit(1);
});
