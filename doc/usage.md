# Usage

[Back to README](../README.md)

Run `isimbot setup`, choose Claude Code or Codex, and restart the client. Then ask:

> List my simulators, connect to iPhone 17, open my app, and take a screenshot.

Existing simulators can be started with `boot_simulator`. Apps must already be
built for the simulator; iSimBot-MCP does not build Xcode projects.
One server selects one device at a time; concurrent device switching is not supported.

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
| `connect_device`, `boot_simulator`, `shutdown_simulator` | `udid` | — |
| `install_app` | `appPath` (simulator `.app`) | — |
| `launch_app`, `terminate_app`, `uninstall_app` | `bundleId` | — |
| `tap`, `double_tap` | `x`, `y` | — |
| `long_press` | `x`, `y` | `duration: 1` |
| `swipe` | `x1`, `y1`, `x2`, `y2` | `duration: 0.5` |
| `scroll` | `x1`, `y1`, `direction` | `distance: 200` |
| `pinch` | `x`, `y` | `scale: 2`, `duration: 0.5` |
| `press_button` | `button`: `home`, `lock`, `volumeUp`, `volumeDown` | — |
| `type_text` | `text` | — |
| `set_location` | `latitude`, `longitude` | — |
| `describe_ui` | — | — |
| `get_logs` | — | `lines: 100` |
| `screenshot` | — | `path` (otherwise managed automatically) |
| `setup` | — | Screenshot settings below |
| `operation_chain` | `steps` | — |

`scroll.direction` is finger movement: `up`, `down`, `left`, or `right`.
`pinch` currently approximates the gesture with sequential single-finger swipes.
Screenshot pixels are not necessarily simulator touch coordinates.

Tools return text results; screenshots also return image data directly to the agent.
Failures set `isError`.

## Screenshot settings

MCP `setup` reads settings with `{}` or updates them, for example `{"scale": 0.5}`.
It is separate from the CLI setup command.

| Setting | Default | Accepted values |
| --- | --- | --- |
| `scale` | `1` | `0.1`–`4`, relative to native device pixels, independent of window size |
| `format` | `"png"` | `"png"`, `"jpeg"` |
| `quality` | `80` | `40`–`100`, JPEG only |
| `maxBytes` | `1000000` | `10000`–`5000000`, before Base64 encoding |
| `maxSavedImages` | `200` | Integer `1`–`10000` |

There is no maximum width or height setting. Scale is never silently reduced;
images exceeding the byte budget fail (JPEG quality may be reduced to fit).
Processing is limited to 100 megapixels.

Settings live in `~/.config/isimbot/screenshot.json`; originals in
`~/.config/isimbot/screenshots/`. `ISIMBOT_CONFIG_DIR` overrides the base directory.
Oldest managed images are pruned to the limit, including when the limit is lowered.
Custom `path` files are excluded. Returned image data remains usable after file cleanup.

## Operation chains

Run actions and screenshots in one request:

```json
{
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
and 8 MB total Base64 image data. Chains cannot call `setup` or another chain.
Avoid concurrent operations while a chain runs.
