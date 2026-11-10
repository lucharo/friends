#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { claudeSessions, codexSessions, detectSelf, piSessions, remoteClaudeSessions, resolve, send } from '../lib/friends.mjs';

const USAGE = `friends: message Claude Code, Codex and Pi sessions on this machine

  friends ls [--json] [--remote]     live sessions (--remote adds Claude sessions on the ssh host)
  friends send <target> [--check] [--reply-to <target>] [--no-reply] [--from-mode prompting|bypass] [--local] < message
  friends whoami [--json]            the session this command runs in, i.e. your reply route
  friends resolve <target> [--local] the one live session a target names, as JSON (or why not)

Targets: claude:<name|uuid>, codex:<thread uuid|name>, pi:<name|id>.
A claude: target not found here is looked up on the ssh host FRIENDS_REMOTE_HOST when it is set,
one way: no reply route back. "written"/"queued" is submission, not delivery.
--check resolves the target and reports permission uncertainty without reading stdin or sending.
Claude sends warn before writing: its live inbound policy is unavailable through this transport.`;

const home = (p = '') => p.replace(homedir(), '~');

// a cut name ends in … and will not resolve; the id always does
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function table(rows, me) {
  if (!rows.length) return 'No live sessions.';
  const cells = rows.map((r) => [
    r.harness + (r.host !== 'local' ? `@${r.host.split(/[.-]/)[0]}` : ''),
    cut(r.name ?? '(unnamed)', 48),
    r.id,
    home(r.cwd ?? ''),
    (r.canReceive ? 'yes' : r.registered === false ? 'no*' : 'no') + (me && me.harness === r.harness && me.id === r.id ? ' (you)' : ''),
  ]);
  const head = ['HARNESS', 'NAME', 'ID', 'CWD', 'RECEIVE'];
  let note = cells.some((c) => c[1].endsWith('…')) ? '\nNames ending in … are cut; target those sessions by id.' : '';
  if (rows.some((r) => r.registered === false && !r.canReceive)) note += '\nno*: a live Claude session Claude Code wrote no session record for, so it has no inbox; found from its process and transcript.';
  const width = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  return [head, ...cells].map((c) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(width[i]))).join('  ')).join('\n') + note;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') return console.log(USAGE);
  if (cmd === 'ls') {
    const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' }, remote: { type: 'boolean' } } });
    const rows = [];
    const errors = [];
    for (const [name, list] of [['claude', claudeSessions], ['codex', codexSessions], ['pi', piSessions]]) {
      try { rows.push(...list()); } catch (error) { errors.push(`${name}: ${error.message}`); }
    }
    if (values.remote) {
      try { rows.push(...remoteClaudeSessions()); } catch (e) { errors.push(`remote: ${e.message}`); }
    }
    if (values.json) console.log(JSON.stringify(values.remote || errors.length ? { sessions: rows, errors } : rows, null, 2));
    else {
      let me;
      try { me = detectSelf(); } catch (error) { errors.push(`sender: ${error.message}`); }
      console.log(table(rows, me));
    }
    for (const error of errors) console.error(`Inventory incomplete: ${error}`);
    if (errors.length) process.exitCode = 1;
    return;
  }
  if (cmd === 'whoami') {
    const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } });
    const me = detectSelf();
    if (values.json) return console.log(JSON.stringify(me));
    if (!me) { console.log('Not inside a Claude Code, Codex or Pi session that friends can identify.'); process.exitCode = 1; return; }
    return console.log(`${me.harness}:${me.id}  ${me.name ?? '(unnamed)'}  ${home(me.cwd ?? '')}`);
  }
  if (cmd === 'resolve') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { local: { type: 'boolean' } } });
    if (positionals.length !== 1) throw new Error('Give exactly one target: friends resolve <target>');
    return console.log(JSON.stringify(resolve(positionals[0], { remote: !values.local })));
  }
  if (cmd === 'send') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
      'reply-to': { type: 'string' }, 'no-reply': { type: 'boolean' }, 'from-mode': { type: 'string' }, local: { type: 'boolean' }, check: { type: 'boolean' },
    } });
    if (positionals.length !== 1) throw new Error('Give exactly one target: friends send <target> < message');
    const result = await send(positionals[0], values.check ? undefined : readFileSync(0, 'utf8'), {
      replyTo: values['reply-to'], noReply: values['no-reply'], mode: values['from-mode'], remote: !values.local, check: values.check,
    });
    return console.log(JSON.stringify(result));
  }
  throw new Error(`Unknown command ${cmd}\n\n${USAGE}`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
