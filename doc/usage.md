# Usage

[Back to README](../README.md)

Run `isimbot setup`, choose Claude Code or Codex, and restart the client. Then ask:

> List my simulators, connect to iPhone 17, open my app, and take a screenshot.

Existing simulators can be started with `boot_simulator`. Apps must already be
built for the simulator; iSimBot-MCP does not build Xcode projects.
One server can connect to multiple simulators. Operations on the same device
run sequentially; different devices can run concurrently within this server.

## Multiple devices

Use `list_devices` to get UDIDs (`connected` indicates this server's connections),
then `connect_device {"deviceId": "<UDID>"}` for each device. Connecting another
device preserves existing connections. Start a stopped simulator with
`boot_simulator` before connecting. Lifecycle tools still accept legacy `udid`.

Pass `deviceId` to device operations, for example:

```json
{ "deviceId": "<UDID>", "mode": "logical" }
```

Without `deviceId`, a valid `screenshotId` determines the device; otherwise exactly
one device must be connected. With multiple connections, ambiguous requests fail
and list the connected IDs. Conflicting device and screenshot IDs are rejected.
Each operation chain binds one device and keeps its queue until all steps finish,
including delays. Other devices remain available. Separate MCP server processes
have independent queues. Screenshot settings and history retention remain shared.

## CLI

| Command | Purpose |
| --- | --- |
| `isimbot setup` | Register with an MCP client |
| `isimbot doctor` | Check dependencies and registration |
| `isimbot --version` | Show version |
| `isimbot --help` | Show help |

The MCP client starts the stdio server automatically; no separate HTTP service is needed.

## Tools

Optional parameters show their defaults. Durations and delays are in seconds.

| Tool | Required parameters | Optional parameters |
| --- | --- | --- |
| `list_devices` | — | — |
| `connect_device`, `boot_simulator`, `shutdown_simulator` | `deviceId` (or legacy `udid`) | — |
| `install_app` | `appPath` (simulator `.app`) | — |
| `launch_app`, `terminate_app`, `uninstall_app` | `bundleId` | — |
| `tap`, `double_tap` | `x`, `y` | — |
| `long_press` | `x`, `y` | `duration: 1` |
| `swipe` | `x1`, `y1`, `x2`, `y2` | `duration: 0.5` |
| `pinch` | `x`, `y` | `scale: 2`, `duration: 0.5`, `radius: 100` |
| `scroll` | `x1`, `y1`, `direction` | `distance: 200` |
| `press_button` | `button`: `home`, `lock`, `volumeUp`, `volumeDown` | — |
| `type_text` | `text` | — |
| `set_location` | `latitude`, `longitude` | — |
| `describe_ui` | — | — |
| `get_logs` | — | `lines: 100` |
| `screenshot` | — | `path`, `mode`, `format`, `quality`, `maxBytes` |
| `setup` | — | Screenshot settings below |
| `operation_chain` | `steps` | — |

`scroll.direction` is finger movement: `up`, `down`, `left`, or `right`.
Pass the `screenshotId` returned by `screenshot` to any coordinate gesture
(`tap`, `double_tap`, `long_press`, `swipe`, `scroll`, `pinch`). Coordinates then
use pixels of that returned image; MCP converts them to simulator points:

```json
{ "screenshotId": "<ID from screenshot>", "x": 360, "y": 900 }
```

Without `screenshotId`, gestures continue to use simulator points. With it,
scroll distance and pinch radius also use image pixels (defaults 200 and 100);
pinch scale is dimensionless and duration remains in seconds. Use the returned image size, not a resized chat preview.
IDs last 5 minutes, retain the newest 20 per device per server session, and are cleared for that device on
reconnect or shutdown. Recapture after rotation or navigation: IDs identify coordinate maps,
not live elements, and do not detect UI changes. Invalid references and coordinates
outside the image fail before the gesture. If idb cannot report screen scale,
`logical`/`both` fail explicitly; `pixel` still returns the image with
`deviceInfo.screenSize: null`, `deviceInfo.scale: null`, and no ID.

Gesture duration accepts 0.01–5 seconds. Invalid tool arguments are rejected
before execution; chains validate all steps before starting. Backend commands
use argument arrays with timeouts. A timeout does not guarantee the action stopped;
inspect the simulator before retrying.

Tools return text results; screenshots also return image data directly to the agent.
Failures set `isError`.

## Screenshot settings

MCP `setup` reads settings with `{}` or updates them, for example `{"mode": "logical"}`.
It is separate from the CLI setup command. Other saved settings are preserved. Legacy `scale` is ignored; the old 2 MB
default migrates to 5 MB when loading a legacy scale configuration. New requests
using screenshot `scale` are rejected.

For a single capture, pass overrides directly to `screenshot` (also inside chains):
`{"mode": "both", "format": "png"}`.
These do not persist. Size errors include actual bytes, limits, and suggested retry arguments.

| Setting | Default | Accepted values |
| --- | --- | --- |
| `mode` | `"logical"` | `"logical"`, `"pixel"`, `"both"` |
| `format` | `"png"` | `"png"`, `"jpeg"` |
| `quality` | `80` | `40`–`100`, JPEG only |
| `maxBytes` | `5000000` | `10000`–`5000000` per image, before Base64 encoding |
| `maxSavedImages` | `200` | Integer `1`–`10000` |

Logical images have one pixel per touch point; their coordinates work directly
with `tap` without an ID. Pixel images retain native resolution. `both` returns
logical then pixel images from one capture. `content` contains only image blocks;
`structuredContent` contains `{screenshotId, mode, imageSize, deviceInfo}` for a single image,
or `{images: [...]}` for both, in the same order as the images. `imageSize` is in pixels.
`deviceInfo` contains `deviceId` (UDID), `screenSize` (points) and `scale` (native screen pixels per
point, identical for logical and pixel images). `scale` is output information,
not a screenshot option. Example:

```json
{
  "screenshotId": "<image ID>",
  "mode": "logical",
  "imageSize": { "width": 402, "height": 874 },
  "deviceInfo": {
    "deviceId": "<UDID>",
    "screenSize": { "width": 402, "height": 874 },
    "scale": 3
  }
}
```

In chains, each screenshot's structured data is under
`structuredContent.steps[].result`; images follow step order.
Dimensions are never silently reduced;
images exceeding the byte budget fail (JPEG quality may be reduced to fit).
Processing is limited to 100 megapixels.

Settings live in `~/.config/isimbot/screenshot.json`; originals in
`~/.config/isimbot/screenshots/`. `ISIMBOT_CONFIG_DIR` overrides the base directory.
Oldest managed images are pruned to the limit, including when the limit is lowered.
Custom `path` files are excluded. Returned image data remains usable after file cleanup.

## Operation chains

Run actions and screenshots on one device in a single request:

```json
{
  "deviceId": "<UDID>",
  "steps": [
    { "tool": "screenshot", "delay": 0 },
    { "tool": "tap", "arguments": { "x": 196, "y": 400 } },
    { "tool": "screenshot", "delay": 0.3 }
  ]
}
```

`delay` defaults to **0.3 seconds after the previous step completes**; the first
step also waits unless set to `0`. Results and images arrive together.
A failure stops remaining steps and keeps completed results; actions are not rolled back.

Limits: 1–20 steps, 6 screenshots, 0–10 seconds per delay, 30 seconds total delay,
and 16 MB total Base64 image data (including both images in `both` mode). Chains cannot call `setup`, another chain, `list_devices`, or lifecycle tools.
Set `deviceId` on the chain, not individual steps. Same-device requests wait until
the chain finishes.

`pinch` uses native simultaneous two-finger input (`idb ui pinch`), supported by
the pinned idb 1.7.8 runtime. `scale > 1` spreads fingers; `scale < 1` brings them
together. `radius` is each finger's initial distance from the center. Keep the
whole gesture on-screen. App zoom limits may prevent visible changes; successful
input delivery does not guarantee a specific zoom level. Unsupported backends
return an error; no swipe approximation is used.
Boot waits for simulator boot completion (up to 120 seconds). App launch waits
for the target process to report Running (up to 10 seconds), foregrounding an
already-running app. This does not wait for UI/network
content to settle. Gestures do not perform HID reconnects or automatic retries;
inspect the screen after a failure before retrying an action.
