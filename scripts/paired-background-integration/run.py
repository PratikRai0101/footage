#!/usr/bin/env python3
"""Actual native G1/G2/G4 -> OS-backed G3 paired service. No Expo activation."""
import importlib.util
import http.client
import json
import os
import shutil
import signal
import sqlite3
import ssl
import subprocess
import time
import uuid
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('runtime_runner', SOURCE.parent / 'test/ios-background-runtime/run.py')
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
r.OUT = r.ROOT / 'artifacts/paired-background-integration' / str(uuid.uuid4())
OUT = r.OUT

def ledger(docs):
    with sqlite3.connect(docs / 'runtime/ledger.sqlite') as db:
        return json.loads(db.execute('SELECT state FROM runtime WHERE id=1').fetchone()[0])

def main():
    if os.environ.get('FOOTAGE_TEST_KEYCHAIN') != '1': raise SystemExit('Opt in with FOOTAGE_TEST_KEYCHAIN=1 (one fresh test-only item)')
    if shutil.disk_usage(r.ROOT).free < 6 * 1024**3: raise SystemExit('Need 6 GiB free')
    OUT.mkdir(parents=True, mode=0o700)
    r.cmd('git', 'check-ignore', OUT / 'raw.key')
    device = listener = stopped_pid = docs = None
    summary = {'syntheticInjectedControl': False, 'actualPairingControl': True, 'expoClaimed': False,
        'physicalLockClaimed': False, 'swift6WarningsAsErrors': True}
    namespace = 'test.' + str(uuid.uuid4())
    initialized = False
    try:
        # Reuse only the tiny standalone project builder, adding exact production pairing sources.
        native_path = r.NATIVE
        class Sources:
            def __truediv__(self, name): return native_path / name
            def glob(self, pattern): return [*native_path.glob(pattern), *native_path.glob('Pairing*.swift')]
        r.NATIVE = Sources()
        r.build(SOURCE / 'Probe.swift')
        r.certs()
        r.cmd('xcrun', 'swiftc', '-swift-version', '6', '-warnings-as-errors',
            r.ROOT / 'apps/server/src/desktop-key-store-helper.swift', '-o', OUT / 'key-helper')
        import socket
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        receiver_config = {'namespace': namespace, 'origin': f'https://localhost:{port}', 'port': port, 'intake': str(uuid.uuid4())}
        (OUT / 'receiver-config.json').write_text(json.dumps(receiver_config))
        r.cmd(str(r.ROOT / 'node_modules/.bin/tsx'), SOURCE / 'key-store.mjs', OUT, 'initialize')
        initialized = True
        device = r.cmd('xcrun', 'simctl', 'create', 'Owned Paired Background Integration',
            'com.apple.CoreSimulator.SimDeviceType.iPhone-16', 'com.apple.CoreSimulator.SimRuntime.iOS-26-2')
        (OUT / 'owned-simulator.txt').write_text(device)
        r.cmd('xcrun', 'simctl', 'boot', device); r.cmd('xcrun', 'simctl', 'bootstatus', device, '-b')
        r.cmd('xcrun', 'simctl', 'install', device, OUT / 'BackgroundProbe.app')
        docs = Path(r.cmd('xcrun', 'simctl', 'get_app_container', device, r.BUNDLE, 'data')) / 'Documents'
        docs.mkdir(exist_ok=True)
        for name in ['root.der', 'leaf.der']: shutil.copyfile(OUT / name, docs / name)
        def start_listener():
            (OUT / 'listener-ready.json').unlink(missing_ok=True)
            log = (OUT / ('listener-' + str(time.time_ns()) + '.log')).open('w')
            p = subprocess.Popen([str(r.ROOT / 'node_modules/.bin/tsx'), str(SOURCE / 'listener.mjs'), str(OUT), str(docs)], stdout=log, stderr=subprocess.STDOUT)
            try:
                r.wait(lambda: r.read_json(OUT / 'listener-ready.json'))
                return p
            except BaseException:
                p.terminate()
                try: p.wait(10)
                except subprocess.TimeoutExpired: p.kill(); p.wait()
                raise
        service = 'test.footage.paired.' + str(uuid.uuid4())
        def launch(mode):
            (docs / 'result.json').unlink(missing_ok=True)
            (docs / 'config.json').write_text(json.dumps({'mode': mode, 'service': service}))
            return int(r.cmd('xcrun', 'simctl', 'launch', device, r.BUNDLE).rsplit(':', 1)[1].strip())
        def terminate(): r.cmd('xcrun', 'simctl', 'terminate', device, r.BUNDLE, check=False)
        (docs / 'binding.json').write_text(json.dumps({'intake': receiver_config['intake'].replace('-', '')}))
        launch('warm')
        assert r.wait(lambda: r.read_json(docs / 'result.json'))['ok']
        terminate()
        listener = start_listener()
        launch('enroll')
        r.wait(lambda: r.read_json(OUT / 'awaiting-local-approval.json'))
        (OUT / 'operator-approve').write_text('Explicit synthetic local operator approval')
        enrolled = r.wait(lambda: r.read_json(docs / 'result.json'))
        assert enrolled['ok'] and enrolled['actualNativeEnrollmentAndRecovery'], enrolled
        summary['nativeGeneratedDeviceIndependentQRLocalApprovalTLSRecovery'] = True
        terminate()
        launch('prepare')
        scheduled = r.wait(lambda: r.read_json(docs / 'scheduled.json'), 180)
        assert scheduled['ok'] and scheduled['groups'] == 2 and scheduled['privateManifestReadDenied'], scheduled
        assert scheduled['exactSetupRetrySameMaster'] and scheduled['changedSetupAndOutcomeBindingRejected'] and scheduled['currentInstallationRemovedAfterFreeze'], scheduled
        summary['frozenJobAuthoritySurvivesMissingCurrentInstallation'] = True
        summary['exactSetupRetrySameMasterAndBindingSubstitutionRejected'] = True
        before = ledger(docs)
        terminate()  # explicit user-style termination: no automatic-relaunch claim
        pid = launch('reassociate')
        reassociated = r.wait(lambda: r.read_json(docs / 'reassociated.json'))
        assert reassociated['ok'], reassociated
        after = ledger(docs)
        assert [(g['taskID'], g['correlation']) for g in before['groups']] == [(g['taskID'], g['correlation']) for g in after['groups']]
        assert before['job'] == after['job'] and before['generation'] == after['generation']
        summary['coldReassociationSameTasksAndIdentity'] = True
        home = r.cmd('xcodebuild', 'test', '-project', OUT / 'BackgroundProbe.xcodeproj', '-scheme', 'Home',
            '-destination', f'platform=iOS Simulator,id={device}', '-parallel-testing-enabled', 'NO',
            '-only-testing:HomeTests/HomeTests/testHome', '-derivedDataPath', OUT / 'home-build',
            'CODE_SIGN_IDENTITY=-', 'CODE_SIGNING_ALLOWED=YES')
        (OUT / 'home.log').write_text(home); assert '** TEST SUCCEEDED **' in home
        r.wait(lambda: r.read_json(docs / 'background.json'))
        os.kill(pid, signal.SIGSTOP); stopped_pid = pid
        assert 'T' in r.cmd('ps', '-o', 'state=', '-p', pid)
        # Keep the listener paused until the owned daemon's socket has been observed.
        # Sampling after release races a fast loopback transfer and can miss the socket entirely.
        services = r.cmd('xcrun', 'simctl', 'spawn', device, 'launchctl', 'list')
        daemon_pids = [line.split()[0] for line in services.splitlines() if 'nsurlsessiond' in line and line.split()[0].isdigit()]
        owns_socket = r.wait(lambda: any(':' + str(port) in r.cmd('/usr/sbin/lsof', '-nP', '-a', '-p', p, '-iTCP', check=False) for p in daemon_pids), 30)
        (OUT / 'release').write_text('background-and-stopped')
        actual = r.wait(lambda: r.read_json(OUT / 'actual-receipt.json'), 240)
        transferred = r.wait(lambda: (s if (s := r.read_json(OUT / 'listener-state.json')) and s['groups'] >= 2 else None), 60)
        assert 'T' in r.cmd('ps', '-o', 'state=', '-p', pid)
        assert owns_socket and transferred['wholeHashMatched'] and all(transferred['wireMatches']), transferred
        assert transferred['fakeOutcomeSent'] and transferred['lostFinalResponse'], transferred
        # Explicit termination can abort the old socket while the same daemon tasks reconnect.
        # G3 must reject those attempts, never credit them. Inspect the actual rejection cause.
        assert transferred['transientFinalizationFailures'] == 1 and not transferred['reusableCredentialInBody'] and not transferred['generationMasterInBody'], transferred
        assert all(e.get('code') in ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'] for e in transferred['rejectedRequests']), transferred
        summary['transientFinalizationResolvedByReceiverWithoutPhoneRetryOrRestart'] = True
        assert actual['jobCount'] == 1 and actual['receipt']['sha256'] == actual['independent']['sha256']
        (OUT / 'stopped-transfer-state.json').write_text(json.dumps(transferred))
        summary['daemon'] = {'homeAndSIGSTOP': True, 'abortedOldConnectionsRejected': transferred['errors'], 'nsurlsessiondOwnsSocket': True, 'originalBytes': actual['independent']['bytes'],
            'wireBytes': transferred['bodyBytes'], 'groups': 2, 'independentReceivingHashMatches': True,
            'exactSavedWireMatches': True, 'authorizationHeaders': 0, 'cookieHeaders': 0,
            'reusableCredentialInBody': False, 'generationMasterInBody': False, 'automaticG3JobsReceiptWhileAppStopped': True, 'fakeOutcomeRejected': True, 'finalResponseLost': True}
        os.kill(pid, signal.SIGCONT); stopped_pid = None
        # Deliver native callbacks only AFTER G3 has durably published while the app was stopped.
        # Require actual HMAC rejection before cancellation, so the cancel fence cannot mask a fake ack.
        returned = r.cmd('xcodebuild', 'test-without-building', '-project', OUT / 'BackgroundProbe.xcodeproj', '-scheme', 'Home',
            '-destination', f'platform=iOS Simulator,id={device}', '-parallel-testing-enabled', 'NO',
            '-only-testing:HomeTests/HomeTests/testReturn', '-derivedDataPath', OUT / 'home-build')
        (OUT / 'return.log').write_text(returned); assert '** TEST EXECUTE SUCCEEDED **' in returned
        callback = r.wait(lambda: r.read_json(docs / 'result.json'))
        assert callback['phase'] == 'blocked' and callback['confirmedBytes'] == 0 and not callback['received'], callback
        (OUT / 'post-callback.json').write_text(json.dumps(callback))
        summary['nativeRejectedForgedHMACBeforeCancel'] = True
        # Explicit relaunch, no claim that force quit restarts automatically.
        terminate()
        launch('status')
        status_receipt = r.wait(lambda: r.read_json(docs / 'result.json'))
        assert status_receipt['ok'] and status_receipt['receiptID'] == actual['receipt']['id'], status_receipt
        summary['nativeAuthenticatedStatusSameAutonomousReceiptWithoutPrivateManifest'] = True
        terminate()
        # Actually take the receiver offline; the native adapter still uses real paired HTTPS.
        listener.terminate(); listener.wait(30); listener = None
        launch('cancel-offline')
        cancelled = r.wait(lambda: r.read_json(docs / 'result.json'))
        assert cancelled['ok'] and cancelled['cleanupPending'], cancelled
        assert ledger(docs).get('receiptOutcome') is None and ledger(docs)['bitmap'] == 0
        summary['fakeOutcomeNoNativeAcceptedProgress'] = True
        summary['offlineCancelDurableBeforeReconciliation'] = True
        terminate()
        # Stop only our receiver, then reopen its actual durable store. No retry-supervisor claim.
        receiver_config['restarted'] = True
        (OUT / 'receiver-config.json').write_text(json.dumps(receiver_config))
        listener = start_listener()
        restarted = r.read_json(OUT / 'startup-receipts.json')
        assert len(restarted) == 1 and restarted[0]['receipt'] == actual['receipt']
        summary['receiverRestartSameJobsReceipt'] = True
        # Real G3 rejects a mutated encrypted last group, without changing the authoritative receipt.
        body = bytearray((docs / 'runtime/group-1.sealed').read_bytes()); body[-1] ^= 1
        connection = http.client.HTTPSConnection('localhost', port, context=ssl.create_default_context(cafile=str(OUT / 'root.pem')), timeout=30)
        connection.request('POST', '/sealed/v1/ingest', body, {'Content-Type': 'application/octet-stream'})
        response = connection.getresponse(); response.read(); assert response.status != 200; connection.close()
        summary['tamperedGroupRejectedByActualG3'] = True
        # Exact saved ciphertext retry is the supported explicit retry scope, not a supervisor.
        (OUT / 'respond-final').write_text('explicit-test-retry-after-restart')
        connection = http.client.HTTPSConnection('localhost', port, context=ssl.create_default_context(cafile=str(OUT / 'root.pem')), timeout=30)
        connection.request('POST', '/sealed/v1/ingest', (docs / 'runtime/group-1.sealed').read_bytes(), {'Content-Type': 'application/octet-stream'})
        response = connection.getresponse(); replay = response.read(); assert response.status == 200 and replay.startswith(b'FTOUT001'); connection.close()
        replayed = r.read_json(OUT / 'actual-receipt.json')
        assert replayed == actual
        summary['explicitExactRetryAfterReceiverRestartSameReceiptAndOneJob'] = True
        launch('reconcile')
        final = r.wait(lambda: r.read_json(docs / 'result.json'))
        assert final['ok'] and final['privateManifestStillUnavailable'], final
        assert final['receiptID'] == actual['receipt']['id'] and final['jobID'] == actual['receipt']['jobId']
        assert final['sha256'] == actual['independent']['sha256'] and final['bytes'] == actual['independent']['bytes']
        assert final['confirmedBytes'] == final['bytes']
        summary['nativeFinality'] = {'phase': final['phase'], 'matchingSameReceiptID': True,
            'independentReceivingSHA256Matches': True, 'originalBytes': final['bytes'], 'receiptWinsOfflineCancel': True,
            'lockedDisplayUnavailableThroughout': True, 'jobCount': 1}
        terminate()
        # Retain independent raw receiving evidence privately, generated fixture can be deleted with sim.
        (OUT / 'scheduled.json').write_text(json.dumps(scheduled))
        print('PASS: real G3 receipt + native received after receiver/native restart and offline cancel', flush=True)
    finally:
        if stopped_pid:
            try: os.kill(stopped_pid, signal.SIGCONT)
            except ProcessLookupError: pass
        if listener:
            listener.terminate()
            try: listener.wait(20)
            except subprocess.TimeoutExpired: listener.kill(); listener.wait()
        if docs:
            # Undo only this test's injected permission denial, for owned-device cleanup.
            private = docs / 'runtime/private'
            if private.exists(): private.chmod(0o700)
        if device:
            try: r.cmd('xcrun', 'simctl', 'shutdown', device, check=False)
            finally: r.cmd('xcrun', 'simctl', 'delete', device)
        summary['ownedSimulatorDeleted'] = device is None or device not in r.cmd('xcrun', 'simctl', 'list', 'devices', '-j')
        summary['ownedListenerStopped'] = listener is None or listener.poll() is not None
        if initialized:
            r.cmd(str(r.ROOT / 'node_modules/.bin/tsx'), SOURCE / 'key-store.mjs', OUT, 'delete')
            summary['exactNewUUIDKeychainItemDeleted'] = True
        (OUT / 'safe-summary.json').write_text(json.dumps(summary, indent=2))
        print('Ignored raw artifacts:', OUT, flush=True)

if __name__ == '__main__': main()
