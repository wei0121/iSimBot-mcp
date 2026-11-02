# iSimBot-MCP changelog

## 1.0.3

- Fix app launch targeting when multiple simulators are connected.
- Default screenshots to 0.6x and 2 MB; preserve existing saved settings.
- Allow per-call screenshot overrides, including in operation chains, with actionable size errors.

## 1.0.2

### Changed

- Homebrew bundles trimmed private Node and Python runtimes without upgrading global runtimes.

- Project and MCP server display name: **iSimBot-MCP**.

- npm package and Homebrew formula: `isimbot-mcp`.

- CLI remains `isimbot`; MCP registration key and settings directory stay unchanged.

- `operation_chain` uses `delay` instead of `delayBefore`, defaulting to 0.3 seconds
  after the previous operation completes. The first step also waits by default;
  explicit `delay: 0` skips waiting.

- Updated installation, scope, migration, and release documentation.

### Current capabilities

- 22 MCP tools covering devices, apps, gestures, input, inspection, location,
  screenshot settings, and sequential operation chains.

- CLI commands: `--version`, `--help`, `doctor`, and interactive `setup` for
  Claude Code or Codex. No `clear` or `status` commands.

- Screenshots return MCP image data with native-resolution scaling, PNG/JPEG
  output, byte limits, and managed retention (default 200 images).

- Local Homebrew packaging includes compiled JavaScript and locked dependencies.

Existing installations require an update and MCP client restart.
