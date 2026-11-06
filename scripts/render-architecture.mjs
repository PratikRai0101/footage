import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { applyDrawingStyle } from './excalidraw-style.mjs';

// Isolated tooling: do not add a drawing editor to the mobile app's dependencies.
const tools = process.env.FOOTAGE_EXCALIDRAW_TOOLS ?? '/tmp/footage-excalidraw-render';
const requireTool = createRequire(path.join(tools, 'package.json'));
const { build } = requireTool('esbuild');
const assets = path.join(tools, 'node_modules/@excalidraw/excalidraw/dist/prod');
const font = await fs.readFile(path.join(assets, 'fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2'));
const fontData = `data:font/woff2;base64,${font.toString('base64')}`;
const entry = path.join(tools, 'render-entry.jsx');
await fs.writeFile(entry, `
import { restore, exportToSvg } from '@excalidraw/excalidraw';
window.renderDiagram = async (data) => {
  await document.fonts.load('20px Excalifont');
  const restored = restore(data, null, null, { repairBindings: true });
  const elements = restored.elements.map(e => ({...e, opacity: 100}));
  const svg = await exportToSvg({ elements, appState: {...restored.appState, exportWithDarkMode:false, exportBackground:true, viewBackgroundColor:'#ffffff'}, files:restored.files, exportPadding:32, skipInliningFonts:true });
  const style = document.createElementNS('http://www.w3.org/2000/svg','style');
  style.textContent = ${JSON.stringify(`@font-face{font-family:Excalifont;src:url(${fontData}) format('woff2');} text{font-family:Excalifont,cursive;}`)};
  svg.prepend(style);
  svg.setAttribute('width', String(svg.viewBox.baseVal.width));
  svg.setAttribute('height', String(svg.viewBox.baseVal.height));
  return {svg:svg.outerHTML,elements};
};
`);
await build({ entryPoints: [entry], bundle: true, outfile: path.join(tools, 'bundle.js'), format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' } });
const renderer = path.join(tools, 'renderer.html');
await fs.writeFile(renderer, `<!doctype html><html><head><style>@font-face{font-family:Excalifont;src:url(${fontData}) format('woff2')}body{margin:0}</style><script>window.EXCALIDRAW_ASSET_PATH=${JSON.stringify(pathToFileURL(assets + '/').href)}</script></head><body><script src="bundle.js"></script></body></html>`);
const browser = await chromium.launch({ channel: 'chrome', args: ['--allow-file-access-from-files'] });
try {
  for (const arg of process.argv.slice(2)) {
    const filename = path.resolve(arg);
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(renderer).href);
    await page.waitForFunction(() => typeof window.renderDiagram === 'function');
    const data = applyDrawingStyle(JSON.parse(await fs.readFile(filename, 'utf8')));
    const ids = new Set(data.elements.map(e => e.id));
    if (ids.size !== data.elements.length) throw new Error('Duplicate element IDs: ' + filename);
    for (const e of data.elements) {
      for (const key of ['startBinding', 'endBinding']) if (e[key] && !ids.has(e[key].elementId)) throw new Error('Dangling binding ' + e.id);
    }
    const rendered = await page.evaluate(data => window.renderDiagram(data), data);
    if (errors.length) throw new Error(errors.join('\n'));
    const svgFile = filename.replace(/\.excalidraw$/, '.svg');
    const pngFile = filename.replace(/\.excalidraw$/, '.png');
    await fs.writeFile(svgFile, rendered.svg);
    await fs.writeFile(filename, JSON.stringify({ ...data, elements: rendered.elements }, null, 2) + '\n');
    await page.setContent(rendered.svg);
    await page.evaluate(() => document.fonts.ready);
    const size = await page.locator('svg').evaluate(svg => ({ width: Math.ceil(svg.width.baseVal.value), height: Math.ceil(svg.height.baseVal.value) }));
    await page.setViewportSize(size);
    // Recreate after resizing: avoids stale Chromium SVG compositor tiles.
    await page.setContent(rendered.svg);
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    await page.screenshot({ path: pngFile });
    console.log(JSON.stringify({ file: filename, elements: ids.size, ...size, errors }));
    await page.close();
  }
} finally { await browser.close(); }
