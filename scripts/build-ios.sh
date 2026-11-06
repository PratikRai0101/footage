#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
(cd apps/mobile && CI=1 npx expo prebuild --platform ios --no-install)
(cd apps/mobile/ios && pod install)
SCHEME=Footage
WORKSPACE="$ROOT/apps/mobile/ios/$SCHEME.xcworkspace"
[[ -d "$WORKSPACE" && -f "$ROOT/apps/mobile/ios/$SCHEME.xcodeproj/xcshareddata/xcschemes/$SCHEME.xcscheme" ]]
xcodebuild -workspace "$WORKSPACE" -scheme "$SCHEME" \
  -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$ROOT/artifacts/ios-simulator/build" \
  -jobs 2 ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO "$@"
APP="$ROOT/artifacts/ios-simulator/build/Build/Products/Release-iphonesimulator/$SCHEME.app"
[[ -d "$APP" ]]
mkdir -p "$ROOT/artifacts/ios-simulator"
ditto "$APP" "$ROOT/artifacts/ios-simulator/$SCHEME.app"
printf '\nSimulator app: %s/artifacts/ios-simulator/%s.app\nEmbedded JS/assets; no Metro. Simulator-only, not a physical iPhone build. iOS uploads require Footage to remain open.\n' "$ROOT" "$SCHEME"
