#!/usr/bin/env python3
"""Exercise the standalone app on an isolated emulator, without Metro.

Real system picker and native owner; the test proxy interrupts transport, not
Wi-Fi. Only the known generated fixture and isolated test receiver are used.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import runpy
import sqlite3
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts/ui-emulator'


def main(host, serial):
    assert serial.startswith('emulator-'), 'This runner never drives a personal phone.'
    os.environ['ANDROID_SERIAL'] = serial
    ui = runpy.run_path(str(ROOT / 'scripts/device-ui.py'))
    a = ui['adb']
    fixture = OUT / 'footage-playback-test.mp4'
    source_sha = hashlib.sha256(fixture.read_bytes()).hexdigest()
    assert a('shell', 'sha256sum', '/sdcard/Download/' + fixture.name).decode().split()[0] == source_sha
    assert subprocess.run(['lsof', '-iTCP:8081', '-sTCP:LISTEN'], capture_output=True).returncode != 0, 'Stop Metro before claiming a standalone pass.'
    db = sqlite3.connect(OUT / 'receiver/jobs.sqlite', isolation_level=None)
    previous = {row[0] for row in db.execute('SELECT id FROM jobs')}
    result = {'scenario': 'standalone-emulator-native-intake-and-transport-recovery', 'scope': 'Android API 36 emulator. Proxy interruption is not physical Wi-Fi, unplugged, or deep-Doze evidence.', 'metroAbsent': True, 'receiptDeliveryDelayMs': 4000, 'fixture': {'name': fixture.name, 'bytes': fixture.stat().st_size, 'sha256': source_sha}, 'events': [], 'passed': False}
    output = OUT / 'standalone-intake.json'
    assert not output.exists(), 'Archive the prior result before rerunning.'
    log = (OUT / 'standalone-proxy.log').open('w')
    proxy = None

    def record(event, **fields):
        item = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'event': event, **fields}
        result['events'].append(item)
        output.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(item), flush=True)

    def start_proxy():
        return subprocess.Popen(['node', str(ROOT / 'scripts/limited-receiver.mjs'), host, '1082', '131072', '1083', '4000'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)

    def stop_proxy():
        if proxy and proxy.poll() is None:
            proxy.terminate()
            try:
                proxy.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proxy.kill(); proxy.wait(timeout=5)

    def nodes():
        return [n for n in ui['nodes']() if n.get('package') == 'dev.footage.spike']

    def snapshot(name):
        (OUT / name).write_bytes(a('exec-out', 'screencap', '-p'))

    try:
        proxy = start_proxy()
        ui['set_server_origin'](f'http://{host}:1082')
        ui['tap_text']('Send another clip')
        ui['tap_text'](fixture.name)
        snapshot('07-standalone-review.png')
        ui['tap_text']('Upload video')
        record('real_ui_upload_confirmed')
        identity = None
        interrupted = False
        resumed = False
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            values = [json.loads(row[0]) for row in db.execute('SELECT document FROM jobs')]
            jobs = [v for v in values if v['id'] not in previous]
            if not jobs:
                time.sleep(.2); continue
            assert len(jobs) == 1, 'The interrupted upload was replaced by another identity.'
            job = jobs[0]
            assert job['name'] == fixture.name and job['sha256'] == source_sha
            identity = identity or job['id']
            assert job['id'] == identity
            file = OUT / 'receiver/uploads' / identity
            count = file.stat().st_size
            if count >= 2 * 1024 * 1024 + 512 * 1024 and not interrupted:
                snapshot('08-standalone-uploading.png')
                stop_proxy(); interrupted = True
                record('test_transport_closed_mid_patch', jobId=identity, serverBytes=count)
                waiting_deadline = time.monotonic() + 45
                while time.monotonic() < waiting_deadline:
                    text = [n.get('text') for n in nodes()]
                    if 'Your progress is saved' in text:
                        break
                    time.sleep(.3)
                else:
                    raise TimeoutError('Waiting state was not observed after transport loss.')
                snapshot('09-standalone-waiting.png')
                record('waiting_visible_without_new_upload', serverBytes=file.stat().st_size)
                proxy = start_proxy()
                resumed = True
            if job['status'] == 'received':
                assert interrupted and resumed
                assert file.stat().st_size == fixture.stat().st_size
                assert hashlib.sha256(file.read_bytes()).hexdigest() == source_sha == job['receipt']['sha256']
                for _ in range(30):
                    text = [n.get('text') for n in nodes()]
                    if 'Verifying the original' in text:
                        snapshot('09b-standalone-verifying.png')
                        result['verificationStateObserved'] = True
                    if 'Original verified' in text:
                        break
                    time.sleep(.2)
                else:
                    raise AssertionError('Server received but the native UI did not publish receipt.')
                snapshot('10-standalone-received.png')
                result.update({'passed': True, 'jobId': identity, 'receipt': job['receipt'], 'sameIdentityRecovery': True, 'independentHashMatch': True})
                record('standalone_original_verified', bytes=file.stat().st_size)
                return
            time.sleep(.2)
        raise TimeoutError('Standalone native intake did not complete within the safety deadline.')
    except BaseException as error:
        result['error'] = str(error)
        record('standalone_test_failed', error=str(error))
        raise
    finally:
        stop_proxy(); log.close(); db.close()
        output.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True)
    parser.add_argument('--serial', default='emulator-5554')
    args = parser.parse_args()
    main(args.host, args.serial)
