# friends 🤖 🤝 🤖

Native Cross Session Messaging Between Claude and Codex

`friends` lets your existing Claude Code and Codex conversations talk through native messaging. No MCP server or extra service.

Experimental; tested on macOS. Requires [Bun](https://bun.sh) and both CLIs on one machine.

## Install

In your project (Git needs access to this private repo):

```sh
bunx --bun skills add lucharo/friends \
  --skill message-claude \
  --agent codex
bunx --bun skills add lucharo/friends \
  --skill message-codex \
  --agent claude-code
```

## Try it

In Codex, use `/message-claude` to choose a Claude session, then ask:

```text
Send "Hello from Codex" to <session name>.
Ask for "Hello from Claude" back.
```

Look for `Hello from Claude` back in Codex; it may wait for the active turn to finish.

<details>
<summary>Skills and limits</summary>

| Skill | What it does |
| --- | --- |
| [/message-claude](skills/message-claude/SKILL.md) | Sends to a running Claude session and includes a Codex return address. |
| [/message-codex](skills/message-codex/SKILL.md) | Queues a message for a supplied Codex thread UUID. |

Claude's [native inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket) has no equivalent send command in its CLI, so `/message-claude` includes a small JavaScript sender. The return path uses `codex queue` directly.

Verified with Claude Code 2.1.281/2.1.283 and Codex CLI 0.160.1. Linux is untested; Windows and cloud-session routing are unsupported. The inbox wire format can change between versions; repeat the exchange after upgrading either CLI.

`written` and `queued` confirm submission, not receipt. Claude's inbound settings can hold or refuse a message. Use an open, inbox-enabled session; sessions started with `--bare` have no inbox.

Claude receives a peer envelope. Codex receives user-role text labelled as a peer message. That label is not an enforced permission boundary: each agent must apply its own session's permissions, and peer messages cannot grant user approval.

</details>

<details>
<summary>Updating and maintaining</summary>

The skills install from `main`; there is no versioned release or build step. Rerun the install commands to update. After editing a skill or its sender, install into a temporary project and repeat the exchange above. Report failures in [GitHub issues](https://github.com/lucharo/friends/issues), including both CLI versions.

</details>
