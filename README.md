# friends 🤖 🤝 🤖

Native Cross Session Messaging Between Claude and Codex

Two skills for conversations you already have open. Codex posts to Claude Code's native inbox socket. Claude replies through `codex queue`, addressed to the same Codex thread. No MCP server or additional messaging service.

| Skill | Direction |
| --- | --- |
| [message-claude](skills/message-claude/SKILL.md) | Codex → a running Claude Code session |
| [message-codex](skills/message-codex/SKILL.md) | Claude Code → an existing Codex thread |

## Install

Requires Bun and both CLIs. From this checkout:

```sh
bunx --bun skills add . --skill message-claude --agent codex
bunx --bun skills add . --skill message-codex --agent claude-code
```

Then ask Codex to message a named Claude conversation. The skill supplies the return address so Claude can reply to that Codex thread.

<details>
<summary>Transport and compatibility</summary>

Same-machine messaging was verified on macOS with Claude Code 2.1.281/2.1.283 and Codex CLI 0.160.1. In that setup, a queued Claude reply automatically started the next Codex turn after the active turn finished.

On 6 October 2026, both skills were also installed as temporary project copies. The installed sender reached an existing Claude conversation; Claude read the installed return skill and queued its `NATIVE_SKILLS_ACK_20261006` reply to the originating Codex thread.

The helper uses JavaScript with no dependencies. It reads Claude's session registry and writes one newline-delimited JSON message to the selected Unix socket. It creates no sessions and changes no configuration. Native Windows named pipes and cloud-session routing are outside its scope.

Claude documents the [inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket), but its wire format is version-sensitive. Check `claude agents --help` and `codex queue --help`, and confirm an actual reply after upgrades.

**Provenance differs by receiver.** Claude receives a native peer envelope. Codex's queue receives user-role text, explicitly labelled as a Claude peer message; the label is not an enforced permission boundary. Each agent must apply its own conversation's permissions. Recipient inbound controls still apply.

`written` means the socket write completed. `queued` means Codex accepted the queued message. Neither alone proves that the receiving model read it.

</details>

## Development

```sh
bun test
```

The tests use temporary registries and sockets; they do not message your running agents.
