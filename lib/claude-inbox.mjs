// Claude Code's inbox socket: find a live session's socket and write one frame.
// Plain Node APIs only: friends also ships this file over ssh to run on a remote host with `node`.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { isAbsolute, join } from 'node:path';

export function claudeRecords(configDir) {
  const directory = join(configDir, 'sessions');
  const out = [];
  let names = [];
  try { names = readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return out; throw error; }
  for (const name of names) {
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
    if (record.pid !== Number(name.slice(0, -5)) || typeof record.sessionId !== 'string') continue;
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') continue;
      if (error.code !== 'EPERM') throw error;
    }
    out.push({ ...record, inbox: inboxOk(record.messagingSocketPath) });
  }
  return out;
}

function inboxOk(socketPath) {
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) return false;
  try {
    const stat = lstatSync(socketPath);
    return stat.isSocket() && stat.uid === process.getuid();
  } catch {
    return false;
  }
}

export function writeMessage(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    // Matches the native Claude Code UDS client's five-second send timeout (checked on 2.1.283).
    socket.setTimeout(5000, () => socket.destroy(new Error('Timed out writing to the Claude inbox')));
    socket.once('error', reject);
    socket.once('connect', () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.once('close', (hadError) => { if (!hadError) resolve(); });
  });
}

// One live inbox for this exact session id, or an error naming how many were found.
export async function sendToSession(sessionId, payload, configDir) {
  const matches = claudeRecords(configDir).filter((r) => r.sessionId === sessionId && r.inbox);
  if (matches.length !== 1) {
    throw new Error(`Expected one live inbox for ${sessionId}; found ${matches.length}. Select the recipient again.`);
  }
  await writeMessage(matches[0].messagingSocketPath, payload);
  return { status: 'written', id: sessionId, name: matches[0].name ?? null };
}
