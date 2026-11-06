#!/usr/bin/env python3
"""Exercise production Swift owner on an explicitly selected isolated Simulator.
Run the owned ios-receiver.ts first. Harness uses native commands/snapshots; never logs authority/URIs.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/ios-foreground'
BUNDLE = 'dev.footage.owner-harness'

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(65536), b''):
            h.update(block)
    return h.hexdigest()

def main(sim):
    devices = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', '-j']))
    assert any(d['udid'] == sim and d['name'] == 'Footage Foreground Acceptance' for ds in devices['devices'].values() for d in ds), 'Only the dedicated acceptance simulator is allowed.'
    def ctl(*args):
        return subprocess.check_output(['xcrun', 'simctl', *args], text=True).strip()
    subprocess.run(['xcrun', 'simctl', 'terminate', sim, BUNDLE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ctl('install', sim, str(OUT / 'OwnerHarness.app'))
    container = Path(ctl('get_app_container', sim, BUNDLE, 'data'))
    docs = container / 'Documents'
    docs.mkdir(exist_ok=True)
    import shutil
    shutil.copyfile(OUT / 'generated-original.mp4', docs / 'generated-original.mp4')
    source_hash = sha(docs / 'generated-original.mp4')
    origin = json.loads((OUT / 'ports.json').read_text())['origin']
    sequence = int(time.time() * 1000)
    results = []
    def foreground(bundle):
        subprocess.run(['npx', '--yes', 'agent-device@0.21.35', 'open', bundle, '--platform', 'ios', '--udid', sim, '--session', 'footage-foreground', '--foreground'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        time.sleep(.5)
    def mode(value):
        (OUT / 'mode').write_text(value)
    def command(action='snapshot', **fields):
        nonlocal sequence
        sequence += 1
        temporary = docs / 'command.tmp'
        temporary.write_text(json.dumps(dict(sequence=sequence, action=action, **fields)))
        temporary.replace(docs / 'command.json')
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                result = json.loads((docs / 'result.json').read_text())
                if result['sequence'] == sequence:
                    assert 'error' not in result, result.get('error')
                    return result
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            time.sleep(.1)
        raise TimeoutError('Native harness command did not return: ' + action)
    def wait(kind, seconds=40):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            result = command()
            s = result['snapshot']
            if s['kind'] == kind and (kind not in ['waiting', 'received', 'failed'] or not s.get('executionActive')):
                return result
            time.sleep(.15)
        raise TimeoutError('Native owner did not reach ' + kind + '; last kind=' + s['kind'])
    def record(name, **facts):
        results.append(dict(test=name, **facts))
        (OUT / 'owner-results.json').write_text(json.dumps(results, indent=2))
        print('PASS ' + name, flush=True)
    def prepare():
        command('prepare', origin=origin)
        ready = wait('ready')['snapshot']
        assert ready['media']['durationMs'] > 11000 and ready['media']['width'] == 1280 and ready['media']['height'] == 720
        assert ready['sha256'] == source_hash and ready['confirmedBytes'] == 0
        return ready
    def verify_received(expected):
        result = wait('received')
        s = result['snapshot']; receipt = s['receipt']
        assert s['id'] == expected['id'] == receipt['jobId']
        assert s['bytes'] == s['confirmedBytes'] == receipt['bytes']
        assert s['sha256'] == receipt['sha256'] == source_hash
        assert sha(OUT / 'receiver/uploads' / s['id']) == source_hash
        assert sha(docs / 'generated-original.mp4') == source_hash
        return s
    def cancel_clean():
        command('cancel')
        value = wait('cancelled')
        deadline = time.monotonic() + 15
        while value['snapshot']['cleanupPending'] and time.monotonic() < deadline:
            time.sleep(.2); value = command()
        assert not value['snapshot']['cleanupPending'] and not value['stagedExists']
        assert not (OUT / 'receiver/uploads' / value['snapshot']['id']).exists()
        return value['snapshot']

    ctl('launch', sim, BUNDLE)
    assert command('core')['corePassed']
    record('native-origin-storage-receipt-corruption-tests')
    command('configure', origin=origin)
    ready = prepare()
    mode('lose-response'); command('start')
    paused = wait('waiting')['snapshot']
    assert paused['id'] == ready['id'] and paused['confirmedBytes'] > 0
    server_bytes = (OUT / 'receiver/uploads' / ready['id']).stat().st_size
    assert server_bytes > paused['confirmedBytes']
    ctl('terminate', sim, BUNDLE); ctl('launch', sim, BUNDLE)
    restored = wait('waiting')
    assert restored['snapshot']['id'] == ready['id'] and restored['snapshot']['confirmedBytes'] == paused['confirmedBytes']
    assert restored['settings'] == dict(origin=origin, appearance='light')
    event_count = len(json.loads((OUT / 'transport.json').read_text())['events'])
    mode('pass'); command('start'); received = verify_received(ready)
    new_events = json.loads((OUT / 'transport.json').read_text())['events'][event_count:]
    first_resumed_patch = next(e for e in new_events if e['event'] == 'patch-start')
    assert int(first_resumed_patch['offset']) == server_bytes
    record('uncertain-patch-head-reconcile-and-relaunch', id=ready['id'], localConfirmedBeforeRelaunch=paused['confirmedBytes'], serverAcceptedBeforeRelaunch=server_bytes, firstResumedPatchOffset=int(first_resumed_patch['offset']), receipt=received['receipt'], independentSha256=source_hash)
    assert command('viewer')['viewerValid']
    command('cancel'); assert command()['snapshot']['kind'] == 'received'
    record('viewer-and-received-cancellation-does-not-promise-deletion')

    command('prepare-cancel', origin=origin); wait('preparation_cancelled')
    ctl('terminate', sim, BUNDLE); ctl('launch', sim, BUNDLE)
    wait('preparation_cancelled')
    record('new-preparation-cancel-does-not-revive-prior-receipt-after-relaunch')
    command('prepare-missing', origin=origin); wait('preparation_failed')
    record('preparation-error-distinct-from-cancellation')

    ready = prepare(); mode('offline'); command('cancel')
    pending = wait('cancelled')
    assert pending['snapshot']['cleanupPending'] and pending['stagedExists']
    mode('pass'); cancelled = cancel_clean(); assert cancelled['id'] == ready['id']
    record('offline-cancellation-persists-until-confirmed-cleanup')

    ready = prepare(); mode('slow'); command('start')
    deadline = time.monotonic() + 20
    while command()['snapshot']['confirmedBytes'] == 0 and time.monotonic() < deadline:
        time.sleep(.2)
    # A real application transition delivers UIKit notifications. No JS owns or stops bytes.
    foreground('dev.footage.spike')
    time.sleep(2)
    size = (OUT / 'receiver/uploads' / ready['id']).stat().st_size
    time.sleep(2)
    assert (OUT / 'receiver/uploads' / ready['id']).stat().st_size == size
    foreground(BUNDLE)
    paused = wait('waiting')['snapshot']
    assert paused['id'] == ready['id'] and not paused['executionActive']
    mode('pass'); command('start'); verify_received(ready)
    record('native-background-transition-stops-and-manual-continue-retains-job', id=ready['id'], checkpoint=paused['confirmedBytes'], serverStoppedAt=size)

    ready = prepare(); mode('wrong-receipt'); command('start')
    rejected = wait('failed')['snapshot']
    assert rejected['id'] == ready['id'] and rejected['kind'] != 'received'
    mode('pass'); command('cancel'); verify_received(ready)
    record('mismatching-receipt-rejected-and-committed-receipt-wins-late-cancel')

    for fault in ['redirect-patch', 'redirect-metadata', 'oversized']:
        ready = prepare(); mode(fault); command('start'); rejected = wait('failed')['snapshot']
        assert rejected['id'] == ready['id'] and rejected['confirmedBytes'] == 0
        mode('pass'); cancel_clean()
        record(fault + '-rejected-by-production-native-owner', id=ready['id'])
    mode('redirect-patch')
    assert command('redirect-no-auth', origin=origin)['redirectRejectedWithoutCredentials']
    mode('pass')
    record('actual-native-transport-307-rejected-without-any-authorization-header')
    transport = json.loads((OUT / 'transport.json').read_text())
    assert transport['sinkBytes'] == 0 and transport['sinkRequests'] == 0
    record('cross-origin-307-sink-zero-requests-and-zero-original-bytes', sinkBytes=0, sinkRequests=0)
    assert sha(docs / 'generated-original.mp4') == source_hash
    record('generated-source-preserved', sha256=source_hash)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--simulator', required=True)
    main(parser.parse_args().simulator)
