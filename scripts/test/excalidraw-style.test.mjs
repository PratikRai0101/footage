import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDrawingStyle } from '../excalidraw-style.mjs';

test('drawings use Excalifont and hand-drawn Sloppiness, not monospace and clean edges', () => {
  const result = applyDrawingStyle({ appState: { viewBackgroundColor: '#ffffff' }, elements: [
    { id: 'caption', type: 'text', fontFamily: 3, roughness: 0, text: 'Your original' },
    { id: 'phone', type: 'rectangle', roughness: 0 },
    { id: 'resume', type: 'arrow', roughness: 0, points: [[0, 0], [100, 0]] },
  ] });
  assert.equal(result.elements[0].fontFamily, 5);
  assert.ok(result.elements.every(element => element.roughness === 1));
  assert.equal(result.elements[0].text, 'Your original');
  assert.deepEqual(result.elements[2].points, [[0, 0], [100, 0]]);
  assert.equal(result.appState.currentItemFontFamily, 5);
  assert.equal(result.appState.currentItemRoughness, 1);
  assert.equal(result.appState.viewBackgroundColor, '#ffffff');
});

test('styling is idempotent and does not mutate the original drawing', () => {
  const before = { elements: [{ id: 'clip', type: 'text', fontFamily: 3, roughness: 0 }] };
  const once = applyDrawingStyle(before);
  assert.deepEqual(applyDrawingStyle(once), once);
  assert.equal(before.elements[0].fontFamily, 3);
  assert.equal(before.elements[0].roughness, 0);
});
