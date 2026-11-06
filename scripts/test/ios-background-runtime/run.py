#!/usr/bin/env python3
"""Standalone owned Simulator tests. No Expo/UI/config/server activation or existing devices.
Private artifacts are ignored; fresh generated Keychain items disappear with the disposable sim.
"""
import json
import os
import plistlib
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).resolve().parent
NATIVE = ROOT / 'apps/mobile/modules/footage-transfer/ios'
OUT = ROOT / 'artifacts/ios-background-runtime' / str(uuid.uuid4())
BUNDLE = 'test.footage.backgroundruntime'


def cmd(*args, check=True):
    result = subprocess.run([str(x) for x in args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if check and result.returncode:
        (OUT / 'command-error.log').write_bytes(result.stdout)
        raise RuntimeError('Command failed: ' + str(args[0]) + '; see ' + str(OUT / 'command-error.log'))
    return result.stdout.decode().strip()


def read_json(path):
    try: return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError): return None


def wait(check, seconds=120):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = check()
        if value is not None and value is not False: return value
        time.sleep(.1)
    raise TimeoutError('Timed out: ' + str(OUT))


def build(probe=None):
    files = [probe or SOURCE / 'Probe.swift', SOURCE / 'Tests.swift', NATIVE / 'SealedProtocol.swift', *sorted(NATIVE.glob('Background*.swift'))]
    for file in files: shutil.copyfile(file, OUT / file.name)
    # Independent tiny Xcode project, not generated Expo sources.
    project = (ROOT / 'scripts/pairing-probe/project.pbxproj').read_text()
    refs, builds, groups, sources = [], [], [], []
    for i, file in enumerate(files[1:]):
        ref, build_id = f'B{i:023X}', f'C{i:023X}'
        refs.append(f'{ref} = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {file.name}; sourceTree = "<group>"; }};')
        builds.append(f'{build_id} = {{isa = PBXBuildFile; fileRef = {ref}; }};')
        groups.append(ref); sources.append(build_id)
    project = project.replace('A00000000000000000000007, A00000000000000000000004', 'A00000000000000000000007, ' + ', '.join(groups) + ', A00000000000000000000004')
    project = project.replace('files = (A0000000000000000000000C)', 'files = (A0000000000000000000000C, ' + ', '.join(sources) + ')')
    project = project.replace(' };\n rootObject', '\n' + '\n'.join(refs + builds) + '\n };\n rootObject')
    project = project.replace('TransportProbe', 'BackgroundProbe').replace('test.footage.transportprobe', BUNDLE)
    project = project.replace('SWIFT_VERSION = 5.0;', 'SWIFT_VERSION = 6.0; SWIFT_TREAT_WARNINGS_AS_ERRORS = YES; ALWAYS_SEARCH_USER_PATHS = NO; OTHER_LDFLAGS = "-lsqlite3";')
    # A destination-scoped XCTest Home press avoids globally sending keyboard events to Simulator.
    shutil.copyfile(SOURCE / 'Home.swift', OUT / 'Home.swift')
    home_objects = '''
    D00000000000000000000001 = {isa = PBXNativeTarget; buildConfigurationList = D00000000000000000000002; buildPhases = (D00000000000000000000004); buildRules = (); dependencies = (); name = HomeTests; productName = HomeTests; productReference = D00000000000000000000005; productType = "com.apple.product-type.bundle.ui-testing"; };
    D00000000000000000000002 = {isa = XCConfigurationList; buildConfigurations = (D00000000000000000000003); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
    D00000000000000000000003 = {isa = XCBuildConfiguration; buildSettings = {PRODUCT_BUNDLE_IDENTIFIER = test.footage.backgroundhome; PRODUCT_NAME = "$(TARGET_NAME)"; GENERATE_INFOPLIST_FILE = YES; TARGETED_DEVICE_FAMILY = 1; SWIFT_VERSION = 6.0; SWIFT_TREAT_WARNINGS_AS_ERRORS = YES; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SDKROOT = iphonesimulator; TEST_TARGET_NAME = BackgroundProbe; CODE_SIGNING_ALLOWED = YES; CODE_SIGN_IDENTITY = "-"; }; name = Debug; };
    D00000000000000000000004 = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (D00000000000000000000007); runOnlyForDeploymentPostprocessing = 0; };
    D00000000000000000000005 = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; path = HomeTests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
    D00000000000000000000006 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = Home.swift; sourceTree = "<group>"; };
    D00000000000000000000007 = {isa = PBXBuildFile; fileRef = D00000000000000000000006; };
    '''
    project = project.replace('targets = (A00000000000000000000005)', 'targets = (A00000000000000000000005, D00000000000000000000001)')
    project = project.replace('children = (A00000000000000000000007,', 'children = (D00000000000000000000006, A00000000000000000000007,')
    project = project.replace('children = (A00000000000000000000008)', 'children = (A00000000000000000000008, D00000000000000000000005)')
    project = project.replace(' };\n rootObject', home_objects + '\n };\n rootObject')
    xcode = OUT / 'BackgroundProbe.xcodeproj'; xcode.mkdir(); (xcode / 'project.pbxproj').write_text(project)
    schemes = xcode / 'xcshareddata/xcschemes'; schemes.mkdir(parents=True)
    app_ref = '<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A00000000000000000000005" BuildableName="BackgroundProbe.app" BlueprintName="BackgroundProbe" ReferencedContainer="container:BackgroundProbe.xcodeproj"/>'
    test_ref = '<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="D00000000000000000000001" BuildableName="HomeTests.xctest" BlueprintName="HomeTests" ReferencedContainer="container:BackgroundProbe.xcodeproj"/>'
    (schemes / 'Home.xcscheme').write_text(f'<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="2700" version="1.3"><BuildAction parallelizeBuildables="NO" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">{app_ref}</BuildActionEntry><BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">{test_ref}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.PosixSpawn" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{test_ref}</TestableReference></Testables></TestAction></Scheme>')
    info = {'CFBundleIdentifier': BUNDLE, 'CFBundleName': 'BackgroundProbe', 'CFBundleExecutable': 'BackgroundProbe', 'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0', 'MinimumOSVersion': '17.0', 'LSRequiresIPhoneOS': True, 'UIDeviceFamily': [1], 'UILaunchScreen': {}, 'NSAppTransportSecurity': {'NSAllowsArbitraryLoads': False, 'NSAllowsLocalNetworking': False}, 'NSLocalNetworkUsageDescription': 'Disposable generated-byte runtime test.'}
    (OUT / 'Info.plist').write_bytes(plistlib.dumps(info))
    log = cmd('xcodebuild', '-project', xcode, '-target', 'BackgroundProbe', '-configuration', 'Debug', '-sdk', 'iphonesimulator', '-arch', 'arm64', 'CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_IDENTITY=-', f'CONFIGURATION_BUILD_DIR={OUT}', f'OBJROOT={OUT}/obj', f'SYMROOT={OUT}/sym')
    (OUT / 'build.log').write_text(log)
    # Also compile the exact runtime against the physical iPhone SDK, not an execution claim.
    sdk = cmd('xcrun', '--sdk', 'iphoneos', '--show-sdk-path')
    cmd('xcrun', 'swiftc', '-swift-version', '6', '-warnings-as-errors', '-parse-as-library', '-emit-module', '-module-name', 'BackgroundRuntime', '-target', 'arm64-apple-ios17.0', '-sdk', sdk, *files[2:], '-o', OUT / 'BackgroundRuntime.swiftmodule')


def certs():
    cmd('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Disposable Background CA', '-keyout', OUT / 'root.key', '-out', OUT / 'root.pem', '-days', '2')
    cmd('openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', OUT / 'leaf.key', '-out', OUT / 'leaf.csr')
    (OUT / 'leaf.ext').write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n')
    cmd('openssl', 'x509', '-req', '-in', OUT / 'leaf.csr', '-CA', OUT / 'root.pem', '-CAkey', OUT / 'root.key', '-CAcreateserial', '-days', '2', '-extfile', OUT / 'leaf.ext', '-out', OUT / 'leaf.pem')
    for name in ['root', 'leaf']: cmd('openssl', 'x509', '-in', OUT / (name + '.pem'), '-outform', 'DER', '-out', OUT / (name + '.der'))


def main():
    if shutil.disk_usage(ROOT).free < 6 * 1024**3: raise SystemExit('Need 6 GiB free; never delete shared resources')
    OUT.mkdir(parents=True, mode=0o700)
    cmd('git', 'check-ignore', OUT / 'generated.key')
    summary = {'xcode': cmd('xcodebuild', '-version'), 'swift6WarningsAsErrors': True, 'globalTrustChanged': False}
    device = listener = stopped_pid = None
    try:
        build()
        device = cmd('xcrun', 'simctl', 'create', 'Owned Background Runtime Proof', 'com.apple.CoreSimulator.SimDeviceType.iPhone-16', 'com.apple.CoreSimulator.SimRuntime.iOS-26-2')
        (OUT / 'owned-simulator.txt').write_text(device)
        cmd('xcrun', 'simctl', 'boot', device); cmd('xcrun', 'simctl', 'bootstatus', device, '-b')
        cmd('xcrun', 'simctl', 'install', device, OUT / 'BackgroundProbe.app')
        docs = Path(cmd('xcrun', 'simctl', 'get_app_container', device, BUNDLE, 'data')) / 'Documents'
        docs.mkdir(exist_ok=True)
        def launch(config):
            (docs / 'result.json').unlink(missing_ok=True)
            (docs / 'config.json').write_text(json.dumps(config))
            text = cmd('xcrun', 'simctl', 'launch', device, BUNDLE)
            return int(text.rsplit(':', 1)[1].strip())
        def terminate(): cmd('xcrun', 'simctl', 'terminate', device, BUNDLE, check=False)
        launch({'mode': 'unit'})
        result = wait(lambda: read_json(docs / 'result.json'))
        summary['unit'] = result
        assert result['ok'], result
        print('Native cases:', len(result['cases']), flush=True)
        if '--unit-only' in sys.argv: return
        terminate()
        shutil.rmtree(docs / 'unit')
        for point in ['consumed', 'encrypted', 'groupPublished']:
            service = 'test.footage.crash.' + str(uuid.uuid4())
            (docs / 'checkpoint.json').unlink(missing_ok=True)
            launch({'mode': 'crash', 'service': service, 'point': point})
            wait(lambda: read_json(docs / 'checkpoint.json'))
            terminate()
            launch({'mode': 'recover', 'service': service})
            result = wait(lambda: read_json(docs / 'result.json'))
            assert result['ok'] and result['intents'] > 0, result
            summary.setdefault('abruptExitReopen', []).append(point)
            terminate(); shutil.rmtree(docs / 'runtime')
        certs()
        for name in ['root.der', 'leaf.der']: shutil.copyfile(OUT / name, docs / name)
        log = (OUT / 'listener.log').open('w')
        listener = subprocess.Popen([str(ROOT / 'node_modules/.bin/tsx'), str(SOURCE / 'listener.mjs'), str(OUT), str(docs)], stdout=log, stderr=subprocess.STDOUT)
        port = wait(lambda: read_json(OUT / 'listener-ready.json'))['port']
        service = 'test.footage.network.' + str(uuid.uuid4())
        pid = launch({'mode': 'network', 'port': port, 'service': service})
        scheduled = wait(lambda: read_json(docs / 'scheduled.json'))
        assert scheduled['ok'] and scheduled['groups'] == 3 and scheduled['confirmedBytes'] == 0, scheduled
        summary['scheduled'] = scheduled
        runtime_files = [p for p in (docs / 'runtime').rglob('*') if p.is_file()]
        summary['storageObservation'] = {
            'stagedOriginalBytes': (docs / 'runtime/private/original').stat().st_size,
            'sealedBodyBytes': sum(p.stat().st_size for p in (docs / 'runtime').glob('*.sealed')),
            'runtimeLogicalBytes': sum(p.stat().st_size for p in runtime_files),
            'runtimeAllocatedBytes': sum(p.stat().st_blocks * 512 for p in runtime_files),
            'daemonOwnedSnapshotAllocationMeasured': False,
            'universalStorageOrRSSBoundClaimed': False,
        }
        # Explicit device UUID: never select the user's booted Simulator.
        home_log = cmd('xcodebuild', 'test', '-project', OUT / 'BackgroundProbe.xcodeproj', '-scheme', 'Home',
            '-destination', f'platform=iOS Simulator,id={device}', '-parallel-testing-enabled', 'NO',
            '-only-testing:HomeTests/HomeTests/testHome',
            '-derivedDataPath', OUT / 'home-build', 'CODE_SIGN_IDENTITY=-', 'CODE_SIGNING_ALLOWED=YES')
        (OUT / 'home.log').write_text(home_log)
        assert '** TEST SUCCEEDED **' in home_log
        wait(lambda: read_json(docs / 'background.json'))
        os.kill(pid, signal.SIGSTOP); stopped_pid = pid
        assert 'T' in cmd('ps', '-o', 'state=', '-p', pid)
        start = read_json(OUT / 'listener-state.json')
        (OUT / 'release').write_text('owned-native-background-and-stopped')
        # Independently observe the daemon owning a loopback socket while app is stopped.
        time.sleep(1)
        services = cmd('xcrun', 'simctl', 'spawn', device, 'launchctl', 'list')
        daemon_pids = [line.split()[0] for line in services.splitlines() if 'nsurlsessiond' in line and line.split()[0].isdigit()]
        socket_owner = False
        for daemon_pid in daemon_pids:
            sockets = cmd('/usr/sbin/lsof', '-nP', '-a', '-p', daemon_pid, '-iTCP', check=False)
            socket_owner |= bool(re.search(r':' + str(port) + r'\b', sockets))
        received = wait(lambda: (s if (s := read_json(OUT / 'listener-state.json')) and s['groups'] == 3 else None), 180)
        assert 'T' in cmd('ps', '-o', 'state=', '-p', pid)
        assert received['wholeHashMatched'] and all(received['wireMatches']) and received['errors'] == 0, received
        assert received['authHeaders'] == 0 and received['cookieHeaders'] == 0, received
        assert socket_owner
        summary['daemon'] = {'enteredBackground': True, 'mechanism': 'XCTest XCUIDevice.press(.home) on explicit owned destination', 'processStopped': True,
            'bodyBytesAtStop': start['bodyBytes'] if start else 0, 'bodyBytesWhileStopped': received['bodyBytes'], 'daemonOwnsReceiverSocket': socket_owner,
            'allGroupsAuthenticated': True, 'wholeOriginalHashMatched': True, 'exactSavedWireMatched': all(received['wireMatches']), 'authorizationHeaders': 0, 'cookieHeaders': 0}
        # Memory/disk observations are scoped to this workload, not a bound for 4 GiB.
        summary['appOwnedBytesAfterSchedule'] = sum(p.stat().st_size for p in docs.rglob('*') if p.is_file())
        os.kill(pid, signal.SIGCONT); stopped_pid = None
        # Natural suspension may keep app timers/delegate processing asleep after SIGCONT.
        # Bring back this owned app only AFTER all daemon bytes authenticated independently.
        return_log = cmd('xcodebuild', 'test-without-building', '-project', OUT / 'BackgroundProbe.xcodeproj', '-scheme', 'Home',
            '-destination', f'platform=iOS Simulator,id={device}', '-parallel-testing-enabled', 'NO',
            '-only-testing:HomeTests/HomeTests/testReturn', '-derivedDataPath', OUT / 'home-build')
        (OUT / 'return.log').write_text(return_log)
        assert '** TEST EXECUTE SUCCEEDED **' in return_log
        result = wait(lambda: read_json(docs / 'result.json'), 120)
        assert result['ok'] and result['phase'] == 'verifying' and not result['received'], result
        summary['chunkOnlyLedgerAfterForegroundReturn'] = result
        # Delete generated Keychain data by uninstalling/deleting the disposable device below.
        terminate()
    finally:
        if stopped_pid:
            try: os.kill(stopped_pid, signal.SIGCONT)
            except ProcessLookupError: pass
        if listener:
            listener.terminate()
            try: listener.wait(10)
            except subprocess.TimeoutExpired: listener.kill(); listener.wait()
        if device:
            try: cmd('xcrun', 'simctl', 'shutdown', device, check=False)
            finally: cmd('xcrun', 'simctl', 'delete', device)
        summary['ownedSimulatorDeleted'] = device is None or device not in cmd('xcrun', 'simctl', 'list', 'devices', '-j')
        summary['ownedListenerStopped'] = listener is None or listener.poll() is not None
        (OUT / 'safe-summary.json').write_text(json.dumps(summary, indent=2))
        print('Owned resources cleaned; ignored artifacts:', OUT, flush=True)


if __name__ == '__main__': main()
