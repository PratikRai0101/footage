#!/usr/bin/env node
// Drive the real receiver using only the generated clip in our isolated emulator.
// Upload capabilities, exchange codes, and session cookies are never written to evidence.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { z } from 'zod';

const { values } = parseArgs({ options: { origin: { type: 'string' }, serial: { type: 'string', default: 'emulator-5554' }, output: { type: 'string', default: 'artifacts/ui-emulator/viewer' } } });
assert(values.origin, 'Pass --origin with the isolated owned receiver origin.');
assert(values.serial.startsWith('emulator-'), 'This script inspects only the isolated test emulator, never a personal phone.');
const origin = new URL(values.origin).origin;
assert.equal(origin, values.origin);
const job = z.object({
  id: z.uuid(), name: z.literal('footage-playback-test.mp4'), endpoint: z.url(), capability: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), phase: z.object({ kind: z.literal('received') }),
}).parse(JSON.parse(execFileSync('adb', ['-s', values.serial, 'exec-out', 'run-as', 'dev.footage.spike', 'cat', 'files/transfer.json'], { encoding: 'utf8' })));
assert.equal(job.endpoint, origin, 'Do not forward this capability to another receiver.');
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
assert.equal(await digest('artifacts/ui-emulator/footage-playback-test.mp4'), job.sha256);
const minted = await fetch(`${origin}/jobs/${job.id}/view`, { method: 'POST', headers: { Authorization: `Bearer ${job.capability}` } });
assert.equal(minted.status, 200);
const grant = z.object({ path: z.string().regex(/^\/receive#[a-f0-9]{64}$/) }).parse(await minted.json());
await mkdir(values.output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.FOOTAGE_BROWSER_CHANNEL });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, colorScheme: 'dark', acceptDownloads: true });
  const page = await context.newPage();
  const rangedResponses = [];
  const failures = [];
  page.on('pageerror', error => failures.push(error.name));
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/viewer/content') rangedResponses.push(response.status());
  });
  await page.goto(origin + grant.path, { waitUntil: 'networkidle' });
  await page.locator('#film:not([hidden])').waitFor();
  assert.equal(new URL(page.url()).hash, '', 'The one-use code must be removed from browser history.');
  assert.equal(await page.locator('#filename').textContent(), job.name);
  assert.equal(await page.locator('#hash').textContent(), job.sha256);
  await page.locator('#film').evaluate(video => { video.muted = true; return video.play(); });
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video && video.currentTime > 1 && video.readyState >= 3 && video.getVideoPlaybackQuality().totalVideoFrames > 1;
  }, undefined, { timeout: 20_000 });
  const playback = await page.locator('#film').evaluate(async video => {
    video.pause();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Seeking did not decode a frame.')), 5_000);
      video.addEventListener('seeked', () => { clearTimeout(timeout); resolve(); }, { once: true });
      video.currentTime = Math.min(6, video.duration - .5);
    });
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 16, 16);
    const pixels = context.getImageData(0, 0, 16, 16).data;
    let nonBlack = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) nonBlack++;
    return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, seekedTo: video.currentTime, decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames, nonBlackPixels: nonBlack };
  });
  assert.equal(playback.width, 1280); assert.equal(playback.height, 720);
  assert(playback.duration >= 8 && playback.duration < 8.2);
  assert(playback.seekedTo >= 5 && playback.nonBlackPixels > 20);
  assert(rangedResponses.includes(206), 'The browser did not exercise authenticated byte ranges.');
  const cookie = (await context.cookies()).find(cookie => cookie.name === 'footage_viewer');
  assert(cookie?.httpOnly && cookie.sameSite === 'Strict');
  assert(!(await page.content()).includes(job.capability));
  await page.screenshot({ path: join(values.output, 'desktop.png'), fullPage: true });
  // A fresh mobile context avoids capturing an in-flight resize/compositor frame.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await mobile.addCookies(await context.cookies());
  const phone = await mobile.newPage();
  phone.on('pageerror', error => failures.push(error.name));
  await phone.goto(`${origin}/receive`, { waitUntil: 'networkidle' });
  await phone.locator('#film:not([hidden])').waitFor();
  await phone.locator('#film').evaluate(video => { video.muted = true; return video.play(); });
  await phone.waitForFunction(() => {
    const video = document.querySelector('video');
    return video && video.readyState >= 3 && video.currentTime > 1;
  }, undefined, { timeout: 20_000 });
  await phone.locator('#film').evaluate(video => video.pause());
  await phone.evaluate(async () => {
    await document.fonts.ready;
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    let stable = 0, height = 0;
    for (let i = 0; i < 120 && stable < 5; i++) {
      await frame();
      const next = document.documentElement.scrollHeight;
      stable = next === height ? stable + 1 : 0; height = next;
    }
    if (stable < 5) throw new Error('Mobile layout did not settle.');
  });
  assert.equal(await phone.locator('header').count(), 1);
  assert.equal(await phone.locator('#hash').textContent(), job.sha256);
  assert(await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'Mobile viewer overflows horizontally.');
  await phone.screenshot({ path: join(values.output, 'mobile.png'), fullPage: true, animations: 'disabled' });
  await phone.screenshot({ path: join(values.output, 'mobile-viewport.png'), animations: 'disabled' });
  await mobile.close();
  const downloading = page.waitForEvent('download');
  await page.locator('#download').click();
  const download = await downloading;
  const path = await download.path();
  assert(path); assert.equal(await digest(path), job.sha256);
  assert.deepEqual(failures, []);
  const result = { scenario: 'actual-received-video-browser-playback', jobId: job.id, fixture: job.name, bytes: job.bytes, sha256: job.sha256, browser: browser.version(), playback, rangeResponseObserved: true, oneUseCodeRemovedFromHistory: true, httpOnlyStrictCookie: true, originalUploadCapabilityAbsentFromMarkup: true, downloadHashMatchesOriginal: true, pageErrors: failures, mobileLayoutStable: true, mobileHorizontalOverflow: false, scope: 'Real native emulator upload and real headless Chromium playback; not physical-phone background evidence.' };
  await writeFile(join(values.output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  await context.close();
} finally { await browser.close(); }
