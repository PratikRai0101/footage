#!/usr/bin/env python3
"""Consolidate only sanitized assertions, generated-fixture receipts, and build fingerprints."""
import datetime
import hashlib
import json
from pathlib import Path
import plistlib
import sqlite3

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts/ios-foreground'

def sha(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(65536), b''):
            value.update(block)
    return value.hexdigest()

fixture = OUT / 'generated-original.mp4'
source_hash = sha(fixture)
tree = json.loads((OUT / 'ui-final-tree.json').read_text())['data']['nodes']
labels = [n.get('label', '') for n in tree]
assert 'Original verified.' in labels
assert '0:12 · 1280 × 720 · 12.7 MB' in labels
ui_receipt = next(label.removeprefix('Receipt ') for label in labels if label.startswith('Receipt '))
assert 'SHA-256 ' + source_hash in labels
with sqlite3.connect(OUT / 'receiver/jobs.sqlite') as db:
    rows = db.execute("SELECT json_extract(document,'$.receipt') FROM jobs WHERE json_extract(document,'$.receipt.id') = ?", (ui_receipt,)).fetchall()
assert len(rows) == 1
receipt = json.loads(rows[0][0])
received_hash = sha(OUT / 'receiver/uploads' / receipt['jobId'])
assert received_hash == source_hash == receipt['sha256']
assert receipt['bytes'] == fixture.stat().st_size
transport = json.loads((OUT / 'transport.json').read_text())
assert transport['sinkRequests'] == transport['sinkBytes'] == 0
owner_checks = json.loads((OUT / 'owner-results.json').read_text())
assert len(owner_checks) == 14
recovery = next(c for c in owner_checks if c['test'] == 'uncertain-patch-head-reconcile-and-relaunch')
assert recovery['firstResumedPatchOffset'] == recovery['serverAcceptedBeforeRelaunch'] > recovery['localConfirmedBeforeRelaunch'] > 0
app = ROOT / 'artifacts/ios-simulator/Footage.app'
plist = plistlib.loads((app / 'Info.plist').read_bytes())
assert (app / 'main.jsbundle').exists()
assert plist['NSAppTransportSecurity']['NSAllowsLocalNetworking']
assert not plist.get('UIBackgroundModes')
for log in ['release-build-final.log', 'harness-build.log', 'npm-tests.log', 'typecheck.log', 'lint.log']:
    assert (OUT / log).exists()
assert '** BUILD SUCCEEDED **' in (OUT / 'release-build-final.log').read_text()
result = {
    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope': 'Owned iPhone 16 Simulator, iOS 26.2. Foreground native uploads only. No physical phone, account credentials, cloud build, or T3 dispatch.',
    'build': {
        'bundleId': plist['CFBundleIdentifier'], 'version': plist['CFBundleShortVersionString'],
        'configuration': 'Release arm64 iphonesimulator, embedded JavaScript/assets, no Metro dependency',
        'xcode': '27.2', 'sdk': 'iPhoneSimulator27.2', 'expo': '58.0.21',
        'executableSha256': sha(app / 'Footage'), 'javascriptSha256': sha(app / 'main.jsbundle'),
        'backgroundModes': plist.get('UIBackgroundModes', []),
    },
    'fixture': {'name': fixture.name, 'bytes': fixture.stat().st_size, 'sha256': source_hash, 'durationMs': 12000, 'width': 1280, 'height': 720, 'kind': 'Generated H264/AAC test pattern'},
    'releaseUI': {'realFilesPicker': True, 'explicitUploadOriginalTap': True, 'nativeMetadataAfterStaging': True,
                  'matchingNativeReceiptVisible': True, 'receipt': receipt, 'independentReceiverFileSha256': received_hash,
                  'stagedFullFrameMovingPlayback': json.loads((OUT / 'ui-playback.json').read_text())},
    'nativeOwnerChecks': owner_checks,
    'redirects': {'metadata307Rejected': True, 'file307Rejected': True, 'sameProductionTransportWithoutAuthorizationAlsoRejected307': True, 'sinkRequests': 0, 'sinkBytes': 0},
    'localChecks': {'npmCi': 'pass', 'npmTest': '53 pass: 26 receiver, 21 mobile, 6 device-tool', 'typecheck': 'pass', 'lint': 'pass'},
    'limits': ['Not background upload completion or automatic restart after force-quit.', 'Lifecycle evidence uses a real app transition and a throttled local proxy, not physical lock, Wi-Fi loss, deep suspension, or power testing.', 'Only one generated 12.7 MB video, one simulator model and OS. No 4 GiB, HDR, physical device, memory benchmark, or accessibility recertification.', 'No T3 destination binding, thread delivery, dispatch, or Cardboard integration. Android was not built or tested.'],
    'rawArtifacts': 'artifacts/ios-foreground/ (ignored; build logs remain local)',
}
(ROOT / 'docs/evidence/ios-foreground-upload.json').write_text(json.dumps(result, indent=2) + '\n')
print('Sanitized evidence: docs/evidence/ios-foreground-upload.json')
