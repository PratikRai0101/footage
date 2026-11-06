#!/usr/bin/env python3
"""Standalone native pairing-source proof; no Expo build, OS trust edit or server routes.
Only creates/stops its own Simulator/listener. Keys and payloads stay ignored.
"""
import json
import plistlib
import shutil
import subprocess
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().parent
NATIVE = ROOT / 'apps/mobile/modules/footage-transfer/ios'
# These are the G1-only owner sources. The paired BackgroundControl adapter is
# compiled by the integrated runtime harness, not by this standalone G1 target.
PAIRING_SOURCES = ('PairingClient.swift', 'PairingControl.swift', 'PairingTrust.swift', 'PairingWire.swift')
EXTRA_SOURCES = ()


def pairing_sources():
    return [NATIVE / name for name in (*PAIRING_SOURCES, *EXTRA_SOURCES)]
OUT = ROOT / 'artifacts/pairing-probe' / str(uuid.uuid4())
BUNDLE = 'test.footage.pairingprobe'


def cmd(*args):
    result = subprocess.run([str(x) for x in args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode:
        (OUT / 'command-error.log').write_bytes(result.stdout)
        raise RuntimeError('Command failed; see ignored command-error.log')
    return result.stdout.decode().strip()


def wait(check, seconds=60):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = check()
        if value is not None:
            return value
        time.sleep(.1)
    raise TimeoutError('Native probe timed out')


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def certs():
    for name in ['root', 'other-root']:
        cmd('openssl', 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', OUT / (name + '.key'))
        conf = OUT / (name + '.cnf')
        conf.write_text('[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Disposable Pairing CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n')
        cmd('openssl', 'req', '-x509', '-new', '-key', OUT / (name + '.key'), '-days', '2', '-config', conf, '-out', OUT / (name + '.pem'))
        cmd('openssl', 'x509', '-in', OUT / (name + '.pem'), '-outform', 'DER', '-out', OUT / (name + '.der'))
    (OUT / 'index').write_text(''); (OUT / 'serial').write_text('1000')
    conf = OUT / 'ca.cnf'
    conf.write_text(f'[ca]\ndefault_ca=local\n[local]\ndatabase={OUT}/index\nserial={OUT}/serial\nnew_certs_dir={OUT}\ncertificate={OUT}/root.pem\nprivate_key={OUT}/root.key\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n')
    for name in ['leaf', 'wrong-host', 'expired', 'future', 'missing-eku', 'missing-san']:
        cmd('openssl', 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', OUT / (name + '.key'))
        cmd('openssl', 'req', '-new', '-key', OUT / (name + '.key'), '-subj', '/CN=' + name, '-out', OUT / (name + '.csr'))
        ext = OUT / (name + '.ext')
        text = '[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n'
        if name != 'missing-eku': text += 'extendedKeyUsage=serverAuth\n'
        if name != 'missing-san': text += 'subjectAltName=DNS:' + ('wrong.invalid' if name == 'wrong-host' else 'localhost') + '\n'
        ext.write_text(text)
        dates = ['-days', '2']
        if name == 'expired': dates = ['-startdate', '20200101000000Z', '-enddate', '20200102000000Z']
        if name == 'future': dates = ['-startdate', '20400101000000Z', '-enddate', '20400102000000Z']
        cmd('openssl', 'ca', '-batch', '-notext', '-config', conf, '-in', OUT / (name + '.csr'), '-out', OUT / (name + '.pem'), '-extfile', ext, '-extensions', 'leaf', *dates)
    # Same CA key/name, but an expired independently acquired anchor. Some trust
    # stacks exempt anchor validity, so production code must check it explicitly.
    cmd('openssl', 'req', '-new', '-key', OUT / 'root.key', '-subj', '/CN=Disposable Pairing CA', '-out', OUT / 'expired-anchor.csr')
    cmd('openssl', 'ca', '-batch', '-selfsign', '-notext', '-config', conf, '-in', OUT / 'expired-anchor.csr', '-out', OUT / 'expired-anchor.pem', '-extfile', OUT / 'root.cnf', '-extensions', 'ca', '-startdate', '20200101000000Z', '-enddate', '20200102000000Z')
    cmd('openssl', 'x509', '-in', OUT / 'expired-anchor.pem', '-outform', 'DER', '-out', OUT / 'expired-anchor.der')


def build():
    sources = ['Probe.swift'] + [p.name for p in pairing_sources()]
    shutil.copyfile(SOURCE / 'Probe.swift', OUT / 'Probe.swift')
    for p in pairing_sources(): shutil.copyfile(p, OUT / p.name)
    # Small checked-in template; independent native source compilation, no package/config edits.
    project = (SOURCE / 'project.pbxproj').read_text()
    refs, builds, groups, files = [], [], [], []
    for i, name in enumerate(sources[1:]):
        ref, build_id = f'B{i:023X}', f'C{i:023X}'
        refs.append(f'{ref} = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {name}; sourceTree = "<group>"; }};')
        builds.append(f'{build_id} = {{isa = PBXBuildFile; fileRef = {ref}; }};')
        groups.append(ref); files.append(build_id)
    project = project.replace('A00000000000000000000007, A00000000000000000000004', 'A00000000000000000000007, ' + ', '.join(groups) + ', A00000000000000000000004')
    project = project.replace('files = (A0000000000000000000000C)', 'files = (A0000000000000000000000C, ' + ', '.join(files) + ')')
    project = project.replace(' };\n rootObject', '\n' + '\n'.join(refs + builds) + '\n };\n rootObject')
    project = project.replace('TransportProbe', 'PairingProbe').replace('test.footage.transportprobe', BUNDLE)
    xcode = OUT / 'PairingProbe.xcodeproj'; xcode.mkdir(); (xcode / 'project.pbxproj').write_text(project)
    info = {'CFBundleIdentifier': BUNDLE, 'CFBundleName': 'PairingProbe', 'CFBundleExecutable': 'PairingProbe', 'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0', 'MinimumOSVersion': '17.0', 'LSRequiresIPhoneOS': True, 'UIDeviceFamily': [1], 'UILaunchScreen': {}, 'NSAppTransportSecurity': {'NSAllowsArbitraryLoads': False, 'NSAllowsLocalNetworking': False}, 'NSLocalNetworkUsageDescription': 'Disposable pairing proof.'}
    (OUT / 'Info.plist').write_bytes(plistlib.dumps(info))
    log = cmd('xcodebuild', '-project', xcode, '-target', 'PairingProbe', '-configuration', 'Debug', '-sdk', 'iphonesimulator', '-arch', 'arm64', 'CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_IDENTITY=-', f'CONFIGURATION_BUILD_DIR={OUT}', f'OBJROOT={OUT}/obj', f'SYMROOT={OUT}/sym')
    (OUT / 'build.log').write_text(log)


def main():
    if shutil.disk_usage(ROOT).free < 6 * 1024**3: raise SystemExit('Need 6 GiB free; no shared-resource deletion allowed')
    OUT.mkdir(parents=True, mode=0o700); cmd('git', 'check-ignore', OUT / 'private.key')
    device, listener = None, None
    summary = {'platform': {'xcode': cmd('xcodebuild', '-version'), 'runtime': 'iOS 26.2', 'arch': 'arm64'}, 'globalTrustChanged': False, 'cases': []}
    try:
        certs(); build()
        device = cmd('xcrun', 'simctl', 'create', 'Isolated Pairing Proof', 'com.apple.CoreSimulator.SimDeviceType.iPhone-16', 'com.apple.CoreSimulator.SimRuntime.iOS-26-2')
        (OUT / 'owned-simulator.txt').write_text(device)
        cmd('xcrun', 'simctl', 'boot', device); cmd('xcrun', 'simctl', 'bootstatus', device, '-b')
        cmd('xcrun', 'simctl', 'install', device, OUT / 'PairingProbe.app')
        container = Path(cmd('xcrun', 'simctl', 'get_app_container', device, BUNDLE, 'data')); docs = container / 'Documents'; docs.mkdir(exist_ok=True)
        # A fresh Simulator's first app launch can take longer than the QR's
        # strict two-minute lifetime. Warm UIKit before minting any offer. Missing
        # config fails without creating keys or sending a request.
        cmd('xcrun', 'simctl', 'launch', device, BUNDLE)
        wait(lambda: read_json(docs / 'result.json'), 180)
        cmd('xcrun', 'simctl', 'terminate', device, BUNDLE)
        with (OUT / 'listener.log').open('w') as log:
            listener = subprocess.Popen([str(ROOT / 'node_modules/.bin/tsx'), str(SOURCE / 'listener.mts'), str(OUT)], stdout=log, stderr=subprocess.STDOUT)
        ready = wait(lambda: read_json(OUT / 'ready.json'))
        for name in ready['cases']:
            mode = 'lost' if name == 'lost' else 'pair'
            (docs / 'result.json').unlink(missing_ok=True)
            shutil.copyfile(OUT / (name + '.qr'), docs / 'offer.bin')
            if name == 'positive':
                for file in ['rotation.bin', 'rotation.nonce']: shutil.copyfile(OUT / file, docs / file)
            (docs / 'config.json').write_text(json.dumps({'name': name, 'mode': mode}))
            # This runner is the trusted local operator for synthetic identities ONLY.
            # Approval isn't reachable over any listener; no production auto-approval.
            def result_or_approve():
                if (OUT / (name + '.awaiting')).exists() and not (OUT / (name + '.approve')).exists():
                    (OUT / (name + '.approve')).write_text('explicit-local-test-approval')
                return read_json(docs / 'result.json')
            cmd('xcrun', 'simctl', 'launch', device, BUNDLE)
            result = wait(result_or_approve, 50)
            cmd('xcrun', 'simctl', 'terminate', device, BUNDLE)
            counts = read_json(OUT / 'state.json')[name]
            safe = {'name': name, **result, **counts}; summary['cases'].append(safe)
            (OUT / 'safe-summary.json').write_text(json.dumps(summary, indent=2))
            assert counts['sinkBytes'] == 0 and counts['cookieRequests'] == 0 and counts['authorizationRequests'] == 0, safe
            if name in ['positive', 'lost']:
                assert result['success'] and result['installed'] and counts['enrollments'] == 1 and counts['recoveries'] == 1 and counts['localApprovals'] == 1, safe
            else:
                assert not result['success'], safe
                if not name.startswith('redirect-') and not name.endswith('-reply') and name != 'http-auth': assert counts['receiverBytes'] == 0, safe
            print(name, 'PASS', flush=True)
    finally:
        if listener:
            listener.terminate()
            try: listener.wait(10)
            except subprocess.TimeoutExpired: listener.kill(); listener.wait()
        if device:
            try: cmd('xcrun', 'simctl', 'shutdown', device)
            finally: cmd('xcrun', 'simctl', 'delete', device)
        summary['ownedListenerStopped'] = listener is None or listener.poll() is not None
        summary['ownedSimulatorDeleted'] = device is None or device not in cmd('xcrun', 'simctl', 'list', 'devices', '-j')
        (OUT / 'safe-summary.json').write_text(json.dumps(summary, indent=2))
        print('Owned resources cleaned. Private artifacts:', OUT)


if __name__ == '__main__': main()
