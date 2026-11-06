#!/usr/bin/env python3
"""Silent physical-phone recording of the explicitly supplied DJI file.

Never records the system picker, notification drawer, keyguard, or initial
viewer-link exchange. Original media is never edited or colour-graded.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import runpy
import shlex
import sqlite3
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
SERIAL = '<redacted-device-serial>'
PACKAGE = 'dev.footage.spike'
HOST = '<private-lan-ip>'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def main(take):
    os.environ['ANDROID_SERIAL'] = SERIAL
    ui = runpy.run_path(str(ROOT / 'scripts/device-ui.py'))
    folder = ROOT / 'artifacts/demo' / take
    folder.mkdir()
    source = json.loads((ROOT / 'artifacts/demo/dji-source.json').read_text())
    expected = digest(ROOT / 'artifacts/demo/source/dji-original.mp4')

    def adb(*args, binary=False):
        result = subprocess.check_output(['adb', '-s', SERIAL, *args], timeout=25)
        return result if binary else result.decode().strip()

    def shell(*args):
        return adb('shell', shlex.join(args))

    def own_nodes():
        return [n for n in ui['nodes']() if n.get('package') == PACKAGE]

    def own_text():
        return [n.get('text') or n.get('content-desc') or '' for n in own_nodes()]

    def locked():
        return 'mIsShowing=true' in adb('shell', 'dumpsys', 'window', 'policy')

    assert not locked(), 'User must unlock; no keyguard bypass.'
    # Original host/phone hashes were independently checked in the first take.
    # Each recorded job must additionally match that known digest and byte count.
    assert source['hostAndPhoneOriginalHashesMatch'] and source['sha256'] == expected
    assert int(shell('stat', '-c', '%s', source['phonePath'])) == source['bytes']
    assert any(source['name'] in text for text in own_text()) and 'Upload video' in own_text()
    assert not any('tcp:' + str(port) in adb('reverse', '--list') for port in (1080, 1082, 1083))
    original = {key: adb('shell', 'settings', 'get', 'global', key) for key in ('wifi_on', 'mobile_data', 'low_power', 'heads_up_notifications_enabled')}
    result = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'take': take, 'device': 'Physical Samsung SM-N981U1 / Android13, USB-powered foreground recording', 'apkSha256': digest(ROOT / 'artifacts/footage-demo.apk'), 'fixture': {'name': source['name'], 'bytes': source['bytes'], 'sha256': expected}, 'settingsBefore': original, 'audio': 'none', 'rateLimiterUsed': False, 'events': [], 'recordings': [], 'passed': False}
    db = sqlite3.connect(ROOT / 'artifacts/device-spike/receiver/jobs.sqlite', isolation_level=None)
    previous = {r[0] for r in db.execute('SELECT id FROM jobs')}

    def event(name, **fields):
        item = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'event': name, **fields}
        result['events'].append(item)
        (folder / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(item), flush=True)

    class Recording:
        def __init__(self, name):
            self.name = name
            self.remote = '/data/local/tmp/footage-' + take + '-' + name + '.mp4'
            self.pid = int(adb('shell', 'screenrecord --size 1080x2400 --bit-rate 8000000 --time-limit 180 ' + shlex.quote(self.remote) + ' </dev/null >/data/local/tmp/footage-screenrecord.log 2>&1 & echo $!'))
            self.started = time.monotonic()
            event('recording_started', clip=name)

        def stop(self):
            command = adb('shell', 'cat /proc/' + str(self.pid) + '/cmdline 2>/dev/null || true')
            if self.remote in command and 'screenrecord' in command:
                adb('shell', 'kill -2 ' + str(self.pid))
            for _ in range(50):
                if self.remote not in adb('shell', 'cat /proc/' + str(self.pid) + '/cmdline 2>/dev/null || true'): break
                time.sleep(.1)
            destination = folder / (self.name + '.mp4')
            subprocess.run(['adb', '-s', SERIAL, 'pull', self.remote, str(destination)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            shell('rm', '-f', self.remote)
            result['recordings'].append({'file': str(destination.relative_to(ROOT)), 'kind': 'Uncut silent physical screen recording', 'bytes': destination.stat().st_size})
            event('recording_saved', clip=self.name)

    recording = None
    try:
        # Suppress personal notification banners for this foreground capture only.
        adb('shell', 'settings', 'put', 'global', 'heads_up_notifications_enabled', '0')
        adb('shell', 'svc', 'wifi', 'enable')
        for _ in range(90):
            route = subprocess.run(['adb', '-s', SERIAL, 'shell', 'ip', 'route', 'get', HOST], capture_output=True, text=True).stdout
            if 'dev wlan0' in route: break
            time.sleep(.5)
        else: raise TimeoutError('Connect phone to the same Wi-Fi as the Mac.')
        adb('shell', 'svc', 'data', 'disable')
        health = adb('shell', "printf 'GET /health HTTP/1.0\\r\\nHost: " + HOST + "\\r\\n\\r\\n' | toybox nc -w 4 " + HOST + ' 1080')
        assert '200 OK' in health and 'footage-receiver' in health, 'Phone cannot reach the owned receiver over Wi-Fi.'
        ui['set_server_origin']('http://' + HOST + ':1080')
        event('wlan_route_ready', cellularFallbackDisabled=True, usbUploadReverse=False)
        recording = Recording('01-review-playback')
        time.sleep(3)
        ui['tap_text']('Play local preview')
        time.sleep(10)
        # Upload pauses the preview; no picker or other app is recorded.
        recording.stop(); recording = None
        recording = Recording('02-upload-recovery-01')
        ui['tap_text']('Upload video')
        event('upload_confirmed')
        identity = None
        cut = False
        resumed = False
        last_touch = time.monotonic()
        last_report = time.monotonic()
        deadline = time.monotonic() + 900
        part = 1
        while time.monotonic() < deadline:
            jobs = [json.loads(r[0]) for r in db.execute('SELECT document FROM jobs')]
            jobs = [j for j in jobs if j['id'] not in previous and j['name'] == source['name'] and j['sha256'] == expected]
            if not jobs:
                time.sleep(.1); continue
            assert len(jobs) == 1, 'A different upload identity replaced the DJI job.'
            job = jobs[0]
            identity = identity or job['id']
            assert identity == job['id']
            target = ROOT / 'artifacts/device-spike/receiver/uploads' / identity
            count = target.stat().st_size if target.exists() else 0
            if not cut and count >= 32 * 1024 * 1024 and job['status'] != 'received':
                adb('shell', 'svc', 'wifi', 'disable')
                event('actual_wifi_disabled', jobId=identity, serverBytes=count)
                waiting = time.monotonic() + 35
                while time.monotonic() < waiting:
                    if 'Your progress is saved' in own_text(): break
                    if time.monotonic() - last_touch > 8:
                        adb('shell', 'input', 'tap', '180', '340'); last_touch = time.monotonic()
                    time.sleep(.2)
                else: raise TimeoutError('Actual waiting UI did not appear.')
                paused = target.stat().st_size
                event('waiting_visible', serverBytes=paused, jobId=identity)
                time.sleep(4)
                adb('shell', 'svc', 'wifi', 'enable')
                event('wifi_enabled_again')
                cut = True
            if cut and not resumed and count > paused + 128 * 1024:
                resumed = True
                event('same_job_recovery', jobId=identity, serverBytes=count)
            if time.monotonic() - last_touch > 8:
                # Keep foreground recording awake; this is NOT a screen-off test.
                adb('shell', 'input', 'tap', '180', '340'); last_touch = time.monotonic()
            if time.monotonic() - last_report > 15:
                event('server_progress', serverBytes=count); last_report = time.monotonic()
            if time.monotonic() - recording.started > 170:
                recording.stop(); part += 1
                recording = Recording('02-upload-recovery-' + str(part).zfill(2))
            if job['status'] == 'received':
                assert cut and resumed
                assert count == source['bytes'] and digest(target) == expected == job['receipt']['sha256']
                for _ in range(20):
                    if 'Original verified' in own_text(): break
                    time.sleep(.2)
                else: raise AssertionError('Matching server receipt was not shown by native UI.')
                event('actual_original_verified', jobId=identity, bytes=count)
                result['receipt'] = job['receipt']; result['jobId'] = identity
                time.sleep(5)
                ui['tap_text']('Verification details')
                time.sleep(5)
                recording.stop(); recording = None
                break
            assert job['status'] != 'failed'
            time.sleep(.1)
        else: raise TimeoutError('Recording exceeded safety deadline.')
        ui['tap_text']('View received file')
        for _ in range(20):
            nodes = list(ui['nodes']())
            labels = [n.get('text') or n.get('content-desc') or '' for n in nodes]
            if source['name'] in labels and any(expected in text for text in labels):
                assert not any('/receive#' in text for text in labels)
                break
            time.sleep(.3)
        else: raise AssertionError('Owned original viewer did not render; browser recording not started.')
        recording = Recording('03-received-viewer')
        # The full original and the visible controls are real, never a transcoded demo.
        labels = [n.get('text') or n.get('content-desc') or '' for n in ui['nodes']()]
        if 'Play' in labels:
            ui['tap_text']('Play')
        time.sleep(10)
        recording.stop(); recording = None
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
        result['passed'] = True
        event('silent_capture_complete', independentOriginalHashMatch=True)
    except BaseException as error:
        result['error'] = str(error)
        event('recording_failed', error=str(error))
        # Preserve an unfinished native job; never rewrite its authority/outcome.
        raise
    finally:
        if recording:
            try: recording.stop()
            except Exception as error: result['recordingCleanupError'] = str(error)
        for key, service in (('mobile_data', 'data'), ('wifi_on', 'wifi')):
            adb('shell', 'svc', service, 'enable' if original[key] == '1' else 'disable')
        if original['heads_up_notifications_enabled'] == 'null':
            adb('shell', 'settings', 'delete', 'global', 'heads_up_notifications_enabled')
        else:
            adb('shell', 'settings', 'put', 'global', 'heads_up_notifications_enabled', original['heads_up_notifications_enabled'])
        result['settingsAfter'] = {key: adb('shell', 'settings', 'get', 'global', key) for key in original}
        result['settingsRestored'] = result['settingsAfter'] == original
        db.close()
        (folder / 'result.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--take', default='take-1')
    args = parser.parse_args()
    assert args.take.replace('-', '').isalnum()
    main(args.take)
