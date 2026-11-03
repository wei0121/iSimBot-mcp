# Installation

[Back to README](../README.md)

Requires Homebrew, Apple Silicon, macOS 15+, and Xcode 26+ with an iOS simulator runtime.
Node and Python are bundled privately; installing iSimBot does not upgrade your global runtimes.

## Homebrew

Install from our [Homebrew tap](https://github.com/wei0121/homebrew-tap):

```bash
brew install wei0121/tap/isimbot-mcp
isimbot setup
```

Choose your MCP client, then restart it.

## Local installation

From an Apple Silicon Mac with macOS 15+ and Xcode 26+, run:

```bash
./scripts/local-setup.sh
./scripts/isimbot-local setup
```

No global Node, Python, npm or Homebrew installation is needed. Setup downloads
checksum-verified runtimes and Python dependencies pinned in the formula template,
installs JS dependencies from the lockfile, and builds the current checkout.
Internet access is required on first installation; downloads are cached locally.

The launcher uses `.runtime/` for Node, Python, idb, companion, caches and local
screenshot settings/history. JS dependencies stay in `node_modules`; compiled code
in `dist`. These directories are ignored by Git. Nothing modifies shell profiles.
The first command only installs/builds; the second asks before registering
`isimbot-local` with your chosen MCP client. It preserves the release `isimbot`
entry. Restart the client and enable the version you want to test.

After editing source:

```bash
./scripts/local-npm run build
./scripts/local-npm test
```

Restart the MCP after rebuilding; there is no automatic reload. To check the
local environment, run `./scripts/isimbot-local doctor`. Re-run setup after
changing dependencies or moving the checkout. If the checkout moves, also update
the MCP launcher path; registration refuses to overwrite an existing entry. Keep
the checkout mounted when using this MCP. Remove `.runtime/` to remove the private environment; client
registration is separate. Brew installations are unaffected.

## Troubleshooting and removal

Run `isimbot doctor` to check dependencies and registration. If tools still show
old parameters, restart the client. Setup preserves unrelated MCP entries and
refuses to overwrite a conflicting `isimbot` entry.

```bash
brew uninstall isimbot-mcp
```

Uninstalling leaves client configuration and saved screenshots in place.

Local idb uses an installation-specific `/tmp/isbl-<uid>-<hash>` directory for
companion sockets, connection state and logs. It does not reuse Homebrew's
`/tmp/idb` companions. Reinstalling from an empty `.runtime` creates a new identity.
Both installations still control the same simulators: gestures, app state and
simulator shutdown affect that shared device. Use different devices when running
local and release sessions at the same time.
