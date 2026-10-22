import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise the real CLI against disposable session registries and sockets, never the user's home.
const root = mkdtempSync(join(tmpdir(), 'friends-permissions-'));
const id = '11111111-0000-4000-8000-000000000001';
const piId = '11111111-0000-4000-8000-000000000002';
const cli = new URL('../bin/friends.mjs', import.meta.url).pathname;
const received = [];
let server;
let recipientProcess;
let connections = 0;
let env;

beforeAll(async () => {
  for (const dir of ['bin', 'claude/sessions', 'pi/sessions', 'codex']) mkdirSync(join(root, dir), { recursive: true });
  for (const name of ['ps', 'lsof']) writeFileSync(join(root, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const socket = join(root, 'inbox.sock');
  server = createServer((connection) => {
    connections++;
    let body = '';
    connection.on('data', (chunk) => { body += chunk; });
    connection.on('end', () => received.push(JSON.parse(body)));
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  // A non-ancestor pid prevents sender detection from mistaking this test runner for the recipient.
  recipientProcess = Bun.spawn(['/bin/cat'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  writeFileSync(join(root, 'claude/sessions', `${recipientProcess.pid}.json`), JSON.stringify({
    pid: recipientProcess.pid, sessionId: id, name: 'Recipient', cwd: root, messagingSocketPath: socket, entrypoint: 'claude-desktop',
    // Neither transcript `normal` nor startup options describe the live permission mode.
    mode: 'normal', permissionMode: 'bypassPermissions', crossSessionInbound: 'accept',
  }));
  writeFileSync(join(root, 'pi/sessions', `${piId}.json`), JSON.stringify({
    id: piId, name: 'Sender', cwd: root, pid: recipientProcess.pid, lastSeen: Date.now(), idle: true,
  }));
  env = {
    HOME: root, PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
    CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), PI_XSM_DIR: join(root, 'pi'), FRIENDS_REMOTE_HOST: '',
  };
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  recipientProcess?.stdin.end();
  await recipientProcess?.exited;
  rmSync(root, { recursive: true, force: true });
});

async function run(args, message = 'Fixture message') {
  const child = Bun.spawn([process.execPath, cli, 'send', `claude:${id}`, ...args], {
    env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  // --check must exit even while stdin remains open, without a message to read.
  if (!args.includes('--check')) { child.stdin.write(message); child.stdin.end(); }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

describe('Claude permission warning', () => {
  test('a real send warns for the detected bypass sender and preserves its declaration', async () => {
    const before = received.length;
    const result = await run(['--reply-to', `pi:${piId}`]);
    expect(result).toMatchObject({ code: 0 });
    const out = JSON.parse(result.stdout);
    expect(out).toEqual({
      status: 'written', harness: 'claude', id, name: 'Recipient', host: 'local', delivery: 'unconfirmed',
      permissionCheck: { status: 'unknown', senderMode: 'bypass', warning: expect.any(String) },
      messageId: expect.any(String), replyRoute: true,
    });
    expect(result.stderr).toBe(`Warning: ${out.permissionCheck.warning}\n`);
    expect(out.permissionCheck.warning).toContain('Auto or other prompting recipient holds it');
    expect(out.permissionCheck.warning).toContain('Desktop cannot show the approval dialog');
    expect(out.permissionCheck.warning).toContain('receipt needs an acknowledgement');
    expect(received.slice(before)).toHaveLength(1);
    expect(received.at(-1).message.content).toContain('from-mode="bypass"');
  });

  test('check warns about the prompting-to-bypass mismatch without opening a socket or reading stdin', async () => {
    const before = connections;
    const result = await run(['--check', '--from-mode', 'prompting']);
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out).toEqual({
      status: 'checked', harness: 'claude', id, name: 'Recipient', host: 'local', submitted: false,
      permissionCheck: { status: 'unknown', senderMode: 'prompting', warning: expect.any(String) },
    });
    expect(result.stderr).toBe(`Warning: ${out.permissionCheck.warning}\n`);
    expect(out.permissionCheck.warning).toContain('This sender declares prompting: a bypass recipient holds it');
    expect(connections).toBe(before);
  });

  test('an unknown sender and unsupported registry fields never become a compatible verdict', async () => {
    const result = await run(['--check']);
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.permissionCheck).toEqual({ status: 'unknown', senderMode: 'unknown', warning: expect.any(String) });
    expect(result.stderr).toBe(`Warning: ${out.permissionCheck.warning}\n`);
    expect(out.permissionCheck.warning).toContain("The sender's permission class is unknown");
    expect(out.permissionCheck.warning).toContain('Explicit inbound settings can also hold or refuse it');
  });

  test('invalid declarations fail during check without a write', async () => {
    const before = connections;
    const result = await run(['--check', '--from-mode', 'auto']);
    expect(result).toEqual({ stdout: '', stderr: '--from-mode must be prompting or bypass\n', code: 1 });
    expect(connections).toBe(before);
  });
});
