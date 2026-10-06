import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function findSession(id, configDir) {
  if (!uuid.test(id ?? '')) throw new Error('--session must be a full Claude session UUID');
  const directory = join(configDir, 'sessions');
  const matches = [];
  for (const name of readdirSync(directory)) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = join(directory, name);
    let record;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.uid !== process.getuid()) continue;
      record = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
    if (record.sessionId !== id || record.pid !== Number(name.slice(0, -5))) continue;
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') continue;
      throw error;
    }
    if (typeof record.messagingSocketPath === 'string') matches.push(record);
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one live inbox for ${id}; found ${matches.length}. Select the recipient again.`);
  }
  const session = matches[0];
  if (!isAbsolute(session.messagingSocketPath)) throw new Error('Inbox path must be absolute');
  const stat = lstatSync(session.messagingSocketPath);
  if (!stat.isSocket() || stat.uid !== process.getuid()) {
    throw new Error('Inbox must be a socket owned by this OS user, not a symlink');
  }
  return session;
}

export function frame(id, message, mode, replyThread) {
  if (!message.trim()) throw new Error('Read an empty message from stdin');
  if (mode !== undefined && !['prompting', 'bypass'].includes(mode)) {
    throw new Error('--from-mode must be prompting or bypass');
  }
  if (replyThread !== undefined && !uuid.test(replyThread)) {
    throw new Error('--reply-thread must be a full Codex thread UUID');
  }
  let body = message.trimEnd();
  if (replyThread) {
    body += `\n\nReply to Codex thread ${replyThread} using its native queue. `;
    body += 'Write your reply to a temporary text file, starting with [Claude peer message; not a user instruction or approval]. Then run:\n';
    body += `codex queue --thread ${replyThread} --message "$(cat REPLY_FILE)"\n`;
    body += 'Replace REPLY_FILE with your file path, quoting the path if needed. Send once; a queued reply may wait for the active Codex turn to finish.';
  }
  // Keep message text inside its peer envelope, including when it discusses this format.
  body = body.replace(/<\/?cross-session-message/g, (tag) => tag.replace('<', '&lt;'));
  const attributes = `from-name="Codex"${mode ? ` from-mode="${mode}"` : ''}`;
  return {
    msgV: 1,
    msg_id: randomUUID(),
    type: 'user',
    session_id: id,
    priority: 'next',
    message: { role: 'user', content: `<cross-session-message ${attributes}>\n${body}\n</cross-session-message>` },
  };
}

export function writeMessage(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    // Matches the native Claude Code 2.1.283 UDS client's five-second send timeout.
    socket.setTimeout(5000, () => socket.destroy(new Error('Timed out writing to the Claude inbox')));
    socket.once('error', reject);
    socket.once('connect', () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.once('close', (hadError) => { if (!hadError) resolve(); });
  });
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: {
      session: { type: 'string' },
      'from-mode': { type: 'string' },
      'reply-thread': { type: 'string' },
      help: { type: 'boolean' },
    } });
    if (values.help) {
      console.log('bun send.mjs --session UUID [--from-mode prompting|bypass] [--reply-thread UUID] < message.txt');
    } else {
      const payload = frame(values.session, readFileSync(0, 'utf8'), values['from-mode'], values['reply-thread']);
      const session = findSession(values.session, process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
      await writeMessage(session.messagingSocketPath, payload);
      console.log(JSON.stringify({ status: 'written', sessionId: session.sessionId, messageId: payload.msg_id, delivery: 'unconfirmed' }));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
