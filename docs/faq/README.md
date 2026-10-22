# friends FAQ

## When a session runs `friends send`, how does it say who it is?

It doesn't have to. friends walks up its own parent processes to the nearest Claude Code, Codex or Pi session (a Claude session record, a Pi registry entry, or a `codex` process with `CODEX_THREAD_ID`) and uses that session as the sender and reply address. `friends whoami` prints what it finds; `--reply-to <target>` overrides it, and the Pi extension always passes it.

_Sources: `lib/friends.mjs` `detectSelf`; tests "automatic sender detection". Created and verified 2026-10-14._

## What if Codex's state database cannot be opened?

`friends ls` preserves the sessions it can read, prints `Inventory incomplete` with the failing database path, and exits 1. With `--json`, this result is `{ "sessions": [...], "errors": [...] }`; a complete local inventory keeps its usual array. Check the configured `CODEX_HOME` and access to the database directory, including WAL/SHM files. friends does not modify the database or retry with a different SQLite mode.

If process ancestry proves the sender is Codex, its `CODEX_THREAD_ID` still identifies it for a message to Claude or Pi. The CLI warns that permission mode and reply capability could not be verified, omits the sender-mode declaration and reply route, and leaves Claude permission compatibility unknown. Direct Codex resolution and sends still fail with the database diagnostic rather than pretending the target is missing. An inherited thread ID without a Codex ancestor does not establish sender identity.

_Sources: `lib/friends.mjs` `readCodexState` and `detectSelf`; `bin/friends.mjs`; isolated real SQLite CANTOPEN and readable-database controls in `test/codex-state.test.mjs`. Created and verified 2026-10-22._

## Does the receiving session need friends and the skills installed?

It needs the CLI, not the skills. Every message carries its full reply command, so a Claude or Codex session with no friends skill still knows what to run (a skill-less Claude replied in testing), but it needs `friends` on its `PATH` to run it. A Pi session replies with `send_message`, which needs the pi-x-session-messaging extension that takes `claude:` and `codex:` targets. So friends assumes one machine with the CLI installed once and skills shared, as in Luis's setup.

_Sources: README round trips, 2026-10-13. Created and verified 2026-10-14._

## Can a Claude session on remote host reply to the Mac?

No. friends reaches node sessions one way over ssh, and since Claude Desktop's 12 Oct 2026 update a node session's own `SendMessage` cannot reach Mac sessions. A relay was considered and rejected to keep friends minimal.

_Created and verified 2026-10-14._

## Why did friends say written when Claude saw nothing?

`written` means the socket write completed; it does not report Claude's inbound decision. Claude's default policy holds a message when its sender and recipient use different permission classes. Auto counts as prompting. Desktop cannot show the approval dialog, so a default-held message normally expires after five minutes unless the user changes the applicable mode or policy. Explicit `crossSessionInbound` settings can hold or refuse messages too.

friends now warns **before writing**, naming the risk for the sender's actual declared class, and includes `permissionCheck.status: "unknown"` in its JSON. Run `friends send claude:<target> --check` for the same warning without posting or supplying a message. This is an uncertainty warning, not a detected mismatch: the session registry has no live mode or effective inbound-policy field. Startup arguments, transcript `mode`, and settings files cannot prove the current policy, so friends does not infer acceptance from them. The one-way transport has no delivery acknowledgement on its write connection. Ask the recipient's user to check; do not resend with a different sender declaration. A reply or acknowledgement confirms receipt.

_Sources: [Claude inbound controls](https://code.claude.com/docs/en/cross-session-messaging#control-inbound-messages); Claude Code 2.1.308 registry and inbox implementation (its status notices use a separate reverse peer address); `lib/friends.mjs`; tests "Claude permission warning". Created and verified 2026-10-22._

## Why can't friends message a Claude session I can see running?

Because it has no inbox socket. friends delivers through the session's inbox socket, the one Claude's cross-session messaging docs describe (there is no `claude inbox` command), and finds it through the session's record in `~/.claude/sessions/`. The docs list a session in Claude's own `/list-agents` "only when it binds an inbox socket", so Claude's `SendMessage` cannot reach such a session either. friends still lists such a session, from the `claude` process and its transcript, with RECEIVE `no*`, and `friends resolve` names it and says why it cannot receive. On Claude Code 2.1.300 a session skips its record when it is a child session (a `claude` started from a Claude Bash tool outside tmux, which exports `CLAUDE_CODE_CHILD_SESSION`), a team agent, a diskless run or a parked spare, and loses it when the write fails. The 15 Oct 2026 case was most likely the last one: `disk-cleanup-emergency`, a terminal `claude` started while the disk was full (its own transcript logs `ENOSPC` a minute later), ran with neither a record nor a socket, none of the skip conditions applied, and a fresh 2.1.300 in a throwaway config dir wrote both, with and without `--dangerously-skip-permissions`. A restart with free disk space (`claude --resume <uuid>` keeps the conversation) runs the same registration, so it should get an inbox.

_Sources: the 2.1.300 binary (`hp()` and `NXe()` gate the pid-file write in `iG()`); code.claude.com/docs/en/cross-session-messaging ("The session's inbox socket"); `lib/claude-procs.mjs`; tests "Claude sessions without a session record". Created and verified 2026-10-15._

## Does finding sessions without a record depend on one machine's setup?

No. It reads the process table with `ps`, open files with `lsof` (only for `claude` processes that have no record), and transcripts under `CLAUDE_CONFIG_DIR` in Claude Code's own project-folder naming, so nothing in it is tied to one machine (it was tested on macOS; Linux uses the same `ps` and `lsof` fields but is untested). Without `lsof` it simply lists nothing extra. It is local only: the remote lookup over ssh still reads records alone. The wider assumption is older and applies to every Claude target: the `~/.claude/sessions/` registry friends reads is undocumented (the docs give the socket path only through `/status` and `CLAUDE_CODE_MESSAGING_SOCKET`), so a Claude Code release that changes it breaks discovery.

_Sources: `lib/claude-procs.mjs`; `lib/friends.mjs` `remoteScript`. Created and verified 2026-10-15._
