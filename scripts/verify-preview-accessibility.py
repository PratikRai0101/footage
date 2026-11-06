#!/usr/bin/env python3
"""Verify real missing-preview text at 320 logical pixels / 2x system text.

Isolated emulator, known generated received fixture only. Temporarily move its
app-owned staged copy, not the public original. Restore the copy, APK and display
settings even on failure. Requires the debug APK installed initially.
"""
import argparse
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts/ui-emulator'
PACKAGE = 'dev.footage.spike'


def main(serial):
    assert serial.startswith('emulator-'), 'Never drive a personal phone with this runner.'
    os.environ['ANDROID_SERIAL'] = serial
    ui = runpy.run_path(str(ROOT / 'scripts/device-ui.py'))
    adb = ui['adb']
    job = json.loads(adb('exec-out', 'run-as', PACKAGE, 'cat', 'files/transfer.json'))
    assert job['name'] == 'footage-playback-test.mp4' and job['phase']['kind'] == 'received'
    assert job['sha256'] == '087c25d01d569da4de721d49392c53a460155c379d0c5028faaeaabc5d35fa81'
    path = job['path']
    assert path.startswith('/data/user/0/' + PACKAGE + '/files/') and '..' not in path
    backup = path + '.preview-test-backup'
    old_scale = adb('shell', 'settings', 'get', 'system', 'font_scale').decode().strip()
    assert b'Override' not in adb('shell', 'wm', 'size'), 'Restore an existing size override before this isolated test.'
    moved = False
    result = {'scope': 'API36 emulator, missing staged preview after verified generated upload; public original unchanged', 'fontScale': 2, 'logicalWidth': 320, 'passed': False}

    def install(name):
        subprocess.run(['adb', '-s', serial, 'install', '--no-streaming', '-r', str(ROOT / 'artifacts' / name)], check=True, capture_output=True)

    def bounds(node):
        values = list(map(int, re.findall(r'\d+', node.get('bounds', ''))))
        assert len(values) == 4
        return values

    try:
        adb('exec-out', 'run-as', PACKAGE, 'mv', path, backup); moved = True
        install('footage-demo.apk')
        adb('shell', 'wm', 'size', '840x1750')
        adb('shell', 'settings', 'put', 'system', 'font_scale', '2.0')
        adb('shell', 'am', 'start', '-W', '-n', PACKAGE + '/.MainActivity')
        for _ in range(12):
            if any(n.get('text') == 'A local preview is not available. Check the file details below.' for n in ui['nodes']()):
                break
            time.sleep(.2)
        adb('shell', 'input', 'swipe', '420', '1100', '420', '750', '400')
        nodes = ui['nodes']()
        frame = next(n for n in nodes if n.get('resource-id') == 'local-preview-stage')
        text = next(n for n in nodes if n.get('text') == 'A local preview is not available. Check the file details below.')
        outer, inner = bounds(frame), bounds(text)
        assert outer[0] <= inner[0] < inner[2] <= outer[2]
        assert outer[1] <= inner[1] < inner[3] <= outer[3], 'Fallback text is clipped by its preview frame.'
        assert outer[3] - outer[1] > 187 * 2.625, 'Fallback did not grow beyond normal preview height.'
        OUT.joinpath('22-preview-large-text.png').write_bytes(adb('exec-out', 'screencap', '-p'))
        result.update({'passed': True, 'previewBoundsPx': outer, 'textBoundsPx': inner, 'previewGrew': True})
        print('Large-text fallback grew naturally; complete message is inside the visible frame.')
    finally:
        install('footage-spike-debug.apk')
        if moved:
            adb('exec-out', 'run-as', PACKAGE, 'mv', backup, path)
        install('footage-demo.apk')
        adb('shell', 'settings', 'put', 'system', 'font_scale', old_scale)
        adb('shell', 'wm', 'size', 'reset')
        adb('shell', 'am', 'start', '-W', '-n', PACKAGE + '/.MainActivity')
        result['stagedCopyRestored'] = moved
        result['displaySettingsRestored'] = True
        OUT.joinpath('preview-accessibility.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', default='emulator-5554')
    main(parser.parse_args().serial)
