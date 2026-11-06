#!/usr/bin/env python3
"""Export the already-selected Footage film-gate artwork. No image-generation API."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'apps/mobile/assets'
SIZE = 2048

def artwork(factor, background):
    image = Image.new('RGBA', (SIZE, SIZE), background)
    draw = ImageDraw.Draw(image)
    scale = SIZE / 240 * factor
    offset = (SIZE - 240 * scale) / 2
    point = lambda x, y: (round(offset + x * scale), round(offset + y * scale))
    ink = '#f5f4f0'
    draw.rounded_rectangle([point(48, 35), point(192, 205)], radius=round(23 * scale), outline=ink, width=round(9 * scale))
    for y in [65, 100, 135, 170]:
        draw.line([point(48, y), point(66, y)], fill=ink, width=round(7 * scale))
        draw.line([point(174, y), point(192, y)], fill=ink, width=round(7 * scale))
    draw.line([point(88, 157), point(88, 87)], fill=ink, width=round(9 * scale))
    draw.line([point(66, 110), point(88, 87), point(110, 110)], fill=ink, width=round(9 * scale), joint='curve')
    draw.line([point(126, 147), point(162, 147)], fill=ink, width=round(9 * scale))
    return image.resize((1024, 1024), Image.Resampling.LANCZOS)

OUT.mkdir(parents=True, exist_ok=True)
artwork(1, '#0b0c0d').convert('RGB').save(OUT / 'icon.png')
artwork(.66, (0, 0, 0, 0)).save(OUT / 'adaptive-icon.png')
print('Exported approved artwork at 1024px; Android foreground uses the 66% safe area.')
