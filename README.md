# iSimBot-MCP

**Let your AI agent see and control your iOS Simulator.**

Tap, swipe, type, capture and more — through Claude Code, Codex, or any MCP client.

![iSimBot-MCP demo](doc/iSImBotDemo.gif)

## Installation

Requires Homebrew, Apple Silicon, macOS 15+, and Xcode 26+ with an iOS simulator runtime.

```bash
brew install wei0121/tap/isimbot-mcp
```

[Installation details](doc/installation.md)

## Usage

```bash
isimbot setup
```

Choose **Claude Code** or **Codex**, then restart the client.
Check dependencies and registration with:

```bash
isimbot doctor
```

Clear caches with:

```bash
isimbot clean
```

### Manual configuration

**Claude Code** — add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "isimbot": {
      "type": "stdio",
      "command": "/opt/homebrew/opt/isimbot-mcp/bin/isimbot",
      "args": []
    }
  }
}
```

**Codex** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.isimbot]
command = "/opt/homebrew/opt/isimbot-mcp/bin/isimbot"
args = []
```

Keep existing MCP entries and restart the client.

## Document

[MCP operations](doc/mcp_operation.md) · [Roadmap](doc/roadmap.md) · [Contribute](doc/contribute.md)

- [Server entry point](src/index.ts)
- [MCP server and request handlers](src/mcp/server.ts)
- [Tool registry](src/mcp/registry.ts)
- [Simulator operations](src/operation/)

MIT — see [LICENSE](LICENSE).
