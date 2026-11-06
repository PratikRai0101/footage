#!/usr/bin/env python3
"""Small ADB UI driver for the private Footage spike. Does not read personal media."""
import argparse
import re
import time
from urllib.parse import urlparse
import subprocess
import xml.etree.ElementTree as ET


def adb(*args):
    return subprocess.run(['adb', *args], check=True, capture_output=True, timeout=20).stdout


def nodes():
    path = '/data/local/tmp/footage-ui.xml'
    adb('shell', 'uiautomator', 'dump', path)
    try:
        content = adb('exec-out', 'cat', path)
        if not content.lstrip().startswith((b'<?xml', b'<hierarchy')):
            raise RuntimeError('UI hierarchy unavailable. Unlock the phone and open Footage before driving the UI.')
        return ET.fromstring(content).iter('node')
    finally:
        subprocess.run(['adb', 'shell', 'rm', '-f', path], capture_output=True, timeout=10)


def tap_text(text):
    for _ in range(6):
        visible = list(nodes())
        matches = [n for n in visible if n.get('text') == text or n.get('content-desc') == text]
        for node in reversed(matches):
            bounds = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
            if not bounds:
                continue
            x1, y1, x2, y2 = map(int, bounds.groups())
            if x2 > x1 and y2 > y1:
                adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
                return
        scrolls = [n for n in visible if n.get('scrollable') == 'true' and n.get('package') == 'dev.footage.spike']
        if not scrolls:
            break
        bounds = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', scrolls[0].get('bounds', ''))
        if not bounds:
            break
        x1, y1, x2, y2 = map(int, bounds.groups())
        center = str((x1 + x2) // 2)
        adb('shell', 'input', 'swipe', center, str(y2 - 150), center, str(y1 + 150), '350')
    raise SystemExit('Requested UI label not found or not visible: ' + text)


def set_server_origin(origin):
    parsed = urlparse(origin)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise SystemExit('Enter only the owned demo server origin.')
    current_nodes = [n for n in nodes() if n.get('package') == 'dev.footage.spike']
    if not any(n.get('class') == 'android.widget.EditText' for n in current_nodes):
        tap_text('Settings')
    tap_text('Server address')
    fields = [n for n in nodes() if n.get('package') == 'dev.footage.spike' and n.get('class') == 'android.widget.EditText' and n.get('focused') == 'true']
    if len(fields) != 1:
        raise SystemExit('Demo server field is not focused; no text was entered.')
    current = fields[0].get('text', '')
    adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END')
    adb('shell', 'input', 'keyevent', *(['KEYCODE_DEL'] * min(512, max(1, len(current)))))
    for character in origin:
        adb('shell', 'input', 'text', character)
        time.sleep(.07)
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    values = [n.get('text') for n in nodes() if n.get('package') == 'dev.footage.spike' and n.get('class') == 'android.widget.EditText']
    if origin not in values:
        raise SystemExit('The server field did not retain the complete origin. No upload was started.')
    if any(n.get('text') == 'Done' and n.get('package') == 'dev.footage.spike' for n in nodes()):
        tap_text('Done')
    print('Verified demo server origin:', origin)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['dump', 'tap', 'set-url'])
    parser.add_argument('text', nargs='?')
    args = parser.parse_args()
    if args.command == 'set-url':
        if not args.text:
            parser.error('set-url requires the owned server origin')
        set_server_origin(args.text)
    elif args.command == 'tap':
        if not args.text:
            parser.error('tap requires an exact UI label')
        tap_text(args.text)
    else:
        for node in nodes():
            # Avoid printing other applications' content or the user's file list.
            if node.get('package') != 'dev.footage.spike':
                continue
            text = node.get('text') or node.get('content-desc')
            if text:
                print(text, node.get('bounds'))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError, ET.ParseError) as error:
        raise SystemExit(str(error))
