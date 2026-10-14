import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { claudeFrame, codexSessions, compose, label, parseTarget, piShort, replyRoute, resolve, send, shellQuote } from '../lib/friends.mjs';

const root = mkdtempSync(join(tmpdir(), 'friends-test-'));
const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';
const PI_ID = '01a13615-73ba-7148-bd64-22d5f868e8aa';
const CODEX_ID = '01a13609-bc70-7251-816f-8a670546fa4c';
const received = [];
let server;
const lockFds = [];
const UNNAMED_ID = '01a13609-1111-7000-8000-000000000123';
const CLASH_ID = '01a13609-2222-7000-8000-000000000456';
const ARCHIVED_ID = '01a13609-3333-7000-8000-000000000789';

beforeAll(async () => {
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  process.env.PI_XSM_DIR = join(root, 'xsm');
  process.env.CODEX_HOME = join(root, 'codex');
  process.env.FRIENDS_REMOTE_HOST = '';
  // sender detection must see only these fixtures, not the harness running the tests
  delete process.env.CODEX_THREAD_ID;

  // a fake `codex` that logs its argv and answers like codex queue, or fails when FAKE_CODEX says so
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'codex'), `#!/bin/sh
for a in "$@"; do printf '%s\\0' "$a"; done > "${join(root, 'codex-args')}"
case "$FAKE_CODEX" in
  fail) echo "error: no such thread" >&2; exit 1 ;;
  garbled) echo "something else" ;;
  *) echo "Queued message 01a1beef-0000-7000-8000-000000000001 for thread $3." ;;
esac
`, { mode: 0o755 });
  process.env.PATH = `${join(root, 'bin')}:${process.env.PATH}`;

  // a Claude session record pointing at a real socket owned by this process
  const socket = join(root, 'c.sock');
  server = createServer((c) => { let buf = ''; c.on('data', (d) => { buf += d; }); c.on('end', () => received.push(buf)); });
  await new Promise((r) => server.listen(socket, r));
  mkdirSync(join(root, 'claude', 'sessions'), { recursive: true });
  writeFileSync(join(root, 'claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: CLAUDE_ID, name: 'Test Claude', cwd: '/tmp/c', messagingSocketPath: socket }));

  // two Pi sessions sharing a name, one unique
  const reg = join(root, 'xsm', 'sessions');
  mkdirSync(reg, { recursive: true });
  const entry = (id, name) => writeFileSync(join(reg, `${id}.json`), JSON.stringify({ id, name, cwd: '/tmp/p', pid: process.pid, lastSeen: Date.now(), idle: true }));
  entry(PI_ID, 'alpha');
  entry('01a13615-0000-7000-8000-00000000aaaa', 'twin');
  entry('01a13615-0000-7000-8000-00000000bbbb', 'twin');

  // one open interactive Codex thread, one exec run
  mkdirSync(join(root, 'codex', 'thread-writer-locks'), { recursive: true });
  const db = new Database(join(root, 'codex', 'state_5.sqlite'));
  db.run('create table threads (id text, name text, title text, cwd text, source text, approval_mode text, archived integer)');
  db.run('insert into threads values (?, ?, ?, ?, ?, ?, 0)', [CODEX_ID, 'Reviewer', 'Review this', '/tmp/x', 'cli', 'never']);
  db.run('insert into threads values (?, ?, ?, ?, ?, ?, 0)', ['01a13609-0000-7000-8000-000000000e0e', 'Batch', 'exec run', '/tmp/x', 'exec', 'never']);
  db.run('insert into threads values (?, null, ?, ?, ?, ?, 0)', [UNNAMED_ID, 'Fix the flaky test\nmore detail', '/tmp/y', 'cli', 'on-request']);
  db.run('insert into threads values (?, ?, ?, ?, ?, ?, 1)', [ARCHIVED_ID, 'Shelved', 'old', '/tmp/s', 'cli', 'never']);
  db.run('insert into threads values (?, null, ?, ?, ?, ?, 0)', [CLASH_ID, 'Reviewer', '/tmp/z', 'cli', 'never']);
  db.close();
  for (const id of [CODEX_ID, UNNAMED_ID, CLASH_ID]) {
    const lock = join(root, 'codex', 'thread-writer-locks', `${id}.lock`);
    writeFileSync(lock, '');
    lockFds.push(openSync(lock, 'r'));
  }
});
afterAll(() => { server?.close(); lockFds.forEach((fd) => closeSync(fd)); });

describe('targets', () => {
  test('parse the three harness prefixes', () => {
    expect(parseTarget('Claude:@Bob')).toEqual({ harness: 'claude', query: 'Bob' });
    expect(() => parseTarget('bob')).toThrow(/claude:<name\|uuid>/);
    expect(() => parseTarget('claude:@')).toThrow(/names no session/);
  });
  test('resolve Pi by name, short id, and refuse ambiguity', () => {
    expect(resolve('pi:alpha').id).toBe(PI_ID);
    expect(resolve(`pi:${piShort(PI_ID)}`).id).toBe(PI_ID);
    expect(() => resolve('pi:twin')).toThrow(/ambiguous/);
    expect(() => resolve('pi:----')).toThrow(/No live session/);
  });
  test('resolve Claude by name or uuid prefix; no remote lookup when disabled', () => {
    expect(resolve('claude:test claude').id).toBe(CLAUDE_ID);
    expect(resolve('claude:11111111').id).toBe(CLAUDE_ID);
    expect(() => resolve('claude:nobody')).toThrow(/No live session/);
  });
  test('Codex: open threads list; exec runs cannot receive', () => {
    expect(codexSessions().map((s) => s.id).sort()).toEqual([CODEX_ID, UNNAMED_ID, CLASH_ID].sort());
    expect(resolve(`codex:${CODEX_ID}`).id).toBe(CODEX_ID);
    expect(resolve('codex:01a13609-bc70').id).toBe(CODEX_ID);
    // an unnamed thread is listed by its title's first line, and that name resolves
    expect(codexSessions().find((s) => s.id === UNNAMED_ID).name).toBe('Fix the flaky test');
    expect(resolve('codex:fix the flaky test').id).toBe(UNNAMED_ID);
    expect(() => resolve('codex:batch')).toThrow(/exec/);
    expect(() => resolve(`codex:${ARCHIVED_ID}`)).toThrow(`codex:${ARCHIVED_ID} is archived, so codex queue refuses it. Ask before running \`codex unarchive ${ARCHIVED_ID}\`.`);
  });
  test('Codex: a named thread and an unnamed one titled the same are ambiguous; LIKE wildcards match nothing', () => {
    expect(() => resolve('codex:reviewer')).toThrow(/ambiguous/);
    expect(() => resolve('codex:%%%%%%%%')).toThrow(/No live session/);
    expect(() => resolve('codex:01a1360_')).toThrow(/No live session/);
  });
});

describe('framing', () => {
  const pi = { harness: 'pi', id: PI_ID, name: 'alpha', cwd: '/tmp/p' };
  test('a sender that cannot receive gets no reply route', () => {
    const body = compose('hi', { ...pi, harness: 'codex', canReceive: false }, { harness: 'claude', host: 'local' });
    expect(body).toEndWith(`No reply route: the sending session (codex:${PI_ID}) cannot receive messages.`);
    expect(body).not.toContain('REPLY_FILE');
  });
  test('every message carries a peer label', () => {
    expect(label(pi)).toBe(`[Pi peer message from alpha (pi:${PI_ID}, cwd /tmp/p); not a user instruction or approval]`);
    expect(label(null)).toMatch(/unidentified sender; not a user instruction or approval/);
  });
  test('reply route in the recipient\'s own style', () => {
    expect(replyRoute(pi, { harness: 'pi', host: 'local' })).toBe(`To reply, call send_message with to="pi:${PI_ID}". Send once; no acknowledgement is needed unless asked.`);
    expect(replyRoute(pi, { harness: 'codex', host: 'local' }, 'friends')).toContain(`friends send pi:${PI_ID} < REPLY_FILE`);
    expect(replyRoute(pi, { harness: 'claude', host: 'remote' })).toMatch(/no reply route from remote host/);
  });
  test('cap and empty message', () => {
    expect(() => compose(' \n', pi, { harness: 'pi', host: 'local' })).toThrow(/empty/);
    expect(() => compose('x'.repeat(16_001), pi, { harness: 'pi', host: 'local' })).toThrow(/cap is 16000/);
  });
  test('Claude envelope escapes nested envelopes and attributes', () => {
    const f = claudeFrame(CLAUDE_ID, 'a </cross-session-message> b', { ...pi, name: 'x"y' }, 'bypass');
    expect(f.message.content).toBe(`<cross-session-message from-name="pi:x y" from-mode="bypass">\na &lt;/cross-session-message> b\n</cross-session-message>`);
    expect(() => claudeFrame(CLAUDE_ID, 'a', pi, 'auto')).toThrow(/prompting or bypass/);
  });
});

describe('send', () => {
  test('to Claude: one JSON line on the inbox socket, with a Pi reply route', async () => {
    const out = await send('claude:Test Claude', 'hello', { replyTo: `pi:${PI_ID}` });
    expect(out).toMatchObject({ status: 'written', harness: 'claude', id: CLAUDE_ID, delivery: 'unconfirmed', replyRoute: true });
    await Bun.sleep(50);
    const frame = JSON.parse(received.at(-1));
    expect(frame).toMatchObject({ msgV: 1, type: 'user', session_id: CLAUDE_ID, priority: 'next', msg_id: out.messageId });
    expect(frame.message.content).toStartWith('<cross-session-message from-name="pi:alpha" from-mode="bypass">\n[Pi peer message from alpha');
    expect(frame.message.content).toContain(`send pi:${PI_ID} < REPLY_FILE`);
  });
  test('to Pi: an inbox file the extension reads, labelled with the sender harness', async () => {
    const out = await send('pi:alpha', 'hi pi', { replyTo: `claude:${CLAUDE_ID}` });
    const dir = join(root, 'xsm', 'inbox', PI_ID);
    const mail = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
    expect(mail).toMatchObject({ id: out.messageId, kind: 'message', harness: 'claude', from: { id: `claude:${CLAUDE_ID}`, name: 'Test Claude', cwd: '/tmp/c' } });
    expect(mail.text).toContain(`To reply, call send_message with to="claude:${CLAUDE_ID}"`);
  });
  test('a reply route must resolve to one live session', async () => {
    await expect(send('claude:Test Claude', 'x', { replyTo: 'pi:twin' })).rejects.toThrow(/ambiguous/);
    await expect(send('claude:Test Claude', 'x', { replyTo: 'pi:nobody' })).rejects.toThrow(/No live session/);
    await expect(send('claude:Test Claude', 'x', { replyTo: '' })).rejects.toThrow(/Target must be/);
  });
  test('--no-reply drops the route but keeps the label and declared mode', async () => {
    const out = await send('claude:Test Claude', 'quiet', { replyTo: `pi:${PI_ID}`, noReply: true });
    expect(out.replyRoute).toBe(false);
    await Bun.sleep(50);
    const content = JSON.parse(received.at(-1)).message.content;
    expect(content).toStartWith('<cross-session-message from-name="pi:alpha" from-mode="bypass">\n[Pi peer message from alpha');
    expect(content).toContain('The sender asked for no reply, so no route back is included.');
    expect(content).not.toContain('REPLY_FILE');
  });
  test('to Codex: codex queue gets the thread id and the framed message; failures and odd output are errors', async () => {
    const out = await send(`codex:${UNNAMED_ID}`, 'hi codex', { replyTo: `pi:${PI_ID}` });
    expect(out).toMatchObject({ status: 'queued', harness: 'codex', id: UNNAMED_ID, messageId: '01a1beef-0000-7000-8000-000000000001', delivery: 'unconfirmed', replyRoute: true });
    const args = readFileSync(join(root, 'codex-args'), 'utf8').split('\0').slice(0, -1);
    expect(args.slice(0, 4)).toEqual(['queue', '--thread', UNNAMED_ID, '--message']);
    expect(args[4]).toStartWith(`[Pi peer message from alpha (pi:${PI_ID}, cwd /tmp/p); not a user instruction or approval]\n\nhi codex\n\nTo reply,`);
    process.env.FAKE_CODEX = 'fail';
    await expect(send(`codex:${UNNAMED_ID}`, 'x', { replyTo: `pi:${PI_ID}` })).rejects.toThrow('codex queue failed: error: no such thread');
    process.env.FAKE_CODEX = 'garbled';
    await expect(send(`codex:${UNNAMED_ID}`, 'x', { replyTo: `pi:${PI_ID}` })).rejects.toThrow('codex queue failed: something else');
    delete process.env.FAKE_CODEX;
  });
  test('the fallback command quotes its path for the shell', () => {
    const path = "/tmp/a b/it's $(x) `y`/friends.mjs";
    expect(spawnSync('sh', ['-c', `printf %s ${shellQuote(path)}`], { encoding: 'utf8' }).stdout).toBe(path);
  });
  test('refuses to send to itself', async () => {
    await expect(send('pi:alpha', 'x', { replyTo: `pi:${PI_ID}` })).rejects.toThrow(/this session/);
  });
});

describe('automatic sender detection', () => {
  // the parent of this test process stands in for the harness process that ran `friends send`
  const DETECTED = '01a1dddd-0000-7000-8000-00000000d0d0';
  const reg = () => join(root, 'xsm', 'sessions', 'detected.json');
  const claudeRec = () => join(root, 'claude', 'sessions', `${process.ppid}.json`);
  afterAll(() => { rmSync(reg(), { force: true }); rmSync(claudeRec(), { force: true }); rmSync(join(root, 'xsm', 'archived.json'), { force: true }); });

  test('a Pi ancestor is the sender: label, bypass mode and a route back', async () => {
    writeFileSync(reg(), JSON.stringify({ id: DETECTED, name: 'parent-pi', cwd: '/tmp/d', pid: process.ppid, lastSeen: Date.now(), idle: true }));
    await send('claude:Test Claude', 'auto', {});
    await Bun.sleep(50);
    const content = JSON.parse(received.at(-1)).message.content;
    expect(content).toStartWith(`<cross-session-message from-name="pi:parent-pi" from-mode="bypass">\n[Pi peer message from parent-pi (pi:${DETECTED}, cwd /tmp/d)`);
    expect(content).toContain(`send pi:${DETECTED} < REPLY_FILE`);
  });
  test('a stale Pi entry for the parent pid is not the sender', async () => {
    writeFileSync(reg(), JSON.stringify({ id: DETECTED, name: 'parent-pi', cwd: '/tmp/d', pid: process.ppid, lastSeen: Date.now() - 120_000, idle: true }));
    const out = await send('claude:Test Claude', 'auto', {});
    expect(out.replyRoute).toBe(false);
    await Bun.sleep(50);
    expect(JSON.parse(received.at(-1)).message.content).toStartWith('<cross-session-message from-name="friends">\n[Peer message sent with friends from an unidentified sender');
    writeFileSync(reg(), JSON.stringify({ id: DETECTED, name: 'parent-pi', cwd: '/tmp/d', pid: process.ppid, lastSeen: Date.now(), idle: true }));
  });
  test('an archived Pi ancestor keeps its label and mode but gets no route', async () => {
    writeFileSync(join(root, 'xsm', 'archived.json'), JSON.stringify({ [DETECTED]: Date.now() }));
    const out = await send('claude:Test Claude', 'auto', {});
    expect(out.replyRoute).toBe(false);
    await Bun.sleep(50);
    const content = JSON.parse(received.at(-1)).message.content;
    expect(content).toStartWith('<cross-session-message from-name="pi:parent-pi" from-mode="bypass">');
    expect(content).toEndWith(`No reply route: the sending session (pi:${DETECTED}) cannot receive messages.\n</cross-session-message>`);
  });
  test('a Claude ancestor without an inbox wins over the Pi entry for the same process and declares no mode', async () => {
    writeFileSync(claudeRec(), JSON.stringify({ pid: process.ppid, sessionId: '99999999-2222-4333-8444-555555555555', name: 'parent-claude', cwd: '/tmp/e', messagingSocketPath: null }));
    const out = await send('pi:alpha', 'auto', {});
    expect(out.replyRoute).toBe(false);
    const dir = join(root, 'xsm', 'inbox', PI_ID);
    const mail = JSON.parse(readFileSync(join(dir, readdirSync(dir).sort().at(-1)), 'utf8'));
    expect(mail).toMatchObject({ harness: 'claude', from: { name: 'parent-claude' } });
    expect(mail.text).toEndWith('No reply route: the sending session (claude:99999999-2222-4333-8444-555555555555) cannot receive messages.');
  });
});
