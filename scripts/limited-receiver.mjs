#!/usr/bin/env node
// Test-only streaming HTTP proxy. Never logs headers or upload capabilities.
import http from 'node:http';
import { Transform } from 'node:stream';
import { isIP } from 'node:net';

const [host, portText = '1082', rateText = '131072', upstreamPortText = '1080', completionDelayText = '0'] = process.argv.slice(2);
const port = Number(portText);
const rate = Number(rateText);
const upstreamPort = Number(upstreamPortText);
const completionDelay = Number(completionDelayText);
const octets = host?.split('.').map(Number) || [];
const privateHost = isIP(host || '') === 4 && (octets[0] === 10 || octets[0] === 127 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
if (!privateHost || !Number.isInteger(port) || (port !== 0 && port < 1024) || port > 65535 || !Number.isInteger(upstreamPort) || upstreamPort < 1024 || upstreamPort > 65535 || !Number.isFinite(rate) || rate < 65536 || !Number.isInteger(completionDelay) || completionDelay < 0 || completionDelay > 10000) {
  throw new Error('Usage: node scripts/limited-receiver.mjs <owned-private-host> [port] [bytes-per-second] [upstream-port]');
}

class LimitedBody extends Transform {
  constructor() {
    super({ highWaterMark: 64 * 1024 });
    this.timer = undefined;
  }
  _transform(chunk, encoding, callback) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      callback(null, chunk);
    }, Math.ceil(chunk.length * 1000 / rate));
  }
  _destroy(error, callback) {
    clearTimeout(this.timer);
    callback(error);
  }
}

const server = http.createServer((req, res) => {
  const upstream = http.request({ host, port: upstreamPort, method: req.method, path: req.url, headers: { ...req.headers, host: `${host}:${upstreamPort}` } }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.on('error', () => res.destroy());
    if (completionDelay && req.method === 'POST' && /^\/jobs\/[^/]+\/complete$/.test(req.url)) {
      // Delay only delivery of the real receipt, so verification can be observed.
      setTimeout(() => { if (!res.destroyed) response.pipe(res); else response.destroy(); }, completionDelay);
    } else response.pipe(res);
  });
  const method = (req.headers['x-http-method-override'] || req.method).toUpperCase();
  const limit = method === 'PATCH' && req.url.startsWith('/files/') ? new LimitedBody() : undefined;
  const abort = () => { limit?.destroy(); upstream.destroy(); };
  req.on('aborted', abort);
  req.on('error', abort);
  res.on('close', () => { if (!res.writableFinished) abort(); });
  upstream.on('error', () => {
    limit?.destroy();
    if (!res.headersSent && !res.destroyed) res.writeHead(502).end();
    else res.destroy();
  });
  if (limit) {
    limit.on('error', abort);
    req.pipe(limit).pipe(upstream);
  } else req.pipe(upstream);
});
server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.listen(port, host, () => console.info(JSON.stringify({ event: 'test_proxy_ready', host, port: server.address().port, upstreamPort, patchBytesPerSecond: rate })));
process.on('SIGTERM', () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
