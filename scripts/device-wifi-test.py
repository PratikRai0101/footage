#!/usr/bin/env python3
"""Test a reviewed generated clip over real Wi-Fi, with cellular fallback disabled.

Requires the private receiver bound to the Mac's LAN address, no USB upload
forward, and footage-generated-test.mp4 selected in Footage's review screen.
Restores Wi-Fi and cellular settings. Never selects personal footage.
"""
import argparse
import datetime
import ipaddress
import json
from pathlib import Path
import re
import runpy
import sqlite3
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
FOLDER = ROOT / 'artifacts/device-spike'
helpers = runpy.run_path(str(ROOT / 'scripts/device-spike.py'))
adb = helpers['adb']
PACKAGE = 'dev.footage.spike'


def setting(name):
    return adb('shell', 'settings', 'get', 'global', name)


def route(host):
    result = subprocess.run(['adb', 'shell', 'ip', 'route', 'get', host], capture_output=True, text=True, timeout=10)
    return result.stdout.strip() or result.stderr.strip()


def wifi_address():
    output = adb('shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0')
    match = re.search(r'\binet (\d+\.\d+\.\d+\.\d+)/', output)
    return match.group(1) if match else None


def wait_for_wifi(host, enabled):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        current = setting('wifi_on')
        current_route = route(host)
        if enabled and current == '1' and 'dev wlan0' in current_route and wifi_address():
            return
        if not enabled and current == '0' and 'dev wlan0' not in current_route:
            return
        time.sleep(.4)
    raise TimeoutError('Wi-Fi did not reach the requested connection state.')


def main(host, resume_existing=False, fixture='footage-generated-test.mp4'):
    ip = ipaddress.ip_address(host)
    if ip.version != 4 or not ip.is_private or ip.is_loopback or ip.is_unspecified or ip.is_link_local:
        raise SystemExit('Use the owned receiver private LAN IPv4 address, not a USB/loopback route.')
    origin = f'http://{host}:1080'
    assert fixture in {'footage-generated-test.mp4', 'footage-wifi-test.mp4'}, 'Use only the generated test fixtures.'
    source = FOLDER / fixture
    original_hash = helpers['digest'](source)
    initial_wifi = setting('wifi_on')
    initial_data = setting('mobile_data')
    assert initial_wifi == '1' and initial_data in {'0', '1'}, 'Cannot safely restore unknown network settings.'
    assert 'dev wlan0' in route(host), 'Receiver route must use Wi-Fi.'
    assert 'tcp:1080' not in adb('reverse', '--list'), 'Remove the USB upload forward before testing Wi-Fi.'
    phone_ip = wifi_address()
    assert phone_ip, 'Phone has no Wi-Fi IPv4 address.'
    driver = runpy.run_path(str(ROOT / 'scripts/device-ui.py'))
    existing_native = helpers['native_state']() if resume_existing else None
    if resume_existing:
        assert existing_native and existing_native['endpoint'] == origin and existing_native['sha256'] == original_hash, 'Existing native job does not match the generated fixture and LAN receiver.'
        assert existing_native['phase']['kind'] in {'waiting', 'uploading'}, 'The existing transfer must still be active.'
    else:
        own_nodes = [n for n in driver['nodes']() if n.get('package') == PACKAGE]
        texts = [n.get('text') for n in own_nodes]
        assert source.name in texts, 'Review the generated clip before starting; never select personal media.'
        assert origin in [n.get('text') for n in own_nodes if n.get('class') == 'android.widget.EditText'], 'Verify the full LAN origin in the server field before changing network settings.'
    assert adb('shell', 'sha256sum', '/sdcard/Download/' + source.name).split()[0] == original_hash
    db = sqlite3.connect(FOLDER / 'receiver/jobs.sqlite', isolation_level=None)
    previous = {json.loads(row[0])['id'] for row in db.execute('SELECT document FROM jobs')}
    initial_bytes = 0
    if existing_native:
        row = db.execute('SELECT document FROM jobs WHERE id=?', (existing_native['id'],)).fetchone()
        assert row
        existing_job = json.loads(row[0])
        assert existing_job['name'] == source.name and existing_job['sha256'] == original_hash and existing_job['status'] == 'uploading'
        previous.discard(existing_native['id'])
        initial_bytes = (FOLDER / 'receiver/uploads' / existing_native['id']).stat().st_size
    result = {'scenario': 'wifi-loss-recovery-home-noninteractive-screen', 'origin': origin, 'route': 'direct Wi-Fi; no USB upload forward; phone USB-powered', 'device': {'model': adb('shell', 'getprop', 'ro.product.model'), 'api': adb('shell', 'getprop', 'ro.build.version.sdk')}, 'fixture': {'name': source.name, 'provenance': 'generated 720p H.264/AAC video, not camera footage', 'bytes': source.stat().st_size, 'sha256': original_hash}, 'networkBefore': {'wifi': initial_wifi, 'mobileData': initial_data}, 'events': [], 'scenarioPassed': False}
    result.update({'resumingExistingJob': resume_existing, 'initialServerBytes': initial_bytes})
    output = FOLDER / 'wifi-run.json'

    def record(event, **fields):
        entry = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'event': event, **fields}
        result['events'].append(entry)
        output.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(entry), flush=True)

    def job():
        for row in db.execute('SELECT document FROM jobs ORDER BY rowid DESC'):
            value = json.loads(row[0])
            if value['id'] not in previous and value['name'] == source.name:
                return value
        return None

    def count_bytes(identity):
        path = FOLDER / 'receiver/uploads' / identity
        return path.stat().st_size if path.exists() else 0

    slept = False
    try:
        if initial_data == '1':
            adb('shell', 'svc', 'data', 'disable')
        assert setting('mobile_data') == '0', 'Could not disable cellular fallback; do not claim a network-loss pass.'
        record('cellular_fallback_disabled', wifiAddress=phone_ip, receiverRoute=route(host), uploadUsbForwardPresent=False)
        adb('shell', 'pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS')
        if existing_native:
            record('existing_job_observer_ready', id=existing_native['id'], serverBytes=initial_bytes)
        else:
            driver['tap_text']('Upload video')
            record('upload_confirmed_in_real_ui')
        identity = None
        home_baseline = None
        home_growth = False
        cut = False
        waiting = False
        resumed = False
        paused = None
        noninteractive_baseline = None
        noninteractive_growth = False
        deadline = time.monotonic() + 900
        registration_deadline = time.monotonic() + 60
        last_progress_at = time.monotonic()
        last_count = initial_bytes
        last_reported_count = initial_bytes
        while time.monotonic() < deadline:
            value = job()
            if value is None:
                if time.monotonic() > registration_deadline:
                    raise TimeoutError('No receiver job was created. Inspect preparation, the address field, and native scheduling before retrying.')
                time.sleep(.15)
                continue
            if identity is None:
                identity = value['id']
                state = helpers['native_state']()
                assert state and state['id'] == identity and state['endpoint'] == origin, 'Native job is not using the direct LAN origin.'
                record('direct_wifi_job_observed', id=identity, nativeEndpoint=state['endpoint'], existingJob=resume_existing)
            assert value['id'] == identity, 'A new upload identity replaced the interrupted transfer.'
            count = count_bytes(identity)
            if count > last_count:
                last_count = count
                last_progress_at = time.monotonic()
            if count - last_reported_count >= 32 * 1024 * 1024:
                record('server_bytes_progress', serverBytes=count)
                last_reported_count = count
            if time.monotonic() - last_progress_at > 90:
                raise TimeoutError('No server byte progress for 90 seconds; inspect the existing job rather than wait for the total-run deadline.')
            current_native = helpers['native_state']()
            if current_native and current_native['id'] == identity and current_native['phase']['kind'] == 'failed':
                raise RuntimeError('Native transfer failed: ' + current_native['phase']['reason'])
            if value['status'] == 'failed':
                raise RuntimeError('Receiver rejected integrity verification.')
            if home_baseline is None and initial_bytes + 2 * 1024 * 1024 <= count < value['bytes']:
                sockets = subprocess.run(['lsof', '-nP', '-iTCP:1080', '-sTCP:ESTABLISHED'], capture_output=True, text=True, timeout=10).stdout
                assert f'->{phone_ip}:' in sockets, 'Receiver TCP peer was not the phone Wi-Fi address.'
                record('receiver_tcp_peer_is_phone_wifi', phoneWifiAddress=phone_ip)
                adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
                home_baseline = count_bytes(identity)
                service = adb('shell', 'dumpsys', 'activity', 'services', PACKAGE)
                assert 'isForeground=true' in service, 'Native foreground service was not observed.'
                record('pressed_home_with_foreground_service', serverBytes=home_baseline)
            elif home_baseline is not None and not cut and count > home_baseline:
                home_growth = True
                record('server_progress_after_home_over_wifi', serverBytes=count)
                adb('shell', 'svc', 'wifi', 'disable')
                cut = True
                wait_for_wifi(host, False)
                assert setting('mobile_data') == '0'
                record('wifi_off_cellular_off', serverBytes=count_bytes(identity), receiverRoute=route(host))
            elif cut and not resumed:
                state = helpers['native_state']()
                if state and state['phase']['kind'] == 'failed':
                    raise RuntimeError('Native transfer became terminal instead of waiting: ' + state['phase']['reason'])
                if state and state['phase']['kind'] == 'waiting':
                    assert state['id'] == identity
                    waiting = True
                    paused = count_bytes(identity)
                    record('native_waiting_during_actual_network_loss', confirmedBytes=state['confirmed'], serverBytes=paused)
                    adb('shell', 'svc', 'wifi', 'enable')
                    wait_for_wifi(host, True)
                    phone_ip = wifi_address()
                    resumed = True
                    record('wifi_reconnected', receiverRoute=route(host), phoneWifiAddress=phone_ip, mobileData=setting('mobile_data'))
            elif resumed and noninteractive_baseline is None and paused is not None and count > paused:
                record('same_identity_progress_after_wifi_reconnect', id=identity, serverBytes=count)
                adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
                slept = True
                power = adb('shell', 'dumpsys', 'power')
                assert helpers['is_noninteractive'](power), 'Non-interactive state was not observed.'
                noninteractive_baseline = count_bytes(identity)
                assert noninteractive_baseline < value['bytes'], 'Upload finished before non-interactive progress could be tested.'
                record('screen_noninteractive_over_wifi', serverBytes=noninteractive_baseline, wakefulness=helpers['wakefulness'](power))
            elif noninteractive_baseline is not None and not noninteractive_growth and count > noninteractive_baseline:
                power = adb('shell', 'dumpsys', 'power')
                assert helpers['is_noninteractive'](power), 'Screen became interactive before progress was proven.'
                noninteractive_growth = True
                record('server_progress_over_wifi_while_noninteractive', serverBytes=count, wakefulness=helpers['wakefulness'](power))
            if value['status'] == 'received':
                state = helpers['native_state']()
                if not state or state['phase']['kind'] != 'received':
                    time.sleep(.15)
                    continue
                assert home_growth and waiting and resumed and noninteractive_growth, 'Not all Wi-Fi lifecycle conditions were observed.'
                assert state['id'] == identity and state['endpoint'] == origin
                assert count == source.stat().st_size == state['bytes'] == value['receipt']['bytes']
                assert helpers['digest'](FOLDER / 'receiver/uploads' / identity) == original_hash == state['sha256'] == value['receipt']['sha256']
                assert state['phase']['receipt'] == value['receipt']
                result.update({'scenarioPassed': True, 'jobId': identity, 'receipt': value['receipt'], 'homeProgressObserved': home_growth, 'networkLossWaitingObserved': waiting, 'sameIdentityResumeObserved': resumed, 'noninteractiveWifiProgressObserved': noninteractive_growth})
                record('original_verified_after_real_wifi_interruption', receiptId=value['receipt']['id'], bytes=count, sha256=original_hash)
                return
            time.sleep(.15)
        raise TimeoutError('Wi-Fi scenario exceeded the 900-second total safety deadline.')
    except Exception as error:
        result['error'] = str(error)
        record('wifi_test_failed', error=str(error))
        raise
    finally:
        cleanup_errors = []
        for command in [('shell', 'svc', 'wifi', 'enable'), ('shell', 'svc', 'data', 'enable' if initial_data == '1' else 'disable')]:
            try:
                adb(*command)
            except Exception as error:
                cleanup_errors.append(str(error))
        if slept:
            try:
                adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
            except Exception as error:
                cleanup_errors.append(str(error))
        try:
            for _ in range(20):
                result['networkAfter'] = {'wifi': setting('wifi_on'), 'mobileData': setting('mobile_data')}
                if result['networkAfter'] == result['networkBefore']:
                    break
                time.sleep(.2)
            assert result['networkAfter'] == result['networkBefore'], 'Original network settings were not restored.'
        except Exception as error:
            cleanup_errors.append(str(error))
        if cleanup_errors:
            result['cleanupErrors'] = cleanup_errors
        db.close()
        output.write_text(json.dumps(result, indent=2) + '\n')
        if cleanup_errors and 'error' not in result:
            raise RuntimeError('Device settings cleanup needs attention: ' + '; '.join(cleanup_errors))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True, help='Owned receiver private LAN IPv4 address')
    parser.add_argument('--resume-existing', action='store_true', help='Observe and interrupt the existing generated-clip job instead of selecting or creating another upload.')
    parser.add_argument('--fixture', choices=['footage-generated-test.mp4', 'footage-wifi-test.mp4'], default='footage-generated-test.mp4')
    args = parser.parse_args()
    main(args.host, resume_existing=args.resume_existing, fixture=args.fixture)
