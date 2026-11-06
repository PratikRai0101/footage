#!/usr/bin/env python3
"""Record narrowly scoped evidence for the polished APK and DJI recording."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / 'docs/evidence'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def main():
    capture = json.loads((ROOT / 'artifacts/demo/take-3/result.json').read_text())
    assert capture['passed'] and capture['settingsRestored'] and not capture['rateLimiterUsed']
    events = {e['event']: e for e in capture['events']}
    identity = capture['jobId']
    assert events['actual_wifi_disabled']['jobId'] == events['same_job_recovery']['jobId'] == identity
    assert events['actual_wifi_disabled']['serverBytes'] > 0
    assert events['waiting_visible']['serverBytes'] < capture['fixture']['bytes']
    db = sqlite3.connect(ROOT / 'artifacts/device-spike/receiver/jobs.sqlite')
    row = db.execute('SELECT document FROM jobs WHERE id=?', (identity,)).fetchone()
    job = json.loads(row[0]); db.close()
    received = ROOT / 'artifacts/device-spike/receiver/uploads' / identity
    assert job['status'] == 'received' and job['receipt'] == capture['receipt']
    assert received.stat().st_size == job['receipt']['bytes'] == capture['fixture']['bytes']
    assert digest(received) == capture['fixture']['sha256'] == job['receipt']['sha256']
    apk = ROOT / 'artifacts/footage-demo.apk'
    installed = subprocess.check_output(['adb', '-s', '<redacted-device-serial>', 'shell', 'pm', 'path', 'dev.footage.spike'], text=True).strip().removeprefix('package:')
    installed_sha = subprocess.check_output(['adb', '-s', '<redacted-device-serial>', 'shell', 'sha256sum', installed], text=True, timeout=25).split()[0]
    assert installed_sha == capture['apkSha256'] == digest(apk)
    tap = (ROOT / 'artifacts/demo/polish-all-tests.tap').read_text()
    assert re.findall(r'^# tests (\d+)$', tap, re.M) == ['26', '18', '2']
    assert re.findall(r'^# fail (\d+)$', tap, re.M) == ['0', '0', '0']
    native = ROOT / 'apps/mobile/modules/footage-transfer/android/build'
    tests = ET.parse(native / 'test-results/testDebugUnitTest/TEST-expo.modules.footagetransfer.ReceiverOriginTest.xml').getroot()
    assert tests.get('tests') == '2' and tests.get('failures') == tests.get('errors') == '0'
    lint = ET.parse(native / 'reports/lint-results-debug.xml').getroot()
    assert all(issue.get('severity') not in ('Error', 'Fatal') for issue in lint)
    signer = Path.home() / 'Library/Android/sdk/build-tools/37.0.0/apksigner'
    signature = subprocess.check_output([str(signer), 'verify', '--verbose', str(apk)], text=True)
    assert 'Verifies' in signature
    (DOCS / 'demo-0.3-apk-signature.txt').write_text(signature)
    sources = {ROOT / 'apps/mobile/app.json', ROOT / 'package-lock.json'}
    for folder in ['apps/mobile/src', 'apps/mobile/modules/footage-transfer', 'apps/server/src']:
        for path in (ROOT / folder).rglob('*'):
            if path.is_file() and not {'build', '.gradle'} & set(path.relative_to(ROOT / folder).parts) and path.suffix in {'.ts', '.tsx', '.kt', '.xml', '.gradle', '.json'}:
                sources.add(path)
    hashes = {str(p.relative_to(ROOT)): digest(p) for p in sorted(sources)}
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    limits = ['Foreground USB-powered Samsung recording, not unplugged or deep Doze', 'No battery exemption or transfer throttle', '4K HEVC preview and original byte integrity checked; HDR/colour fidelity and memory usage not measured', 'Viewer page is not a measured physical browser decode pass', 'iOS native uploads remain unimplemented', 'New UI not rebuilt/rechecked on iOS Simulator or API36 emulator; earlier evidence belongs to version0.2']
    evidence = {'recordedAt': now, 'artifactSha256': installed_sha, 'scope': 'Polished standalone APK on physical Samsung Android13; real authorized DJI 386,918,637-byte original', 'checks': {'receiverHttp': 26, 'mobileContracts': 18, 'streamingProxy': 2, 'nativeOrigin': 2, 'failures': 0, 'nativeLintWarnings': len(lint)}, 'capture': capture, 'independentReceivedFileHashVerified': True, 'installedApkHashMatches': True, 'sourceSha256': hashes, 'limits': limits}
    (DOCS / 'android13-dji-demo.json').write_text(json.dumps(evidence, indent=2) + '\n')
    config = json.loads((ROOT / 'apps/mobile/app.json').read_text())['expo']
    artifact = {'recordedAt': now, 'artifact': str(apk.relative_to(ROOT)), 'sha256': installed_sha, 'bytes': apk.stat().st_size, 'kind': 'Standalone ARM64 release-mode local demo; embedded JavaScript; development signing', 'package': config['android']['package'], 'versionName': config['version'], 'versionCode': config['android']['versionCode'], 'minimumInstallApi': 24, 'minimumTransferApi': 26, 'targetSdk': 36, 'compileSdk': 37, 'physicalDeviceTested': True, 'emulatorTested': False, 'appLaunched': True, 'installedApkHashVerified': True, 'metroRequired': False, 'evidence': 'android13-dji-demo.json', 'physicalDeviceEvidence': 'android13-dji-demo.json', 'physicalCoverage': 'Real DJI 4K HEVC selection/preview, original upload, actual WLAN loss at nonzero bytes, same-job recovery, independent SHA-256 and native matching receipt. Foreground USB-powered recording.', 'previousPhysicalArtifact': '../../artifacts/archive/artifact-0.2.json', 'historicalEvidence': ['android13-final-device.json', 'mobile-finish.json', 'ios-simulator.json'], 'sourceSha256': hashes, 'limits': limits}
    (DOCS / 'artifact.json').write_text(json.dumps(artifact, indent=2) + '\n')
    print(json.dumps({'sha256': installed_sha, 'bytes': artifact['bytes'], 'testsPassed': 48, 'physicalDjiRecoveryPassed': True}, indent=2))


if __name__ == '__main__':
    main()
