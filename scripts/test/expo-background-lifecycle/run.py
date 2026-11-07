#!/usr/bin/env python3
"""Owned actual Expo 58 Release + compile-time no-JS paired test build. No EAS.
Never invokes the subscriber callback. SIGKILL is an OS-style abrupt exit, not jetsam
proof; automatic callback/relaunch is reported only if actually observed.
"""
import hashlib
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('runtime_runner', SOURCE.parent / 'ios-background-runtime/run.py')
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
ROOT = r.ROOT
BASE = ROOT / 'artifacts/expo-background-lifecycle'
OUT = BASE / str(uuid.uuid4())
r.OUT = OUT
APPROOT = ROOT / 'apps/mobile'
BUNDLE = 'dev.footage.spike'
BUILD = BASE / 'owned-build-control-7c12d930'
APP = BUILD / 'Build/Products/Release-iphonesimulator/Footage.app'

def execute(args, log, cwd=ROOT, env=None):
    with (OUT / log).open('w') as f:
        result = subprocess.run([str(x) for x in args], cwd=cwd, env=env, stdout=f, stderr=subprocess.STDOUT)
    if result.returncode: raise RuntimeError(f'{log}: exit {result.returncode}')

def build(test=False):
    required = 6 if BUILD.exists() else 13
    if shutil.disk_usage(ROOT).free < required * 1024**3:
        raise RuntimeError(f'Need {required} GiB free (6 GiB margin); never delete others caches')
    env = dict(os.environ)
    env.pop('FOOTAGE_EXPO_LIFECYCLE_TEST', None)
    if test: env['FOOTAGE_EXPO_LIFECYCLE_TEST'] = '1'
    execute(['pod', 'install'], 'pods-test.log' if test else 'pods-normal.log', APPROOT / 'ios', env)
    provider = APPROOT / 'ios/Pods/Target Support Files/Pods-Footage/ExpoModulesProvider.swift'
    text = provider.read_text()
    assert text.count('FootageTransferAppDelegateSubscriber.self') == 2
    assert text.count('(module: FootageTransferModule.self, name: nil)') == 2
    shutil.copyfile(provider, OUT / ('provider-test.swift' if test else 'provider-normal.swift'))
    args = ['xcodebuild', '-workspace', APPROOT / 'ios/Footage.xcworkspace', '-scheme', 'Footage', '-configuration', 'Release',
        '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', BUILD,
        '-jobs', '2', 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES', 'CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_IDENTITY=-']
    if test: args += ['SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) FOOTAGE_EXPO_LIFECYCLE_TEST']
    execute(args, 'build-test.log' if test else 'build-normal.log', env=env)
    if shutil.disk_usage(ROOT).free < 6 * 1024**3: raise RuntimeError('Build used the 6 GiB safety margin')
    assert (APP / 'main.jsbundle').stat().st_size > 100000
    binary = (APP / 'Footage').read_bytes()
    assert (b'ExpoLifecycleFixture' in binary) == test
    if not test:
        assert b'DurableTestControl' not in binary and b'generated-original' not in binary
        assert b'HarnessWait' not in binary
    assert b'FootageBackgroundSessionRouter' in binary
    # Preserve each final product before the next variant overwrites Products.
    preserved = OUT / ('test.app' if test else 'restored-ordinary.app' if (OUT / 'ordinary.app').exists() else 'ordinary.app')
    assert not preserved.exists()
    shutil.copytree(APP, preserved, symlinks=True)
    return hashlib.sha256(binary).hexdigest()

def driver_project():
    project = (ROOT / 'scripts/pairing-probe/project.pbxproj').read_text()
    project = project.replace('TransportProbe', 'LifecycleDriver').replace('test.footage.transportprobe', 'test.footage.expolifecycledriver')
    project = project.replace('Probe.swift', 'Driver.swift').replace('com.apple.product-type.application', 'com.apple.product-type.bundle.ui-testing')
    project = project.replace('wrapper.application', 'wrapper.cfbundle').replace('LifecycleDriver.app', 'LifecycleDriver.xctest')
    project = project.replace('INFOPLIST_FILE = Info.plist;', 'GENERATE_INFOPLIST_FILE = YES;')
    project = project.replace('SWIFT_VERSION = 5.0;', 'SWIFT_VERSION = 6.0; SWIFT_TREAT_WARNINGS_AS_ERRORS = YES;')
    p = OUT / 'LifecycleDriver.xcodeproj'; p.mkdir()
    (p / 'project.pbxproj').write_text(project)
    shutil.copyfile(SOURCE / 'Driver.swift', OUT / 'Driver.swift')
    schemes = p / 'xcshareddata/xcschemes'; schemes.mkdir(parents=True)
    ref = '<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A00000000000000000000005" BuildableName="LifecycleDriver.xctest" BlueprintName="LifecycleDriver" ReferencedContainer="container:LifecycleDriver.xcodeproj"/>'
    (schemes / 'Driver.xcscheme').write_text(f'<?xml version="1.0" encoding="UTF-8"?><Scheme version="1.3"><BuildAction buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES">{ref}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.PosixSpawn"><Testables><TestableReference skipped="NO">{ref}</TestableReference></Testables></TestAction></Scheme>')
    return p

def state(docs):
    return r.read_json(docs / 'native-state.json')

def main():
    OUT.mkdir(parents=True, mode=0o700)
    if os.environ.get('FOOTAGE_TEST_KEYCHAIN') != '1':
        raise SystemExit('Opt in with FOOTAGE_TEST_KEYCHAIN=1 for one fresh exact recorded macOS test Keychain item')
    r.cmd('git', 'check-ignore', OUT / 'private.key')
    two_wakes = '--two-wakes' in sys.argv
    valid_outcomes = '--valid-outcomes' in sys.argv or two_wakes
    slow_control = '--slow-control' in sys.argv
    assert not slow_control or two_wakes, 'Held-control proof requires --two-wakes'
    summary = {'testBuildOnly': True, 'slowControlRequested': slow_control, 'validOutcomes': valid_outcomes, 'twoWakesRequested': two_wakes, 'productionPairingProven': False, 'actualPairedControl': True, 'syntheticInjectedControl': False, 'g5Passed': False,
        'physicalLockProven': False, 'callbackManuallyInvoked': False, 'xcode': r.cmd('xcodebuild', '-version')}
    device = listener = docs = None
    key_cleanup_pending = False
    paired_source = ROOT / 'scripts/paired-background-integration'
    # Prove the committed plugin survives clean generation, then repeated generation.
    execute(['npx', '--no-install', 'expo', 'prebuild', '--platform', 'ios', '--clean', '--no-install'], 'prebuild-clean.log', APPROOT, dict(os.environ, CI='1'))
    generated_delegate = APPROOT / 'ios/Footage/AppDelegate.swift'
    routed = generated_delegate.read_bytes()
    execute(['npx', '--no-install', 'expo', 'prebuild', '--platform', 'ios', '--no-install'], 'prebuild-again.log', APPROOT, dict(os.environ, CI='1'))
    assert generated_delegate.read_bytes() == routed
    execute(['node', '--test', SOURCE / 'plugin.test.cjs'], 'plugin-tests.log')
    summary['cleanPrebuildAndRepeatedPluginIdempotent'] = True
    summary['generatedRouterSHA256'] = hashlib.sha256(routed).hexdigest()
    scene = APPROOT / 'ios/Footage/SceneDelegate.swift'
    appdelegate = APPROOT / 'ios/Footage/AppDelegate.swift'
    original_scene = scene.read_text()
    original_appdelegate = appdelegate.read_text()
    test_installed = False
    try:
        summary['normalBinarySHA256'] = build()
        summary['embeddedJSSHA256'] = hashlib.sha256((APP / 'main.jsbundle').read_bytes()).hexdigest()
        project = driver_project()
        device = r.cmd('xcrun', 'simctl', 'create', 'Owned Expo Lifecycle Proof',
            'com.apple.CoreSimulator.SimDeviceType.iPhone-16', 'com.apple.CoreSimulator.SimRuntime.iOS-26-2')
        (OUT / 'owned-simulator.txt').write_text(device)
        r.cmd('xcrun', 'simctl', 'boot', device); r.cmd('xcrun', 'simctl', 'bootstatus', device, '-b')
        r.cmd('xcrun', 'simctl', 'install', device, APP)
        def launch(): return int(r.cmd('xcrun', 'simctl', 'launch', device, BUNDLE).rsplit(':', 1)[1].strip())
        def terminate(): r.cmd('xcrun', 'simctl', 'terminate', device, BUNDLE, check=False)
        def drive(method, first=False):
            execute(['xcodebuild', 'test' if first else 'test-without-building', '-project', project, '-scheme', 'Driver',
                '-destination', f'platform=iOS Simulator,id={device}', '-parallel-testing-enabled', 'NO',
                f'-only-testing:LifecycleDriver/LifecycleDriver/{method}', '-derivedDataPath', OUT / 'driver-build',
                'CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_IDENTITY=-'], method + '-' + str(time.time_ns()) + '.log')
        launch(); drive('testNormalPicker', first=True)
        summary['normalEmbeddedJSPickerCancelPreviewOnly'] = True
        terminate()
        docs = Path(r.cmd('xcrun', 'simctl', 'get_app_container', device, BUNDLE, 'data')) / 'Documents'
        docs.mkdir(exist_ok=True)
        # Only bounded test waits + existing native UNIT helpers; the actual OS path
        # uses production PairingClient/BackgroundControl/Trust, never mailbox control.
        adapter = (paired_source / 'Probe.swift').read_text().split('@main\n')[0]
        tests = (SOURCE.parent / 'ios-background-runtime/Tests.swift').read_text()
        helpers = 'import SQLite3\n' + tests[tests.index('final class TestControl:'):tests.index('final class DeferredEnumerationDaemon:')]
        for start, end in [('func testState(', 'func testAwait('), ('func testAwait(', 'func testEvent('),
                           ('func testSelection(', 'func runRuntimeTests(')]:
            helpers += tests[tests.index(start):tests.index(end)]
        fixture = '#if FOOTAGE_EXPO_LIFECYCLE_TEST\n' + adapter + '\n' + helpers + '\n' + (SOURCE / 'HostTests.swift').read_text() + '\n' + (SOURCE / 'RuntimeDrainProbe.swift').read_text() + '\n#endif\n' + (SOURCE / 'Fixture.swift').read_text()
        generated = APPROOT / 'modules/footage-transfer/ios/build/lifecycle-test/Fixture.generated.swift'
        generated.parent.mkdir(parents=True, exist_ok=True)
        r.cmd('git', 'check-ignore', generated)
        generated.write_text(fixture)
        # Only the disposable test build skips startReactNative. ExpoAppDelegate, module
        # loader/provider and scene lifecycle forwarding are still the actual Expo code.
        assert 'class SceneDelegate: ExpoAppSceneDelegate {' in original_scene
        scene.write_text(original_scene.replace('  // Extension point for config plugins.', '''  #if FOOTAGE_EXPO_LIFECYCLE_TEST
  override func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: scene)
    window.rootViewController = UIViewController()
    window.rootViewController?.view.backgroundColor = .systemBackground
    self.window = window
    window.makeKeyAndVisible()
    // Deliberately NO super: do not call factory.startReactNative in this test build.
  }
  #endif'''))
        # Observe the REAL UIKit completion around the existing production route,
        # not an extra override/subscriber call. Only OS callback entry runs this.
        start = '    if FootageBackgroundSessionRouter.handle(identifier, completionHandler: completionHandler) {'
        assert original_appdelegate.count(start) == 1
        instrumented = original_appdelegate.replace(start, '''    let callbackStarted = Date().timeIntervalSince1970
    let systemCompletion = {
      precondition(Thread.isMainThread)
      let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      let file = docs.appendingPathComponent("aggregate-completion.json")
      var count = 0
      if let bytes = try? Data(contentsOf: file),
        let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] { count = object["count"] as? Int ?? 0 }
      // This file exists only after the native contribution independently reopens
      // the FULL/WAL ledger. Reading it here witnesses ordering at outer handoff.
      let ledgerBytes = try! Data(contentsOf: docs.appendingPathComponent("completion-ledger.json"))
      let ledger = try! JSONSerialization.jsonObject(with: ledgerBytes)
      let bytes = try! JSONSerialization.data(withJSONObject: ["count": min(count + 1, 1000), "main": true,
        "afterDurableLedger": ledger, "seconds": Date().timeIntervalSince1970 - callbackStarted,
        "callbackStarted": callbackStarted,
        "controlSocketPending": FileManager.default.fileExists(atPath: docs.appendingPathComponent("control-socket-pending.json").path),
        "controlReturned": FileManager.default.fileExists(atPath: docs.appendingPathComponent("native-control-ended.json").path)])
      try! bytes.write(to: file, options: .atomic)
      completionHandler()
    }
    if FootageBackgroundSessionRouter.handle(identifier, completionHandler: systemCompletion) {''')
        instrumented = instrumented.replace('super.application(application, handleEventsForBackgroundURLSession: identifier, completionHandler: completionHandler)',
            'super.application(application, handleEventsForBackgroundURLSession: identifier, completionHandler: systemCompletion)')
        appdelegate.write_text(instrumented)
        test_installed = True
        summary['testBinarySHA256'] = build(test=True)
        r.cmd('xcrun', 'simctl', 'install', device, APP)
        docs = Path(r.cmd('xcrun', 'simctl', 'get_app_container', device, BUNDLE, 'data')) / 'Documents'
        docs.mkdir(exist_ok=True)
        # Test-only filesystem mode cannot enable anything in an ordinary binary.
        service = 'test.footage.expolifecycle.' + str(uuid.uuid4())
        def configure(mode):
            for name in ['native-state.json', 'lifecycle.json', 'completion-ledger.json', 'aggregate-completion.json',
                         'native-control-start.json', 'native-control-ended.json']:
                (docs / name).unlink(missing_ok=True)
            (docs / 'lifecycle-config.json').write_text(json.dumps({'mode': mode, 'service': service,
                'slowControl': 'true' if slow_control else 'false'}))
        configure('unit'); launch()
        host = r.wait(lambda: r.read_json(docs / 'host-tests.json'))
        assert host['ok'], host
        summary['hostUnitCases'] = host['cases']
        drain_probe = r.wait(lambda: r.read_json(docs / 'runtime-drain-probe.json'))
        assert 'error' not in drain_probe, drain_probe
        summary['runtimeEnumerationDrainRaceReproduced'] = drain_probe['finishDuringEnumerationLeavesPendingToken']
        shutil.copyfile(docs / 'runtime-drain-probe.json', OUT / 'runtime-drain-probe.json')
        terminate()
        assert drain_probe['unavailableControlDrainedWithDurableUncertainty']
        assert drain_probe['unavailableControlSeconds'] < 5, drain_probe
        summary['immediateUnavailableControlDurableDefer'] = True
        summary['slowNetworkDeadlineProven'] = False
        r.certs()
        r.cmd('xcrun', 'swiftc', '-swift-version', '6', '-warnings-as-errors',
            ROOT / 'apps/server/src/desktop-key-store-helper.swift', '-o', OUT / 'key-helper')
        import socket
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        receiver_config = {'namespace': 'test.' + str(uuid.uuid4()), 'origin': f'https://localhost:{port}',
            'port': port, 'intake': str(uuid.uuid4()), 'validOutcomes': valid_outcomes, 'twoWakes': two_wakes,
            'holdControl': slow_control}
        # Record the exact account BEFORE initialization, and arm finally BEFORE any
        # constructor can fail. Never enumerate or delete any pre-existing item.
        (OUT / 'receiver-config.json').write_text(json.dumps(receiver_config))
        (OUT / 'keychain-cleanup-pending.json').write_text(json.dumps({'namespace': receiver_config['namespace']}))
        key_cleanup_pending = True
        r.cmd(ROOT / 'node_modules/.bin/tsx', paired_source / 'key-store.mjs', OUT, 'initialize')
        log = (OUT / 'listener.log').open('w')
        adapter = paired_source / 'listener.mjs'
        summary['existingPairedAdapterSHA256'] = hashlib.sha256(adapter.read_bytes()).hexdigest()
        if valid_outcomes: (OUT / 'respond-final').write_text('valid-response-test-only')
        listener = subprocess.Popen([str(ROOT / 'node_modules/.bin/tsx'), str(adapter), str(OUT), str(docs)], stdout=log, stderr=subprocess.STDOUT)
        ready = r.wait(lambda: r.read_json(OUT / 'listener-ready.json'))
        configure('enroll'); launch()
        r.wait(lambda: r.read_json(OUT / 'awaiting-local-approval.json'))
        (OUT / 'operator-approve').write_text('Independent local test operator approves generated device and exact intake')
        enrolled = r.wait(lambda: r.read_json(docs / 'enrolled.json'))
        assert enrolled['ok'] and enrolled['actualNativeEnrollmentAndRecovery'], enrolled
        summary['nativeGeneratedDeviceIndependentQRLocalApprovalTLSRecovery'] = True
        terminate()
        configure('prepare'); pid = launch()
        queued = r.wait(lambda: (s if (s := state(docs)) and s.get('backgroundReady') else None), 180)
        assert queued['groups'] == 2 and queued['bridgeCreated'] == 0 and queued['privateDeniedBeforeBackground'], queued
        shutil.copyfile(docs / 'native-state.json', OUT / 'scheduled.json')
        drive('testHome')
        r.wait(lambda: (s if (s := r.read_json(docs / 'lifecycle.json')) and s['counts'].get('enteredBackground') else None))
        shutil.copyfile(docs / 'lifecycle.json', OUT / 'before-termination-lifecycle.json')
        # SIGKILL is not simctl terminate / userkill. Simulator may still not relaunch;
        # wait without activating or manually forwarding any callback.
        os.kill(pid, signal.SIGKILL)
        configure('restore')
        services = r.cmd('xcrun', 'simctl', 'spawn', device, 'launchctl', 'list')
        daemon_pids = [line.split()[0] for line in services.splitlines() if 'nsurlsessiond' in line and line.split()[0].isdigit()]
        summary['daemonSocketObserved'] = any(':' + str(ready['port']) in r.cmd('/usr/sbin/lsof', '-nP', '-a', '-p', p, '-iTCP', check=False) for p in daemon_pids)
        (OUT / 'release').write_text('owned-expo-background-abrupt-exit')
        if two_wakes:
            deadline = time.monotonic() + 75
            first_completion = None
            while time.monotonic() < deadline:
                first_completion = r.read_json(docs / 'completion-ledger.json')
                if first_completion: break
                time.sleep(.2)
            summary['firstOSWakeDrainedBeforeSecondGroup'] = bool(first_completion)
            if first_completion:
                first_life = r.read_json(docs / 'lifecycle.json')
                assert first_life and first_life['pid'] != pid and first_life['counts'].get('ownedCallback') == 1
                assert first_completion['main'] and first_completion['confirmedBytes'] == 67108864
                assert first_completion['completions'] == first_completion['ownedCallbacks'] == 1
                assert first_life['counts'].get('bridgeCreated', 0) == 0
                assert not first_completion['hasReceipt']
                shutil.copyfile(docs / 'lifecycle.json', OUT / 'first-os-lifecycle.json')
                shutil.copyfile(docs / 'completion-ledger.json', OUT / 'first-os-completion.json')
                # Observe the outer UIKit completion separately from the native
                # contribution. The owned event must never enter Expo aggregation.
                aggregate_deadline = time.monotonic() + 30
                while time.monotonic() < aggregate_deadline and not r.read_json(docs / 'aggregate-completion.json'):
                    time.sleep(.2)
                first_aggregate = r.read_json(docs / 'aggregate-completion.json')
                assert first_aggregate and first_aggregate['count'] == 1 and first_aggregate['main'], first_aggregate
                assert first_aggregate['afterDurableLedger'] == first_completion and first_aggregate['seconds'] < 10
                summary['firstOuterUIKitCompletionObserved'] = True
                summary['firstOuterCompletionCount'] = first_aggregate['count']
                summary['firstOuterCompletionSeconds'] = first_aggregate['seconds']
                shutil.copyfile(docs / 'aggregate-completion.json', OUT / 'first-os-aggregate.json')
                if slow_control:
                    rendezvous = r.read_json(docs / 'slow-control-rendezvous.json')
                    assert rendezvous and rendezvous['testOnlyEarlyRestoreRendezvous']
                    summary['testOnlyEarlyRestoreRendezvous'] = True
                    summary['testOnlyEarlyRestoreRendezvousSeconds'] = rendezvous['seconds']
                    shutil.copyfile(docs / 'slow-control-rendezvous.json', OUT / 'slow-control-rendezvous.json')
                    pending = r.read_json(OUT / 'control-socket-pending.json')
                    native_start = r.read_json(docs / 'native-control-start.json')
                    summary['heldControlAtFirstOuterCompletion'] = bool(first_aggregate['controlSocketPending'])
                    summary['firstLocalUncertainGroups'] = first_completion['uncertainGroups']
                    summary['controlSocketEnteredBeforeOwnedCallback'] = bool(pending and pending['started'] < first_aggregate['callbackStarted'])
                    assert pending and native_start, 'Startup did not issue real paired control'
                    summary['nativeControlStartedBeforeOwnedCallback'] = native_start['started'] < first_aggregate['callbackStarted']
                    assert native_start['started'] < first_aggregate['callbackStarted'], 'Native startup control must precede the OS callback'
                    assert first_completion['completedAt'] - native_start['started'] < 5
                    assert not first_aggregate['controlReturned'], 'Not an in-flight control request at outer completion'
                    shutil.copyfile(docs / 'native-control-start.json', OUT / 'first-native-control-start.json')
                    assert first_aggregate['controlSocketPending'] and first_completion['controlSocketPending'], 'Outer completed before held TLS socket entered'
                    assert not (OUT / 'control-released.json').exists()
                    summary['heldControlFirstOuterGapSeconds'] = first_completion['completedAt'] - pending['started']
                    summary['slowNetworkDeadlineProven'] = True
                    # Hold the real TLS response well beyond the handoff, not an immediate
                    # refusal. No application timer/extra finish event makes progress.
                    time.sleep(10)
                    assert not (docs / 'native-control-ended.json').exists()
                    assert r.read_json(docs / 'aggregate-completion.json')['count'] == 1
                    summary['controlStillPendingTenSecondsAfterOuter'] = True
                    summary['nativeStartToOuterSeconds'] = first_completion['completedAt'] - native_start['started']
                    # Kill AFTER OS completion, WITHOUT releasing that control request.
                    # Next wake must recover from the durable uncertainty, not its response.
                os.kill(first_life['pid'], signal.SIGKILL)
                configure('restore')
            assert summary['firstOSWakeDrainedBeforeSecondGroup'], 'No first actual OS drain/completion'
            if slow_control: (OUT / 'control-release').write_text('owned-local-controller-releases-response-after-first-outer-and-process-exit')
            (OUT / 'second-release').write_text('second-native-event-batch')
        if slow_control:
            released = r.wait(lambda: r.read_json(OUT / 'control-released.json'))
            summary['heldTLSSocketSeconds'] = released['released'] - released['started']
            assert summary['heldTLSSocketSeconds'] >= 10
        actual = r.wait(lambda: r.read_json(OUT / 'actual-receipt.json'), 240)
        transferred = r.wait(lambda: r.read_json(OUT / 'listener-state.json'))
        assert transferred['wholeHashMatched'] and all(transferred['wireMatches']), transferred
        assert actual['jobCount'] == 1 and actual['receipt']['sha256'] == actual['independent']['sha256']
        summary['actualG3ReceiptWhileExpoNotRunning'] = True
        summary['originalBytes'] = actual['independent']['bytes']; summary['groups'] = 2
        summary['noCredentialsOnIngest'] = transferred['authHeaders'] == transferred['cookieHeaders'] == 0
        # Bounded observation window, not a claim that the OS must wake within it.
        deadline = time.monotonic() + 75
        while time.monotonic() < deadline:
            life = r.read_json(docs / 'lifecycle.json')
            if life and life['counts'].get('ownedCallback') and r.read_json(docs / 'completion-ledger.json'):
                if (not valid_outcomes or (state(docs) or {}).get('phase') == 'received') and r.read_json(docs / 'aggregate-completion.json'): break
            time.sleep(1)
        life = r.read_json(docs / 'lifecycle.json')
        summary['osDrivenCallbackObserved'] = bool(life and life['counts'].get('ownedCallback'))
        summary['osDrivenLaunchObserved'] = bool(life and life['counts'].get('factoryBeforeJS'))
        summary['osLaunchDifferentPID'] = bool(life and life['pid'] != pid)
        assert summary['osLaunchDifferentPID']
        if two_wakes: assert life['pid'] != first_life['pid']
        summary['osCallbackBatches'] = (life['counts'].get('ownedCallback', 0) if life else 0) + int(summary.get('firstOSWakeDrainedBeforeSecondGroup', False))
        summary['osBridgeCreations'] = life['counts'].get('bridgeCreated', 0) if life else 0
        if life: shutil.copyfile(docs / 'lifecycle.json', OUT / 'os-lifecycle.json')
        completion = r.read_json(docs / 'completion-ledger.json')
        summary['nativeCompletionAfterDrainObserved'] = bool(completion and completion['main'] and completion['completions'] == completion['ownedCallbacks'] == 1)
        if completion: shutil.copyfile(docs / 'completion-ledger.json', OUT / 'os-completion-ledger.json')
        aggregate = r.read_json(docs / 'aggregate-completion.json')
        summary['outerUIKitSystemCompletionObserved'] = bool(aggregate)
        assert aggregate and aggregate['count'] == 1 and aggregate['main'], aggregate
        assert aggregate['afterDurableLedger'] == completion and aggregate['seconds'] < 10
        summary['finalOuterCompletionCount'] = aggregate['count']
        summary['finalOuterCompletionSeconds'] = aggregate['seconds']
        shutil.copyfile(docs / 'aggregate-completion.json', OUT / 'os-aggregate-completion.json')
        os_final = state(docs) or {}
        if os_final: shutil.copyfile(docs / 'native-state.json', OUT / 'os-native-state.json')
        summary['osWakeMatchingNativeReceipt'] = bool(os_final.get('phase') == 'received'
            and os_final.get('receiptID') == actual['receipt']['id']
            and os_final.get('sha256') == actual['independent']['sha256']
            and os_final.get('confirmedBytes') == actual['independent']['bytes'])
        if valid_outcomes:
            assert summary['osWakeMatchingNativeReceipt'] and summary['osBridgeCreations'] == 0, os_final
            assert summary['nativeCompletionAfterDrainObserved']
            assert completion['phase'] == 'received' and completion['hasReceipt']
            assert completion['confirmedBytes'] == actual['independent']['bytes']
        # Explicit foreground relaunch is separately labelled, NOT a cold OS wake.
        terminate(); configure('restore'); launch()
        final = r.wait(lambda: (s if (s := state(docs)) and s.get('phase') == 'received' else None), 120)
        assert final['receiptID'] == actual['receipt']['id'] and final['jobID'] == actual['receipt']['jobId']
        assert final['sha256'] == actual['independent']['sha256'] and final['bytes'] == actual['independent']['bytes']
        assert final['bridgeCreated'] == 0 and final['privateDeniedBeforeBackground']
        try:
            (docs / 'runtime/private/manifest').read_bytes()
        except PermissionError:
            summary['privateManifestStillPermissionDeniedAfterWakes'] = True
        else:
            raise AssertionError('Protected manifest unexpectedly readable')
        summary['explicitNativeRelaunchNoJSSameDurableReceipt'] = True
        summary['g5Passed'] = False # Full G5/activation/physical gates are not implied by this slice
        summary['actualOSOuterCompletionPassed'] = True
        assert summary['osCallbackBatches'] == (2 if two_wakes else 1)
        assert summary['noCredentialsOnIngest'] and summary['daemonSocketObserved']
        assert not transferred['reusableCredentialInBody'] and not transferred['generationMasterInBody']
        summary['pairedBodiesContainNoReusableCredentialOrGenerationMaster'] = True
        shutil.copyfile(docs / 'native-state.json', OUT / 'native-final.json')
        print(json.dumps(summary, indent=2), flush=True)
    finally:
        cleanup_errors = []
        def cleanup(label, operation):
            try: operation()
            except BaseException as error: cleanup_errors.append(label + ': ' + str(error))
        def stop_listener():
            if listener:
                listener.terminate()
                try: listener.wait(20)
                except subprocess.TimeoutExpired: listener.kill(); listener.wait()
        cleanup('listener shutdown', stop_listener)
        # Exact deletion is independent of shutdown success. Keep pending metadata
        # if deletion fails, even if initialization itself threw after creating it.
        if key_cleanup_pending:
            def delete_key():
                r.cmd(ROOT / 'node_modules/.bin/tsx', paired_source / 'key-store.mjs', OUT, 'delete')
                (OUT / 'keychain-cleanup-pending.json').unlink()
                summary['exactNewUUIDKeychainItemDeleted'] = True
            cleanup('exact Keychain deletion', delete_key)
        def save_evidence():
            if docs:
                for name in ['native-state.json', 'lifecycle.json', 'host-tests.json', 'completion-ledger.json', 'aggregate-completion.json']:
                    if (docs / name).exists(): shutil.copyfile(docs / name, OUT / ('last-' + name))
                private = docs / 'runtime/private'
                if private.exists(): private.chmod(0o700)
        cleanup('save evidence', save_evidence)
        if device:
            cleanup('sim shutdown', lambda: r.cmd('xcrun', 'simctl', 'shutdown', device, check=False))
            cleanup('sim deletion', lambda: r.cmd('xcrun', 'simctl', 'delete', device))
        cleanup('restore SceneDelegate', lambda: scene.write_text(original_scene))
        cleanup('restore routed AppDelegate', lambda: appdelegate.write_text(original_appdelegate))
        # Rebuild and inspect the actual ordinary artifact after removing test flags.
        if test_installed:
            def restore_normal():
                summary['restoredNormalBinarySHA256'] = build()
                assert 'FOOTAGE_EXPO_LIFECYCLE_TEST' not in appdelegate.read_text() + scene.read_text()
            cleanup('ordinary Release rebuild', restore_normal)
        summary['ownedSimulatorDeleted'] = device is None or device not in r.cmd('xcrun', 'simctl', 'list', 'devices', '-j')
        summary['ownedListenerStopped'] = listener is None or listener.poll() is not None
        summary['cleanupErrors'] = cleanup_errors
        (OUT / 'safe-summary.json').write_text(json.dumps(summary, indent=2))
        print('Ignored artifacts:', OUT, flush=True)
        if cleanup_errors: raise RuntimeError('Cleanup failed; see private metadata: ' + '; '.join(cleanup_errors))

if __name__ == '__main__': main()
