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
