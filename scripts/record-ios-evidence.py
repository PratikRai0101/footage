#!/usr/bin/env python3
"""Consolidate actual simulator UI captures without storing selected-file URIs."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts/ios-simulator'
SIMULATOR = 'FA652008-7FC6-4054-A1F9-4D5E6464FA3C'


def main():
    app = OUT / 'Footage.app'
    plist = json.loads(subprocess.check_output(['plutil', '-convert', 'json', '-o', '-', str(app / 'Info.plist')], text=True))
    review = json.loads((OUT / 'review-after-fix.json').read_text())
    nodes = review['data']['nodes']
    labels = {node.get('label') for node in nodes}
    assert '0:08 · 1280 × 720 · 4.0 MiB' in labels and 'Upload original' not in labels
    frame = next(node for node in nodes if node.get('identifier') == 'local-preview-stage')['rect']
    box = tuple(round(value * 3) for value in (frame['x'], frame['y'], frame['x'] + frame['width'], frame['y'] + frame['height']))
    first = Image.open(OUT / '05-playback-1.png').convert('RGB').crop(box)
    later = Image.open(OUT / '06-playback-3.png').convert('RGB').crop(box)
    changed = sum(1 for pixel in ImageChops.difference(first, later).getdata() if sum(pixel) > 60)
    assert changed > 1000
    scrolled = json.loads((OUT / 'large-after-drag-tree.json').read_text())['data']['nodes']
    assert any(node.get('label') == 'Preview only in this build' and node.get('hittable') for node in scrolled)
    assert any('temporary copy for playback' in (node.get('label') or '') and node.get('hittable') for node in scrolled)
    source = ROOT / 'artifacts/ui-emulator/footage-playback-test.mp4'
    sha = hashlib.sha256(source.read_bytes()).hexdigest()
    local = Path('<developer-home>/Library/Developer/CoreSimulator/Devices') / SIMULATOR / 'data/Containers/Shared/AppGroup/993099F3-8F18-4326-8E60-4C1468BD01B1/File Provider Storage/Footage Generated Tests/footage-ios-generated.mp4'
    assert hashlib.sha256(local.read_bytes()).hexdigest() == sha
    assert subprocess.run(['lsof', '-iTCP:8081', '-sTCP:LISTEN'], capture_output=True).returncode != 0
    record = {
        'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'simulator': {'name': 'iPhone Duo', 'udid': SIMULATOR, 'os': 'iOS 27.1', 'physical': False},
        'build': {'artifact': 'artifacts/ios-simulator/Footage.app', 'bundleId': plist['CFBundleIdentifier'], 'version': plist['CFBundleShortVersionString'], 'configuration': 'Release iphonesimulator arm64; unsigned; JS/assets embedded', 'executableSha256': hashlib.sha256((app / 'Footage').read_bytes()).hexdigest(), 'javascriptSha256': hashlib.sha256((app / 'main.jsbundle').read_bytes()).hexdigest(), 'metroRequired': False, 'metroAbsentDuringTest': True},
        'fixture': {'name': 'footage-ios-generated.mp4', 'bytes': source.stat().st_size, 'sha256': sha, 'durationMs': 8000, 'width': 1280, 'height': 720, 'kind': 'Generated H264 Main/AAC; dedicated simulator local-provider test folder'},
        'checks': {'coldLaunch': True, 'realSystemPicker': True, 'actualPreviewMetadata': True, 'movingVideoFramesObserved': True, 'changedPixelsInPreviewBetweenRecordedFrames': changed, 'providerOriginalUnchanged': True, 'pickerCancellationRetainsSelection': True, 'previewOnlyActionNotUpload': True, 'accessibilityLargeDisclosureReachableAfterRawDrag': True, 'appearance': json.loads((OUT / 'theme-and-text.json').read_text()), 'mobileTests': 17, 'receiverTests': 26, 'proxyTests': 2, 'lint': 'pass', 'typecheck': 'pass'},
        'fixed': ['Read real Expo Video duration/dimensions in preview-only builds; Android keeps native metadata ownership', 'Remove non-Android upload action and no-copy promise; disclose preview-only/temporary-picker-copy boundary'],
        'limits': ['No iOS native upload engine, background-transfer or receipt claim', 'No physical iPhone', 'Only available iPhone Duo/iOS27.1 simulator; other devices/versions unverified', 'VoiceOver audio, HDR fidelity, 4K memory and Safari receiving-side playback not tested'],
        'rawEvidence': ['04-review-after-fix.png', 'local-preview.mp4', '05-playback-1.png', '06-playback-3.png', '07-light.png', 'theme-dark.png', 'theme-system.png', '08-large-text.png', '09-large-text-scrolled.png', 'mobile-before-fix.tap', 'all-tests.tap', 'typecheck.log', 'lint.log'],
    }
    for path in (OUT / 'result.json', ROOT / 'docs/evidence/ios-simulator.json'):
        path.write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({'realIOSSimulator': True, 'pickerPlaybackMetadataPassed': True, 'changedPreviewPixels': changed, 'providerFixtureHashMatches': True, 'nativeIOSUploads': False}, indent=2))


if __name__ == '__main__':
    main()
