#!/usr/bin/env python3
"""Record final build/test evidence without reading native authority or video URIs."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts/ui-emulator'
DOCS = ROOT / 'docs/evidence'


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def load(name):
    return json.loads((OUT / name).read_text())


def main():
    apk = ROOT / 'artifacts/footage-demo.apk'
    debug = ROOT / 'artifacts/footage-spike-debug.apk'
    tap = (OUT / 'all-tests.tap').read_text()
    assert re.findall(r'^# tests (\d+)$', tap, re.M) == ['26', '17', '2']
    assert re.findall(r'^# fail (\d+)$', tap, re.M) == ['0', '0', '0']
    native = ROOT / 'apps/mobile/modules/footage-transfer/android/build'
    tests = ET.parse(native / 'test-results/testDebugUnitTest/TEST-expo.modules.footagetransfer.ReceiverOriginTest.xml').getroot()
    assert tests.get('tests') == '2' and tests.get('failures') == tests.get('errors') == '0'
    lint = ET.parse(native / 'reports/lint-results-debug.xml').getroot()
    assert all(issue.get('severity') not in ('Error', 'Fatal') for issue in lint)
    assert 'Verifies' in (DOCS / 'final-demo-apk-signature.txt').read_text()
    serial = 'emulator-5554'
    installed = subprocess.check_output(['adb', '-s', serial, 'shell', 'pm', 'path', 'dev.footage.spike'], text=True).strip().removeprefix('package:')
    installed_sha = subprocess.check_output(['adb', '-s', serial, 'shell', 'sha256sum', installed], text=True).split()[0]
    assert installed_sha == digest(apk)
    assert load('final-binary-intake.json')['apkSha256'] == installed_sha
    files = {ROOT / 'apps/mobile/app.json', ROOT / 'package-lock.json'}
    for folder in ['apps/mobile/src', 'apps/mobile/modules/footage-transfer', 'apps/server/src']:
        for path in (ROOT / folder).rglob('*'):
            if path.is_file() and not {'build', '.gradle'} & set(path.relative_to(ROOT / folder).parts) and path.suffix in {'.ts', '.tsx', '.kt', '.xml', '.gradle', '.json'}:
                files.add(path)
    sources = {str(path.relative_to(ROOT)): digest(path) for path in sorted(files)}
    artifact = {'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'artifact': str(apk.relative_to(ROOT)), 'sha256': digest(apk), 'bytes': apk.stat().st_size, 'kind': 'Standalone ARM64 release-mode local demo; embedded JavaScript; development signing; native public-HTTP rejection', 'package': 'dev.footage.spike', 'versionName': '0.2.0', 'versionCode': 2, 'minimumInstallApi': 24, 'minimumTransferApi': 26, 'targetSdk': 36, 'compileSdk': 37, 'physicalDeviceTested': False, 'emulatorTested': True, 'appLaunched': True, 'installedApkHashVerified': True, 'metroRequired': False, 'schedulers': {'26-33': 'foreground-service; historical physical evidence only', '34+': 'user-initiated-job; API36 emulator, not physical hardware'}, 'evidence': 'mobile-finish.json', 'previousPhysicalArtifact': 'artifact-before-ui-finish.json', 'debugArtifact': {'artifact': str(debug.relative_to(ROOT)), 'sha256': digest(debug), 'bytes': debug.stat().st_size, 'metroRequired': True}, 'sourceSha256': sources}
    physical_path = DOCS / 'android13-final-device.json'
    if physical_path.exists():
        physical = json.loads(physical_path.read_text())
        if physical['artifactSha256'] == artifact['sha256'] and physical['settingsRestoredAtSessionEnd']:
            assert all(physical[name]['passed'] for name in ('usbBaseline', 'wifiHomeScreen', 'visibleCancellation', 'directWifi', 'nativeViewer'))
            artifact['physicalDeviceTested'] = True
            artifact['physicalDeviceEvidence'] = 'android13-final-device.json'
            artifact['physicalCoverage'] = 'Samsung API33; standalone upload/integrity/UI, Home, actual WLAN loss/recovery, 226.5s powered continuous AOD, cancellation/resource release and native viewer page. Unplugged/deep Doze unverified.'
    records = {name: load(path) for name, path in {'standaloneRecovery': 'standalone-intake.json', 'freshNotificationConsentIntake': 'final-direct-intake.json', 'finalBinaryIntake': 'final-binary-intake.json', 'browser': 'viewer-final/result.json', 'nativeBrowserOpening': 'native-viewer.json', 'previewAccessibility': 'preview-accessibility.json', 'storageRejection': 'storage-rejection-result.json', 'receiverDeployment': 'receiver-deployment.json'}.items()}
    assert all(records[name]['passed'] for name in ['standaloneRecovery', 'freshNotificationConsentIntake', 'finalBinaryIntake', 'nativeBrowserOpening', 'previewAccessibility', 'storageRejection'])
    evidence = {'recordedAt': artifact['recordedAt'], 'scope': 'Local tests, API36 emulator and Chromium. Not physical/unplugged/Doze evidence.', 'artifactSha256': artifact['sha256'], 'checks': {'receiverHttp': 26, 'mobileContracts': 17, 'streamingProxy': 2, 'nativeOrigin': 2, 'failures': 0, 'nativeLintWarnings': len(lint)}, 'records': records, 'limits': ['Physical coverage is in android13-final-device.json when its artifact hash matches', 'Unplugged and deep Doze unverified', 'TalkBack, cellular, real 4K/HDR and memory measurement unverified', 'Final three-minute application recording pending'], 'sourceSha256': sources}
    (DOCS / 'artifact.json').write_text(json.dumps(artifact, indent=2) + '\n')
    (DOCS / 'mobile-finish.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps({'artifact': artifact['artifact'], 'bytes': artifact['bytes'], 'sha256': artifact['sha256'], 'installedHashMatches': True, 'automatedTestsPassed': 47, 'physicalDeviceTested': artifact['physicalDeviceTested']}, indent=2))


if __name__ == '__main__':
    main()
