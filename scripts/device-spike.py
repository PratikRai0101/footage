#!/usr/bin/env python3
"""Drive the generated test clip through Footage; never select personal footage.

Requires the diagnostic screen to be reviewing footage-generated-test.mp4, with
http://127.0.0.1:1080 configured and both development services running.
This exercises an ADB USB route, not Wi-Fi or mobile-data interruption.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import runpy
import re
import sqlite3
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
FOLDER = ROOT / 'artifacts/device-spike'
SOURCE = FOLDER / 'footage-generated-test.mp4'
PACKAGE = 'dev.footage.spike'


def adb(*args):
    return subprocess.run(['adb', *args], check=True, capture_output=True, timeout=15).stdout.decode().strip()


def native_state():
    # This is this debug app's own private record. Never print its capability.
    result = subprocess.run(['adb', 'exec-out', 'run-as', PACKAGE, 'cat', 'files/transfer.json'], capture_output=True, timeout=10)
    if result.returncode:
        return None
    raw = json.loads(result.stdout)
    return {key: raw[key] for key in ['id', 'confirmed', 'phase', 'bytes', 'sha256', 'endpoint']}


def wakefulness(power_dump):
    match = re.search(r'^\s*mWakefulness=(\w+)', power_dump, re.MULTILINE)
    return match.group(1) if match else 'Unknown'


def is_noninteractive(power_dump):
    # Samsung AOD reports Dozing, not Asleep. This does not prove deep Doze.
    return wakefulness(power_dump) in {'Asleep', 'Dozing'}


def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def main(start_only=False):
    events = []
    output = FOLDER / 'device-run.json'
    result = {'fixture': {'name': SOURCE.name, 'kind': 'generated 720p H.264/AAC test clip, not camera footage', 'bytes': SOURCE.stat().st_size, 'sha256': digest(SOURCE)}, 'route': 'ADB USB reverse, not Wi-Fi', 'device': {'model': adb('shell', 'getprop', 'ro.product.model'), 'api': adb('shell', 'getprop', 'ro.build.version.sdk')}, 'events': events, 'complete': False}

    def record(event, **fields):
        item = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'event': event, **fields}
        events.append(item)
        output.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(item), flush=True)

    db = sqlite3.connect(FOLDER / 'receiver/jobs.sqlite', isolation_level=None)
    previous_ids = {json.loads(row[0])['id'] for row in db.execute('SELECT document FROM jobs')}
    def job():
        for row in db.execute('SELECT document FROM jobs ORDER BY rowid DESC'):
            value = json.loads(row[0])
            if value['name'] == SOURCE.name and value['id'] not in previous_ids:
                return value
        return None

    def server_bytes(value):
        path = FOLDER / 'receiver/uploads' / value['id']
        return path.stat().st_size if path.exists() else 0

    route_removed = False
    screen_slept = False
    try:
        device_hash = adb('shell', 'sha256sum', '/sdcard/Download/' + SOURCE.name).split()[0]
        assert device_hash == result['fixture']['sha256'], 'Pushed fixture differs from host original'
        driver = runpy.run_path(str(ROOT / 'scripts/device-ui.py'))
        visible = [node.get('text') for node in driver['nodes']() if node.get('package') == PACKAGE]
        assert SOURCE.name in visible, 'Review the generated fixture, not personal media, before running'
        adb('shell', 'pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS')
        driver['tap_text']('Upload video')
        record('confirmed_upload_in_real_ui')
        home = False
        home_growth = False
        home_baseline = None
        cut = False
        resumed = False
        locked = False
        lock_baseline = None
        locked_growth = False
        waiting_seen = False
        wait_started = None
        paused_bytes = None
        deadline = time.monotonic() + 180
        identity = None
        while time.monotonic() < deadline:
            value = job()
            if value is None:
                time.sleep(0.15)
                continue
            if identity is None:
                identity = value['id']
                record('receiver_registered', id=identity)
            assert value['id'] == identity, 'Upload identity changed unexpectedly'
            count = server_bytes(value)
            if value['status'] == 'failed':
                raise RuntimeError('Receiver rejected integrity verification')
            if start_only and value['status'] != 'received':
                time.sleep(0.1)
                continue
            if not start_only and not home and count >= 2 * 1024 * 1024 and count < value['bytes']:
                adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
                home = True
                home_baseline = server_bytes(value)
                service = adb('shell', 'dumpsys', 'activity', 'services', PACKAGE)
                record('pressed_home', serverBytes=home_baseline, foregroundServiceObserved='isForeground=true' in service)
            elif home and not cut and home_baseline is not None and count > home_baseline:
                record('server_progress_after_home', serverBytes=count)
                home_growth = True
                adb('reverse', '--remove', 'tcp:1080')
                route_removed = True
                cut = True
                wait_started = time.monotonic()
                record('removed_usb_upload_route', serverBytes=server_bytes(value))
                # Removing a reverse listener does not close pooled active connections.
                # Reconnect ADB to close the actual USB channels, then leave upload forwarding absent.
                adb('reconnect')
                adb('wait-for-device')
                adb('reverse', 'tcp:8081', 'tcp:8081')
                record('usb_transport_reconnected_without_upload_route')
            elif cut and not resumed:
                state = native_state()
                if state and state['phase']['kind'] == 'waiting':
                    waiting_seen = True
                    paused_bytes = server_bytes(value)
                    record('native_waiting_observed', id=state['id'], confirmedBytes=state['confirmed'], serverBytes=paused_bytes)
                    adb('reverse', 'tcp:1080', 'tcp:1080')
                    route_removed = False
                    resumed = True
                    record('restored_usb_upload_route')
                elif wait_started is not None and time.monotonic() - wait_started > 35:
                    raise RuntimeError('Native waiting state was not observed after removing the USB route')
            elif resumed and not locked and paused_bytes is not None and count > paused_bytes:
                record('server_progress_after_route_restored', id=identity, serverBytes=count)
                adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
                screen_slept = True
                power = adb('shell', 'dumpsys', 'power')
                assert is_noninteractive(power), 'Non-interactive screen state was not observed'
                lock_baseline = server_bytes(value)
                locked = True
                record('screen_noninteractive_observed', serverBytes=lock_baseline, wakefulness=wakefulness(power))
            elif locked and not locked_growth and lock_baseline is not None and count > lock_baseline:
                power = adb('shell', 'dumpsys', 'power')
                locked_growth = is_noninteractive(power)
                record('server_progress_while_screen_noninteractive', serverBytes=count, noninteractive=locked_growth, wakefulness=wakefulness(power))
            if value['status'] == 'received':
                state = native_state()
                if state is None or state['phase']['kind'] != 'received':
                    time.sleep(0.15)
                    continue
                received_hash = digest(FOLDER / 'receiver/uploads' / identity)
                assert received_hash == device_hash == state['sha256'] == value['receipt']['sha256']
                assert state['phase']['receipt']['id'] == value['receipt']['id']
                assert count == result['fixture']['bytes']
                if start_only:
                    texts = [node.get('text', '') for node in driver['nodes']() if node.get('package') == PACKAGE]
                    bridge_errors = [text for text in texts if 'FootageTransfer.start' in text or 'Unknown type:' in text]
                    if bridge_errors:
                        raise AssertionError('Native start promise rejected: ' + ' '.join(bridge_errors))
                    assert 'Native transfer started.' in texts, 'JavaScript did not acknowledge the native start command'
                    record('native_start_promise_resolved_in_ui')
                result.update({'complete': True, 'jobId': identity, 'receipt': value['receipt'], 'homeProgressObserved': home_growth, 'usbInterruptionWaitingObserved': waiting_seen, 'noninteractiveScreenProgressObserved': locked_growth, 'nativeReceiptObserved': True, 'scenario': 'start-command-regression' if start_only else 'home-usb-recovery-noninteractive-screen', 'scenarioPassed': start_only or (home_growth and waiting_seen and locked_growth)})
                record('original_verified_on_both_sides', bytes=count, sha256=received_hash, receiptId=value['receipt']['id'])
                if not result['scenarioPassed']:
                    raise RuntimeError('File arrived intact, but not every lifecycle/interruption condition was observed')
                return
            time.sleep(0.1)
        raise TimeoutError('Device spike did not complete within 180 seconds')
    except Exception as error:
        result['error'] = str(error)
        record('run_failed', error=str(error), nativeState=native_state())
        raise
    finally:
        cleanup_errors = []
        for needed, command in [
            (route_removed, ('reverse', 'tcp:1080', 'tcp:1080')),
            (screen_slept, ('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')),
        ]:
            if needed:
                try:
                    adb(*command)
                except Exception as error:
                    cleanup_errors.append(str(error))
        if cleanup_errors:
            result['cleanupErrors'] = cleanup_errors
        db.close()
        output.write_text(json.dumps(result, indent=2) + '\n')
        if cleanup_errors and 'error' not in result:
            raise RuntimeError('The scenario finished but device cleanup requires attention: ' + '; '.join(cleanup_errors))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--start-only', action='store_true', help='Verify native start acknowledgment and receipt without Home, USB interruption, or screen locking.')
    arguments = parser.parse_args()
    main(start_only=arguments.start_only)
