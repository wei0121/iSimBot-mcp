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

Start and stop recordings on iOS and Android simulators while continuing operations.
Return the video file and metadata. Formats, audio, and retention are to be decided.

## 3. USB physical devices

Support authorized Android phones through ADB and evaluate WDA/XCUITest for iPhones.
Android requires USB debugging and host authorization; iPhone requires developer
setup plus a configured automation runner. Validate screenshots, gestures, input,
and operation chains separately on each platform.

## 4. Device control

Switch between portrait and landscape, lock/unlock the screen, and query device
state. Support these actions in operation chains, with platform limitations made
explicit. The current `press_button` tool already exposes the lock button;
explicit lock/unlock state control is planned.
