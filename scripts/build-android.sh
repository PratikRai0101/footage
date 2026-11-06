#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob
variant=Debug
artifact=footage-spike-debug.apk
if [[ "${1:-}" == "--standalone" ]]; then
  variant=Release
  artifact=footage-demo.apk
  shift
fi
cd "$(dirname "$0")/.."

if [[ -z "${JAVA_HOME:-}" ]]; then
  candidates=(
    "$HOME"/.gradle/jdks/*21*/*/Contents/Home
    "$HOME"/.gradle/jdks/*21*/Contents/Home
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate/bin/java" ]]; then export JAVA_HOME="$candidate"; break; fi
  done
fi
if [[ ! -x "${JAVA_HOME:-}/bin/java" ]]; then
  printf 'Set JAVA_HOME to a JDK 21 installation, then rerun this script.\n' >&2
  exit 1
fi
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [[ ! -d "$ANDROID_HOME/platforms" ]]; then
  printf 'Set ANDROID_HOME to your installed Android SDK, then rerun this script.\n' >&2
  exit 1
fi

(cd apps/mobile && CI=1 npx expo prebuild --platform android --no-install)
apps/mobile/android/gradlew -p apps/mobile/android ":app:assemble${variant}" --console=plain "$@"
mkdir -p artifacts
folder=$(printf '%s' "$variant" | tr '[:upper:]' '[:lower:]')
cp "apps/mobile/android/app/build/outputs/apk/$folder/app-$folder.apk" "artifacts/$artifact"
printf '\nAPK: %s/artifacts/%s\n' "$PWD" "$artifact"
if [[ "$variant" == Release ]]; then
  printf 'Standalone local-demo build with embedded JavaScript; no Metro required. ARM64, development signing, not a store release. Public HTTP receiver origins are rejected by native validation.\n'
else
  printf 'Development client; Metro required. Compilation alone is not device evidence.\n'
fi
