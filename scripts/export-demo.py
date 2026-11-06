#!/usr/bin/env python3
"""Export silent phone footage. Does not touch the DJI original."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts/demo/deliverables'


def probe(path):
    return json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(path)]))


def main():
    capture = json.loads((ROOT / 'artifacts/demo/take-3/result.json').read_text())
    assert capture['passed'] and capture['settingsRestored']
    OUT.mkdir(exist_ok=True)
    clips = OUT / 'clips'; clips.mkdir(exist_ok=True)
    common = ['-c:v', 'h264_videotoolbox', '-b:v', '6000k', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-an', '-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart']
    exported = []
    for recording in capture['recordings']:
        source = ROOT / recording['file']
        assert not any(s['codec_type'] == 'audio' for s in probe(source)['streams'])
        output = clips / source.name
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(source), '-map', '0:v:0', '-vf', 'crop=1056:2160:12:96,fps=30,setsar=1', *common, str(output)], check=True)
        exported.append(output)
    events = {e['event']: e for e in capture['events']}
    start = next(e for e in capture['events'] if e['event'] == 'recording_started' and e['clip'] == '02-upload-recovery-01')
    def offset(event):
        return (datetime.datetime.fromisoformat(event['at']) - datetime.datetime.fromisoformat(start['at'])).total_seconds()
    cut_start = offset(events['waiting_visible']) + 6
    cut_end = offset(events['same_job_recovery']) - 2
    assert 0 < cut_start < cut_end < float(probe(exported[1])['format']['duration'])
    omitted = cut_end - cut_start
    card = Image.new('RGB', (1056, 2160), '#0b0b0b')
    draw = ImageDraw.Draw(card)
    font = '/System/Library/Fonts/SFNS.ttf'
    draw.text((528, 1035), 'Reconnection wait shortened', font=ImageFont.truetype(font, 47), fill='#f1f1ef', anchor='mm')
    draw.text((528, 1110), f'{omitted:.0f} seconds omitted', font=ImageFont.truetype(font, 34), fill='#a7a7a7', anchor='mm')
    card_path = OUT / 'reconnection-edit-card.png'; card.save(card_path)
    # Full chapter assembly: normal speed, no waiting time removed.
    listing = OUT / 'full-concat.txt'
    listing.write_text(''.join("file '" + str(p) + "'\n" for p in exported))
    full = OUT / 'Footage-demo-full-silent.mp4'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(listing), '-map', '0:v:0', '-c', 'copy', '-an', '-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart', str(full)], check=True)
    # Short cut: a labelled title card, never an invisible speedup.
    short = OUT / 'Footage-demo-silent.mp4'
    graph = f'[1:v]split=2[a][b];[a]trim=end={cut_start},setpts=PTS-STARTPTS[pre];[b]trim=start={cut_end},setpts=PTS-STARTPTS[post];[3:v]trim=duration=1.5,setpts=PTS-STARTPTS,setsar=1,format=yuv420p[card];[0:v][pre][card][post][2:v]concat=n=5:v=1:a=0[out]'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(exported[0]), '-i', str(exported[1]), '-i', str(exported[2]), '-loop', '1', '-framerate', '30', '-i', str(card_path), '-filter_complex', graph, '-map', '[out]', *common, str(short)], check=True)
    files = []
    for path in [full, short, *exported]:
        data = probe(path)
        assert len(data['streams']) == 1 and data['streams'][0]['codec_type'] == 'video'
        assert data['streams'][0]['width'] == 1056 and data['streams'][0]['height'] == 2160
        files.append({'file': str(path.relative_to(ROOT)), 'seconds': float(data['format']['duration']), 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'audioStreams': 0})
    manifest = {'source': 'Real physical Samsung screen recordings from take-3', 'normalPlaybackSpeed': True, 'crop': '12 pixels from each side; 96 pixels from top; 2160px output height. Removes OS status/navigation chrome and Edge handle, not app content.', 'originalDjiFileEdited': False, 'shortCut': {'sourceMainCutStartSeconds': cut_start, 'sourceMainCutEndSeconds': cut_end, 'secondsOmitted': omitted, 'visibleEditCardSeconds': 1.5, 'reason': 'Repeated connection-wait state. No accepted-byte progress removed in this interval.'}, 'fullCut': 'No transfer-wait time omitted; chapter boundaries exclude system picker and private viewer-link exchange.', 'files': files}
    (OUT / 'export.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest, indent=2), flush=True)


if __name__ == '__main__':
    main()
