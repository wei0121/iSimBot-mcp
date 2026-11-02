# Roadmap

[Back to README](../README.md)

Planned features, in priority order. No release dates are assigned.

## 1. Android emulators

Operate existing AVDs: start/connect, install APKs, control apps, inspect UI,
and capture screenshots. Reuse screenshot settings and operation chains.
Use ADB and Android Emulator, preferring an existing Android Studio SDK.
App builds and AVD creation are outside the initial scope.

## 2. Screen recording

Start and stop recordings on iOS and Android simulators while continuing operations.
Return the video file and metadata. Formats, audio, and retention are to be decided.

## 3. Multi-simulator operation

Target devices explicitly and operate different simulators concurrently.
Keep each chain bound to one device and identify the device in returned results.

## 4. USB physical devices

Support authorized Android phones through ADB and evaluate WDA/XCUITest for iPhones.
Android requires USB debugging and host authorization; iPhone requires developer
setup plus a configured automation runner. Validate screenshots, gestures, input,
and operation chains separately on each platform.
