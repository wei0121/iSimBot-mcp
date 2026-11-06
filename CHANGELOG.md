# iSimBot-MCP changelog

## 1.0.11

- Round tap, long-press, double-tap and swipe coordinates at the idb CLI boundary, after screenshot and orientation conversion. The pinned CLI accepts integer coordinates; fractional element centers previously failed. Scroll uses the same corrected swipe path; pinch retains native floating-point precision.

## 1.0.10

- Unify observation and operation-chain responses as indexed events; return compact element changes by default, retain full raw snapshots, and add get_images for deferred retrieval of saved captures.
- Add native Chinese/Emoji input, cursor/selection insert, full-field replace and clear. Enable explicitly with launch_app enableTextInput:true or start_observation; preserve App validation and SwiftUI bindings without clipboard input.
- Observe standard text-field editing begin/change/end events with element information and Agent request IDs. Redact secure text and retain compatibility with protocol-v4 archives.
- Add device rotation with physical orientation readback, orientation-aware screenshots and gesture coordinates, and invalidation of old screenshot references.
- Add device_control with top-level deviceId plus action/payload: query settings, set system text size and appearance, rotate, send/list simulated notifications, and request a fixed location. Support operation chains with full payload preflight and configurable minimum intervals.
- Include device runtime/model in listings; list user-installed apps by default. Extend clean to completed chain images while preserving catalogs and active media.

### Compatibility notes

- Chain response steps becomes events; requests still use steps. Public events inherit timeline from the response root and use zero-based indexes. Capture events directly expose images, metadata and elements/elementCount; changes includes comparedToIndex.
- Chain capture images are saved references rather than inline images; retrieve them with get_images. Standalone capture still returns images and full accessibility elements immediately.
- Enhanced text input explicitly restarts the selected App. Standard UIKit/SwiftUI editors are supported; custom/web editors and active IME composition require separate handling.
- Simulator display normalization requires the bundled display reader and compatible Xcode display metadata. Physical orientation and system settings do not force an App to change its layout or theme.
- Notifications simulate device delivery, not the complete server/APNs path. Listing reads currently retained delivered notifications, not history; fixed location success reports request acceptance.
- Restart the MCP client after upgrading to load the new tools and behavior.

## 1.0.9

- Change the project license from MIT to Apache-2.0 and credit Weiren Xie in the attribution notice and package metadata.
- Include LICENSE and NOTICE in release packages and Homebrew installations; update README, contribution guidance and formula license metadata. Third-party licenses remain unchanged.
- Versions through 1.0.8 retain their original MIT license. No runtime behavior changes.

## 1.0.8

- Fix `double_tap` by sending both taps in one timed idb HID request. Separate CLI processes added startup/connection delays and could produce two single taps instead of a system-recognized double tap.
- Apply the same fix in operation chains. Observation continues to use UIKit tap counts, preserving independent single taps rather than merging them heuristically.
- Add a regression check for a single device-targeted multi-tap request and no fallback/retry after failure.

## 1.0.7

- Add experimental app observation with `start_observation`, `stop_observation` and `get_observation`: record taps, double taps, long presses, swipes and scrolls alongside logical captures and accessibility elements.
- Store sessions in `observing.json` and `observations.json`, with separate image files. Reading a running session stops and archives it; start/get also finalize expired sessions using `expireAt`. Each new observation creates a new session.
- Unify observation and operation-chain timeline records. Chain `delay` now measures between operation starts; allow captures during gestures, report conflicting operations, and provide configurable minimum intervals.
- Add `isimbot clean` for managed screenshots, completed recordings and archived observation images. Preserve active observation media, JSON records, configuration, installation/download caches and custom output paths.
- Build releases on macOS and bundle the simulator observation framework for Homebrew installations.

### Compatibility notes

- Chain `delay` is now start-to-start, rather than waiting after completion. Update existing chains accordingly; explicit intervals below configured minimums report an error.
- Observation is app-local and experimental: it restarts the app and does not record keyboard text, system dialogs, other apps or replay multitouch gestures. Older experimental observation schemas are not migrated.
- Restart your MCP client after upgrading to load the new tools.

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
