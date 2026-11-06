#!/usr/bin/env python3
"""Generated-fixture tests for the standalone physical Android app.

Uses public UI, OS execution state and independent receiver bytes. Never reads
native authority/private files, selects personal media or bypasses keyguard.
"""
import argparse
import datetime
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import runpy
import signal
import socket
import sqlite3
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = 'dev.footage.spike'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def main(args):
    assert args.serial == os.environ.get('FOOTAGE_AUTHORIZED_ANDROID_SERIAL'), 'Set FOOTAGE_AUTHORIZED_ANDROID_SERIAL to explicitly authorize this test phone.'
    host = ipaddress.ip_address(args.host)
    assert host.version == 4 and host.is_private and not (host.is_loopback or host.is_unspecified or host.is_link_local)
    os.environ['ANDROID_SERIAL'] = args.serial
    ui = runpy.run_path(str(ROOT / 'scripts/device-ui.py'))
    out = ROOT / 'artifacts/android-final-device'
    label = args.label or args.case
    assert re.fullmatch(r'[a-z0-9-]+', label)
    output = out / (label + '.json')
    assert not output.exists(), 'Preserve prior verdicts; use a separate evidence folder for a repeat.'
    source = ROOT / 'artifacts/device-spike/footage-wifi-test.mp4'
    expected = digest(source)

    def adb(*command):
        return subprocess.check_output(['adb', '-s', args.serial, *command], text=True, timeout=20).strip()

    def settings():
        return {key: adb('shell', 'settings', 'get', 'global', key) for key in ('wifi_on', 'mobile_data', 'low_power')}

    def power():
        text = adb('shell', 'dumpsys', 'power')
        wifi = adb('shell', 'dumpsys', 'wifi')
        match = re.search(r'\bmLastWakeTime=(\d+)', text)
        assert match
        cpu = [line for line in text.splitlines() if 'Footage:transfer-cpu' in line and 'PARTIAL_WAKE_LOCK' in line and 'DISABLED' not in line]
        state = re.search(r'\bmWakefulness=(\w+)', text)
        return {'wakefulness': state.group(1), 'lastWakeTime': match.group(1), 'cpuLockHeld': bool(cpu), 'wifiLockHeld': 'Footage:transfer-wifi' in wifi}

    def own_text():
        return [node.get('text') or node.get('content-desc') for node in ui['nodes']() if node.get('package') == PACKAGE]

    before = settings()
    assert before['wifi_on'] == '1' and before['mobile_data'] in ('0', '1')
    route = adb('shell', 'ip', 'route', 'get', args.host)
    peer = re.search(r'\bsrc (\d+\.\d+\.\d+\.\d+)', route)
    assert 'dev wlan0' in route and peer
    assert not any('tcp:' + str(port) in adb('reverse', '--list') for port in (1080, 1082, 1083))
    assert adb('shell', 'sha256sum', '/sdcard/Download/' + source.name).split()[0] == expected
    assert source.name in own_text() and 'Upload video' in own_text()
    with socket.socket() as sock:
        assert sock.connect_ex((args.host, 1082)) != 0
    result = {'case': args.case, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'passed': False, 'route': 'Actual physical phone WLAN → streaming limiter → unchanged primary receiver; no USB upload reverse; USB-powered', 'device': {'serial': '<redacted-device-serial>', 'model': 'SM-N981U1', 'api': 33}, 'fixture': {'name': source.name, 'bytes': source.stat().st_size, 'sha256': expected}, 'settingsBefore': before, 'events': []}

    def record(event, **fields):
        item = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'event': event, **fields}
        result['events'].append(item)
        output.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(item), flush=True)

    db = sqlite3.connect(ROOT / 'artifacts/device-spike/receiver/jobs.sqlite', isolation_level=None)
    previous = {row[0] for row in db.execute('SELECT id FROM jobs')}
    log = (out / (label + '-proxy.log')).open('w')
    proxy = subprocess.Popen(['node', str(ROOT / 'scripts/limited-receiver.mjs'), args.host, '1082', '131072', '1080'], stdout=log, stderr=subprocess.STDOUT, cwd=ROOT)
    origin = 'http://' + args.host + ':1082'
    identity = None
    quiet = False
    sleep_state = None
    try:
        for _ in range(40):
            assert proxy.poll() is None
            try:
                urllib.request.urlopen(origin + '/health', timeout=1).close(); break
            except OSError:
                time.sleep(.1)
        else:
            raise TimeoutError('Test limiter did not start.')
        ui['set_server_origin'](origin)
        adb('shell', 'svc', 'data', 'disable')
        assert settings()['mobile_data'] == '0'
        ui['tap_text']('Upload video')
        record('native_upload_confirmed_in_real_ui', cellularFallbackDisabled=True)
        deadline = time.monotonic() + 600
        changed = time.monotonic()
        count = 0
        stage = 'home'
        last_report = time.monotonic()
        while time.monotonic() < deadline:
            rows = [json.loads(row[0]) for row in db.execute('SELECT document FROM jobs')]
            jobs = [job for job in rows if job['id'] not in previous and job['name'] == source.name and job['sha256'] == expected]
            if not jobs:
                assert time.monotonic() - changed < 45, 'No matching job registered.'
                time.sleep(.15); continue
            assert len(jobs) == 1, 'Upload identity changed.'
            job = jobs[0]
            identity = identity or job['id']
            assert identity == job['id']
            file = ROOT / 'artifacts/device-spike/receiver/uploads' / identity
            current = file.stat().st_size if file.exists() else 0
            if current > count:
                changed = time.monotonic(); count = current
            if stage == 'home' and current >= 512 * 1024:
                resources = power()
                assert resources['cpuLockHeld'] and resources['wifiLockHeld']
                assert 'isForeground=true' in adb('shell', 'dumpsys', 'activity', 'services', PACKAGE)
                sockets = subprocess.check_output(['lsof', '-nP', '-iTCP:1082', '-sTCP:ESTABLISHED'], text=True)
                assert '->' + peer.group(1) + ':' in sockets
                record('physical_wlan_peer_and_execution_resources_verified', jobId=identity, serverBytes=current, power=resources, phoneWifiAddress=peer.group(1))
                if args.case == 'cancel':
                    ui['tap_text']('Cancel upload')
                    for _ in range(50):
                        value = json.loads(db.execute('SELECT document FROM jobs WHERE id=?', (identity,)).fetchone()[0])
                        if value['status'] == 'cancelled' and not file.exists(): break
                        time.sleep(.2)
                    assert value['status'] == 'cancelled' and value.get('receipt') is None and not file.exists()
                    for _ in range(15):
                        released = power()
                        if not released['cpuLockHeld'] and not released['wifiLockHeld']: break
                        time.sleep(.2)
                    assert not released['cpuLockHeld'] and not released['wifiLockHeld']
                    assert any(text and 'Uploaded data was removed' in text for text in own_text())
                    result.update({'passed': True, 'jobId': identity, 'serverCleanupConfirmed': True, 'receiptIssued': False, 'resourcesReleased': True})
                    record('visible_cancel_confirmed_no_receipt', power=released)
                    return
                adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
                baseline = file.stat().st_size
                stage = 'home-progress'
                record('home_pressed', serverBytes=baseline)
            elif stage == 'home-progress' and current >= baseline + 256 * 1024:
                record('actual_server_progress_after_home', serverBytes=current)
                adb('shell', 'am', 'start', '-n', PACKAGE + '/.MainActivity')
                adb('shell', 'svc', 'wifi', 'disable')
                assert settings()['mobile_data'] == '0'
                record('actual_wifi_disabled_no_cellular_fallback', serverBytes=file.stat().st_size)
                waiting_deadline = time.monotonic() + 35
                while time.monotonic() < waiting_deadline:
                    if 'Your progress is saved' in own_text(): break
                    time.sleep(.2)
                else:
                    raise TimeoutError('Visible waiting state not observed after actual Wi-Fi loss.')
                out.joinpath('wifi-waiting.png').write_bytes(subprocess.check_output(['adb', '-s', args.serial, 'exec-out', 'screencap', '-p']))
                paused = file.stat().st_size
                record('real_waiting_ui_observed_same_job', serverBytes=paused)
                adb('shell', 'svc', 'wifi', 'enable')
                for _ in range(100):
                    if 'dev wlan0' in subprocess.run(['adb', '-s', args.serial, 'shell', 'ip', 'route', 'get', args.host], capture_output=True, text=True, timeout=10).stdout: break
                    time.sleep(.3)
                else:
                    raise TimeoutError('Wi-Fi route did not return.')
                stage = 'recovery'
            elif stage == 'recovery' and current > paused + 128 * 1024:
                record('same_identity_progress_after_wifi_restoration', serverBytes=current, jobId=identity)
                resources = power()
                assert resources['cpuLockHeld'] and resources['wifiLockHeld']
                adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
                sleep_state = power()
                assert sleep_state['wakefulness'] in ('Dozing', 'Asleep')
                screen_started = time.monotonic(); quiet = True; stage = 'quiet'
                record('quiet_screen_off_window_started', power=sleep_state, serverBytes=current)
                # During this interval no ADB/native/UI polling occurs.
            if stage == 'quiet' and time.monotonic() - changed > 60:
                raise TimeoutError('No server progress for 60 seconds during quiet screen-off window.')
            if time.monotonic() - last_report > 30:
                record('host_only_byte_observation', serverBytes=current)
                last_report = time.monotonic()
            if job['status'] == 'received':
                assert quiet
                after = power(); seconds = time.monotonic() - screen_started
                assert after['wakefulness'] in ('Dozing', 'Asleep') and after['lastWakeTime'] == sleep_state['lastWakeTime']
                assert seconds >= 120, 'Screen-off interval too short for this controlled test.'
                assert current == source.stat().st_size and digest(file) == expected == job['receipt']['sha256']
                for _ in range(30):
                    released = power()
                    if not released['cpuLockHeld'] and not released['wifiLockHeld']: break
                    time.sleep(.2)
                assert not released['cpuLockHeld'] and not released['wifiLockHeld']
                result.update({'passed': True, 'jobId': identity, 'receipt': job['receipt'], 'screenOffSeconds': round(seconds, 1), 'lastWakeTimestampUnchanged': True, 'independentHashMatch': True, 'resourcesReleased': True, 'nativeReceiptUiAfterWake': 'Awaiting user unlock if secure keyguard is shown'})
                record('received_and_hashed_before_any_test_wake', power=after, noninteractiveSeconds=round(seconds, 1), serverBytes=current)
                return
            assert job['status'] != 'failed'
            time.sleep(.2)
        raise TimeoutError('Physical test safety deadline reached.')
    except BaseException as error:
        result['error'] = str(error)
        record('failed_before_cleanup', error=str(error))
        # No force-unlock or private-state rewrite. Stop only this owned test app.
        adb('shell', 'am', 'force-stop', PACKAGE)
        result['failureIntervention'] = 'Owned test app stopped; job retained. Not an autonomous recovery pass.'
        raise
    finally:
        adb('shell', 'svc', 'wifi', 'enable' if before['wifi_on'] == '1' else 'disable')
        adb('shell', 'svc', 'data', 'enable' if before['mobile_data'] == '1' else 'disable')
        result['settingsAfterCase'] = settings()
        if quiet:
            adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
        proxy.terminate()
        try: proxy.wait(timeout=5)
        except subprocess.TimeoutExpired: proxy.kill(); proxy.wait(timeout=5)
        db.close(); log.close()
        output.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--host', required=True)
    parser.add_argument('--label', help='Fresh evidence label for an explicit repeat; never overwrite a failed run')
    parser.add_argument('--case', choices=['wifi-home-screen', 'cancel'], required=True)
    main(parser.parse_args())
