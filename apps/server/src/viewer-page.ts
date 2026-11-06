import { createHash } from 'node:crypto';

const script = `
'use strict';
const code = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const byId = (id) => document.getElementById(id);
const message = byId('message');
const video = byId('film');
function explain(text) { message.textContent = text; message.hidden = false; }
async function openOriginal() {
  try {
    if (code) {
      const exchanged = await fetch('/viewer/session', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
      });
      if (!exchanged.ok) throw new Error('This viewing link has expired or has already been used. Open a fresh link from the sender.');
    }
    const response = await fetch('/viewer/job', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Open a fresh viewing link from the sender to see this original.');
    const job = await response.json();
    byId('filename').textContent = job.name;
    document.title = job.name + ' — Footage';
    byId('size').textContent = new Intl.NumberFormat().format(job.bytes) + ' bytes · original file';
    byId('receipt').textContent = job.receipt.id;
    byId('hash').textContent = job.receipt.sha256;
    const verified = new Date(job.receipt.verifiedAt);
    byId('verified').textContent = verified.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    byId('verified').dateTime = job.receipt.verifiedAt;
    const download = byId('download');
    download.href = job.downloadPath;
    download.download = job.name;
    download.hidden = false;
    byId('details').hidden = false;
    byId('state').textContent = 'Received & verified';
    if (job.previewSupported) {
      message.hidden = true;
      video.hidden = false;
      video.src = job.contentPath;
      video.addEventListener('error', () => explain('This browser cannot preview the original format, or the viewing session has expired. Download the original, or open a fresh viewing link.'));
    } else {
      explain('Preview is not supported for this file format. Your verified original is available to download, unchanged.');
    }
  } catch (error) {
    byId('state').textContent = 'Viewing link required';
    byId('filename').textContent = 'The original stays private.';
    byId('size').textContent = 'Short-lived access. No public library.';
    explain(error instanceof Error ? error.message : 'Unable to open the original. Try a fresh viewing link.');
  } finally { byId('screening').setAttribute('aria-busy', 'false'); }
}
void openOriginal();
`;

const style = `
:root{color-scheme:dark;--ink:#eee9df;--quiet:#b0aaa0;--edge:#3d3d39;--room:#20211f;--accent:#d8bc8c;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--room);color:var(--ink)}
*{box-sizing:border-box}body{margin:0;min-width:280px;background:radial-gradient(ellipse at 50% 18%,#2d2e2a 0,transparent 65%)}
[hidden]{display:none!important}a{color:inherit}a:focus-visible,video:focus-visible{outline:2px solid var(--accent);outline-offset:6px}
header,main,footer{width:min(1180px,calc(100% - 88px));margin:auto}header{display:flex;align-items:center;justify-content:space-between;padding:31px 0;border-bottom:1px solid var(--edge);gap:20px}.wordmark{font-weight:650;letter-spacing:-.04em;font-size:23px}.room-label{font-size:10px;text-transform:uppercase;letter-spacing:.19em;color:var(--quiet)}
.intro{padding:56px 0 29px;display:flex;justify-content:space-between;align-items:end;gap:32px}.title-block{min-width:0}.eyebrow{margin:0 0 17px;display:flex;align-items:center;gap:9px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}.eyebrow:before{content:"";width:5px;height:5px;border-radius:50%;background:var(--accent);flex-shrink:0}
h1{font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;font-size:clamp(32px,4.2vw,58px);line-height:1.1;font-weight:400;letter-spacing:-.035em;margin:0;overflow-wrap:anywhere}#size{font-size:12px;line-height:1.6;color:var(--quiet);margin:16px 0 0}
.download{display:inline-flex;align-items:center;justify-content:center;gap:18px;flex-shrink:0;border:1px solid #77766d;min-height:46px;padding:12px 18px;text-decoration:none;font-size:12px;transition:background .18s,border-color .18s}.download:hover{background:#373832;border-color:var(--accent)}.download span{font-size:18px;line-height:1}
.stage{background:#11120f;border:1px solid #3c3d36;min-height:260px;aspect-ratio:16/9;display:grid;place-items:center;position:relative;box-shadow:0 22px 65px #0003}video{display:block;width:100%;height:100%;max-height:75vh;background:#0b0c0a}.stage:has(video:not([hidden])){aspect-ratio:auto}#message{max-width:480px;text-align:center;padding:36px;font-size:15px;line-height:1.8;color:var(--quiet);margin:0}
.verification{display:grid;grid-template-columns:1fr 2fr;gap:48px;border-top:1px solid var(--edge);padding:29px 0 38px;margin-top:39px}.verification h2{font-size:18px;font-weight:400;letter-spacing:-.01em;font-family:"Iowan Old Style",Georgia,serif;margin:0 0 10px}.verification p{font-size:12px;line-height:1.7;color:var(--quiet);max-width:240px;margin:0}dl{margin:0;display:grid;grid-template-columns:94px minmax(0,1fr);column-gap:18px;row-gap:16px}dt{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--quiet);padding-top:3px}dd{margin:0;font-size:12px;line-height:1.6;overflow-wrap:anywhere}.mono{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace;font-size:11px;color:#d1ccc1}footer{border-top:1px solid var(--edge);padding:22px 0 30px;display:flex;justify-content:space-between;gap:20px;font-size:10px;letter-spacing:.04em;color:var(--quiet)}
@media(max-width:700px){header,main,footer{width:calc(100% - 36px)}header{padding:22px 0}.room-label{font-size:9px}.intro{padding:34px 0 24px;align-items:start;flex-direction:column;gap:22px}.download{width:100%;justify-content:space-between}.stage{min-height:220px}.verification{grid-template-columns:1fr;gap:23px;margin-top:27px;padding-top:24px}.verification p{max-width:100%}dl{grid-template-columns:74px minmax(0,1fr);gap:14px}footer{font-size:9px;line-height:1.6}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`;

function hash(value: string): string {
  return `'sha256-${createHash('sha256').update(value).digest('base64')}'`;
}

export const viewerCsp = `default-src 'none'; script-src ${hash(script)}; style-src ${hash(style)}; connect-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

// No job data is interpolated into markup or executable code. The client uses textContent.
export const viewerHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Screening room — Footage</title><style>${style}</style></head>
<body><header><span class="wordmark">Footage.</span><span class="room-label">Private screening room</span></header>
<main id="screening" aria-busy="true"><section class="intro"><div class="title-block"><p class="eyebrow" id="state">Opening your original</p><h1 id="filename">From sender to screen.</h1><p id="size">Retrieving the verified receipt.</p></div><a class="download" id="download" hidden>Download original <span aria-hidden="true">↓</span></a></section>
<section class="stage" aria-label="Original video"><video id="film" controls playsinline preload="metadata" hidden aria-label="Received original"></video><p id="message" role="status" aria-live="polite">Opening this private viewing link…</p></section>
<section class="verification" id="details" hidden aria-labelledby="verification-title"><div><h2 id="verification-title">An intact arrival.</h2><p>The received file matches the sender’s SHA-256. This is the original, not a transcode.</p></div><dl><dt>Verified</dt><dd><time id="verified"></time></dd><dt>Receipt</dt><dd id="receipt" class="mono"></dd><dt>SHA-256</dt><dd id="hash" class="mono"></dd></dl></section></main>
<footer><span>Original quality. Nothing in between.</span><span>Private link · Short-lived viewing session</span></footer><script>${script}</script></body></html>`;
