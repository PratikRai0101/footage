#!/usr/bin/env python3
"""Actual native pairing owner -> credential-bearing fixed control requests.
Only own disposable Simulator/listeners. No Expo, global trust, personal data.
"""
import importlib.util
import json
import shutil
import subprocess
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('pairing_proof', ROOT / 'scripts/pairing-probe/run.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
OUT = ROOT / 'artifacts/pairing-control-probe' / str(uuid.uuid4())
r.OUT = OUT
BUNDLE = r.BUNDLE


def certificates():
    r.certs()
    # Extra valid leaf with another key, and a chain under another test CA.
    shutil.copyfile(OUT / 'leaf.ext', OUT / 'alternate.ext')
    r.cmd('openssl', 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', OUT / 'alternate.key')
    r.cmd('openssl', 'req', '-new', '-key', OUT / 'alternate.key', '-subj', '/CN=Disposable Alternate', '-out', OUT / 'alternate.csr')
    r.cmd('openssl', 'ca', '-batch', '-notext', '-config', OUT / 'ca.cnf', '-in', OUT / 'alternate.csr', '-out', OUT / 'alternate.pem', '-extfile', OUT / 'alternate.ext', '-extensions', 'leaf', '-days', '2')
    shutil.copyfile(OUT / 'alternate.key', OUT / 'untrusted.key')
    r.cmd('openssl', 'x509', '-req', '-in', OUT / 'alternate.csr', '-CA', OUT / 'other-root.pem', '-CAkey', OUT / 'other-root.key', '-CAcreateserial', '-out', OUT / 'untrusted.pem', '-days', '2', '-extfile', OUT / 'alternate.ext', '-extensions', 'leaf')


def main():
    if shutil.disk_usage(ROOT).free < 6 * 1024**3:
        raise SystemExit('Need 6 GiB free; no shared-resource cleanup allowed')
    OUT.mkdir(parents=True, mode=0o700)
    r.cmd('git', 'check-ignore', OUT / 'private.key')
    device, listener = None, None
    summary = {'globalTrustChanged': False, 'cases': []}
    try:
        certificates()
        native = OUT / 'native'; native.mkdir()
        for file in r.pairing_sources(): shutil.copyfile(file, native / file.name)
        shutil.copyfile(r.NATIVE / 'SealedProtocol.swift', native / 'PairingSealedCodec.swift')
        source = OUT / 'source'; source.mkdir()
        shutil.copyfile(r.SOURCE / 'project.pbxproj', source / 'project.pbxproj')
        shutil.copyfile(SOURCE / 'Probe.swift', source / 'Probe.swift')
        r.SOURCE = source; r.NATIVE = native
        r.EXTRA_SOURCES = ('PairingSealedCodec.swift',)
        r.build()
        device = r.cmd('xcrun', 'simctl', 'create', 'Isolated Paired Control Proof', 'com.apple.CoreSimulator.SimDeviceType.iPhone-16', 'com.apple.CoreSimulator.SimRuntime.iOS-26-2')
        (OUT / 'owned-simulator.txt').write_text(device)
        r.cmd('xcrun', 'simctl', 'boot', device); r.cmd('xcrun', 'simctl', 'bootstatus', device, '-b')
        r.cmd('xcrun', 'simctl', 'install', device, OUT / 'PairingProbe.app')
        docs = Path(r.cmd('xcrun', 'simctl', 'get_app_container', device, BUNDLE, 'data')) / 'Documents'; docs.mkdir(exist_ok=True)
        # Do not spend a two-minute pairing offer on first-launch Simulator work.
        r.cmd('xcrun', 'simctl', 'launch', device, BUNDLE)
        r.wait(lambda: r.read_json(docs / 'result.json'), 180)
        r.cmd('xcrun', 'simctl', 'terminate', device, BUNDLE)
        with (OUT / 'listener.log').open('w') as log:
            listener = subprocess.Popen([str(ROOT / 'node_modules/.bin/tsx'), str(SOURCE / 'listener.mts'), str(OUT)], stdout=log, stderr=subprocess.STDOUT)
        ready = r.wait(lambda: r.read_json(OUT / 'ready.json'))
        for name in ready['cases']:
            (docs / 'result.json').unlink(missing_ok=True)
            shutil.copyfile(OUT / (name + '.qr'), docs / 'offer.bin'); (docs / 'role.txt').write_text(name)
            if name == 'future-pairing': shutil.copyfile(OUT / 'future-installation.qr', docs / 'future-installation.qr')
            if name == 'rotation-not-applied':
                for file in ['rotation.bin', 'rotation.nonce']: shutil.copyfile(OUT / file, docs / file)
            def result_or_approve():
                for suffix in ['', '.future']:
                    approval = name + suffix
                    if (OUT / (approval + '.awaiting')).exists() and not (OUT / (approval + '.approve')).exists():
                        (OUT / (approval + '.approve')).write_text('explicit-local-synthetic-approval')
                return r.read_json(docs / 'result.json')
            r.cmd('xcrun', 'simctl', 'launch', device, BUNDLE)
            result = r.wait(result_or_approve, 50)
            r.cmd('xcrun', 'simctl', 'terminate', device, BUNDLE)
            counts = r.read_json(OUT / 'state.json')[name]
            safe = {'name': name, **result, **counts}; summary['cases'].append(safe)
            (OUT / 'safe-summary.json').write_text(json.dumps(summary, indent=2))
            assert counts['enrolled'] == (2 if name == 'future-pairing' else 1) and counts['sinkBytes'] == 0 and counts['sinkCredentials'] == 0 and counts['cookieRequests'] == 0 and counts['sharedAuthRequests'] == 0, safe
            if name in ['positive', 'future-pairing', 'rotation-not-applied']:
                assert result['success'] and not result['received'] and counts['authorized'] == 5, safe
            else:
                assert not result['success'], safe
                if name in ['missing-confirmation', 'oversized-body', 'wrong-body', 'wrong-port', 'unconfirmed', 'stale', 'changed-confirmation', 'http', 'expired-pairing', 'wrong-key', 'wrong-host', 'wrong-chain', 'expired', 'future']:
                    assert counts['controls'] == 0, safe
                if name == 'oversized':
                    assert result['setup'] and not result.get('status') and counts['authorized'] == 2, safe
                if name in ['permission', 'wrong-query']:
                    assert result['setup'] and counts['controls'] == 1, safe
                if name == 'missing-installed':
                    assert result['setup'] and result['status'] and result['revoke'] and counts['authorized'] == 4, safe
                if name == 'oversized-control':
                    assert not result.get('setup') and counts['authorized'] == 1, safe
            print(name, 'PASS', flush=True)
    finally:
        if listener:
            listener.terminate()
            try: listener.wait(10)
            except subprocess.TimeoutExpired: listener.kill(); listener.wait()
        if device:
            try: r.cmd('xcrun', 'simctl', 'shutdown', device)
            finally: r.cmd('xcrun', 'simctl', 'delete', device)
        summary['ownedListenerStopped'] = listener is None or listener.poll() is not None
        summary['ownedSimulatorDeleted'] = device is None or device not in r.cmd('xcrun', 'simctl', 'list', 'devices', '-j')
        (OUT / 'safe-summary.json').write_text(json.dumps(summary, indent=2))
        print('Owned resources cleaned. Private artifacts:', OUT)


if __name__ == '__main__': main()
