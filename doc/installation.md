# Installation

[Back to README](../README.md)

Requires Apple Silicon, macOS 15+, and Xcode 26+ with an iOS simulator runtime.
Both installation methods include private Node and Python runtimes.

## Brew install

Requires Homebrew:

```bash
brew install wei0121/tap/isimbot-mcp
```

## Manual install (local source)

```bash
git clone https://github.com/wei0121/iSimBot-mcp.git
cd iSimBot-mcp
./scripts/local-setup.sh
```

No global Node, Python or Homebrew is required. The script downloads dependencies
and builds the project. Keep the checkout available: the local launcher uses it.
Local runtimes, settings and companion connections are separate from the brew version.

## CLI config

Choose the command for your installation:

**Brew:**

```bash
isimbot setup
```

**Local** — run from the checkout:

```bash
./scripts/isimbot-local setup
```

Choose Claude Code or Codex, then restart the client. Setup adds `isimbot` for
brew or `isimbot-local` for local, preserving other MCP entries.

## Manual config

Use these instead of CLI setup. Merge the entry into your existing config and
restart the client. Replace `/path/to/iSimBot-mcp` with your checkout's absolute path.

### Brew version

**Claude Code** — `~/.claude.json`:

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

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.isimbot]
command = "/opt/homebrew/opt/isimbot-mcp/bin/isimbot"
args = []
```

For a different Homebrew prefix, find the command path with
`echo "$(brew --prefix isimbot-mcp)/bin/isimbot"`.

### Local version

**Claude Code** — `~/.claude.json`:

```json
{
  "mcpServers": {
    "isimbot-local": {
      "type": "stdio",
      "command": "/path/to/iSimBot-mcp/scripts/isimbot-local",
      "args": []
    }
  }
}
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.isimbot-local]
command = "/path/to/iSimBot-mcp/scripts/isimbot-local"
args = []
```

If configured, `CODEX_HOME` replaces `~/.codex`; `CLAUDE_CONFIG_DIR` replaces the
directory containing `.claude.json`.

## Check and maintain

| Task | Brew | Local (from checkout) |
| --- | --- | --- |
| Check setup | `isimbot doctor` | `./scripts/isimbot-local doctor` |
| Clear caches | `isimbot clean` | `./scripts/isimbot-local clean` |
| Update | `brew upgrade wei0121/tap/isimbot-mcp` | Update source, then `./scripts/local-setup.sh` |
| Rebuild after edits | — | `./scripts/local-npm run build` |
| Run tests | — | `./scripts/local-npm test` |

Restart the MCP client after updating or rebuilding. If you move the checkout,
update the local command path in your client config.

Uninstall brew with `brew uninstall isimbot-mcp`. To remove the local environment,
delete `.runtime/` from the checkout. Client config entries are removed separately.

`clean` removes managed screenshots and, for local installations, private download/npm
cache files. It preserves configuration, installed runtimes, recordings, observation
sessions, pending screenshots and custom files. Symbolic links are skipped. Local
and Homebrew installations clean only their own storage; global caches are untouched.

Continue with [MCP operations](mcp_operation.md).
