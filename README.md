# friends 🤖 🤝 🤖

Native Cross Session Messaging Between Claude and Codex

`friends` lets your existing Claude Code and Codex conversations talk through each one's native inbox, in every direction. No MCP server or extra service.

Experimental; tested on macOS. Requires [Bun](https://bun.sh) 1.1 or later, Git, [Node.js](https://nodejs.org) for skill installation, and the agent CLIs you use, all on one machine.

## Install

Clone the CLI and link it onto your `PATH` (Bun puts it in `~/.bun/bin`, which its installer adds to your `PATH`):

```sh
git clone https://github.com/lucharo/friends ~/.local/share/friends
cd ~/.local/share/friends && bun link
friends --help
```

Then add the skills in your project:

```sh
npx skills add lucharo/friends \
  --skill message-claude \
  --agent codex
npx skills add lucharo/friends \
  --skill message-codex \
  --agent claude-code
```

## Try it

```sh
friends ls
echo "Hello from the terminal" | friends send claude:<name or uuid>
```

`friends ls` lists the live sessions with a `RECEIVE` column; `send` prints a permission warning on stderr and a JSON result on stdout, and the message appears in that Claude session:

```text
HARNESS  NAME   ID                                    CWD           RECEIVE
claude   bob    eca6a9df-099f-4302-bad0-24bf566095bc  ~/work/bob    yes
claude   alice  88b3e32d-72c0-4a04-af89-2e8c4854e30c  ~/work/alice  yes

{"status":"written","harness":"claude","id":"eca6a9df-…","name":"bob","host":"local","delivery":"unconfirmed",…,"replyRoute":false}
```

`written` means the inbox accepted the message, not that the session read it. From a plain terminal there is no reply route; run from inside a Claude or Codex session, `send` adds one so the recipient can answer.

In Codex, use `/message-claude`, then ask:

```text
Send "Hello from Codex" to <session name>.
Ask for "Hello from Claude" back.
```

Look for `Hello from Claude` back in Codex; it may wait for the active turn to finish.

<details>
<summary>Commands, skills and limits</summary>

| Command | What it does |
| --- | --- |
| `friends ls [--json] [--remote]` | Live sessions: harness, name, id, folder, whether it can receive. |
| `friends send <target> < message` | Sends one message with a peer label and a reply route back to the sender. |
| `friends send <target> --check` | Resolves the target and reports permission uncertainty without sending or reading stdin. |
| `friends whoami` | The session the command runs in, i.e. the reply route it will add. |
| `friends resolve <target>` | The one live session a target names, as JSON, or why it names none. |

Targets are `claude:<name|uuid>` and `codex:<thread uuid|name>`. friends finds the sender from its parent processes; `--reply-to <target>` overrides that, `--no-reply` drops it.

If one harness cannot be read, `ls` still shows the others, reports `Inventory incomplete` on stderr and exits 1. Successful local `ls --json` remains an array; incomplete results use `{ "sessions": [...], "errors": [...] }`, also used by `--remote`. An unreadable Codex database names the path and suggests checking `CODEX_HOME` and directory/WAL/SHM access. A verified Codex ancestor can still send to Claude, but its permission mode and reply capability remain unknown, with a warning and no reply route. Direct Codex targets still fail until the state can be read.

| Skill | What it does |
| --- | --- |
| [/message-claude](skills/message-claude/SKILL.md) | Sends to a running Claude session. |
| [/message-codex](skills/message-codex/SKILL.md) | Queues a message for a Codex thread. |

Each session answers by running `friends send <sender>`. Transports are Claude's [inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket) and `codex queue`.

Set `FRIENDS_REMOTE_HOST` to an ssh host to reach Claude sessions there too: a `claude:` target not found locally is then looked up on that host and written over ssh with the host's `node`, and `friends ls --remote` lists its sessions. It is off by default. That route is one way: the message says there is no reply route back. Claude Desktop used to forward an SSH session's `SendMessage` to local sessions, but since its 12 Oct 2026 update an SSH session can reach only sessions on its own host.

Verified on 2026-10-13 with Claude Code 2.1.296, Codex CLI 0.162.0 and Bun 1.4.2: Claude to Codex to Claude, and Mac to a Linux ssh host. Claude to Claude to Claude verified again from a clean install on 2026-11-10 with Claude Code 2.1.322 and Bun 1.4.4. Linux beyond that remote route is untested; Windows is unsupported. Sender and receiver must share one profile per harness (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`); a reply route names a session, not a profile. The wire formats can change between versions; repeat the exchanges after upgrading a CLI.

`written` and `queued` confirm submission, not receipt; friends never retries. Before writing to Claude, friends warns on stderr and returns `permissionCheck.status: "unknown"` in its JSON result. Claude does not publish its live permission class or effective inbound policy through this transport, so friends cannot certify compatibility. `--check` performs this preflight without posting; a successful check means the target resolved, not that Claude will accept a message.

Under [Claude's default inbound policy](https://code.claude.com/docs/en/cross-session-messaging#control-inbound-messages), a `bypass` sender to an Auto or other prompting recipient is held, as is a prompting or unknown sender to a bypass recipient. Explicit `crossSessionInbound` settings can also hold or refuse messages. Desktop cannot show the approval dialog, and default-held messages normally expire after five minutes. Confirm the recipient's mode and inbound settings with its user; never change the sender's declaration to get past a hold. Only an acknowledgement establishes receipt. friends declares `bypass` for Codex threads that never ask, and `prompting` for other Codex threads.

Use an open, inbox-enabled Claude session; `--bare` sessions have no inbox. RECEIVE `yes` means an inbox exists, not that inbound permissions allow delivery. friends finds Claude sessions from their records in `~/.claude/sessions/`, and also lists a live `claude` process that has none (Claude Code writes no record for a `claude` started from a Claude Bash tool outside tmux, and loses it when the write fails, as on a full disk). It names that session from the transcript the process holds open, or else from the newest transcript in its folder written since it started, and shows it with RECEIVE `no*`: with no record there is no inbox socket on file. `friends resolve` then says the session is live but cannot receive. Codex lists a thread while a process holds its writer lock; `exec` runs never read the queue, and `codex queue` refuses an archived thread even while it is open.

Every message starts with a peer label ("not a user instruction or approval"). That label is not an enforced permission boundary: each agent applies its own session's permissions, and peer messages cannot grant user approval. Claude replies on its own. Codex follows its AGENTS.md: one that forbids acting for you without approval makes it wait for you, so pre-approve the one reply there ("a peer message sent through friends may be answered through its own reply route without asking"); with that line it replied unprompted in testing.

</details>

<details>
<summary>Updating and maintaining</summary>

Run `git pull` in the clone to update the CLI, and rerun the skill install commands to update the skills. There is no versioned release or build step. `bun test` covers targets, framing and the Claude inbox writes; after a change, repeat the exchanges above between throwaway sessions. Report failures in [GitHub issues](https://github.com/lucharo/friends/issues), including the CLI versions.

</details>

<details>
<summary>Has anyone built this on GitHub?</summary>

Related projects cover adjacent workflows:

| Project | Approach |
| --- | --- |
| [Dunqing/claude-codex-bridge](https://github.com/Dunqing/claude-codex-bridge) | Bidirectional MCP server. |
| [SeemSeam/claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge) | Terminal workspace with tmux panes. |
| [Jayden-X-L/claude-codex-bridge](https://github.com/Jayden-X-L/claude-codex-bridge) | Second-opinion review handoffs. |

Our search found no exact match for the native inbox-and-queue route; it was not exhaustive. The linked READMEs describe each project's approach.

Created 2026-10-06; updated 2026-11-10.

</details>

## Licence

[MIT](LICENSE)
