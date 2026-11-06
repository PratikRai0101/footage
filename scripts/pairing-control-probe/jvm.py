#!/usr/bin/env python3
"""Compile all Pairing Kotlin including AndroidKeyStore vault; actual JSSE proof.
No AVD/AndroidKeyStore execution claim. Requires already cached local toolchain.
"""
import os
import shutil
import subprocess
from pathlib import Path
import run as control

ROOT, SOURCE, OUT, r = control.ROOT, control.SOURCE, control.OUT, control.r


def first(paths):
    value = next(iter(paths), None)
    if value is None: raise RuntimeError('Cached JDK/Kotlin/Android SDK required')
    return value


def main():
    if shutil.disk_usage(ROOT).free < 3 * 1024**3: raise SystemExit('Need 3 GiB free')
    OUT.mkdir(parents=True, mode=0o700)
    home = Path.home()
    java = first((home / '.gradle/jdks').glob('*21*/*/Contents/Home/bin/java'))
    compiler = first((home / '.gradle/wrapper/dists').glob('gradle-9.4.1-bin/*/gradle-9.4.1/lib'))
    stdlib = compiler / 'kotlin-stdlib-2.3.0.jar'
    android = home / 'Library/Android/sdk/platforms/android-36/android.jar'
    native = ROOT / 'apps/mobile/modules/footage-transfer/android/src/main/java/expo/modules/footagetransfer'
    classes = OUT / 'classes'; classes.mkdir()
    classpath = os.pathsep.join(map(str, [stdlib, compiler / 'annotations-24.0.1.jar', android]))
    build = r.cmd(java, '-cp', str(compiler / '*'), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-Werror', '-no-stdlib', '-no-reflect', '-classpath', classpath, '-d', classes, *sorted(native.glob('Pairing*.kt')), SOURCE / 'JVMProbe.kt')
    (OUT / 'kotlin-build.log').write_text(build)
    control.certificates(); listener = None
    summary = {'androidKeyStoreExercised': False, 'globalTrustChanged': False, 'cases': []}
    try:
        with (OUT / 'listener.log').open('w') as log:
            listener = subprocess.Popen([str(ROOT / 'node_modules/.bin/tsx'), str(SOURCE / 'listener.mts'), str(OUT)], stdout=log, stderr=subprocess.STDOUT)
        ready = r.wait(lambda: r.read_json(OUT / 'ready.json'))
        for name in ready['cases']:
            with (OUT / (name + '.jvm.log')).open('w') as log:
                process = subprocess.Popen([str(java), '-cp', os.pathsep.join(map(str, [classes, stdlib])), 'expo.modules.footagetransfer.JVMProbeKt', str(OUT), name], stdout=log, stderr=subprocess.STDOUT)
            def result_or_approve():
                for suffix in ['', '.future']:
                    approval = name + suffix
                    if (OUT / (approval + '.awaiting')).exists() and not (OUT / (approval + '.approve')).exists():
                        (OUT / (approval + '.approve')).write_text('explicit-local-synthetic-approval')
                return r.read_json(OUT / (name + '.result.json'))
            try:
                result = r.wait(result_or_approve, 50); process.wait(10)
            finally:
                if process.poll() is None: process.kill(); process.wait()
            counts = r.read_json(OUT / 'state.json')[name]
            safe = {'name': name, **result, **counts}; summary['cases'].append(safe)
            (OUT / 'safe-summary.json').write_text(__import__('json').dumps(summary, indent=2))
            assert counts['enrolled'] == (2 if name == 'future-pairing' else 1) and counts['sinkBytes'] == 0 and counts['sinkCredentials'] == 0 and counts['cookieRequests'] == 0 and counts['sharedAuthRequests'] == 0, safe
            if name in ['positive', 'future-pairing', 'rotation-not-applied']: assert result['success'] and counts['authorized'] == 5 and not result['received'], safe
            else:
                assert not result['success'], safe
                if name in ['missing-confirmation', 'oversized-body', 'wrong-body', 'wrong-port', 'unconfirmed', 'stale', 'changed-confirmation', 'http', 'expired-pairing', 'wrong-key', 'wrong-host', 'wrong-chain', 'expired', 'future']: assert counts['controls'] == 0, safe
                if name == 'oversized': assert result['setup'] and not result['status'] and counts['authorized'] == 2, safe
                if name in ['permission', 'wrong-query']: assert result['setup'] and counts['controls'] == 1, safe
                if name == 'missing-installed': assert result['setup'] and result['status'] and counts['authorized'] == 4, safe
                if name == 'oversized-control': assert not result['setup'] and counts['authorized'] == 1, safe
            print(name, 'PASS', flush=True)
    finally:
        if listener:
            listener.terminate()
            try: listener.wait(10)
            except subprocess.TimeoutExpired: listener.kill(); listener.wait()
        summary['ownedListenerStopped'] = listener is None or listener.poll() is not None
        (OUT / 'safe-summary.json').write_text(__import__('json').dumps(summary, indent=2))
        print('Owned listener cleaned. Private artifacts:', OUT)


if __name__ == '__main__': main()
