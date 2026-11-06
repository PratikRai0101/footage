#!/usr/bin/env bash
# Build only for Simulator; test host links the exact production owner sources.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="$PWD/artifacts/ios-foreground/OwnerHarness.app"
mkdir -p "$OUT"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
xcrun swiftc -swift-version 5 -parse-as-library -O -target arm64-apple-ios16.4-simulator -sdk "$SDK" \
  apps/mobile/modules/footage-transfer/ios/Transfer{Model,HTTP,Owner}.swift scripts/test/IOSOwnerHarness.swift \
  -o "$OUT/OwnerHarness"
/usr/libexec/PlistBuddy -c 'Clear dict' "$OUT/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string dev.footage.owner-harness' \
  -c 'Add :CFBundleExecutable string OwnerHarness' -c 'Add :CFBundleName string OwnerHarness' \
  -c 'Add :CFBundlePackageType string APPL' -c 'Add :CFBundleVersion string 1' \
  -c 'Add :CFBundleShortVersionString string 1.0' -c 'Add :MinimumOSVersion string 16.4' \
  -c 'Add :LSRequiresIPhoneOS bool true' -c 'Add :UIDeviceFamily array' -c 'Add :UIDeviceFamily:0 integer 1' \
  -c 'Add :NSAppTransportSecurity dict' -c 'Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true' \
  -c 'Add :UILaunchScreen dict' "$OUT/Info.plist"
codesign --force --sign - "$OUT"
