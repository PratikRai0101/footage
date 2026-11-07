#!/usr/bin/env python3
"""Cancel an already-reviewed generated Android original during a real sealed
request. Only signals the owned fixture and reads the owned emulator's app state.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'artifacts/mobile-parity'
adb = str(Path.home() / 'Library/Android/sdk/platform-tools/adb')
pid = int((OUT / 'receiver.pid').read_text())
assert 'scripts/test/mobile-parity/receiver.mts' in subprocess.check_output(['ps', '-p', str(pid), '-o', 'args='], text=True)
assert (OUT / 'avd-name.txt').read_text().strip() in subprocess.check_output([adb, '-s', 'emulator-5584', 'emu', 'avd', 'name'], text=True)
def native():
    return json.loads(subprocess.check_output([adb, '-s', 'emulator-5584', 'shell', 'cat', '/data/user/0/dev.footage.spike/files/transfer.json'], text=True))
def device(*args):
    return subprocess.check_output(['npx', '--yes', 'agent-device@0.21.35', *args, '--session', 'footage06-android'], text=True)
before = native()['id']; log = OUT / 'receiver.log'; initial = log.read_text().count('Observed POST /sealed/v1/ingest')
paused = threading.Event(); stop = threading.Event()
def watch():
    while not stop.wait(.001):
        if log.read_text().count('Observed POST /sealed/v1/ingest') > initial:
            os.kill(pid, signal.SIGSTOP); paused.set(); return
thread = threading.Thread(target=watch, daemon=True); thread.start()
try:
    device('press', 'role=button label="Upload original"', '--settle')
    assert paused.wait(15), 'No real ingest request'
    active = native(); assert active['id'] != before and active['protocol'] == 'Sealed' and active['phase']['kind'] != 'received'
    device('press', 'role=button label="Cancel upload"', '--settle')
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        pending = native()
        if pending['phase']['kind'] == 'cancelled': break
        time.sleep(.1)
    assert pending['phase']['kind'] == 'cancelled' and pending['phase']['cleanupPending'] is True
    (OUT / 'android-cancel-pending-ui.txt').write_text(device('snapshot', '-i'))
    record = {'platform': 'android', 'jobId': active['id'], 'nativeSocketCancellation': True, 'receiverUnreachableDuringCancel': True, 'cleanupPendingBeforeReconnect': True, 'confirmedBeforeCancel': active['confirmed']}
    os.kill(pid, signal.SIGCONT); paused.clear()
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        after = native()
        if after['phase']['kind'] == 'cancelled' and not after['phase']['cleanupPending']: break
        time.sleep(.1)
    if after['phase']['cleanupPending']:
        device('press', 'role=button label="Retry cleanup"', '--settle')
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            after = native()
            if after['phase']['kind'] == 'cancelled' and not after['phase']['cleanupPending']: break
            time.sleep(.1)
    assert after['phase']['kind'] == 'cancelled' and not after['phase']['cleanupPending']
    source = subprocess.check_output([adb, '-s', 'emulator-5584', 'shell', 'sha256sum', '/sdcard/Download/Background-original.mp4'], text=True).split()[0]
    assert source == '8c7615c1b7a0bff8f74a3979c39cf5daed127670fbc33c694d2cbf1af777e5bd'
    rows = json.loads((OUT / 'session/outcomes.json').read_text()); row = next(r for r in rows if r['id'] == active['id'])
    assert row['status'] == 'cancelled' and row['receipt'] is None
    record.update(authenticatedCleanupConfirmed=True, sourceUnchanged=True, receivedReceiptInvented=False)
    (OUT / 'android-cancel-result.json').write_text(json.dumps(record, indent=2))
    print('PASS: native cancellation during real upload; pending while unreachable, authenticated cleanup after reconnect, source unchanged.')
finally:
    stop.set(); thread.join(timeout=1)
    if 'T' in subprocess.check_output(['ps', '-p', str(pid), '-o', 'stat='], text=True): os.kill(pid, signal.SIGCONT)
