#!/usr/bin/env python3
"""Disposable Simulator probe. Requires Xcode, Node, Python and openssl; no npm/Pods.
Run from repo root: python3 scripts/ios-background-probe/run.py
Raw certs, payloads, paths and logs are confined to ignored artifacts. No host trust edits.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import ssl
import signal
import subprocess
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().parent
OUT = ROOT / 'artifacts' / 'ios-background-transport' / str(uuid.uuid4())
BUNDLE = 'test.footage.transportprobe'

def cmd(*args, **kw):
    try:
        return subprocess.check_output([str(x) for x in args], stderr=subprocess.STDOUT, **kw).decode().strip()
    except subprocess.CalledProcessError as e:
        (OUT / 'last-command-error.log').write_bytes(e.output)
        raise

def wait(check, timeout=40):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        value = check()
        if value:
            return value
        time.sleep(.2)
    raise TimeoutError('probe condition not reached')

def read_json(p):
    try:
        return json.loads(p.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def main():
    if shutil.disk_usage(ROOT).free < 6 * 1024**3:
        raise SystemExit('Need at least 6 GiB free; do not delete anyone else\'s artifacts.')
    OUT.mkdir(parents=True)
    assert cmd('git', 'check-ignore', str(OUT / 'secret.key'))
    device = None
    listener = None
    summary = {'platform': {'xcode': cmd('xcodebuild', '-version'), 'runtime': 'iOS 26.2', 'sdk': 'iphonesimulator', 'arch': 'arm64'}, 'cases': []}
    try:
        # Certificates are generated locally, short-lived and never committed.
        root_config = OUT / 'root.cnf'
        root_config.write_text('[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Disposable Probe CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n')
        cmd('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', root_config, '-keyout', OUT / 'root.key', '-out', OUT / 'root.pem')
        ext = OUT / 'leaf.cnf'
        ext.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n')
        for name in ['leaf', 'other']:
            cmd('openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', OUT / (name + '.key'), '-out', OUT / (name + '.csr'))
            cmd('openssl', 'x509', '-req', '-in', OUT / (name + '.csr'), '-CA', OUT / 'root.pem', '-CAkey', OUT / 'root.key', '-CAcreateserial', '-days', '2', '-sha256', '-extfile', ext, '-out', OUT / (name + '.pem'))
        for name in ['root', 'leaf']:
            cmd('openssl', 'x509', '-in', OUT / (name + '.pem'), '-outform', 'DER', '-out', OUT / (name + '.der'))
        listener = subprocess.Popen(['node', str(SOURCE / 'listeners.mjs'), str(OUT)], stdout=(OUT / 'listener.log').open('w'), stderr=subprocess.STDOUT)
        ports = wait(lambda: read_json(OUT / 'ports.json'))
        origin = f'https://localhost:{ports["receiver"]}'
        def control():
            with urllib.request.urlopen(f'http://127.0.0.1:{ports["http"]}/control') as r:
                return json.load(r)
        # Reachability controls independent of URLSession and trust.
        with urllib.request.urlopen(f'http://127.0.0.1:{ports["http"]}/plain', data=b'listener-control') as r:
            assert r.status == 204
        for role in ['receiver', 'same', 'different']:
            context = ssl.create_default_context(cafile=str(OUT / 'root.pem'))
            with urllib.request.urlopen(f'https://localhost:{ports[role]}/plain', data=b'listener-control', context=context) as r:
                assert r.status == 204
        summary['independentListenerControlsPassed'] = True
        device = cmd('xcrun', 'simctl', 'create', 'Isolated Transport Research', 'com.apple.CoreSimulator.SimDeviceType.iPhone-16', 'com.apple.CoreSimulator.SimRuntime.iOS-26-2')
        (OUT / 'owned-simulator.txt').write_text(device)
        cmd('xcrun', 'simctl', 'boot', device); cmd('xcrun', 'simctl', 'bootstatus', device, '-b')
        app = OUT / 'TransportProbe.app'; app.mkdir()
        info = {'CFBundleIdentifier': BUNDLE, 'CFBundleName': 'TransportProbe', 'CFBundleExecutable': 'TransportProbe', 'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0', 'MinimumOSVersion': '17.0', 'LSRequiresIPhoneOS': True, 'UIDeviceFamily': [1], 'UILaunchScreen': {}, 'NSAppTransportSecurity': {'NSAllowsArbitraryLoads': False, 'NSAllowsLocalNetworking': False}, 'NSLocalNetworkUsageDescription': 'Disposable loopback transport research.'}
        (app / 'Info.plist').write_bytes(plistlib.dumps(info))
        for n in ['root.der', 'leaf.der']:
            shutil.copyfile(OUT / n, app / n)
        project = OUT / 'TransportProbe.xcodeproj'; project.mkdir()
        shutil.copyfile(SOURCE / 'project.pbxproj', project / 'project.pbxproj')
        shutil.copyfile(SOURCE / 'Probe.swift', OUT / 'Probe.swift')
        shutil.copyfile(app / 'Info.plist', OUT / 'Info.plist')
        build = cmd('xcodebuild', '-project', project, '-target', 'TransportProbe', '-configuration', 'Debug', '-sdk', 'iphonesimulator', '-arch', 'arm64', 'CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_IDENTITY=-', f'CONFIGURATION_BUILD_DIR={OUT}', f'OBJROOT={OUT}/obj', f'SYMROOT={OUT}/sym')
        (OUT / 'build.log').write_text(build)
        # Resource-only additions require resealing, preserving Xcode's Simulator entitlements.
        cmd('codesign', '--force', '--sign', '-', '--preserve-metadata=entitlements', app)
        cmd('xcrun', 'simctl', 'install', device, app)
        container = Path(cmd('xcrun', 'simctl', 'get_app_container', device, BUNDLE, 'data'))
        docs = container / 'Documents'; docs.mkdir(exist_ok=True)
        def run(name, suspend=False, **config):
            try:
                cmd('xcrun', 'simctl', 'terminate', device, BUNDLE)
            except subprocess.CalledProcessError:
                pass
            for f in ['result.json', 'events.jsonl']:
                (docs / f).unlink(missing_ok=True)
            config.update(name=name, origin=origin)
            config.setdefault('url', origin + '/plain')
            p = docs / 'config.json'; p.write_text(json.dumps(config))
            before = len(control()['records'])
            launched = cmd('xcrun', 'simctl', 'launch', device, BUNDLE, '--config', p)
            pid = int(launched.rsplit(':', 1)[1].strip())
            observation = None
            if suspend:
                first = wait(lambda: next((x for x in control()['active'] if x['url'] == '/slow-sealed' and x['bytes'] > 1024**2), None), 60)
                cmd('xcrun', 'simctl', 'launch', device, 'com.apple.Preferences')
                wait(lambda: (docs / 'events.jsonl').exists() and 'enteredBackground' in (docs / 'events.jsonl').read_text())
                os.kill(pid, signal.SIGSTOP)
                stopped = cmd('ps', '-o', 'state=', '-p', str(pid)).strip()
                assert 'T' in stopped
                start = next(x for x in control()['active'] if x['url'] == '/slow-sealed')
                assert start['bytes'] < config['length'] // 2
                services = cmd('xcrun', 'simctl', 'spawn', device, 'launchctl', 'list')
                daemon_pids = [line.split()[0] for line in services.splitlines() if 'nsurlsessiond' in line and line.split()[0].isdigit()]
                socket_owner = False
                for daemon_pid in daemon_pids:
                    try:
                        sockets = cmd('/usr/sbin/lsof', '-nP', '-a', '-p', daemon_pid, '-iTCP')
                        (OUT / ('daemon-sockets-' + daemon_pid + '.log')).write_text(sockets)
                        socket_owner |= f':{ports["receiver"]} ' in sockets
                    except subprocess.CalledProcessError:
                        pass
                time.sleep(2)
                intermediate = next(x for x in control()['active'] if x['url'] == '/slow-sealed')
                assert intermediate['bytes'] > start['bytes']
                assert 'T' in cmd('ps', '-o', 'state=', '-p', str(pid))
                end = wait(lambda: next((r for r in control()['records'][before:] if r['kind'] == 'sealedAccepted'), None), 150)
                # Resume only after the listener has all bytes and has decrypted/verified the body.
                assert 'T' in cmd('ps', '-o', 'state=', '-p', str(pid))
                observation = {'enteredBackground': True, 'processStopped': True, 'bytesReadAtStop': start['bytes'], 'bytesReadByCompletion': end['wireBytes'], 'additionalBodyBytesWhileStopped': end['wireBytes'] - start['bytes'], 'daemonListed': bool(daemon_pids), 'daemonOwnsReceiverSocket': socket_owner, 'bytesReadTwoSecondsLater': intermediate['bytes'], 'socketBytesAtStop': start['socketBytes']}
                os.kill(pid, signal.SIGCONT)
            result = wait(lambda: read_json(docs / 'result.json'), 65)
            events = [json.loads(l) for l in (docs / 'events.jsonl').read_text().splitlines()]
            raw = {'config': config, 'result': result, 'events': events, 'records': control()['records'][before:], 'suspension': observation}
            (OUT / (name + '.json')).write_text(json.dumps(raw, indent=2))
            # Do not export receiver origins/ports, keys, job IDs, bearer values or local paths.
            safe = {'name': name, 'status': result['status'], 'error': result['error'], 'redirectCallbacks': result['redirectCallbacks'], 'trustCallbacks': result['trustCallbacks'], 'acceptedPlaintextOffset': result['acceptedPlaintextOffset'], 'trust': [{k: e[k] for k in ['originOK', 'pinOK', 'trusted']} for e in events if e['event'] == 'trust'], 'expected': [{k: e[k] for k in ['bytes', 'sha256']} for e in events if e['event'] in ['expected', 'sealedReady']], 'observed': raw['records'], 'suspension': observation}
            safe['sealedBoundary'] = [e['noPlaintextOrKeys'] for e in events if e['event'] == 'sealedBoundary']
            safe['ackContextMatched'] = result['ackContextMatched']
            safe['ackMACVerified'] = result['ackMACVerified']
            if result['status'] == 204 and not config.get('metadata') and not config.get('sealed'):
                received = [r for r in raw['records'] if r['kind'] == 'plain']
                assert received and all(r['bytes'] == 65536 and r['sha256'] == hashlib.sha256(b'F' * 65536).hexdigest() for r in received)
            if config.get('sealed'):
                assert safe['sealedBoundary'] == [True]
                expected = next(e for e in events if e['event'] == 'sealedReady')
                if 'redirect' not in config['url']:
                    accepted = next(r for r in raw['records'] if r['kind'] == 'sealedAccepted')
                    assert accepted['bytes'] == expected['bytes'] and accepted['sha256'] == expected['sha256']
                    assert all(accepted['checks'][k] is True for k in ['tampered', 'wrongOffset', 'wrongLength', 'crossJob', 'noProgressAdvance'])
                    assert accepted['checks']['crossJobProgress'] == 0 and accepted['idempotentReplay']
                    assert result['acceptedPlaintextOffset'] == expected['bytes']
                    assert result['ackContextMatched'] and result['ackMACVerified']
                else:
                    sink = next(r for r in raw['records'] if r['kind'] == 'sealedSink')
                    assert sink['sha256'] == expected['wireHash'] and sink['bytes'] == expected['wireBytes']
                    assert not any(sink[k] for k in ['auth', 'cookie', 'urlHasSecret'])
                    assert result['ackContextMatched'] and not result['ackMACVerified'] and result['acceptedPlaintextOffset'] == 0
            summary['cases'].append(safe)
            (OUT / 'safe-summary.json').write_text(json.dumps(summary, indent=2))
            print(name, result['status'], result['error'], 'accepted', result['acceptedPlaintextOffset'], flush=True)
            return raw
        # ATS FIRST. Explicit false flags; no exceptions or arbitrary loads anywhere.
        run('ats-http-ip', url=f'http://127.0.0.1:{ports["http"]}/plain')
        run('ats-http-localhost', url=f'http://localhost:{ports["http"]}/plain')
        run('untrusted-default-baseline', anchor='default')
        baseline = run('custom-baseline', anchor='custom')
        assert baseline['result']['status'] == 204, baseline['result']
        run('custom-metadata-baseline', anchor='custom', metadata=True)
        for target in ['different', 'same', 'httpIP', 'httpHost']:
            for metadata, auth in [(False, False), (False, True), (True, False), (True, True)]:
                run(f'custom-{target}-meta{int(metadata)}-auth{int(auth)}', url=origin + '/redirect?to=' + target, anchor='custom', metadata=metadata, auth=auth)
        # Trust change is confined to this newly created Simulator, never macOS keychains.
        cmd('xcrun', 'simctl', 'keychain', device, 'add-root-cert', OUT / 'root.der')
        summary['disposableSimulatorRootInstalled'] = True
        baseline = run('default-baseline', anchor='default')
        assert baseline['result']['status'] == 204, baseline['result']
        run('default-metadata-baseline', anchor='default', metadata=True)
        for target in ['different', 'same', 'httpIP', 'httpHost']:
            for metadata, auth in [(False, False), (False, True), (True, False), (True, True)]:
                run(f'default-{target}-meta{int(metadata)}-auth{int(auth)}', url=origin + '/redirect?to=' + target, anchor='default', metadata=metadata, auth=auth)
        run('foreground-redirect-control', url=origin + '/redirect?to=httpIP', foreground=True, anchor='default')
        # B uses the same established TLS setup; redirectable requests contain only sealed bytes.
        run('sealed-positive', url=origin + '/sealed', sealed=True, anchor='default')
        sink = run('sealed-redirect-fake-ack', url=origin + '/redirect?to=sealed', sealed=True, anchor='default')
        assert sink['result']['acceptedPlaintextOffset'] == 0
        with urllib.request.urlopen(origin.replace('https://localhost', 'http://127.0.0.1').replace(str(ports['receiver']), str(ports['http'])) + '/verify-captured') as r:
            verified = json.load(r)
        summary['capturedDecrypt'] = {k: verified[k] for k in ['length', 'sha256']}
        long = run('sealed-suspended-positive', url=origin + '/slow-sealed', sealed=True, anchor='default', length=64 * 1024 * 1024, suspend=True)
        assert long['result']['acceptedPlaintextOffset'] == 64 * 1024 * 1024
        (OUT / 'safe-summary.json').write_text(json.dumps(summary, indent=2))
    finally:
        if listener:
            listener.terminate()
            try:
                listener.wait(10)
            except subprocess.TimeoutExpired:
                listener.kill(); listener.wait()
        if device:
            try:
                cmd('xcrun', 'simctl', 'shutdown', device)
            finally:
                cmd('xcrun', 'simctl', 'delete', device)
        summary['ownedListenerStopped'] = listener is None or listener.poll() is not None
        summary['ownedSimulatorDeleted'] = device is None or device not in cmd('xcrun', 'simctl', 'list', 'devices', '-j')
        (OUT / 'safe-summary.json').write_text(json.dumps(summary, indent=2))
        print('Owned listeners and disposable Simulator cleaned up. Raw artifacts:', OUT)
    from verify import verify
    verify(summary)

if __name__ == '__main__':
    main()
