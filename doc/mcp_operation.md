# MCP Operations

[Back to README](../README.md) · [Installation and config](installation.md)

Control existing simulators and apps; iSimBot does not build Xcode projects.

## Devices

| Operation | Description |
| --- | --- |
| `list_devices` | List available devices and their boot state. |
| `boot_simulator` | Start a simulator and wait for boot completion. |
| `shutdown_simulator` | Shut down a simulator. |

Device listings include an 8-character `deviceId` and the full `udid`.
The operation's `deviceId` field accepts either ID or the exact device name.
Duplicate names are rejected; use a short ID or UDID to disambiguate.
For example: `capture {"deviceId": "iPhone 18 Pro"}`; MCP connects automatically
and reuses the connection. Boot a stopped simulator with `boot_simulator` first.
Short IDs remain stable within one MCP session; after restarting, call
`list_devices` again or use the full UDID. Screenshot `deviceInfo` includes both IDs. Operations on the same
device run sequentially; different devices can run concurrently.

## Apps

| Operation | Description |
| --- | --- |
| `list_apps` | List installed apps with bundle ID, name, install type and process state. |
| `open_url` | Open a URL or App deep link on the selected device; inspect the destination with `capture`. |
| `install_app` | Install a simulator `.app` from a local path. |
| `launch_app` | Launch or foreground an app by bundle ID. |
| `terminate_app` | Stop an app by bundle ID. |
| `uninstall_app` | Remove an app by bundle ID. |

## Gestures and input

| Operation | Description |
| --- | --- |
| `tap` | Tap a coordinate once. |
| `double_tap` | Double-tap a coordinate. |
| `long_press` | Hold a coordinate; default duration is 1 second. |
| `swipe` | Swipe between two coordinates. |
| `scroll` | Move a finger from a start point in the specified direction. |
| `pinch` | Perform a simultaneous two-finger pinch around a center point. |
| `press_button` | Press Home, Lock, Volume Up or Volume Down. |
| `type_text` | Enter text into the focused field. |
| `set_location` | Set the simulated GPS latitude and longitude. |

Coordinates use logical points. Pass `screenshotId` when using image-pixel
coordinates to let MCP convert them automatically.

## Screen and inspection

| Operation | Description |
| --- | --- |
| `screenshot` | Return an image and metadata; defaults to original pixel dimensions. |
| `capture` | Return images and accessibility elements; defaults to logical dimensions. |
| `describe_ui` | Return the current accessibility tree. |
| `get_logs` | Read device logs. |

`capture` elements include labels, identifiers, bounds and center coordinates.
Their coordinates always use logical points: pass the center directly to `tap`
without `screenshotId`. Accessibility may not expose every visible element.

## Settings and sequences

| Operation | Description |
| --- | --- |
| `setup` | Read or update image settings and screenshot retention; separate from CLI setup. |
| `operation_chain` | Run a sequence of actions and captures on one device, returning results together. |

Chain `delay` is the wait after the previous operation completes, before the current
operation. It is optional, defaults to 0.3 seconds, and 0 means no delay.

To inspect animations, follow an action with consecutive `screenshot` steps using
`delay: 0.1`. Screenshot processing time is additional.

A failed step stops the remaining steps. Each chain allows up to 20 steps and
6 combined `screenshot`/`capture` calls.

## Recording

| Operation | Description |
| --- | --- |
| `start_recording` | Start background recording on a device. Optional `maxDuration`: 1–3600 seconds, default 300; `path`: absolute `.mp4` destination. |
| `stop_recording` | Stop and wait for the MP4 file to finish saving. |
| `recording_status` | Read active or last recording status, including auto-stop and failures. |

Recordings use native resolution and H.264 MP4. Each device can record once at a
time while other operations continue. Omit `path` to save under `recordings` beside
the current configuration file, or supply an absolute `.mp4` file path. Missing
parent directories are created; existing files are never overwritten. Recordings
are not automatically deleted. Results include
`path`, `sizeBytes` and elapsed `durationSeconds` (not decoded media duration).
The path is local to the MCP host; video is not returned as image data. Recording
uses a temporary file first, then transfers it to the recording directory. If the
transfer fails, `recoveryPath` points to the preserved temporary video.

All three tools work in `operation_chain`. If a chain fails, a recording started
by that chain is stopped and its file result appears in `recordingCleanup`.
A successful chain can leave recording active until a later stop or auto-stop.
Normal server shutdown and `shutdown_simulator` attempt to finalize recordings.
Force-killing the server or shutting down a simulator externally can leave an
incomplete file. Recording status is kept only for the current server session.

## App observation (experimental, local builds)

| Operation | Description |
| --- | --- |
| `start_observation` | Restart an installed app with the recorder. Requires `bundleId`; optional `maxDuration` (default 300 seconds) and `captureInterval` (default 0.5 seconds). |
| `stop_observation` | Stop collecting; leave the app running. |
| `get_observation` | Read a `sessionId`; paginate with `offset` / `limit`. `includeImages: true` returns up to two images per page. |

Build the native recorder with `./scripts/local-npm run build:observation`.
New local installations build it automatically. The release pipeline does not
package this experimental native component yet.

The recorder loads into the selected app at launch; no app source changes,
macOS input monitoring, or Bonjour discovery are used. It observes both human
and automated touches. Keyboard text actions, system dialogs, other apps and
multi-touch replay are not supported. Multi-touch/cancelled/incomplete gestures
are retained as unsupported records instead of guessed commands.

Capture uses logical size and elements. Before the first touch, only the latest
two captures are retained; afterwards captures continue at the target interval,
without overlapping reads. Actual start/end timestamps are returned because
capture may take longer than the interval. Stop limits: 200 retained captures,
100 MB capture data, 16 MB event data, or `maxDuration`. Sessions are saved under
`observations` beside the configuration file and are not automatically deleted.

Each page includes candidate `operationChain` steps for that page. Touch paths
and timing are preserved, but straight swipes approximate curved gestures and
taps do not reproduce the original hold duration. `replayable` checks command
limits, not whether replay will have the same UI result. Historical screenshot
IDs are not live coordinate references. Normal MCP shutdown stops collection;
a crashed server's recording lease expires after 10 seconds. A normal app
relaunch removes the injected framework.

The handshake confirms recorder loading, not UI readiness; inspect capture or
accessibility before sending test actions.

Each session stores one `session.json` with an `events` array. Every event and
the protocol-v2 handshake carry `sessionId`. Events use `tap`, `double_tap`, `long_press`,
`scroll`, `swipe`, `capture` or `unsupported`; `time` and `duration` are seconds relative
to session start. Absolute capture/operation start and end timestamps remain
available for alignment. Native touch samples use an atomic JSON snapshot in
the app's temporary directory, removed after successful finalization.
`captureInterval` is independent per session (0.5–10 seconds, default 0.5).

Double taps require UIKit `tapCount == 2`, a preceding tap within 0.5 seconds
and a separation of at most 20 logical points. Nearby independent taps remain
separate. Movement in an enabled ancestor `UIScrollView` whose pan recognizer
actively handles the gesture is `scroll`; other movement is `swipe`. Custom
scrolling implementations without a `UIScrollView` fall back to `swipe`. Scroll
direction describes finger movement; replay uses its dominant axis and backend
default duration. Raw paths/timing remain available.
