# friends FAQ

## When a session runs `friends send`, how does it say who it is?

It doesn't have to. friends walks up its own parent processes to the nearest Claude Code, Codex or Pi session (a Claude session record, a Pi registry entry, or a `codex` process with `CODEX_THREAD_ID`) and uses that session as the sender and reply address. `friends whoami` prints what it finds; `--reply-to <target>` overrides it, and the Pi extension always passes it.

_Sources: `lib/friends.mjs` `detectSelf`; tests "automatic sender detection". Created and verified 2026-10-14._

## Does the receiving session need friends and the skills installed?

It needs the CLI, not the skills. Every message carries its full reply command, so a Claude or Codex session with no friends skill still knows what to run (a skill-less Claude replied in testing), but it needs `friends` on its `PATH` to run it. A Pi session replies with `send_message`, which needs the pi-x-session-messaging extension that takes `claude:` and `codex:` targets. So friends assumes one machine with the CLI installed once and skills shared, as in Luis's setup.

_Sources: README round trips, 2026-10-13. Created and verified 2026-10-14._

## Can a Claude session on remote host reply to the Mac?

No. friends reaches node sessions one way over ssh, and since Claude Desktop's 12 Oct 2026 update a node session's own `SendMessage` cannot reach Mac sessions. A relay was considered and rejected to keep friends minimal.

_Created and verified 2026-10-14._
