#!/usr/bin/env python3
"""Resume the existing generated-clip job and test its non-interactive screen path.

Does not select media, create another upload, disconnect USB, or bypass a lock.
Approve USB debugging before running. Uses the existing private USB receiver.
"""
import datetime
import json
from pathlib import Path
import runpy
import sqlite3
import time

ROOT = Path(__file__).resolve().parent.parent
FOLDER = ROOT / 'artifacts/device-spike'
helpers = runpy.run_path(str(ROOT / 'scripts/device-spike.py'))
adb = helpers['adb']


def main():
    source = FOLDER / 'footage-generated-test.mp4'
    original_hash = helpers['digest'](source)
    native = helpers['native_state']()
    if not native:
        raise SystemExit('Authorize USB debugging so the existing native job can be inspected.')
    identity = native['id']
    db = sqlite3.connect(FOLDER / 'receiver/jobs.sqlite', isolation_level=None)
    row = db.execute('SELECT document FROM jobs WHERE id=?', (identity,)).fetchone()
    if not row:
        raise SystemExit('No receiver record matches the native job.')
    initial = json.loads(row[0])
    assert initial['name'] == source.name and initial['sha256'] == original_hash
    assert initial['status'] == 'uploading', 'The existing upload already ended; do not claim a new screen test.'
    received = FOLDER / 'receiver/uploads' / identity
    output = FOLDER / 'screen-run.json'
    result = {'scenario': 'existing-job-screen-noninteractive', 'route': 'ADB USB reverse; powered phone, not Wi-Fi', 'jobId': identity, 'events': [], 'scenarioPassed': False}

    def record(event, **fields):
        entry = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'event': event, **fields}
        result['events'].append(entry)
        output.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(entry), flush=True)

    slept = False
    try:
        record('existing_upload_inspected', serverBytes=received.stat().st_size, nativePhase=native['phase']['kind'])
        adb('reverse', 'tcp:8081', 'tcp:8081')
        adb('reverse', 'tcp:1080', 'tcp:1080')
        record('usb_upload_route_restored')
        adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
        slept = True
        power = adb('shell', 'dumpsys', 'power')
        assert helpers['is_noninteractive'](power), 'A non-interactive screen state was not observed.'
        baseline = received.stat().st_size
        assert baseline < initial['bytes'], 'Upload finished before screen observation; no lock-progress pass.'
        record('screen_noninteractive_observed', serverBytes=baseline, wakefulness=helpers['wakefulness'](power))
        growth = False
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            count = received.stat().st_size
            if not growth and count > baseline:
                power = adb('shell', 'dumpsys', 'power')
                assert helpers['is_noninteractive'](power), 'Phone became interactive before progress was proven.'
                growth = True
                record('server_progress_while_screen_noninteractive', serverBytes=count, wakefulness=helpers['wakefulness'](power))
            row = db.execute('SELECT document FROM jobs WHERE id=?', (identity,)).fetchone()
            server = json.loads(row[0])
            state = helpers['native_state']()
            if server['status'] == 'received' and state and state['phase']['kind'] == 'received':
                assert growth
                assert state['id'] == identity
                assert count == source.stat().st_size == state['bytes'] == server['receipt']['bytes']
                assert helpers['digest'](received) == original_hash == state['sha256'] == server['receipt']['sha256']
                assert state['phase']['receipt'] == server['receipt']
                result.update({'scenarioPassed': True, 'receipt': server['receipt'], 'bytes': count, 'sha256': original_hash})
                record('same_original_verified_after_screen_test', receiptId=server['receipt']['id'])
                return
            time.sleep(.15)
        raise TimeoutError('Existing transfer did not complete within the screen-test deadline.')
    except Exception as error:
        result['error'] = str(error)
        record('screen_test_failed', error=str(error))
        raise
    finally:
        db.close()
        if slept:
            try:
                adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
            except Exception as error:
                result['wakeRequestError'] = str(error)
        output.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
