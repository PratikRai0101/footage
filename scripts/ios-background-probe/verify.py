#!/usr/bin/env python3
"""Verify sanitized assertions from a completed run; prints no raw origins or authority.
Usage: python3 scripts/ios-background-probe/verify.py artifacts/.../safe-summary.json
"""
import hashlib
import json
import sys


def verify(summary):
    cases = {c['name']: c for c in summary['cases']}
    assert len(cases) == len(summary['cases']) == 43
    assert summary['independentListenerControlsPassed'] and summary['disposableSimulatorRootInstalled']
    assert summary['ownedListenerStopped'] and summary['ownedSimulatorDeleted']
    expected_hash = hashlib.sha256(b'F' * 65536).hexdigest()
    for name in ['ats-http-ip', 'ats-http-localhost', 'custom-baseline', 'default-baseline']:
        c = cases[name]
        assert c['status'] == 204 and c['error'] == 0
        r = next(r for r in c['observed'] if r['kind'] == 'plain')
        assert r['bytes'] == 65536 and r['sha256'] == expected_hash
    assert cases['untrusted-default-baseline']['trust'] == [{'originOK': True, 'pinOK': True, 'trusted': False}]
    assert cases['untrusted-default-baseline']['status'] == 0
    for anchor in ['custom', 'default']:
        assert cases[anchor + '-metadata-baseline']['status'] == 204
        for target in ['different', 'same', 'httpIP', 'httpHost']:
            for meta, auth in [(False, False), (False, True), (True, False), (True, True)]:
                c = cases[f'{anchor}-{target}-meta{int(meta)}-auth{int(auth)}']
                assert c['redirectCallbacks'] == 0
                origin = next(r for r in c['observed'] if r['kind'] == 'redirect')
                assert origin['auth'] == auth and origin['bytes'] == (0 if meta else 65536)
                if target in ['different', 'same']:
                    assert c['error'] == -999 and c['status'] == 0
                    assert not any(r['kind'] == 'plain' for r in c['observed'])
                    assert c['trust'][-1] == {'originOK': False, 'pinOK': target == 'same', 'trusted': True}
                else:
                    assert c['status'] == 204 and c['error'] == 0
                    sink = next(r for r in c['observed'] if r['kind'] == 'plain')
                    assert sink['role'] == 'http' and not sink['auth']
                    assert sink['bytes'] == (0 if meta else 65536)
                    if not meta:
                        assert sink['sha256'] == expected_hash
    foreground = cases['foreground-redirect-control']
    assert foreground['status'] == 307 and foreground['redirectCallbacks'] == 1
    assert not any(r['kind'] == 'plain' for r in foreground['observed'])
    for name in ['sealed-positive', 'sealed-suspended-positive']:
        c = cases[name]
        assert c['status'] == 200 and c['error'] == 0
        expected = c['expected'][0]
        accepted = next(r for r in c['observed'] if r['kind'] == 'sealedAccepted')
        assert c['acceptedPlaintextOffset'] == accepted['bytes'] == expected['bytes']
        assert accepted['sha256'] == expected['sha256']
        assert c['sealedBoundary'] == [True] and c['ackMACVerified'] and c['ackContextMatched']
        assert accepted['plaintextFileVerified'] and accepted['idempotentReplay'] and not accepted['auth']
        checks = accepted['checks']
        assert all(checks[k] for k in ['tampered', 'crossJob', 'wrongOffset', 'wrongLength', 'noProgressAdvance'])
        assert checks['crossJobProgress'] == 0
    foreign = cases['sealed-redirect-fake-ack']
    assert foreign['status'] == 200 and foreign['error'] == 0
    assert foreign['acceptedPlaintextOffset'] == 0 and foreign['sealedBoundary'] == [True]
    assert foreign['ackContextMatched'] and not foreign['ackMACVerified']
    sink = next(r for r in foreign['observed'] if r['kind'] == 'sealedSink')
    assert not any(sink[k] for k in ['auth', 'cookie', 'urlHasSecret'])
    assert summary['capturedDecrypt']['length'] == foreign['expected'][0]['bytes']
    assert summary['capturedDecrypt']['sha256'] == foreign['expected'][0]['sha256']
    suspended = cases['sealed-suspended-positive']['suspension']
    assert suspended['enteredBackground'] and suspended['processStopped']
    assert suspended['daemonListed'] and suspended['daemonOwnsReceiverSocket']
    assert suspended['bytesReadAtStop'] < 8 * 1024**2
    assert suspended['bytesReadAtStop'] < suspended['bytesReadTwoSecondsLater'] < suspended['bytesReadByCompletion']
    assert suspended['additionalBodyBytesWhileStopped'] > 48 * 1024**2
    assert cases['sealed-suspended-positive']['acceptedPlaintextOffset'] == 64 * 1024**2
    print('PASS: 43 cases; live baselines; ATS downgrade disclosure; TLS challenge controls; sealed content/authority; forgery/tamper/replay; stopped-app daemon continuation.')


if __name__ == '__main__':
    verify(json.load(open(sys.argv[1])))
