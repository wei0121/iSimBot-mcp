# iSimBot-MCP

Let Claude Code, Codex, and other MCP clients operate your iOS Simulator:
tap, swipe, type, inspect screens, and run operation chains with screenshots.

**CLI:** `isimbot` · **Package:** `isimbot-mcp`

Build your app with Xcode first; iSimBot-MCP installs and interacts with the built app.

<!-- Add the demo GIF here when ready. -->

## Quick Start

Requires Homebrew, Apple Silicon, macOS 15+, and Xcode 26+ with an iOS simulator runtime.

> The public Homebrew formula is not yet available. The installation commands
> below will work once it is published in this repository.

```bash
brew tap wei0121/isimbot-mcp https://github.com/wei0121/iSimBot-mcp.git
brew install wei0121/isimbot-mcp/isimbot-mcp
isimbot setup
```

Choose **Claude Code** or **Codex**, then restart the client. Try:

> List my simulators, connect to iPhone 17, and take a screenshot.

- [Installation](doc/installation.md)

- [Usage](doc/usage.md)

- [Roadmap](doc/roadmap.md)

- [Contribute](doc/contribute.md)

MIT — see [LICENSE](LICENSE).
