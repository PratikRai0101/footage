#!/usr/bin/env python3
"""Check reachable Git history before public publication; never print matched values."""
import re
import subprocess
import sys

PATTERNS = {
    'private key': rb'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY',
    'credential': rb'(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16})',
    'bearer credential': rb'Bearer [A-Za-z0-9_.-]{24,}',
    'private viewing code': rb'/receive#code=[A-Za-z0-9_-]{16,}',
    'personal phone serial': rb'\bR[0-9][0-9A-Z]{9}\b',
    'developer home path': rb'/Users/[A-Za-z0-9._-]+/',
    'recorded private LAN address': rb'\b(?:172\.31|10\.43\.65)\.[0-9.]+',
}
PATTERNS = {name: re.compile(pattern) for name, pattern in PATTERNS.items()}
PRIVATE_SUFFIXES = ('.mp4', '.mov', '.mkv', '.apk', '.ipa', '.keystore', '.jks', '.p12', '.pem')


def main():
    if subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip():
        raise SystemExit('Commit the intended changes before checking the published history.')
    objects = subprocess.check_output(['git', 'rev-list', '--objects', '--all'], text=True).splitlines()
    findings = set()
    blobs = 0
    for item in objects:
        parts = item.split(' ', 1)
        if len(parts) != 2:
            continue
        oid, name = parts
        if subprocess.check_output(['git', 'cat-file', '-t', oid]).strip() != b'blob':
            continue
        blobs += 1
        data = subprocess.check_output(['git', 'cat-file', 'blob', oid])
        if len(data) > 10 * 1024 * 1024:
            findings.add(('large binary', name))
        if name.lower().endswith(PRIVATE_SUFFIXES) or ('/.env' in '/' + name and name.rsplit('/', 1)[-1] != '.env.example'):
            findings.add(('private media/build/config file', name))
        for category, pattern in PATTERNS.items():
            if pattern.search(data):
                findings.add((category, name))
    for category, name in sorted(findings):
        print(f'BLOCKED: {category}: {name}')
    if findings:
        return 1
    print(f'Public preflight passed: {blobs} historical blobs; no matched credentials, personal device identifiers, local home paths or media/build artifacts. Pattern checks are not a guarantee against every kind of secret.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
