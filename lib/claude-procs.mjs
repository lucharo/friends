// Live Claude Code processes that have no ~/.claude/sessions/<pid>.json record.
// Claude Code skips the record for a child session (a `claude` started from a Claude Bash tool, outside
// tmux), a team agent, a diskless run or a parked spare, and it is lost when the write fails (a full disk).
// Such a session still runs and still writes its transcript, so friends finds it from the process
// table: an open transcript handle when lsof shows one, otherwise the newest unclaimed transcript in
// its cwd's project directory written since the process started. Without a record there is no inbox
// socket on file, so the row says it cannot receive unless lsof shows the process listening on one.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const TRANSCRIPT = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;
const START_SLACK_MS = 5_000; // ps reports elapsed time in whole seconds
// how much of a transcript to read: backwards from the end in chunks, then the head; tests shrink these
export const limits = { chunk: 256 * 1024, back: 8 * 1024 * 1024, head: 512 * 1024 };
const NO_RECORD = 'Claude Code wrote no session record for this process, so it has no inbox socket to write to.';

// [[dd-]hh:]mm:ss -> seconds
export function etimeSeconds(etime) {
  const m = String(etime).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d = 0, h = 0, min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

// Replaceable so tests can feed a fake process table and fake lsof output.
export const probes = {
  ps() {
    const res = spawnSync('ps', ['-axo', 'pid=,ppid=,etime=,tty=,comm='], { encoding: 'utf8' });
    return res.stdout || '';
  },
  // -F fields: p pid, f fd, t type, n name. Only the exact pids asked for.
  lsof(pids) {
    const res = spawnSync('lsof', ['-nP', '-a', '-p', pids.join(','), '-Fpftn'], { encoding: 'utf8', timeout: 20_000 });
    return res.stdout || '';
  },
};

export function parsePs(text, now = Date.now()) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const secs = etimeSeconds(m[3]);
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), startMs: secs === null ? null : now - secs * 1000, tty: m[4], comm: m[5].trim() });
  }
  return out;
}

export function parseLsof(text) {
  const byPid = new Map();
  let cur = null;
  let fd = null;
  let type = null;
  for (const line of text.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      cur = { cwd: null, files: [], sockets: [] };
      byPid.set(Number(value), cur);
    } else if (tag === 'f') {
      fd = value;
      type = null;
    } else if (tag === 't') {
      type = value;
    } else if (tag === 'n' && cur) {
      if (fd === 'cwd') cur.cwd = value;
      else if (type === 'unix' && value.startsWith('/')) cur.sockets.push(value);
      else if (type === 'REG') cur.files.push(value);
    }
  }
  return byPid;
}

const isClaude = (comm) => basename(comm) === 'claude';
const hasTty = (tty) => !!tty && tty !== '??' && tty !== '-';

// Claude Code names a project directory after its cwd with every non-alphanumeric turned into "-"
// and long names cut, so a long one is found by its prefix.
export function projectDir(configDir, cwd) {
  const projects = join(configDir, 'projects');
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const exact = join(projects, name);
  if (existsSync(exact) || name.length <= 200) return exact;
  const hit = (existsSync(projects) ? readdirSync(projects) : []).find((d) => d.startsWith(name.slice(0, 200)));
  return hit ? join(projects, hit) : exact;
}

function readSlice(file, position, length) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, position);
    return buf.subarray(0, n).toString('utf8');
  } finally { closeSync(fd); }
}

// Complete lines of a file from the end backwards, reading at most maxBytes; a line cut by that limit is dropped.
function* linesBackward(file, size, maxBytes) {
  const fd = openSync(file, 'r');
  try {
    let pos = size;
    let read = 0;
    let carry = Buffer.alloc(0);
    while (pos > 0 && read < maxBytes) {
      const len = Math.min(limits.chunk, pos);
      pos -= len;
      read += len;
      const chunk = Buffer.alloc(len);
      readSync(fd, chunk, 0, len, pos);
      const data = Buffer.concat([chunk, carry]);
      let from = 0;
      if (pos > 0) {
        // bytes before the first newline may continue a line that starts in an earlier chunk
        const nl = data.indexOf(10);
        if (nl === -1) { carry = data; continue; }
        carry = data.subarray(0, nl);
        from = nl + 1;
      }
      const lines = data.subarray(from).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) yield lines[i];
    }
  } finally { closeSync(fd); }
}

const parse = (line) => {
  if (!line.includes('{')) return null;
  try { return JSON.parse(line); } catch { return null; }
};

// The name and launch details a transcript carries: the latest custom title (what /rename sets), else the
// latest agent name, else the latest automatic title; and the latest entrypoint, cwd and version.
// Reads backwards from the end until it has a custom title and all three launch fields, at most
// limits.back bytes; then fills anything still missing from the head, the oldest part of the file.
export function transcriptMeta(file) {
  let size;
  try { size = statSync(file).size; } catch { return null; }
  const meta = { customTitle: null, agentName: null, aiTitle: null, entrypoint: null, cwd: null, version: null };
  const take = (d, into) => {
    if (d.type === 'custom-title' && typeof d.customTitle === 'string') into.customTitle ??= d.customTitle;
    else if (d.type === 'agent-name' && typeof d.agentName === 'string') into.agentName ??= d.agentName;
    else if (d.type === 'ai-title' && typeof d.aiTitle === 'string') into.aiTitle ??= d.aiTitle;
    for (const k of ['entrypoint', 'cwd', 'version']) if (typeof d[k] === 'string') into[k] ??= d[k];
  };
  const done = () => meta.customTitle !== null && meta.entrypoint !== null && meta.cwd !== null && meta.version !== null;
  let scanned = 0;
  for (const line of linesBackward(file, size, limits.back)) {
    scanned += line.length + 1;
    const d = parse(line);
    if (d) take(d, meta);
    if (done()) break;
  }
  if (!done() && scanned < size) {
    // the head is older than everything read so far, so it only fills gaps; within it the latest value wins
    const head = { customTitle: null, agentName: null, aiTitle: null, entrypoint: null, cwd: null, version: null };
    const lines = readSlice(file, 0, Math.min(limits.head, size)).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) { const d = parse(lines[i]); if (d) take(d, head); }
    for (const k of Object.keys(meta)) meta[k] ??= head[k];
  }
  meta.name = meta.customTitle || meta.agentName || meta.aiTitle || null;
  return meta;
}

// A socket the process itself is listening on at <dir>/<pid>.sock, where Claude Code puts its inbox,
// and that still exists as a socket this user owns.
function liveInbox(pid, sockets, uid) {
  for (const path of sockets) {
    if (basename(path) !== `${pid}.sock`) continue;
    try {
      const st = lstatSync(path);
      if (st.isSocket() && st.uid === uid) return path;
    } catch {}
  }
  return null;
}

// Only a verified match (an open transcript handle, or the session id the process exported) may use a socket:
// a folder-and-time match can name a session that has since closed, and writing to the wrong inbox is worse
// than not writing.
const VERIFIED = new Set(['open-transcript', 'env']);
const INFERRED = ' It was matched to its process by folder and newest transcript, not proven.';

function row(proc, sessionId, meta, info, match, extraReason = '') {
  const socket = proc ? liveInbox(proc.pid, info?.sockets ?? [], process.getuid()) : null;
  const usable = socket && VERIFIED.has(match);
  const reason = socket
    ? 'Claude Code wrote no session record for this process. It listens on an inbox socket, but this session was matched to it by folder and newest transcript, not proven, so friends will not write there.'
    : NO_RECORD + (VERIFIED.has(match) ? '' : INFERRED) + extraReason;
  return {
    harness: 'claude', name: meta?.name ?? null, id: sessionId, cwd: info?.cwd ?? meta?.cwd ?? null, host: 'local',
    canReceive: !!usable, pid: proc?.pid ?? null, entrypoint: meta?.entrypoint ?? null, status: null,
    registered: false, match, ...(usable ? { messagingSocketPath: socket } : { reason }),
  };
}

// records: the live session records already read, so their pids and session ids are left alone.
export function unregisteredClaude(configDir, records, { now = Date.now() } = {}) {
  const recordPids = new Set(records.map((r) => r.pid));
  const claimed = new Set(records.map((r) => r.sessionId));
  const procs = parsePs(probes.ps(), now).filter((p) => isClaude(p.comm) && !recordPids.has(p.pid) && p.pid !== process.pid);
  if (!procs.length) return [];
  const info = parseLsof(probes.lsof(procs.map((p) => p.pid)));
  const projects = join(configDir, 'projects');
  const rows = [];
  const rest = [];

  // an open transcript handle names the session for certain
  for (const p of procs) {
    const i = info.get(p.pid);
    if (!i) continue; // gone, or not ours to inspect
    const file = i.files.find((f) => dirname(dirname(f)) === projects && TRANSCRIPT.test(basename(f)) && !claimed.has(basename(f).slice(0, -6)));
    if (file) {
      const id = basename(file).slice(0, -6).toLowerCase();
      claimed.add(id);
      rows.push(row(p, id, transcriptMeta(file), i, 'open-transcript'));
    } else if (i.cwd && hasTty(p.tty) && p.startMs !== null) rest.push(p);
  }

  // otherwise the newest unclaimed terminal transcript in the cwd's project directory written since the
  // process started; only for processes on a terminal, so background helpers do not claim transcripts
  const groups = new Map();
  for (const p of rest) {
    const dir = projectDir(configDir, info.get(p.pid).cwd);
    groups.set(dir, [...(groups.get(dir) ?? []), p]);
  }
  for (const [dir, group] of groups) {
    const since = Math.min(...group.map((p) => p.startMs)) - START_SLACK_MS;
    const found = [];
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      if (!TRANSCRIPT.test(name) || claimed.has(name.slice(0, -6).toLowerCase())) continue;
      const file = join(dir, name);
      let mtime;
      try { mtime = statSync(file).mtimeMs; } catch { continue; }
      if (mtime < since) continue;
      found.push({ id: name.slice(0, -6).toLowerCase(), file, mtime });
    }
    found.sort((a, b) => b.mtime - a.mtime);
    const picked = [];
    for (const t of found) {
      if (picked.length === group.length) break;
      const meta = transcriptMeta(t.file);
      if (meta?.entrypoint && meta.entrypoint !== 'cli') continue; // a Desktop or SDK session, not a terminal one
      picked.push({ ...t, meta });
    }
    for (const t of picked) {
      claimed.add(t.id);
      if (group.length === 1) rows.push(row(group[0], t.id, t.meta, info.get(group[0].pid), 'cwd-recent'));
      else {
        // several record-less terminal sessions in one directory: the session is real, but which pid is not known
        const pids = group.map((p) => p.pid).join(', ');
        rows.push(row(null, t.id, t.meta, info.get(group[0].pid), 'cwd-ambiguous', ` It is one of pids ${pids}, which share this directory.`));
      }
    }
  }
  return rows;
}

// The session a record-less Claude process runs, when its id is known (a Claude Bash tool exports
// CLAUDE_CODE_SESSION_ID and CLAUDE_PID to the commands it runs).
export function claudeByPid(configDir, pid, sessionId) {
  const info = parseLsof(probes.lsof([pid])).get(pid);
  const dir = info?.cwd ? projectDir(configDir, info.cwd) : null;
  let file = dir && join(dir, `${sessionId}.jsonl`);
  if (!file || !existsSync(file)) {
    const projects = join(configDir, 'projects');
    const hit = (existsSync(projects) ? readdirSync(projects) : []).find((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
    file = hit ? join(projects, hit, `${sessionId}.jsonl`) : null;
  }
  return row({ pid }, sessionId, file ? transcriptMeta(file) : null, info, 'env');
}
