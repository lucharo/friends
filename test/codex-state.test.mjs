import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'friends-codex-state-'));
const claudeId = '22222222-0000-4000-8000-000000000001';
const codexId = '22222222-0000-4000-8000-000000000002';
const piId = '22222222-0000-4000-8000-000000000003';
const cli = new URL('../bin/friends.mjs', import.meta.url).pathname;
const received = [];
let server;
let recipientProcess;
let env;

beforeAll(async () => {
  for (const dir of ['bin', 'claude/sessions', 'broken-claude', 'pi/sessions', 'valid/thread-writer-locks', 'unavailable/thread-writer-locks']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  // Only external process discovery is stubbed. SQLite and both CLI paths remain real.
  writeFileSync(join(root, 'bin/ps'), `#!/bin/sh\nprintf '%s 1 00:01 ?? %s\\n' '${process.pid}' "\${TEST_ANCESTOR:-bun}"\n`, { mode: 0o755 });
  writeFileSync(join(root, 'bin/lsof'), `#!/bin/sh\nif [ "$1" = '-Fn' ]; then printf 'n%s/thread-writer-locks/${codexId}.lock\\n' "$CODEX_HOME"; fi\n`, { mode: 0o755 });
  for (const dir of ['valid', 'unavailable']) writeFileSync(join(root, dir, 'thread-writer-locks', `${codexId}.lock`), '');
  const db = new Database(join(root, 'valid/state_5.sqlite'));
  db.run('create table threads (id text, name text, title text, cwd text, source text, approval_mode text, archived integer)');
  db.run('insert into threads values (?, ?, ?, ?, ?, ?, 0)', [codexId, 'Sender', 'Fixture', root, 'cli', 'never']);
  db.close();
  // Opening a directory as a database produces a real SQLITE_CANTOPEN, without touching live state.
  mkdirSync(join(root, 'unavailable/state_5.sqlite'));
  writeFileSync(join(root, 'broken-claude/sessions'), 'not a registry directory');
  const socket = join(root, 'inbox.sock');
  server = createServer((connection) => {
    let body = '';
    connection.on('data', (chunk) => { body += chunk; });
    connection.on('end', () => received.push(JSON.parse(body)));
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  recipientProcess = Bun.spawn(['/bin/cat'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  writeFileSync(join(root, 'claude/sessions', `${recipientProcess.pid}.json`), JSON.stringify({
    pid: recipientProcess.pid, sessionId: claudeId, name: 'Recipient', cwd: root, messagingSocketPath: socket,
  }));
  writeFileSync(join(root, 'pi/sessions', `${piId}.json`), JSON.stringify({
    id: piId, name: 'Pi fixture', cwd: root, pid: recipientProcess.pid, lastSeen: Date.now(), idle: true,
  }));
  env = {
    HOME: root, PATH: `${join(root, 'bin')}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: join(root, 'claude'),
    PI_XSM_DIR: join(root, 'pi'), FRIENDS_REMOTE_HOST: '', CODEX_THREAD_ID: codexId,
  };
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  recipientProcess?.stdin.end();
  await recipientProcess?.exited;
  rmSync(root, { recursive: true, force: true });
});

async function run(args, { database = 'unavailable', ancestor = 'bun', claude = 'claude' } = {}) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: { ...env, CODEX_HOME: join(root, database), TEST_ANCESTOR: ancestor, CLAUDE_CONFIG_DIR: join(root, claude) },
    cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  child.stdin.write('Fixture message');
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

const healthyRows = () => [
  { harness: 'claude', name: 'Recipient', id: claudeId, cwd: root, host: 'local', canReceive: true, pid: recipientProcess.pid, entrypoint: null, status: null },
  { harness: 'pi', name: 'Pi fixture', id: piId, cwd: root, host: 'local', canReceive: true, status: 'idle', pid: recipientProcess.pid },
];
const codexRow = () => ({ harness: 'codex', name: 'Sender', id: codexId, cwd: root, host: 'local', canReceive: true, open: true, source: 'cli', approvalMode: 'never' });

describe('unreadable Codex state', () => {
  test('a readable database preserves the complete inventory array and sender declaration', async () => {
    const listed = await run(['ls', '--json'], { database: 'valid' });
    expect(listed).toMatchObject({ code: 0, stderr: '' });
    const [claude, pi] = healthyRows();
    expect(JSON.parse(listed.stdout)).toEqual([claude, codexRow(), pi]);
    const sender = await run(['whoami', '--json'], { database: 'valid', ancestor: 'codex' });
    expect(sender).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(sender.stdout)).toEqual({ harness: 'codex', id: codexId, name: 'Sender', cwd: root, mode: 'bypass', canReceive: true });
  });

  test('CANTOPEN yields usable partial inventory, actionable diagnostics and a failing exit', async () => {
    const result = await run(['ls', '--json']);
    const out = JSON.parse(result.stdout);
    expect(out).toEqual({ sessions: healthyRows(), errors: [expect.stringContaining('SQLITE_CANTOPEN')] });
    expect(result).toMatchObject({ code: 1, stderr: `Inventory incomplete: ${out.errors[0]}\n` });
    expect(out.errors[0]).toContain(join(root, 'unavailable/state_5.sqlite'));
    expect(out.errors[0]).toContain('Check CODEX_HOME and access to the database directory, including WAL/SHM files');
  });

  test('text inventory still shows healthy harnesses and cannot silently succeed', async () => {
    const result = await run(['ls']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Recipient');
    expect(result.stdout).toContain('Pi fixture');
    expect(result.stderr).toStartWith('Inventory incomplete: codex: Cannot read Codex state');
  });

  test('direct Codex resolution still fails rather than reporting a missing target', async () => {
    const result = await run(['resolve', `codex:${codexId}`]);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toContain('SQLITE_CANTOPEN');
    expect(result.stderr).not.toContain('No live session');
  });

  test('a registry error during optional sender detection cannot hide healthy text inventory', async () => {
    const result = await run(['ls'], { database: 'valid', claude: 'broken-claude' });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Sender');
    expect(result.stdout).toContain('Pi fixture');
    expect(result.stderr).toContain('Inventory incomplete: claude: ENOTDIR');
    expect(result.stderr).toContain('Inventory incomplete: sender: ENOTDIR');
  });

  test('a proven Codex sender can reach Claude with unknown mode and no invented reply route', async () => {
    const result = await run(['send', `claude:${claudeId}`], { ancestor: 'codex' });
    const out = JSON.parse(result.stdout);
    expect(out).toEqual({
      status: 'written', harness: 'claude', id: claudeId, name: 'Recipient', host: 'local', delivery: 'unconfirmed',
      permissionCheck: { status: 'unknown', senderMode: 'unknown', warning: expect.any(String) },
      messageId: expect.any(String), replyRoute: false,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('SQLITE_CANTOPEN');
    expect(result.stderr).toContain('Sender permission mode and reply capability are unknown');
    expect(received).toHaveLength(1);
    const body = received[0].message.content;
    expect(body).toContain(`Codex peer message from (unnamed) (codex:${codexId}`);
    expect(body).toContain('could not verify whether the sending session');
    expect(body).not.toContain('from-mode=');
    expect(body).not.toContain('REPLY_FILE');
  });

  test('an inherited thread ID alone does not establish a Codex sender', async () => {
    expect(await run(['whoami', '--json'])).toEqual({ code: 0, stdout: 'null\n', stderr: '' });
  });
});
