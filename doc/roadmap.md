# Roadmap

[Back to README](../README.md)

Multi-simulator operation is implemented in source and awaits release.
See [MCP operations](mcp_operation.md#devices).

Planned features below are in priority order. No release dates are assigned.

## 1. Android emulators

Operate existing AVDs: start/connect, install APKs, control apps, inspect UI,
and capture screenshots. Reuse screenshot settings and operation chains.
Use ADB and Android Emulator, preferring an existing Android Studio SDK.
App builds and AVD creation are outside the initial scope.

## 2. Screen recording

iOS simulator recording is implemented in source and awaits release: background
H.264 MP4 capture, auto-stop, status and operation-chain support.
Android recording, audio and retention settings remain planned.

## 3. USB physical devices

Support authorized Android phones through ADB and evaluate WDA/XCUITest for iPhones.
Android requires USB debugging and host authorization; iPhone requires developer
setup plus a configured automation runner. Validate screenshots, gestures, input,
and operation chains separately on each platform.

## 4. Device control

Device control is implemented in source for system text size, appearance,
rotation, notification send/list and fixed location, including operation chains. Explicit lock/unlock and more device state
queries remain planned. The current `press_button` tool exposes the lock button.
