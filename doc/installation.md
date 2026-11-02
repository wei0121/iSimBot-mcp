# Installation

[Back to README](../README.md)

Requires Homebrew, Apple Silicon, macOS 15+, and Xcode 26+ with an iOS simulator runtime.
Homebrew installs the runtime dependencies.

## Homebrew

The public tap is not published yet. Once available, use the commands in
[Quick Start](../README.md#quick-start), then run `isimbot setup` and restart your MCP client.

## Local installation

From the repository, with Node.js 20.9+ and npm installed:

```bash
npm ci
npm run brew:prepare
brew tap-new local/isimbot # Skip if this tap already exists.
cp homebrew/isimbot-mcp.rb "$(brew --repository local/isimbot)/Formula/isimbot-mcp.rb"
brew tap facebook/fb
brew install local/isimbot/isimbot-mcp
isimbot setup
```

If Homebrew requires tap trust, run:

```bash
brew trust --formula facebook/fb/idb facebook/fb/idb-cli facebook/fb/idb-companion
```

After source changes or moving the checkout, regenerate and copy the formula,
then run `brew reinstall local/isimbot/isimbot-mcp`. Restart your MCP client.

## Troubleshooting and removal

Run `isimbot doctor` to check dependencies and registration. If tools still show
old parameters, restart the client. Setup preserves unrelated MCP entries and
refuses to overwrite a conflicting `isimbot` entry.

```bash
brew uninstall isimbot-mcp
```

Uninstalling leaves client configuration and saved screenshots in place.
