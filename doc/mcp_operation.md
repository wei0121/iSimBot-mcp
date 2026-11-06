# MCP Operations

[Back to README](../README.md) · [Installation and config](installation.md)

Control existing simulators and apps; iSimBot does not build Xcode projects.

## Devices

| Operation | Description |
| --- | --- |
| `list_devices` | List devices, boot state, `runtime` (for example, `iOS 27.0`) and `model` (for example, `iPhone 18 Pro`). Unknown values are `null`. Entries without a UDID are omitted. |
| `boot_simulator` | Start a simulator and wait for boot completion. |
| `shutdown_simulator` | Shut down a simulator. |
| `rotate` | Set `orientation`: `portrait`, `portrait_upside_down`, `landscape_left`, or `landscape_right`. Confirms physical orientation; apps may lock their interface. |

Device listings include an 8-character `deviceId` and the full `udid`.
`name` is the editable device name; `model` resolves the actual simulator type by UDID.
The operation's `deviceId` field accepts either ID or the exact device name.
Duplicate names are rejected; use a short ID or UDID to disambiguate.
For example: `capture {"deviceId": "iPhone 18 Pro"}`; MCP connects automatically
and reuses the connection. Boot a stopped simulator with `boot_simulator` first.
Short IDs remain stable within one MCP session; after restarting, call
`list_devices` again or use the full UDID. Screenshot `deviceInfo` includes both IDs. Operations on the same
device run sequentially; different devices can run concurrently. Inside an operation
chain, image operations may overlap a running gesture.

`rotate {"orientation":"landscape_left","deviceId":"iPhone 18 Pro"}` sets an
absolute physical orientation (device top pointing left), not a relative turn.
It works in operation chains and reads back the physical orientation. App rotation
support and animations are separate: use a fresh capture after rotating. Old
screenshot references and captures overlapping rotation cannot be used for
coordinate mapping. Rejected/unsupported rotations return an error, without a
GUI or app-injection fallback. Chain minimum start interval defaults to 1 second
for rotate and can be adjusted with `setup.minDelay.rotate`.

Simulator images are losslessly turned to the current foreground interface
orientation before logical/pixel output, without reducing native resolution.
Logical touch points use interface coordinates. MCP reads the Simulator display
rotation through Xcode `devicectl` and converts interface points into the display
axes expected by idb; idb then performs its native HID conversion. This also
handles a portrait app in a sideways Simulator window. App-locked
interfaces use their actual orientation, not a guess from physical orientation.
A bundled simulator display reader uses a system private API; unavailable or
changing orientation returns an actionable error rather than guessed coordinates.
Local native builds include this reader via `build:observation`. Explicit image
paths keep the backend PNG; returned images follow the interface orientation.

## Device control

`device_control` uses the common top-level `deviceId`, plus `action` and `payload`:

```json
{"deviceId":"iPhone 18 Pro","action":"set_text_size","payload":{"size":"extra-large"}}
```

| Action | Payload |
| --- | --- |
| `get_settings` | `{}` — reads appearance, textSize and physical orientation independently |
| `set_text_size` | `{"size":"extra-large"}` — standard or accessibility Dynamic Type category |
| `rotate` | `{"orientation":"landscape_left"}` — same implementation as `rotate` |
| `set_appearance` | `{"appearance":"dark"}` — `light` or `dark` |
| `send_notification` | `{"bundleId":"com.example.app","notification":{"aps":{"alert":"Hello"}}}` |
| `list_notifications` | `{"bundleId":"com.example.app","offset":0,"limit":100}` — offset/limit optional |
| `set_location` | `{"latitude":48.137,"longitude":11.575}` — fixed position only |

Payload fields belong only to their selected action. Unknown fields, nested
`deviceId`, invalid ranges and notification JSON over 4096 UTF-8 bytes fail
before a chain starts. In chains, put `deviceId` on the chain and use
`{"tool":"device_control","arguments":{"action":"set_appearance","payload":{"appearance":"dark"}}}`.
Default minimum start interval is 1 second, configurable with
`setup.minDelay.device_control`; rotate/location aliases also honor their existing minima.

Setting changes read back system state; apps can override appearance or ignore
Dynamic Type. Physical rotation does not guarantee interface rotation/readiness.
`get_settings` returns null/error for unreadable fields and `partial:true`;
`capabilities` describes current read availability, while `actions` lists the
MCP action contracts, not a guarantee of runtime support. Location is not read
back; success means the request was accepted, not an app location callback.

Notification send simulates delivery, without testing the APNs server path.
Permissions and foreground handling determine presentation. Listing returns
currently retained delivered notifications, newest first, not complete history
or a live stream; no app launch is performed. `deliveredAt` uses Unix seconds
(or null). Pagination defaults/maxes to 100 and may shift as notifications arrive
or disappear. Notifications are not saved in iSimBot command history.
Existing `rotate`, `set_location` and `open_url` remain available.

## Apps

| Operation | Description |
| --- | --- |
| `list_apps` | List user-installed apps by default, with bundle ID, name, install type and process state. Use `installType: "all"` for all apps or `"system"` for system apps. |
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
| `type_text` | Insert at the cursor/selection (default), or use `mode: "replace"` for the whole focused field. Empty replace clears it. |
| `set_location` | Set the simulated GPS latitude and longitude. |

Coordinates use logical points. Pass `screenshotId` when using image-pixel
coordinates to let MCP convert them automatically.

### Native text input

For Chinese, Emoji, replace and clear, explicitly restart the app with
`launch_app {"bundleId":"com.example.app","enableTextInput":true}` (or start
an observation), then focus a text field. `type_text` also works in chains:

```json
{"text":"你好 🙂","mode":"replace"}
```

Standard UIKit text fields/views and SwiftUI TextField/TextEditor are supported.
Input uses the app's native editing pipeline, preserving validation and bindings;
plain apps retain ASCII insert via idb. No clipboard or additional permissions.
Custom/web editors are unsupported. Active IME composition must finish first.
Native success checks immediate field text, not later business/network validation.
Rejected/transformed input returns actual field state; timeouts may have applied,
so inspect before retrying. Password text is redacted; lengths use UTF-16 units.
Native input stays enabled after Observe stops, until ordinary relaunch or MCP shutdown.

## Screen and inspection

| Operation | Description |
| --- | --- |
| `screenshot` | Return an image and metadata; defaults to original pixel dimensions. |
| `capture` | Return images and accessibility elements; defaults to logical dimensions. |
| `describe_ui` | Save the full accessibility tree as local JSON; return up to 50 compact elements by default. Use `snapshotId`, `offset` and `limit` to paginate the same snapshot. `detail: "number"` returns a count; `"raw"` explicitly returns the JSON tree (up to 256 KiB). |
| `get_logs` | Read simulator unified logs, not MCP logs or Observe records. Defaults: `lastSeconds: 30`, `lines: 100`; optional `process` is an executable name or PID. Not a live stream or guaranteed stdout/stderr capture. |

`capture` elements include labels, identifiers, bounds and center coordinates.
Their coordinates always use logical points: pass the center directly to `tap`
without `screenshotId`. Accessibility may not expose every visible element.

## Settings and sequences

| Operation | Description |
| --- | --- |
| `setup` | Read or update image settings and screenshot retention; separate from CLI setup. |
| `operation_chain` | Run a sequence of actions and captures on one device, returning results together. |

Observation events and chain results share this shape:

```json
{"timeline":"chain_a7k2m9x4","index":0,"tool":"swipe","arguments":{"x1":170,"y1":650,"x2":170,"y2":400,"duration":0.5},"time":1,"delay":1,"duration":0.65}
```

`timeline` is `session_xxxxxxxx` or `chain_xxxxxxxx`. All timing uses seconds:
`time` is this operation's start relative to timeline start, `delay` is this start
minus the previous start (first delay is from timeline start), and `duration` is
this operation's own elapsed time. Duration never adds to delay. Chain duration
measures tool execution; observed gesture duration measures the touch interval.
`arguments.duration` remains the requested gesture duration when supported.

For starts `[0, 1, 5, 6]` and durations `[1, 2, 3, 2]`, delays are `[0, 1, 4, 1]`.
Operation three can still be running when operation four starts.

Chain requests require only `tool`; `arguments` defaults to `{}` and `delay` to
0.3 seconds. Optional source `time` must agree with cumulative delays. Execution
assigns a fresh chain timeline and measures actual start times/durations. If the
backend or event loop is late, actual starts may be later than requested.

`capture`/`screenshot` can run during gestures and alongside other images. Overlapping
non-image commands fail with `OPERATION_TIME_CONFLICT` instead of being delayed.
To inspect motion, follow a gesture with image steps at `delay: 0.1`.
On failure, no further steps are launched; already started operations finish.
Each chain allows up to 20 steps, 6 image calls, 0–10 seconds per delay and 30
seconds total delay. Whole-chain device queue ownership is preserved.

Top-level `elementDetail` uses the same `number` / `list` / `changes` presentation
as `get_observation`, defaulting to `changes`. It affects capture step results
only. Each capture compares with the previous capture in the same chain by
`index`, regardless of completion order; intervening screenshot/gesture steps do
not reset the baseline. First capture marks all elements appeared. Changes include
`comparedToIndex`. Capture images are saved locally and returned as references;
screenshot steps continue to return image content. Image metadata and execution timing are preserved;
the option adds no captures or waits. Full snapshots are used internally for
comparison, rather than previously reduced change lists.

Configure per-tool minimum start intervals with MCP `setup`:

```json
{"minDelay":{"tap":0.4,"double_tap":0.9,"long_press":1.35,"swipe":0.9,"scroll":0.7,"pinch":0.8}}
```

These defaults reflect local simulator measurements, not guarantees under all loads.
Partial updates merge and `setup {}` reads them back.
Values are 0–10 seconds. A minimum belongs to the previous non-image tool;
intervening captures count toward the elapsed interval but do not reset it.
Images remain exempt. Long press, swipe and pinch also require their requested
(or default) duration plus 0.2 seconds. Omitted delays are increased as needed;
explicit insufficient delays fail with `MIN_OPERATION_DELAY` before any action.
Actual backend work can take longer, so runtime conflict detection remains.
Observation timestamps are recorded as observed and are not constrained by chain execution limits.

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

## App observation (experimental)

| Operation | Description |
| --- | --- |
| `start_observation` | Restart an installed app with the recorder. Requires `bundleId`; optional `maxDuration` (default 300 seconds) and `captureInterval` (default 0.5 seconds). |
| `stop_observation` | Stop collecting; leave the app running. |
| `get_images` | Read saved images by `timeline` and `indexes` (1–6 unique event indexes). No simulator connection needed. |
| `get_observation` | Read a session `timeline`; paginate with `offset` / `limit` (default and maximum 100 events). `elementDetail` defaults to `"changes"`; `"number"` returns counts and `"list"` returns compact elements. `includeImages: true` returns up to two images per page. |

Homebrew releases include the native recorder. New local installations build it
automatically; rebuild it after native edits with
`./scripts/local-npm run build:observation`.

The recorder loads into the selected app at launch; no app source changes,
macOS input monitoring, or Bonjour discovery are used. It observes both human
and automated touches, plus standard text-field editing notifications. System
dialogs, other apps and raw keyboard keys are not observed; multi-touch is not classified. Multi-touch/cancelled/incomplete gestures
are retained as unsupported records instead of guessed commands.

Capture uses logical size and elements. Before the first touch or editing event, only the latest
two captures are retained; afterwards captures continue at the target interval,
without overlapping reads. Returned timing describes actual capture execution, which may take longer
than the interval. Stop limits: 200 retained captures,
100 MB capture data, 16 MB event data, or `maxDuration`. Sessions are saved under
`observations` beside the configuration file and are not automatically deleted.

Observation returns recorded events, not a replayable operation chain. Historical
screenshot IDs are not live coordinate references. Normal MCP shutdown stops
collection; a crashed server's recording lease expires after 10 seconds. A normal
app relaunch removes the injected framework.

The handshake confirms recorder loading, not UI readiness; inspect capture or
accessibility before sending test actions.

`observations/observing.json` and `observations/observations.json` each contain a
root JSON array of session objects. Active sessions are updated in the first;
stopped/automatically ended sessions are archived in the second. Session objects
retain their `timeline`, device/app metadata and `events` array. Capture images are separate files in `observations/images/`, named
`session_xxxxxxxx-capture-000000-0.png` (or `.jpeg`). Events store image paths,
metadata and elements, without Base64. Images are read when `includeImages` is
requested; missing files are reported per event. There are no per-session or
per-capture JSON files. Events are sorted stably by `time`. Updates parse the
JSON into objects, merge under a cross-process lock, then serialize and atomically
replace the file. File membership indicates state; session objects have no `active` field.
Archive writes complete before observing entries are removed. Ended sessions cannot
resume or change; every start creates a new timeline. `get_observation` stops and
archives a running session before returning its records. Each session stores
`expireAt` (Unix milliseconds): start time plus `maxDuration`. Every start/get
checks all observing sessions and stops/archives expired ones, including saved
sessions left by an earlier MCP process. If final native reads fail, saved data
is archived with an error rather than discarded.
If a process is killed while holding the storage lock, the abandoned `.lock`
needs removal after confirming its owner exited; requests fail safely meanwhile.

Every observation event and chain step has a zero-based `index` in its timeline.
Observation indexes follow chronological event order across gestures and captures;
chain indexes follow request order, regardless of concurrent completion order.
`timeline` + `index` identifies an event; `time` remains its elapsed start time.
Pagination never restarts numbering. Observing snapshots may be renumbered while
late touch events arrive; indexes are fixed after stop/archive. Old archives are
indexed when returned without rewriting the stored data. Internal capture file
counters are separate and do not determine public event indexes.
Optional source indexes in chain requests are metadata; a new execution assigns
fresh indexes from zero. Chain results use `index` instead of the old one-based
`step` field.

Editing events contain `arguments.target` (identifier when available, type and
logical frame), `text`, `textLength`, `redacted`, `composing` and `source`.
Synchronous Agent input notifications include its `requestId`; other notifications
use `app_or_user`, which does not prove human input. Secure fields omit text.
These instantaneous events have duration 0; focus/blur do not prove typing, and
there is no reliable "finished typing" event while a user pauses with focus.
Editing events describe recorded changes; they are not converted into text commands. Other apps, system keyboards/dialogs and web/custom
editors remain outside observation scope.

Every session has an `events` array. Internally saved events and
the protocol-v5 handshake (v4 archives remain readable) carry `timeline`; public events inherit it from the
response root. Events use `tool` values `tap`,
`double_tap`, `long_press`, `scroll`, `swipe`, `capture`, `editing_begin`,
`text_change`, `editing_end` or `unsupported`, with
`arguments`, `time`, `delay` and `duration` matching the common operation model. Native touch samples use an atomic JSON snapshot in
the app's temporary directory, removed after successful finalization.
`captureInterval` is independent per session (0.5–10 seconds, default 0.5).

`get_observation` changes only the returned presentation. Captures continue at the
configured interval and saved JSON retains complete accessibility snapshots.
Compact elements contain `elementId`, `type`, `text` and logical `frame`; `text`
combines distinct label/title/value strings. Changes add `changeTypes` containing
`appeared`, `moved` (position or size), `disappeared` or `updated` (content/state).
Comparison uses the preceding capture in the same session, including before a
page boundary; `comparedToIndex` identifies its event index. First capture
marks all elements appeared. Disappeared elements retain their previous data.
Unique identifiers match across captures; absent/duplicate IDs match only when
unchanged, otherwise report removal/addition. No pixel comparison is performed.
Unavailable accessibility snapshots produce `elements: null` with an event-level
`error`, not false disappearance events. Use `list` to inspect a valid
current snapshot when its baseline is unavailable.


The `double_tap` tool sends both taps in one timed idb request, avoiding CLI
startup delays between touches. Observation double taps require UIKit `tapCount == 2`, a preceding tap within 0.5 seconds
and a separation of at most 20 logical points. Nearby independent taps remain
separate. Movement in an enabled ancestor `UIScrollView` whose pan recognizer
actively handles the gesture is `scroll`; other movement is `swipe`. Custom
scrolling implementations without a `UIScrollView` fall back to `swipe`. Scroll
direction describes finger movement. Raw paths and timing remain available. Existing experimental UUID/sessionId records
use the older schema and are not read by the new timeline API.

## Timeline images and return format

Observation and chain responses use top-level `timeline` and `events`. Public
events have `index`, `tool`, `arguments`, `time`, `delay` and `duration`, without
repeating `timeline`. Chain requests still use `steps`. Capture events directly
contain `images` (file references), `metadata` (image/device information), and
`elements` or `elementCount`, without a `result` wrapper. `changes` additionally
returns `comparedToIndex`; no comparison object or availability flag is used.

Standalone `capture` still immediately returns MCP image content and complete
original accessibility fields, without an elementDetail option. Chain captures
and observation captures save processed PNG/JPEG images under `chains/images/`
and `observations/images/` beside the configuration file. Chain capture indexes,
times and full raw metadata persist in `chains/captures.json`; other chain
commands are not logged. Ordinary screenshot retention does not delete these
files. Existing observation JSON keeps its complete original snapshots.

Use `get_images {"timeline":"chain_1234abcd","indexes":[0,2]}` to retrieve selected
images after completion, including after an MCP restart. Captures in both mode
return logical and pixel images in that order. A batch returns at most six images
and 16 MB Base64; missing/cleaned images and indexes exceeding the budget report
per-index errors while other indexes continue. No arbitrary paths are accepted.
Historical images do not provide fresh coordinate references. `isimbot clean`
removes completed chain images as well as archived observation images, preserving
catalogs, active/uncataloged images, configuration and custom output paths.


`describe_ui` snapshots are saved under `ui/` beside the configuration file.
Only the latest 200 are retained; `isimbot clean` removes these snapshots along
with recorded media. `snapshotId` reads a saved snapshot, not the current screen.

Element `changes` first matches unique identifiers, then exact snapshots. Elements
without stable IDs can be reported as `moved` when their nonempty content, type
and size match uniquely in both snapshots. Repeated/ambiguous elements remain
appearance/disappearance pairs. This is a presentation heuristic, not a stable
identity guarantee; raw saved captures are unchanged.

Enhanced text input supports standard UIKit/SwiftUI editors and a Search Bar's
underlying `UISearchTextField`. A keyboard on screen alone does not prove the
focused editor is supported. Input errors include the responder class, target
identifier and ancestor classes to help diagnose unsupported/custom editors.
No failed text input is automatically retried.

Display geometry timeouts receive one read-only retry (at most two attempts;
up to 20 seconds when both interface and display reads are required). Invalid
geometry is not retried or guessed. Gesture and text commands are not repeated.

If a client omits `enableTextInput`, `installType` or `elementDetail`, check its
connected server version and refresh its MCP tool list. These parameters are
published by the server; restarting a different server process does not refresh
another client's cached definitions.

`launch_app` checks installation first in both ordinary and enhanced-input modes.
A missing app returns `APP_NOT_INSTALLED`; launch failures return concise error
codes rather than raw system output.

`terminate_app` checks the simulator's actual launchd App process and waits up to
5 seconds after one termination request. Already-stopped apps are a confirmed
no-op. Failed process queries remain `confirmed: false`, `terminated: null`;
a process still running at the deadline returns `APP_STILL_RUNNING`.
