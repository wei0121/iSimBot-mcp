# iSimBot-MCP changelog

## 1.0.6

- Add `open_url` for URLs and App deep links, and `list_apps` for installed apps. Both support device selection and operation chains.
- Add `start_recording`, `stop_recording` and `recording_status` for native-resolution H.264 MP4 recording while other operations continue.
- Support optional recording `path` and `maxDuration` (default 300 seconds). Record to temporary storage before transferring; never overwrite existing files and preserve a recovery path if transfer fails.
- Finalize recordings on normal server/device shutdown and stop chain-owned recordings when an operation chain fails.
- Clarify that optional chain `delay` waits after the previous operation completes (default 0.3 seconds; 0 means no delay), with guidance for animation screenshots.

### Compatibility notes

- Recordings are local files, not MCP image data, and are not automatically deleted. Force-killing the server can leave incomplete recordings.
- Restart your MCP client after upgrading to refresh tool definitions.

## 1.0.5

- Automatically connect when a device operation runs; remove the `connect_device` tool.
- Accept a short device ID, full UDID or unique device name in `deviceId`; report ambiguous names with matching devices.
- Return both short IDs and UDIDs from `list_devices` and capture device metadata. Short IDs last for the server session.
- Preserve per-device serial execution and parallel execution across devices.
- Publish releases automatically when a `release/vX.Y.Z` PR merges into `main`; Homebrew tap updates remain separate.

### Compatibility notes

- Pass `deviceId` directly to operations; no explicit connection step is needed. Simulators must already be booted, or be started with `boot_simulator`.
- Restart your MCP client after upgrading to refresh tool definitions.

## 1.0.4

- Add multi-device routing: serialize operations per device and run different devices concurrently.
- Add `capture` with logical-size images and accessibility elements; `screenshot` defaults to native pixel dimensions.
- Add screenshot-coordinate mapping and native simultaneous two-finger pinch gestures.
- Harden command execution with argument arrays, validation and bounded timeouts; wait for actual boot/process readiness.
- Add project-local runtime installation with isolated companion connections, preserving the Homebrew installation.
- Refresh installation, manual MCP configuration and operation documentation; correct project attribution.

### Compatibility notes

- Screenshot `scale` is replaced by `mode`: `logical`, `pixel` or `both`. The default image limit is now 5 MB per image.
- Screenshot metadata is returned in `structuredContent`; image data remains in `content`.
- With multiple connected devices, pass `deviceId` or a valid `screenshotId` where supported.
- Restart your MCP client after upgrading to refresh tool definitions.

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
