# iSimBot-MCP changelog

## Unreleased

### Changed

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

The package version remains 1.0.0. These are local source changes, not a claim
that a public release has been published. Existing installations require a
separate update and MCP client restart.
