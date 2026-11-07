#!/usr/bin/env python3
"""One ordinary-app background acceptance. Requires the owned receiver fixture,
a selected generated Background-original.mp4 in the actual Release UI, and the
footage-finish agent-device session. No fixture assembly is injected into the app.
"""
import base64
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'artifacts/app-finish'
SIM = (OUT / 'simulator.txt').read_text().strip()
PID = int((OUT / 'receiver.pid').read_text())
command = subprocess.check_output(['ps', '-p', str(PID), '-o', 'args='], text=True)
assert 'scripts/test/normal-app/receiver.mts' in command, 'Refuse to signal an unrelated process'
container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', SIM, 'dev.footage.spike', 'data'], text=True).strip())
database = container / 'Library/Application Support/FootageOriginals/ledger.sqlite'
log = OUT / 'receiver.log'
initial = log.read_text().count('Observed POST /sealed/v1/setup')
paused = threading.Event()
stop = threading.Event()
record = {'ordinaryRelease': True, 'testAssembly': False}
def state():
    db = sqlite3.connect(f'file:{database}?mode=ro', uri=True)
    try:
        value = db.execute('SELECT state FROM runtime WHERE id=1').fetchone()
        return json.loads(value[0]) if value and value[0] else None
    finally:
        db.close()
def pause_after_setup():
    while not stop.wait(.01):
        if log.read_text().count('Observed POST /sealed/v1/setup') > initial:
            # Let the already authenticated setup reply leave the local receiver.
            time.sleep(.15)
            os.kill(PID, signal.SIGSTOP)
            record['receiverPausedAt'] = time.time()
            paused.set()
            return
watcher = threading.Thread(target=pause_after_setup, daemon=True)
watcher.start()
try:
    result = subprocess.run(['npx', '--yes', 'agent-device@0.21.35', 'press', 'role=button label="Upload original"', '--session', 'footage-finish', '--settle'], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=45)
    (OUT / 'background-upload-ui.txt').write_text(result.stdout)
    assert result.returncode == 0 and paused.wait(2), 'Setup did not reach the owned receiver'
    current = state()
    assert current and current['phase'] == 'transferring' and all(g.get('taskID') and g.get('resumed') for g in current['groups']), 'Preparation must finish before backgrounding'
    record['originalBytes'] = current['originalBytes']
    record['groups'] = len(current['groups'])
    record['confirmedBeforeBackground'] = current['bitmap']
    assert record['groups'] == 2 and current['bitmap'] == 0
    subprocess.run(['npx', '--yes', 'agent-device@0.21.35', 'home', '--session', 'footage-finish'], check=True, stdout=subprocess.DEVNULL)
    for _ in range(5):
        appstate = subprocess.check_output(['npx', '--yes', 'agent-device@0.21.35', 'appstate', '--session', 'footage-finish'], text=True)
        if 'runningBackground' in appstate: break
        time.sleep(.1)
    (OUT / 'background-appstate.txt').write_text(appstate)
    assert 'runningBackground' in appstate, appstate
    record['backgroundConfirmedAt'] = time.time()
    os.kill(PID, signal.SIGCONT); paused.clear()
    record['receiverResumedAt'] = time.time()
    job = str(__import__('uuid').UUID(bytes=base64.b64decode(current['job'])))
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        outcomes = json.loads((OUT / 'receiver/outcomes.json').read_text())
        outcome = next((item for item in outcomes if item['id'] == job and item['status'] == 'received'), None)
        if outcome:
            record['receiverReceivedWhileAppBackgrounded'] = True
            record['receiptId'] = outcome['receipt']['id']
            record['receivedAt'] = time.time()
            break
        time.sleep(.1)
    assert record.get('receiverReceivedWhileAppBackgrounded'), 'No background receipt'
    time.sleep(.5)
    after = state()
    record['nativeReceiptWhileBackgrounded'] = bool(after and after.get('receiptOutcome'))
    record['nativePhaseWhileBackgrounded'] = after['phase'] if after else 'unavailable'
    appstate = subprocess.check_output(['npx', '--yes', 'agent-device@0.21.35', 'appstate', '--session', 'footage-finish'], text=True)
    assert 'runningBackground' in appstate
    (OUT / 'background-result.json').write_text(json.dumps(record, indent=2))
    print('PASS: ordinary Release prepared two groups; receiver and native state checked while app remained backgrounded.')
finally:
    stop.set()
    if paused.is_set(): os.kill(PID, signal.SIGCONT)
    watcher.join(timeout=1)
