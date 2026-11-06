import fs from 'node:fs/promises';
import path from 'node:path';
import { applyDrawingStyle } from './excalidraw-style.mjs';

// Assemble the three hand-authored drawings into one editable, framed canvas.
// Coordinates inside each drawing remain unchanged.
const dir = path.resolve('artifacts/architecture');
const pages = [
  ['01-current-architecture', '01 Current architecture'],
  ['02-recovery-and-integrity', '02 Recovery and integrity'],
  ['03-cardboard-opportunity', '03 Improvements and Cardboard fit'],
];
const elements = [];
let offset = 0;
for (const [basename, name] of pages) {
  const drawing = JSON.parse(await fs.readFile(path.join(dir, basename + '.excalidraw'), 'utf8'));
  const width = Math.ceil(Math.max(...drawing.elements.map(e => e.x + e.width))) + 60;
  const height = Math.ceil(Math.max(...drawing.elements.map(e => e.y + e.height))) + 60;
  const id = 'frame-' + basename;
  elements.push({ id, type: 'frame', name, x: 0, y: offset, width, height, angle: 0, strokeColor: '#ced4da', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, seed: 900001 + elements.length, version: 1, versionNonce: 1, isDeleted: false, groupIds: [], frameId: null, roundness: null, boundElements: [], updated: 1, link: null, locked: false });
  elements.push(...drawing.elements.map(e => ({ ...e, y: e.y + offset, frameId: id })));
  offset += height + 120;
}
const ids = new Set(elements.map(e => e.id));
if (ids.size !== elements.length) throw new Error('Duplicate IDs in assembled canvas.');
for (const e of elements) {
  for (const k of ['startBinding', 'endBinding']) if (e[k] && !ids.has(e[k].elementId)) throw new Error('Dangling arrow binding.');
  if (e.frameId && !ids.has(e.frameId)) throw new Error('Dangling frame ID.');
}
const output = path.join(dir, 'Footage-engineering.excalidraw');
await fs.writeFile(output, JSON.stringify(applyDrawingStyle({ type: 'excalidraw', version: 2, source: 'https://excalidraw.com', elements, appState: { viewBackgroundColor: '#ffffff', gridSize: null, frameRendering: { enabled: true, clip: true, name: true, outline: true } }, files: {} }), null, 2) + '\n');
console.log(JSON.stringify({ output, frames: pages.length, elements: elements.length, height: offset - 120 }));
