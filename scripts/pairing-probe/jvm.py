#!/usr/bin/env python3
"""Compile all new Android pairing sources against android.jar, then exercise the
pure JSSE/client sources on a JVM. NOT AndroidKeyStore/emulator/release evidence.
Uses existing cached JDK/Kotlin; no download, SDK changes or AVD operations.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path
from run import ROOT, SOURCE, OUT, cmd, certs, read_json, wait


def first(paths):
    value = next(iter(paths), None)
    if value is None: raise RuntimeError('Required cached JDK/Kotlin/Android SDK unavailable')
    return value


def main():
    if shutil.disk_usage(ROOT).free < 3 * 1024**3: raise SystemExit('Need 3 GiB free')
    OUT.mkdir(parents=True, mode=0o700); cmd('git', 'check-ignore', OUT / 'private.key')
    home = Path.home()
    java = first((home / '.gradle/jdks').glob('*21*/*/Contents/Home/bin/java'))
    compiler = first((home / '.gradle/wrapper/dists').glob('gradle-9.4.1-bin/*/gradle-9.4.1/lib'))
    stdlib = compiler / 'kotlin-stdlib-2.3.0.jar'
    android = home / 'Library/Android/sdk/platforms/android-36/android.jar'
    native = ROOT / 'apps/mobile/modules/footage-transfer/android/src/main/java/expo/modules/footagetransfer'
    classes = OUT / 'classes'; classes.mkdir()
    classpath = os.pathsep.join(map(str, [stdlib, compiler / 'annotations-24.0.1.jar', android]))
    build = cmd(java, '-cp', str(compiler / '*'), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-classpath', classpath, '-d', classes, *sorted(native.glob('Pairing*.kt')), SOURCE / 'JVMProbe.kt')
    (OUT / 'kotlin-build.log').write_text(build)
    certs(); listener = None
    summary = {'platform': 'JVM 21 / Kotlin 2.3.0, Android 36 compile', 'androidKeyStoreExercised': False, 'globalTrustChanged': False, 'cases': []}
    try:
        with (OUT / 'listener.log').open('w') as log:
            listener = subprocess.Popen([str(ROOT / 'node_modules/.bin/tsx'), str(SOURCE / 'listener.mts'), str(OUT)], stdout=log, stderr=subprocess.STDOUT)
        ready = wait(lambda: read_json(OUT / 'ready.json'))
        for name in ready['cases']:
            with (OUT / (name + '.jvm.log')).open('w') as log:
                process = subprocess.Popen([str(java), '-cp', os.pathsep.join(map(str, [classes, stdlib])), 'expo.modules.footagetransfer.JVMProbeKt', str(OUT), name], stdout=log, stderr=subprocess.STDOUT)
            def result_or_approve():
                if (OUT / (name + '.awaiting')).exists() and not (OUT / (name + '.approve')).exists():
                    (OUT / (name + '.approve')).write_text('explicit-local-test-approval')
                return read_json(OUT / (name + '.result.json'))
            try:
                result = wait(result_or_approve, 50); process.wait(10)
            finally:
                if process.poll() is None: process.kill(); process.wait()
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
        summary['ownedListenerStopped'] = listener is None or listener.poll() is not None
        (OUT / 'safe-summary.json').write_text(json.dumps(summary, indent=2))
        print('Owned listener cleaned. Private artifacts:', OUT)


if __name__ == '__main__': main()
