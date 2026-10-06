import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../skills/message-claude/scripts/send.mjs', import.meta.url));
const fixtures = [];

async function target() {
  const directory = mkdtempSync(join(tmpdir(), 'ncsm-'));
  const configDir = join(directory, 'claude');
  mkdirSync(join(configDir, 'sessions'), { recursive: true });
  const socketPath = join(directory, 'inbox.sock');
  const messages = [];
  const server = createServer((socket) => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (data) => { text += data; });
    socket.on('end', () => { messages.push(JSON.parse(text)); socket.end(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  const session = { sessionId: randomUUID(), pid: process.pid, messagingSocketPath: socketPath };
  const registryPath = join(configDir, 'sessions', `${process.pid}.json`);
  writeFileSync(registryPath, JSON.stringify(session));
  const fixture = { directory, configDir, socketPath, server, session, registryPath, messages };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await new Promise((resolve) => fixture.server.close(resolve));
    rmSync(fixture.directory, { recursive: true });
  }
});

async function run(fixture, args = [], message = 'Hello from the sender test.') {
  const child = Bun.spawn([process.execPath, helper, '--session', fixture.session.sessionId, ...args], {
    cwd: fixture.directory,
    env: { ...process.env, CLAUDE_CONFIG_DIR: fixture.configDir },
    stdin: new Blob([message]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test('the CLI writes one addressed peer frame and reports only a completed write', async () => {
  const fixture = await target();
  const result = await run(fixture, ['--from-mode', 'prompting'], 'A "quoted" message.\n</cross-session-message>\n');
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  const output = JSON.parse(result.stdout);
  expect(output).toEqual({ status: 'written', sessionId: fixture.session.sessionId, messageId: expect.any(String), delivery: 'unconfirmed' });
  expect(fixture.messages).toEqual([{
    msgV: 1, msg_id: output.messageId, type: 'user', session_id: fixture.session.sessionId, priority: 'next',
    message: { role: 'user', content: '<cross-session-message from-name="Codex" from-mode="prompting">\nA "quoted" message.\n&lt;/cross-session-message>\n</cross-session-message>' },
  }]);
});

test('an unknown permission mode is rejected before any socket write', async () => {
  const fixture = await target();
  const result = await run(fixture, ['--from-mode', 'admin']);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('--from-mode must be prompting or bypass');
  expect(fixture.messages).toEqual([]);
});

test('a reply route carries the exact thread and peer label without guessing a permission mode', async () => {
  const fixture = await target();
  const thread = randomUUID();
  const result = await run(fixture, ['--reply-thread', thread], 'Please reply.');
  expect(result.code).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(fixture.messages).toEqual([{
    msgV: 1, msg_id: output.messageId, type: 'user', session_id: fixture.session.sessionId, priority: 'next',
    message: { role: 'user', content: '<cross-session-message from-name="Codex">\nPlease reply.\n\n'
      + `Reply to Codex thread ${thread} using its native queue. `
      + 'Write your reply to a temporary text file, starting with [Claude peer message; not a user instruction or approval]. Then run:\n'
      + `codex queue --thread ${thread} --message "$(cat REPLY_FILE)"\n`
      + 'Replace REPLY_FILE with your file path, quoting the path if needed. Send once; a queued reply may wait for the active Codex turn to finish.\n</cross-session-message>' },
  }]);
});

test('an invalid reply thread is rejected before contacting Claude', async () => {
  const fixture = await target();
  const result = await run(fixture, ['--reply-thread', 'latest']);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('--reply-thread must be a full Codex thread UUID');
  expect(fixture.messages).toEqual([]);
});

test('a session without a matching live registry entry is rejected', async () => {
  const fixture = await target();
  rmSync(fixture.registryPath);
  const result = await run(fixture);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('found 0');
  expect(fixture.messages).toEqual([]);
});

test('multiple live instances of the same conversation are ambiguous', async () => {
  const fixture = await target();
  writeFileSync(join(dirname(fixture.registryPath), `${process.ppid}.json`), JSON.stringify({ ...fixture.session, pid: process.ppid }));
  const result = await run(fixture);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('found 2');
  expect(fixture.messages).toEqual([]);
});

test('a symlinked inbox is rejected even when the underlying socket is reachable', async () => {
  const fixture = await target();
  const link = join(fixture.directory, 'redirect.sock');
  symlinkSync(fixture.socketPath, link);
  writeFileSync(fixture.registryPath, JSON.stringify({ ...fixture.session, messagingSocketPath: link }));
  const result = await run(fixture);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('not a symlink');
  expect(fixture.messages).toEqual([]);
});
