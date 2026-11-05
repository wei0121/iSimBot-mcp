#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/native"
mkdir -p "$OUT"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
for ARCH in arm64 x86_64; do
xcrun --sdk iphonesimulator clang -dynamiclib -fobjc-arc -fmodules \
  -isysroot "$SDK" -target "$ARCH-apple-ios15.0-simulator" \
  -framework Foundation -framework UIKit "$ROOT/native/observation/Recorder.m" \
  -o "$OUT/isimbot-observer-$ARCH.dylib"
done
xcrun lipo -create "$OUT/isimbot-observer-arm64.dylib" "$OUT/isimbot-observer-x86_64.dylib" -output "$OUT/isimbot-observer.dylib"
rm "$OUT/isimbot-observer-arm64.dylib" "$OUT/isimbot-observer-x86_64.dylib"
codesign --force --sign - "$OUT/isimbot-observer.dylib"
