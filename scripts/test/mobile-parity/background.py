#!/usr/bin/env python3
"""Drive one already-reviewed generated two-group original in the NORMAL app.
Owned receiver pauses itself after setup; always resume it, including on failure.
Android private-state observations require the owned rootable emulator, never a phone.
"""
import base64
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import time
import uuid
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'artifacts/mobile-parity'
platform = sys.argv[1]
assert platform in ('ios', 'android')
session = 'footage06-' + platform
pid = int((OUT / 'receiver.pid').read_text())
assert 'scripts/test/mobile-parity/receiver.mts' in subprocess.check_output(['ps', '-p', str(pid), '-o', 'args='], text=True)
adb = str(Path.home() / 'Library/Android/sdk/platform-tools/adb')
sim = (OUT / 'simulator.txt').read_text().strip()
if platform == 'android':
    assert (OUT / 'avd-name.txt').read_text().strip() in subprocess.check_output([adb, '-s', 'emulator-5584', 'emu', 'avd', 'name'], text=True)
else:
    container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', sim, 'dev.footage.spike', 'data'], text=True).strip())
def device(*args):
    return subprocess.check_output(['npx', '--yes', 'agent-device@0.21.35', *args, '--session', session], text=True)
def native():
    if platform == 'android':
        row = json.loads(subprocess.check_output([adb, '-s', 'emulator-5584', 'shell', 'cat', '/data/user/0/dev.footage.spike/files/transfer.json'], text=True))
        return row['id'], row['phase']['kind'], row['confirmed'], row['bytes'], row['phase'].get('receipt')
    db = sqlite3.connect(f'file:{container}/Library/Application Support/FootageOriginals/ledger.sqlite?mode=ro', uri=True)
    try: row = json.loads(db.execute('SELECT state FROM runtime WHERE id=1').fetchone()[0])
    finally: db.close()
    return str(uuid.UUID(bytes=base64.b64decode(row['job']))), row['phase'], row['bitmap'], row['originalBytes'], row.get('receiptOutcome')
def observed_rows():
    try: return json.loads((OUT / 'session/outcomes.json').read_text())
    except json.JSONDecodeError: return []  # only the fixture observer file is rewritten
before = {row['id'] for row in observed_rows()}
marker = OUT / 'session/pause-after-setup'; marker.write_text('own fault injection')
record = {'platform': platform, 'ordinaryRelease': True, 'testAssembly': False}
try:
    (OUT / f'{platform}-background-start-ui.txt').write_text(device('press', 'role=button label="Upload original"', '--settle'))
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        paused = 'T' in subprocess.check_output(['ps', '-p', str(pid), '-o', 'stat='], text=True)
        try: current = native()
        except Exception: current = None
        if paused and current and current[0] not in before and current[3] == 79595914:
            if platform == 'ios' and current[1] == 'transferring': break
            if platform == 'android' and current[1] == 'ready':
                state = subprocess.run([adb, '-s', 'emulator-5584', 'shell', 'cmd', 'jobscheduler', 'get-job-state', 'dev.footage.spike', '14271'], text=True, stdout=subprocess.PIPE)
                if 'active' in state.stdout: break
        time.sleep(.1)
    else: raise AssertionError('Full preseal and native scheduling were not observed')
    assert current and current[2] == 0
    record.update(jobId=current[0], originalBytes=current[3], confirmedBeforeHome=0, nativeScheduledBeforeHome=True)
    device('home')
    background = device('appstate')
    (OUT / f'{platform}-background-appstate.txt').write_text(background)
    assert ('runningBackground' in background) if platform == 'ios' else ('com.google.android.apps.nexuslauncher' in background)
    record['homeObservedAt'] = time.time()
    marker.unlink(); os.kill(pid, signal.SIGCONT); record['receiverResumedAt'] = time.time()
    deadline = time.monotonic() + 75
    while time.monotonic() < deadline:
        received = next((row for row in observed_rows() if row['id'] == current[0] and row['status'] == 'received'), None)
        if received: break
        time.sleep(.1)
    else: raise AssertionError('No matching background receiver receipt')
    record['receiptId'] = received['receipt']['id']; record['receiverReceivedWhileBackgrounded'] = True
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        latest = native()
        if latest[1] == 'received' and latest[4]: break
        time.sleep(.1)
    assert latest[1] == 'received' and latest[4]
    background = device('appstate')
    assert ('runningBackground' in background) if platform == 'ios' else ('com.google.android.apps.nexuslauncher' in background)
    record['nativeReceivedBeforeReturn'] = True
    (OUT / f'{platform}-background-result.json').write_text(json.dumps(record, indent=2))
    print('PASS:', platform, 'ordinary app, two-group original, native scheduled before Home; native and receiver received before return.')
finally:
    marker.unlink(missing_ok=True)
    if 'T' in subprocess.check_output(['ps', '-p', str(pid), '-o', 'stat='], text=True): os.kill(pid, signal.SIGCONT)
