#!/usr/bin/env python3
"""Generated-video screen-off Wi-Fi test with a bounded streaming network limiter.

Requires Footage reviewing footage-wifi-test.mp4 on an unlocked device. No lock
bypass, battery exemption, personal footage, or receiver restart. An idle gap
fails the test. The screen is not woken until after the verdict is recorded.
"""
import argparse
import datetime
import ipaddress
import json
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
FOLDER = ROOT / 'artifacts/device-spike'
H = runpy.run_path(str(ROOT / 'scripts/device-spike.py'))
D = runpy.run_path(str(ROOT / 'scripts/device-ui.py'))
adb = H['adb']
PACKAGE = 'dev.footage.spike'
CPU_TAG = 'Footage:transfer-cpu'
WIFI_TAG = 'Footage:transfer-wifi'


def settings():
    return {key: adb('shell', 'settings', 'get', 'global', key) for key in ['wifi_on', 'mobile_data', 'low_power']}


def power_state():
    power = adb('shell', 'dumpsys', 'power')
    match = re.search(r'\bmLastWakeTime=(\d+)', power)
    assert match, 'Cannot prove a continuous non-interactive interval without the wake timestamp.'
    cpu = [line.strip() for line in power.splitlines() if CPU_TAG in line]
    wifi = adb('shell', f'dumpsys wifi | grep -F "{WIFI_TAG}" || true')
    return {'wakefulness': H['wakefulness'](power), 'noninteractive': H['is_noninteractive'](power), 'lastWakeTime': match.group(1), 'cpuLeaseHeld': any('PARTIAL_WAKE_LOCK' in line and 'DISABLED' not in line for line in cpu), 'wifiLeaseHeld': WIFI_TAG in wifi, 'ownCpuLocks': cpu, 'ownWifiLocks': wifi.strip()}


def main(args):
    ip = ipaddress.ip_address(args.host)
    assert ip.version == 4 and ip.is_private and not (ip.is_loopback or ip.is_link_local or ip.is_unspecified)
    assert re.fullmatch(r'[a-z0-9-]+', args.label), 'Use a simple evidence label.'
    fixture = FOLDER / 'footage-wifi-test.mp4'
    source_hash = H['digest'](fixture)
    assert adb('shell', 'sha256sum', '/sdcard/Download/' + fixture.name).split()[0] == source_hash
    before = settings()
    assert before['wifi_on'] == '1' and before['mobile_data'] in {'0', '1'}
    route = adb('shell', 'ip', 'route', 'get', args.host)
    peer = re.search(r'\bsrc (\d+\.\d+\.\d+\.\d+)', route)
    assert 'dev wlan0' in route and peer
    assert 'tcp:1082' not in adb('reverse', '--list') and 'tcp:1080' not in adb('reverse', '--list')
    nodes = [n for n in D['nodes']() if n.get('package') == PACKAGE]
    assert fixture.name in [n.get('text') for n in nodes]
    origin = f'http://{args.host}:1082'
    existing = H['native_state']() if args.resume_existing else None
    if existing:
        assert existing['sha256'] == source_hash and existing['endpoint'] == origin
        assert existing['phase']['kind'] in {'waiting', 'uploading'}
        assert 'Continue upload' in [n.get('text') for n in nodes]
        original_origin = f'http://{args.host}:1080'
    else:
        assert 'Upload video' in [n.get('text') for n in nodes], 'Review only the generated fixture first.'
        original_origin = next(n.get('text') for n in nodes if n.get('class') == 'android.widget.EditText')
    with socket.socket() as probe:
        assert probe.connect_ex((args.host, 1082)) != 0, 'Do not replace another process on the test port.'
    assert not (args.cancel_only and args.resume_existing), 'Cancellation mode starts its own generated-fixture job.'
    output = FOLDER / f'screen-stress-{args.label}.json'
    assert not output.exists(), 'Evidence already exists. Choose a fresh --label instead of overwriting it.'
    result = {'scenario': 'extended-screen-off-real-wifi', 'scenarioPassed': False, 'fixture': {'name': fixture.name, 'bytes': fixture.stat().st_size, 'sha256': source_hash, 'provenance': 'generated H.264/AAC, not camera footage'}, 'origin': origin, 'transport': 'phone WLAN to test-only streaming limiter to unchanged receiver; USB-powered; no upload forwarding', 'limiter': {'patchBytesPerSecond': 131072, 'reason': 'Keep the actual transfer active for multiple minutes, not a throughput measurement'}, 'settingsBefore': before, 'events': []}

    if args.cancel_only:
        result['scenario'] = 'foreground-cancellation-resource-release'

    def record(event, **fields):
        entry = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'event': event, **fields}
        result['events'].append(entry)
        output.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(entry), flush=True)

    db = sqlite3.connect(FOLDER / 'receiver/jobs.sqlite', isolation_level=None)
    previous = {row[0] for row in db.execute('SELECT id FROM jobs')}
    if existing:
        previous.discard(existing['id'])
    result['resumingExistingJob'] = bool(existing)
    log = (FOLDER / f'screen-proxy-{args.label}.log').open('w')
    proxy = subprocess.Popen(['node', str(ROOT / 'scripts/limited-receiver.mjs'), args.host], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    identity = None
    slept = False
    try:
        for _ in range(30):
            assert proxy.poll() is None, 'Test proxy failed to start.'
            try:
                with urllib.request.urlopen(origin + '/health', timeout=1) as response:
                    assert response.status == 200
                break
            except OSError:
                time.sleep(.1)
        else:
            raise TimeoutError('Test proxy did not become ready.')
        if not existing:
            D['set_server_origin'](origin)
        adb('shell', 'svc', 'data', 'disable')
        assert settings()['mobile_data'] == '0'
        D['tap_text']('Continue upload' if existing else 'Upload video')
        record('upload_confirmed', power=power_state(), phoneWifiAddress=peer.group(1))
        deadline = time.monotonic() + args.deadline
        last_change = time.monotonic()
        last_count = 0
        screen_started = None
        screen_state = None
        last_report = time.monotonic()
        while time.monotonic() < deadline:
            rows = db.execute('SELECT id,document FROM jobs ORDER BY rowid DESC').fetchall()
            found = [(key, json.loads(raw)) for key, raw in rows if key not in previous]
            if identity is None:
                found = [(key, value) for key, value in found if value['name'] == fixture.name and value['sha256'] == source_hash]
                if not found:
                    assert time.monotonic() - last_change < 60, 'No generated-fixture job registered.'
                    time.sleep(.2)
                    continue
                assert len(found) == 1
                identity = found[0][0]
                result['jobId'] = identity
                record('job_registered', id=identity)
            server = next(value for key, value in found if key == identity)
            received = FOLDER / 'receiver/uploads' / identity
            count = received.stat().st_size if received.exists() else 0
            if count > last_count:
                last_change = time.monotonic()
                last_count = count
            if screen_started is None and count >= 512 * 1024:
                native = H['native_state']()
                assert native['id'] == identity and native['endpoint'] == origin
                if native['phase']['kind'] == 'waiting':
                    time.sleep(.2)
                    continue
                assert native['phase']['kind'] == 'uploading', 'Native owner did not begin the existing upload.'
                sockets = subprocess.run(['lsof', '-nP', '-iTCP:1082', '-sTCP:ESTABLISHED'], capture_output=True, text=True, check=True).stdout
                assert f'->{peer.group(1)}:' in sockets
                service = adb('shell', 'dumpsys', 'activity', 'services', PACKAGE)
                assert 'isForeground=true' in service
                active_power = power_state()
                record('active_transfer_resources', power=active_power, serverBytes=count)
                if args.require_lease:
                    assert active_power['cpuLeaseHeld'], 'Native transfer has no active partial CPU wake lock.'
                if args.require_wifi_lease:
                    assert active_power['wifiLeaseHeld'], 'Native Wi-Fi transfer has no radio wake lock.'
                if args.cancel_only:
                    D['tap_text']('Cancel upload')
                    cancelled_power = power_state()
                    assert not cancelled_power['cpuLeaseHeld'] and not cancelled_power['wifiLeaseHeld'], 'Execution resources remained held after cancellation.'
                    for _ in range(150):
                        native = H['native_state']()
                        if native['phase']['kind'] == 'cancelled' and not native['phase']['cleanupPending']:
                            break
                        time.sleep(.2)
                    assert native['id'] == identity and native['phase']['kind'] == 'cancelled' and not native['phase']['cleanupPending']
                    cancelled_server = json.loads(db.execute('SELECT document FROM jobs WHERE id=?', (identity,)).fetchone()[0])
                    assert cancelled_server['status'] == 'cancelled' and cancelled_server.get('receipt') is None
                    assert not received.exists(), 'Cancelled receiver file was not cleaned up.'
                    result.update({'scenarioPassed': True, 'resourcesReleased': True, 'serverCleanupConfirmed': True, 'receiptIssued': False})
                    record('cancelled_with_resources_released_and_no_receipt', power=cancelled_power)
                    return
                adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
                slept = True
                screen_state = power_state()
                assert screen_state['noninteractive']
                screen_started = time.monotonic()
                record('screen_noninteractive_quiet_window_started', power=screen_state, serverBytes=count)
                # During the quiet window only the receiver's local file/DB is polled.
                # No ADB/native-state polling can periodically wake the phone's CPU.
            if time.monotonic() - last_change > args.idle_limit:
                raise TimeoutError(f'No server byte progress for {args.idle_limit} seconds with the screen non-interactive.')
            if time.monotonic() - last_report > 30:
                record('host_only_progress_observation', serverBytes=count, idleSeconds=round(time.monotonic() - last_change, 1))
                last_report = time.monotonic()
            if server['status'] == 'received':
                assert screen_started is not None
                after = power_state()
                screen_seconds = time.monotonic() - screen_started
                record('server_received_before_any_wake_or_network_restore', power=after, serverBytes=count, noninteractiveSeconds=round(screen_seconds, 1))
                assert after['noninteractive'] and after['lastWakeTime'] == screen_state['lastWakeTime'], 'Phone woke during the supposed continuous screen-off interval.'
                assert screen_seconds >= args.minimum_screen_seconds, 'Transfer finished too soon to count as an extended test.'
                native = H['native_state']()
                for _ in range(20):
                    if native and native['phase']['kind'] == 'received':
                        break
                    time.sleep(.2)
                    native = H['native_state']()
                assert native['id'] == identity and native['phase']['kind'] == 'received'
                assert server['receipt'] == native['phase']['receipt']
                assert count == fixture.stat().st_size == native['confirmed'] == server['receipt']['bytes']
                assert H['digest'](received) == source_hash == server['receipt']['sha256']
                for _ in range(20):
                    released = power_state()
                    if not released['cpuLeaseHeld'] and not released['wifiLeaseHeld']:
                        break
                    time.sleep(.2)
                assert not released['cpuLeaseHeld'] and not released['wifiLeaseHeld'], 'Execution resources leaked after receipt.'
                assert settings()['mobile_data'] == '0' and settings()['low_power'] == before['low_power']
                result.update({'scenarioPassed': True, 'receipt': server['receipt'], 'noninteractiveSeconds': round(screen_seconds, 1), 'noWakeDuringTransfer': True, 'independentHashMatch': True, 'resourcesReleased': True})
                record('extended_screen_off_transfer_verified', releasedPower=released)
                return
            assert server['status'] != 'failed', 'Receiver rejected the original.'
            time.sleep(.15)
        raise TimeoutError('Extended screen-off test reached its total safety deadline.')
    except BaseException as error:
        result['error'] = str(error)
        record('screen_stress_failed_before_cleanup', error=str(error), power=power_state(), native=H['native_state']())
        raise
    finally:
        cleanup_errors = []
        if slept:
            try:
                adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
            except Exception as error:
                cleanup_errors.append(str(error))
        if not result['scenarioPassed'] and identity:
            try:
                native = H['native_state']()
                if native and native['id'] == identity and native['phase']['kind'] not in {'received', 'cancelled'}:
                    adb('shell', 'am', 'start', '-n', PACKAGE + '/.MainActivity')
                    D['tap_text']('Cancel upload')
                    for _ in range(50):
                        native = H['native_state']()
                        if native['phase']['kind'] == 'cancelled' and not native['phase']['cleanupPending']:
                            break
                        time.sleep(.2)
                    assert native['phase']['kind'] in {'cancelled', 'received'}
                    record('owned_test_job_cancelled_after_failed_verdict', phase=native['phase']['kind'])
            except BaseException as error:
                result['uiCancellationDeferred'] = str(error)
                try:
                    # Stop only this test app if the secure keyguard prevents its Cancel UI.
                    # This is explicit test cleanup, never counted as autonomous recovery.
                    adb('shell', 'am', 'force-stop', PACKAGE)
                    record('owned_app_force_stopped_after_failed_test', reason='Could not reach Cancel without unlocking', power=power_state())
                except Exception as stop_error:
                    cleanup_errors.append(str(stop_error))
        try:
            adb('shell', 'svc', 'data', 'enable' if before['mobile_data'] == '1' else 'disable')
            result['settingsAfter'] = settings()
            assert result['settingsAfter'] == before, 'Original network/power flags were not restored.'
        except BaseException as error:
            cleanup_errors.append(str(error))
        # Restoring an app-only text field is not a reason to unlock/bypass the keyguard.
        # The native job is either received or explicitly stopped before the proxy exits.
        result['uiOriginRestorePending'] = original_origin
        proxy.terminate()
        try:
            proxy.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proxy.kill()
            proxy.wait(timeout=5)
        log.close()
        db.close()
        if cleanup_errors:
            result['cleanupErrors'] = cleanup_errors
        output.write_text(json.dumps(result, indent=2) + '\n')
        if cleanup_errors and result['scenarioPassed']:
            raise RuntimeError('Test passed but cleanup needs attention: ' + '; '.join(cleanup_errors))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--require-lease', action='store_true')
    parser.add_argument('--require-wifi-lease', action='store_true')
    parser.add_argument('--resume-existing', action='store_true')
    parser.add_argument('--cancel-only', action='store_true', help='Test visible cancellation and resource release instead of screen-off completion')
    parser.add_argument('--minimum-screen-seconds', type=int, default=180)
    parser.add_argument('--idle-limit', type=int, default=60)
    parser.add_argument('--deadline', type=int, default=600)
    args = parser.parse_args()
    def interrupted(signum, frame):
        raise KeyboardInterrupt('Runner interrupted')
    for sig in [signal.SIGTERM, signal.SIGINT]:
        signal.signal(sig, interrupted)
    main(args)
