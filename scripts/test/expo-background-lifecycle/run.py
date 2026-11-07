#!/usr/bin/env python3
"""Owned actual Expo 58 Release + compile-time no-JS test build. No EAS/real pairing.
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
BUILD = BASE / 'build'
APP = BUILD / 'Build/Products/Release-iphonesimulator/Footage.app'

def execute(args, log, cwd=ROOT, env=None):
    with (OUT / log).open('w') as f:
        result = subprocess.run([str(x) for x in args], cwd=cwd, env=env, stdout=f, stderr=subprocess.STDOUT)
    if result.returncode: raise RuntimeError(f'{log}: exit {result.returncode}')

def build(test=False):
    if shutil.disk_usage(ROOT).free < 8 * 1024**3: raise RuntimeError('Need 8 GiB free; never delete others caches')
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
    assert (APP / 'main.jsbundle').stat().st_size > 100000
    binary = (APP / 'Footage').read_bytes()
    assert (b'ExpoLifecycleFixture' in binary) == test
    if not test:
        assert b'DurableTestControl' not in binary and b'generated-original' not in binary
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
    r.cmd('git', 'check-ignore', OUT / 'private.key')
    two_wakes = '--two-wakes' in sys.argv
    valid_outcomes = '--valid-outcomes' in sys.argv or two_wakes
    summary = {'testBuildOnly': True, 'validOutcomes': valid_outcomes, 'twoWakesRequested': two_wakes, 'productionPairingProven': False, 'g5Passed': False,
        'physicalLockProven': False, 'callbackManuallyInvoked': False, 'xcode': r.cmd('xcodebuild', '-version')}
    device = listener = docs = None
    if not (APPROOT / 'ios/Footage.xcworkspace').exists():
        execute(['npx', '--no-install', 'expo', 'prebuild', '--platform', 'ios', '--no-install'], 'prebuild.log', APPROOT, dict(os.environ, CI='1'))
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
        # Reuse the EXISTING G3 control/trust adapter and native fixture helpers.
        # No copied implementation is maintained, and no full runtime fault suite is
        # transplanted into an optimized Expo target (run its own Debug runner).
        adapter = (SOURCE.parent / 'ios-background-integration/Probe.swift').read_text().split('@main\n')[0]
        tests = (SOURCE.parent / 'ios-background-runtime/Tests.swift').read_text()
        helpers = 'import SQLite3\n'
        for start, end in [('func testState(', 'func testRewriteState('), ('func testAwait(', 'func testEvent('),
                           ('func testGenerate(', 'func runRuntimeTests(')]:
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
        app_class = 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {'
        assert original_appdelegate.count(app_class) == 1
        appdelegate.write_text(original_appdelegate.replace(app_class, app_class + '''
  #if FOOTAGE_EXPO_LIFECYCLE_TEST
  override func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void) {
    super.application(application, handleEventsForBackgroundURLSession: identifier) {
      precondition(Thread.isMainThread)
      let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("aggregate-completion.json")
      var count = 0
      if let bytes = try? Data(contentsOf: file),
        let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Int] { count = object["count"] ?? 0 }
      let bytes = try! JSONSerialization.data(withJSONObject: ["count": min(count + 1, 1000), "main": true])
      try! bytes.write(to: file, options: .atomic)
      completionHandler()
    }
  }
  #endif
'''))
        test_installed = True
        summary['testBinarySHA256'] = build(test=True)
        r.cmd('xcrun', 'simctl', 'install', device, APP)
        docs = Path(r.cmd('xcrun', 'simctl', 'get_app_container', device, BUNDLE, 'data')) / 'Documents'
        docs.mkdir(exist_ok=True)
        # Test-only filesystem mode cannot enable anything in an ordinary binary.
        service = 'test.footage.expolifecycle.' + str(uuid.uuid4())
        def configure(mode):
            for name in ['native-state.json', 'lifecycle.json', 'completion-ledger.json', 'aggregate-completion.json']:
                (docs / name).unlink(missing_ok=True)
            (docs / 'lifecycle-config.json').write_text(json.dumps({'mode': mode, 'service': service}))
        configure('unit'); launch()
        host = r.wait(lambda: r.read_json(docs / 'host-tests.json'))
        assert host['ok'], host
        summary['hostUnitCases'] = host['cases']
        drain_probe = r.wait(lambda: r.read_json(docs / 'runtime-drain-probe.json'))
        assert 'error' not in drain_probe, drain_probe
        summary['runtimeEnumerationDrainRaceReproduced'] = drain_probe['finishDuringEnumerationLeavesPendingToken']
        shutil.copyfile(docs / 'runtime-drain-probe.json', OUT / 'runtime-drain-probe.json')
        terminate()
        r.certs()
        for name in ['root.der', 'leaf.der']: shutil.copyfile(OUT / name, docs / name)
        log = (OUT / 'listener.log').open('w')
        adapter = SOURCE.parent / 'ios-background-integration/listener.mjs'
        adapter_source = adapter.read_text()
        summary['existingG3AdapterSHA256'] = hashlib.sha256(adapter_source.encode()).hexdigest()
        if valid_outcomes:
            # Same actual G3 adapter, with ONLY its two response-loss/forgery faults off.
            # Never duplicate ingest, encryption, receipt or native control implementation.
            condition = '} else if (!state.fakeOutcomeSent) {'
            assert adapter_source.count(condition) == 1
            adapter_source = adapter_source.replace(condition, '} else if (false) {')
            if two_wakes:
                gate = '    while (!await exists(join(out, \'release\'))) await sleep(50);'
                assert adapter_source.count(gate) == 1
                adapter_source = adapter_source.replace(gate, gate + '\n    if (state.groups >= 1) { while (!await exists(join(out, \'second-release\'))) await sleep(50); }')
            adapter_source = adapter_source.replace("'../../../apps/", "'" + (ROOT / 'apps').as_uri() + '/')
            adapter = OUT / 'valid-listener.generated.mjs'
            adapter.write_text(adapter_source)
            (OUT / 'respond-final').write_text('valid-response-test-only')
        listener = subprocess.Popen([str(ROOT / 'node_modules/.bin/tsx'), str(adapter), str(OUT), str(docs)], stdout=log, stderr=subprocess.STDOUT)
        ready = r.wait(lambda: r.read_json(OUT / 'listener-ready.json'))
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
                assert not first_completion['hasReceipt']
                shutil.copyfile(docs / 'lifecycle.json', OUT / 'first-os-lifecycle.json')
                shutil.copyfile(docs / 'completion-ledger.json', OUT / 'first-os-completion.json')
                # Observe Expo's OUTER aggregated OS completion separately from our
                # subscriber's contribution. Never manufacture the missing completion.
                aggregate_deadline = time.monotonic() + 30
                while time.monotonic() < aggregate_deadline and not r.read_json(docs / 'aggregate-completion.json'):
                    time.sleep(.2)
                summary['firstExpoAggregateCompletionObserved'] = bool(r.read_json(docs / 'aggregate-completion.json'))
                os.kill(first_life['pid'], signal.SIGKILL)
                configure('restore')
            (OUT / 'second-release').write_text('second-native-event-batch')
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
        summary['osCallbackBatches'] = (life['counts'].get('ownedCallback', 0) if life else 0) + int(summary.get('firstOSWakeDrainedBeforeSecondGroup', False))
        summary['osBridgeCreations'] = life['counts'].get('bridgeCreated', 0) if life else 0
        if life: shutil.copyfile(docs / 'lifecycle.json', OUT / 'os-lifecycle.json')
        completion = r.read_json(docs / 'completion-ledger.json')
        summary['subscriberCompletionAfterDrainObserved'] = bool(completion and completion['main'] and completion['completions'] == completion['ownedCallbacks'])
        if completion: shutil.copyfile(docs / 'completion-ledger.json', OUT / 'os-completion-ledger.json')
        aggregate = r.read_json(docs / 'aggregate-completion.json')
        summary['expoAggregateSystemCompletionObserved'] = bool(aggregate)
        if aggregate: shutil.copyfile(docs / 'aggregate-completion.json', OUT / 'os-aggregate-completion.json')
        os_final = state(docs) or {}
        if os_final: shutil.copyfile(docs / 'native-state.json', OUT / 'os-native-state.json')
        summary['osWakeMatchingNativeReceipt'] = bool(os_final.get('phase') == 'received'
            and os_final.get('receiptID') == actual['receipt']['id']
            and os_final.get('sha256') == actual['independent']['sha256']
            and os_final.get('confirmedBytes') == actual['independent']['bytes'])
        if valid_outcomes:
            assert summary['osWakeMatchingNativeReceipt'] and summary['osBridgeCreations'] == 0, os_final
            assert summary['subscriberCompletionAfterDrainObserved']
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
        summary['g5Passed'] = False # Expo aggregate completion and physical/paired gates remain open
        shutil.copyfile(docs / 'native-state.json', OUT / 'native-final.json')
        print(json.dumps(summary, indent=2), flush=True)
    finally:
        if listener:
            listener.terminate()
            try: listener.wait(20)
            except subprocess.TimeoutExpired: listener.kill(); listener.wait()
        if docs:
            for name in ['native-state.json', 'lifecycle.json', 'host-tests.json', 'completion-ledger.json', 'aggregate-completion.json']:
                if (docs / name).exists(): shutil.copyfile(docs / name, OUT / ('last-' + name))
            private = docs / 'runtime/private'
            if private.exists(): private.chmod(0o700)
        if device:
            r.cmd('xcrun', 'simctl', 'shutdown', device, check=False)
            r.cmd('xcrun', 'simctl', 'delete', device)
        scene.write_text(original_scene)
        appdelegate.write_text(original_appdelegate)
        # Restore ordinary generated build configuration; never leave test mode as default.
        if test_installed:
            env = dict(os.environ); env.pop('FOOTAGE_EXPO_LIFECYCLE_TEST', None)
            execute(['pod', 'install'], 'pods-restored-normal.log', APPROOT / 'ios', env)
        summary['ownedSimulatorDeleted'] = device is None or device not in r.cmd('xcrun', 'simctl', 'list', 'devices', '-j')
        summary['ownedListenerStopped'] = listener is None or listener.poll() is not None
        (OUT / 'safe-summary.json').write_text(json.dumps(summary, indent=2))
        print('Ignored artifacts:', OUT, flush=True)

if __name__ == '__main__': main()
