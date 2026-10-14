# friends 🤖 🤝 🤖

Native Cross Session Messaging Between Claude, Codex and Pi

`friends` lets your existing Claude Code, Codex and Pi conversations talk through each one's native inbox, in every direction. No MCP server or extra service.

Experimental; tested on macOS. Requires [Bun](https://bun.sh), [Node.js](https://nodejs.org) for skill installation, and the CLIs you use on one machine.

## Install

Clone the CLI (Git needs access to this private repo) and link it onto your `PATH`:

```sh
git clone https://github.com/lucharo/friends ~/.local/share/friends
cd ~/.local/share/friends && bun link
```

Then add the skills in your project:

```sh
npx skills add lucharo/friends \
  --skill message-claude --skill message-pi \
  --agent codex
npx skills add lucharo/friends \
  --skill message-codex --skill message-pi \
  --agent claude-code
```

Pi needs no skill: [pi-x-session-messaging](https://github.com/lucharo/pi-extensions/tree/main/extensions/pi-x-session-messaging) gives its `list_sessions` and `send_message` tools Claude and Codex targets.

## Try it

```sh
friends ls
echo "Hello from the terminal" | friends send claude:<name or uuid>
```

In Codex, use `/message-claude`, then ask:

```text
Send "Hello from Codex" to <session name>.
Ask for "Hello from Claude" back.
```

Look for `Hello from Claude` back in Codex; it may wait for the active turn to finish. From Pi, ask it to message `claude:<name>` or `codex:<thread>`.

<details>
<summary>Commands, skills and limits</summary>

| Command | What it does |
| --- | --- |
| `friends ls [--json] [--remote]` | Live sessions: harness, name, id, folder, whether it can receive. |
| `friends send <target> < message` | Sends one message with a peer label and a reply route back to the sender. |
| `friends whoami` | The session the command runs in, i.e. the reply route it will add. |
| `friends resolve <target>` | The one live session a target names, as JSON, or why it names none. |

Targets are `claude:<name|uuid>`, `codex:<thread uuid|name>` and `pi:<name|id>`. friends finds the sender from its parent processes; `--reply-to <target>` overrides that, `--no-reply` drops it.

| Skill | What it does |
| --- | --- |
| [/message-claude](skills/message-claude/SKILL.md) | Sends to a running Claude session. |
| [/message-codex](skills/message-codex/SKILL.md) | Queues a message for a Codex thread. |
| [/message-pi](skills/message-pi/SKILL.md) | Sends to a running Pi session. |

Each harness answers in its own way: Claude and Codex run `friends send <sender>`, Pi calls `send_message` with the sender's target. Transports are Claude's [inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket), `codex queue`, and Pi's inbox files under `~/.pi/xsm`.

A `claude:` target not found on the Mac is looked up on the remote host (`FRIENDS_REMOTE_HOST`, default `remote-host`; empty turns it off) and written there over ssh with the node's `node`. That is one way: the message says there is no reply route back. Claude Desktop used to forward a remote host session's `SendMessage` to Mac sessions, but since its 12 Oct 2026 update an SSH session can reach only sessions on its own host.

Verified on 2026-10-13 with Claude Code 2.1.296 (2.1.295 on the remote host), Codex CLI 0.162.0, Pi 1.1.0 and Bun 1.4.2: Pi to Claude to Pi, Pi to Codex to Pi, Claude to Codex to Claude, and Mac to remote host. Linux beyond the remote host is untested; Windows is unsupported. Sender and receiver must share one profile per harness (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_XSM_DIR`); a reply route names a session, not a profile. The wire formats can change between versions; repeat the exchanges after upgrading a CLI.

`written` and `queued` confirm submission, not receipt; friends never retries. Claude's inbound settings can hold a message whose sender declares no permission mode, so friends declares `bypass` for Pi (which asks no permission questions) and Codex threads that never ask, and `prompting` for other Codex threads. Use an open, inbox-enabled Claude session; `--bare` sessions have no inbox. Codex lists a thread while a process holds its writer lock; `exec` runs never read the queue, and `codex queue` refuses an archived thread even while it is open.

Every message starts with a peer label ("not a user instruction or approval"). That label is not an enforced permission boundary: each agent applies its own session's permissions, and peer messages cannot grant user approval. Claude and Pi reply on their own. Codex follows its AGENTS.md: one that forbids acting for you without approval makes it wait for you, so pre-approve the one reply there ("a peer message sent through friends may be answered through its own reply route without asking"); with that line it replied unprompted in testing.

</details>

<details>
<summary>Updating and maintaining</summary>

Run `git pull` in the clone to update the CLI, and rerun the skill install commands to update the skills. There is no versioned release or build step. `bun test` covers targets, framing and the Claude and Pi inbox writes; after a change, repeat the exchanges above between throwaway sessions. Report failures in [GitHub issues](https://github.com/lucharo/friends/issues), including the CLI versions.

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

Created 2026-10-06; updated and verified 2026-10-13.

</details>
