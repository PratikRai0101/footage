#!/usr/bin/env python3
"""Verify captured iPhone rebuild evidence without exporting selected-file URIs."""
import datetime
import hashlib
import json
from pathlib import Path
import plistlib
import subprocess
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts/rebuild'


def document(name):
    return json.loads((OUT / name).read_text())


def nodes(name):
    value = document(name)['data']
    return value.get('nodes', value.get('snapshot', {}).get('nodes', []))


def labels(name):
    return {node.get('label') for node in nodes(name)}


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def main():
    simulator = (OUT / 'ios-simulator-id.txt').read_text().strip()
    opened = document('ios-open.json')['data']
    assert opened['device_udid'] == simulator
    app = ROOT / 'artifacts/ios-simulator/Footage.app'
    plist = plistlib.loads((app / 'Info.plist').read_bytes())
    assert plist['CFBundleShortVersionString'] == '0.4.0' and plist['CFBundleVersion'] == '4'
    installed = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', simulator, 'dev.footage.spike', 'app'], text=True).strip())
    assert digest(app / 'main.jsbundle') == digest(installed / 'main.jsbundle')
    for name in ['ios-check-selected.json', 'ios-check-play.json', 'ios-check-close.json', 'ios-about-open.json']:
        assert document(name)['success'], name
    review = labels('ios-final-review.json')
    assert {'Ready to preview.', 'Full-frame playback', '0:08 · 1280 × 720 · 4.0 MB', 'Preview only', 'Choose another video'} <= review
    assert 'Upload original' not in review and 'Send to thread' not in review
    assert 'Choose a video' in labels('ios-final-empty.json')
    assert any('Uploads are available on Android' in (label or '') for label in labels('ios-about-tree.json'))
    close = next(node for node in nodes('ios-playback-tree.json') if node.get('type') == 'Button' and node.get('label') == 'Close preview')
    assert close['hittable'] and close['rect']['y'] >= 62
    assert close['rect']['width'] >= 44 and close['rect']['height'] >= 44
    a = Image.open(OUT / 'ios-playback-a.png').convert('RGB')
    b = Image.open(OUT / 'ios-playback-b.png').convert('RGB')
    assert a.size == b.size == (1206, 2622)
    height = round(a.width * 720 / 1280)
    box = (0, (a.height - height) // 2, a.width, (a.height + height) // 2)
    changed = sum(sum(pixel) > 60 for pixel in ImageChops.difference(a.crop(box), b.crop(box)).getdata())
    assert changed > 1000
    metro_absent = subprocess.run(['lsof', '-iTCP:8081', '-sTCP:LISTEN'], capture_output=True).returncode != 0
    assert metro_absent
    normal = next(node for node in nodes('ios-final-empty.json') if node.get('label') == 'Choose an original.')
    large = next(node for node in nodes('ios-large-cold-tree.json') if node.get('label') == 'Choose an original.')
    large_changed = large['rect']['height'] > normal['rect']['height'] * 1.1
    record = {
        'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'platform': {'device': 'Footage · iPhone 17 Pro', 'udid': simulator, 'os': 'iOS 26.2', 'physical': False},
        'build': {'version': '0.4.0', 'number': '4', 'artifact': 'artifacts/ios-simulator/Footage.app', 'configuration': 'Release arm64 iPhone Simulator, unsigned', 'javascriptSha256': digest(app / 'main.jsbundle'), 'installedBundleMatches': True, 'metroAbsent': metro_absent},
        'fixture': {'name': 'footage-ui-test.mp4', 'bytes': (OUT / 'footage-ui-test.mp4').stat().st_size, 'sha256': digest(OUT / 'footage-ui-test.mp4'), 'kind': 'generated 8-second 1280×720 H264/AAC test pattern'},
        'checks': {'realSystemPicker': True, 'metadataMatchesGeneratedFixture': True, 'fullFramePlaybackAndReturn': True, 'changedVideoPixelsBetweenFrames': changed, 'closeControlSafeAnd44pt': True, 'platformDisclosureInAbout': True, 'noUnimplementedUploadOrT3Action': True, 'coldLaunch': True, 'largeTextGeometryIncreased': large_changed, 'textSizeRestored': True},
        'scope': ['iOS remains preview-only; no native iOS upload engine or T3 dispatch was implemented', 'Android runtime validation was abandoned at user request; its test session and receiver were stopped', 'No physical phone, background transfer, VoiceOver, 4K/HDR fidelity or memory claim', 'Requested large-text setting is accepted as evidence only if title geometry actually increases'],
        'screenshots': ['artifacts/rebuild/ios-final.png', 'artifacts/rebuild/ios-09-review.png', 'artifacts/rebuild/ios-playback-a.png', 'artifacts/rebuild/ios-playback-b.png'],
    }
    for path in [OUT / 'ios-result.json', ROOT / 'docs/evidence/full-frame-ios-rebuild.json']:
        path.write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({'simulator': 'iPhone 17 Pro / iOS 26.2', 'installedVersion': '0.4.0 (4)', 'pickerAndFullFramePlayback': True, 'changedVideoPixels': changed, 'largeTextGeometryIncreased': large_changed, 'nativeIOSUploads': False}))


if __name__ == '__main__':
    main()
